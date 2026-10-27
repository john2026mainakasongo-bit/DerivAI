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

## V6 experimental sharp filter (supersedes earlier entry/stop behavior)

New zones carry policy sharp-v6. Confirmation requires the observed quote within 0.15 ATR of the completed rejection close. Confirmed stop is beyond BOTH the rejection wick and zone edge by 0.15 ATR. A distance below 0.35 ATR or above 1.25 ATR invalidates the candidate rather than moving the stop inside the structure. These are research defaults, not optimized or proven profitable thresholds. They can reject more trades and do not guarantee small monetary losses. The feed does not provide broker spread, minimum stop distance or fill/slippage; check those separately.

Entry and targets remain hidden while waiting for confirmation. Original plannedEntry/plannedStop are retained on confirmation, and transition events now snapshot entry/stop/targets. No confirmed levels are recalculated. A preconfirmation data gap invalidates the new-policy zone. Existing setups keep their original prices and appear as ARCHIVED; old-policy outcomes are excluded from sharp statistics and ML. No previous history is erased.

The selected setup is pinned per market/timeframe and retained across refresh. A new record does not replace the selection automatically. Choose a newer setup explicitly in the selector. Dynamic BUY/SELL trigger lines, scenario paths and the second trigger panel have been removed. Manual monitoring reports observed fixed-level touches, not HOLD/EXIT commands, and does not know a user's actual MT5 fill.

Validation: 15 Node tests pass, including both-side rejection stops, wide-stop rejection, original-plan audit snapshots, immutable confirmed prices and preconfirmation gap rejection. Build passes. Chromium checks cover zoom, layout, JSON export, hidden preconfirmation levels, pinned selection after a newer record and reload, and explicit selection retention. No broker/live strategy profitability validation.

Install using Apply-V6.ps1 -Repo <existing project path>. Backup is automatic; commit/push are separate. Demo research only until execution assumptions and out-of-sample performance are established.

## V7 — Current setup and persistent event history
- Current view ignores legacy policy records. Displays WAIT / WAIT ENTRY / BUY CONFIRMED / SELL CONFIRMED / FAILED / TARGET HIT / CANCELLED / EXPIRED. Never manufactures an entry to fill the panel.
- Historical selection is explicit, dated and labelled HISTORY. Returning/reloading opens current view. Fixed levels and original event records are preserved.
- Event markers use observed event epochs, aligned to their candles: zone, tap, confirmation, TP1, SL, target, cancellation, expiry. Historical level segments end at their last observed time. SL failure displays a red notice; this is a quote observation, not an MT5 execution or a predictive exit.
- TP2 is the simulated terminal target. Price movement after terminal TP2 does not retroactively turn a win into a loss. Gap-flagged outcomes cannot establish the actual first crossing.
- V7 saves setup candles from creation onward for history review. Older records have no original candle snapshot; the UI identifies that limitation. No invented backfill.
- Removed automatic 500-record pruning. Browser storage remains finite: failures show a warning. Same-browser backup copy plus full JSON export/restore; imports merge by ID and preserve existing records. Export regularly. Clearing site data removes local history and backup; another device requires JSON restore. No server storage, broker link or always-on monitoring.
- Monitoring covers the selected market while fresh data arrives. Switching markets, closing browser or losing connection can create gaps. Confirmed SL/entry/targets never move.
- Install using Apply-V7.ps1. It backs up files before applying, then runs 19 tests and build. No automatic Git push.

## V8 — Independent server scanner
See SERVER-SCANNER-SETUP.md. New server observes supported volatility markets and 11 signal timeframes regardless of which chart is selected, even with no browsers open. Node >=22.15, always-on hosting and persistent disk required. Frontend polls server every five seconds, with explicit browser-only fallback if no server is deployed. Browser-only records stay local; server history starts at server startup, with no fabricated historical observations. Tested 24 unit cases, browser fallback/history checks, server API sync, and a live public-data handshake with one market fully initialized. Full production uptime and all market availability must be verified after deployment.
