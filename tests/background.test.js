/* Focused tests for background.js: shared reservation budget across
   concurrent contexts, per-alert reconciliation against concurrent edits,
   single-flight scan coalescing, and persist-before-notify ordering.
   Run with: node --test tests/background.test.js (or via node tests/background.test.js) */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
 attachRuntimeListener,
 createAlertMonitor,
 reconcileAndPersist
} = require("../background.js");
const rateLimit = require("../rateLimit.js");
const alertsLib = require("../alerts.js");

class MockStorage {
 constructor(seed = {}) { this.data = { ...seed }; }
 async get(keys) {
  if (Array.isArray(keys)) { const out = {}; for (const k of keys) out[k] = this.data[k]; return out; }
  return { ...this.data };
 }
 async set(obj) { Object.assign(this.data, obj); }
}

test("alert monitor and UI context share one serialized reservation budget concurrently", async () => {
 let now = 1000;
 const sleepCalls = [];
 const storage = new MockStorage();
 let messageHandler;
 const runtime = {
  onMessage: { addListener: (fn) => { messageHandler = fn; } },
  sendMessage: (msg) => messageHandler(msg)
 };
 const service = attachRuntimeListener(runtime, storage, {
  limit: 8, windowMs: 120, key: "concurrentBudget",
  nowFn: () => now, sleepFn: async (ms) => { sleepCalls.push(ms); now += ms; }
 });

 const uiReserve = () => rateLimit.limitedJson("https://example.test/quote", {
  runtime, storage, fetchImpl: async () => ({ ok: true, json: async () => ({}) })
 });
 const alertReserve = () => service.reserve();

 // 5 "popup/details" reservations plus 4 concurrent background alert-monitor
 // reservations = 9 total against a budget of 8.
 await Promise.all([uiReserve(), uiReserve(), uiReserve(), uiReserve(), uiReserve(), alertReserve(), alertReserve(), alertReserve(), alertReserve()]);

 assert.equal(sleepCalls.length, 1, "the 9th reservation must wait exactly once");
 assert.ok(sleepCalls[0] >= 220, "must wait roughly a full window before the 9th slot opens");
});

test("reconcileAndPersist preserves concurrent deletion and never resurrects a deleted alert", async () => {
 const alertA = alertsLib.validateAlertInput({ type: "price_above", value: 100 }).alert;
 const alertB = alertsLib.validateAlertInput({ type: "price_below", value: 50 }).alert;
 const storage = new MockStorage({ stockAlerts: { AAPL: [alertA, alertB] } });

 // Simulate indicator.js deleting alertB while the scan was doing network I/O.
 storage.data.stockAlerts = { AAPL: [alertA] };

 const patched = await reconcileAndPersist(storage, alertsLib, "AAPL", {
  [alertA.id]: { lastMet: true, lastValue: 105, lastCheckedAt: 123 }
 });
 assert.ok(patched);
 assert.equal(patched.lastMet, true);
 assert.equal(storage.data.stockAlerts.AAPL.length, 1);
 assert.equal(storage.data.stockAlerts.AAPL[0].id, alertA.id);

 const patchedDeleted = await reconcileAndPersist(storage, alertsLib, "AAPL", {
  [alertB.id]: { lastMet: true, lastValue: 40, lastCheckedAt: 456 }
 });
 assert.equal(patchedDeleted, null, "a patch for a since-deleted alert id is a no-op");
 assert.equal(storage.data.stockAlerts.AAPL.length, 1);
});

test("reconcileAndPersist preserves a concurrent enable/disable toggle made by the UI", async () => {
 const alert = alertsLib.validateAlertInput({ type: "price_above", value: 100 }).alert;
 const storage = new MockStorage({ stockAlerts: { AAPL: [alert] } });

 // Simulate the user disabling the alert in indicator.js mid-scan.
 storage.data.stockAlerts = { AAPL: [{ ...alert, enabled: false }] };

 await reconcileAndPersist(storage, alertsLib, "AAPL", {
  [alert.id]: { lastMet: true, lastValue: 105, lastCheckedAt: 123 }
 });
 const stored = storage.data.stockAlerts.AAPL[0];
 assert.equal(stored.enabled, false, "concurrent disable is not clobbered by the scan's write");
 assert.equal(stored.lastMet, true, "evaluation fields are still merged in");
});

test("overlapping alarm invocations are coalesced into a single scan", async () => {
 const alert = { ...alertsLib.validateAlertInput({ type: "price_above", value: 100 }).alert, lastMet: false };
 const storage = new MockStorage({ apiKey: "key", stockAlerts: { AAPL: [alert] } });
 let fetchCalls = 0;
 const fetchImpl = async () => {
  fetchCalls++;
  await new Promise((r) => setTimeout(r, 20));
  return { ok: true, status: 200, json: async () => ({ close: "105" }) };
 };
 const notifications = [];
 const monitor = createAlertMonitor({
  storage, alertsLib, reserve: async () => {}, fetchImpl,
  notify: async (symbol, a, v) => notifications.push([symbol, a.id, v])
 });

 const first = monitor.runCheck();
 const second = monitor.runCheck(); // a second alarm firing before the first scan finished
 assert.equal(monitor.isScanInFlight(), true);
 await Promise.all([first, second]);

 assert.equal(fetchCalls, 1, "only one scan's worth of network requests should occur");
 assert.equal(notifications.length, 1, "no duplicate notification from the overlapping alarm");
});

test("alert state is persisted before the notification is emitted", async () => {
 const alert = { ...alertsLib.validateAlertInput({ type: "price_above", value: 100 }).alert, lastMet: false };
 const storage = new MockStorage({ apiKey: "key", stockAlerts: { AAPL: [alert] } });
 const order = [];
 const originalSet = storage.set.bind(storage);
 storage.set = async (obj) => { const r = await originalSet(obj); if (obj.stockAlerts) order.push("persist"); return r; };
 const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ close: "105" }) });

 const monitor = createAlertMonitor({
  storage, alertsLib, reserve: async () => {}, fetchImpl,
  notify: async () => { order.push("notify"); }
 });
 await monitor.runCheck();

 assert.deepEqual(order, ["persist", "notify"], "state must be durable before the notification fires");
});

test("a persistence failure suppresses the notification instead of firing before the write", async () => {
 const alert = { ...alertsLib.validateAlertInput({ type: "price_above", value: 100 }).alert, lastMet: false };
 const storage = new MockStorage({ apiKey: "key", stockAlerts: { AAPL: [alert] } });
 storage.set = async () => { throw new Error("storage unavailable"); };
 const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ close: "105" }) });
 let notified = false;

 const monitor = createAlertMonitor({
  storage, alertsLib, reserve: async () => {}, fetchImpl,
  notify: async () => { notified = true; }
 });
 await monitor.runCheck(); // must not throw out of the alarm handler

 assert.equal(notified, false, "no notification without a durable state write");
});
