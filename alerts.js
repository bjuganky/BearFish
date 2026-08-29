/* Shared, browser-free alert logic used by indicator.js (UI) and background.js (monitor). */
(function (root) {
 "use strict";

 const TYPES = ["price_above", "price_below", "rsi_above", "rsi_below"];
 const TYPE_LABELS = {
  price_above: "Price crosses above",
  price_below: "Price crosses below",
  rsi_above: "RSI crosses above",
  rsi_below: "RSI crosses below"
 };
 const DEFAULT_RSI_PERIOD = 14;

 function makeAlertId() {
  return "al_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
 }

 function isRsiType(type) {
  return type === "rsi_above" || type === "rsi_below";
 }

 /**
  * Validate raw user input for a new/edited alert.
  * input: {type, value, rsiPeriod}
  * Returns {ok:true, alert} or {ok:false, error}
  */
 function validateAlertInput(input) {
  input = input || {};
  const type = String(input.type || "");
  if (TYPES.indexOf(type) === -1) return { ok: false, error: "Choose a valid alert type." };

  const value = Number(input.value);
  if (!Number.isFinite(value)) return { ok: false, error: "Enter a numeric threshold." };

  if (type === "price_above" || type === "price_below") {
   if (value <= 0) return { ok: false, error: "Price threshold must be greater than 0." };
  } else {
   if (value < 0 || value > 100) return { ok: false, error: "RSI threshold must be between 0 and 100." };
  }

  let rsiPeriod = DEFAULT_RSI_PERIOD;
  if (isRsiType(type)) {
   rsiPeriod = Math.round(Number(input.rsiPeriod));
   if (!Number.isFinite(rsiPeriod) || rsiPeriod < 2 || rsiPeriod > 100) {
    return { ok: false, error: "RSI period must be a whole number between 2 and 100." };
   }
  }

  return {
   ok: true,
   alert: {
    id: input.id || makeAlertId(),
    type,
    value,
    rsiPeriod,
    enabled: input.enabled !== false,
    createdAt: input.createdAt || Date.now(),
    lastMet: null,
    lastValue: null,
    lastCheckedAt: null
   }
  };
 }

 /** Wilder's RSI, same formula used by details.js. Returns array aligned with closes (null until warmed up). */
 function computeRSI(closes, period) {
  period = period || DEFAULT_RSI_PERIOD;
  const out = Array(closes.length).fill(null);
  if (!Array.isArray(closes) || closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
   const d = closes[i] - closes[i - 1];
   if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
   const d = closes[i] - closes[i - 1];
   gain = (gain * (period - 1) + Math.max(d, 0)) / period;
   loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
   out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
 }

 function latestRSI(closes, period) {
  const series = computeRSI(closes, period);
  for (let i = series.length - 1; i >= 0; i--) {
   if (Number.isFinite(series[i])) return series[i];
  }
  return null;
 }

 function isMet(type, currentValue, threshold) {
  if (!Number.isFinite(currentValue)) return null;
  switch (type) {
   case "price_above": return currentValue > threshold;
   case "price_below": return currentValue < threshold;
   case "rsi_above": return currentValue > threshold;
   case "rsi_below": return currentValue < threshold;
   default: return null;
  }
 }

 /**
  * Evaluate one alert against a fresh current value (price or RSI) and decide
  * whether a notification should fire. Only fires on an unmet -> met transition;
  * the first-ever observation only arms the alert (no notification), so alerts
  * that already qualify at creation time don't immediately fire.
  * Returns {alert: updatedAlert, notify: boolean}.
  */
 function processAlertUpdate(alert, currentValue) {
  const met = isMet(alert.type, currentValue, alert.value);
  if (met === null) {
   return { alert, notify: false };
  }
  const prev = alert.lastMet;
  const notify = met === true && prev === false;
  const updated = Object.assign({}, alert, {
   lastMet: met,
   lastValue: currentValue,
   lastCheckedAt: Date.now()
  });
  return { alert: updated, notify };
 }

 function describeAlert(alert) {
  const label = TYPE_LABELS[alert.type] || alert.type;
  if (isRsiType(alert.type)) return `${label} ${alert.value} (RSI ${alert.rsiPeriod})`;
  return `${label} ${alert.value}`;
 }

 function notificationMessage(symbol, alert, currentValue) {
  const shown = Number.isFinite(currentValue) ? currentValue.toFixed(isRsiType(alert.type) ? 1 : 2) : "—";
  return `${symbol}: ${describeAlert(alert)} — now ${shown}`;
 }

 /** Normalize a possibly-missing/malformed stockAlerts storage blob into {symbol: [alert,...]}. */
 function sanitizeStore(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const symbol of Object.keys(raw)) {
   const list = raw[symbol];
   if (!Array.isArray(list)) continue;
   const cleaned = [];
   for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const check = validateAlertInput(item);
    if (!check.ok) continue;
    const alert = check.alert;
    alert.id = String(item.id || alert.id);
    alert.enabled = item.enabled !== false;
    alert.lastMet = typeof item.lastMet === "boolean" ? item.lastMet : null;
    alert.lastValue = Number.isFinite(item.lastValue) ? item.lastValue : null;
    alert.lastCheckedAt = Number.isFinite(item.lastCheckedAt) ? item.lastCheckedAt : null;
    alert.createdAt = Number.isFinite(item.createdAt) ? item.createdAt : Date.now();
    cleaned.push(alert);
   }
   const sym = String(symbol || "").toUpperCase().trim();
   if (sym && cleaned.length) out[sym] = cleaned;
  }
  return out;
 }

 const api = {
  TYPES,
  TYPE_LABELS,
  DEFAULT_RSI_PERIOD,
  isRsiType,
  makeAlertId,
  validateAlertInput,
  computeRSI,
  latestRSI,
  isMet,
  processAlertUpdate,
  describeAlert,
  notificationMessage,
  sanitizeStore
 };

 if (typeof module !== "undefined" && module.exports) module.exports = api;
 root.BearFishAlerts = api;
})(typeof self !== "undefined" ? self : this);
