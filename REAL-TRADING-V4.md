# Zentora Adaptive Trend V4

## What changed
- Shadow outcomes are now stored by **symbol + duration + direction**.
- Overlapping shadow candidates for the same key are reduced so samples are less correlated.
- Performance is persisted in browser `localStorage` under `zentora_adaptive_trend_v4_performance`.
- DEMO can warm up while evidence builds.
- REAL trading is hard-locked until the current symbol/duration/direction key has **100 completed shadow samples** and at least **56% win rate**.
- REAL trading is also blocked when balance is below $35 because the $0.35 minimum stake would exceed a strict 1% risk cap.
- Stake is capped at 1% of displayed balance for REAL trades.
- Existing proposal break-even, minimum-edge, positive-EV, take-profit, stop-loss and max-loss protections remain active.

## Important
V4 is an evidence gate, not a profit guarantee. A high historical/shadow win rate can still fail in live markets. Keep REAL disabled until the evidence is sufficiently large and inspect performance by key.

## Flow
`Ticks → Regime → Historical probability → Key evidence → Live proposal → Break-even/edge/EV → Risk gate → Execution → Outcome → Key telemetry`
