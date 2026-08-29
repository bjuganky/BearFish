# BearFish — Firefox V0.8

## Indicator editor
Indicator configuration is no longer crowded into the inline stock panel.

Open a stock, then use:
`INDICATORS -> EDIT…`

This opens a separate compact BearFish window for:
- SMA enable + period
- EMA enable + period
- Volume
- RSI enable + period
- MACD enable + fast / slow / signal

Changes save automatically and update the open BearFish popup.

### Help bubbles
Every indicator has a `?` control with a short plain-English explanation.

## Indicator presets
The inline stock panel has a quick preset selector.

Built-ins:
- Clean
- Trend
- Momentum
- Full

The indicator editor can save your current setup as a named custom preset.
Custom presets appear in the inline selector and can be deleted later.

## Live-tick reliability
Second-based live views no longer stay on `Collecting live ticks` forever.

If no valid tick arrives within 8 seconds:
1. BearFish closes the stalled WebSocket.
2. It tries a 1-minute REST fallback.
3. If that is unavailable too, it shows a clear retry/change-interval message.

## API pacing
All REST calls now pass through one centralized, serialized limiter (`rateLimit.js` +
the reservation service registered in `background.js`):
- maximum 8 calls in any rolling 60-second window, shared by every context
- popup and details pages reserve a slot by messaging the background script
  (`bearfish:reserve-rest-slot`), which serializes every reservation — including
  its own alert-monitoring requests — through one queue, so contexts can never
  race each other over the same budget
- request timestamps persist in extension storage so closing/reopening the popup
  does not reset the limit
- requests wait automatically when the limit has been reached

WebSocket streaming is separate from this REST-call limiter.

## Stock alerts
The indicator editor (`INDICATORS -> EDIT…`) has a compact ALERTS section per stock.

Supported trigger types:
- price crosses above a threshold
- price crosses below a threshold
- RSI crosses above a threshold
- RSI crosses below a threshold

Alerts can be created, listed, enabled/disabled, and deleted. Invalid or missing
thresholds (including blank/whitespace-only input) are rejected with a short inline
message before saving.

Alert definitions and their armed/notified state are stored in
`browser.storage.local` (`stockAlerts`), so they persist across popup closes and
browser/extension restarts. Malformed or legacy alert data is dropped safely
without breaking watchlists, themes, presets, or other preferences.

### Monitoring behavior
A background context (`background.js`) wakes on a recurring alarm (every 5
minutes) only when at least one alert is enabled and an API key is configured:
- REST calls are grouped per symbol — one quote request covers all price
  alerts on that symbol, and one daily time-series request per distinct RSI
  period covers all RSI alerts on that symbol. Alerts never generate one
  request each.
- RSI is always computed locally from the fetched closes; no Twelve Data
  technical-indicator endpoint is called.
- All background REST requests reserve a slot from the same centralized,
  persisted, rolling 8-per-60-second limiter used by the popup/details views
  (calling the reservation service directly in-process, rather than through
  the runtime-message path used by the popup/details pages), so alert
  monitoring can never push the extension over its shared request budget.
- A notification fires only on an unmet → met transition. A condition that
  stays true does not repeat; it re-arms once it becomes false again. The very
  first check after creating an alert only arms it (no notification), so an
  already-qualifying threshold doesn't fire immediately.
- While markets are closed or data is temporarily stale/unavailable, the last
  known value is reused/held and evaluated normally; failed requests for a
  symbol are logged and skipped for that cycle rather than throwing.
- Each alert's evaluation state is re-read and merged against the latest
  `stockAlerts` storage immediately before every write, so an alert added,
  edited, or deleted in the indicator UI while a scan is in progress is never
  silently overwritten or resurrected.
- Only one scan runs at a time: if an alarm fires again before the previous
  scan finished (for example because many symbols queued behind the shared
  rate limiter), the overlapping invocation is coalesced into a no-op instead
  of starting a second concurrent scan.
- A crossing is persisted to `browser.storage.local` before its notification
  is created. If the write fails, the notification is skipped entirely (rather
  than firing first) so a storage error or restart cannot cause a duplicate
  notification for the same crossing.
- Clicking a notification opens/focuses the corresponding stock's details view.

## Themes / spacing
The UI was reworked around five more cohesive themes rather than many near-duplicate recolors:
- Slate
- Forest
- Cream
- Terminal
- Midnight

Spacing, typography, search text, stock rows, chart controls, and menus were made more consistent and readable.
