# DerivAI Adaptive Trend V8 — Single Strategy Engine

## Core rule
DEMO and REAL use the same Adaptive Trend signal and execution pipeline.

The account mode must not change:
- symbol
- CALL/PUT direction
- duration
- probability model
- payout / break-even / EV gate
- cooldown
- requested stake
- setup confirmations

REAL has one additional authorization layer: the account must satisfy the configured REAL evidence gate before execution. That gate does not change the signal; it only prevents the already-approved strategy signal from being executed on REAL.

## V8 changes
- Removed the DEMO-only 50 exact-key execution gate.
- DEMO can execute the same signal once the normal strategy + historical + payout/EV gates pass.
- REAL remains locked until 100 exact-key samples and at least 56% observed win rate for the active exact key.
- DEMO and REAL now use the same requested stake. REAL no longer silently caps the stake; if the requested stake exceeds 1% of the REAL balance, the REAL trade is rejected with a risk message so DEMO/REAL trades cannot diverge silently.
- Shadow evidence records only actual A+ strategy candidates rather than every tick, so evidence is about the strategy's candidate setups.
- Performance storage is versioned as V8.

## Important
V8 is designed so DEMO is a rehearsal of REAL, not a separate easier strategy. Profitability is not guaranteed. Validate the strategy with DEMO/shadow results before enabling REAL execution.
