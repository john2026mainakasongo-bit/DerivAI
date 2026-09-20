# Zentora Adaptive Trend — Profitability V2

## Main issue fixed

The previous bot bought whenever the local signal reached A+, without checking whether the live Deriv proposal price gave the model enough edge to justify the trade.

## New execution flow

1. Build the A+ signal from live ticks.
2. Estimate the probability of the next selected-duration move using similar historical market states.
3. Request a live Deriv proposal.
4. Calculate:
   - Break-even probability = `askPrice / payout`
   - Model edge = `modelProbability - breakEvenProbability`
   - Expected value = `modelProbability * payout - askPrice`
5. Buy only when:
   - model probability >= 56%
   - edge >= configured minimum (default 5 percentage points)
   - expected value > 0
6. Start cooldown only after a purchase is accepted.

## Risk defaults

- Stake: $0.35 minimum
- Take profit: $2
- Stop loss: $1.50
- Max consecutive/session losses: 2
- Cooldown: 10 seconds
- REAL trading remains explicitly armed

These settings do not guarantee profitability. The strategy should be validated on DEMO with a large sample before REAL trading.
