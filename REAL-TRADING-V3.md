# Zentora Adaptive Trend V3

This patch changes the strategy from **A+ signal -> buy** to:

1. Regime alignment (EMA gap + medium momentum)
2. Pullback / extension check
3. RSI and volatility regime confirmation
4. Historical nearest-state probability
5. Shadow-book evidence from the current live stream
6. Live Deriv proposal break-even calculation
7. Positive expected value and minimum edge
8. Account-aware stake cap (1% of displayed account balance)
9. Session take-profit / stop-loss / consecutive-loss circuit breaker
10. Explicit REAL arm remains required

## Important

No trading strategy can guarantee profit. This patch is designed to stop the bot from guessing and to refuse trades when evidence or live pricing is insufficient.

REAL mode remains an explicit opt-in. Validate the shadow statistics and DEMO behavior before arming REAL.

The existing Deriv integration already uses the authenticated account WebSocket, `underlying_symbol`, proposal -> buy, and open-contract subscriptions. Current Deriv documentation confirms that authenticated WebSocket connections support proposal, buy, and `proposal_open_contract` workflows.
