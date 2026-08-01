import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const DERIV_CLIENT_ID = String(process.env.DERIV_CLIENT_ID || "").trim();
const DERIV_CLIENT_SECRET = String(process.env.DERIV_CLIENT_SECRET || "").trim();
const DERIV_REDIRECT_URI = String(
  process.env.DERIV_REDIRECT_URI || "https://derivai.onrender.com/dashboard"
).trim();

const allowedOrigins = String(
  process.env.ALLOWED_ORIGINS ||
    "https://derivai.onrender.com,http://localhost:5173"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const ACCOUNTS_URL = "https://api.derivws.com/trading/v1/options/accounts";

app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed."));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

function requireConfig() {
  if (!DERIV_CLIENT_ID) throw new Error("DERIV_CLIENT_ID is missing.");
  if (!DERIV_CLIENT_SECRET) throw new Error("DERIV_CLIENT_SECRET is missing.");
  if (!DERIV_REDIRECT_URI) throw new Error("DERIV_REDIRECT_URI is missing.");
}

function safeError(payload, fallback) {
  return (
    payload?.error_description ||
    payload?.error?.message ||
    payload?.errors?.[0]?.message ||
    payload?.message ||
    fallback
  );
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "EdgePilot Deriv OAuth Backend" });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(
      DERIV_CLIENT_ID && DERIV_CLIENT_SECRET && DERIV_REDIRECT_URI
    ),
  });
});

app.post("/api/oauth/exchange", async (req, res) => {
  try {
    requireConfig();

    const code = String(req.body?.code || "").trim();
    const codeVerifier = String(req.body?.code_verifier || "").trim();
    const redirectUri = String(
      req.body?.redirect_uri || DERIV_REDIRECT_URI
    ).trim();

    if (!code) {
      return res.status(400).json({ ok: false, error: "Authorization code is required." });
    }

    if (!codeVerifier) {
      return res.status(400).json({ ok: false, error: "PKCE code verifier is required." });
    }

    if (redirectUri !== DERIV_REDIRECT_URI) {
      return res.status(400).json({
        ok: false,
        error: "Redirect URI does not match backend configuration.",
      });
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: DERIV_CLIENT_ID,
      client_secret: DERIV_CLIENT_SECRET,
      code,
      redirect_uri: DERIV_REDIRECT_URI,
      code_verifier: codeVerifier,
    });

    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    const tokenPayload = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok) {
      return res.status(tokenResponse.status).json({
        ok: false,
        error: safeError(tokenPayload, "Deriv token exchange failed."),
      });
    }

    const accessToken =
      tokenPayload?.access_token ||
      tokenPayload?.data?.access_token ||
      tokenPayload?.token ||
      tokenPayload?.data?.token ||
      "";

    if (!accessToken) {
      return res.status(502).json({
        ok: false,
        error: "Deriv did not return an access token.",
      });
    }

    const accountsResponse = await fetch(ACCOUNTS_URL, {
      headers: {
        "Deriv-App-ID": DERIV_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    const accountsPayload = await accountsResponse.json().catch(() => ({}));

    if (!accountsResponse.ok) {
      return res.status(accountsResponse.status).json({
        ok: false,
        error: safeError(accountsPayload, "Unable to load Deriv accounts."),
      });
    }

    res.set("Cache-Control", "no-store");

    return res.json({
      ok: true,
      access_token: accessToken,
      refresh_token:
        tokenPayload?.refresh_token ||
        tokenPayload?.data?.refresh_token ||
        "",
      token_type:
        tokenPayload?.token_type ||
        tokenPayload?.data?.token_type ||
        "Bearer",
      expires_in: Number(
        tokenPayload?.expires_in ||
          tokenPayload?.data?.expires_in ||
          0
      ),
      accounts: accountsPayload,
    });
  } catch (error) {
    console.error("OAuth exchange error:", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "OAuth backend failed.",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`EdgePilot OAuth backend listening on ${PORT}`);
});
