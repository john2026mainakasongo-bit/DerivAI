# DerivAI

DerivAI is a React/Vite trading interface for Deriv with two independent trading desks.

## Desk flow

- `/dashboard` — bot selection/control center only.
- `/rise-fall` — dedicated Rise / Fall trading desk.
- `/touch-no-touch` — dedicated Touch / No Touch trading desk.
- `/login` — Deriv OAuth login.

Rise / Fall and Touch / No Touch do not share strategy logic. The Rise / Fall desk no longer uses Touch / No Touch proposal confirmation.

## Touch / No Touch

The Touch desk uses Deriv `ONETOUCH` and `NOTOUCH` proposals and checks `contracts_for` availability before allowing proposal tests or automated execution. Proposal pricing is treated as a market quote, not a guaranteed probability.

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

The final source package intentionally excludes `node_modules`, `dist`, and old backup files. Install dependencies on the target machine with `npm install` before building.
