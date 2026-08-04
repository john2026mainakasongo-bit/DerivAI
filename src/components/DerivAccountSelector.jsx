import { useMemo } from "react";

function accountId(account = {}) {
  return String(
    account.id ||
    account.account_id ||
    account.loginid ||
    account.login_id ||
    ""
  );
}

function accountBalance(account = {}) {
  const value = Number(
    account.balance ??
    account.amount ??
    account.account_balance ??
    account.display_balance ??
    0
  );
  return Number.isFinite(value) ? value : 0;
}

function accountType(account = {}) {
  const id = accountId(account).toUpperCase();
  const raw = String(account.type || account.account_type || "").toLowerCase();
  return raw.includes("demo") || id.startsWith("VRTC") ? "demo" : "real";
}

function accountLabel(account = {}) {
  const type = accountType(account).toUpperCase();
  const id = accountId(account) || "NOT SELECTED";
  return `${type} · ${id}`;
}

export default function DerivAccountSelector({
  accounts = [],
  selectedAccountId = "",
  selectedAccount = null,
  currency = "USD",
  onChange,
}) {
  const normalized = useMemo(
    () =>
      (Array.isArray(accounts) ? accounts : [])
        .filter((account) => accountId(account))
        .sort((left, right) => {
          const leftType = accountType(left);
          const rightType = accountType(right);
          if (leftType !== rightType) return leftType === "demo" ? -1 : 1;
          return accountId(left).localeCompare(accountId(right));
        }),
    [accounts]
  );

  const active =
    selectedAccount ||
    normalized.find((account) => accountId(account) === selectedAccountId) ||
    normalized[0] ||
    {};

  const type = accountType(active);
  const balance = accountBalance(active);
  const activeCurrency = active.currency || currency || "USD";

  return (
    <label className={`derivAccountSelector ${type}`}>
      <span className="derivAccountBadge">
        {type === "demo" ? "D" : "R"}
      </span>

      <span className="derivAccountMain">
        <small>{type.toUpperCase()} ACCOUNT</small>
        <select
          value={accountId(active)}
          onChange={(event) => onChange?.(event.target.value)}
        >
          {normalized.map((account) => (
            <option key={accountId(account)} value={accountId(account)}>
              {accountLabel(account)}
            </option>
          ))}
        </select>
      </span>

      <span className="derivAccountBalance">
        <small>BALANCE</small>
        <strong>{balance.toFixed(2)} {activeCurrency}</strong>
      </span>
    </label>
  );
}

export {
  accountId,
  accountBalance,
  accountType,
};
