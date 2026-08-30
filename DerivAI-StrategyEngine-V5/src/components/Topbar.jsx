import {
  useEffect,
  useRef,
  useState,
} from "react";

import { useDerivAuth } from "../auth/DerivAuthContext";

function money(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "—";
  }

  return amount.toLocaleString(
    "en-US",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  );
}

function accountType(account) {
  const value = String(
    account?.displayType ||
      account?.accountType ||
      account?.account_type ||
      account?.type ||
      ""
  ).toLowerCase();

  if (
    value.includes("demo") ||
    value.includes("virtual")
  ) {
    return "demo";
  }

  return "real";
}

function accountName(account) {
  return accountType(account) === "demo"
    ? "Demo Account"
    : "Real Account";
}

export default function Topbar({
  title,
  subtitle,
  connected = false,
  connecting = false,
  onConnect,
  onDisconnect,
}) {
  const auth = useDerivAuth();

  const [accountMenuOpen, setAccountMenuOpen] =
    useState(false);

  const menuRef = useRef(null);

  useEffect(() => {
    function closeMenu(event) {
      if (
        menuRef.current &&
        !menuRef.current.contains(
          event.target
        )
      ) {
        setAccountMenuOpen(false);
      }
    }

    document.addEventListener(
      "mousedown",
      closeMenu
    );

    return () =>
      document.removeEventListener(
        "mousedown",
        closeMenu
      );
  }, []);

  const selected =
    auth.selectedAccount;

  const type = selected
    ? accountType(selected)
    : "";

  const currency =
    selected?.currency || "USD";

  const balance =
    money(selected?.balance);

  return (
    <header className="topbar">
      <div className="topbarTitle">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>

      <div className="topbarActions">
        <div
          className={
            connected
              ? "connection connected"
              : "connection"
          }
        >
          <span className="statusDot" />

          {connected
            ? "Deriv live feed"
            : "Feed disconnected"}
        </div>

        <button
          type="button"
          className={
            connected
              ? "connectButton disconnect"
              : "connectButton"
          }
          disabled={connecting}
          onClick={
            connected
              ? onDisconnect
              : onConnect
          }
        >
          {connecting
            ? "Connecting..."
            : connected
            ? "Disconnect feed"
            : "Connect feed"}
        </button>

        {auth.authenticated ? (
          <>
            <div
              className="derivAccountSwitcher"
              ref={menuRef}
            >
              <button
                type="button"
                className={`derivAccountButton ${type}`}
                onClick={() =>
                  setAccountMenuOpen(
                    (current) => !current
                  )
                }
              >
                <span
                  className={`derivAccountTypeIcon ${type}`}
                >
                  {type === "demo"
                    ? "D"
                    : "R"}
                </span>

                <span className="derivAccountButtonText">
                  <strong>
                    {balance} {currency}
                  </strong>

                  <small>
                    {accountName(selected)}
                  </small>
                </span>

                <span
                  className={
                    accountMenuOpen
                      ? "derivAccountChevron open"
                      : "derivAccountChevron"
                  }
                >
                  ▾
                </span>
              </button>

              {accountMenuOpen ? (
                <div className="derivAccountMenu">
                  <div className="derivAccountMenuHeader">
                    <div>
                      <strong>
                        Deriv accounts
                      </strong>

                      <small>
                        Choose Demo or Real
                      </small>
                    </div>

                    <button
                      type="button"
                      disabled={
                        auth.accountsLoading
                      }
                      onClick={() =>
                        auth.refreshAccounts()
                      }
                    >
                      {auth.accountsLoading
                        ? "..."
                        : "↻"}
                    </button>
                  </div>

                  <div className="derivAccountMenuList">
                    {auth.accounts.length ===
                    0 ? (
                      <div className="derivAccountEmpty">
                        No Deriv accounts were
                        returned.
                      </div>
                    ) : (
                      auth.accounts.map(
                        (account) => {
                          const rowType =
                            accountType(
                              account
                            );

                          const active =
                            account.id ===
                            selected?.id;

                          return (
                            <button
                              type="button"
                              key={account.id}
                              className={
                                active
                                  ? "derivAccountRow active"
                                  : "derivAccountRow"
                              }
                              onClick={() => {
                                auth.selectAccount(
                                  account.id
                                );

                                setAccountMenuOpen(
                                  false
                                );
                              }}
                            >
                              <span
                                className={`derivAccountTypeIcon ${rowType}`}
                              >
                                {rowType ===
                                "demo"
                                  ? "D"
                                  : "R"}
                              </span>

                              <span className="derivAccountRowCopy">
                                <strong>
                                  {accountName(
                                    account
                                  )}
                                </strong>

                                <small>
                                  {account.id}
                                </small>
                              </span>

                              <span className="derivAccountRowBalance">
                                <strong>
                                  {money(
                                    account.balance
                                  )}
                                </strong>

                                <small>
                                  {account.currency ||
                                    "USD"}
                                </small>
                              </span>

                              {active ? (
                                <span className="derivAccountCheck">
                                  ✓
                                </span>
                              ) : null}
                            </button>
                          );
                        }
                      )
                    )}
                  </div>

                  <div className="derivAccountBalanceStatus">
                    <span
                      className={`statusDot ${auth.balanceStatus}`}
                    />

                    {auth.balanceStatus ===
                    "live"
                      ? "Live balance connected"
                      : auth.balanceStatus ===
                        "connecting"
                      ? "Connecting balance..."
                      : auth.balanceStatus ===
                        "error"
                      ? "Balance connection error"
                      : "Balance feed disconnected"}
                  </div>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="derivLogoutButton"
              onClick={auth.logout}
            >
              Log out
            </button>
          </>
        ) : (
          <button
            type="button"
            className="derivLoginButton"
            disabled={auth.loading}
            onClick={auth.login}
          >
            {auth.loading
              ? "Signing in..."
              : "Log in with Deriv"}
          </button>
        )}

        {auth.authError ? (
          <div className="derivAuthInlineError">
            {auth.authError}
          </div>
        ) : null}
      </div>
    </header>
  );
}
