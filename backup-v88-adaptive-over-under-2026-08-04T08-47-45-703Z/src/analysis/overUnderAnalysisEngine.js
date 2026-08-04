function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function lastDigit(value) {
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

function countsOf(digits) {
  const counts = Array(10).fill(0);
  digits.forEach((digit) => {
    if (digit >= 0 && digit <= 9) counts[digit] += 1;
  });
  return counts;
}

function percent(count, total) {
  return total ? (count / total) * 100 : 0;
}

function entropy(counts, total) {
  if (!total) return 100;
  const raw = counts.reduce((sum, count) => {
    if (!count) return sum;
    const p = count / total;
    return sum - p * Math.log2(p);
  }, 0);
  return clamp((raw / Math.log2(10)) * 100);
}

function transitionScore(digits, side, barrier) {
  if (digits.length < 3) return 0;
  const wins = (digit) => side === "OVER" ? digit > barrier : digit < barrier;
  let samples = 0;
  let matches = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (!wins(digits[index - 1])) continue;
    samples += 1;
    if (wins(digits[index])) matches += 1;
  }

  return samples ? percent(matches, samples) : 0;
}

function sideProbability(counts, side, barrier, total) {
  const selected =
    side === "OVER"
      ? counts.slice(barrier + 1)
      : counts.slice(0, barrier);
  return percent(selected.reduce((sum, value) => sum + value, 0), total);
}

function range(start, end) {
  const values = [];
  for (let value = start; value <= end; value += 1) values.push(value);
  return values;
}

function recentRowPressure(digits) {
  const fast = digits.slice(-25);
  const trigger = digits.slice(-6);
  const lower = fast.filter((digit) => digit <= 4).length +
    trigger.filter((digit) => digit <= 4).length;
  const upper = fast.filter((digit) => digit >= 5).length +
    trigger.filter((digit) => digit >= 5).length;

  if (upper >= lower + 3) return "LOWER → UPPER";
  if (lower >= upper + 3) return "UPPER → LOWER";
  return "BALANCED";
}

function differsRanking(digits, counts, total) {
  const current = digits.at(-1);
  return range(0, 9)
    .map((target) => {
      const globalRisk = percent(counts[target], total);
      const fast = digits.slice(-25);
      const fastRisk = percent(
        fast.filter((digit) => digit === target).length,
        fast.length
      );

      let transitions = 0;
      let repeats = 0;
      for (let i = 0; i < digits.length - 1; i += 1) {
        if (digits[i] !== current) continue;
        transitions += 1;
        if (digits[i + 1] === target) repeats += 1;
      }

      const transitionRisk = percent(repeats, transitions);
      const exactRisk = clamp(
        globalRisk * 0.45 + fastRisk * 0.35 + transitionRisk * 0.2
      );

      return {
        digit: target,
        exactRisk,
        differsProbability: clamp(100 - exactRisk),
      };
    })
    .sort((a, b) => a.exactRisk - b.exactRisk);
}

export function analyzeOverUnder(prices = []) {
  const values = normalizePrices(prices).slice(-220);
  const digits = values.map(lastDigit);
  const counts = countsOf(digits);
  const total = digits.length;
  const latestDigit = digits.at(-1) ?? 0;
  const entropyScore = entropy(counts, total);
  const rowPressure = recentRowPressure(digits);
  const candidates = [];

  for (let barrier = 1; barrier <= 7; barrier += 1) {
    for (const side of ["OVER", "UNDER"]) {
      const probability = sideProbability(counts, side, barrier, total);
      const exactRisk = percent(counts[barrier], total);
      const transition = transitionScore(digits.slice(-80), side, barrier);
      const rowBonus =
        (side === "OVER" && rowPressure === "LOWER → UPPER") ||
        (side === "UNDER" && rowPressure === "UPPER → LOWER")
          ? 5
          : rowPressure === "BALANCED"
            ? 0
            : -3;

      const safeBarrierBonus =
        (side === "OVER" && barrier <= 3) ||
        (side === "UNDER" && barrier >= 5)
          ? 5
          : 0;

      const score = clamp(
        probability * 0.48 +
        transition * 0.24 +
        (100 - exactRisk) * 0.18 +
        safeBarrierBonus +
        rowBonus -
        Math.max(0, entropyScore - 92) * 0.5
      );

      candidates.push({
        side,
        barrier,
        probability,
        exactRisk,
        transitionScore: transition,
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

  const differs = differsRanking(digits, counts, total);
  const bestDiffers = differs[0] || {
    digit: 0,
    exactRisk: 100,
    differsProbability: 0,
  };

  const confidence = clamp(
    best.probability * 0.54 +
    best.transitionScore * 0.26 +
    (100 - best.exactRisk) * 0.2
  );

  const quality = clamp(best.score * 0.72 + confidence * 0.28);
  const risk =
    best.exactRisk > 15 || entropyScore > 96
      ? "HIGH"
      : best.exactRisk > 11 || entropyScore > 91
        ? "MEDIUM"
        : "LOW";

  const enoughData = total >= 50;
  const tradeNow =
    enoughData &&
    best.score >= 72 &&
    confidence >= 70 &&
    best.transitionScore >= 54 &&
    best.exactRisk <= 15;

  const prepare =
    !tradeNow &&
    enoughData &&
    best.score >= 62 &&
    confidence >= 62;

  const winningDigits =
    best.side === "OVER"
      ? range(best.barrier + 1, 9)
      : range(0, best.barrier - 1);

  const triggerDigits =
    best.side === "OVER"
      ? range(0, Math.min(9, best.barrier + 1))
      : range(Math.max(0, best.barrier - 1), 9);

  const avoidDigits =
    best.side === "OVER"
      ? range(0, best.barrier)
      : range(best.barrier, 9);

  return {
    total,
    digits,
    recentDigits: digits.slice(-30),
    counts,
    latestDigit,
    entropy: entropyScore,
    rowPressure,
    best,
    confidence,
    quality,
    risk,
    tradeNow,
    prepare,
    triggerDigits,
    winningDigits,
    avoidDigits,
    bestDiffers,
    differs: differs.slice(0, 4),
    decision: tradeNow
      ? `BUY ${best.side} ${best.barrier}`
      : prepare
        ? `PREPARE ${best.side} ${best.barrier}`
        : "WAIT",
    grade:
      tradeNow && quality >= 84
        ? "A"
        : tradeNow
          ? "B"
          : prepare
            ? "C"
            : "WAIT",
    reason: tradeNow
      ? `${best.side} ${best.barrier} has a qualified fast entry.`
      : prepare
        ? `${best.side} ${best.barrier} is forming; watch the trigger digits.`
        : "No qualified entry yet. Scanner continues or switches market.",
    rows: range(1, 7).map((barrier) => ({
      barrier,
      over: sideProbability(counts, "OVER", barrier, total),
      under: sideProbability(counts, "UNDER", barrier, total),
      exact: percent(counts[barrier], total),
    })),
  };
}

export default analyzeOverUnder;
