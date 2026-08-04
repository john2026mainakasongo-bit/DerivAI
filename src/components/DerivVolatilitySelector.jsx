const DERIV_VOLATILITY_MARKETS = [
  { id: "R_10", label: "Volatility 10 Index" },
  { id: "1HZ10V", label: "Volatility 10 (1s) Index" },
  { id: "R_25", label: "Volatility 25 Index" },
  { id: "1HZ25V", label: "Volatility 25 (1s) Index" },
  { id: "R_50", label: "Volatility 50 Index" },
  { id: "1HZ50V", label: "Volatility 50 (1s) Index" },
  { id: "R_75", label: "Volatility 75 Index" },
  { id: "1HZ75V", label: "Volatility 75 (1s) Index" },
  { id: "R_100", label: "Volatility 100 Index" },
  { id: "1HZ100V", label: "Volatility 100 (1s) Index" },
];

export default function DerivVolatilitySelector({
  value,
  disabled = false,
  onChange,
}) {
  return (
    <label className="derivVolatilitySelector">
      <small>VOLATILITY MARKET</small>
      <select
        value={value || DERIV_VOLATILITY_MARKETS[0].id}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {DERIV_VOLATILITY_MARKETS.map((market) => (
          <option key={market.id} value={market.id}>
            {market.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export { DERIV_VOLATILITY_MARKETS };
