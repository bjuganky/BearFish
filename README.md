# BearFish — Firefox V0.8

## Development & Testing

### Setup
Clone the repository and install development dependencies:

```bash
npm install
```

### Commands
- **Launch in Firefox**: Launch BearFish in Firefox from the repository source:
  ```bash
  npm run firefox
  ```
- **Lint extension**: Run `web-ext lint` validation on extension source:
  ```bash
  npm run lint
  ```
- **Run tests**: Run extension manifest and file validation tests:
  ```bash
  npm test
  ```

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
All REST calls now pass through one persisted limiter:
- maximum 8 calls in any rolling 60-second window
- includes stock search, quote requests, historical chart requests, and fallbacks
- request timestamps persist in extension storage so closing/reopening the popup does not reset the limit
- requests wait automatically when the limit has been reached

WebSocket streaming is separate from this REST-call limiter.

## Themes / spacing
The UI was reworked around five more cohesive themes rather than many near-duplicate recolors:
- Slate
- Forest
- Cream
- Terminal
- Midnight

Spacing, typography, search text, stock rows, chart controls, and menus were made more consistent and readable.
