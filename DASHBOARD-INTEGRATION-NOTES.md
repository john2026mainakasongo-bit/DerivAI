# DerivAI Dashboard Integration

Integrated the dashboard UI into the main DerivAI trading project.

Changes:
- Main dashboard remains at /dashboard.
- StrategyEngineV36.jsx now uses the dashboard layout.
- Added live CandlestickChart.jsx.
- Dashboard branding is DerivAI (not Zentora).
- Existing DerivAI trading/auth/market services are preserved from the full backup.
- Live open contracts and transaction stream are sourced from useDerivTicks().
