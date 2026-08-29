/* Focused tests for alerts.js: validation, crossing/re-arm logic, RSI calc,
   and storage sanitization. Run with: node tests/alerts.test.js */
const assert = require("assert");
const A = require("../alerts.js");

let passed = 0;
function test(name, fn) {
 try {
  fn();
  passed++;
  console.log("ok -", name);
 } catch (e) {
  console.error("FAIL -", name);
  console.error(e);
  process.exitCode = 1;
 }
}

test("validates price_above thresholds", () => {
 const bad = A.validateAlertInput({ type: "price_above", value: 0 });
 assert.strictEqual(bad.ok, false);
 const good = A.validateAlertInput({ type: "price_above", value: 150.5 });
 assert.strictEqual(good.ok, true);
 assert.strictEqual(good.alert.type, "price_above");
 assert.strictEqual(good.alert.value, 150.5);
});

test("validates price_below thresholds", () => {
 const bad = A.validateAlertInput({ type: "price_below", value: -5 });
 assert.strictEqual(bad.ok, false);
 const good = A.validateAlertInput({ type: "price_below", value: 10 });
 assert.strictEqual(good.ok, true);
});

test("rejects unknown alert types", () => {
 const bad = A.validateAlertInput({ type: "moon_phase", value: 1 });
 assert.strictEqual(bad.ok, false);
});

test("rejects non-numeric threshold", () => {
 const bad = A.validateAlertInput({ type: "price_above", value: "abc" });
 assert.strictEqual(bad.ok, false);
});

test("validates RSI thresholds and period", () => {
 const badRange = A.validateAlertInput({ type: "rsi_above", value: 150, rsiPeriod: 14 });
 assert.strictEqual(badRange.ok, false);
 const badPeriod = A.validateAlertInput({ type: "rsi_above", value: 70, rsiPeriod: 1 });
 assert.strictEqual(badPeriod.ok, false);
 const good = A.validateAlertInput({ type: "rsi_below", value: 30, rsiPeriod: 14 });
 assert.strictEqual(good.ok, true);
 assert.strictEqual(good.alert.rsiPeriod, 14);
});

test("first observation only arms, never notifies", () => {
 const created = A.validateAlertInput({ type: "price_above", value: 100 }).alert;
 const { alert, notify } = A.processAlertUpdate(created, 105);
 assert.strictEqual(notify, false);
 assert.strictEqual(alert.lastMet, true);
});

test("notifies once on unmet -> met transition, not while remaining met", () => {
 let alert = A.validateAlertInput({ type: "price_above", value: 100 }).alert;
 let r = A.processAlertUpdate(alert, 90); // arm (unmet)
 assert.strictEqual(r.notify, false);
 alert = r.alert;
 r = A.processAlertUpdate(alert, 105); // cross above -> notify
 assert.strictEqual(r.notify, true);
 alert = r.alert;
 r = A.processAlertUpdate(alert, 110); // still above -> no repeat
 assert.strictEqual(r.notify, false);
 alert = r.alert;
 r = A.processAlertUpdate(alert, 95); // falls back below -> re-armed, no notify
 assert.strictEqual(r.notify, false);
 alert = r.alert;
 r = A.processAlertUpdate(alert, 101); // crosses again -> notify
 assert.strictEqual(r.notify, true);
});

test("price_below crossing behaves symmetrically", () => {
 let alert = A.validateAlertInput({ type: "price_below", value: 50 }).alert;
 let r = A.processAlertUpdate(alert, 60); // arm (unmet)
 assert.strictEqual(r.notify, false);
 alert = r.alert;
 r = A.processAlertUpdate(alert, 45); // crosses below -> notify
 assert.strictEqual(r.notify, true);
 alert = r.alert;
 r = A.processAlertUpdate(alert, 40); // still below -> no repeat
 assert.strictEqual(r.notify, false);
});

test("ignores non-finite current values without changing state", () => {
 const alert = A.validateAlertInput({ type: "price_above", value: 100 }).alert;
 const { alert: updated, notify } = A.processAlertUpdate(alert, NaN);
 assert.strictEqual(notify, false);
 assert.strictEqual(updated, alert);
});

test("computes RSI matching a known fixture", () => {
 // Classic Wilder RSI teaching example (14-period) converges near 70.
 const closes = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28
 ];
 const rsi = A.latestRSI(closes, 14);
 assert.ok(rsi > 65 && rsi < 75, `expected ~70, got ${rsi}`);
});

test("RSI series is null until warmed up", () => {
 const series = A.computeRSI([1, 2, 3], 14);
 assert.strictEqual(series.every((v) => v === null), true);
});

test("sanitizeStore drops malformed entries and keeps valid ones", () => {
 const raw = {
  aapl: [{ id: "a1", type: "price_above", value: 200, enabled: true }],
  " msft ": [{ id: "a2", type: "rsi_above", value: 70, rsiPeriod: 14 }],
  bad1: "not-an-array",
  tsla: [{ type: "unknown_type", value: 1 }, null, 42],
  empty: []
 };
 const clean = A.sanitizeStore(raw);
 assert.deepStrictEqual(Object.keys(clean).sort(), ["AAPL", "MSFT"]);
 assert.strictEqual(clean.AAPL.length, 1);
 assert.strictEqual(clean.AAPL[0].id, "a1");
 assert.strictEqual(clean.MSFT[0].rsiPeriod, 14);
});

test("sanitizeStore tolerates completely missing/legacy storage", () => {
 assert.deepStrictEqual(A.sanitizeStore(undefined), {});
 assert.deepStrictEqual(A.sanitizeStore(null), {});
 assert.deepStrictEqual(A.sanitizeStore("legacy-string"), {});
});

console.log(`\n${passed} test(s) passed`);
