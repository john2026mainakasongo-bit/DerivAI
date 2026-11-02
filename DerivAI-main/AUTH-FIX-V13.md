# Deriv OAuth Trading Connection Fix V13

## What changed

- Added `/api/oauth/refresh` to the OAuth backend.
- Added frontend refresh-token handling for short-lived OAuth access tokens.
- The frontend refreshes the Deriv session approximately 2 minutes before expiry.
- The refreshed access token and account list are persisted back into the active session.
- Existing authenticated WebSocket flow remains unchanged: the trading socket is still required before proposals/buys.

## Deploy

1. Deploy the `edgepilot-oauth-backend` changes to the OAuth backend service on Render.
2. Deploy the frontend changes to the main EdgePilot/DerivAI service.
3. Open the dashboard and select DEMO.
4. Confirm the Digit Over page shows:
   - Markets: 4/4
   - Books ready: 4/4
   - Trading connection: DEMO CONNECTED
5. Start the bot in DEMO.

If the existing browser session has no usable refresh token, log in to Deriv once again so a fresh OAuth session is created.
