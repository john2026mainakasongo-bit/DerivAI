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

function linearSlope(values, lookback = 12) {
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

function directionStats(values, lookback) {
  const rows = values.slice(-(lookback + 1));
  let up = 0;
  let down = 0;
  let flat = 0;
  let run = 0;
  let bestRun = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const delta = rows[index] - rows[index - 1];
    if (delta > 0) {
      up += 1;
      run += 1;
      bestRun = Math.max(bestRun, run);
    } else {
      run = 0;
      if (delta < 0) down += 1;
      else flat += 1;
    }
  }
  const directional = up + down;
  return {
    up,
    down,
    flat,
    upRatio: directional ? up / directional : 0.5,
    bestUpRun: bestRun,
  };
}

function transitionProbability(values, lookback = 60) {
  const rows = values.slice(-(lookback + 1));
  if (rows.length < 12) return 0.5;
  let upAfterUp = 0;
  let upContexts = 0;
  let upAfterDown = 0;
  let downContexts = 0;
  for (let index = 2; index < rows.length; index += 1) {
    const previous = rows[index - 1] - rows[index - 2];
    const current = rows[index] - rows[index - 1];
    if (previous > 0) {
      upContexts += 1;
      if (current > 0) upAfterUp += 1;
    } else if (previous < 0) {
      downContexts += 1;
      if (current > 0) upAfterDown += 1;
    }
  }
  const lastDelta = rows.at(-1) - rows.at(-2);
  if (lastDelta > 0 && upContexts) return upAfterUp / upContexts;
  if (lastDelta < 0 && downContexts) return upAfterDown / downContexts;
  const total = upContexts + downContexts;
  return total ? (upAfterUp + upAfterDown) / total : 0.5;
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

function scoreBand(value) {
  if (value >= 82) return "STRONG";
  if (value >= 74) return "GOOD";
  if (value >= 64) return "WATCH";
  return "WEAK";
}

export function analyzeHigherHigh(prices = [], options = {}) {
  const values = finiteSeries(prices).slice(-260);
  const minimumTicks = Math.max(100, Number(options.minimumTicks ?? 140));
  const userMinimumConfidence = clamp(Number(options.minimumConfidence ?? 80), 70, 95);
  const minimumEfficiency = clamp(Number(options.minimumEfficiency ?? 0.18), 0.08, 0.8);
  const maximumEntropy = clamp(Number(options.maximumEntropy ?? 0.99), 0.7, 1);

  if (values.length < minimumTicks) {
    return {
      ready: false,
      decision: "COLLECTING",
      confidence: 0,
      adaptiveThreshold: userMinimumConfidence,
      reason: `Collecting ticks ${values.length}/${minimumTicks}`,
      structure: "WAIT",
      pullback: "WAIT",
      regime: "COLLECTING",
      probability: 50,
      metrics: { ticksCollected: values.length },
      checks: [],
    };
  }

  const last = values.at(-1);
  const prior = values.at(-2);
  const returns = values.slice(-70).map((value, index, rows) => index ? value - rows[index - 1] : 0).slice(1);
  const volatility = standardDeviation(returns);
  const safeVolatility = Math.max(volatility, Number.EPSILON);
  const recentMove = Math.abs(last - prior);
  const spikeRatio = recentMove / safeVolatility;

  const fast = ema(values.slice(-80), 9);
  const medium = ema(values.slice(-120), 21);
  const slow = ema(values, 50);
  const fastBefore = ema(values.slice(-81, -1), 9);
  const mediumBefore = ema(values.slice(-121, -1), 21);
  const fastSlope = fast - fastBefore;
  const mediumSlope = medium - mediumBefore;

  const slope8 = linearSlope(values, 8);
  const slope20 = linearSlope(values, 20);
  const slope50 = linearSlope(values, 50);
  const normalizedSlope8 = slope8 / safeVolatility;
  const normalizedSlope20 = slope20 / safeVolatility;
  const normalizedSlope50 = slope50 / safeVolatility;

  const momentum3 = last - values.at(-4);
  const momentum5 = last - values.at(-6);
  const momentum12 = last - values.at(-13);
  const momentum24 = last - values.at(-25);
  const acceleration = (momentum5 / 5) - ((values.at(-6) - values.at(-11)) / 5);

  const micro = directionStats(values, 8);
  const short = directionStats(values, 15);
  const mediumWindow = directionStats(values, 35);
  const transition = transitionProbability(values, 60);
  const efficiency12 = efficiencyRatio(values, 12);
  const efficiency28 = efficiencyRatio(values, 28);
  const entropy18 = directionalEntropy(values, 18);
  const entropy36 = directionalEntropy(values, 36);

  const pivotRows = values.slice(-130);
  const { highs, lows } = pivots(pivotRows, 2);
  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);
  const lastTwoHighs = recentHighs.slice(-2);
  const lastTwoLows = recentLows.slice(-2);

  const higherHigh = lastTwoHighs.length === 2 && lastTwoHighs[1].value > lastTwoHighs[0].value;
  const higherLow = lastTwoLows.length === 2 && lastTwoLows[1].value > lastTwoLows[0].value;
  const softHigherHigh = last > Math.max(...values.slice(-18, -2));
  const structureScore = (higherHigh ? 1 : 0) + (higherLow ? 1 : 0) + (softHigherHigh ? 0.5 : 0);
  const structureBullish = higherLow && (higherHigh || softHigherHigh);

  const emaAligned = fast > medium && medium >= slow;
  const emaBullishSoft = fast > medium && fastSlope > 0;
  const slopeVotes = [normalizedSlope8 > 0.05, normalizedSlope20 > 0.02, normalizedSlope50 > -0.01];
  const slopeVoteCount = slopeVotes.filter(Boolean).length;
  const multiTrend = slopeVoteCount >= 2;

  const momentumVotes = [momentum3 > 0, momentum5 > 0, momentum12 > 0, momentum24 > 0];
  const momentumVoteCount = momentumVotes.filter(Boolean).length;
  const momentumBullish = momentumVoteCount >= 3 || (momentumVoteCount >= 2 && acceleration > 0);

  const lastSwingHigh = lastTwoHighs.at(-1)?.value ?? Math.max(...values.slice(-30));
  const lastSwingLow = lastTwoLows.at(-1)?.value ?? Math.min(...values.slice(-30));
  const range = Math.max(safeVolatility * 2, lastSwingHigh - lastSwingLow, Number.EPSILON);
  const retracement = (lastSwingHigh - last) / range;
  const heldHigherLow = last > lastSwingLow;
  const shallowPullback = retracement >= -0.10 && retracement <= 0.58 && heldHigherLow;
  const continuation = last > prior && (prior >= values.at(-3) || momentum3 > 0);
  const breakoutContinuation = softHigherHigh && micro.upRatio >= 0.6 && momentum5 > 0;
  const pullbackConfirmed = (shallowPullback && continuation) || breakoutContinuation;

  const noSpike = spikeRatio <= 2.25;
  const efficiencyGood = efficiency12 >= minimumEfficiency || efficiency28 >= minimumEfficiency;
  const noiseAcceptable = entropy18 <= maximumEntropy || entropy36 <= maximumEntropy;
  const microBullish = micro.upRatio >= 0.58 && micro.bestUpRun >= 2;
  const shortBullish = short.upRatio >= 0.54;
  const mediumBullish = mediumWindow.upRatio >= 0.51;
  const timeframeAgreement = [microBullish, shortBullish, mediumBullish].filter(Boolean).length;
  const transitionGood = transition >= 0.52;

  const strongTrend = emaAligned && multiTrend && timeframeAgreement >= 2;
  const mediumTrend = (emaBullishSoft || multiTrend) && timeframeAgreement >= 2;
  const regime = strongTrend ? "STRONG TREND" : mediumTrend ? "TREND" : efficiency28 < 0.12 ? "CHOPPY" : "MIXED";

  const adaptiveThreshold = clamp(
    userMinimumConfidence
      - (strongTrend ? 5 : mediumTrend ? 2 : 0)
      + (spikeRatio > 1.7 ? 4 : 0)
      + (entropy36 > 0.995 ? 2 : 0),
    74,
    92
  );

  const checks = [
    { label: "HH / breakout", passed: higherHigh || softHigherHigh, weight: 10 },
    { label: "Higher Low", passed: higherLow, weight: 11 },
    { label: "EMA trend", passed: emaAligned || emaBullishSoft, weight: 11 },
    { label: "3-window slope", passed: multiTrend, weight: 10 },
    { label: "Momentum vote", passed: momentumBullish, weight: 11 },
    { label: "Acceleration", passed: acceleration > 0, weight: 7 },
    { label: "Micro trend", passed: microBullish, weight: 8 },
    { label: "Timeframe 2/3", passed: timeframeAgreement >= 2, weight: 9 },
    { label: "Pullback / break", passed: pullbackConfirmed, weight: 10 },
    { label: "Transition", passed: transitionGood, weight: 5 },
    { label: "Efficiency", passed: efficiencyGood, weight: 4 },
    { label: "No spike", passed: noSpike, weight: 4 },
  ];

  const rawScore = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  const structureBonus = structureScore >= 2 ? 3 : 0;
  const probability = clamp(
    50
      + (micro.upRatio - 0.5) * 45
      + (short.upRatio - 0.5) * 30
      + (transition - 0.5) * 22
      + clamp(normalizedSlope20, -1, 1) * 8,
    35,
    88
  );
  const confidence = clamp(Math.round(rawScore + structureBonus), 0, 100);

  const hardRiskGate = noSpike && heldHigherLow && regime !== "CHOPPY";
  const directionalGate = (structureBullish || (softHigherHigh && emaBullishSoft)) && multiTrend;
  const timingGate = pullbackConfirmed && momentumBullish && timeframeAgreement >= 2;
  const qualityGate = efficiencyGood || (strongTrend && micro.upRatio >= 0.62);
  const ready = hardRiskGate && directionalGate && timingGate && qualityGate && confidence >= adaptiveThreshold;

  let reason = "Waiting for a higher-probability continuation.";
  if (!noSpike) reason = "Volatility spike detected. Entry blocked for safety.";
  else if (regime === "CHOPPY") reason = "Market is choppy. Waiting for directional efficiency.";
  else if (!directionalGate) reason = "Structure and multi-window trend are not aligned yet.";
  else if (timeframeAgreement < 2) reason = "Micro, short and medium trend need at least 2/3 agreement.";
  else if (!momentumBullish) reason = "Momentum vote is not bullish enough.";
  else if (!pullbackConfirmed) reason = "Waiting for shallow pullback continuation or clean breakout.";
  else if (!qualityGate) reason = "Market quality is still below the adaptive entry gate.";
  else if (confidence < adaptiveThreshold) reason = `Score ${confidence}% is below adaptive threshold ${adaptiveThreshold}%.`;
  else reason = "Adaptive HH continuation confirmed. CALL entry is ready.";

  return {
    ready,
    decision: ready ? "BUY HIGHER" : confidence >= adaptiveThreshold - 6 ? "WATCH" : "WAIT",
    confidence,
    adaptiveThreshold,
    probability: Math.round(probability),
    quality: scoreBand(confidence),
    reason,
    structure: structureBullish ? "HH + HL" : softHigherHigh && higherLow ? "BREAK + HL" : higherHigh ? "HH ONLY" : higherLow ? "HL ONLY" : "UNCONFIRMED",
    pullback: pullbackConfirmed ? "CONFIRMED" : shallowPullback ? "FORMING" : "WAIT",
    regime,
    duration: Number(options.duration ?? 5),
    durationUnit: String(options.durationUnit ?? "t"),
    checks,
    metrics: {
      ticksCollected: values.length,
      fastEma: fast,
      mediumEma: medium,
      slowEma: slow,
      fastSlope,
      mediumSlope,
      normalizedSlope8,
      normalizedSlope20,
      normalizedSlope50,
      momentum3,
      momentum5,
      momentum12,
      momentum24,
      acceleration,
      microUpRatio: micro.upRatio,
      shortUpRatio: short.upRatio,
      mediumUpRatio: mediumWindow.upRatio,
      timeframeAgreement,
      transitionProbability: transition,
      volatility,
      spikeRatio,
      efficiency12,
      efficiency28,
      entropy18,
      entropy36,
      retracement,
      lastSwingHigh,
      lastSwingLow,
      currentPrice: last,
    },
  };
}
