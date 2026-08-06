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

export function analyseTicks(ticks = []) {
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
  ];

  const passedChecks = checks.filter(
    (item) => item.passed
  ).length;

  const hardBlock =
    trendContract === "NONE" ||
    volatility === "HIGH" ||
    !entropyAcceptable;

  const buyQualified =
    !hardBlock &&
    trendAligned &&
    directionStrong &&
    probability >= 66 &&
    confidence >= 78 &&
    passedChecks >= 5;

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

  const stage = buyQualified
    ? "BUY"
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
          probability >= 70
        ? "LOW"
        : confidence >= 65
          ? "MEDIUM"
          : "HIGH";

  const reasons = checks.map((item) =>
    `${item.passed ? "✓" : "✗"} ${item.label}: ${item.detail}`
  );

  const reason =
    buyQualified
      ? `${trendContract} entry confirmed by ${passedChecks}/6 filters`
      : prepareQualified
        ? `${trendContract} setup is preparing; one more confirmation needed`
        : watchQualified
          ? `${trendContract} direction detected but confirmation is incomplete`
          : trendContract === "NONE"
            ? "No clean direction yet"
            : volatility === "HIGH"
              ? "Volatility is too high"
              : "Scanning for a stronger setup";

  const regime =
    volatility === "HIGH"
      ? "CHAOTIC"
      : trend === "FLAT"
        ? "RANGE"
        : "TREND";

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
    },
  };
}
