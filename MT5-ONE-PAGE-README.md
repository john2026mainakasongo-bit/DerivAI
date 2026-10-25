# Volatility Tap V4

The MT5 desk now searches for prospective breakout retests and EMA20 trend pullbacks on standard Volatility symbols (R_* and *HZ*V). ATR scales the zone and stop. Both the selected timeframe and a completed higher timeframe must agree. 1D remains view-only because no higher timeframe is available.

Lifecycle: zone created -> future live tap -> completed rejection candle -> confirmed BUY/SELL. A quote extended more than 0.25 ATR from the rejection close cannot confirm. Zones expire after 12 bars or invalidate at the stop. Confirmation fixes the actual observed entry and 1R/2R/3R levels. BUY/SELL markers retain their original confirmation candle; outcome markers and timestamped event history support review. Markers are visible when their candles are within the loaded history.

Quote simulation uses a fixed TP2 +2R / SL -1R exit policy. TP1 is a milestone; TP3 is a visual reference, not the measured exit. Journal statistics include eligible wins, losses, win rate, mean R, and MFE/MAE. These are not broker fills or account profits: costs and slippage are excluded. Gaps over 30 seconds flag the record and exclude it from performance/ML. Existing legacy records remain visible but are excluded from V4 statistics. Only the selected market is monitored; other markets may develop gaps.

The experimental local ML model is logistic regression on five recorded setup features. It requires at least 60 eligible completed outcomes per market/timeframe, 40 training examples, 18 chronological holdout examples, and both training classes. Training examples overlapping the first holdout setup are purged. An estimate appears only if holdout Brier error is at least 5% better than a constant baseline. Until then it shows Collecting data or No measured improvement. The model does not gate setup detection. It uses no external AI service and has no demonstrated profitable edge; the reused holdout is exploratory, not independent live validation.

History retains the latest 500 setups across markets/timeframes in this browser and origin. Export JSON before clearing storage or exceeding retention. Selected market/timeframe, fixed levels and manual monitor restore after refresh. The selected market's latest 300 historical candles per timeframe and 1200 ticks are cached every five seconds and on page hide for up to seven days. Refresh temporarily disconnects the feed; cached data displays during reconnection. No new confirmations run on stale quotes. Storage clearing removes saved state; this is not server-side persistence or an always-on scanner.

The compact desktop view includes chart, tracked setup and scanner. Analysis and journal open in dialogs. Manual entry monitoring remains opt-in; no broker orders are placed.

Validation: 12 Node tests pass for both sides, tap/rejection lifecycle, chase prevention, expiry/invalidation, retention/deduplication, gap and legacy exclusion, model gating and chronological split, storage recovery, and price fitting. Production build passes. Chromium checks with synthetic cached data pass at 1366x633, 1366x600 and mobile 390px, including reload, dialogs, Fit trade, JSON export and no JavaScript errors. Live Deriv connectivity and profitability are not verified here.

## Install on Windows

Extract this ZIP. Run Apply-V4.ps1 with -Repo pointing to your existing DerivAI project. It backs up affected files, copies the patch, runs tests and builds. It does not commit or push. Review locally with npm.cmd run dev, then open /mt5.

Manual validation: node --test tests/mt5ViewerState.test.mjs tests/volatilityTapEngine.test.mjs

## V5 chart navigation

Default autoscale fits candles instead of distant trade targets. Fit trade explicitly includes all targets; AUTO returns to candle fitting. Wheel/pinch zooms time; drag the bottom axis to adjust time spacing. Drag the right price axis, use Y+/Y-, or use Shift+wheel / wheel over the price axis for vertical zoom. Drag inside the chart to pan in both dimensions (freezes price autoscale). LIVE returns to the latest candles; RESET restores time and candle autoscale. New signals do not reset manual price zoom. Horizontal zoom has a wider 0.5–100 pixel bar-spacing range.

V5 validation: production build and Chromium checks for price buttons, price-axis wheel, pan/reset, desktop/mobile layout, refresh and journal export. Touch gestures use the chart library's native support; physical touch-device testing was not performed.
