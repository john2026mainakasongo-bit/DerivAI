# Digit Over / Under V12

## Multi-market fast scanner

V12 keeps independent 60-digit books and analysis for:
- Volatility 100 Index
- Volatility 75 Index
- Volatility 25 Index
- Volatility 10 Index

### Execution flow
1. Subscribe to the four market tick streams concurrently.
2. Build a separate rolling 60-digit book for each market.
3. Evaluate OVER and UNDER candidates for barriers 2 and 1 on every scan.
4. Scan continuously (250 ms UI loop) rather than waiting for a 1-second scan interval.
5. Every 10 seconds the UI reports a market-cycle refresh, but entry discovery does not wait for that cycle.
6. Rank all valid candidates across all four markets.
7. Request the live Deriv proposal for the best candidate.
8. If the proposal fails payout/edge/EV validation, immediately try the next valid market candidate.
9. After settlement, immediately resume scanning all four books.
10. After a loss, block the exact failed contract key during cooldown and require a fresh tick before considering the same market setup again.

### Risk/validation
- The live proposal remains authoritative for payout and price.
- Positive EV and configured proposal edge are required before buying.
- DEMO and REAL use the same selection and entry logic; REAL still requires explicit authorization.
- V12 does not guarantee profitability and should be validated in DEMO before REAL use.

### Speed note
The scanner can only complete trades as quickly as Deriv supplies ticks, proposals, purchase confirmations, and contract settlements. The code does not promise a fixed number of trades per two-minute period.
