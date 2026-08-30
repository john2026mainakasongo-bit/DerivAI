const WEIGHTS = {
  trend: 22,
  momentum: 18,
  supportResistance: 15,
  volatility: 12,
  historical: 18,
  digitPressure: 10,
  pattern: 5,
};

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function cleanNumbers(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);
}

function mean(values = []) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function standardDeviation(values = []) {
  if (values.length < 2) return 0;

  const average = mean(values);

  return Math.sqrt(
    values.reduce(
      (sum, value) => sum + (value - average) ** 2,
      0
    ) / values.length
  );
}

function linearSlope(values = []) {
  if (values.length < 3) return 0;

  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = mean(values);

  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < n; index += 1) {
    const delta = index - meanX;
    numerator += delta * (values[index] - meanY);
    denominator += delta * delta;
  }

  return denominator ? numerator / denominator : 0;
}

function trendAcrossWindows(prices = []) {
  const clean = cleanNumbers(prices);
  const windows = [20, 50, 100];

  const slopes = windows.map((size) => {
    const values = clean.slice(-size);
    const current = Math.abs(values.at(-1) || 1);
    const slope = linearSlope(values);

    return {
      size,
      slope,
      normalized:
        values.length >= 3
          ? (slope / current) * 100000
          : 0,
    };
  });

  const positive = slopes.filter(
    (item) => item.normalized > 0.2
  ).length;

  const negative = slopes.filter(
    (item) => item.normalized < -0.2
  ).length;

  const direction =
    positive >= 2
      ? "RISE"
      : negative >= 2
      ? "FALL"
      : "WAIT";

  const agreement = Math.max(positive, negative);
  const averageStrength =
    mean(
      slopes.map((item) =>
        Math.abs(item.normalized)
      )
    ) || 0;

  return {
    direction,
    agreement,
    score: clamp(
      agreement * 22 +
        averageStrength * 8
    ),
    slopes,
    passed:
      direction !== "WAIT" &&
      agreement >= 2,
    detail:
      `20/50/100 agreement ${agreement}/3`,
  };
}

function momentum(prices = []) {
  const clean =
    cleanNumbers(prices).slice(-25);

  if (clean.length < 10) {
    return {
      direction: "WAIT",
      score: 0,
      passed: false,
      detail: "Need more prices",
    };
  }

  const first = clean[0];
  const last = clean.at(-1);

  const change = first
    ? ((last - first) /
        Math.abs(first)) *
      100
    : 0;

  const score = clamp(
    Math.abs(change) * 1700
  );

  return {
    direction:
      change > 0
        ? "RISE"
        : change < 0
        ? "FALL"
        : "WAIT",
    score,
    passed: score >= 50,
    detail:
      `${change >= 0 ? "+" : ""}${change.toFixed(4)}%`,
  };
}

function supportResistance(prices = []) {
  const clean =
    cleanNumbers(prices).slice(-80);

  if (clean.length < 25) {
    return {
      state: "WAIT",
      direction: "WAIT",
      score: 0,
      passed: false,
      support: null,
      resistance: null,
      detail: "Need more range data",
    };
  }

  const current = clean.at(-1);
  const support = Math.min(...clean);
  const resistance = Math.max(...clean);
  const range = Math.max(
    resistance - support,
    1e-9
  );

  const distanceToSupport =
    (current - support) / range;

  const distanceToResistance =
    (resistance - current) / range;

  let state = "MID-RANGE";
  let direction = "WAIT";
  let passed = false;
  let score = 20;

  if (distanceToSupport <= 0.12) {
    state = "NEAR SUPPORT";
    direction = "RISE";
    passed = true;
    score = clamp(
      (0.12 - distanceToSupport) *
        700 +
        55
    );
  } else if (
    distanceToResistance <= 0.12
  ) {
    state = "NEAR RESISTANCE";
    direction = "FALL";
    passed = true;
    score = clamp(
      (0.12 - distanceToResistance) *
        700 +
        55
    );
  } else {
    const centerDistance =
      Math.abs(
        distanceToSupport -
          distanceToResistance
      );

    score = clamp(
      25 + centerDistance * 25
    );
  }

  return {
    state,
    direction,
    passed,
    score,
    support,
    resistance,
    detail:
      `${state} · range ${range.toFixed(4)}`,
  };
}

function volatilityRegime(prices = []) {
  const clean =
    cleanNumbers(prices).slice(-70);

  if (clean.length < 20) {
    return {
      regime: "WAIT",
      score: 0,
      rawScore: 0,
      passed: false,
      detail: "Need more prices",
    };
  }

  const changes = [];

  for (
    let index = 1;
    index < clean.length;
    index += 1
  ) {
    const previous = clean[index - 1];

    if (previous) {
      changes.push(
        ((clean[index] - previous) /
          Math.abs(previous)) *
          100
      );
    }
  }

  const deviation =
    standardDeviation(changes);

  const rawScore = clamp(
    deviation * 1500
  );

  const regime =
    rawScore >= 75
      ? "HIGH"
      : rawScore >= 35
      ? "MEDIUM"
      : "LOW";

  /*
   * Medium volatility receives the highest
   * execution-quality score. Very low and very
   * high volatility are treated more cautiously.
   */
  const score =
    regime === "MEDIUM"
      ? clamp(
          100 -
            Math.abs(rawScore - 55) *
              1.4
        )
      : regime === "LOW"
      ? clamp(rawScore * 1.65)
      : clamp(
          100 -
            (rawScore - 75) * 2.4
        );

  return {
    regime,
    score,
    rawScore,
    passed:
      rawScore >= 25 &&
      rawScore <= 90,
    detail:
      `${regime} volatility`,
  };
}

function digitPressure(digits = []) {
  const clean = (
    Array.isArray(digits) ? digits : []
  )
    .map(Number)
    .filter(
      (digit) =>
        Number.isInteger(digit) &&
        digit >= 0 &&
        digit <= 9
    )
    .slice(-40);

  if (clean.length < 20) {
    return {
      contract: "WAIT",
      score: 0,
      passed: false,
      detail: "Need more digits",
    };
  }

  const even =
    clean.filter(
      (digit) => digit % 2 === 0
    ).length / clean.length;

  const over2 =
    clean.filter(
      (digit) => digit > 2
    ).length / clean.length;

  const under2 =
    clean.filter(
      (digit) => digit < 2
    ).length / clean.length;

  const candidates = [
    {
      contract: "EVEN",
      score:
        Math.max(0, even - 0.5) *
        250,
    },
    {
      contract: "ODD",
      score:
        Math.max(0, 0.5 - even) *
        250,
    },
    {
      contract: "OVER 2",
      score:
        Math.max(0, over2 - 0.7) *
        300,
    },
    {
      contract: "UNDER 2",
      score:
        Math.max(0, under2 - 0.2) *
        300,
    },
  ].sort(
    (a, b) => b.score - a.score
  );

  const best = candidates[0];

  return {
    contract: best.contract,
    score: clamp(best.score),
    passed: best.score >= 50,
    detail:
      `EVEN ${(even * 100).toFixed(0)}% · ` +
      `OVER2 ${(over2 * 100).toFixed(0)}%`,
  };
}

function repeatingPattern(digits = []) {
  const clean = (
    Array.isArray(digits) ? digits : []
  )
    .map(Number)
    .filter(Number.isInteger);

  if (clean.length < 40) {
    return {
      pattern: "WAIT",
      score: 0,
      passed: false,
      detail: "Need more history",
    };
  }

  const tail = clean.slice(-4);
  let repeats = 0;

  for (
    let index = 0;
    index <=
    clean.length - tail.length - 1;
    index += 1
  ) {
    const candidate = clean.slice(
      index,
      index + tail.length
    );

    if (
      candidate.every(
        (digit, offset) =>
          digit === tail[offset]
      )
    ) {
      repeats += 1;
    }
  }

  const score = clamp(repeats * 18);

  return {
    pattern: tail.join("-"),
    score,
    passed: repeats >= 3,
    detail: `${repeats} prior repeats`,
  };
}

function historyAgreement(
  validatedSignals = {}
) {
  const approved = Array.isArray(
    validatedSignals.signals
  )
    ? validatedSignals.signals.filter(
        (signal) => signal.approved
      )
    : [];

  const best =
    validatedSignals.best ||
    approved[0] ||
    null;

  return {
    action: best?.action || "WAIT",
    score: clamp(
      best?.lowerBound ||
        best?.hitRate ||
        0
    ),
    passed: Boolean(best?.approved),
    samples: Number(best?.samples || 0),
    detail: best?.approved
      ? `${best.action} · ${Number(
          best.hitRate || 0
        ).toFixed(1)}% hit rate`
      : "No historical validation",
  };
}

function component(
  key,
  label,
  check
) {
  const weight = WEIGHTS[key];
  const rawScore = clamp(
    check?.score || 0
  );

  return {
    key,
    label,
    weight,
    rawScore,
    weightedScore:
      (rawScore * weight) / 100,
    passed: Boolean(check?.passed),
    detail:
      check?.detail ||
      "No detail",
  };
}

function candidateScores(checks) {
  const scores = new Map();

  const add = (
    setup,
    score,
    source
  ) => {
    if (
      !setup ||
      setup === "WAIT" ||
      !Number.isFinite(Number(score))
    ) {
      return;
    }

    const current =
      scores.get(setup) || {
        setup,
        score: 0,
        sources: [],
      };

    current.score += Number(score);
    current.sources.push(source);
    scores.set(setup, current);
  };

  if (checks.historical.passed) {
    add(
      checks.historical.action,
      checks.historical.score * 0.45,
      "historical"
    );
  }

  if (checks.digitPressure.passed) {
    add(
      checks.digitPressure.contract,
      checks.digitPressure.score * 0.38,
      "digit-pressure"
    );
  }

  if (checks.trend.passed) {
    add(
      checks.trend.direction,
      checks.trend.score * 0.28,
      "trend"
    );
  }

  if (checks.momentum.passed) {
    add(
      checks.momentum.direction,
      checks.momentum.score * 0.24,
      "momentum"
    );
  }

  if (
    checks.supportResistance.passed
  ) {
    add(
      checks.supportResistance.direction,
      checks.supportResistance.score *
        0.18,
      "support-resistance"
    );
  }

  return [...scores.values()].sort(
    (a, b) => b.score - a.score
  );
}

function dataSufficiency(
  snapshot,
  history
) {
  const priceCount = cleanNumbers(
    snapshot?.prices
  ).length;

  const digitCount = (
    Array.isArray(
      snapshot?.digitHistory
    )
      ? snapshot.digitHistory
      : []
  ).length;

  const priceScore = clamp(
    (priceCount / 100) * 100
  );

  const digitScore = clamp(
    (digitCount / 40) * 100
  );

  const historyScore = history.passed
    ? clamp(
        60 +
          Math.min(
            40,
            history.samples * 0.5
          )
      )
    : 20;

  return clamp(
    priceScore * 0.45 +
      digitScore * 0.35 +
      historyScore * 0.2
  );
}

function conflictPenalty(checks) {
  let penalty = 0;

  if (
    checks.trend.direction !== "WAIT" &&
    checks.momentum.direction !== "WAIT" &&
    checks.trend.direction !==
      checks.momentum.direction
  ) {
    penalty += 12;
  }

  if (
    checks.historical.passed &&
    checks.digitPressure.passed &&
    checks.historical.action !==
      checks.digitPressure.contract
  ) {
    penalty += 8;
  }

  if (
    checks.supportResistance.passed &&
    checks.trend.passed &&
    checks.supportResistance.direction !==
      checks.trend.direction
  ) {
    penalty += 6;
  }

  if (!checks.volatility.passed) {
    penalty += 10;
  }

  return penalty;
}

function marketState(checks) {
  if (
    checks.volatility.regime === "HIGH"
  ) {
    return "VOLATILE";
  }

  if (
    checks.trend.passed &&
    checks.momentum.passed &&
    checks.trend.direction ===
      checks.momentum.direction
  ) {
    return "TRENDING";
  }

  if (
    checks.supportResistance.passed
  ) {
    return checks.supportResistance.state;
  }

  if (
    checks.volatility.regime === "LOW"
  ) {
    return "QUIET";
  }

  return "CHOPPY";
}

export function buildProfessionalDecision(
  snapshot = {},
  validatedSignals = {}
) {
  const trend =
    trendAcrossWindows(snapshot.prices);

  const momentumVote =
    momentum(snapshot.prices);

  const range =
    supportResistance(snapshot.prices);

  const volatility =
    volatilityRegime(snapshot.prices);

  const pressure =
    digitPressure(
      snapshot.digitHistory
    );

  const pattern =
    repeatingPattern(
      snapshot.digitHistory
    );

  const history =
    historyAgreement(
      validatedSignals
    );

  const checks = {
    trend,
    momentum: momentumVote,
    supportResistance: range,
    volatility,
    historical: history,
    digitPressure: pressure,
    pattern,
  };

  const components = [
    component(
      "trend",
      "Trend",
      trend
    ),
    component(
      "momentum",
      "Momentum",
      momentumVote
    ),
    component(
      "supportResistance",
      "Support / Resistance",
      range
    ),
    component(
      "volatility",
      "Volatility",
      volatility
    ),
    component(
      "historical",
      "Historical",
      history
    ),
    component(
      "digitPressure",
      "Digit pressure",
      pressure
    ),
    component(
      "pattern",
      "Pattern",
      pattern
    ),
  ];

  const passedCount =
    components.filter(
      (item) => item.passed
    ).length;

  const candidates =
    candidateScores(checks);

  const best =
    candidates[0] || null;

  const setup =
    best && best.score >= 30
      ? best.setup
      : "WAIT";

  const baseWeightedScore =
    components.reduce(
      (sum, item) =>
        sum + item.weightedScore,
      0
    );

  const penalty =
    conflictPenalty(checks);

  const setupBonus =
    setup !== "WAIT"
      ? Math.min(
          8,
          (best?.sources.length || 0) * 2
        )
      : 0;

  const professionalScore = clamp(
    baseWeightedScore -
      penalty +
      setupBonus
  );

  const sufficiency =
    dataSufficiency(
      snapshot,
      history
    );

  const marketQuality = clamp(
    professionalScore * 0.78 +
      sufficiency * 0.22
  );

  const state =
    marketState(checks);

  const riskLevel =
    !volatility.passed ||
    professionalScore < 65 ||
    penalty >= 15
      ? "HIGH"
      : professionalScore < 82 ||
        marketQuality < 80 ||
        state === "CHOPPY"
      ? "MEDIUM"
      : "LOW";

  const validated =
    setup !== "WAIT" &&
    professionalScore >= 72 &&
    marketQuality >= 65 &&
    passedCount >= 3 &&
    volatility.passed &&
    riskLevel !== "HIGH";

  const reasons = components
    .filter((item) => item.passed)
    .map(
      (item) =>
        `${item.label} ${item.rawScore.toFixed(0)}`
    );

  return {
    checks,
    components,
    candidates,
    passedCount,
    totalChecks:
      components.length,
    setup,
    bestContract: setup,
    confidence:
      professionalScore,
    professionalScore,
    marketQuality,
    marketState: state,
    riskLevel,
    expectedRR: null,
    expectedRRLabel:
      "Available after Deriv proposal",
    dataSufficiency: sufficiency,
    conflictPenalty: penalty,
    validated,
    status:
      validated
        ? "TRADE"
        : "NO TRADE",
    reason:
      reasons.length
        ? reasons.join(" + ")
        : "No strong agreement",
  };
}
