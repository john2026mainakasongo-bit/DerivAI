import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  beginDerivLogin,
  clearOAuthSession,
  completeDerivLogin,
  fetchDerivAccounts,
  loadOAuthConfig,
  loadOAuthSession,
  saveOAuthConfig,
} from "./derivOAuth";

const DerivAuthContext = createContext(null);

const SESSION_KEY = "edgepilot-deriv-oauth-session";
const API_BASE_URL = "https://api.derivws.com";

function saveSession(session) {
  if (!session) {
    sessionStorage.removeItem(SESSION_KEY);
    return;
  }

  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify(session)
  );
}

function getAccountId(account) {
  return String(
    account?.id ||
      account?.account_id ||
      account?.loginid ||
      account?.login_id ||
      ""
  );
}

function getAccountType(account) {
  const value = String(
    account?.accountType ||
      account?.account_type ||
      account?.type ||
      account?.raw?.account_type ||
      account?.raw?.type ||
      ""
  ).toLowerCase();

  if (
    value.includes("demo") ||
    value.includes("virtual")
  ) {
    return "demo";
  }

  if (
    value.includes("real") ||
    value.includes("financial")
  ) {
    return "real";
  }

  const id = getAccountId(account).toUpperCase();

  if (
    id.startsWith("VRTC") ||
    id.startsWith("VR") ||
    id.includes("DEMO")
  ) {
    return "demo";
  }

  return "real";
}

function accountLabel(account) {
  const type = getAccountType(account);

  return type === "demo"
    ? "Demo Account"
    : "Real Account";
}

function normalizeBalanceMessage(message) {
  const payload =
    message?.balance ||
    message?.data?.balance ||
    message?.data ||
    null;

  if (!payload) return null;

  const value = Number(
    payload?.balance?.value ??
      payload?.balance ??
      payload?.value
  );

  if (!Number.isFinite(value)) {
    return null;
  }

  return {
    balance: value,
    currency: String(
      payload?.currency ||
        payload?.balance?.currency ||
        "USD"
    ),
  };
}

export function DerivAuthProvider({ children }) {
  const [config, setConfigState] =
    useState(loadOAuthConfig);

  const [session, setSession] =
    useState(loadOAuthSession);

  const [loading, setLoading] =
    useState(false);

  const [accountsLoading, setAccountsLoading] =
    useState(false);

  const [balanceStatus, setBalanceStatus] =
    useState("idle");

  const [authError, setAuthError] =
    useState("");

  const [showSetup, setShowSetup] =
    useState(false);

  const balanceSocketRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  const persistSession = useCallback((next) => {
    setSession(next);
    saveSession(next);
    return next;
  }, []);

  const updateConfig = useCallback((next) => {
    const saved = saveOAuthConfig(next);
    setConfigState(saved);
    return saved;
  }, []);

  const login = useCallback(async () => {
    setAuthError("");

    if (!config.clientId) {
      setShowSetup(true);
      return;
    }

    try {
      await beginDerivLogin(config);
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : "Unable to start login."
      );
    }
  }, [config]);

  const logout = useCallback(() => {
    if (balanceSocketRef.current) {
      balanceSocketRef.current.close();
      balanceSocketRef.current = null;
    }

    window.clearTimeout(
      reconnectTimerRef.current
    );

    clearOAuthSession();
    persistSession(null);
    setAuthError("");
    setBalanceStatus("idle");
  }, [persistSession]);

  const refreshAccounts = useCallback(
    async (sessionInput) => {
      const activeSession =
        sessionInput || session;

      if (!activeSession?.accessToken) {
        return null;
      }

      setAccountsLoading(true);

      try {
        const next =
          await fetchDerivAccounts(
            activeSession
          );

        const accounts = Array.isArray(
          next?.accounts
        )
          ? next.accounts
          : [];

        const selectedStillExists =
          accounts.some(
            (account) =>
              getAccountId(account) ===
              next.selectedAccountId
          );

        const selectedAccountId =
          selectedStillExists
            ? next.selectedAccountId
            : getAccountId(accounts[0]);

        return persistSession({
          ...next,
          accounts,
          selectedAccountId,
        });
      } catch (error) {
        setAuthError(
          error instanceof Error
            ? error.message
            : "Unable to load Deriv accounts."
        );

        return null;
      } finally {
        setAccountsLoading(false);
      }
    },
    [persistSession, session]
  );

  const selectAccount = useCallback(
    (accountId) => {
      if (!session) return;

      const exists = session.accounts?.some(
        (account) =>
          getAccountId(account) ===
          accountId
      );

      if (!exists) return;

      persistSession({
        ...session,
        selectedAccountId: accountId,
      });

      setAuthError("");
    },
    [persistSession, session]
  );

  useEffect(() => {
    let cancelled = false;

    async function finishLogin() {
      const params = new URLSearchParams(
        window.location.search
      );

      if (
        !params.has("code") &&
        !params.has("error")
      ) {
        return;
      }

      setLoading(true);
      setAuthError("");

      try {
        const next =
          await completeDerivLogin();

        if (cancelled || !next) return;

        const withAccounts =
          await fetchDerivAccounts(next);

        if (cancelled) return;

        const accounts = Array.isArray(
          withAccounts?.accounts
        )
          ? withAccounts.accounts
          : [];

        persistSession({
          ...withAccounts,
          accounts,
          selectedAccountId:
            withAccounts.selectedAccountId ||
            getAccountId(accounts[0]),
        });
      } catch (error) {
        if (!cancelled) {
          setAuthError(
            error instanceof Error
              ? error.message
              : "Deriv login failed."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void finishLogin();

    return () => {
      cancelled = true;
    };
  }, [persistSession]);

  useEffect(() => {
    if (
      !session?.accessToken ||
      !session?.accounts?.length
    ) {
      return;
    }

    const selectedExists =
      session.accounts.some(
        (account) =>
          getAccountId(account) ===
          session.selectedAccountId
      );

    if (!selectedExists) {
      persistSession({
        ...session,
        selectedAccountId:
          getAccountId(session.accounts[0]),
      });
    }
  }, [persistSession, session]);

  const selectedAccount = useMemo(() => {
    const accounts = Array.isArray(
      session?.accounts
    )
      ? session.accounts
      : [];

    return (
      accounts.find(
        (account) =>
          getAccountId(account) ===
          session?.selectedAccountId
      ) ||
      accounts[0] ||
      null
    );
  }, [session]);

  useEffect(() => {
    let disposed = false;

    window.clearTimeout(
      reconnectTimerRef.current
    );

    if (balanceSocketRef.current) {
      balanceSocketRef.current.close();
      balanceSocketRef.current = null;
    }

    const accountId =
      getAccountId(selectedAccount);

    if (
      !session?.accessToken ||
      !config.clientId ||
      !accountId
    ) {
      setBalanceStatus("idle");
      return undefined;
    }

    async function connectBalance() {
      setBalanceStatus("connecting");

      try {
        const response = await fetch(
          `${API_BASE_URL}/trading/v1/options/accounts/${encodeURIComponent(
            accountId
          )}/otp`,
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${session.accessToken}`,
              "Deriv-App-ID":
                config.clientId,
              Accept: "application/json",
            },
          }
        );

        const payload = await response
          .json()
          .catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            payload?.errors?.[0]?.message ||
              payload?.error?.message ||
              payload?.message ||
              `Unable to open account balance feed (${response.status}).`
          );
        }

        const websocketUrl =
          payload?.data?.url ||
          payload?.url;

        if (!websocketUrl) {
          throw new Error(
            "Deriv did not return the account WebSocket URL."
          );
        }

        if (disposed) return;

        const socket =
          new WebSocket(websocketUrl);

        balanceSocketRef.current = socket;

        socket.onopen = () => {
          if (disposed) return;

          setBalanceStatus("live");

          socket.send(
            JSON.stringify({
              balance: 1,
              subscribe: 1,
            })
          );
        };

        socket.onmessage = (event) => {
          if (disposed) return;

          let message;

          try {
            message = JSON.parse(
              event.data
            );
          } catch {
            return;
          }

          if (message?.error) {
            setAuthError(
              message.error.message ||
                "Unable to read the selected account balance."
            );
            return;
          }

          const balance =
            normalizeBalanceMessage(
              message
            );

          if (!balance) return;

          setSession((current) => {
            if (!current) return current;

            const updatedAccounts =
              (current.accounts || []).map(
                (account) => {
                  if (
                    getAccountId(account) !==
                    accountId
                  ) {
                    return account;
                  }

                  return {
                    ...account,
                    balance:
                      balance.balance,
                    currency:
                      balance.currency,
                  };
                }
              );

            const next = {
              ...current,
              accounts:
                updatedAccounts,
            };

            saveSession(next);
            return next;
          });
        };

        socket.onerror = () => {
          if (!disposed) {
            setBalanceStatus("error");
          }
        };

        socket.onclose = () => {
          if (disposed) return;

          setBalanceStatus("disconnected");

          reconnectTimerRef.current =
            window.setTimeout(
              connectBalance,
              5000
            );
        };
      } catch (error) {
        if (disposed) return;

        setBalanceStatus("error");

        setAuthError(
          error instanceof Error
            ? error.message
            : "Unable to connect the account balance."
        );
      }
    }

    void connectBalance();

    return () => {
      disposed = true;

      window.clearTimeout(
        reconnectTimerRef.current
      );

      if (balanceSocketRef.current) {
        balanceSocketRef.current.close();
        balanceSocketRef.current = null;
      }
    };
  }, [
    config.clientId,
    selectedAccount,
    session?.accessToken,
  ]);

  const accounts = useMemo(
    () =>
      (session?.accounts || []).map(
        (account) => ({
          ...account,
          id: getAccountId(account),
          displayType:
            getAccountType(account),
          displayLabel:
            accountLabel(account),
        })
      ),
    [session?.accounts]
  );

  const value = useMemo(
    () => ({
      config,
      updateConfig,
      session,
      accounts,
      selectedAccount,
      selectedAccountType:
        selectedAccount
          ? getAccountType(
              selectedAccount
            )
          : "",
      authenticated: Boolean(
        session?.accessToken
      ),
      loading,
      accountsLoading,
      balanceStatus,
      authError,
      login,
      logout,
      refreshAccounts,
      selectAccount,
      showSetup,
      openSetup: () =>
        setShowSetup(true),
      closeSetup: () =>
        setShowSetup(false),
    }),
    [
      config,
      session,
      accounts,
      selectedAccount,
      loading,
      accountsLoading,
      balanceStatus,
      authError,
      login,
      logout,
      refreshAccounts,
      selectAccount,
      showSetup,
      updateConfig,
    ]
  );

  return (
    <DerivAuthContext.Provider
      value={value}
    >
      {children}
      <DerivOAuthSetupModal />
    </DerivAuthContext.Provider>
  );
}

export function useDerivAuth() {
  const value = useContext(
    DerivAuthContext
  );

  if (!value) {
    throw new Error(
      "useDerivAuth must be used inside DerivAuthProvider."
    );
  }

  return value;
}

function DerivOAuthSetupModal() {
  const auth = useContext(
    DerivAuthContext
  );

  const [draft, setDraft] =
    useState(auth?.config);

  useEffect(() => {
    if (auth?.showSetup) {
      setDraft(auth.config);
    }
  }, [
    auth?.showSetup,
    auth?.config,
  ]);

  if (!auth?.showSetup) return null;

  const saveAndLogin = async () => {
    const saved =
      auth.updateConfig(draft);

    auth.closeSetup();
    await beginDerivLogin(saved);
  };

  return (
    <div className="derivAuthModalBackdrop">
      <section
        className="derivAuthModal"
        role="dialog"
        aria-modal="true"
      >
        <div className="derivAuthModalHeader">
          <div>
            <small>DERIV OAUTH</small>
            <h2>
              Connect your Deriv account
            </h2>
          </div>

          <button
            type="button"
            onClick={auth.closeSetup}
          >
            ×
          </button>
        </div>

        <label>
          <span>
            Deriv OAuth Client ID /
            App ID
          </span>

          <input
            value={
              draft?.clientId || ""
            }
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                clientId:
                  event.target.value,
              }))
            }
            placeholder="Enter your registered App ID"
            autoComplete="off"
          />
        </label>

        <label>
          <span>
            Registered redirect URL
          </span>

          <input
            value={
              draft?.redirectUri || ""
            }
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                redirectUri:
                  event.target.value,
              }))
            }
          />
        </label>

        <label>
          <span>OAuth scopes</span>

          <input
            value={
              draft?.scope ||
              "trade account_manage"
            }
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                scope:
                  event.target.value,
              }))
            }
          />
        </label>

        <div className="derivAuthSecurityNote">
          Your password is entered only
          on Deriv’s official login page.
        </div>

        <div className="derivAuthModalActions">
          <button
            type="button"
            className="secondary"
            onClick={auth.closeSetup}
          >
            Cancel
          </button>

          <button
            type="button"
            className="primary"
            disabled={
              !draft?.clientId ||
              !draft?.redirectUri
            }
            onClick={saveAndLogin}
          >
            Save & Log in with Deriv
          </button>
        </div>
      </section>
    </div>
  );
}
