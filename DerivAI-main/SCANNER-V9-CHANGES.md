# Scanner V9 — stability and startup update

- Avoid immediate EACCES startup failure when SCANNER_DATA_DIR is unset: use writable ephemeral `/tmp/derivai-scanner` with a clear warning. For persistent signal history on Render, mount a disk and set SCANNER_DATA_DIR to its writable mount path.
- Prioritize R_100, R_75, R_50, R_25, R_10 when available; load common chart frames before the remaining frames.
- Reduce per-request artificial delay from 200 ms to 60 ms; historical requests remain serial to limit API load.
- Expose `warming`, `readyCount`, and `configuredPersistentStorage` in scanner status API.

Validation: Node syntax check passed; 24/24 automated Node tests passed. Frontend build could not be verified in this environment because Vite executable was unavailable (dependency install timed out). Live feed and Render deployment not tested. No profitability claims.
