export function derivMarketName(symbol, fallback = "") {
  const exact = {
    "1HZ10V": "Volatility 10 (1s) Index",
    "1HZ15V": "Volatility 15 (1s) Index",
    "1HZ25V": "Volatility 25 (1s) Index",
    "1HZ30V": "Volatility 30 (1s) Index",
    "1HZ50V": "Volatility 50 (1s) Index",
    "1HZ75V": "Volatility 75 (1s) Index",
    "1HZ90V": "Volatility 90 (1s) Index",
    "1HZ100V": "Volatility 100 (1s) Index",

    "R_10": "Volatility 10 Index",
    "R_25": "Volatility 25 Index",
    "R_50": "Volatility 50 Index",
    "R_75": "Volatility 75 Index",
    "R_100": "Volatility 100 Index",
  };

  if (exact[symbol]) return exact[symbol];

  const oneSecond = String(symbol || "").match(/^1HZ(\d+)V$/i);
  if (oneSecond) {
    return `Volatility ${oneSecond[1]} (1s) Index`;
  }

  const normal = String(symbol || "").match(/^R_(\d+)$/i);
  if (normal) {
    return `Volatility ${normal[1]} Index`;
  }

  return fallback || symbol || "Deriv Market";
}
