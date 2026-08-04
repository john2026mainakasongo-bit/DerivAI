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

  const checks = [
    {
      label: "HH / breakout",
      passed: higherHigh || cleanBreakout,
      weight: 9,
    },
    {
      label: "Higher Low",
      passed: higherLow,
      weight: 10,
    },
    {
      label: "EMA 9>21>50",
      passed: emaAligned,
      weight: 13,
    },
    {
      label: "3-window slope",
      passed: slopesAligned,
      weight: 11,
    },
    {
      label: "Momentum 3/5/12",
      passed: momentumAligned,
      weight: 13,
    },
    {
      label: "Acceleration",
      passed: acceleration >= 0,
      weight: 5,
    },
    {
      label: "Timeframe 3/3",
      passed: timeframeAgreement === 3,
      weight: 11,
    },
    {
      label: "Pullback / break",
      passed: pullbackConfirmed,
      weight: 10,
    },
    {
      label: "Transition ≥ gate",
      passed: transitionGood,
      weight: 7,
    },
    {
      label: "Efficiency",
      passed: efficiencyGood,
      weight: 6,
    },
    {
      label: "Low entropy",
      passed: entropyGood,
      weight: 3,
    },
    {
      label: "No spike",
      passed: noSpike,
      weight: 2,
    },
  ];

  const confidence = Math.round(
    checks.reduce(
      (sum, check) => sum + (check.passed ? check.weight : 0),
      0
    )
  );

  const probability = Math.round(
    clamp(
      transition * 45 +
        micro.upRatio * 20 +
        short.upRatio * 15 +
        mediumWindow.upRatio * 10 +
        efficiency12 * 10,
      0,
      1
    ) * 100
  );

  const hardGate =
    structureBullish &&
    emaAligned &&
    slopesAligned &&
    momentumAligned &&
    timeframeAgreement === 3 &&
    pullbackConfirmed &&
    transitionGood &&
    efficiencyGood &&
    entropyGood &&
    noSpike;

  const ready =
    hardGate &&
    confidence >= minimumConfidence;

  let reason =
    "Strict V3 gate is waiting for full confirmation.";

  if (!structureBullish) {
    reason = "Higher High / Higher Low structure is incomplete.";
  } else if (!emaAligned) {
    reason = "EMA 9, 21 and 50 are not fully bullish.";
  } else if (!slopesAligned) {
    reason = "Micro, short and medium slopes do not agree.";
  } else if (!momentumAligned) {
    reason = "Momentum 3, 5 and 12 must all be positive.";
  } else if (timeframeAgreement !== 3) {
    reason = `Timeframe agreement is ${timeframeAgreement}/3; V3 requires 3/3.`;
  } else if (!pullbackConfirmed) {
    reason = "Waiting for controlled pullback continuation or clean breakout.";
  } else if (!transitionGood) {
    reason = `Continuation probability ${(transition * 100).toFixed(0)}% is below ${(minimumTransition * 100).toFixed(0)}%.`;
  } else if (!efficiencyGood) {
    reason = "Trend efficiency is too low for a low-risk entry.";
  } else if (!entropyGood) {
    reason = "Market direction is too random for V3.";
  } else if (!noSpike) {
    reason = "Recent move is a spike; entry blocked.";
  } else if (confidence < minimumConfidence) {
    reason = `Confidence ${confidence}% is below ${minimumConfidence}%.`;
  } else {
    reason = "All strict gates passed. Hold signal for confirmation ticks.";
  }

  const regime =
    hardGate
      ? "QUALIFIED TREND"
      : entropy36 > 0.92 || efficiency28 < 0.18
      ? "CHOPPY"
      : emaAligned
      ? "BULLISH WATCH"
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
    },
  };
}
