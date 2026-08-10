# Deriv AI Analyzer V9 — History Seed + Stable Bias

- Analyzer now seeds from the Deriv tick history already loaded by `useDerivTicks` instead of waiting for new page-local ticks.
- Entry Engine can analyze immediately after market history arrives instead of showing 5 ticks / collecting from zero.
- Rise/Fall context stays 50/50 while data is insufficient or the bias engine is WAIT; no misleading 100% / 0% startup state.
- Existing V8 compact UI, V7 scale protections, Touch/No Touch qualification and manual Deriv trading flow are retained.
