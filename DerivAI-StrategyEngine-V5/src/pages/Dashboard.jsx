import { useEffect, useState } from "react";
import { useDerivAuth } from "../auth/DerivAuthContext";
import { completeDerivLogin } from "../auth/derivOAuth";
import RiseFallBot from "../components/RiseFallBot";

function accountIdOf(account) {
  return String(
    account?.id ||
      account?.account_id ||
      account?.loginid ||
      account?.login_id ||
      ""
  );
}

function accountTypeOf(account) {
  return String(
    account?.displayType ||
      account?.accountType ||
      account?.account_type ||
      account?.type ||
      ""
  ).toLowerCase();
}

function balanceOf(account) {
  const value = Number(
    account?.balance?.value ??
      account?.balance ??
      account?.available_balance ??
      0
  );

  return Number.isFinite(value) ? value : null;
}

export default function Dashboard() {
  const auth = useDerivAuth();

  const [oauthError, setOauthError] = useState("");
  const [completingOAuth, setCompletingOAuth] = useState(false);

  const accounts = Array.isArray(auth.accounts)
    ? auth.accounts.filter((account) => {
        const type = accountTypeOf(account);
        return type === "demo" || type === "real";
      })
    : [];

  const selectedAccount =
    auth.selectedAccount ||
    accounts.find(
      (account) =>
        accountIdOf(account) ===
        accountIdOf(auth.selectedAccount)
    ) ||
    accounts[0] ||
    null;

  const selectedType =
    String(
      auth.selectedAccountType ||
        accountTypeOf(selectedAccount)
    ).toLowerCase();

  const selectedBalance = balanceOf(selectedAccount);
  const currency = selectedAccount?.currency || "USD";

  useEffect(() => {
    let cancelled = false;

    async function finishOAuthLogin() {
      const currentUrl = new URL(window.location.href);

      const hasCode = currentUrl.searchParams.has("code");
      const hasOAuthError =
        currentUrl.searchParams.has("error");

      if (!hasCode && !hasOAuthError) return;

      try {
        setCompletingOAuth(true);
        setOauthError("");

        const session = await completeDerivLogin();

        if (cancelled) return;

        if (session?.accessToken) {
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

    void finishOAuthLogin();

    return () => {
      cancelled = true;
    };
  }, []);

  const switchAccount = async (account) => {
    const id = accountIdOf(account);

    if (!id) return;

    const currentId = accountIdOf(
      auth.selectedAccount
    );

    if (id === currentId) return;

    /*
     * Stop the old trading connection first.
     * The RiseFallBot/useDerivTicks instance will
     * reconnect using the newly selected account.
     */
    try {
      const event = new CustomEvent(
        "deriv:account-switching"
      );

      window.dispatchEvent(event);
    } catch {
      // Ignore browser event errors.
    }

    auth.selectAccount(id);
  };

  return (
    <main className="cleanBotPage">
      <section className="cleanAccountBar">
        <div className="cleanAccountIdentity">
          <span className="cleanAccountEyebrow">
            ACCOUNT
          </span>

          <strong>
            {selectedType === "demo"
              ? "Demo Account"
              : selectedType === "real"
                ? "Real Account"
                : "Choose Account"}
          </strong>

          {selectedAccount ? (
            <small>
              {accountIdOf(selectedAccount)}
            </small>
          ) : null}
        </div>

        <div className="cleanAccountBalance">
          <span>BALANCE</span>

          <strong>
            {selectedBalance === null
              ? "—"
              : `${selectedBalance.toFixed(2)} ${currency}`}
          </strong>
        </div>

        <div className="cleanAccountButtons">
          {accounts.map((account) => {
            const id = accountIdOf(account);
            const type = accountTypeOf(account);
            const active = id === accountIdOf(selectedAccount);

            return (
              <button
                key={id}
                type="button"
                className={`cleanAccountButton ${
                  active ? "active" : ""
                } ${type}`}
                onClick={() =>
                  void switchAccount(account)
                }
                disabled={active}
              >
                <strong>
                  {type === "demo"
                    ? "DEMO"
                    : "REAL"}
                </strong>

                <small>
                  {type === "demo"
                    ? "Demo Account"
                    : "Real Account"}
                </small>
              </button>
            );
          })}

          {!auth.authenticated ? (
            <button
              type="button"
              className="cleanLoginButton"
              onClick={() => void auth.login()}
              disabled={auth.loading}
            >
              {auth.loading
                ? "CONNECTING..."
                : "LOGIN WITH DERIV"}
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
  );
}