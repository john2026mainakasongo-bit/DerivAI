
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const ACCOUNTS_URL = "https://api.derivws.com/trading/v1/options/accounts";

const CONFIG_KEY = "edgepilot-deriv-oauth-config";
const SESSION_KEY = "edgepilot-deriv-oauth-session";
const VERIFIER_KEY = "edgepilot-deriv-pkce-verifier";
const STATE_KEY = "edgepilot-deriv-oauth-state";

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
  return `${window.location.origin}/dashboard`;
}

export function loadOAuthConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    return {
      clientId: String(saved.clientId || ""),
      redirectUri: String(saved.redirectUri || getDefaultRedirectUri()),
      scope: String(saved.scope || "trade account_manage"),
    };
  } catch {
    return {
      clientId: "",
      redirectUri: getDefaultRedirectUri(),
      scope: "trade account_manage",
    };
  }
}

export function saveOAuthConfig(config) {
  const clean = {
    clientId: String(config.clientId || "").trim(),
    redirectUri: String(config.redirectUri || getDefaultRedirectUri()).trim(),
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

  if (!config.clientId) {
    throw new Error("Enter your registered Deriv OAuth Client ID first.");
  }

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

function tokenValue(payload, ...keys) {
  for (const key of keys) {
    if (payload?.[key] != null) return payload[key];
    if (payload?.data?.[key] != null) return payload.data[key];
  }

  return null;
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

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const config = loadOAuthConfig();

  if (!expectedState || returnedState !== expectedState) {
    throw new Error("OAuth state verification failed. Start login again.");
  }

  if (!verifier) {
    throw new Error("PKCE verifier is missing. Start login again.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload?.error_description ||
        payload?.error?.message ||
        payload?.message ||
        "Deriv token exchange failed."
    );
  }

  const accessToken = tokenValue(payload, "access_token", "token");

  if (!accessToken) {
    throw new Error("Deriv did not return an access token.");
  }

  const session = {
    accessToken,
    refreshToken: tokenValue(payload, "refresh_token"),
    tokenType: tokenValue(payload, "token_type") || "Bearer",
    expiresIn: Number(tokenValue(payload, "expires_in") || 0),
    createdAt: Date.now(),
    accounts: [],
    selectedAccountId: "",
  };

  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("scope");
  url.searchParams.delete("session_state");

  window.history.replaceState(
    {},
    document.title,
    `${url.pathname}${url.search}${url.hash}`
  );

  return session;
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

export async function fetchDerivAccounts(sessionInput) {
  const session = sessionInput || loadOAuthSession();
  const config = loadOAuthConfig();

  if (!session?.accessToken) {
    throw new Error("Deriv session is not available.");
  }

  const response = await fetch(ACCOUNTS_URL, {
    headers: {
      "Deriv-App-ID": config.clientId,
      Authorization: `Bearer ${session.accessToken}`,
      Accept: "application/json",
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload?.errors?.[0]?.message ||
        payload?.error?.message ||
        payload?.message ||
        "Unable to load Deriv accounts."
    );
  }

  const accounts = normalizeAccounts(payload);

  const next = {
    ...session,
    accounts,
    selectedAccountId:
      session.selectedAccountId || accounts[0]?.id || "",
  };

  sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  return next;
}
