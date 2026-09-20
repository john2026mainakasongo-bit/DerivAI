# Digit Over / Under V10

This version uses one decision engine for DEMO and REAL.

Flow:
1. Analyze the same rolling 60-digit market book.
2. Compare OVER and UNDER candidates across the configured barriers.
3. Apply one consistent set of configurable entry gates: prediction threshold, minimum score, stability, regime safety and minimum baseline edge.
4. Request the live Deriv proposal.
5. Validate payout, implied probability, EV and the configured proposal edge.
6. Execute the selected contract only when the complete gate passes.
7. On WIN, reset recovery.
8. On LOSS, close the failed signal, block the exact contract key during cooldown, and search for a fresh validated setup. Recovery stake is only allowed on a new setup; it never forces the same losing signal.

V10 defaults:
- Prediction threshold: 65%
- Minimum score: 60/100
- Stability: 25%
- Minimum baseline edge: 1.5%
- Proposal edge and EV are still checked against the live Deriv quote.

The AUTO selector now evaluates all ready OVER/UNDER candidates instead of falling back to the first candidate when none has yet passed the gates. This avoids a deadlock caused by an arbitrary first candidate while preserving the validation gate.

DEMO and REAL use the same signal/entry engine. The only account-specific control is the REAL authorization gate.

This does not guarantee profitability. Validate in DEMO/shadow mode before enabling REAL.
