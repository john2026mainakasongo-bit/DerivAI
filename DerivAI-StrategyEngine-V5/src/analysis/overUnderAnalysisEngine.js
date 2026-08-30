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

  for (const digit of digits) {
    if (digit >= 0 && digit <= 9) counts[digit] += 1;
  }

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
  return side === "OVER"
    ? ((9 - barrier) / 10) * 100
    : (barrier / 10) * 100;
}

function transition(digits, barrier, side) {
  if (digits.length < 12) return 0;

  const qualifies = (digit) =>
    side === "OVER" ? digit > barrier : digit < barrier;

  let samples = 0;
  let matches = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (!qualifies(digits[index - 1])) continue;

    samples += 1;

    if (qualifies(digits[index])) {
      matches += 1;
    }
  }

  return samples ? clamp((matches / samples) * 100) : 0;
}

function scoreWindow(digits, barrier, side) {
  const counts = countsOf(digits);
  const total = digits.length;
  const probability = sideProbability(counts, barrier, side, total);
  const baseline = naturalProbability(barrier, side);
  const edge = probability - baseline;

  return {
    probability,
    edge,
    exactRisk: total ? (counts[barrier] / total) * 100 : 100,
    transition: transition(digits, barrier, side),
  };
}

function agreementScore(values) {
  const valid = values.filter(Number.isFinite);

  if (valid.length < 2) return 0;

  const average =
    valid.reduce((sum, value) => sum + value, 0) / valid.length;

  const deviation =
    valid.reduce((sum, value) => sum + Math.abs(value - average), 0) /
    valid.length;

  return clamp(100 - deviation * 3.5);
}

export function analyzeOverUnder(prices = []) {
  const values = normalizePrices(prices).slice(-240);
  const digits = values.map(lastDigit);
  const total = digits.length;

  const longDigits = digits.slice(-180);
  const mediumDigits = digits.slice(-90);
  const fastDigits = digits.slice(-36);
  const triggerDigits = digits.slice(-14);

  const counts = countsOf(longDigits);
  const entropyScore = entropy(counts, longDigits.length);
  const candidates = [];

  for (let barrier = 1; barrier <= 7; barrier += 1) {
    for (const side of ["OVER", "UNDER"]) {
      const long = scoreWindow(longDigits, barrier, side);
      const medium = scoreWindow(mediumDigits, barrier, side);
      const fast = scoreWindow(fastDigits, barrier, side);
      const trigger = scoreWindow(triggerDigits, barrier, side);

      const consistency = agreementScore([
        long.probability,
        medium.probability,
        fast.probability,
        trigger.probability,
      ]);

      const edgeAgreement = agreementScore([
        long.edge,
        medium.edge,
        fast.edge,
        trigger.edge,
      ]);

      const transitionEdge =
        long.transition - naturalProbability(barrier, side);

      const compositeEdge =
        long.edge * 0.3 +
        medium.edge * 0.25 +
        fast.edge * 0.27 +
        trigger.edge * 0.18;

      const exactRisk =
        long.exactRisk * 0.5 +
        medium.exactRisk * 0.25 +
        fast.exactRisk * 0.25;

      const score = clamp(
        50 +
          compositeEdge * 3.5 +
          transitionEdge * 0.7 +
          (consistency - 50) * 0.17 +
          (edgeAgreement - 50) * 0.12 -
          Math.max(0, exactRisk - 10) * 1.8 -
          Math.max(0, entropyScore - 88) * 1.7
      );

      candidates.push({
        side,
        barrier,
        probability: long.probability,
        mediumProbability: medium.probability,
        fastProbability: fast.probability,
        triggerProbability: trigger.probability,
        probabilityEdge: compositeEdge,
        transitionEdge,
        consistency,
        edgeAgreement,
        exactRisk,
        score,
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.probabilityEdge - left.probabilityEdge;
  });

  const best = candidates[0] || {
    side: "WAIT",
    barrier: 2,
    probability: 0,
    probabilityEdge: -100,
    transitionEdge: -100,
    consistency: 0,
    exactRisk: 100,
    score: 0,
  };

  const confidence = clamp(
    best.score * 0.55 +
      best.consistency * 0.2 +
      best.edgeAgreement * 0.15 +
      (100 - best.exactRisk) * 0.1
  );

  const quality = clamp(
    best.score * 0.55 +
      confidence * 0.25 +
      best.consistency * 0.12 +
      (100 - entropyScore) * 0.08
  );

  const risk =
    best.exactRisk > 11 ||
    entropyScore > 90 ||
    best.probabilityEdge < 2.5 ||
    best.consistency < 74
      ? "HIGH"
      : best.exactRisk > 8 ||
          entropyScore > 86 ||
          best.probabilityEdge < 4 ||
          best.consistency < 82
        ? "MEDIUM"
        : "LOW";

  const tradeNow =
    total >= 140 &&
    best.score >= 88 &&
    confidence >= 86 &&
    quality >= 84 &&
    best.probabilityEdge >= 4.5 &&
    best.transitionEdge >= 1 &&
    best.consistency >= 82 &&
    best.edgeAgreement >= 78 &&
    best.exactRisk <= 8 &&
    entropyScore <= 86 &&
    risk === "LOW";

  const prepare =
    !tradeNow &&
    total >= 110 &&
    best.score >= 78 &&
    confidence >= 76 &&
    best.probabilityEdge >= 2.5 &&
    best.consistency >= 72 &&
    best.exactRisk <= 11 &&
    entropyScore <= 90;

  return {
    total,
    digits,
    recentDigits: digits.slice(-30),
    counts,
    latestDigit: digits.at(-1) ?? 0,
    entropy: entropyScore,
    candidates,
    best,
    confidence,
    quality,
    risk,
    tradeNow,
    prepare,
    decision: tradeNow
      ? `GOOD ENTRY ${best.side} ${best.barrier}`
      : prepare
        ? `PREPARE ${best.side} ${best.barrier}`
        : "WAIT FOR GOOD ENTRY",
    grade:
      tradeNow && quality >= 90
        ? "A+"
        : tradeNow
          ? "A"
          : prepare
            ? "B"
            : "WAIT",
    reason: tradeNow
      ? `${best.side} ${best.barrier} passed all quality gates · score ${best.score.toFixed(
          1
        )}, edge ${best.probabilityEdge.toFixed(1)}, risk LOW.`
      : prepare
        ? `${best.side} ${best.barrier} is forming, but confirmation is not complete.`
        : `High-risk or weak setup. Waiting. Best score ${best.score.toFixed(
            1
          )}, edge ${best.probabilityEdge.toFixed(1)}, risk ${risk}.`,
    rows: Array.from({ length: 7 }, (_, index) => {
      const barrier = index + 1;

      return {
        barrier,
        over: sideProbability(counts, barrier, "OVER", longDigits.length),
        under: sideProbability(counts, barrier, "UNDER", longDigits.length),
        exact: longDigits.length
          ? (counts[barrier] / longDigits.length) * 100
          : 0,
      };
    }),
  };
}

export default analyzeOverUnder;
