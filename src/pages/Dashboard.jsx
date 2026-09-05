import { useEffect, useState } from "react";
import { completeDerivLogin } from "../auth/derivOAuth";
import { useDerivAuth } from "../auth/DerivAuthContext";
import RiseFallBot from "../components/RiseFallBot";
import Sidebar from "../components/Sidebar";

export default function Dashboard() {
  const auth = useDerivAuth();

  const [oauthError, setOauthError] = useState("");
  const [completingOAuth, setCompletingOAuth] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function finish() {
      const url = new URL(window.location.href);

      if (
        !url.searchParams.has("code") &&
        !url.searchParams.has("error")
      ) {
        return;
      }

      try {
        setCompletingOAuth(true);
        setOauthError("");

        const session = await completeDerivLogin();

        if (!cancelled && session?.accessToken) {
          window.history.replaceState(
            {},
            document.title,
            window.location.pathname
          );

          window.location.reload();
        }
      } catch (error) {
        if (!cancelled) {
          setOauthError(
            error instanceof Error
              ? error.message
              : "Unable to complete Deriv login."
          );
        }
      } finally {
        if (!cancelled) {
          setCompletingOAuth(false);
        }
      }
    }

    void finish();

    return () => {
      cancelled = true;
    };
  }, []);

  const accountList = (auth.accounts || []).filter(
    (account) =>
      account.displayType === "demo" ||
      account.displayType === "real"
  );

  const selectedId = String(
    auth.selectedAccount?.id ||
      auth.selectedAccount?.account_id ||
      auth.selectedAccount?.loginid ||
      ""
  );

  function handleAccountChange(accountId) {
    if (!accountId || accountId === selectedId) {
      return;
    }

    auth.selectAccount(accountId);
  }

  return (
    <div className="appShell zentoraShell">
      <Sidebar />
      <main className="cleanBotPage">
      <section className="cleanAccountBar">
        <div className="cleanAccountInfo">
          <span className="cleanAccountLabel">
            ACCOUNT
          </span>

          <strong>
            {auth.authenticated
              ? auth.selectedAccountType === "real"
                ? "Real Account"
                : "Demo Account"
              : "Not connected"}
          </strong>

          {auth.selectedAccount?.displayLabel ? (
            <small>
              {auth.selectedAccount.displayLabel}
            </small>
          ) : null}
        </div>

        <div className="cleanAccountActions">
          {auth.authenticated && accountList.length > 0
            ? accountList.map((account) => {
                const id = String(account.id || "");
                const isSelected = id === selectedId;

                return (
                  <button
                    key={id}
                    type="button"
                    className={
                      "cleanAccountButton" +
                      (isSelected ? " selected" : "")
                    }
                    onClick={() =>
                      handleAccountChange(id)
                    }
                  >
                    {account.displayType === "real"
                      ? "REAL"
                      : "DEMO"}

                    <small>
                      {account.displayLabel || id}
                    </small>
                  </button>
                );
              })
            : null}

          {!auth.authenticated ? (
            <button
              type="button"
              className="cleanAccountButton login"
              onClick={auth.login}
            >
              LOGIN
            </button>
          ) : null}
        </div>
      </section>

      {completingOAuth ? (
        <div className="connectionError">
          Completing Deriv login. Please wait...
        </div>
      ) : null}

      {oauthError ? (
        <div className="connectionError">
          Deriv login failed: {oauthError}
        </div>
      ) : null}

      {auth.authError ? (
        <div className="connectionError">
          {auth.authError}
        </div>
      ) : null}

      <RiseFallBot />
      </main>
    </div>
  );
}

