# Zentora / EdgePilot — Clean Trading Dashboard

This is the cleaned production project extracted from the current Zentora dashboard.

## Included
- React + Vite dashboard
- Deriv OAuth login and Demo/Real account switching
- Authenticated Deriv trading WebSocket
- Automatic authenticated reconnect with backoff
- Tick streaming
- 1m / 5m / 15m historical OHLC candles
- Real-time candle updates from ticks
- Rise/Fall manual trading
- Contract lifecycle tracking and WIN/LOSS results
- Session risk manager
- OAuth backend for secure code exchange

## Removed
- Legacy `DerivAI-StrategyEngine-V5` nested project
- Old backup copies
- Old version patch scripts
- Unused strategy-lab files
- Unused duplicate UI components
- Old `.before-*` and `.V30-*` files

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## OAuth backend

```bash
cd edgepilot-oauth-backend
npm install
npm start
```

Set the backend environment variables used by the existing OAuth flow:
- `DERIV_CLIENT_ID`
- `DERIV_REDIRECT_URI`
- `ALLOWED_ORIGINS`

The browser app can use `VITE_OAUTH_BACKEND_URL` when the OAuth exchange is served by the backend.
