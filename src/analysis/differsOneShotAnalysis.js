function clamp(value, minimum = 0, maximum = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function entropy(counts = []) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (!total) return 100;

  const raw = counts.reduce((sum, count) => {
    if (!count) return sum;
    const probability = count / total;
    return sum - probability * Math.log2(probability);
  }, 0);

  return clamp((raw / Math.log2(10)) * 100);
}

function transitionTable(digits = []) {
  const table = Array.from({ length: 10 }, () => Array(10).fill(0));

  for (let index = 1; index < digits.length; index += 1) {
    const previous = Number(digits[index - 1]);
    const current = Number(digits[index]);

    if (
      Number.isInteger(previous) &&
      Number.isInteger(current) &&
      previous >= 0 &&
      previous <= 9 &&
      current >= 0 &&
      current <= 9
    ) {
      table[previous][current] += 1;
    }
  }

  return table;
}

function longestGap(digits = [], target = 0) {
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] === target) {
      return digits.length - 1 - index;
    }
  }

  return digits.length;
}

function recentStreak(digits = []) {
  if (!digits.length) return { digit: null, length: 0 };

  const last = digits.at(-1);
  let length = 0;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== last) break;
    length += 1;
  }

  return { digit: last, length };
}

export function analyzeDiffersOneShot(digitHistory = []) {
  const digits = (Array.isArray(digitHistory) ? digitHistory : [])
    .map(Number)
    .filter(
      (digit) =>
        Number.isInteger(digit) &&
        digit >= 0 &&
        digit <= 9
    )
    .slice(-120);

  if (digits.length < 18) {
    return {
      ready: false,
      reason: `Collecting fresh digits ${digits.length}/18`,
      samples: digits.length,
      selectedDigit: null,
      confidence: 0,
      safetyScore: 0,
      entropy: 100,
      candidates: [],
    };
  }

  const longWindow = digits.slice(-100);
  const mediumWindow = digits.slice(-50);
  const shortWindow = digits.slice(-20);
  const microWindow = digits.slice(-8);

  const longCounts = Array(10).fill(0);
  const mediumCounts = Array(10).fill(0);
  const shortCounts = Array(10).fill(0);
  const microCounts = Array(10).fill(0);

  longWindow.forEach((digit) => longCounts[digit] += 1);
  mediumWindow.forEach((digit) => mediumCounts[digit] += 1);
  shortWindow.forEach((digit) => shortCounts[digit] += 1);
  microWindow.forEach((digit) => microCounts[digit] += 1);

  const transitions = transitionTable(digits);
  const lastDigit = digits.at(-1);
  const nextCounts = transitions[lastDigit] || Array(10).fill(0);
  const nextTotal = nextCounts.reduce((sum, count) => sum + count, 0);
  const distributionEntropy = entropy(shortCounts);
  const streak = recentStreak(digits);

  const candidates = Array.from({ length: 10 }, (_, digit) => {
    const longRate = longCounts[digit] / Math.max(1, longWindow.length);
    const mediumRate = mediumCounts[digit] / Math.max(1, mediumWindow.length);
    const shortRate = shortCounts[digit] / Math.max(1, shortWindow.length);
    const microRate = microCounts[digit] / Math.max(1, microWindow.length);
    const transitionRate = nextTotal
      ? nextCounts[digit] / nextTotal
      : mediumRate;

    const weightedMatchProbability = clamp(
      (
        longRate * 0.15 +
        mediumRate * 0.20 +
        shortRate * 0.25 +
        microRate * 0.15 +
        transitionRate * 0.25
      ) * 100,
      0,
      100
    );

    const gap = longestGap(digits, digit);
    const immediateRepeatPenalty = digit === lastDigit ? 4 : 0;
    const streakPenalty =
      digit === streak.digit && streak.length >= 2
        ? Math.min(10, streak.length * 2.5)
        : 0;

    /*
      For DIGITDIFF, lower estimated match probability is better.
      Gap is only a weak tie-breaker; a long absence does not make a digit "due".
    */
    const differsProbability = clamp(
      100 -
        weightedMatchProbability -
        immediateRepeatPenalty -
        streakPenalty,
      0,
      99.9
    );

    const stabilityPenalty =
      Math.abs(longRate - shortRate) * 100 * 0.45 +
      Math.abs(mediumRate - microRate) * 100 * 0.35;

    const safetyScore = clamp(
      differsProbability * 0.72 +
        (100 - distributionEntropy) * 0.08 +
        clamp(gap * 3, 0, 30) * 0.08 +
        (100 - stabilityPenalty) * 0.12
    );

    return {
      digit,
      differsProbability,
      weightedMatchProbability,
      safetyScore,
      gap,
      transitionRate: transitionRate * 100,
      recentRate: shortRate * 100,
      microRate: microRate * 100,
    };
  }).sort((a, b) => b.safetyScore - a.safetyScore);

  const best = candidates[0];
  const second = candidates[1];
  const separation = Math.max(
    0,
    Number(best?.safetyScore || 0) -
      Number(second?.safetyScore || 0)
  );

  const confidence = clamp(
    Number(best?.safetyScore || 0) * 0.78 +
      Number(best?.differsProbability || 0) * 0.14 +
      separation * 1.5 +
      Math.min(8, digits.length / 15)
  );

  const reasons = [];

  if (distributionEntropy >= 96) {
    reasons.push("Digit distribution is highly random.");
  }

  if (confidence < 91) {
    reasons.push("Fresh-scan confidence is below 91%.");
  }

  if (separation < 3) {
    reasons.push("The best digit has not stayed clearly separated.");
  }

  if (Number(best?.weightedMatchProbability || 100) > 8.5) {
    reasons.push("Estimated match rate is above the strict 8.5% limit.");
  }

  const ready =
    confidence >= 91 &&
    separation >= 3 &&
    Number(best?.weightedMatchProbability || 100) <= 8.5 &&
    distributionEntropy <= 96;

  return {
    ready,
    reason: ready
      ? `DIFFERS ${best.digit} setup prepared.`
      : reasons[0] || "Waiting for a cleaner differs setup.",
    samples: digits.length,
    selectedDigit: best.digit,
    confidence,
    safetyScore: Number(best?.safetyScore || 0),
    differsProbability: Number(best?.differsProbability || 0),
    estimatedMatchProbability: Number(best?.weightedMatchProbability || 0),
    entropy: distributionEntropy,
    separation,
    lastDigit,
    streak,
    candidates,
  };
}

export default analyzeDiffersOneShot;
