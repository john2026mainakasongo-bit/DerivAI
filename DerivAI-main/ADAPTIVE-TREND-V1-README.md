# Zentora Adaptive Trend Bot V1
Separate desk: `/adaptive-trend`.

Strategy: EMA 9/21 trend regime + slope + momentum + RSI + pullback gate. Auto-entry requires A+ only, one open contract, cooldown, session TP/SL and max-loss protection. REAL trading requires an explicit Arm REAL toggle.

Start in DEMO. This is not a guaranteed-profit system. The bot reuses the project's existing Deriv trading adapter and its proposal-before-buy flow.

Phone install:
1. Extract this ZIP.
2. Copy the included files over `~/DerivAI`.
3. `cd ~/DerivAI && npm run build`
4. If build passes: `git add src && git commit -m "Add Adaptive Trend Bot V1" && git push origin main`
