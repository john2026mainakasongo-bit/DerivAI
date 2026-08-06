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

  const recentLossStreak = Math.max(
    0,
    Number(riskContext?.recentLossStreak || 0)
  );
  const protectionPaused = Boolean(
    riskContext?.protectionPaused
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
        transition.probability >= 56,
      `${Math.round(
        transition.probability
      )}% ${transition.direction}`
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
      "Expected value",
      expectedValue > 0,
      `${expectedValue >= 0 ? "+" : ""}${expectedValue.toFixed(3)}`
    ),
  ];

  const passedChecks = checks.filter(
    (item) => item.passed
  ).length;

  const buyQualified =
    !protectionPaused &&
    !hardBlock &&
    trendAligned &&
    directionStrong &&
    probability >= 72 &&
    confidence >= 84 &&
    passedChecks >= 5 &&
    confirmQualified &&
    memoryQualified &&
    expectedValue > 0;

  const prepareQualified =
    !hardBlock &&
    trendContract !== "NONE" &&
    confidence >= 67 &&
    probability >= 60 &&
    passedChecks >= 4;

  const watchQualified =
    trendContract !== "NONE" &&
    confidence >= 55;

  const decision = buyQualified
    ? "BUY"
    : hardBlock && confidence < 58
      ? "SKIP"
      : "WAIT";

  const confirmStage =
    prepareQualified &&
    !buyQualified &&
    confirmQualified;

  const stage = protectionPaused
    ? "PROTECTION"
    : buyQualified
      ? "BUY"
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
        ? `${trendContract} entry confirmed by ${passedChecks}/13 filters`
      : regime === "RANGE"
        ? `${trendContract} blocked because market regime is RANGE`
        : exactBlacklisted
          ? `${trendContract} exact pattern is blacklisted`
          : clusterBlacklisted
            ? `${trendContract} pattern cluster is blacklisted`
            : !memoryQualified
              ? `${trendContract} blocked by weak historical pattern memory`
        : expectedValue <= 0
          ? `${trendContract} blocked because expected value is not positive`
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

  return {
    ready: true,
    stage,
    decision,
    contract: trendContract,
    confidence,
    probability: Math.round(probability),
    risk,
    reason,
    reasons,
    checks,
    passedChecks,
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
      memoryQualified,
      expectedValue: Number(expectedValue.toFixed(3)),
      memorySignature: signature,
      clusterSignature: clusterKey,
    },
  };
}
