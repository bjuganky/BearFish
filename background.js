/* BearFish background monitor: evaluates persisted stock alerts and fires
   native Firefox notifications on unmet -> met transitions. Consolidates
   REST usage by symbol and shares the extension-wide rolling 8-per-60s
   request budget with popup.js/details.js via the same "apiRequestTimes"
   storage key. */
(function () {
 "use strict";

 const ALARM_NAME = "bearfish-alert-scan";
 const CHECK_PERIOD_MINUTES = 5;
 const API_LIMIT = 8, API_WINDOW_MS = 60000;

 function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

 async function reserveApiSlot() {
  while (true) {
   const d = await browser.storage.local.get(["apiRequestTimes"]);
   const now = Date.now();
   const times = (Array.isArray(d.apiRequestTimes) ? d.apiRequestTimes : []).filter((t) => now - t < API_WINDOW_MS);
   if (times.length < API_LIMIT) {
    times.push(now);
    await browser.storage.local.set({ apiRequestTimes: times });
    return;
   }
   const wait = Math.max(250, API_WINDOW_MS - (now - times[0]) + 100);
   await sleep(wait);
  }
 }

 async function limitedJson(url) {
  await reserveApiSlot();
  const r = await fetch(url);
  const d = await r.json();
  return { r, d };
 }

 async function fetchQuote(symbol, apiKey) {
  const u = new URL("https://api.twelvedata.com/quote");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("apikey", apiKey);
  const { r, d } = await limitedJson(u);
  if (!r.ok || d.status === "error" || d.code) throw new Error(d.message || "Quote request failed");
  return d;
 }

 async function fetchCloses(symbol, apiKey, period) {
  const outputsize = Math.max(period + 5, 30);
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", "1day");
  u.searchParams.set("outputsize", String(outputsize));
  u.searchParams.set("apikey", apiKey);
  const { r, d } = await limitedJson(u);
  if (!r.ok || d.status === "error" || !Array.isArray(d.values)) throw new Error(d.message || "Series request failed");
  return [...d.values].reverse().map((v) => Number(v.close)).filter(Number.isFinite);
 }

 async function fireNotification(symbol, alert, currentValue) {
  const id = `${symbol}::${alert.id}`;
  try {
   await browser.notifications.create(id, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icon-48.png"),
    title: "BearFish alert",
    message: BearFishAlerts.notificationMessage(symbol, alert, currentValue)
   });
  } catch (e) {
   console.error("BearFish: notification failed", e);
  }
 }

 async function runCheck() {
  let data;
  try {
   data = await browser.storage.local.get(["apiKey", "stockAlerts"]);
  } catch (e) {
   console.error("BearFish: unable to read storage", e);
   return;
  }
  const apiKey = data.apiKey || "";
  const store = BearFishAlerts.sanitizeStore(data.stockAlerts);
  const symbols = Object.keys(store).filter((sym) => store[sym].some((a) => a.enabled));
  if (!apiKey || !symbols.length) return;

  let changed = false;
  for (const symbol of symbols) {
   const alerts = store[symbol];
   const enabled = alerts.filter((a) => a.enabled);
   const needsPrice = enabled.some((a) => a.type === "price_above" || a.type === "price_below");
   const rsiAlerts = enabled.filter((a) => BearFishAlerts.isRsiType(a.type));
   let priceValue = null;
   const rsiByPeriod = {};

   try {
    if (needsPrice) {
     const q = await fetchQuote(symbol, apiKey);
     priceValue = Number(q.close ?? q.price ?? q.last);
    }
    const periods = [...new Set(rsiAlerts.map((a) => a.rsiPeriod))];
    for (const period of periods) {
     const closes = await fetchCloses(symbol, apiKey, period);
     rsiByPeriod[period] = BearFishAlerts.latestRSI(closes, period);
    }
   } catch (e) {
    console.error("BearFish: alert check failed for", symbol, e && e.message);
    continue;
   }

   for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    if (!alert.enabled) continue;
    const currentValue = BearFishAlerts.isRsiType(alert.type) ? rsiByPeriod[alert.rsiPeriod] : priceValue;
    if (!Number.isFinite(currentValue)) continue;
    const { alert: updated, notify } = BearFishAlerts.processAlertUpdate(alert, currentValue);
    alerts[i] = updated;
    changed = true;
    if (notify) await fireNotification(symbol, updated, currentValue);
   }
   store[symbol] = alerts;
  }

  if (changed) {
   try {
    await browser.storage.local.set({ stockAlerts: store });
   } catch (e) {
    console.error("BearFish: unable to persist alert state", e);
   }
  }
 }

 function ensureAlarm() {
  browser.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_PERIOD_MINUTES });
 }

 browser.runtime.onInstalled.addListener(() => { ensureAlarm(); runCheck(); });
 browser.runtime.onStartup.addListener(() => { ensureAlarm(); runCheck(); });
 browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM_NAME) runCheck(); });

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

 // Ensure the alarm exists even if onInstalled already fired in a previous session.
 ensureAlarm();
})();
