const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const mean = (items) =>
  items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : 0;

const stdDev = (items) => {
  if (items.length < 2) return 0;
  const avg = mean(items);
  return Math.sqrt(mean(items.map((value) => (value - avg) ** 2)));
};

const lastDigit = (quote) => {
  const value = Number(quote);
  if (!Number.isFinite(value)) return 0;
  const fixed = value.toFixed(4).replace(".", "");
  return Number(fixed.at(-1) || 0);
};

export function analyseTicks(ticks = []) {
  const clean = ticks
    .map((tick) => Number(tick))
    .filter(Number.isFinite)
    .slice(-160);

  if (clean.length < 24) {
    return {
      ready: false,
      decision: "WAIT",
      contract: "NONE",
      confidence: 0,
      probability: 0,
      risk: "HIGH",
      reason: `Collecting ticks ${clean.length}/24`,
      metrics: {
        momentum: 0,
        trend: "FLAT",
        volatility: "UNKNOWN",
        entropy: 0,
        bayesian: 50,
        transition: 50,
        cycle: 0,
        regime: "WAIT",
      },
    };
  }

  const recent = clean.slice(-32);
  const previous = clean.slice(-64, -32);
  const changes = recent.slice(1).map((value, index) => value - recent[index]);
  const up = changes.filter((value) => value > 0).length;
  const down = changes.filter((value) => value < 0).length;
  const directional = Math.max(1, up + down);
  const upRatio = up / directional;
  const downRatio = down / directional;

  const fast = mean(recent.slice(-8));
  const slow = mean(recent.slice(-24));
  const priceScale = Math.max(Math.abs(mean(recent)), 1);
  const momentumRaw = ((recent.at(-1) - recent.at(-9)) / priceScale) * 10000;
  const momentum = clamp(momentumRaw, -100, 100);

  const recentStd = stdDev(recent);
  const previousStd = stdDev(previous);
  const volRatio = previousStd > 0 ? recentStd / previousStd : 1;
  const volatility =
    volRatio > 1.7 ? "HIGH" : volRatio < 0.65 ? "LOW" : "NORMAL";

  const digits = recent.map(lastDigit);
  const counts = Array.from({ length: 10 }, (_, digit) =>
    digits.filter((value) => value === digit).length
  );
  const probabilities = counts
    .filter(Boolean)
    .map((count) => count / digits.length);
  const entropyRaw = -probabilities.reduce(
    (sum, probability) => sum + probability * Math.log2(probability),
    0
  );
  const entropy = clamp((entropyRaw / Math.log2(10)) * 100, 0, 100);

  const trend =
    fast > slow && upRatio >= 0.55
      ? "UP"
      : fast < slow && downRatio >= 0.55
        ? "DOWN"
        : "FLAT";

  const transition = clamp(Math.max(upRatio, downRatio) * 100, 50, 100);
  const bayesian = clamp(
    50 +
      (upRatio - downRatio) * 34 +
      Math.sign(momentum) * Math.min(12, Math.abs(momentum) / 5),
    1,
    99
  );

  let cycle = 0;
  for (let lag = 2; lag <= 12; lag += 1) {
    const matches = digits
      .slice(lag)
      .filter((digit, index) => digit === digits[index]).length;
    const score = matches / Math.max(1, digits.length - lag);
    if (score > 0.24) {
      cycle = lag;
      break;
    }
  }

  const trendAligned =
    (trend === "UP" && momentum > 0) || (trend === "DOWN" && momentum < 0);

  const noisePenalty =
    (entropy > 92 ? 14 : entropy > 86 ? 7 : 0) +
    (volatility === "HIGH" ? 12 : 0) +
    (trend === "FLAT" ? 10 : 0);

  const baseConfidence =
    48 +
    Math.abs(upRatio - downRatio) * 80 +
    Math.min(16, Math.abs(momentum) / 4) +
    (trendAligned ? 12 : 0) +
    (cycle ? 4 : 0) -
    noisePenalty;

  const confidence = Math.round(clamp(baseConfidence, 1, 96));
  const probability = Math.round(
    clamp((transition + Math.max(bayesian, 100 - bayesian)) / 2, 1, 96)
  );

  const contract =
    trend === "UP" && momentum > 0
      ? "RISE"
      : trend === "DOWN" && momentum < 0
        ? "FALL"
        : "NONE";

  const risk =
    volatility === "HIGH" || entropy > 92
      ? "HIGH"
      : confidence >= 82 && trendAligned
        ? "LOW"
        : "MEDIUM";

  const decision =
    contract !== "NONE" &&
    confidence >= 82 &&
    probability >= 72 &&
    risk !== "HIGH"
      ? "BUY"
      : confidence < 58 || risk === "HIGH"
        ? "SKIP"
        : "WAIT";

  const regime =
    volatility === "HIGH"
      ? "CHAOTIC"
      : trend === "FLAT"
        ? "RANGE"
        : "TREND";

  const reason =
    decision === "BUY"
      ? `${trend} trend, momentum and transition confirmed`
      : risk === "HIGH"
        ? "Market noise or volatility is too high"
        : trend === "FLAT"
          ? "No clean direction yet"
          : "Waiting for stronger confirmation";

  return {
    ready: true,
    decision,
    contract,
    confidence,
    probability,
    risk,
    reason,
    metrics: {
      momentum: Math.round(momentum),
      trend,
      volatility,
      entropy: Math.round(entropy),
      bayesian: Math.round(bayesian),
      transition: Math.round(transition),
      cycle,
      regime,
    },
  };
}
