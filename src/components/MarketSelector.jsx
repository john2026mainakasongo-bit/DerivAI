export default function MarketSelector({
  markets = [],
  value = "",
  disabled = false,
  onChange,
}) {
  return (
    <select
      className="marketSelector"
      value={value}
      disabled={disabled || !markets.length}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {!markets.length ? (
        <option value="">Connect Deriv to load markets</option>
      ) : null}

      {markets.map((market) => (
        <option value={market.id} key={market.id}>
          {market.label} ({market.id})
        </option>
      ))}
    </select>
  );
}
