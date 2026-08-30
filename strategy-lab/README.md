# Deriv Strategy Lab V1

Standalone module intended to be placed into the existing Deriv dashboard later.

## What it contains
- Rule-based signal engine
- EMA + momentum + volatility filters
- WAIT state when conditions are weak
- Fixed-risk research model
- No martingale / no loss doubling
- Historical-style backtest screen
- Responsive UI

## Important
The included backtest uses generated research data so the module is completely standalone.
It is NOT evidence of profitability and does not simulate Deriv contract payouts.

## Integration plan
When the full project ZIP is provided:
1. Keep the strategy engine isolated.
2. Connect the data adapter to the project's existing Deriv live/history feed.
3. Reuse the project's existing auth/API connection instead of creating a second one.
4. Add the module to the appropriate dashboard route/component.
5. Preserve existing features and styles unless specifically replaced.
6. Validate with demo/historical data before enabling real-money execution.

## Suggested next version
A real-data adapter can expose:
`onTicks(ticks)`, `getHistory(symbol, count)`, and optionally `getAccountBalance()`.

The strategy should remain a signal/research component unless the user explicitly chooses to build an execution layer.
