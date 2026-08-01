function clamp(value, min = 0, max = 100) {
  return Math.max(
    min,
    Math.min(max, Number(value) || 0)
  );
}

export function standardDeviation(values = []) {
  const clean = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);

  if (clean.length < 2) return 0;

  const mean =
    clean.reduce((sum, value) => sum + value, 0) /
    clean.length;

  return Math.sqrt(
    clean.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0
    ) / clean.length
  );
}

export function priceMomentum(prices = [], lookback = 30) {
  const clean = (Array.isArray(prices) ? prices : [])
    .map(Number)
    .filter(Number.isFinite);

  if (clean.length < 2) {
    return {
      direction: "NEUTRAL",
      percent: 0,
      raw: 0,
    };
  }

  const window = clean.slice(-Math.max(2, lookback));
  const first = window[0];
  const last = window.at(-1);
  const raw = last - first;
  const percent = first
    ? (raw / Math.abs(first)) * 100
    : 0;

  return {
    direction:
      percent > 0.03
        ? "UP"
        : percent < -0.03
        ? "DOWN"
        : "NEUTRAL",
    percent,
    raw,
  };
}

export function volatilityScore(prices = []) {
  const clean = (Array.isArray(prices) ? prices : [])
    .map(Number)
    .filter(Number.isFinite);

  if (clean.length < 3) {
    return {
      score: 0,
      label: "LOW",
      deviation: 0,
    };
  }

  const changes = [];

  for (let index = 1; index < clean.length; index += 1) {
    if (clean[index - 1]) {
      changes.push(
        ((clean[index] - clean[index - 1]) /
          Math.abs(clean[index - 1])) *
          100
      );
    }
  }

  const deviation = standardDeviation(changes);
  const score = clamp(deviation * 900);

  return {
    score,
    label:
      score >= 65
        ? "HIGH"
        : score >= 35
        ? "MEDIUM"
        : "LOW",
    deviation,
  };
}

export function confidenceScore({
  parityEdge = 0,
  thresholdEdge = 0,
  entropyNormalized = 1,
  volatility = 0,
  momentumPercent = 0,
} = {}) {
  return clamp(
    28 +
      clamp(Math.abs(parityEdge), 0, 30) * 1.35 +
      clamp(Math.abs(thresholdEdge), 0, 45) * 0.9 +
      clamp((1 - entropyNormalized) * 100) * 0.28 +
      clamp(Math.abs(momentumPercent) * 180) * 0.16 +
      clamp(volatility) * 0.12
  );
}

export function confidenceLabel(score = 0) {
  return score >= 75
    ? "STRONG"
    : score >= 58
    ? "MODERATE"
    : "LOW";
}
