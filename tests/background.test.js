/* Focused tests for background.js: shared reservation budget across
   concurrent contexts, the single in-memory AlertStore owner's
   serialization (no lost updates regardless of call/interleaving order,
   because there is no separate read-then-write step for two contexts to
   race on), single-flight scan coalescing, persist-before-notify
   ordering, and mid-scan edit correctness.
   Run with: node --test tests/background.test.js (or via node tests/background.test.js) */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
 attachRuntimeListener,
 createAlertStore,
 createAlertMonitor,
 checkSymbol
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

/* A storage whose `set` resolves only after `releaseNextSet()` is called,
   letting a test deterministically pause execution right in the middle of
   a store mutation (after the in-memory cache has been updated, before
   the write actually lands) so a second, concurrent mutation can be
   issued into that exact window. */
class GatedStorage extends MockStorage {
 constructor(seed = {}) {
  super(seed);
  this._gates = [];
 }
 async set(obj) {
  await new Promise((resolve) => this._gates.push(resolve));
  return super.set(obj);
 }
 releaseNextSet() {
  const gate = this._gates.shift();
  if (gate) gate();
 }
 /* Waits (polling on the microtask/timer queue) until a set() call has
    actually been issued and is blocked on a gate, then releases it. This
    avoids assuming exact tick timing for when a queued operation's
    storage.set() is reached. */
 async releaseWhenGated() {
  while (this._gates.length === 0) await new Promise((r) => setTimeout(r, 0));
  this.releaseNextSet();
 }
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

test("AlertStore serializes a UI mutation issued while the monitor's write is still in flight (no lost update)", async () => {
 const storage = new GatedStorage();
 const store = createAlertStore(storage, alertsLib);

 const setup = store.addAlert("AAPL", { type: "price_above", value: 100 });
 await storage.releaseWhenGated();
 const added = await setup;
 assert.ok(added.ok);
 const alertId = added.alert.id;

 // "Monitor" begins persisting an evaluation patch; its storage.set() is
 // gated open, so it is paused right after mutating the in-memory cache
 // but before the write actually completes.
 const monitorPatch = store.patchEvaluation("AAPL", alertId, { lastMet: true, lastValue: 105, lastCheckedAt: 1 });

 // While that write is still pending, the "UI" issues a second, unrelated
 // mutation (add another alert for the same symbol). Because both
 // operations are funneled through the same store's single queue, this
 // call cannot start until the monitor's mutation (including its
 // storage.set) has fully resolved -- there is no window where a "get"
 // from this call could observe stale data and overwrite the monitor's
 // in-flight change.
 const uiAdd = store.addAlert("AAPL", { type: "price_below", value: 50 });

 await storage.releaseWhenGated(); // let the monitor's write proceed
 await storage.releaseWhenGated(); // let the UI's write proceed (queued behind it)

 const [patched, added2] = await Promise.all([monitorPatch, uiAdd]);
 assert.equal(patched.lastMet, true);
 assert.ok(added2.ok);

 const finalList = await store.listAlerts("AAPL");
 assert.equal(finalList.length, 2, "both the monitor's patch and the UI's add must survive");
 assert.equal(finalList.find((a) => a.id === alertId).lastMet, true);
 assert.equal(finalList.filter((a) => a.type === "price_below").length, 1);
});

test("AlertStore serializes a monitor patch issued while a UI write is still in flight (reverse ordering, no lost update)", async () => {
 const storage = new GatedStorage();
 const store = createAlertStore(storage, alertsLib);

 const setup = store.addAlert("MSFT", { type: "price_above", value: 100 });
 await storage.releaseWhenGated();
 const added = await setup;
 const alertId = added.alert.id;

 // This time the "UI" (an enable/disable toggle) starts first and its
 // write is paused mid-flight.
 const uiToggle = store.setEnabled("MSFT", alertId, false);

 // The "monitor" tries to patch evaluation state for the same alert while
 // that UI write is still pending; it must queue behind it rather than
 // racing a concurrent get/set.
 const monitorPatch = store.patchEvaluation("MSFT", alertId, { lastMet: true, lastValue: 105, lastCheckedAt: 2 });

 await storage.releaseWhenGated(); // UI toggle's write proceeds first
 await storage.releaseWhenGated(); // monitor patch's write proceeds, queued behind it

 await Promise.all([uiToggle, monitorPatch]);

 const finalList = await store.listAlerts("MSFT");
 assert.equal(finalList.length, 1);
 assert.equal(finalList[0].enabled, false, "the concurrent disable is not clobbered");
 assert.equal(finalList[0].lastMet, true, "the evaluation patch still lands");
});

test("AlertStore never resurrects a deleted alert even when a patch for it is queued right behind the delete", async () => {
 const storage = new MockStorage();
 const store = createAlertStore(storage, alertsLib);
 const a = (await store.addAlert("AAPL", { type: "price_above", value: 100 })).alert;
 const b = (await store.addAlert("AAPL", { type: "price_below", value: 50 })).alert;

 const del = store.removeAlert("AAPL", b.id);
 const patch = store.patchEvaluation("AAPL", b.id, { lastMet: true, lastValue: 40, lastCheckedAt: 1 });
 const [, patched] = await Promise.all([del, patch]);

 assert.equal(patched, null, "a patch for a since-deleted alert id is a no-op");
 const finalList = await store.listAlerts("AAPL");
 assert.equal(finalList.length, 1);
 assert.equal(finalList[0].id, a.id);
});

test("a persistence failure rolls back the in-memory cache instead of leaving a phantom unsaved mutation", async () => {
 const storage = new MockStorage();
 const store = createAlertStore(storage, alertsLib);
 const a = (await store.addAlert("AAPL", { type: "price_above", value: 100 })).alert;

 storage.set = async () => { throw new Error("storage unavailable"); };
 await assert.rejects(() => store.patchEvaluation("AAPL", a.id, { lastMet: true, lastValue: 105, lastCheckedAt: 1 }));

 // The cache must reflect the last durable state, not the failed write,
 // so a later successful operation can't be fooled into thinking this
 // transition was already saved.
 const fresh = await store.getAlert("AAPL", a.id);
 assert.equal(fresh.lastMet, null, "rolled back to the pre-failure state");
});

test("an alert edited mid-scan is evaluated against its new definition, never a stale pre-fetch snapshot", async () => {
 const storage = new MockStorage();
 const store = createAlertStore(storage, alertsLib);
 const added = await store.addAlert("AAPL", { type: "price_above", value: 100 });
 const alertId = added.alert.id;

 let fetchCalls = 0;
 const fetchImpl = async () => {
  fetchCalls++;
  // While the network request is "in flight", the user raises the
  // threshold well above the value about to be returned.
  await store.updateAlert("AAPL", alertId, { type: "price_above", value: 1000 });
  return { ok: true, status: 200, json: async () => ({ close: "105" }) };
 };
 const notifications = [];
 await checkSymbol({
  store, alertsLib, reserve: async () => {}, fetchImpl, apiKey: "key", symbol: "AAPL",
  notify: async (...args) => notifications.push(args)
 });

 assert.equal(fetchCalls, 1);
 assert.equal(notifications.length, 0, "105 no longer crosses the edited threshold of 1000, so nothing fires");
 const final = await store.getAlert("AAPL", alertId);
 assert.equal(final.value, 1000);
 assert.equal(final.lastMet, false, "evaluated (and armed) against the new definition, not the stale one");
});

test("an alert whose type is edited mid-scan to data not fetched this cycle is skipped, not evaluated against mismatched data", async () => {
 const storage = new MockStorage();
 const store = createAlertStore(storage, alertsLib);
 const added = await store.addAlert("AAPL", { type: "price_above", value: 100 });
 const alertId = added.alert.id;

 const fetchImpl = async () => {
  // Concurrently, the user changes this alert into an RSI alert. This
  // cycle only fetched a quote (no RSI series), so it must not be
  // evaluated against a mismatched/absent RSI value.
  await store.updateAlert("AAPL", alertId, { type: "rsi_above", value: 70, rsiPeriod: 14 });
  return { ok: true, status: 200, json: async () => ({ close: "105" }) };
 };
 const notifications = [];
 await checkSymbol({
  store, alertsLib, reserve: async () => {}, fetchImpl, apiKey: "key", symbol: "AAPL",
  notify: async (...args) => notifications.push(args)
 });

 assert.equal(notifications.length, 0);
 const final = await store.getAlert("AAPL", alertId);
 assert.equal(final.type, "rsi_above");
 assert.equal(final.lastCheckedAt, null, "skipped this cycle rather than evaluated against mismatched data");
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
 const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ close: "105" }) });
 let notified = false;

 const monitor = createAlertMonitor({
  storage, alertsLib, reserve: async () => {}, fetchImpl,
  notify: async () => { notified = true; }
 });
 storage.set = async () => { throw new Error("storage unavailable"); };
 await monitor.runCheck(); // must not throw out of the alarm handler

 assert.equal(notified, false, "no notification without a durable state write");
});
