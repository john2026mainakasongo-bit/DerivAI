import { useMemo } from "react";
import { useDerivAuth } from "../auth/DerivAuthContext";

export default function AccountBar() {
  const auth = useDerivAuth();

  const accountList = useMemo(
    () =>
      (auth.accounts || []).filter(
        (account) =>
          account.displayType === "demo" ||
          account.displayType === "real"
      ),
    [auth.accounts]
  );

  const selectedId = String(
    auth.selectedAccount?.id ||
      auth.selectedAccount?.account_id ||
      auth.selectedAccount?.loginid ||
      ""
  );

  function handleAccountChange(accountId) {
    if (!accountId || accountId === selectedId) return;
    auth.selectAccount(accountId);
  }

  return (
    <section className="cleanAccountBar">
      <div className="cleanAccountInfo">
        <span className="cleanAccountLabel">ACCOUNT</span>
        <strong>
          {auth.authenticated
            ? auth.selectedAccountType === "real"
              ? "Real Account"
              : "Demo Account"
            : "Not connected"}
        </strong>
        {auth.selectedAccount?.displayLabel ? (
          <small>{auth.selectedAccount.displayLabel}</small>
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
                  onClick={() => handleAccountChange(id)}
                >
                  {account.displayType === "real" ? "REAL" : "DEMO"}
                  <small>{account.displayLabel || id}</small>
                  <strong className="accountBalanceValue">
                    {Number.isFinite(Number(account.balance))
                      ? `${Number(account.balance).toLocaleString(
                          undefined,
                          {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          }
                        )} ${String(
                          account.currency || "USD"
                        ).toUpperCase()}`
                      : "Balance unavailable"}
                  </strong>
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
  );
}
