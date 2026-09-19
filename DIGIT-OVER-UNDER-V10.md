# Digit Over / Under V10

This version redesigns the Digit desk around one decision engine for DEMO and REAL.

Flow:
1. Analyze the same rolling 60-digit market book.
2. Compare OVER and UNDER candidates.
3. Validate probability, score, stability, regime and baseline edge.
4. Request the live Deriv proposal.
5. Validate payout, implied probability, EV and minimum edge.
6. Execute the selected contract.
7. On WIN, reset recovery.
8. On LOSS, close the failed signal, block the exact contract key during cooldown, and search for a fresh validated setup. Recovery stake is only allowed on a new setup; it never forces the same losing signal.

DEMO and REAL use the same signal/entry engine. The only account-specific control is the REAL authorization gate.

This does not guarantee profitability. Validate in DEMO/shadow mode before enabling REAL.
