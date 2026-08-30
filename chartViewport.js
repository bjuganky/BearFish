/* Shared, framework-free viewport utilities used by both the inline popup
   chart (popup.js) and the full-page chart (details.js). These are pure
   functions operating on ascending-by-time bar arrays ({t,o,h,l,c,v}) so
   they can be unit tested in isolation (see tests/chartViewport.test.js)
   and reused without duplicating slicing/status logic per view. */
(function (global) {
 const UNIT_MS = {
  minutes: 60000,
  hours: 3600000,
  days: 86400000,
  weeks: 604800000,
  months: 2629800000, // 30.44 days, average calendar month
  years: 31557600000  // 365.25 days, average calendar year
 };

 function windowDurationMs(value, unit) {
  const n = Math.max(1, Number(value) || 1);
  return n * (UNIT_MS[unit] || UNIT_MS.days);
 }

 function barTimeMs(bar) {
  if (!bar) return NaN;
  if (Number.isFinite(bar.tms)) return bar.tms;
  const t = bar.t;
  if (typeof t === "number") return t;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : NaN;
 }

 function seriesBounds(series) {
  if (!Array.isArray(series) || !series.length) return null;
  let first = Infinity, last = -Infinity;
  for (const bar of series) {
   const t = barTimeMs(bar);
   if (!Number.isFinite(t)) continue;
   if (t < first) first = t;
   if (t > last) last = t;
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return { first, last };
 }

 function clampAnchorMs(series, anchorMs) {
  const bounds = seriesBounds(series);
  if (!bounds) return null;
  if (anchorMs === null || anchorMs === undefined || !Number.isFinite(anchorMs)) return bounds.last;
  return Math.min(bounds.last, Math.max(bounds.first, anchorMs));
 }

 function findViewportIndices(series, anchorMs, spanMs) {
  if (!Array.isArray(series) || !series.length) return { startIdx: -1, endIdx: -1 };
  let endIdx = -1;
  for (let i = 0; i < series.length; i++) {
   const t = barTimeMs(series[i]);
   if (!Number.isFinite(t)) continue;
   if (t <= anchorMs) endIdx = i;
   else break;
  }
  if (endIdx === -1) endIdx = 0;
  const windowStart = anchorMs - Math.max(0, Number(spanMs) || 0);
  let startIdx = endIdx;
  for (let i = endIdx; i >= 0; i--) {
   const t = barTimeMs(series[i]);
   if (Number.isFinite(t) && t > windowStart) startIdx = i;
   else break;
  }
  return { startIdx, endIdx };
 }

 /* Slices `series` (the full loaded buffer) down to the bars that fall
    within [anchorMs-spanMs, anchorMs]. Never fabricates bars: gaps
    (market closures, missing data) simply mean fewer bars in the slice. */
 function sliceViewport(series, anchorMs, spanMs) {
  const bounds = seriesBounds(series);
  if (!bounds) {
   return { bars: [], startIdx: -1, endIdx: -1, anchorMs: null, windowStartMs: null, windowEndMs: null };
  }
  const anchor = clampAnchorMs(series, anchorMs);
  const { startIdx, endIdx } = findViewportIndices(series, anchor, spanMs);
  const bars = startIdx >= 0 && endIdx >= 0 ? series.slice(startIdx, endIdx + 1) : [];
  const windowEndMs = bars.length ? barTimeMs(bars[bars.length - 1]) : anchor;
  const windowStartMs = bars.length ? barTimeMs(bars[0]) : anchor - spanMs;
  return { bars, startIdx, endIdx, anchorMs: anchor, windowStartMs, windowEndMs };
 }

 /* True when the viewport anchor represents "follow the newest data"
    (anchorMs is null/undefined) or is within `toleranceMs` of the last
    loaded bar. Used to decide LIVE/CURRENT/LATEST vs HISTORY status. */
 function isAtLatest(series, anchorMs, toleranceMs = 1) {
  const bounds = seriesBounds(series);
  if (!bounds) return true;
  if (anchorMs === null || anchorMs === undefined) return true;
  return anchorMs >= bounds.last - toleranceMs;
 }

 /* True when the visible window's left edge has reached (or passed) the
    oldest bar currently buffered, meaning more history should be fetched
    if the caller wants to allow scrolling further back. */
 function needsOlderData(series, anchorMs, spanMs) {
  const bounds = seriesBounds(series);
  if (!bounds) return false;
  const anchor = Number.isFinite(anchorMs) ? anchorMs : bounds.last;
  return anchor - Math.max(0, Number(spanMs) || 0) <= bounds.first;
 }

 function statusLabel({ atLatest, liveConnected, fresh }) {
  if (!atLatest) return "HISTORY";
  if (liveConnected) return "LIVE";
  if (fresh) return "CURRENT";
  return "LATEST";
 }

 function formatRange(startMs, endMs, formatFn) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "";
  const fmt = typeof formatFn === "function" ? formatFn : (ms) => new Date(ms).toLocaleString(undefined, {
   month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
  return `${fmt(startMs)} \u2013 ${fmt(endMs)}`;
 }

 const api = {
  UNIT_MS, windowDurationMs, barTimeMs, seriesBounds, clampAnchorMs,
  findViewportIndices, sliceViewport, isAtLatest, needsOlderData,
  statusLabel, formatRange
 };
 if (typeof module !== "undefined" && module.exports) module.exports = api;
 global.BearFishViewport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
