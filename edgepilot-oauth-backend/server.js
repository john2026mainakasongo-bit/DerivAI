import express from "express";
import cors from "cors";

const app = express();

const PORT = Number(process.env.PORT || 10000);

const DERIV_CLIENT_ID = String(
  process.env.DERIV_CLIENT_ID || ""
).trim();

const DERIV_REDIRECT_URI = String(
  process.env.DERIV_REDIRECT_URI || ""
).trim();

const DERIV_TOKEN_URL =
  "https://auth.deriv.com/oauth2/token";

const DERIV_ACCOUNTS_URL =
  "https://api.derivws.com/trading/v1/options/accounts";

const allowedOrigins = String(
  process.env.ALLOWED_ORIGINS || ""
)
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/+$/, "");
}

app.disable("x-powered-by");

app.use(
  cors({
    origin(origin, callback) {
      /*
       * Requests without Origin include health checks,
       * curl and server-to-server requests.
       */
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalized = normalizeOrigin(origin);

      if (allowedOrigins.includes(normalized)) {
        callback(null, true);
        return;
      }

      callback(
        new Error(
          `CORS blocked request from origin: ${normalized}`
        )
      );
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

app.use(express.json({ limit: "100kb" }));
app.use(
  express.urlencoded({
    extended: false,
    limit: "100kb",
  })
);

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getErrorMessage(payload, fallback) {
  return (
    payload?.error_description ||
    payload?.message ||
    payload?.error?.message ||
    payload?.error ||
    fallback
  );
}

async function readResponse(response) {
  const text = await response.text();
  const json = safeJson(text);

  return {
    text,
    json,
  };
}

async function fetchDerivAccounts(accessToken) {
  try {
    const response = await fetch(DERIV_ACCOUNTS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Deriv-App-ID": DERIV_CLIENT_ID,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    const result = await readResponse(response);

    if (!response.ok) {
      console.error(
        "Deriv account request failed:",
        response.status,
        getErrorMessage(
          result.json,
          "Unable to retrieve Deriv accounts."
        )
      );

      return [];
    }

    const payload = result.json || {};

    if (Array.isArray(payload)) {
      return payload;
    }

    if (Array.isArray(payload.data)) {
      return payload.data;
    }

    if (Array.isArray(payload.accounts)) {
      return payload.accounts;
    }

    if (Array.isArray(payload.data?.accounts)) {
      return payload.data.accounts;
    }

    return [];
  } catch (error) {
    console.error(
      "Unable to retrieve Deriv accounts:",
      error instanceof Error
        ? error.message
        : String(error)
    );

    /*
     * Login may still be successful even if the
     * account-list endpoint temporarily fails.
     */
    return [];
  }
}

app.get("/", (request, response) => {
  response.status(200).json({
    ok: true,
    service: "EdgePilot OAuth backend",
    status: "running",
  });
});

app.get("/health", (request, response) => {
  response.status(200).json({
    ok: true,
    service: "EdgePilot OAuth backend",
    clientConfigured: Boolean(DERIV_CLIENT_ID),
    redirectConfigured: Boolean(DERIV_REDIRECT_URI),
    allowedOriginsConfigured:
      allowedOrigins.length > 0,
  });
});

app.post(
  "/api/oauth/exchange",
  async (request, response) => {
    try {
      if (!DERIV_CLIENT_ID) {
        return response.status(500).json({
          ok: false,
          error:
            "DERIV_CLIENT_ID is not configured on the backend.",
        });
      }

      if (!DERIV_REDIRECT_URI) {
        return response.status(500).json({
          ok: false,
          error:
            "DERIV_REDIRECT_URI is not configured on the backend.",
        });
      }

      const code = String(
        request.body?.code || ""
      ).trim();

      const codeVerifier = String(
        request.body?.code_verifier || ""
      ).trim();

      const requestedRedirectUri = String(
        request.body?.redirect_uri || ""
      ).trim();

      if (!code) {
        return response.status(400).json({
          ok: false,
          error:
            "Authorization code is missing.",
        });
      }

      if (!codeVerifier) {
        return response.status(400).json({
          ok: false,
          error:
            "PKCE code_verifier is missing.",
        });
      }

      /*
       * Prevent the browser from changing the callback
       * address during token exchange.
       */
      if (
        requestedRedirectUri &&
        requestedRedirectUri !== DERIV_REDIRECT_URI
      ) {
        return response.status(400).json({
          ok: false,
          error:
            "The frontend redirect URI does not match the backend redirect URI.",
          expectedRedirectUri: DERIV_REDIRECT_URI,
        });
      }

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: DERIV_CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: DERIV_REDIRECT_URI,
      });

      const tokenResponse = await fetch(
        DERIV_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: tokenBody.toString(),
        }
      );

      const tokenResult =
        await readResponse(tokenResponse);

      if (!tokenResponse.ok) {
        const errorMessage = getErrorMessage(
          tokenResult.json,
          `Deriv token exchange failed (${tokenResponse.status}).`
        );

        console.error(
          "Deriv token exchange failed:",
          tokenResponse.status,
          errorMessage
        );

        return response
          .status(tokenResponse.status)
          .json({
            ok: false,
            error: errorMessage,
          });
      }

      const tokenPayload =
        tokenResult.json || {};

      const accessToken = String(
        tokenPayload.access_token || ""
      );

      if (!accessToken) {
        return response.status(502).json({
          ok: false,
          error:
            "Deriv did not return an access token.",
        });
      }

      const accounts =
        await fetchDerivAccounts(accessToken);

      return response.status(200).json({
        ok: true,
        access_token: accessToken,
        refresh_token: String(
          tokenPayload.refresh_token || ""
        ),
        token_type: String(
          tokenPayload.token_type || "Bearer"
        ),
        expires_in: Number(
          tokenPayload.expires_in || 0
        ),
        scope: String(
          tokenPayload.scope || ""
        ),
        accounts,
      });
    } catch (error) {
      console.error(
        "OAuth exchange server error:",
        error instanceof Error
          ? error.message
          : String(error)
      );

      return response.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "OAuth token exchange failed.",
      });
    }
  }
);

app.use((error, request, response, next) => {
  if (
    error instanceof Error &&
    error.message.startsWith("CORS blocked")
  ) {
    return response.status(403).json({
      ok: false,
      error: error.message,
    });
  }

  console.error("Unhandled server error:", error);

  return response.status(500).json({
    ok: false,
    error: "Internal server error.",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `EdgePilot OAuth backend listening on port ${PORT}`
  );

  console.log(
    `Redirect URI: ${
      DERIV_REDIRECT_URI || "NOT CONFIGURED"
    }`
  );

  console.log(
    `Allowed origins: ${
      allowedOrigins.join(", ") ||
      "NOT CONFIGURED"
    }`
  );
});