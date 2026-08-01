const AUTH_URL = "https://auth.deriv.com/oauth2/auth";

const CONFIG_KEY = "edgepilot-deriv-oauth-config";
const SESSION_KEY = "edgepilot-deriv-oauth-session";
const VERIFIER_KEY = "edgepilot-deriv-pkce-verifier";
const STATE_KEY = "edgepilot-deriv-oauth-state";

const CALLBACK_LOCK_KEY =
  "edgepilot-deriv-oauth-callback-lock";

const DEFAULT_CLIENT_ID =
  "33ZwwSOS2hgdlG91Hbk8Q";

const DEFAULT_REDIRECT_URI =
  "https://edgepilot-ai-tmdr.onrender.com/dashboard";

const BACKEND_URL = String(
  import.meta.env.VITE_OAUTH_BACKEND_URL || ""
)
  .trim()
  .replace(/\/+$/, "");

let oauthCompletionPromise = null;
let oauthCompletionCode = "";

function base64Url(bytes) {
  return btoa(
    String.fromCharCode(...bytes)
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomString(length = 48) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(
    value
  );

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );

  return new Uint8Array(digest);
}

function cleanUrl(urlInput) {
  const url =
    urlInput instanceof URL
      ? urlInput
      : new URL(window.location.href);

  [
    "code",
    "state",
    "scope",
    "session_state",
    "error",
    "error_description",
  ].forEach((key) =>
    url.searchParams.delete(key)
  );

  const nextUrl =
    `${url.pathname}${url.search}${url.hash}`;

  window.history.replaceState(
    {},
    document.title,
    nextUrl
  );
}

function readJsonStorage(
  storage,
  key,
  fallback = null
) {
  try {
    const raw = storage.getItem(key);

    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeSession(session) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify(session)
  );
}

function normalizeAccounts(payload) {
  const candidates = [
    payload?.data,
    payload?.accounts,
    payload?.data?.accounts,
    payload?.result,
    payload,
  ];

  const list =
    candidates.find(Array.isArray) || [];

  return list.map((item, index) => ({
    id: String(
      item?.id ||
        item?.account_id ||
        item?.loginid ||
        item?.login_id ||
        `account-${index}`
    ),

    label: String(
      item?.display_name ||
        item?.name ||
        item?.account_type ||
        item?.loginid ||
        `Deriv account ${index + 1}`
    ),

    accountType: String(
      item?.account_type ||
        item?.type ||
        ""
    ),

    currency: String(
      item?.currency || ""
    ),

    balance:
      item?.balance == null
        ? null
        : Number(
            item.balance?.value ??
              item.balance
          ),

    raw: item,
  }));
}

function callbackAlreadyProcessing(code) {
  const lock = readJsonStorage(
    sessionStorage,
    CALLBACK_LOCK_KEY,
    null
  );

  if (!lock) {
    return false;
  }

  const sameCode =
    String(lock.code || "") === code;

  const age =
    Date.now() -
    Number(lock.createdAt || 0);

  /*
   * Ignore a stale lock after 30 seconds.
   */
  return sameCode && age < 30_000;
}

function setCallbackLock(code) {
  sessionStorage.setItem(
    CALLBACK_LOCK_KEY,
    JSON.stringify({
      code,
      createdAt: Date.now(),
    })
  );
}

function clearCallbackLock() {
  sessionStorage.removeItem(
    CALLBACK_LOCK_KEY
  );
}

export function getDefaultRedirectUri() {
  return window.location.hostname ===
    "localhost"
    ? "http://localhost:5173/dashboard"
    : DEFAULT_REDIRECT_URI;
}

export function loadOAuthConfig() {
  const saved = readJsonStorage(
    localStorage,
    CONFIG_KEY,
    {}
  );

  return {
    clientId: String(
      saved?.clientId ||
        DEFAULT_CLIENT_ID
    ),

    redirectUri: String(
      saved?.redirectUri ||
        getDefaultRedirectUri()
    ),

    scope: String(
      saved?.scope ||
        "trade account_manage"
    ),
  };
}

export function saveOAuthConfig(config) {
  const clean = {
    clientId: String(
      config?.clientId ||
        DEFAULT_CLIENT_ID
    ).trim(),

    redirectUri: String(
      config?.redirectUri ||
        getDefaultRedirectUri()
    ).trim(),

    scope: String(
      config?.scope ||
        "trade account_manage"
    ).trim(),
  };

  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify(clean)
  );

  return clean;
}

export function loadOAuthSession() {
  return readJsonStorage(
    sessionStorage,
    SESSION_KEY,
    null
  );
}

export function clearOAuthSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(
    CALLBACK_LOCK_KEY
  );

  oauthCompletionPromise = null;
  oauthCompletionCode = "";
}

export async function beginDerivLogin(
  configInput
) {
  const config = saveOAuthConfig(
    configInput || loadOAuthConfig()
  );

  const verifier = randomString(64);

  const challenge = base64Url(
    await sha256(verifier)
  );

  const state = randomString(32);

  sessionStorage.setItem(
    VERIFIER_KEY,
    verifier
  );

  sessionStorage.setItem(
    STATE_KEY,
    state
  );

  clearCallbackLock();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  window.location.assign(
    `${AUTH_URL}?${params.toString()}`
  );
}

export async function completeDerivLogin() {
  const url = new URL(
    window.location.href
  );

  const code = String(
    url.searchParams.get("code") || ""
  ).trim();

  const returnedState = String(
    url.searchParams.get("state") || ""
  ).trim();

  const oauthError =
    url.searchParams.get("error");

  const oauthDescription =
    url.searchParams.get(
      "error_description"
    );

  if (oauthError) {
    cleanUrl(url);

    throw new Error(
      oauthDescription || oauthError
    );
  }

  if (!code) {
    return loadOAuthSession();
  }

  /*
   * Multiple React renders must share
   * the same token-exchange request.
   */
  if (
    oauthCompletionPromise &&
    oauthCompletionCode === code
  ) {
    return oauthCompletionPromise;
  }

  /*
   * The authorization code is one-time.
   * Remove it from the browser URL before
   * starting the network request.
   */
  cleanUrl(url);

  const existingSession =
    loadOAuthSession();

  /*
   * If another mounted provider already
   * completed the callback, reuse its session.
   */
  if (
    callbackAlreadyProcessing(code) &&
    existingSession?.accessToken
  ) {
    return existingSession;
  }

  if (callbackAlreadyProcessing(code)) {
    throw new Error(
      "Deriv login is already being completed. Wait a moment, then reload the dashboard."
    );
  }

  setCallbackLock(code);

  oauthCompletionCode = code;

  oauthCompletionPromise =
    (async () => {
      if (!BACKEND_URL) {
        throw new Error(
          "VITE_OAUTH_BACKEND_URL is not configured on Render."
        );
      }

      const expectedState =
        sessionStorage.getItem(
          STATE_KEY
        );

      const verifier =
        sessionStorage.getItem(
          VERIFIER_KEY
        );

      const config =
        loadOAuthConfig();

      if (
        !expectedState ||
        !returnedState ||
        returnedState !== expectedState
      ) {
        throw new Error(
          "OAuth state verification failed. Start login again."
        );
      }

      if (!verifier) {
        throw new Error(
          "PKCE verifier is missing. Start login again."
        );
      }

      const response = await fetch(
        `${BACKEND_URL}/api/oauth/exchange`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            code,
            code_verifier: verifier,
            redirect_uri:
              config.redirectUri,
          }),
        }
      );

      const payload = await response
        .json()
        .catch(() => ({}));

      if (
        !response.ok ||
        !payload?.ok
      ) {
        throw new Error(
          payload?.error ||
            `Deriv login completion failed (${response.status}).`
        );
      }

      const accounts =
        normalizeAccounts(
          payload.accounts
        );

      const previousSession =
        loadOAuthSession();

      const selectedStillExists =
        accounts.some(
          (account) =>
            account.id ===
            previousSession
              ?.selectedAccountId
        );

      const session = {
        accessToken: String(
          payload.access_token || ""
        ),

        refreshToken: String(
          payload.refresh_token || ""
        ),

        tokenType: String(
          payload.token_type ||
            "Bearer"
        ),

        expiresIn: Number(
          payload.expires_in || 0
        ),

        createdAt: Date.now(),

        accounts,

        selectedAccountId:
          selectedStillExists
            ? previousSession
                .selectedAccountId
            : accounts[0]?.id || "",
      };

      if (!session.accessToken) {
        throw new Error(
          "Deriv did not return an access token."
        );
      }

      writeSession(session);

      sessionStorage.removeItem(
        VERIFIER_KEY
      );

      sessionStorage.removeItem(
        STATE_KEY
      );

      clearCallbackLock();

      return session;
    })();

  try {
    return await oauthCompletionPromise;
  } catch (error) {
    clearCallbackLock();
    throw error;
  } finally {
    oauthCompletionPromise = null;
    oauthCompletionCode = "";
  }
}

export async function fetchDerivAccounts(
  sessionInput
) {
  const session =
    sessionInput ||
    loadOAuthSession();

  if (!session?.accessToken) {
    throw new Error(
      "Deriv session is not available."
    );
  }

  /*
   * The backend already returns accounts
   * during OAuth exchange. Keep the same
   * session instead of exchanging the
   * authorization code again.
   */
  return {
    ...session,

    accounts: Array.isArray(
      session.accounts
    )
      ? session.accounts
      : [],

    selectedAccountId:
      session.selectedAccountId ||
      session.accounts?.[0]?.id ||
      "",
  };
}