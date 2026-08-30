function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function digitFromPrice(value) {
  const text = String(value ?? "").replace(/\D/g, "");
  return text ? Number(text.at(-1)) : 0;
}

function normalizePrices(prices = []) {
  return (Array.isArray(prices) ? prices : [])
    .map((item) =>
      typeof item === "number"
        ? item
        : Number(item?.quote ?? item?.price ?? item?.value ?? item?.tick ?? 0)
    )
    .filter(Number.isFinite);
}

function percent(count, total) {
  return total > 0 ? (count / total) * 100 : 0;
}

function contractKey(side, barrier) {
  return `${String(side || "").toUpperCase()}-${Number(barrier)}`;
}

function naturalProbability(side, barrier) {
  return side === "OVER"
    ? ((9 - Number(barrier)) / 10) * 100
    : (Number(barrier) / 10) * 100;
}

function winsContract(digit, side, barrier) {
  return side === "OVER" ? digit > barrier : digit < barrier;
}

function probabilityFor(digits, side, barrier) {
  return percent(
    digits.filter((digit) => winsContract(digit, side, barrier)).length,
    digits.length
  );
}

function transitionProbability(digits, side, barrier) {
  if (digits.length < 12) return 0;

  let samples = 0;
  let winsAfter = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (!winsContract(digits[index - 1], side, barrier)) continue;
    samples += 1;
    if (winsContract(digits[index], side, barrier)) winsAfter += 1;
  }

  return percent(winsAfter, samples);
}

function exactRisk(digits, barrier) {
  return percent(
    digits.filter((digit) => digit === barrier).length,
    digits.length
  );
}

function directionPressure(digits, side, barrier) {
  if (digits.length < 8) return 0;

  const recent = digits.slice(-12);
  let pressure = 0;

  for (let index = 1; index < recent.length; index += 1) {
    const previous = recent[index - 1];
    const current = recent[index];

    if (side === "OVER") {
      if (current > previous && current > barrier) pressure += 1;
      if (current <= barrier) pressure -= 0.6;
    } else {
      if (current < previous && current < barrier) pressure += 1;
      if (current >= barrier) pressure -= 0.6;
    }
  }

  return clamp(50 + pressure * 5, 0, 100);
}

function streakPenalty(recentContracts, key) {
  const normalized = (Array.isArray(recentContracts) ? recentContracts : [])
    .map((item) =>
      typeof item === "string"
        ? item.toUpperCase().replace(/\s+/g, "-")
        : contractKey(item?.side, item?.barrier)
    );

  const recentFive = normalized.slice(-5);
  const uses = recentFive.filter((item) => item === key).length;

  let consecutive = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index] !== key) break;
    consecutive += 1;
  }

  return {
    uses,
    consecutive,
    penalty: uses * 4.5 + Math.max(0, consecutive - 1) * 12,
  };
}

function scoreCandidate(digits, side, barrier, context = {}) {
  const historical = digits.slice(-200);
  const medium = digits.slice(-60);
  const fast = digits.slice(-24);
  const trigger = digits.slice(-8);

  const baseline = naturalProbability(side, barrier);
  const historicalProbability = probabilityFor(historical, side, barrier);
  const mediumProbability = probabilityFor(medium, side, barrier);
  const fastProbability = probabilityFor(fast, side, barrier);
  const triggerProbability = probabilityFor(trigger, side, barrier);
  const transition = transitionProbability(historical.slice(-100), side, barrier);
  const risk = exactRisk(historical, barrier);
  const pressure = directionPressure(digits, side, barrier);

  const probabilityEdge = historicalProbability - baseline;
  const mediumEdge = mediumProbability - baseline;
  const fastEdge = fastProbability - baseline;
  const triggerEdge = triggerProbability - baseline;
  const transitionEdge = transition - baseline;

  const consistency =
    100 -
    Math.min(
      100,
      Math.abs(historicalProbability - mediumProbability) * 1.4 +
        Math.abs(mediumProbability - fastProbability) * 1.2 +
        Math.abs(fastProbability - triggerProbability)
    );

  const key = contractKey(side, barrier);
  const rotation = streakPenalty(context.recentContracts, key);
  const blocked = new Set(
    (Array.isArray(context.blockedContracts) ? context.blockedContracts : [])
      .map((item) => String(item).toUpperCase().replace(/\s+/g, "-"))
  ).has(key);

  /*
   * This is an edge score, not a raw probability score.
   * OVER 1 no longer wins just because its natural probability is already high.
   */
  const expectedEdge =
    probabilityEdge * 0.28 +
    mediumEdge * 0.18 +
    fastEdge * 0.2 +
    triggerEdge * 0.12 +
    transitionEdge * 0.14 +
    (pressure - 50) * 0.05 +
    (consistency - 50) * 0.03;

  const quality = clamp(
    50 +
      expectedEdge * 3.2 +
      (consistency - 50) * 0.16 -
      Math.max(0, risk - 10) * 1.6 -
      rotation.penalty -
      (blocked ? 100 : 0)
  );

  return {
    key,
    side,
    barrier,
    naturalProbability: baseline,
    probability: historicalProbability,
    mediumProbability,
    fastProbability,
    triggerProbability,
    probabilityEdge,
    transition,
    transitionEdge,
    exactRisk: risk,
    pressure,
    consistency,
    expectedEdge,
    rotationPenalty: rotation.penalty,
    recentUses: rotation.uses,
    consecutiveUses: rotation.consecutive,
    blocked,
    score: quality,
  };
}

export function buildTargetTenDecision(prices = [], settings = {}) {
  const values = normalizePrices(prices);
  const digits = values.map(digitFromPrice);
  const currentDigit = digits.at(-1) ?? 0;

  const context = {
    recentContracts: settings.recentContracts,
    blockedContracts: settings.blockedContracts,
  };

  const candidates = [];

  for (const barrier of [1, 2, 3, 4, 5, 6, 7]) {
    candidates.push(scoreCandidate(digits, "OVER", barrier, context));
    candidates.push(scoreCandidate(digits, "UNDER", barrier, context));
  }

  candidates.sort((left, right) => {
    if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
    if (right.expectedEdge !== left.expectedEdge) {
      return right.expectedEdge - left.expectedEdge;
    }
    return right.score - left.score;
  });

  const best = candidates[0] || {
    key: "WAIT-1",
    side: "WAIT",
    barrier: 1,
    naturalProbability: 0,
    probability: 0,
    mediumProbability: 0,
    fastProbability: 0,
    triggerProbability: 0,
    probabilityEdge: 0,
    transition: 0,
    transitionEdge: 0,
    exactRisk: 100,
    pressure: 0,
    consistency: 0,
    expectedEdge: -100,
    rotationPenalty: 0,
    recentUses: 0,
    consecutiveUses: 0,
    blocked: false,
    score: 0,
  };

  const minimumSamples = Number(settings.minimumSamples ?? 120);
  const minimumScore = Number(settings.minimumScore ?? 76);
  const minimumEdge = Number(settings.minimumEdge ?? 2.5);
  const minimumFastEdge = Number(settings.minimumFastEdge ?? 0.5);
  const minimumTransitionEdge = Number(settings.minimumTransitionEdge ?? -1);
  const minimumConsistency = Number(settings.minimumConsistency ?? 58);
  const maximumExactRisk = Number(settings.maximumExactRisk ?? 15);
  const maximumConsecutiveUses = Number(settings.maximumConsecutiveUses ?? 2);

  const qualified =
    digits.length >= minimumSamples &&
    !best.blocked &&
    best.score >= minimumScore &&
    best.expectedEdge >= minimumEdge &&
    best.fastProbability - best.naturalProbability >= minimumFastEdge &&
    best.transitionEdge >= minimumTransitionEdge &&
    best.consistency >= minimumConsistency &&
    best.exactRisk <= maximumExactRisk &&
    best.consecutiveUses < maximumConsecutiveUses;

  const winningDigits =
    best.side === "OVER"
      ? Array.from(
          { length: Math.max(0, 9 - best.barrier) },
          (_, index) => best.barrier + 1 + index
        )
      : Array.from(
          { length: Math.max(0, best.barrier) },
          (_, index) => index
        );

  const reason = qualified
    ? `${best.side} ${best.barrier} selected: edge ${best.expectedEdge.toFixed(
        1
      )}, score ${best.score.toFixed(1)}, rotation clear.`
    : `Scanning all 14 contracts. Best ${best.side} ${
        best.barrier
      }: edge ${best.expectedEdge.toFixed(1)}/${minimumEdge}, score ${best.score.toFixed(
        1
      )}/${minimumScore}, consistency ${best.consistency.toFixed(
        1
      )}/${minimumConsistency}.`;

  return {
    digits,
    currentDigit,
    candidates,
    best,
    qualified,
    winningDigits,
    reason,
  };
}

export default buildTargetTenDecision;
