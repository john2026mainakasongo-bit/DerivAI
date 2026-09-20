# Zentora Adaptive Trend V6 — Deriv Native

## Purpose
V6 is built around the current Deriv Options API flow used by this app: live ticks → CALL/PUT candidate → proposal pricing → break-even/edge/EV → buy → proposal_open_contract outcome.

## Deriv-specific changes
- Uses the selected Deriv symbol, currency, tick duration and CALL/PUT direction as the exact evidence key.
- Uses a fresh V6 localStorage namespace so broken/partial V4 telemetry is not silently mixed into new evidence.
- Fixes the V4 persistence typo and validates persisted statistics before loading them.
- Keeps separate exact-key evidence from aggregate evidence.
- Shadow candidates are keyed and can coexist across different exact keys; the same key cannot create another overlapping candidate until its horizon completes.
- Shadow outcomes use the same directional CALL/PUT interpretation as the proposed contract; zero-price-change outcomes are excluded instead of being fabricated as wins/losses.
- DEMO trading requires at least 50 completed exact-key shadow samples and ≥56% exact-key win rate before the proposal gate can buy.
- REAL trading remains explicitly armed and additionally requires 100 completed exact-key samples and ≥56% win rate.
- Before buying, V6 requests a fresh Deriv proposal and checks ask price, payout, implied break-even, model probability, minimum edge and positive EV.
- REAL risk is blocked below $35 and capped at 1% of displayed balance because the app minimum stake is $0.35.
- Open contracts continue to be settled from the authenticated Deriv contract stream and journaled by contract id.

## Current Deriv API compatibility notes
Deriv's current Options API uses `underlying_symbol` for proposals and returns proposal `ask_price`/`payout` as values that may be strings or numbers. Open-contract responses can likewise return numeric fields as strings or numbers, and current responses use `exit_spot` rather than deprecated `sell_spot`. The existing `useDerivTicks`/`derivApi` layer already normalizes the proposal/buy flow; V6 keeps the bot on that layer rather than bypassing it.

## Important
This is a risk/evidence gate, not a profit guarantee. Historical or shadow win rate can degrade in live markets. Do not enable REAL simply because the UI unlocks; validate the exact key on DEMO first.

## Flow
`Deriv ticks → regime model → exact-key shadow evidence → fresh Deriv proposal → break-even/edge/EV → risk gate → buy → proposal_open_contract → outcome telemetry`
