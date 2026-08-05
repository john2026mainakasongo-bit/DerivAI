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

function linearSlope(values, lookback) {
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
  return denominator
    ? (n * sumXY - sumX * sumY) / denominator
    : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean =
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0
    ) / values.length;

  return Math.sqrt(variance);
}

function efficiencyRatio(values, lookback) {
  const rows = values.slice(-lookback);
  if (rows.length < 3) return 0;

  const net = Math.abs(rows.at(-1) - rows[0]);
  let travel = 0;

  for (let index = 1; index < rows.length; index += 1) {
    travel += Math.abs(rows[index] - rows[index - 1]);
  }

  return travel > 0 ? net / travel : 0;
}

function directionalEntropy(values, lookback) {
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

  const probabilities = [up / total, down / total].filter(
    (value) => value > 0
  );

  return -probabilities.reduce(
    (sum, value) => sum + value * Math.log2(value),
    0
  );
}

function directionStats(values, lookback) {
  const rows = values.slice(-(lookback + 1));
  let up = 0;
  let down = 0;
  let run = 0;
  let bestUpRun = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const delta = rows[index] - rows[index - 1];

    if (delta > 0) {
      up += 1;
      run += 1;
      bestUpRun = Math.max(bestUpRun, run);
    } else {
      run = 0;
      if (delta < 0) down += 1;
    }
  }

  const directional = up + down;

  return {
    up,
    down,
    upRatio: directional ? up / directional : 0.5,
    bestUpRun,
  };
}

function transitionProbability(values, lookback = 70) {
  const rows = values.slice(-(lookback + 1));
  if (rows.length < 15) return 0.5;

  let bullishOutcomes = 0;
  let bullishContexts = 0;

  for (let index = 3; index < rows.length; index += 1) {
    const a = rows[index - 2] - rows[index - 3];
    const b = rows[index - 1] - rows[index - 2];
    const c = rows[index] - rows[index - 1];

    // Continuation after either an up move or a shallow one-tick pullback.
    const bullishContext =
      (a > 0 && b >= 0) ||
      (a > 0 && b < 0 && Math.abs(b) < Math.abs(a));

    if (bullishContext) {
      bullishContexts += 1;
      if (c > 0) bullishOutcomes += 1;
    }
  }

  return bullishContexts
    ? bullishOutcomes / bullishContexts
    : 0.5;
}

function pivots(values, wing = 2) {
  const highs = [];
  const lows = [];

  for (let index = wing; index < values.length - wing; index += 1) {
    const center = values[index];
    const left = values.slice(index - wing, index);
    const right = values.slice(index + 1, index + wing + 1);

    if (
      left.every((value) => center > value) &&
      right.every((value) => center >= value)
    ) {
      highs.push({ index, value: center });
    }

    if (
      left.every((value) => center < value) &&
      right.every((value) => center <= value)
    ) {
      lows.push({ index, value: center });
    }
  }

  return { highs, lows };
}

export function analyzeHigherHigh(prices = [], options = {}) {
  const values = finiteSeries(prices).slice(-300);

  const minimumTicks = Math.max(
    140,
    Number(options.minimumTicks ?? 180)
  );

  const minimumConfidence = clamp(
    Number(options.minimumConfidence ?? 84),
    78,
    96
  );

  const minimumEfficiency = clamp(
    Number(options.minimumEfficiency ?? 0.28),
    0.18,
    0.8
  );

  const maximumEntropy = clamp(
    Number(options.maximumEntropy ?? 0.86),
    0.65,
    0.95
  );

  const minimumTransition = clamp(
    Number(options.minimumTransition ?? 0.56),
    0.52,
    0.75
  );

  const maximumSpikeRatio = clamp(
    Number(options.maximumSpikeRatio ?? 1.55),
    1,
    2.5
  );

  if (values.length < minimumTicks) {
    return {
      ready: false,
      decision: "COLLECTING",
      confidence: 0,
      adaptiveThreshold: minimumConfidence,
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

  const returns = values
    .slice(-90)
    .map((value, index, rows) =>
      index ? value - rows[index - 1] : 0
    )
    .slice(1);

  const volatility = standardDeviation(returns);
  const safeVolatility = Math.max(volatility, Number.EPSILON);
  const spikeRatio = Math.abs(last - prior) / safeVolatility;

  const fast = ema(values.slice(-100), 9);
  const medium = ema(values.slice(-150), 21);
  const slow = ema(values, 50);

  const fastBefore = ema(values.slice(-101, -1), 9);
  const mediumBefore = ema(values.slice(-151, -1), 21);

  const fastSlope = fast - fastBefore;
  const mediumSlope = medium - mediumBefore;

  const slope8 = linearSlope(values, 8) / safeVolatility;
  const slope20 = linearSlope(values, 20) / safeVolatility;
  const slope50 = linearSlope(values, 50) / safeVolatility;

  const momentum3 = last - values.at(-4);
  const momentum5 = last - values.at(-6);
  const momentum12 = last - values.at(-13);
  const momentum24 = last - values.at(-25);

  const acceleration =
    momentum5 / 5 -
    (values.at(-6) - values.at(-11)) / 5;

  const micro = directionStats(values, 8);
  const short = directionStats(values, 15);
  const mediumWindow = directionStats(values, 35);

  const transition = transitionProbability(values, 70);
  const efficiency12 = efficiencyRatio(values, 12);
  const efficiency28 = efficiencyRatio(values, 28);
  const entropy18 = directionalEntropy(values, 18);
  const entropy36 = directionalEntropy(values, 36);

  const pivotRows = values.slice(-150);
  const { highs, lows } = pivots(pivotRows, 2);
  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);

  const higherHigh =
    lastTwoHighs.length === 2 &&
    lastTwoHighs[1].value > lastTwoHighs[0].value;

  const higherLow =
    lastTwoLows.length === 2 &&
    lastTwoLows[1].value > lastTwoLows[0].value;

  const recentResistance = Math.max(...values.slice(-22, -2));
  const cleanBreakout = last > recentResistance;

  const lastSwingHigh =
    lastTwoHighs.at(-1)?.value ??
    Math.max(...values.slice(-35));

  const lastSwingLow =
    lastTwoLows.at(-1)?.value ??
    Math.min(...values.slice(-35));

  const range = Math.max(
    safeVolatility * 3,
    lastSwingHigh - lastSwingLow,
    Number.EPSILON
  );

  const retracement = (lastSwingHigh - last) / range;
  const heldHigherLow = last > lastSwingLow;

  const controlledPullback =
    heldHigherLow &&
    retracement >= 0.04 &&
    retracement <= 0.48;

  const continuation =
    last > prior &&
    prior >= values.at(-3) &&
    momentum3 > 0;

  const breakoutContinuation =
    cleanBreakout &&
    micro.upRatio >= 0.63 &&
    micro.bestUpRun >= 2 &&
    momentum3 > 0 &&
    momentum5 > 0;

  const pullbackConfirmed =
    (controlledPullback && continuation) ||
    breakoutContinuation;

  const emaAligned =
    fast > medium &&
    medium > slow &&
    fastSlope > 0 &&
    mediumSlope > 0;

  const slopesAligned =
    slope8 > 0.06 &&
    slope20 > 0.025 &&
    slope50 > 0;

  const momentumAligned =
    momentum3 > 0 &&
    momentum5 > 0 &&
    momentum12 > 0;

  const microBullish =
    micro.upRatio >= 0.62 &&
    micro.bestUpRun >= 2;

  const shortBullish = short.upRatio >= 0.57;
  const mediumBullish = mediumWindow.upRatio >= 0.53;

  const timeframeAgreement = [
    microBullish,
    shortBullish,
    mediumBullish,
  ].filter(Boolean).length;

  const efficiencyGood =
    efficiency12 >= minimumEfficiency &&
    efficiency28 >= Math.max(0.20, minimumEfficiency - 0.04);

  const entropyGood =
    entropy18 <= maximumEntropy &&
    entropy36 <= Math.min(0.92, maximumEntropy + 0.04);

  const transitionGood = transition >= minimumTransition;
  const noSpike = spikeRatio <= maximumSpikeRatio;
  const structureBullish =
    higherLow && (higherHigh || cleanBreakout);

  const trendScore = Math.round(
    clamp(
      (emaAligned ? 38 : 0) +
        (slopesAligned ? 30 : 0) +
        (higherLow ? 17 : 0) +
        (higherHigh || cleanBreakout ? 15 : 0),
      0,
      100
    )
  );

  const momentumScore = Math.round(
    clamp(
      micro.upRatio * 25 +
        short.upRatio * 20 +
        mediumWindow.upRatio * 15 +
        (momentum3 > 0 ? 12 : 0) +
        (momentum5 > 0 ? 12 : 0) +
        (momentum12 > 0 ? 10 : 0) +
        (acceleration >= 0 ? 6 : 0),
      0,
      100
    )
  );

  const volatilityScore = Math.round(
    clamp(
      (1 - Math.min(1, entropy18)) * 35 +
        (1 - Math.min(1, entropy36)) * 25 +
        Math.min(1, efficiency12 / 0.45) * 20 +
        Math.min(1, efficiency28 / 0.35) * 15 +
        (noSpike ? 5 : 0),
      0,
      100
    )
  );

  const patternScore = Math.round(
    clamp(
      (structureBullish ? 35 : 0) +
        (pullbackConfirmed ? 35 : 0) +
        (cleanBreakout ? 15 : 0) +
        (continuation ? 15 : 0),
      0,
      100
    )
  );

  const transitionScore = Math.round(
    clamp(transition * 100, 0, 100)
  );

  const riskPenalty = Math.round(
    clamp(
      (spikeRatio > 1.4 ? (spikeRatio - 1.4) * 28 : 0) +
        (entropy18 > 0.94 ? (entropy18 - 0.94) * 180 : 0) +
        (efficiency28 < 0.12 ? (0.12 - efficiency28) * 120 : 0) +
        (timeframeAgreement === 0 ? 18 : 0),
      0,
      45
    )
  );

  const learnedWeights =
    options.learningWeights &&
    typeof options.learningWeights === "object"
      ? options.learningWeights
      : {};

  const weightTrend = clamp(
    Number(learnedWeights.trend ?? 1),
    0.72,
    1.28
  );
  const weightMomentum = clamp(
    Number(learnedWeights.momentum ?? 1),
    0.72,
    1.28
  );
  const weightVolatility = clamp(
    Number(learnedWeights.volatility ?? 1),
    0.72,
    1.28
  );
  const weightPattern = clamp(
    Number(learnedWeights.pattern ?? 1),
    0.72,
    1.28
  );
  const weightTransition = clamp(
    Number(learnedWeights.transition ?? 1),
    0.72,
    1.28
  );

  const weightedTotal =
    0.28 * weightTrend +
    0.24 * weightMomentum +
    0.16 * weightVolatility +
    0.20 * weightPattern +
    0.12 * weightTransition;

  const confidence = Math.round(
    clamp(
      (
        trendScore * 0.28 * weightTrend +
        momentumScore * 0.24 * weightMomentum +
        volatilityScore * 0.16 * weightVolatility +
        patternScore * 0.20 * weightPattern +
        transitionScore * 0.12 * weightTransition
      ) /
        Math.max(weightedTotal, Number.EPSILON) -
        riskPenalty,
      0,
      100
    )
  );

  const probabilityComponents = {
    transition: clamp(transition, 0, 1),
    trend: clamp(trendScore / 100, 0, 1),
    momentum: clamp(momentumScore / 100, 0, 1),
    volatility: clamp(volatilityScore / 100, 0, 1),
    pattern: clamp(patternScore / 100, 0, 1),
    timeframe: clamp(timeframeAgreement / 3, 0, 1),
  };

  const rawProbability =
    probabilityComponents.transition * 0.20 +
    probabilityComponents.trend * 0.20 +
    probabilityComponents.momentum * 0.20 +
    probabilityComponents.volatility * 0.12 +
    probabilityComponents.pattern * 0.18 +
    probabilityComponents.timeframe * 0.10;

  const cappedProbability = clamp(
    rawProbability * 100 - riskPenalty * 0.45,
    5,
    96
  );

  const probability = Math.round(cappedProbability);

  const minimumVoteScore = clamp(
    Number(options.minimumVoteScore ?? 78),
    68,
    92
  );

  const minimumProbability = clamp(
    Number(options.minimumProbability ?? 54),
    50,
    72
  );

  const hardRiskBlock =
    spikeRatio > maximumSpikeRatio ||
    entropy18 > 0.97 ||
    entropy36 > 0.98 ||
    efficiency12 < 0.03 ||
    timeframeAgreement === 0;

  const votePasses = [
    trendScore >= 70,
    momentumScore >= 66,
    volatilityScore >= 38,
    patternScore >= 60,
    transitionScore >= minimumProbability,
  ].filter(Boolean).length;

  const minimumTrendRegimeScore = clamp(
    Number(options.minimumTrendRegimeScore ?? 42),
    20,
    80
  );

  const maximumRangeEntropy = clamp(
    Number(options.maximumRangeEntropy ?? 0.96),
    0.80,
    1
  );

  const minimumBreakoutEfficiency = clamp(
    Number(options.minimumBreakoutEfficiency ?? 0.10),
    0.02,
    0.40
  );

  const trendRegimeScore = Math.round(
    clamp(
      trendScore * 0.40 +
        momentumScore * 0.25 +
        patternScore * 0.20 +
        volatilityScore * 0.15,
      0,
      100
    )
  );

  const isRangeMarket =
    entropy18 >= maximumRangeEntropy &&
    efficiency28 < minimumBreakoutEfficiency &&
    patternScore < 45;

  const isTrendMarket =
    trendRegimeScore >= minimumTrendRegimeScore &&
    !isRangeMarket;

  const isVolatileMarket =
    spikeRatio > 1.25 ||
    entropy18 > 0.94;

  const marketRegime = isRangeMarket
    ? "RANGE"
    : isVolatileMarket
    ? "VOLATILE"
    : isTrendMarket
    ? "TREND"
    : "MIXED";

  const decisionCodes = [];

  if (marketRegime === "TREND") {
    decisionCodes.push({
      code: "TREND_OK",
      label: "Trend direction is usable.",
      passed: true,
    });
  } else if (marketRegime === "RANGE") {
    decisionCodes.push({
      code: "RANGE_MARKET",
      label: "Market is moving sideways; Higher strategy is blocked.",
      passed: false,
    });
  } else if (marketRegime === "VOLATILE") {
    decisionCodes.push({
      code: "SPIKE_RISK",
      label: "Market is noisy or stretched; wait for stabilization.",
      passed: false,
    });
  } else {
    decisionCodes.push({
      code: "REGIME_MIXED",
      label: "Trend and range signals are mixed.",
      passed: false,
    });
  }

  decisionCodes.push({
    code: emaAligned ? "EMA_OK" : "EMA_WAIT",
    label: emaAligned
      ? "EMA 9, 21 and 50 support the Higher direction."
      : "EMA direction is not fully aligned.",
    passed: emaAligned,
  });

  decisionCodes.push({
    code: momentum3 > 0 && momentum5 > 0
      ? "MOMENTUM_OK"
      : "MOMENTUM_WEAK",
    label:
      momentum3 > 0 && momentum5 > 0
        ? "Short momentum is positive."
        : "Short momentum is not strong enough.",
    passed: momentum3 > 0 && momentum5 > 0,
  });

  decisionCodes.push({
    code: structureBullish || cleanBreakout
      ? "STRUCTURE_OK"
      : "STRUCTURE_WAIT",
    label:
      structureBullish || cleanBreakout
        ? "HH/HL or breakout structure is confirmed."
        : "Higher High / Higher Low structure is incomplete.",
    passed: structureBullish || cleanBreakout,
  });

  decisionCodes.push({
    code: hardRiskBlock ? "RISK_BLOCK" : "RISK_OK",
    label: hardRiskBlock
      ? "Risk filter rejected the setup."
      : "No hard risk block detected.",
    passed: !hardRiskBlock,
  });

  const ready =
    !hardRiskBlock &&
    !isRangeMarket &&
    confidence >= minimumVoteScore &&
    probability >= minimumProbability &&
    votePasses >= 2 &&
    (structureBullish || cleanBreakout) &&
    momentum3 > 0 &&
    momentum5 > 0;

  const checks = [
    { label: "Trend AI", passed: trendScore >= 70, weight: trendScore },
    { label: "Momentum AI", passed: momentumScore >= 66, weight: momentumScore },
    { label: "Volatility AI", passed: volatilityScore >= 38, weight: volatilityScore },
    { label: "Pattern AI", passed: patternScore >= 60, weight: patternScore },
    { label: "Transition AI", passed: transitionScore >= minimumProbability, weight: transitionScore },
    { label: "Risk AI", passed: !hardRiskBlock, weight: Math.max(0, 100 - riskPenalty) },
  ];

  let reason = "AI voting engine is waiting for a qualified majority.";
  let primaryCode = "WAIT_ANALYSIS";

  if (hardRiskBlock) {
    primaryCode = "RISK_BLOCK";
    reason = "Risk AI blocked the setup because noise, spike or efficiency is unsafe.";
  } else if (isRangeMarket) {
    primaryCode = "RANGE_MARKET";
    reason = "Market is sideways; Higher entries are disabled.";
  } else if (confidence < minimumVoteScore) {
    primaryCode = "SCORE_LOW";
    reason = `Vote score ${confidence}% is below ${minimumVoteScore}%.`;
  } else if (probability < minimumProbability) {
    primaryCode = "PROBABILITY_LOW";
    reason = `Probability ${probability}% is below ${minimumProbability}%.`;
  } else if (votePasses < 2) {
    primaryCode = "VOTES_LOW";
    reason = `Only ${votePasses}/5 analysis agents agree; at least 2 are required.`;
  } else if (!(structureBullish || cleanBreakout)) {
    primaryCode = "STRUCTURE_WAIT";
    reason = "Structure AI has not confirmed HH/HL or breakout.";
  } else if (!(momentum3 > 0 && momentum5 > 0)) {
    primaryCode = "MOMENTUM_WEAK";
    reason = "Micro momentum is not positive enough for entry.";
  } else {
    primaryCode = "ENTRY_READY";
    reason = "AI voting majority passed. Entry is ready after confirmation ticks.";
  }

  const regime =
    hardRiskBlock
      ? "RISK BLOCK"
      : ready
      ? "VOTE QUALIFIED"
      : confidence >= minimumVoteScore - 6
      ? "WATCH"
      : "MIXED";


  return {
    ready,
    decision: ready ? "READY HIGHER" : confidence >= 72 ? "WATCH" : "WAIT",
    confidence,
    adaptiveThreshold: minimumConfidence,
    reason,
    structure: structureBullish ? "HH + HL" : "WAIT",
    pullback: pullbackConfirmed ? "CONFIRMED" : "FORMING",
    regime,
    marketRegime,
    primaryCode,
    decisionCodes,
    probability,
    checks,
    metrics: {
      ticksCollected: values.length,
      fastEma: fast,
      mediumEma: medium,
      slowEma: slow,
      momentum3,
      momentum5,
      momentum12,
      momentum24,
      acceleration,
      efficiency12,
      efficiency28,
      entropy18,
      entropy36,
      spikeRatio,
      transitionProbability: transition,
      microUpRatio: micro.upRatio,
      shortUpRatio: short.upRatio,
      mediumUpRatio: mediumWindow.upRatio,
      timeframeAgreement,
      higherHigh,
      higherLow,
      cleanBreakout,
      controlledPullback,
      continuation,
      slope8,
      slope20,
      slope50,
      minimumTransition,
      maximumSpikeRatio,
      trendScore,
      momentumScore,
      volatilityScore,
      patternScore,
      transitionScore,
      riskPenalty,
      votePasses,
      minimumVoteScore,
      minimumProbability,
      hardRiskBlock,
      trendRegimeScore,
      isRangeMarket,
      isTrendMarket,
      isVolatileMarket,
      probabilityComponents,
      rawProbabilityScore: cappedProbability,
      learningWeights: {
        trend: weightTrend,
        momentum: weightMomentum,
        volatility: weightVolatility,
        pattern: weightPattern,
        transition: weightTransition,
      },
    },
  };
}
