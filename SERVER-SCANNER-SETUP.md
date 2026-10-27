# V8: Scanner without an open browser

## What runs
`npm start` runs the website and a separate market scanner in one Node.js process. The scanner connects directly to Deriv public market data; no browser, MT5 login or account token is required. It discovers supported R_* and *HZ*V volatility markets, loads OHLC history, then subscribes each market to ticks. It evaluates 1m/2m/3m/5m/10m/15m/30m/1h/2h/4h/8h setups. 24h candles supply higher-timeframe context only. Initialization is deliberately paced; markets become available progressively. Failed histories retry each minute and are listed under View analysis.

The scanner records zones, confirmations and simulated outcomes even with zero website visitors. It does not place or close trades. Confirmed prices stay fixed; SL and TP2 observations are terminal under the existing strategy. This is experimental quote simulation, not evidence of trading profitability.

## Render setup — required to run while the website is closed
This release is prepared code, not an already deployed server. A static site or a sleeping free instance cannot provide this function. Use an always-on paid Web Service with persistent disk. Creating/changing a plan incurs the provider's charges; review Render's displayed price before choosing it.

For the GitHub repo `john2026mainakasongo-bit/DerivAI`, branch `main`:
- Service type: Web Service, runtime Node; root directory empty (repository root).
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check: `/healthz`
- Environment: `NODE_VERSION=22.16.0`, `SCANNER_DATA_DIR=/var/data/derivai`
- Persistent disk mount path: `/var/data`. Use one service instance, one scanner process; this file store is not designed for replicas or shared writers.
- Do not set `SCANNER_TEST_MODE=1` in production (reserved for tests).

If the existing service is already a Web Service, edit these settings there. If it is a Static Site, create a separate Web Service with these settings and open that new service URL for `/mt5`. Keep the existing site until the new service is verified. This package serves frontend and API from the same origin; there is no cross-origin API configuration.

Validation after deploy:
1. `/api/scanner/status` must return JSON with `mode: server`, `status: Running`, blank `storageError`, and fresh ticks for the markets being tested. Some markets may still be loading or show errors; the UI must not be interpreted as covering those markets.
2. `/mt5` scanner card must show server status and the live-market count. `Browser only · server not deployed` means the server is not active at this URL.
3. Close every browser tab for several minutes, reopen `/api/scanner/status`, and confirm updated market tick times. A setup appears only when strategy criteria qualify; continuous operation does not guarantee continuous entries.
4. Export history, restart the service, and confirm previously recorded server IDs/outcomes are still returned by `/api/scanner/signals`.

## Persistence and migration
Server records live in `SCANNER_DATA_DIR/scanner.json`, written to a temporary file, fsynced and atomically renamed at status transitions and every five seconds. Corrupt stores stop startup rather than silently erasing history. Write errors pause signal processing and are displayed in health/UI. Attach the persistent disk before deployment; an environment variable alone does not create durable storage. Back up the JSON file and use Render disk backup facilities. A crash can lose up to the last five seconds of non-transition observations; no service promises uninterrupted network access.

Existing browser-only setups remain local archive/monitor records. They are NOT automatically uploaded to the public server, retrospectively confirmed, or relabelled as server observations. Export them before switching to a new URL, and Restore history JSON at the new URL. Server observations use a `server:` ID prefix and source `server`, are refreshed every five seconds, and are never advanced by client ticks. API data is shared public market research with no account balances, trading credentials or browser journal upload endpoint.

A feed disconnect or restart can create an observation gap. The engine marks gap-affected outcomes unverified and cancels unconfirmed sharp setups across gaps; it never pretends it monitored while offline. Existing local setups can update on all subscribed market ticks while the browser is open, but new local detection still follows the selected chart. Deploy the server for independent all-market detection.

## Local smoke check
Requires Node >=22.15. From PowerShell in the repo:
```
$env:SCANNER_DATA_DIR = Join-Path $env:LOCALAPPDATA 'DerivAI-Scanner'
npm.cmd run build
npm.cmd start
```
Open `http://localhost:3000/mt5`. Closing the browser will not stop this process, but closing PowerShell or switching off the computer will. Use the hosted server for operation independent of the computer.

References: https://render.com/docs/free ; https://render.com/docs/disks ; https://render.com/docs/web-services ; https://developers.deriv.com/docs/data/ticks-history/
