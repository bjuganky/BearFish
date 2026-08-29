/* BearFish MV3 background/event page.
   1) Serializes Twelve Data REST reservations for every context (popup,
      details, and this script itself) behind one queued service, exposed to
      popup/details via a runtime message (see rateLimit.js).
   2) Runs a periodic, single-flight alert monitor that evaluates persisted
      stock alerts and fires native Firefox notifications on unmet -> met
      transitions, reconciling its evaluation state against the latest
      storage before every write so concurrent edits/deletes from the
      indicator UI are never clobbered, and persists that state before
      emitting a notification. */
(function (global) {
 "use strict";

 const API_LIMIT = 8, API_WINDOW_MS = 60000, API_TIMES_KEY = "apiRequestTimes", RESERVE_MESSAGE_TYPE = "bearfish:reserve-rest-slot";

 function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
 function pruneTimes(times, now, windowMs) { return (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && now - t < windowMs); }

 function createReservationService(storage, { limit = API_LIMIT, windowMs = API_WINDOW_MS, key = API_TIMES_KEY, nowFn = () => Date.now(), sleepFn = sleep } = {}) {
  let queue = Promise.resolve();
  function reserve({ onWait } = {}) {
   const task = queue.then(async () => {
    while (true) {
     const now = nowFn(), d = await storage.get([key]), times = pruneTimes(d[key], now, windowMs);
     if (times.length < limit) { times.push(now); await storage.set({ [key]: times }); return; }
     const waitMs = Math.max(250, windowMs - (now - times[0]) + 100);
     if (typeof onWait === "function") onWait({ waitMs });
     await sleepFn(waitMs);
    }
   });
   queue = task.catch(() => {});
   return task;
  }
  return { reserve };
 }

 function attachRuntimeListener(runtime, storage, opts) {
  const service = createReservationService(storage, opts);
  runtime.onMessage.addListener((msg) => {
   if (!msg || msg.type !== RESERVE_MESSAGE_TYPE) return;
   return service.reserve().then(() => ({ ok: true }));
  });
  return service;
 }

 /* ---------------- Alert monitor (pure/testable core) ---------------- */

 const ALARM_NAME = "bearfish-alert-scan";
 const CHECK_PERIOD_MINUTES = 5;

 function buildQuoteUrl(symbol, apiKey) {
  const u = new URL("https://api.twelvedata.com/quote");
  u.searchParams.set("symbol", symbol); u.searchParams.set("apikey", apiKey);
  return u;
 }
 function buildSeriesUrl(symbol, apiKey, outputsize) {
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", symbol); u.searchParams.set("interval", "1day");
  u.searchParams.set("outputsize", String(outputsize)); u.searchParams.set("apikey", apiKey);
  return u;
 }

 /**
  * Re-reads the latest persisted alert store and applies only the supplied
  * per-alert evaluation patches (keyed by alert id), for one symbol. Alerts
  * that were deleted/edited concurrently by the UI are left untouched aside
  * from the patched evaluation fields, and a missing alert id is skipped
  * entirely rather than resurrected.
  */
 async function reconcileAndPersist(storage, alertsLib, symbol, patchesById) {
  const raw = await storage.get(["stockAlerts"]);
  const store = alertsLib.sanitizeStore(raw.stockAlerts);
  const list = store[symbol];
  if (!list || !list.length) return null;
  let changed = false, patchedAlert = null;
  const nextList = list.map((a) => {
   const patch = patchesById[a.id];
   if (!patch) return a;
   changed = true;
   patchedAlert = Object.assign({}, a, patch);
   return patchedAlert;
  });
  if (!changed) return null;
  store[symbol] = nextList;
  await storage.set({ stockAlerts: store });
  return patchedAlert;
 }

 /**
  * Evaluates every enabled alert for one symbol against freshly-fetched
  * price/RSI values, persisting each alert's new evaluation state (merged
  * against the latest store) before firing its notification, so a crash or
  * concurrent edit cannot cause a duplicate notification after restart.
  */
 async function checkSymbol({ storage, alertsLib, reserve, fetchImpl, apiKey, symbol, alerts, notify, log }) {
  const enabled = alerts.filter((a) => a.enabled);
  const needsPrice = enabled.some((a) => a.type === "price_above" || a.type === "price_below");
  const rsiAlerts = enabled.filter((a) => alertsLib.isRsiType(a.type));
  let priceValue = null;
  const rsiByPeriod = {};

  try {
   if (needsPrice) {
    await reserve();
    const r = await fetchImpl(buildQuoteUrl(symbol, apiKey)), q = await r.json();
    if (!r.ok || q.status === "error" || q.code) throw new Error(q.message || "Quote request failed");
    priceValue = Number(q.close ?? q.price ?? q.last);
   }
   const periods = [...new Set(rsiAlerts.map((a) => a.rsiPeriod))];
   for (const period of periods) {
    await reserve();
    const outputsize = Math.max(period + 5, 30);
    const r = await fetchImpl(buildSeriesUrl(symbol, apiKey, outputsize)), d = await r.json();
    if (!r.ok || d.status === "error" || !Array.isArray(d.values)) throw new Error(d.message || "Series request failed");
    const closes = [...d.values].reverse().map((v) => Number(v.close)).filter(Number.isFinite);
    rsiByPeriod[period] = alertsLib.latestRSI(closes, period);
   }
  } catch (e) {
   if (log) log("BearFish: alert check failed for " + symbol, e && e.message);
   return;
  }

  for (const alert of enabled) {
   const currentValue = alertsLib.isRsiType(alert.type) ? rsiByPeriod[alert.rsiPeriod] : priceValue;
   if (!Number.isFinite(currentValue)) continue;
   const { alert: updated, notify: shouldNotify } = alertsLib.processAlertUpdate(alert, currentValue);
   const patch = { lastMet: updated.lastMet, lastValue: updated.lastValue, lastCheckedAt: updated.lastCheckedAt };
   let persisted;
   try {
    persisted = await reconcileAndPersist(storage, alertsLib, symbol, { [alert.id]: patch });
   } catch (e) {
    // Explicit failure policy: never notify on a transition that failed to persist.
    // The prior (unmet) state stays on disk, so the next scan re-evaluates and can
    // still notify once persistence succeeds and a genuine crossing is (re)detected.
    if (log) log("BearFish: unable to persist alert state for " + symbol, e && e.message);
    continue;
   }
   if (!persisted) continue; // alert was deleted/edited away concurrently; nothing to notify about
   if (shouldNotify) await notify(symbol, persisted, currentValue);
  }
 }

 function createAlertMonitor({ storage, alertsLib, reserve, fetchImpl, notify, log = console.error.bind(console) }) {
  let inFlight = null;
  async function doRun() {
   let data;
   try {
    data = await storage.get(["apiKey", "stockAlerts"]);
   } catch (e) {
    log("BearFish: unable to read storage", e);
    return;
   }
   const apiKey = data.apiKey || "";
   const store = alertsLib.sanitizeStore(data.stockAlerts);
   const symbols = Object.keys(store).filter((sym) => store[sym].some((a) => a.enabled));
   if (!apiKey || !symbols.length) return;
   for (const symbol of symbols) {
    // Re-read per symbol so a long-running earlier iteration can't act on stale data.
    const fresh = alertsLib.sanitizeStore((await storage.get(["stockAlerts"])).stockAlerts);
    const alerts = fresh[symbol];
    if (!alerts || !alerts.some((a) => a.enabled)) continue;
    await checkSymbol({ storage, alertsLib, reserve, fetchImpl, apiKey, symbol, alerts, notify, log });
   }
  }
  function runCheck() {
   if (inFlight) return inFlight; // single-flight: coalesce overlapping alarms
   inFlight = doRun().finally(() => { inFlight = null; });
   return inFlight;
  }
  return { runCheck, isScanInFlight: () => !!inFlight };
 }

 /* ---------------- Browser wiring ---------------- */

 if (typeof browser !== "undefined" && browser?.runtime?.onMessage && browser?.storage?.local) {
  const service = attachRuntimeListener(browser.runtime, browser.storage.local);

  const alertsLib = global.BearFishAlerts;
  if (alertsLib) {
   const monitor = createAlertMonitor({
    storage: browser.storage.local,
    alertsLib,
    reserve: () => service.reserve(),
    fetchImpl: (...args) => fetch(...args),
    notify: async (symbol, alert, currentValue) => {
     const id = `${symbol}::${alert.id}`;
     try {
      await browser.notifications.create(id, {
       type: "basic",
       iconUrl: browser.runtime.getURL("icon-48.png"),
       title: "BearFish alert",
       message: alertsLib.notificationMessage(symbol, alert, currentValue)
      });
     } catch (e) {
      console.error("BearFish: notification failed", e);
     }
    }
   });

   function ensureAlarm() { browser.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_PERIOD_MINUTES }); }
   browser.runtime.onInstalled.addListener(() => { ensureAlarm(); monitor.runCheck(); });
   browser.runtime.onStartup.addListener(() => { ensureAlarm(); monitor.runCheck(); });
   browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM_NAME) monitor.runCheck(); });
   ensureAlarm();

   if (browser.notifications && browser.notifications.onClicked) {
    browser.notifications.onClicked.addListener((notificationId) => {
     const symbol = String(notificationId || "").split("::")[0];
     if (!symbol) return;
     const url = browser.runtime.getURL("details.html") + "?symbol=" + encodeURIComponent(symbol);
     browser.tabs.query({}).then((tabs) => {
      const existing = tabs.find((t) => t.url && t.url.startsWith(browser.runtime.getURL("details.html")) && t.url.includes(`symbol=${symbol}`));
      if (existing) browser.tabs.update(existing.id, { active: true });
      else browser.tabs.create({ url });
     }).catch(() => browser.tabs.create({ url }));
    });
   }
  }
 }

 if (typeof module !== "undefined" && module.exports) {
  module.exports = { createReservationService, attachRuntimeListener, RESERVE_MESSAGE_TYPE, createAlertMonitor, checkSymbol, reconcileAndPersist };
 }
 global.BearFishBackgroundRateLimit = { createReservationService, attachRuntimeListener, RESERVE_MESSAGE_TYPE };
})(typeof globalThis !== "undefined" ? globalThis : this);
