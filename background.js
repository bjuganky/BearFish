/* BearFish MV3 background/event page.
   1) Serializes Twelve Data REST reservations for every context (popup,
      details, and this script itself) behind one queued service, exposed to
      popup/details via a runtime message (see rateLimit.js).
   2) Owns the single in-memory, in-process `stockAlerts` store: every
      mutation (UI add/remove/enable-disable, and the monitor's evaluation
      patches) is serialized through one promise queue operating on one
      shared cache, so there is never a separate "read the whole blob, then
      write the whole blob" step for two contexts to race on. The UI talks
      to this owner exclusively via runtime messages (bearfish:alerts:*);
      it never reads or writes browser.storage.local for stockAlerts itself.
   3) Runs a periodic, single-flight alert monitor that evaluates persisted
      stock alerts and fires native Firefox notifications on unmet -> met
      transitions. Immediately before evaluating each alert it re-fetches
      that alert's *current* definition from the store owner, so a
      threshold/type edited mid-scan is honored rather than acted on with a
      stale snapshot, and persists the new evaluation state (atomically,
      via the same owner) before emitting a notification. */
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

 /* ---------------- Alert store (single in-memory owner) ---------------- */

 const ALERT_MESSAGE_TYPES = {
  list: "bearfish:alerts:list",
  add: "bearfish:alerts:add",
  update: "bearfish:alerts:update",
  remove: "bearfish:alerts:remove",
  setEnabled: "bearfish:alerts:setEnabled"
 };

 /**
  * The only code in the extension allowed to read/write the `stockAlerts`
  * storage key. Loads it once, keeps an in-process cache as the single
  * source of truth, and serializes every operation (list/add/update/
  * remove/setEnabled from the UI, and patchEvaluation/getAlert from the
  * monitor) through one queue. Because there is no separate "get the whole
  * blob" step exposed to callers, two concurrent mutations can never
  * interleave a read from one with a write from the other: each operation
  * runs to completion (including its `storage.set`) before the next one
  * starts, and every operation mutates the same up-to-date in-memory cache.
  */
 function createAlertStore(storage, alertsLib) {
  let cache = null;
  let queue = Promise.resolve();

  async function ensureLoaded() {
   if (cache) return;
   const raw = await storage.get(["stockAlerts"]);
   cache = alertsLib.sanitizeStore(raw.stockAlerts);
  }

  function enqueue(fn) {
   const task = queue.then(async () => { await ensureLoaded(); return fn(); });
   queue = task.catch(() => {});
   return task;
  }

  function cloneList(symbol) { return (cache[symbol] || []).map((a) => ({ ...a })); }

  /* Applies `mutate(cache)` (which must assign/delete cache[symbol] itself)
     and persists the whole cache. If persistence fails, the mutation is
     rolled back so the in-memory cache never diverges from what is
     actually durable on disk -- a failed write can never leave a "phantom"
     state that a later operation (e.g. the next scan) would mistake for
     having been saved. */
  async function mutateAndPersist(symbol, mutate) {
   const prevHad = Object.prototype.hasOwnProperty.call(cache, symbol);
   const prevList = cache[symbol];
   mutate();
   try {
    await storage.set({ stockAlerts: cache });
   } catch (e) {
    if (prevHad) cache[symbol] = prevList; else delete cache[symbol];
    throw e;
   }
  }

  return {
   listAlerts(symbol) {
    return enqueue(() => cloneList(symbol));
   },

   addAlert(symbol, input) {
    return enqueue(async () => {
     const check = alertsLib.validateAlertInput(input);
     if (!check.ok) return { ok: false, error: check.error };
     await mutateAndPersist(symbol, () => {
      const list = cache[symbol] ? cache[symbol].slice() : [];
      list.push(check.alert);
      cache[symbol] = list;
     });
     return { ok: true, alert: { ...check.alert }, list: cloneList(symbol) };
    });
   },

   /* Not currently wired to a UI control (the alert editor stays add/
      enable-disable/delete only, per the compact-UI requirement), but
      exposed and tested to prove that when an alert's definition does
      change mid-scan, the store's other operations (including the
      monitor's getAlert) always observe the new definition, never a
      stale one -- there is no read path that could still see the old
      value/type/rsiPeriod once this resolves. */
   updateAlert(symbol, alertId, input) {
    return enqueue(async () => {
     const list = cache[symbol] || [];
     const idx = list.findIndex((a) => a.id === alertId);
     if (idx === -1) return { ok: false, error: "Alert not found." };
     const check = alertsLib.validateAlertInput({ ...input, id: alertId });
     if (!check.ok) return { ok: false, error: check.error };
     const prev = list[idx];
     // Changing the definition re-arms the alert (like a freshly created one):
     // the next observation only arms it, it never fires from stale state.
     const updated = { ...prev, type: check.alert.type, value: check.alert.value, rsiPeriod: check.alert.rsiPeriod, lastMet: null, lastValue: null, lastCheckedAt: null };
     await mutateAndPersist(symbol, () => {
      const nextList = list.slice();
      nextList[idx] = updated;
      cache[symbol] = nextList;
     });
     return { ok: true, alert: { ...updated }, list: cloneList(symbol) };
    });
   },

   removeAlert(symbol, alertId) {
    return enqueue(async () => {
     await mutateAndPersist(symbol, () => {
      const list = (cache[symbol] || []).filter((a) => a.id !== alertId);
      if (list.length) cache[symbol] = list; else delete cache[symbol];
     });
     return { ok: true, list: cloneList(symbol) };
    });
   },

   setEnabled(symbol, alertId, enabled) {
    return enqueue(async () => {
     const list = cache[symbol] || [];
     const idx = list.findIndex((a) => a.id === alertId);
     if (idx === -1) return { ok: false, error: "Alert not found." };
     await mutateAndPersist(symbol, () => {
      const nextList = list.slice();
      nextList[idx] = { ...list[idx], enabled: !!enabled };
      cache[symbol] = nextList;
     });
     return { ok: true, list: cloneList(symbol) };
    });
   },

   /* Monitor-only: which symbols currently have at least one enabled alert.
      Used only to decide *what* to check; each alert's definition is always
      re-read fresh via getAlert() immediately before it is evaluated. */
   enabledSymbols() {
    return enqueue(() => Object.keys(cache).filter((sym) => (cache[sym] || []).some((a) => a.enabled)));
   },

   enabledAlerts(symbol) {
    return enqueue(() => (cache[symbol] || []).filter((a) => a.enabled).map((a) => ({ ...a })));
   },

   /* Monitor-only: fetch the current definition + evaluation state for one
      alert id, or null if it no longer exists (deleted concurrently). Only
      used for diagnostics/tests -- the monitor's actual read-evaluate-write
      decision goes through evaluateAndPatch() below, as a single serialized
      operation, so nothing can be interleaved between the read and the
      write of a scan's transition. */
   getAlert(symbol, alertId) {
    return enqueue(() => {
     const found = (cache[symbol] || []).find((a) => a.id === alertId);
     return found ? { ...found } : null;
    });
   },

   /* Monitor-only: apply an evaluation patch iff the alert still exists;
      returns the merged alert, or null if it was deleted/edited away
      concurrently (never resurrects a deleted alert). Only used for
      diagnostics/tests; see evaluateAndPatch() for the atomic path the
      monitor actually uses. */
   patchEvaluation(symbol, alertId, patch) {
    return enqueue(async () => {
     const list = cache[symbol];
     if (!list) return null;
     const idx = list.findIndex((a) => a.id === alertId);
     if (idx === -1) return null;
     const updated = { ...list[idx], ...patch };
     await mutateAndPersist(symbol, () => {
      const nextList = list.slice();
      nextList[idx] = updated;
      cache[symbol] = nextList;
     });
     return { ...updated };
    });
   },

   /* Monitor-only: the read (current definition/state), the crossing
      evaluation, and the write of the resulting evaluation patch all run
      inside a *single* queued operation, so no other mutation (a UI
      disable/delete/edit, or another scan) can land between "read" and
      "write" -- there is no separate getAlert()+patchEvaluation() pair for
      something else to interleave into. `resolveValue(alert)` must be a
      synchronous, side-effect-free function of the (possibly stale)
      planned alert type/rsiPeriod (e.g. a lookup into an already-fetched
      price/RSI map); it receives the *fresh* alert read inside this same
      operation, so it always evaluates against the current definition.
      Returns { skipped: true } if the alert no longer exists, was disabled
      concurrently, or `resolveValue` yields a non-finite value (e.g. its
      definition changed to data this cycle didn't fetch). Otherwise
      returns { skipped: false, notify, alert, currentValue } for the
      committed transition -- notify() must only ever be called with this
      result, never with a value computed from a separate earlier read. */
   evaluateAndPatch(symbol, alertId, resolveValue) {
    return enqueue(async () => {
     const list = cache[symbol];
     if (!list) return { skipped: true };
     const idx = list.findIndex((a) => a.id === alertId);
     if (idx === -1) return { skipped: true };
     const alert = list[idx];
     if (!alert.enabled) return { skipped: true };
     const currentValue = resolveValue(alert);
     if (!Number.isFinite(currentValue)) return { skipped: true };
     const { alert: updated, notify: shouldNotify } = alertsLib.processAlertUpdate(alert, currentValue);
     await mutateAndPersist(symbol, () => {
      const nextList = list.slice();
      nextList[idx] = updated;
      cache[symbol] = nextList;
     });
     return { skipped: false, notify: shouldNotify, alert: { ...updated }, currentValue };
    });
   }
  };
 }

 function attachAlertStoreListener(runtime, store) {
  runtime.onMessage.addListener((msg) => {
   if (!msg || typeof msg.type !== "string") return;
   switch (msg.type) {
    case ALERT_MESSAGE_TYPES.list:
     return store.listAlerts(msg.symbol).then((list) => ({ ok: true, list }));
    case ALERT_MESSAGE_TYPES.add:
     return store.addAlert(msg.symbol, msg.input);
    case ALERT_MESSAGE_TYPES.update:
     return store.updateAlert(msg.symbol, msg.id, msg.input);
    case ALERT_MESSAGE_TYPES.remove:
     return store.removeAlert(msg.symbol, msg.id);
    case ALERT_MESSAGE_TYPES.setEnabled:
     return store.setEnabled(msg.symbol, msg.id, msg.enabled);
    default:
     return undefined;
   }
  });
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
  * Evaluates every enabled alert for one symbol against freshly-fetched
  * price/RSI values. The set of alerts/periods to fetch is only *planned*
  * from a snapshot; the actual read of each alert's current definition,
  * the crossing evaluation, and the persistence of the resulting state all
  * happen inside one atomic `store.evaluateAndPatch()` call per alert, so
  * a concurrent disable/delete/edit can never land between "decide to
  * notify" and "persist that decision" -- notify() is only ever invoked
  * with the result of that same committed operation. If a concurrent edit
  * changes what data is needed (e.g. a different RSI period) that wasn't
  * part of this cycle's fetch plan, that alert is simply skipped for this
  * cycle and picked up on the next scan, rather than evaluated against
  * mismatched data.
  */
 async function checkSymbol({ store, alertsLib, reserve, fetchImpl, apiKey, symbol, notify, log }) {
  const planned = await store.enabledAlerts(symbol);
  if (!planned.length) return;
  const needsPrice = planned.some((a) => a.type === "price_above" || a.type === "price_below");
  const periods = [...new Set(planned.filter((a) => alertsLib.isRsiType(a.type)).map((a) => a.rsiPeriod))];

  let priceValue = null;
  const rsiByPeriod = {};
  try {
   if (needsPrice) {
    await reserve();
    const r = await fetchImpl(buildQuoteUrl(symbol, apiKey)), q = await r.json();
    if (!r.ok || q.status === "error" || q.code) throw new Error(q.message || "Quote request failed");
    priceValue = Number(q.close ?? q.price ?? q.last);
   }
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

  const resolveValue = (alert) => (alertsLib.isRsiType(alert.type) ? rsiByPeriod[alert.rsiPeriod] : priceValue);

  for (const plannedAlert of planned) {
   let result;
   try {
    result = await store.evaluateAndPatch(symbol, plannedAlert.id, resolveValue);
   } catch (e) {
    // Explicit failure policy: never notify on a transition that failed to persist.
    // The prior (unmet) state stays in the store, so the next scan re-evaluates and
    // can still notify once persistence succeeds and a genuine crossing is (re)detected.
    if (log) log("BearFish: unable to persist alert state for " + symbol, e && e.message);
    continue;
   }
   if (result.skipped) continue; // deleted/disabled/edited away concurrently, or data mismatch
   if (result.notify) await notify(symbol, result.alert, result.currentValue);
  }
 }

 function createAlertMonitor({ storage, alertsLib, reserve, fetchImpl, notify, log = console.error.bind(console) }) {
  const store = createAlertStore(storage, alertsLib);
  let inFlight = null;
  async function doRun() {
   let apiKey;
   try {
    apiKey = (await storage.get(["apiKey"])).apiKey || "";
   } catch (e) {
    log("BearFish: unable to read storage", e);
    return;
   }
   if (!apiKey) return;
   const symbols = await store.enabledSymbols();
   if (!symbols.length) return;
   for (const symbol of symbols) {
    await checkSymbol({ store, alertsLib, reserve, fetchImpl, apiKey, symbol, notify, log });
   }
  }
  function runCheck() {
   if (inFlight) return inFlight; // single-flight: coalesce overlapping alarms
   inFlight = doRun().finally(() => { inFlight = null; });
   return inFlight;
  }
  return { runCheck, isScanInFlight: () => !!inFlight, store };
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

   attachAlertStoreListener(browser.runtime, monitor.store);

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
  module.exports = {
   createReservationService, attachRuntimeListener, RESERVE_MESSAGE_TYPE,
   createAlertStore, attachAlertStoreListener, ALERT_MESSAGE_TYPES,
   createAlertMonitor, checkSymbol
  };
 }
 global.BearFishBackgroundRateLimit = { createReservationService, attachRuntimeListener, RESERVE_MESSAGE_TYPE };
})(typeof globalThis !== "undefined" ? globalThis : this);
