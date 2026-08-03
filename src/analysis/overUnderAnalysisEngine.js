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
    const p = count / total;
    return sum - p * Math.log2(p);
  }, 0);
  return clamp(value / Math.log2(10) * 100);
}

function sideProbability(counts, barrier, side, total) {
  if (!total) return 0;
  const selected =
    side === "OVER"
      ? counts.slice(barrier + 1)
      : counts.slice(0, barrier);
  return selected.reduce((sum, value) => sum + value, 0) / total * 100;
}

function transition(digits, barrier, side) {
  if (digits.length < 3) return 0;
  const qualifies = (digit) =>
    side === "OVER" ? digit > barrier : digit < barrier;

  let samples = 0;
  let matches = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (!qualifies(digits[index - 1])) continue;
    samples += 1;
    if (qualifies(digits[index])) matches += 1;
  }

  return samples ? clamp(matches / samples * 100) : 0;
}

export function analyzeOverUnder(prices = []) {
  const values = normalizePrices(prices).slice(-180);
  const digits = values.map(lastDigit);
  const counts = countsOf(digits);
  const total = digits.length;
  const entropyScore = entropy(counts, total);
  const candidates = [];

  for (let barrier = 1; barrier <= 7; barrier += 1) {
    for (const side of ["OVER", "UNDER"]) {
      const probability = sideProbability(counts, barrier, side, total);
      const exactRisk = total ? counts[barrier] / total * 100 : 0;
      const transitionScore = transition(digits, barrier, side);
      const score = clamp(
        probability * 0.55 +
          transitionScore * 0.2 +
          (100 - exactRisk) * 0.15 +
          (100 - entropyScore) * 0.1
      );

      candidates.push({
        side,
        barrier,
        probability,
        exactRisk,
        transitionScore,
        score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] || {
    side: "WAIT",
    barrier: 2,
    probability: 0,
    exactRisk: 100,
    transitionScore: 0,
    score: 0,
  };

  const confidence = clamp(
    best.probability * 0.58 +
      best.transitionScore * 0.22 +
      (100 - best.exactRisk) * 0.2
  );

  const quality = clamp(
    best.score * 0.65 +
      confidence * 0.25 +
      (100 - entropyScore) * 0.1
  );

  const risk =
    best.exactRisk >= 16 || entropyScore >= 93
      ? "HIGH"
      : best.exactRisk >= 11 || entropyScore >= 86
        ? "MEDIUM"
        : "LOW";

  const tradeNow =
    total >= 80 &&
    best.score >= 72 &&
    confidence >= 68 &&
    quality >= 66 &&
    best.exactRisk <= 14 &&
    risk !== "HIGH";

  const prepare =
    !tradeNow &&
    total >= 60 &&
    best.score >= 64 &&
    confidence >= 60;

  return {
    total,
    digits,
    recentDigits: digits.slice(-30),
    counts,
    latestDigit: digits.at(-1) ?? 0,
    entropy: entropyScore,
    best,
    confidence,
    quality,
    risk,
    tradeNow,
    prepare,
    decision: tradeNow
      ? `BUY ${best.side} ${best.barrier}`
      : prepare
        ? `PREPARE ${best.side} ${best.barrier}`
        : "WAIT",
    grade:
      tradeNow && quality >= 84
        ? "A"
        : tradeNow && quality >= 74
          ? "B"
          : prepare
            ? "C"
            : "WAIT",
    reason: tradeNow
      ? `${best.side} ${best.barrier} qualified · score ${best.score.toFixed(1)}.`
      : prepare
        ? `${best.side} ${best.barrier} is forming.`
        : `No safe entry. Best score ${best.score.toFixed(1)}.`,
    rows: Array.from({ length: 7 }, (_, index) => {
      const barrier = index + 1;
      return {
        barrier,
        over: sideProbability(counts, barrier, "OVER", total),
        under: sideProbability(counts, barrier, "UNDER", total),
        exact: total ? counts[barrier] / total * 100 : 0,
      };
    }),
  };
}

export default analyzeOverUnder;
