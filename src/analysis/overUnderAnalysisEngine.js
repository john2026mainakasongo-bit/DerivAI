function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function lastDigit(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? Number(digits.at(-1)) : 0;
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

function countsOf(digits) {
  const counts = Array.from({ length: 10 }, () => 0);
  digits.forEach((digit) => {
    if (digit >= 0 && digit <= 9) counts[digit] += 1;
  });
  return counts;
}

function entropy(counts, total) {
  if (!total) return 100;

  const value = counts.reduce((sum, count) => {
    if (!count) return sum;
    const probability = count / total;
    return sum - probability * Math.log2(probability);
  }, 0);

  return clamp((value / Math.log2(10)) * 100);
}

function sideProbability(counts, barrier, side, total) {
  if (!total) return 0;

  const selected =
    side === "OVER"
      ? counts.slice(barrier + 1)
      : counts.slice(0, barrier);

  return (
    (selected.reduce((sum, value) => sum + value, 0) / total) *
    100
  );
}

function naturalProbability(barrier, side) {
  const safeBarrier = Math.max(0, Math.min(9, Number(barrier) || 0));

  return side === "OVER"
    ? ((9 - safeBarrier) / 10) * 100
    : (safeBarrier / 10) * 100;
}

function standardDeviation(values = []) {
  if (!values.length) return 0;
  const mean =
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;
  return Math.sqrt(variance);
}

function windowProbability(digits, barrier, side, size) {
  const window = digits.slice(-size);
  const counts = countsOf(window);
  return sideProbability(counts, barrier, side, window.length);
}

function transitionModel(digits, barrier, side) {
  if (digits.length < 12) {
    return {
      probability: 0,
      samples: 0,
      edge: 0,
    };
  }

  const wins = (digit) =>
    side === "OVER" ? digit > barrier : digit < barrier;

  let samples = 0;
  let matches = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (!wins(digits[index - 1])) continue;
    samples += 1;
    if (wins(digits[index])) matches += 1;
  }

  const probability = samples ? (matches / samples) * 100 : 0;
  const baseline = naturalProbability(barrier, side);

  return {
    probability: clamp(probability),
    samples,
    edge: probability - baseline,
  };
}

function conditionalAfterLatest(digits, barrier, side) {
  if (digits.length < 20) {
    return {
      probability: 0,
      samples: 0,
      edge: 0,
    };
  }

  const latest = digits.at(-1);
  const wins = (digit) =>
    side === "OVER" ? digit > barrier : digit < barrier;

  let samples = 0;
  let matches = 0;

  for (let index = 0; index < digits.length - 1; index += 1) {
    if (digits[index] !== latest) continue;
    samples += 1;
    if (wins(digits[index + 1])) matches += 1;
  }

  const probability = samples ? (matches / samples) * 100 : 0;
  const baseline = naturalProbability(barrier, side);

  return {
    probability: clamp(probability),
    samples,
    edge: probability - baseline,
  };
}

function streakPenalty(digits, barrier, side) {
  const wins = (digit) =>
    side === "OVER" ? digit > barrier : digit < barrier;

  let streak = 0;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (!wins(digits[index])) break;
    streak += 1;
  }

  return Math.min(10, Math.max(0, streak - 2) * 2.5);
}

function winningDigitsFor(barrier, side) {
  if (side === "OVER") {
    return Array.from(
      { length: Math.max(0, 9 - Number(barrier)) },
      (_, index) => Number(barrier) + index + 1
    );
  }

  return Array.from(
    { length: Math.max(0, Number(barrier)) },
    (_, index) => index
  );
}

function avoidDigitsFor(barrier, side) {
  const winning = new Set(winningDigitsFor(barrier, side));

  return Array.from({ length: 10 }, (_, digit) => digit).filter(
    (digit) => !winning.has(digit)
  );
}

function buildCandidate(digits, counts, entropyScore, barrier, side) {
  const total = digits.length;
  const baseline = naturalProbability(barrier, side);
  const fullProbability = sideProbability(
    counts,
    barrier,
    side,
    total
  );

  const probability30 = windowProbability(
    digits,
    barrier,
    side,
    30
  );
  const probability60 = windowProbability(
    digits,
    barrier,
    side,
    60
  );
  const probability120 = windowProbability(
    digits,
    barrier,
    side,
    120
  );

  const windows = [
    fullProbability,
    probability30,
    probability60,
    probability120,
  ];

  const conservativeProbability = Math.min(...windows);
  const probabilityEdge = conservativeProbability - baseline;
  const spread = standardDeviation(windows);
  const consistency = clamp(100 - spread * 8);

  const exactRisk = total
    ? (counts[barrier] / total) * 100
    : 100;

  const transition = transitionModel(
    digits,
    barrier,
    side
  );

  const latestCondition = conditionalAfterLatest(
    digits,
    barrier,
    side
  );

  const penalty =
    streakPenalty(digits, barrier, side) +
    Math.max(0, entropyScore - 92) * 1.6 +
    Math.max(0, spread - 4) * 2;

  const score = clamp(
    46 +
      probabilityEdge * 3.1 +
      Math.max(0, transition.edge) * 1.15 +
      Math.max(0, latestCondition.edge) * 0.75 +
      consistency * 0.12 +
      Math.min(8, transition.samples / 5) +
      Math.min(6, latestCondition.samples / 3) -
      exactRisk * 0.35 -
      penalty
  );

  const autoEligible =
    barrier >= 2 &&
    barrier <= 6 &&
    total >= 120 &&
    probabilityEdge >= 2.5 &&
    transition.edge >= 1 &&
    consistency >= 68 &&
    exactRisk <= 15 &&
    entropyScore <= 96 &&
    score >= 67;

  return {
    side,
    barrier,
    contract: `${side} ${barrier}`,
    winningDigits: winningDigitsFor(barrier, side),
    avoidDigits: avoidDigitsFor(barrier, side),
    probability: conservativeProbability,
    observedProbability: fullProbability,
    baselineProbability: baseline,
    probabilityEdge,
    transitionScore: transition.probability,
    transitionEdge: transition.edge,
    transitionSamples: transition.samples,
    conditionalProbability: latestCondition.probability,
    conditionalEdge: latestCondition.edge,
    conditionalSamples: latestCondition.samples,
    consistency,
    exactRisk,
    entropy: entropyScore,
    score,
    autoEligible,
  };
}

export function analyzeOverUnder(prices = []) {
  const values = normalizePrices(prices).slice(-300);
  const digits = values.map(lastDigit);
  const counts = countsOf(digits);
  const total = digits.length;
  const entropyScore = entropy(counts, total);

  const candidates = [];

  for (let barrier = 1; barrier <= 7; barrier += 1) {
    candidates.push(
      buildCandidate(
        digits,
        counts,
        entropyScore,
        barrier,
        "OVER"
      )
    );

    candidates.push(
      buildCandidate(
        digits,
        counts,
        entropyScore,
        barrier,
        "UNDER"
      )
    );
  }

  candidates.sort((left, right) => {
    if (left.autoEligible !== right.autoEligible) {
      return Number(right.autoEligible) - Number(left.autoEligible);
    }

    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return right.probabilityEdge - left.probabilityEdge;
  });

  const best =
    candidates.find((candidate) => candidate.autoEligible) ||
    candidates[0] || {
      side: "WAIT",
      barrier: 2,
      probability: 0,
      observedProbability: 0,
      baselineProbability: 0,
      probabilityEdge: 0,
      transitionScore: 0,
      transitionEdge: 0,
      transitionSamples: 0,
      conditionalProbability: 0,
      conditionalEdge: 0,
      conditionalSamples: 0,
      consistency: 0,
      exactRisk: 100,
      entropy: 100,
      score: 0,
      autoEligible: false,
    };

  const confidence = clamp(
    best.score * 0.55 +
      best.consistency * 0.2 +
      Math.max(0, best.probabilityEdge) * 2.2 +
      Math.min(10, best.transitionSamples / 3)
  );

  const quality = clamp(
    best.score * 0.62 +
      confidence * 0.25 +
      Math.max(0, 96 - entropyScore) * 0.5
  );

  const risk =
    best.exactRisk > 15 ||
    entropyScore > 96 ||
    best.consistency < 65
      ? "HIGH"
      : best.exactRisk > 11 ||
          entropyScore > 92 ||
          best.consistency < 75
        ? "MEDIUM"
        : "LOW";

  const tradeNow =
    Boolean(best.autoEligible) &&
    confidence >= 68 &&
    quality >= 64 &&
    best.side !== "WAIT";

  const prepare =
    !tradeNow &&
    total >= 90 &&
    best.score >= 60 &&
    best.probabilityEdge >= 1.5;

  return {
    total,
    digits,
    recentDigits: digits.slice(-30),
    counts,
    latestDigit: digits.at(-1) ?? 0,
    entropy: entropyScore,
    candidates,
    best,
    contract: `${best.side} ${best.barrier}`,
    winningDigits: Array.isArray(best.winningDigits)
      ? best.winningDigits
      : winningDigitsFor(best.barrier, best.side),
    avoidDigits: Array.isArray(best.avoidDigits)
      ? best.avoidDigits
      : avoidDigitsFor(best.barrier, best.side),
    confidence,
    quality,
    risk,
    tradeNow,
    prepare,
    decision: tradeNow
      ? `BUY ${best.side} ${best.barrier}`
      : prepare
        ? `PREPARE ${best.side} ${best.barrier}`
        : "SCANNING OVER + UNDER",
    grade:
      tradeNow && quality >= 82
        ? "A"
        : tradeNow && quality >= 72
          ? "B"
          : prepare
            ? "C"
            : "WAIT",
    waitDigits: [0, 1, 2],
    triggerDigits: [0, 1, 2],
    reason: tradeNow
      ? `${best.side} ${best.barrier} qualified · edge ${best.probabilityEdge.toFixed(1)} · score ${best.score.toFixed(1)}.`
      : prepare
        ? `${best.side} ${best.barrier} is forming · edge ${best.probabilityEdge.toFixed(1)}.`
        : "Comparing every OVER and UNDER barrier from live Deriv ticks.",
    rows: Array.from({ length: 7 }, (_, index) => {
      const barrier = index + 1;

      return {
        barrier,
        over: sideProbability(
          counts,
          barrier,
          "OVER",
          total
        ),
        under: sideProbability(
          counts,
          barrier,
          "UNDER",
          total
        ),
        exact: total
          ? (counts[barrier] / total) * 100
          : 0,
      };
    }),
  };
}

export default analyzeOverUnder;
