const AUTH_URL = "https://auth.deriv.com/oauth2/auth";

const CONFIG_KEY = "edgepilot-deriv-oauth-config";
const SESSION_KEY = "edgepilot-deriv-oauth-session";
const VERIFIER_KEY = "edgepilot-deriv-pkce-verifier";
const STATE_KEY = "edgepilot-deriv-oauth-state";

const DEFAULT_CLIENT_ID = "33ZwwSOS2hgdlG91Hbk8Q";
const DEFAULT_REDIRECT_URI = "https://derivai.onrender.com/dashboard";

const BACKEND_URL = String(import.meta.env.VITE_OAUTH_BACKEND_URL || "")
  .trim()
  .replace(/\/+$/, "");

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

export function getDefaultRedirectUri() {
  return window.location.hostname === "localhost"
    ? "http://localhost:5173/dashboard"
    : DEFAULT_REDIRECT_URI;
}

export function loadOAuthConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    return {
      clientId: String(saved.clientId || DEFAULT_CLIENT_ID),
      redirectUri: String(saved.redirectUri || getDefaultRedirectUri()),
      scope: String(saved.scope || "trade account_manage"),
    };
  } catch {
    return {
      clientId: DEFAULT_CLIENT_ID,
      redirectUri: getDefaultRedirectUri(),
      scope: "trade account_manage",
    };
  }
}

export function saveOAuthConfig(config) {
  const clean = {
    clientId: String(config.clientId || DEFAULT_CLIENT_ID).trim(),
    redirectUri: String(
      config.redirectUri || getDefaultRedirectUri()
    ).trim(),
    scope: String(config.scope || "trade account_manage").trim(),
  };

  localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
  return clean;
}

export function loadOAuthSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

export function clearOAuthSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
}

export async function beginDerivLogin(configInput) {
  const config = saveOAuthConfig(configInput || loadOAuthConfig());

  const verifier = randomString(64);
  const challenge = base64Url(await sha256(verifier));
  const state = randomString(32);

  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  window.location.assign(`${AUTH_URL}?${params.toString()}`);
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
    accountType: String(item?.account_type || item?.type || ""),
    currency: String(item?.currency || ""),
    balance:
      item?.balance == null
        ? null
        : Number(item.balance?.value ?? item.balance),
    raw: item,
  }));
}

export async function completeDerivLogin() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const oauthDescription = url.searchParams.get("error_description");

  if (oauthError) {
    throw new Error(oauthDescription || oauthError);
  }

  if (!code) return null;

  if (!BACKEND_URL) {
    throw new Error("VITE_OAUTH_BACKEND_URL is not configured on Render.");
  }

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const config = loadOAuthConfig();

  if (!expectedState || returnedState !== expectedState) {
    throw new Error("OAuth state verification failed. Start login again.");
  }

  if (!verifier) {
    throw new Error("PKCE verifier is missing. Start login again.");
  }

  const response = await fetch(`${BACKEND_URL}/api/oauth/exchange`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      redirect_uri: config.redirectUri,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || "Deriv login completion failed.");
  }

  const accounts = normalizeAccounts(payload.accounts);

  const session = {
    accessToken: String(payload.access_token || ""),
    refreshToken: String(payload.refresh_token || ""),
    tokenType: String(payload.token_type || "Bearer"),
    expiresIn: Number(payload.expires_in || 0),
    createdAt: Date.now(),
    accounts,
    selectedAccountId: accounts[0]?.id || "",
  };

  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  ["code", "state", "scope", "session_state", "error", "error_description"].forEach(
    (key) => url.searchParams.delete(key)
  );

  window.history.replaceState(
    {},
    document.title,
    `${url.pathname}${url.search}${url.hash}`
  );

  return session;
}
