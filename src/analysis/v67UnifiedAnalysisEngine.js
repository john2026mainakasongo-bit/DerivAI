
function clamp(value, minimum = 0, maximum = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function validDigits(values = []) {
  return values
    .map(Number)
    .filter(
      (value) =>
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 9
    );
}

function fairProbability(mode, digit = null) {
  if (mode === "EVEN" || mode === "ODD") return 0.5;
  if (mode === "MATCH") return 0.1;
  if (mode === "DIFFERS") return 0.9;
  if (mode === "OVER") return (9 - Number(digit)) / 10;
  if (mode === "UNDER") return Number(digit) / 10;
  return 0.5;
}

function wins(value, mode, digit = null) {
  if (mode === "EVEN") return value % 2 === 0;
  if (mode === "ODD") return value % 2 === 1;
  if (mode === "MATCH") return value === digit;
  if (mode === "DIFFERS") return value !== digit;
  if (mode === "OVER") return value > digit;
  if (mode === "UNDER") return value < digit;
  return false;
}

function probability(values, mode, digit = null) {
  if (!values.length) return fairProbability(mode, digit);
  return values.filter((value) => wins(value, mode, digit)).length / values.length;
}

function weightedProbability(values, mode, digit = null) {
  if (!values.length) return fairProbability(mode, digit);

  let weight = 1;
  let total = 0;
  let success = 0;

  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (wins(values[index], mode, digit)) success += weight;
    total += weight;
    weight *= 0.972;
  }

  return total ? success / total : fairProbability(mode, digit);
}

function transitionProbability(values, mode, digit = null) {
  if (values.length < 8) return fairProbability(mode, digit);

  const previous = values[values.length - 1];
  let total = 0;
  let success = 0;

  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] !== previous) continue;
    total += 1;
    if (wins(values[index], mode, digit)) success += 1;
  }

  return total ? (success + 1) / (total + 2) : probability(values, mode, digit);
}

function stability(values, mode, digit = null) {
  const windows = [20, 40, 80, 160]
    .map((size) => values.slice(-Math.min(size, values.length)))
    .filter((window) => window.length >= 12);

  if (windows.length < 2) return 50;

  const probabilities = windows.map((window) => probability(window, mode, digit));
  const spread = Math.max(...probabilities) - Math.min(...probabilities);

  return clamp((1 - spread / 0.16) * 100);
}

function bayesianProbability(observed, baseline, samples) {
  const prior = samples < 50 ? 120 : samples < 100 ? 85 : 60;

  return (
    observed * samples +
    baseline * prior
  ) / (samples + prior);
}

function conservativeEv(probabilityValue, baseline) {
  const multiplier = (1 / Math.max(0.01, baseline)) * 0.94;
  return probabilityValue * multiplier - 1;
}

function setupName(mode, digit) {
  if (mode === "EVEN" || mode === "ODD") return mode;
  return `${mode} ${digit}`;
}

function triggerDigits(mode, digit) {
  if (mode === "OVER") {
    return Array.from({ length: digit + 1 }, (_, value) => value);
  }

  if (mode === "UNDER") {
    return Array.from({ length: 9 - digit }, (_, index) => digit + 1 + index);
  }

  return [];
}

function riskLabel(score, executable) {
  if (executable && score >= 88) return "GOOD ENTRY";
  if (score >= 74) return "RISKY";
  return "DO NOT TRADE";
}

export function analyzeDigitSetups({
  digitHistory = [],
  allowHighRisk = false,
} = {}) {
  const digits = validDigits(digitHistory);
  const sampleSize = digits.length;

  const definitions = [
    ...[1, 2, 3, 4, 5, 6].map((digit) => ({ mode: "OVER", digit })),
    ...[3, 4, 5, 6, 7, 8].map((digit) => ({ mode: "UNDER", digit })),
    { mode: "EVEN", digit: null },
    { mode: "ODD", digit: null },
    ...Array.from({ length: 10 }, (_, digit) => ({ mode: "MATCH", digit })),
    ...Array.from({ length: 10 }, (_, digit) => ({ mode: "DIFFERS", digit })),
  ];

  const candidates = definitions.map(({ mode, digit }) => {
    const baseline = fairProbability(mode, digit);
    const recent20 = digits.slice(-20);
    const recent50 = digits.slice(-50);
    const recent100 = digits.slice(-100);
    const observed =
      weightedProbability(recent20, mode, digit) * 0.45 +
      weightedProbability(recent50, mode, digit) * 0.30 +
      weightedProbability(recent100, mode, digit) * 0.15 +
      transitionProbability(digits.slice(-160), mode, digit) * 0.10;

    const probabilityValue = bayesianProbability(
      observed,
      baseline,
      sampleSize
    );
    const edge = probabilityValue - baseline;
    const ev = conservativeEv(probabilityValue, baseline);
    const stable = stability(digits, mode, digit);
    const highRisk = mode === "MATCH" || mode === "DIFFERS";

    let confidence =
      55 +
      ev * 180 +
      edge * 260 +
      (stable - 50) * 0.16;

    if (highRisk) {
      confidence -= 14;
      confidence = Math.min(85, confidence);
    } else {
      confidence = Math.min(96, confidence);
    }

    confidence = clamp(confidence);

    const executable =
      sampleSize >= (highRisk ? 250 : 40) &&
      ev >= (highRisk ? 0.12 : 0.018) &&
      edge >= (highRisk ? 0.035 : 0.013) &&
      stable >= (highRisk ? 78 : 64) &&
      confidence >= (highRisk ? 88 : 80) &&
      (!highRisk || allowHighRisk);

    const triggers = triggerDigits(mode, digit);

    return {
      setup: setupName(mode, digit),
      mode,
      digit,
      highRisk,
      sampleSize,
      probability: probabilityValue * 100,
      baseline: baseline * 100,
      edge: edge * 100,
      expectedValue: ev * 100,
      stability: stable,
      confidence,
      executable,
      risk: riskLabel(confidence, executable),
      triggerDigits: triggers,
      triggerText:
        triggers.length
          ? `Wait until the live digit touches ${triggers.join(", ")}, then re-confirm ${setupName(mode, digit)}.`
          : "Enter only after the live signal remains confirmed.",
    };
  });

  candidates.sort((left, right) => {
    if (left.executable !== right.executable) {
      return left.executable ? -1 : 1;
    }

    return (
      right.expectedValue - left.expectedValue ||
      right.confidence - left.confidence ||
      right.stability - left.stability
    );
  });

  return {
    sampleSize,
    best: candidates.find((candidate) => candidate.executable) || null,
    candidates,
    standard: candidates.filter((candidate) => !candidate.highRisk),
    highRisk: candidates.filter((candidate) => candidate.highRisk),
  };
}

function movingAverage(values, period) {
  if (!values.length) return 0;
  const slice = values.slice(-Math.min(period, values.length));
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function priceMomentum(values, period) {
  if (values.length < period + 1) return 0;
  const start = values[values.length - period - 1];
  const end = values[values.length - 1];
  return end - start;
}

function directionalVotes(values) {
  const periods = [5, 10, 20, 40];
  return periods.map((period) => {
    const momentum = priceMomentum(values, period);
    if (momentum > 0) return 1;
    if (momentum < 0) return -1;
    return 0;
  });
}

export function analyzeRiseFall({
  prices = [],
  currentPrice = null,
} = {}) {
  const values = prices
    .map(Number)
    .filter(Number.isFinite);

  const sampleSize = values.length;

  if (sampleSize < 20) {
    return {
      sampleSize,
      signal: "WAIT",
      risk: "DO NOT TRADE",
      confidence: 0,
      trend: "NEUTRAL",
      momentum: 0,
      entryPrice: null,
      support: null,
      resistance: null,
      instruction: `Collecting price ticks: ${sampleSize}/20.`,
    };
  }

  const recent = values.slice(-Math.min(120, sampleSize));
  const votes = directionalVotes(recent);
  const riseVotes = votes.filter((vote) => vote > 0).length;
  const fallVotes = votes.filter((vote) => vote < 0).length;

  const fast = movingAverage(recent, 8);
  const medium = movingAverage(recent, 20);
  const slow = movingAverage(recent, 50);
  const momentum = priceMomentum(recent, 10);
  const support = Math.min(...recent.slice(-30));
  const resistance = Math.max(...recent.slice(-30));
  const price = Number(currentPrice ?? recent[recent.length - 1]);

  const riseScore =
    (riseVotes / votes.length) * 45 +
    (fast > medium ? 20 : 0) +
    (medium > slow ? 15 : 0) +
    (momentum > 0 ? 20 : 0);

  const fallScore =
    (fallVotes / votes.length) * 45 +
    (fast < medium ? 20 : 0) +
    (medium < slow ? 15 : 0) +
    (momentum < 0 ? 20 : 0);

  const signal =
    riseScore >= 72 && riseScore > fallScore
      ? "RISE"
      : fallScore >= 72 && fallScore > riseScore
        ? "FALL"
        : "WAIT";

  const confidence = Math.min(95, clamp(Math.max(riseScore, fallScore)));
  const distanceFromSupport = Math.abs(price - support);
  const distanceFromResistance = Math.abs(resistance - price);
  const range = Math.max(0.000001, resistance - support);

  let risk = "DO NOT TRADE";

  if (signal !== "WAIT") {
    const edgeDistance =
      signal === "RISE"
        ? distanceFromSupport / range
        : distanceFromResistance / range;

    risk =
      confidence >= 86 && edgeDistance >= 0.18
        ? "GOOD ENTRY"
        : "RISKY";
  }

  const entryPrice =
    signal === "RISE"
      ? Math.max(price, fast)
      : signal === "FALL"
        ? Math.min(price, fast)
        : null;

  return {
    sampleSize,
    signal,
    risk,
    confidence,
    trend:
      fast > medium && medium > slow
        ? "UPTREND"
        : fast < medium && medium < slow
          ? "DOWNTREND"
          : "MIXED",
    momentum,
    entryPrice,
    support,
    resistance,
    duration: confidence >= 88 ? 3 : 5,
    instruction:
      signal === "RISE"
        ? `Enter RISE only when price holds above ${entryPrice.toFixed(3)}.`
        : signal === "FALL"
          ? `Enter FALL only when price stays below ${entryPrice.toFixed(3)}.`
          : "WAIT. Trend and momentum are not aligned.",
  };
}
