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

    return {
      size,
      slope: linearSlope(values),
      normalized:
        values.length >= 3
          ? (linearSlope(values) / current) * 100000
          : 0,
    };
  });

  const positive = slopes.filter((item) => item.normalized > 0.2).length;
  const negative = slopes.filter((item) => item.normalized < -0.2).length;

  const direction =
    positive >= 2
      ? "RISE"
      : negative >= 2
      ? "FALL"
      : "WAIT";

  const agreement = Math.max(positive, negative);
  const averageStrength =
    mean(slopes.map((item) => Math.abs(item.normalized))) || 0;

  return {
    direction,
    agreement,
    score: clamp(agreement * 22 + averageStrength * 8),
    slopes,
    passed: direction !== "WAIT" && agreement >= 2,
    detail: `20/50/100 agreement ${agreement}/3`,
  };
}

function momentum(prices = []) {
  const clean = cleanNumbers(prices).slice(-25);

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
    ? ((last - first) / Math.abs(first)) * 100
    : 0;

  const score = clamp(Math.abs(change) * 1700);

  return {
    direction:
      change > 0
        ? "RISE"
        : change < 0
        ? "FALL"
        : "WAIT",
    score,
    passed: score >= 50,
    detail: `${change >= 0 ? "+" : ""}${change.toFixed(4)}%`,
  };
}

function supportResistance(prices = []) {
  const clean = cleanNumbers(prices).slice(-80);

  if (clean.length < 25) {
    return {
      state: "WAIT",
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
  const range = Math.max(resistance - support, 1e-9);

  const distanceToSupport = (current - support) / range;
  const distanceToResistance = (resistance - current) / range;

  let state = "MID-RANGE";
  let passed = false;
  let score = 0;

  if (distanceToSupport <= 0.12) {
    state = "NEAR SUPPORT";
    passed = true;
    score = clamp((0.12 - distanceToSupport) * 700 + 55);
  } else if (distanceToResistance <= 0.12) {
    state = "NEAR RESISTANCE";
    passed = true;
    score = clamp((0.12 - distanceToResistance) * 700 + 55);
  }

  return {
    state,
    passed,
    score,
    support,
    resistance,
    detail: `${state} · range ${range.toFixed(4)}`,
  };
}

function volatilityRegime(prices = []) {
  const clean = cleanNumbers(prices).slice(-70);

  if (clean.length < 20) {
    return {
      regime: "WAIT",
      score: 0,
      passed: false,
      detail: "Need more prices",
    };
  }

  const changes = [];

  for (let index = 1; index < clean.length; index += 1) {
    const previous = clean[index - 1];

    if (previous) {
      changes.push(
        ((clean[index] - previous) / Math.abs(previous)) * 100
      );
    }
  }

  const deviation = standardDeviation(changes);
  const score = clamp(deviation * 1500);

  const regime =
    score >= 75
      ? "HIGH"
      : score >= 35
      ? "MEDIUM"
      : "LOW";

  return {
    regime,
    score,
    passed: score >= 25 && score <= 90,
    detail: `${regime} volatility`,
  };
}

function digitPressure(digits = []) {
  const clean = (Array.isArray(digits) ? digits : [])
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

  const even = clean.filter((digit) => digit % 2 === 0).length / clean.length;
  const over2 = clean.filter((digit) => digit > 2).length / clean.length;
  const under2 = clean.filter((digit) => digit < 2).length / clean.length;

  const candidates = [
    {
      contract: "EVEN",
      score: Math.max(0, even - 0.5) * 250,
      edge: even - 0.5,
    },
    {
      contract: "ODD",
      score: Math.max(0, 0.5 - even) * 250,
      edge: 0.5 - even,
    },
    {
      contract: "OVER 2",
      score: Math.max(0, over2 - 0.7) * 300,
      edge: over2 - 0.7,
    },
    {
      contract: "UNDER 2",
      score: Math.max(0, under2 - 0.2) * 300,
      edge: under2 - 0.2,
    },
  ].sort((a, b) => b.score - a.score);

  const best = candidates[0];

  return {
    contract: best.contract,
    score: clamp(best.score),
    passed: best.score >= 50,
    detail: `EVEN ${(even * 100).toFixed(0)}% · OVER2 ${(over2 * 100).toFixed(0)}%`,
  };
}

function repeatingPattern(digits = []) {
  const clean = (Array.isArray(digits) ? digits : [])
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
    index <= clean.length - tail.length - 1;
    index += 1
  ) {
    const candidate = clean.slice(index, index + tail.length);

    if (candidate.every((digit, offset) => digit === tail[offset])) {
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

function historyAgreement(validatedSignals = {}) {
  const approved = Array.isArray(validatedSignals.signals)
    ? validatedSignals.signals.filter((signal) => signal.approved)
    : [];

  const best = validatedSignals.best || approved[0] || null;

  return {
    action: best?.action || "WAIT",
    score: clamp(best?.lowerBound || best?.hitRate || 0),
    passed: Boolean(best?.approved),
    detail: best?.approved
      ? `${best.action} · ${Number(best.hitRate || 0).toFixed(1)}% hit rate`
      : "No historical validation",
  };
}

export function buildProfessionalDecision(
  snapshot = {},
  validatedSignals = {}
) {
  const trend = trendAcrossWindows(snapshot.prices);
  const momentumVote = momentum(snapshot.prices);
  const range = supportResistance(snapshot.prices);
  const volatility = volatilityRegime(snapshot.prices);
  const pressure = digitPressure(snapshot.digitHistory);
  const pattern = repeatingPattern(snapshot.digitHistory);
  const history = historyAgreement(validatedSignals);

  const checks = {
    trend,
    momentum: momentumVote,
    supportResistance: range,
    digitPressure: pressure,
    volatility,
    pattern,
    historical: history,
  };

  const passed = Object.values(checks).filter((item) => item.passed);
  const passedCount = passed.length;

  const directionalAgreement = [
    trend.direction,
    momentumVote.direction,
  ].filter((direction) => direction !== "WAIT");

  const direction =
    directionalAgreement.filter((item) => item === "RISE").length >
    directionalAgreement.filter((item) => item === "FALL").length
      ? "RISE"
      : directionalAgreement.filter((item) => item === "FALL").length >
        directionalAgreement.filter((item) => item === "RISE").length
      ? "FALL"
      : "WAIT";

  let setup = "WAIT";

  if (
    history.passed &&
    history.action !== "WAIT"
  ) {
    setup = history.action;
  } else if (
    pressure.passed &&
    pressure.contract !== "WAIT"
  ) {
    setup = pressure.contract;
  } else if (
    trend.passed &&
    momentumVote.passed &&
    direction !== "WAIT"
  ) {
    setup = direction;
  }

  const averageScore =
    mean(
      Object.values(checks).map(
        (item) => Number(item.score || 0)
      )
    ) || 0;

  const confidence = clamp(
    35 +
      passedCount * 7 +
      averageScore * 0.24 +
      (setup !== "WAIT" ? 8 : 0)
  );

  const reasons = [];

  if (trend.passed) reasons.push(`Trend ${trend.direction}`);
  if (momentumVote.passed) reasons.push(`Momentum ${momentumVote.direction}`);
  if (pressure.passed) reasons.push(`Digit pressure ${pressure.contract}`);
  if (history.passed) reasons.push(`History ${history.action}`);
  if (range.passed) reasons.push(range.state);
  if (volatility.passed) reasons.push(`${volatility.regime} volatility`);

  const validated =
    setup !== "WAIT" &&
    passedCount >= 5 &&
    confidence >= 78 &&
    volatility.passed;

  return {
    checks,
    passedCount,
    totalChecks: Object.keys(checks).length,
    setup,
    confidence,
    validated,
    status: validated ? "ENTRY" : "NO TRADE",
    reason:
      reasons.length
        ? reasons.join(" + ")
        : "No strong agreement",
  };
}
