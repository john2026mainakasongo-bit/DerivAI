const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, Number(value || 0)));

const mean = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) /
      values.length
    : 0;

const standardDeviation = (values) => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    mean(values.map((value) => (value - average) ** 2))
  );
};

function lastDigit(quote) {
  const numeric = Number(quote);
  if (!Number.isFinite(numeric)) return null;

  const normalized = numeric
    .toFixed(5)
    .replace(".", "");

  const digit = Number(normalized.at(-1));
  return Number.isInteger(digit) ? digit : null;
}

function normalizedEntropy(digits) {
  if (!digits.length) return 100;

  const counts = Array.from({ length: 10 }, () => 0);

  for (const digit of digits) {
    if (digit >= 0 && digit <= 9) {
      counts[digit] += 1;
    }
  }

  let entropy = 0;

  for (const count of counts) {
    if (!count) continue;
    const probability = count / digits.length;
    entropy -= probability * Math.log2(probability);
  }

  return clamp(
    (entropy / Math.log2(10)) * 100,
    0,
    100
  );
}

function cycleAnalysis(digits) {
  let bestLength = 0;
  let bestStrength = 0;

  for (let lag = 2; lag <= 12; lag += 1) {
    if (digits.length < lag * 3) continue;

    let matches = 0;
    let comparisons = 0;

    for (let index = lag; index < digits.length; index += 1) {
      comparisons += 1;
      if (digits[index] === digits[index - lag]) {
        matches += 1;
      }
    }

    const strength =
      comparisons > 0
        ? (matches / comparisons) * 100
        : 0;

    if (strength > bestStrength) {
      bestStrength = strength;
      bestLength = lag;
    }
  }

  return {
    length: bestStrength >= 16 ? bestLength : 0,
    strength: Math.round(bestStrength),
  };
}

function transitionAnalysis(changes) {
  const directions = changes
    .map((value) =>
      value > 0 ? 1 : value < 0 ? -1 : 0
    )
    .filter(Boolean);

  if (directions.length < 4) {
    return {
      direction: "NONE",
      probability: 50,
      persistence: 0,
    };
  }

  const recent = directions.slice(-16);
  const rises = recent.filter((value) => value > 0).length;
  const falls = recent.filter((value) => value < 0).length;

  const direction =
    rises > falls
      ? "RISE"
      : falls > rises
        ? "FALL"
        : "NONE";

  const probability =
    Math.max(rises, falls) /
    Math.max(1, rises + falls) *
    100;

  let repeated = 0;

  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index] === recent[index - 1]) {
      repeated += 1;
    }
  }

  return {
    direction,
    probability: clamp(probability, 50, 96),
    persistence:
      repeated /
      Math.max(1, recent.length - 1) *
      100,
  };
}


function tickSequenceAnalysis(changes = []) {
  const directions = changes
    .map((value) => (value > 0 ? 1 : value < 0 ? -1 : 0))
    .filter(Boolean);

  const windowStats = (size) => {
    const window = directions.slice(-size);
    const rises = window.filter((value) => value > 0).length;
    const falls = window.filter((value) => value < 0).length;
    const direction =
      rises > falls ? "RISE" : falls > rises ? "FALL" : "NONE";
    const dominance =
      window.length
        ? (Math.max(rises, falls) / window.length) * 100
        : 0;

    return {
      size,
      direction,
      dominance,
      rises,
      falls,
    };
  };

  const w3 = windowStats(3);
  const w5 = windowStats(5);
  const w8 = windowStats(8);
  const w13 = windowStats(13);
  const w21 = windowStats(21);

  const votes = [w3, w5, w8, w13, w21].filter(
    (item) => item.direction !== "NONE"
  );

  const riseVotes = votes.filter(
    (item) => item.direction === "RISE"
  ).length;
  const fallVotes = votes.filter(
    (item) => item.direction === "FALL"
  ).length;

  const direction =
    riseVotes > fallVotes
      ? "RISE"
      : fallVotes > riseVotes
        ? "FALL"
        : w3.direction;

  const aligned = votes.filter(
    (item) => item.direction === direction
  );

  const consensus =
    votes.length
      ? (aligned.length / votes.length) * 100
      : 0;

  const averageDominance =
    aligned.length
      ? aligned.reduce(
          (sum, item) => sum + item.dominance,
          0
        ) / aligned.length
      : 0;

  const lastSix = directions.slice(-6);
  let streak = 0;

  for (let index = lastSix.length - 1; index >= 0; index -= 1) {
    const value = lastSix[index];
    const expected = direction === "RISE" ? 1 : -1;

    if (value !== expected) break;
    streak += 1;
  }

  const flip =
    directions.length >= 4 &&
    directions.at(-1) === directions.at(-2) &&
    directions.at(-3) !== directions.at(-1);

  const score = clamp(
    consensus * 0.42 +
      averageDominance * 0.38 +
      Math.min(4, streak) * 5 +
      (flip ? 4 : 0),
    0,
    100
  );

  const setup =
    streak >= 3 && consensus >= 75
      ? "TICK_STREAK"
      : flip && consensus >= 50
        ? "PULLBACK_RELEASE"
        : consensus >= 75
          ? "MULTI_WINDOW"
          : averageDominance >= 72
            ? "TICK_PRESSURE"
            : "SCANNING";

  const targetTicks =
    setup === "TICK_STREAK"
      ? 2
      : setup === "PULLBACK_RELEASE"
        ? 3
        : setup === "MULTI_WINDOW"
          ? 3
          : 5;

  const qualified =
    direction !== "NONE" &&
    score >= 58 &&
    consensus >= 50 &&
    averageDominance >= 58;

  return {
    direction,
    score: Math.round(score),
    consensus: Math.round(consensus),
    dominance: Math.round(averageDominance),
    streak,
    setup,
    targetTicks,
    qualified,
    windows: [w3, w5, w8, w13, w21].map((item) => ({
      size: item.size,
      direction: item.direction,
      dominance: Math.round(item.dominance),
    })),
  };
}

function check(label, passed, detail) {
  return {
    label,
    passed: Boolean(passed),
    detail: String(detail || ""),
  };
}


function bucket(value, size = 10) {
  return Math.round(Number(value || 0) / size) * size;
}

function memorySignature({
  trend,
  volatility,
  regime,
  momentum,
  transitionProbability,
  probability,
  reversalRisk,
}) {
  return [
    trend === "UP" ? "RISE" : trend === "DOWN" ? "FALL" : "NONE",
    trend,
    volatility,
    regime,
    `M${bucket(Math.abs(momentum), 5)}`,
    `T${bucket(transitionProbability, 5)}`,
    `P${bucket(probability, 5)}`,
    `R${bucket(reversalRisk, 10)}`,
  ].join("|");
}


function clusterSignature({
  trend,
  volatility,
  regime,
  momentum,
  transitionProbability,
  reversalRisk,
}) {
  const momentumBand =
    Math.abs(momentum) >= 12
      ? "STRONG"
      : Math.abs(momentum) >= 5
        ? "MEDIUM"
        : "WEAK";

  const transitionBand =
    transitionProbability >= 72
      ? "HIGH"
      : transitionProbability >= 60
        ? "MEDIUM"
        : "LOW";

  const reversalBand =
    reversalRisk <= 25
      ? "LOW"
      : reversalRisk <= 50
        ? "MEDIUM"
        : "HIGH";

  return [
    trend === "UP" ? "RISE" : trend === "DOWN" ? "FALL" : "NONE",
    regime,
    volatility,
    momentumBand,
    transitionBand,
    reversalBand,
  ].join("|");
}

function mergeMemoryRows(memory, signatures) {
  const rows = signatures
    .map((signature) => memorySummary(memory, signature))
    .filter((row) => row.sample > 0);

  const sample = rows.reduce((sum, row) => sum + row.sample, 0);
  const wins = rows.reduce((sum, row) => sum + row.wins, 0);
  const losses = rows.reduce((sum, row) => sum + row.losses, 0);
  const profit = rows.reduce((sum, row) => sum + row.profit, 0);

  return {
    sample,
    wins,
    losses,
    winRate: sample ? (wins / sample) * 100 : 50,
    profit,
  };
}

function memorySummary(memory, signature) {
  const row = memory && typeof memory === "object"
    ? memory[signature]
    : null;

  const wins = Number(row?.wins || 0);
  const losses = Number(row?.losses || 0);
  const sample = wins + losses;

  return {
    sample,
    wins,
    losses,
    winRate: sample ? (wins / sample) * 100 : 50,
    profit: Number(row?.profit || 0),
  };
}

export function analyseTicks(
  ticks = [],
  adaptiveMemory = {},
  clusterMemory = {},
  riskContext = {}
) {
  const clean = (Array.isArray(ticks) ? ticks : [])
    .map(Number)
    .filter(Number.isFinite)
    .slice(-180);

  if (clean.length < 24) {
    return {
      ready: false,
      stage: "SCAN",
      decision: "WAIT",
      contract: "NONE",
      confidence: 0,
      probability: 0,
      risk: "HIGH",
      reason: `Collecting live ticks ${clean.length}/24`,
      reasons: ["Waiting for enough live market history."],
      checks: [
        check(
          "Sample",
          false,
          `${clean.length}/24 ticks collected`
        ),
      ],
      metrics: {
        momentum: 0,
        trend: "WARMING",
        volatility: "UNKNOWN",
        entropy: 100,
        bayesian: 50,
        transition: 50,
        cycle: 0,
        regime: "WARMING",
      },
    };
  }

  const recent = clean.slice(-48);
  const short = recent.slice(-10);
  const medium = recent.slice(-24);

  const changes = recent
    .slice(1)
    .map((value, index) => value - recent[index]);

  const shortChanges = short
    .slice(1)
    .map((value, index) => value - short[index]);

  const tickSequence = tickSequenceAnalysis(changes);

  const upMoves = shortChanges.filter((value) => value > 0).length;
  const downMoves = shortChanges.filter((value) => value < 0).length;
  const directionalMoves = Math.max(1, upMoves + downMoves);

  const riseShare = upMoves / directionalMoves;
  const fallShare = downMoves / directionalMoves;

  const fastAverage = mean(short);
  const mediumAverage = mean(medium);
  const slowAverage = mean(recent);

  const priceScale = Math.max(
    Math.abs(mean(recent)),
    1
  );

  const rawMomentum =
    ((short.at(-1) - short[0]) / priceScale) *
    10000;

  const momentum = clamp(rawMomentum, -100, 100);

  const trend =
    fastAverage > mediumAverage &&
    mediumAverage >= slowAverage
      ? "UP"
      : fastAverage < mediumAverage &&
          mediumAverage <= slowAverage
        ? "DOWN"
        : riseShare >= 0.62
          ? "UP"
          : fallShare >= 0.62
            ? "DOWN"
            : "FLAT";

  const recentVolatility = standardDeviation(
    changes.slice(-16)
  );
  const baselineVolatility = standardDeviation(changes);

  const volatilityRatio =
    baselineVolatility > 0
      ? recentVolatility / baselineVolatility
      : 1;

  const volatility =
    volatilityRatio > 1.65
      ? "HIGH"
      : volatilityRatio < 0.45
        ? "LOW"
        : "NORMAL";

  const digits = recent
    .map(lastDigit)
    .filter((digit) => digit !== null);

  const entropy = normalizedEntropy(digits);
  const cycle = cycleAnalysis(digits);
  const transition = transitionAnalysis(changes);

  const trendContract =
    trend === "UP"
      ? "RISE"
      : trend === "DOWN"
        ? "FALL"
        : "NONE";

  const momentumContract =
    momentum > 1.2
      ? "RISE"
      : momentum < -1.2
        ? "FALL"
        : "NONE";

  const directionalShare =
    trendContract === "RISE"
      ? riseShare * 100
      : trendContract === "FALL"
        ? fallShare * 100
        : Math.max(riseShare, fallShare) * 100;

  const bayesian = clamp(
    50 +
      (riseShare - fallShare) * 32 +
      Math.sign(momentum) *
        Math.min(14, Math.abs(momentum) * 1.8),
    3,
    97
  );

  const selectedBayesian =
    trendContract === "FALL"
      ? 100 - bayesian
      : bayesian;

  const trendAligned =
    trendContract !== "NONE" &&
    momentumContract === trendContract;

  const transitionAligned =
    transition.direction === trendContract ||
    transition.direction === "NONE";

  const volatilityAcceptable =
    volatility !== "HIGH";

  const entropyAcceptable =
    entropy <= 97;

  const momentumStrong =
    Math.abs(momentum) >= 1.5;

  const directionStrong =
    directionalShare >= 58;

  const probability = clamp(
    directionalShare * 0.32 +
      transition.probability * 0.26 +
      selectedBayesian * 0.24 +
      (trendAligned ? 88 : 45) * 0.18,
    1,
    96
  );

  let confidence = clamp(
    43 +
      Math.abs(riseShare - fallShare) * 72 +
      Math.min(18, Math.abs(momentum) * 2.4) +
      (trendAligned ? 16 : 0) +
      (transitionAligned ? 8 : -7) +
      (volatility === "NORMAL" ? 7 : 0) +
      (volatility === "LOW" ? 4 : 0) +
      (cycle.length ? 3 : 0) -
      (trend === "FLAT" ? 18 : 0) -
      (volatility === "HIGH" ? 20 : 0) -
      (entropy > 97 ? 8 : 0),
    1,
    97
  );

  confidence = Math.round(confidence);


  const regime =
    volatility === "HIGH"
      ? "CHAOTIC"
      : trend === "FLAT"
        ? "RANGE"
        : "TREND";

  const recentLossStreak = Math.max(
    0,
    Number(riskContext?.recentLossStreak || 0)
  );
  const protectionPaused = Boolean(
    riskContext?.protectionPaused
  );
  const rollingExpectedValue = Number(
    riskContext?.rollingExpectedValue || 0
  );

  const trendStrength =
    clamp(
      Math.abs(momentum) * 4 +
        Math.abs(riseShare - fallShare) * 100,
      0,
      100
    );

  const bayesianThreshold =
    regime === "RANGE"
      ? 60
      : trendStrength >= 75
        ? 66
        : 70;

  const transitionThreshold =
    volatility === "LOW"
      ? 62
      : volatility === "NORMAL"
        ? 66
        : 72;

  const evThreshold =
    Math.max(
      0.05,
      Math.min(
        0.22,
        rollingExpectedValue > 0
          ? rollingExpectedValue * 0.85
          : 0.12
      )
    );

  const hardBlock =
    trendContract === "NONE" ||
    volatility === "HIGH" ||
    !entropyAcceptable ||
    regime === "RANGE";

  const recentDirections = changes
    .slice(-4)
    .map((value) => (value > 0 ? "RISE" : value < 0 ? "FALL" : "FLAT"));

  const consecutiveDirection = recentDirections
    .filter((value) => value === trendContract).length;

  const momentumDecay =
    Math.abs(shortChanges.at(-1) || 0) <
    Math.abs(shortChanges.at(-3) || 0);

  const reversalRisk = clamp(
    (transition.direction !== trendContract ? 34 : 0) +
      (momentumDecay ? 26 : 0) +
      (consecutiveDirection < 2 ? 24 : 0) +
      (volatility === "HIGH" ? 30 : 0),
    0,
    100
  );

  const requiredConsecutive =
    2 + Math.min(2, recentLossStreak);

  const maximumReversalRisk =
    Math.max(18, 38 - recentLossStreak * 6);

  const confirmQualified =
    trendContract !== "NONE" &&
    consecutiveDirection >= requiredConsecutive &&
    transitionAligned &&
    !momentumDecay &&
    reversalRisk <= maximumReversalRisk;

  confidence = Math.round(
    clamp(confidence * 0.88 + probability * 0.12, 1, 94)
  );

  const signature = memorySignature({
    trend,
    volatility,
    regime:
      volatility === "HIGH"
        ? "CHAOTIC"
        : trend === "FLAT"
          ? "RANGE"
          : "TREND",
    momentum,
    transitionProbability: transition.probability,
    probability,
    reversalRisk,
  });

  const learned = memorySummary(
    adaptiveMemory,
    signature
  );

  const clusterKey = clusterSignature({
    trend,
    volatility,
    regime,
    momentum,
    transitionProbability: transition.probability,
    reversalRisk,
  });

  const clustered = memorySummary(
    clusterMemory,
    clusterKey
  );

  const exactWeight = Math.min(
    0.60,
    learned.sample / 20
  );
  const clusterWeight = Math.min(
    0.30,
    clustered.sample / 40
  );
  const rawWeight = Math.max(
    0.10,
    1 - exactWeight - clusterWeight
  );

  const calibratedConfidence =
    confidence * rawWeight +
    learned.winRate * exactWeight +
    clustered.winRate * clusterWeight;

  confidence = Math.round(
    clamp(
      calibratedConfidence +
        Math.max(-7, Math.min(7, learned.profit * 2.5)) +
        Math.max(-5, Math.min(5, clustered.profit * 1.5)),
      1,
      94
    )
  );

  const recentLossPenalty =
    recentLossStreak === 0
      ? 0
      : recentLossStreak === 1
        ? 5
        : recentLossStreak === 2
          ? 11
          : 18;

  confidence = Math.round(
    clamp(confidence - recentLossPenalty, 1, 94)
  );

  const exactBlacklisted =
    learned.sample >= 8 &&
    (
      learned.winRate < 45 ||
      learned.profit < -0.70
    );

  const clusterBlacklisted =
    clustered.sample >= 14 &&
    (
      clustered.winRate < 46 ||
      clustered.profit < -1.20
    );

  const memoryQualified =
    !exactBlacklisted &&
    !clusterBlacklisted &&
    (
      learned.sample < 8 ||
      (
        learned.winRate >= 60 &&
        learned.profit > 0
      )
    );

  const expectedValue =
    (probability / 100) * 0.92 -
    (1 - probability / 100);

  const learnedProfitQualified =
    learned.sample < 4 ||
    learned.profit > 0;

  const clusterProfitQualified =
    clustered.sample < 6 ||
    clustered.profit > 0;

  const recentDirectionWindow = changes
    .slice(-8)
    .map((value) =>
      value > 0 ? "RISE" : value < 0 ? "FALL" : "FLAT"
    );

  const stableDirectionalTicks =
    recentDirectionWindow.filter(
      (value) => value === trendContract
    ).length;

  const directionStability =
    recentDirectionWindow.length
      ? (stableDirectionalTicks /
          recentDirectionWindow.length) *
        100
      : 0;

  const stabilityQualified =
    directionStability >= 62 &&
    consecutiveDirection >= requiredConsecutive;

  const signalFresh =
    recentDirections.length <= 4 &&
    !momentumDecay;

  const adaptiveMarketGate =
    signalFresh &&
    regime === "TREND" &&
    selectedBayesian >= bayesianThreshold &&
    transition.probability >= transitionThreshold &&
    reversalRisk <= 30 &&
    consecutiveDirection >= requiredConsecutive &&
    Math.abs(momentum) >= 4 &&
    expectedValue >= evThreshold &&
    stabilityQualified &&
    learnedProfitQualified &&
    clusterProfitQualified;


  const checks = [
    check(
      "Direction",
      trendContract !== "NONE",
      trendContract === "NONE"
        ? "Trend is still flat"
        : `${trend} trend detected`
    ),
    check(
      "Momentum",
      momentumStrong && trendAligned,
      `Momentum ${Math.round(momentum)}`
    ),
    check(
      "Transition",
      transitionAligned &&
        transition.probability >= transitionThreshold,
      `${Math.round(
        transition.probability
      )}% / ${Math.round(transitionThreshold)}% ${transition.direction}`
    ),
    check(
      "Volatility",
      volatilityAcceptable,
      volatility
    ),
    check(
      "Entropy",
      entropyAcceptable,
      `${Math.round(entropy)}%`
    ),
    check(
      "Probability",
      probability >= 64,
      `${Math.round(probability)}%`
    ),
    check(
      "Confirmation",
      confirmQualified,
      `${consecutiveDirection}/4 aligned · reversal ${Math.round(reversalRisk)}%`
    ),
    check(
      "Pattern memory",
      memoryQualified,
      learned.sample
        ? `${learned.sample} samples · ${Math.round(learned.winRate)}% wins`
        : "No prior sample"
    ),
    check(
      "Pattern cluster",
      !clusterBlacklisted,
      clustered.sample
        ? `${clustered.sample} samples · ${Math.round(clustered.winRate)}% wins`
        : "No cluster sample"
    ),
    check(
      "Blacklist",
      !exactBlacklisted && !clusterBlacklisted,
      exactBlacklisted
        ? "Exact pattern blocked"
        : clusterBlacklisted
          ? "Cluster blocked"
          : "Clear"
    ),
    check(
      "Loss protection",
      !protectionPaused,
      protectionPaused
        ? "Paused after consecutive losses"
        : `${recentLossStreak} recent losses`
    ),
    check(
      "Adaptive confirm",
      consecutiveDirection >= requiredConsecutive,
      `${consecutiveDirection}/${requiredConsecutive} aligned`
    ),
    check(
      "Bayesian gate",
      selectedBayesian >= bayesianThreshold,
      `${Math.round(selectedBayesian)}% / ${Math.round(bayesianThreshold)}%`
    ),
    check(
      "Reversal gate",
      reversalRisk <= 30,
      `${Math.round(reversalRisk)}% / 30%`
    ),
    check(
      "Learned P/L",
      learnedProfitQualified,
      learned.sample
        ? `${learned.profit >= 0 ? "+" : ""}${learned.profit.toFixed(2)}`
        : "Learning sample"
    ),
    check(
      "Cluster P/L",
      clusterProfitQualified,
      clustered.sample
        ? `${clustered.profit >= 0 ? "+" : ""}${clustered.profit.toFixed(2)}`
        : "Learning cluster"
    ),
    check(
      "Expected value",
      expectedValue >= evThreshold,
      `${expectedValue >= 0 ? "+" : ""}${expectedValue.toFixed(3)} / +${evThreshold.toFixed(3)}`
    ),
    check(
      "Direction stability",
      stabilityQualified,
      `${Math.round(directionStability)}% / 62%`
    ),
    check(
      "Signal freshness",
      signalFresh,
      signalFresh
        ? "Fresh"
        : "Stale or momentum decaying"
    ),
  ];

  const passedChecks = checks.filter(
    (item) => item.passed
  ).length;

  const buyQualified =
    !protectionPaused &&
    !hardBlock &&
    adaptiveMarketGate &&
    trendAligned &&
    directionStrong &&
    probability >= 74 &&
    confidence >= 84 &&
    passedChecks >= 15 &&
    confirmQualified &&
    memoryQualified;

  const prepareQualified =
    !hardBlock &&
    regime === "TREND" &&
    trendContract !== "NONE" &&
    confidence >= 72 &&
    probability >= 66 &&
    passedChecks >= 8;

  const watchQualified =
    regime === "TREND" &&
    trendContract !== "NONE" &&
    confidence >= 58;

  const decision = buyQualified
    ? "BUY"
    : hardBlock && confidence < 58
      ? "SKIP"
      : "WAIT";

  const confirmStage =
    prepareQualified &&
    !buyQualified &&
    confirmQualified;

  const armedQualified =
    signalFresh &&
    !protectionPaused &&
    !hardBlock &&
    regime === "TREND" &&
    selectedBayesian >= bayesianThreshold &&
    transition.probability >= transitionThreshold &&
    expectedValue >= evThreshold &&
    directionStability >= 55 &&
    reversalRisk <= 34 &&
    confidence >= 78 &&
    probability >= 68;

  const stage = protectionPaused
    ? "PROTECTION"
    : buyQualified
      ? "BUY"
      : armedQualified
        ? "ARMED"
        : confirmStage
          ? "CONFIRM"
          : prepareQualified
            ? "PREPARE"
            : watchQualified
              ? "WATCH"
              : "SCAN";

  const risk =
    volatility === "HIGH" ||
    entropy > 97
      ? "HIGH"
      : buyQualified &&
          confidence >= 84 &&
          probability >= 72
        ? "LOW"
        : confidence >= 65
          ? "MEDIUM"
          : "HIGH";

  const reasons = checks.map((item) =>
    `${item.passed ? "✓" : "✗"} ${item.label}: ${item.detail}`
  );

  const reason =
    protectionPaused
      ? `Trading paused after ${recentLossStreak} consecutive losses`
      : buyQualified
        ? `${trendContract} entry confirmed by ${passedChecks}/19 filters`
      : regime === "RANGE"
        ? `${trendContract} blocked because market regime is RANGE`
        : exactBlacklisted
          ? `${trendContract} exact pattern is blacklisted`
          : clusterBlacklisted
            ? `${trendContract} pattern cluster is blacklisted`
            : !memoryQualified
              ? `${trendContract} blocked by weak historical pattern memory`
        : selectedBayesian < bayesianThreshold
          ? `${trendContract} blocked because Bayesian score is below adaptive ${Math.round(bayesianThreshold)}%`
          : transition.probability < transitionThreshold
            ? `${trendContract} blocked because transition is below adaptive ${Math.round(transitionThreshold)}%`
            : reversalRisk > 30
              ? `${trendContract} blocked because reversal risk is above 30%`
              : expectedValue < evThreshold
                ? `${trendContract} blocked because expected value is below adaptive +${evThreshold.toFixed(3)}`
                : !stabilityQualified
                  ? `${trendContract} blocked because direction stability is below 62%`
                  : !signalFresh
                    ? `${trendContract} blocked because the signal is stale or momentum is decaying`
                    : !learnedProfitQualified
                  ? `${trendContract} blocked by negative learned pattern P/L`
                  : !clusterProfitQualified
                    ? `${trendContract} blocked by negative cluster P/L`
                    : confirmStage
        ? `${trendContract} setup confirmed; waiting execution gate`
        : prepareQualified
          ? `${trendContract} setup is preparing; one more confirmation needed`
        : watchQualified
          ? `${trendContract} direction detected but confirmation is incomplete`
          : trendContract === "NONE"
            ? "No clean direction yet"
            : volatility === "HIGH"
              ? "Volatility is too high"
              : "Scanning for a stronger setup";


  const setupCandidates = [
    {
      id: "TICK_SEQUENCE",
      label: `Tick sequence · ${tickSequence.setup}`,
      contract: tickSequence.direction,
      passed:
        tickSequence.qualified &&
        signalFresh &&
        reversalRisk <= 38,
      score: clamp(
        tickSequence.score * 0.62 +
          tickSequence.consensus * 0.23 +
          tickSequence.dominance * 0.15,
        0,
        100
      ),
    },
    {
      id: "TREND_CONTINUATION",
      label: "Trend continuation",
      contract: trendContract,
      passed:
        regime === "TREND" &&
        Math.abs(momentum) >= 5 &&
        directionStability >= 62 &&
        transition.probability >= transitionThreshold &&
        reversalRisk <= 30 &&
        signalFresh,
      score: clamp(
        confidence * 0.30 +
          probability * 0.25 +
          directionStability * 0.25 +
          transition.probability * 0.20,
        0,
        100
      ),
    },
    {
      id: "MOMENTUM_BREAKOUT",
      label: "Momentum breakout",
      contract: momentum > 0 ? "RISE" : momentum < 0 ? "FALL" : "NONE",
      passed:
        regime === "TREND" &&
        Math.abs(momentum) >= 8 &&
        selectedBayesian >= bayesianThreshold - 4 &&
        reversalRisk <= 28 &&
        signalFresh,
      score: clamp(
        Math.abs(momentum) * 4 +
          selectedBayesian * 0.25 +
          directionStability * 0.30,
        0,
        100
      ),
    },
    {
      id: "TRANSITION_EDGE",
      label: "Transition edge",
      contract: transition.direction,
      passed:
        transition.direction !== "NONE" &&
        transition.probability >= transitionThreshold + 3 &&
        selectedBayesian >= bayesianThreshold &&
        reversalRisk <= 26 &&
        signalFresh,
      score: clamp(
        transition.probability * 0.40 +
          selectedBayesian * 0.30 +
          probability * 0.30,
        0,
        100
      ),
    },
    {
      id: "LOW_REVERSAL_PULL",
      label: "Low-reversal pull",
      contract: trendContract,
      passed:
        regime === "TREND" &&
        reversalRisk <= 18 &&
        directionStability >= 58 &&
        probability >= 70 &&
        expectedValue >= evThreshold &&
        signalFresh,
      score: clamp(
        (100 - reversalRisk) * 0.35 +
          probability * 0.30 +
          confidence * 0.20 +
          directionStability * 0.15,
        0,
        100
      ),
    },
  ]
    .filter((item) =>
      item.contract === "RISE" || item.contract === "FALL"
    )
    .sort((a, b) => b.score - a.score);

  const passedSetups = setupCandidates.filter(
    (item) => item.passed
  );

  const riseVotes = passedSetups.filter(
    (item) => item.contract === "RISE"
  );

  const fallVotes = passedSetups.filter(
    (item) => item.contract === "FALL"
  );

  const voteDirection =
    riseVotes.length > fallVotes.length
      ? "RISE"
      : fallVotes.length > riseVotes.length
        ? "FALL"
        : tickSequence.direction;

  const directionVotes =
    voteDirection === "RISE"
      ? riseVotes
      : voteDirection === "FALL"
        ? fallVotes
        : [];

  const agreementCount = directionVotes.length;
  const totalPassedVotes = passedSetups.length;

  const agreementPercent =
    totalPassedVotes > 0
      ? (agreementCount / totalPassedVotes) * 100
      : 0;

  const averageSetupScore =
    directionVotes.length
      ? directionVotes.reduce(
          (sum, item) => sum + Number(item.score || 0),
          0
        ) / directionVotes.length
      : 0;

  const tickPressureScore = clamp(
    tickSequence.score * 0.45 +
      tickSequence.consensus * 0.30 +
      tickSequence.dominance * 0.25,
    0,
    100
  );

  const realConfidence = Math.round(
    clamp(
      tickPressureScore * 0.28 +
        averageSetupScore * 0.24 +
        selectedBayesian * 0.14 +
        transition.probability * 0.12 +
        directionStability * 0.12 +
        probability * 0.10,
      1,
      94
    )
  );

  const voteQualified =
    agreementCount >= 3 &&
    agreementPercent >= 60 &&
    tickPressureScore >= 62 &&
    voteDirection !== "NONE";

  const selectedSetup =
    directionVotes[0] ||
    setupCandidates.find((item) => item.passed) ||
    setupCandidates[0] ||
    null;

  return {
    ready: true,
    stage,
    decision,
    contract:
      voteQualified
        ? voteDirection
        : selectedSetup?.passed
          ? selectedSetup.contract
          : trendContract,
    confidence,
    probability: Math.round(probability),
    risk,
    reason,
    reasons,
    checks,
    passedChecks,
    selectedSetup: selectedSetup
      ? {
          id: selectedSetup.id,
          label: selectedSetup.label,
          contract: selectedSetup.contract,
          passed: selectedSetup.passed,
          score: Math.round(selectedSetup.score),
        }
      : null,
    setupCandidates: setupCandidates.map((item) => ({
      id: item.id,
      label: item.label,
      contract: item.contract,
      passed: item.passed,
      score: Math.round(item.score),
    })),
    setupVoting: {
      direction: voteDirection,
      agreementCount,
      totalPassedVotes,
      agreementPercent: Math.round(agreementPercent),
      averageSetupScore: Math.round(averageSetupScore),
      tickPressureScore: Math.round(tickPressureScore),
      realConfidence,
      qualified: voteQualified,
      riseVotes: riseVotes.length,
      fallVotes: fallVotes.length,
    },
    tickSetup: {
      contract: tickSequence.direction,
      score: tickSequence.score,
      consensus: tickSequence.consensus,
      dominance: tickSequence.dominance,
      streak: tickSequence.streak,
      setup: tickSequence.setup,
      targetTicks: tickSequence.targetTicks,
      qualified: tickSequence.qualified,
      windows: tickSequence.windows,
    },
    metrics: {
      momentum: Math.round(momentum),
      trend,
      volatility,
      entropy: Math.round(entropy),
      bayesian: Math.round(selectedBayesian),
      transition: Math.round(
        transition.probability
      ),
      cycle: cycle.length,
      regime,
      reversalRisk: Math.round(reversalRisk),
      consecutiveDirection,
      momentumDecay: momentumDecay ? "YES" : "NO",
      signalAge: recentDirections.length,
      learnedSample: learned.sample,
      learnedWins: learned.wins,
      learnedLosses: learned.losses,
      learnedProfit: Number(learned.profit.toFixed(3)),
      learnedWinRate: Math.round(learned.winRate),
      clusterSample: clustered.sample,
      clusterWinRate: Math.round(clustered.winRate),
      clusterProfit: Number(clustered.profit.toFixed(3)),
      exactBlacklisted,
      clusterBlacklisted,
      calibratedConfidence: confidence,
      recentLossStreak,
      recentLossPenalty,
      requiredConsecutive,
      maximumReversalRisk,
      protectionPaused,
      learnedProfitQualified,
      clusterProfitQualified,
      adaptiveMarketGate,
      armedQualified,
      trendStrength: Math.round(trendStrength),
      bayesianThreshold: Math.round(bayesianThreshold),
      transitionThreshold: Math.round(transitionThreshold),
      evThreshold: Number(evThreshold.toFixed(3)),
      rollingExpectedValue: Number(rollingExpectedValue.toFixed(3)),
      stableDirectionalTicks,
      directionStability: Math.round(directionStability),
      stabilityQualified,
      signalFresh,
      memoryQualified,
      expectedValue: Number(expectedValue.toFixed(3)),
      memorySignature: signature,
      clusterSignature: clusterKey,
    },
  };
}
