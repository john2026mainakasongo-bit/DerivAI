# Zentora Adaptive Trend V5

## Fix in V5
- Removed the duplicate shadow-booking loop that was creating extra aggregate shadow samples without a performance key.
- Every shadow candidate now carries the exact `symbol + duration + direction` key used by the key-evidence gate.
- This fixes the state where the dashboard could show a large shadow win-rate while the current key remained `0/50`.
- Overlapping candidates are still limited to one active candidate per key/horizon.
- Existing historical probability, proposal break-even, minimum-edge, positive-EV, risk and REAL evidence locks remain active.

## Evidence behavior
- DEMO can scan while key evidence is building.
- REAL remains locked until the current key has 100 completed shadow samples and at least 56% win rate.
- A+ alone is not sufficient: the live proposal must also have positive expected value after the quote is received.

## Important
V5 fixes an evidence-accounting bug; it does not guarantee profitability. Validate the strategy on DEMO/shadow data before risking real funds.
