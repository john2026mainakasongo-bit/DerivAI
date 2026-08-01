
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

export function DerivAuthProvider({ children }) {
  const [config, setConfigState] = useState(loadOAuthConfig);
  const [session, setSession] = useState(loadOAuthSession);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [showSetup, setShowSetup] = useState(false);

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
        error instanceof Error ? error.message : "Unable to start login."
      );
    }
  }, [config]);

  const logout = useCallback(() => {
    clearOAuthSession();
    setSession(null);
    setAuthError("");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function finishLogin() {
      const params = new URLSearchParams(window.location.search);

      if (!params.has("code") && !params.has("error")) return;

      setLoading(true);
      setAuthError("");

      try {
        const next = await completeDerivLogin();
        if (cancelled || !next) return;

        const withAccounts = await fetchDerivAccounts(next);

        if (!cancelled) {
          setSession(withAccounts);
        }
      } catch (error) {
        if (!cancelled) {
          setAuthError(
            error instanceof Error ? error.message : "Deriv login failed."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    finishLogin();

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedAccount = useMemo(
    () =>
      session?.accounts?.find(
        (item) => item.id === session.selectedAccountId
      ) ||
      session?.accounts?.[0] ||
      null,
    [session]
  );

  const value = useMemo(
    () => ({
      config,
      updateConfig,
      session,
      selectedAccount,
      authenticated: Boolean(session?.accessToken),
      loading,
      authError,
      login,
      logout,
      showSetup,
      openSetup: () => setShowSetup(true),
      closeSetup: () => setShowSetup(false),
    }),
    [
      config,
      updateConfig,
      session,
      selectedAccount,
      loading,
      authError,
      login,
      logout,
      showSetup,
    ]
  );

  return (
    <DerivAuthContext.Provider value={value}>
      {children}
      <DerivOAuthSetupModal />
    </DerivAuthContext.Provider>
  );
}

export function useDerivAuth() {
  const value = useContext(DerivAuthContext);

  if (!value) {
    throw new Error("useDerivAuth must be used inside DerivAuthProvider.");
  }

  return value;
}

function DerivOAuthSetupModal() {
  const auth = useContext(DerivAuthContext);
  const [draft, setDraft] = useState(auth?.config);

  useEffect(() => {
    if (auth?.showSetup) setDraft(auth.config);
  }, [auth?.showSetup, auth?.config]);

  if (!auth?.showSetup) return null;

  const saveAndLogin = async () => {
    const saved = auth.updateConfig(draft);
    auth.closeSetup();
    await beginDerivLogin(saved);
  };

  return (
    <div className="derivAuthModalBackdrop">
      <section className="derivAuthModal" role="dialog" aria-modal="true">
        <div className="derivAuthModalHeader">
          <div>
            <small>DERIV OAUTH</small>
            <h2>Connect your Deriv account</h2>
          </div>

          <button type="button" onClick={auth.closeSetup}>
            Ã—
          </button>
        </div>

        <label>
          <span>Deriv OAuth Client ID / App ID</span>
          <input
            value={draft?.clientId || ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                clientId: event.target.value,
              }))
            }
            placeholder="Enter your registered App ID"
            autoComplete="off"
          />
        </label>

        <label>
          <span>Registered redirect URL</span>
          <input
            value={draft?.redirectUri || ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                redirectUri: event.target.value,
              }))
            }
          />
        </label>

        <label>
          <span>OAuth scopes</span>
          <input
            value={draft?.scope || "trade account_manage"}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                scope: event.target.value,
              }))
            }
          />
        </label>

        <div className="derivAuthSecurityNote">
          Your password is entered only on Derivâ€™s official login page.
        </div>

        <div className="derivAuthModalActions">
          <button type="button" className="secondary" onClick={auth.closeSetup}>
            Cancel
          </button>

          <button
            type="button"
            className="primary"
            disabled={!draft?.clientId || !draft?.redirectUri}
            onClick={saveAndLogin}
          >
            Save & Log in with Deriv
          </button>
        </div>
      </section>
    </div>
  );
}
