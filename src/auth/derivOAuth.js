const AUTH_URL = "https://auth.deriv.com/oauth2/auth";

const CONFIG_KEY = "edgepilot-deriv-oauth-config";
const SESSION_KEY = "edgepilot-deriv-oauth-session";
const VERIFIER_KEY = "edgepilot-deriv-pkce-verifier";
const STATE_KEY = "edgepilot-deriv-oauth-state";
const CALLBACK_LOCK_KEY = "edgepilot-deriv-oauth-callback-lock";

const DEFAULT_CLIENT_ID = "33ZwwSOS2hgdlG91Hbk8Q";
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
  return btoa(String.fromCharCode(...bytes))
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
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

function readJsonStorage(storage, key, fallback = null) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function cleanOAuthParams(urlInput) {
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
  ].forEach((key) => url.searchParams.delete(key));

  window.history.replaceState(
    {},
    document.title,
    `${url.pathname}${url.search}${url.hash}`
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

  const list = candidates.find(Array.isArray) || [];

  return list
    .map((item, index) => {
      const raw = item && typeof item === "object" ? item : {};

      const id = String(
        raw.id ||
          raw.account_id ||
          raw.loginid ||
          raw.login_id ||
          raw.accountId ||
          `account-${index}`
      ).trim();

      const accountType = String(
        raw.account_type ||
          raw.accountType ||
          raw.type ||
          raw.display_type ||
          raw.displayType ||
          raw.raw?.account_type ||
          raw.raw?.type ||
          ""
      ).trim();

      // Keep the real Deriv currency instead of assuming USD.
      // Different account responses may expose it under slightly
      // different keys, so preserve all common variants.
      const currency = String(
        raw.currency ||
          raw.currency_code ||
          raw.currencyCode ||
          raw.account_currency ||
          raw.accountCurrency ||
          raw.raw?.currency ||
          raw.raw?.currency_code ||
          ""
      ).trim().toUpperCase();

      const balanceValue =
        raw.balance?.value ??
        raw.balance?.amount ??
        raw.balance ??
        raw.amount ??
        null;

      const balance =
        balanceValue == null || balanceValue === ""
          ? null
          : Number(balanceValue);

      return {
        ...raw,
        id,
        label: String(
          raw.display_name ||
            raw.name ||
            raw.account_type ||
            raw.accountType ||
            raw.loginid ||
            id ||
            `Deriv account ${index + 1}`
        ),
        accountType,
        currency: currency || "USD",
        balance: Number.isFinite(balance) ? balance : null,
        raw,
      };
    })
    .filter((account) => account.id);
}

function getCallbackLock() {
  return readJsonStorage(
    sessionStorage,
    CALLBACK_LOCK_KEY,
    null
  );
}

function callbackAlreadyProcessing(code) {
  const lock = getCallbackLock();

  if (!lock) return false;

  const sameCode =
    String(lock.code || "") === code;

  const age =
    Date.now() -
    Number(lock.createdAt || 0);

  return sameCode && age < 30000;
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

function saveOAuthSession(session) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify(session)
  );
}

export function getDefaultRedirectUri() {
  return window.location.hostname === "localhost"
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
  clearCallbackLock();

  oauthCompletionPromise = null;
  oauthCompletionCode = "";
}

export async function beginDerivLogin(configInput) {
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
  const url = new URL(window.location.href);

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
    cleanOAuthParams(url);

    throw new Error(
      oauthDescription || oauthError
    );
  }

  if (!code) {
    return loadOAuthSession();
  }

  if (
    oauthCompletionPromise &&
    oauthCompletionCode === code
  ) {
    return oauthCompletionPromise;
  }

  const existingSession =
    loadOAuthSession();

  if (
    callbackAlreadyProcessing(code) &&
    existingSession?.accessToken
  ) {
    cleanOAuthParams(url);
    return existingSession;
  }

  if (callbackAlreadyProcessing(code)) {
    cleanOAuthParams(url);

    throw new Error(
      "Deriv login is already being completed. Wait a moment, then reload the dashboard."
    );
  }

  const expectedState =
    sessionStorage.getItem(STATE_KEY);

  const verifier =
    sessionStorage.getItem(
      VERIFIER_KEY
    );

  const config = loadOAuthConfig();

  if (
    !expectedState ||
    !returnedState ||
    returnedState !== expectedState
  ) {
    cleanOAuthParams(url);

    throw new Error(
      "OAuth state verification failed. Start login again."
    );
  }

  if (!verifier) {
    cleanOAuthParams(url);

    throw new Error(
      "PKCE verifier is missing. Start login again."
    );
  }

  if (!BACKEND_URL) {
    cleanOAuthParams(url);

    throw new Error(
      "VITE_OAUTH_BACKEND_URL is not configured on Render."
    );
  }

  setCallbackLock(code);
  cleanOAuthParams(url);

  oauthCompletionCode = code;

  oauthCompletionPromise = (async () => {
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
          previousSession?.selectedAccountId
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
          ? previousSession.selectedAccountId
          : accounts[0]?.id || "",
    };

    if (!session.accessToken) {
      throw new Error(
        "Deriv did not return an access token."
      );
    }

    saveOAuthSession(session);

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
