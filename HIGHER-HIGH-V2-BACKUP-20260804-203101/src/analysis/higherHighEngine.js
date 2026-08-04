function finiteSeries(values = []) {
  return values.map(Number).filter(Number.isFinite);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ema(values, period) {
  if (!values.length) return 0;
  const alpha = 2 / (period + 1);
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) {
    result = alpha * values[index] + (1 - alpha) * result;
  }
  return result;
}

function slope(values, lookback = 12) {
  const rows = values.slice(-lookback);
  if (rows.length < 3) return 0;
  const n = rows.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  rows.forEach((value, index) => {
    sumX += index;
    sumY += value;
    sumXY += index * value;
    sumXX += index * index;
  });
  const denominator = n * sumXX - sumX * sumX;
  return denominator ? (n * sumXY - sumX * sumY) / denominator : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function efficiencyRatio(values, lookback = 24) {
  const rows = values.slice(-lookback);
  if (rows.length < 3) return 0;
  const net = Math.abs(rows.at(-1) - rows[0]);
  let travel = 0;
  for (let index = 1; index < rows.length; index += 1) {
    travel += Math.abs(rows[index] - rows[index - 1]);
  }
  return travel > 0 ? net / travel : 0;
}

function directionalEntropy(values, lookback = 32) {
  const rows = values.slice(-(lookback + 1));
  if (rows.length < 8) return 1;
  let up = 0;
  let down = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index] > rows[index - 1]) up += 1;
    else if (rows[index] < rows[index - 1]) down += 1;
  }
  const total = up + down;
  if (!total) return 1;
  const probabilities = [up / total, down / total].filter((value) => value > 0);
  return -probabilities.reduce((sum, value) => sum + value * Math.log2(value), 0);
}

function pivots(values, wing = 2) {
  const highs = [];
  const lows = [];
  for (let index = wing; index < values.length - wing; index += 1) {
    const center = values[index];
    const left = values.slice(index - wing, index);
    const right = values.slice(index + 1, index + wing + 1);
    if (left.every((value) => center > value) && right.every((value) => center >= value)) {
      highs.push({ index, value: center });
    }
    if (left.every((value) => center < value) && right.every((value) => center <= value)) {
      lows.push({ index, value: center });
    }
  }
  return { highs, lows };
}

function pct(value) {
  return `${Math.round(Number(value || 0))}%`;
}

export function analyzeHigherHigh(prices = [], options = {}) {
  const values = finiteSeries(prices).slice(-220);
  const minimumConfidence = Number(options.minimumConfidence ?? 86);
  const minimumEfficiency = Number(options.minimumEfficiency ?? 0.46);
  const maximumEntropy = Number(options.maximumEntropy ?? 0.92);

  if (values.length < 80) {
    return {
      ready: false,
      decision: "COLLECTING",
      confidence: 0,
      reason: `Collecting ticks ${values.length}/80`,
      structure: "WAIT",
      pullback: "WAIT",
      metrics: {},
      checks: [],
    };
  }

  const last = values.at(-1);
  const fast = ema(values.slice(-60), 9);
  const medium = ema(values.slice(-100), 21);
  const slow = ema(values, 50);
  const fastBefore = ema(values.slice(-61, -1), 9);
  const fastSlope = fast - fastBefore;
  const regressionSlope = slope(values, 18);
  const momentum5 = last - values.at(-6);
  const momentum12 = last - values.at(-13);
  const returns = values.slice(-40).map((value, index, rows) => index ? value - rows[index - 1] : 0).slice(1);
  const volatility = standardDeviation(returns);
  const recentMove = Math.abs(last - values.at(-2));
  const spikeRatio = volatility > 0 ? recentMove / volatility : 0;
  const efficiency = efficiencyRatio(values, 28);
  const entropy = directionalEntropy(values, 36);
  const { highs, lows } = pivots(values.slice(-100), 2);
  const recentHighs = highs.slice(-2);
  const recentLows = lows.slice(-2);

  const higherHigh = recentHighs.length === 2 && recentHighs[1].value > recentHighs[0].value;
  const higherLow = recentLows.length === 2 && recentLows[1].value > recentLows[0].value;
  const structureBullish = higherHigh && higherLow;
  const emaAligned = fast > medium && medium > slow;
  const slopePositive = fastSlope > 0 && regressionSlope > 0;
  const momentumPositive = momentum5 > 0 && momentum12 > 0;
  const normalVolatility = volatility > 0 && spikeRatio < 2.6;
  const efficient = efficiency >= minimumEfficiency;
  const lowNoise = entropy <= maximumEntropy;

  const lastSwingHigh = recentHighs.at(-1)?.value ?? Math.max(...values.slice(-25));
  const lastSwingLow = recentLows.at(-1)?.value ?? Math.min(...values.slice(-25));
  const range = Math.max(Number.EPSILON, lastSwingHigh - lastSwingLow);
  const retracement = (lastSwingHigh - last) / range;
  const heldHigherLow = last > lastSwingLow;
  const validPullback = retracement >= 0.08 && retracement <= 0.55 && heldHigherLow;
  const continuation = last > values.at(-2) && values.at(-2) >= values.at(-3);
  const pullbackConfirmed = validPullback && continuation;

  const checks = [
    { label: "Higher High", passed: higherHigh, weight: 14 },
    { label: "Higher Low", passed: higherLow, weight: 14 },
    { label: "EMA 9/21/50", passed: emaAligned, weight: 14 },
    { label: "Positive slope", passed: slopePositive, weight: 10 },
    { label: "Momentum 5/12", passed: momentumPositive, weight: 12 },
    { label: "Pullback held", passed: validPullback, weight: 12 },
    { label: "Continuation", passed: continuation, weight: 8 },
    { label: "Efficiency", passed: efficient, weight: 7 },
    { label: "Low entropy", passed: lowNoise, weight: 5 },
    { label: "No spike", passed: normalVolatility, weight: 4 },
  ];

  const rawScore = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  const confidence = clamp(rawScore, 0, 100);
  const hardGate = structureBullish && emaAligned && slopePositive && momentumPositive && pullbackConfirmed && normalVolatility;
  const ready = hardGate && efficient && lowNoise && confidence >= minimumConfidence;

  let reason = "Waiting for a clean Higher High setup.";
  if (!structureBullish) reason = "Market structure has not confirmed Higher High + Higher Low.";
  else if (!emaAligned) reason = "EMA 9/21/50 trend alignment is incomplete.";
  else if (!momentumPositive) reason = "Short and medium momentum do not agree.";
  else if (!validPullback) reason = "Waiting for a controlled pullback above the Higher Low.";
  else if (!continuation) reason = "Pullback found; waiting for bullish continuation ticks.";
  else if (!normalVolatility) reason = "Current tick is a volatility spike; entry skipped.";
  else if (!efficient) reason = "Trend efficiency is below the entry threshold.";
  else if (!lowNoise) reason = "Direction entropy is too high; market is choppy.";
  else if (confidence < minimumConfidence) reason = `Setup score ${pct(confidence)} is below ${pct(minimumConfidence)}.`;
  else reason = "Confirmed Higher High continuation. CALL entry is ready.";

  return {
    ready,
    decision: ready ? "BUY HIGHER" : pullbackConfirmed ? "WATCH" : "WAIT",
    confidence,
    reason,
    structure: structureBullish ? "HH + HL" : higherHigh ? "HH ONLY" : higherLow ? "HL ONLY" : "UNCONFIRMED",
    pullback: pullbackConfirmed ? "CONFIRMED" : validPullback ? "FORMING" : "WAIT",
    duration: Number(options.duration ?? 5),
    durationUnit: String(options.durationUnit ?? "t"),
    checks,
    metrics: {
      fastEma: fast,
      mediumEma: medium,
      slowEma: slow,
      fastSlope,
      regressionSlope,
      momentum5,
      momentum12,
      volatility,
      spikeRatio,
      efficiency,
      entropy,
      retracement,
      lastSwingHigh,
      lastSwingLow,
      currentPrice: last,
    },
  };
}
