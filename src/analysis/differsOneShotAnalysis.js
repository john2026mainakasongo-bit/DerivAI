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
  const total = counts.reduce((sum, value) => sum + Number(value || 0), 0);
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

function gapSinceLastSeen(digits = [], target = 0) {
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] === target) return digits.length - 1 - index;
  }

  return digits.length;
}

function recentStreak(digits = []) {
  if (!digits.length) return { digit: null, length: 0 };

  const digit = digits.at(-1);
  let length = 0;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== digit) break;
    length += 1;
  }

  return { digit, length };
}

function countWindow(digits = [], size = 20) {
  const counts = Array(10).fill(0);
  digits.slice(-size).forEach((digit) => {
    if (Number.isInteger(digit) && digit >= 0 && digit <= 9) {
      counts[digit] += 1;
    }
  });
  return counts;
}

function repeatRisk(digits = []) {
  if (digits.length < 2) return 10;

  const sample = digits.slice(-40);
  let repeats = 0;

  for (let index = 1; index < sample.length; index += 1) {
    if (sample[index] === sample[index - 1]) repeats += 1;
  }

  return clamp((repeats / Math.max(1, sample.length - 1)) * 100);
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
    .slice(-140);

  if (digits.length < 24) {
    return {
      ready: false,
      reason: `Building analysis ${digits.length}/24`,
      samples: digits.length,
      selectedDigit: null,
      confidence: 0,
      safetyScore: 0,
      entropy: 100,
      candidates: [],
      repeatRisk: 0,
      marketQuality: 0,
    };
  }

  const longWindow = digits.slice(-100);
  const mediumWindow = digits.slice(-50);
  const shortWindow = digits.slice(-20);
  const microWindow = digits.slice(-8);

  const longCounts = countWindow(longWindow, 100);
  const mediumCounts = countWindow(mediumWindow, 50);
  const shortCounts = countWindow(shortWindow, 20);
  const microCounts = countWindow(microWindow, 8);

  const transitions = transitionTable(digits);
  const lastDigit = digits.at(-1);
  const nextCounts = transitions[lastDigit] || Array(10).fill(0);
  const nextTotal = nextCounts.reduce((sum, count) => sum + count, 0);
  const distributionEntropy = entropy(shortCounts);
  const streak = recentStreak(digits);
  const currentRepeatRisk = repeatRisk(digits);

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
        longRate * 0.12 +
        mediumRate * 0.18 +
        shortRate * 0.25 +
        microRate * 0.20 +
        transitionRate * 0.25
      ) * 100
    );

    const gap = gapSinceLastSeen(digits, digit);
    const sameAsLastPenalty = digit === lastDigit ? 3.5 : 0;
    const activeStreakPenalty =
      digit === streak.digit && streak.length >= 2
        ? Math.min(8, streak.length * 2)
        : 0;

    const differsProbability = clamp(
      100 -
        weightedMatchProbability -
        sameAsLastPenalty -
        activeStreakPenalty,
      0,
      99.5
    );

    const windowDrift =
      Math.abs(longRate - shortRate) * 100 * 0.35 +
      Math.abs(mediumRate - microRate) * 100 * 0.35;

    const transitionSafety = clamp(100 - transitionRate * 100);
    const frequencySafety = clamp(100 - weightedMatchProbability * 6.5);
    const gapScore = clamp(gap * 5, 0, 30);

    const safetyScore = clamp(
      differsProbability * 0.44 +
        transitionSafety * 0.20 +
        frequencySafety * 0.18 +
        (100 - windowDrift) * 0.12 +
        gapScore * 0.06
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
      frequencySafety,
      transitionSafety,
      windowDrift,
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
    Number(best?.safetyScore || 0) * 0.68 +
      Number(best?.differsProbability || 0) * 0.16 +
      Number(best?.transitionSafety || 0) * 0.08 +
      Math.min(6, separation * 2) +
      Math.min(6, digits.length / 24)
  );

  const marketQuality = clamp(
    confidence * 0.38 +
      Number(best?.safetyScore || 0) * 0.30 +
      (100 - distributionEntropy) * 0.10 +
      (100 - currentRepeatRisk) * 0.12 +
      Math.min(100, separation * 15) * 0.10
  );

  const ready =
    confidence >= 82 &&
    Number(best?.weightedMatchProbability || 100) <= 12.5 &&
    Number(best?.transitionRate || 100) <= 18 &&
    Number(best?.safetyScore || 0) >= 78 &&
    separation >= 0.45;

  let reason = "Waiting for stronger digit separation.";

  if (ready) {
    reason = `DIFFERS ${best.digit} setup ready.`;
  } else if (Number(best?.weightedMatchProbability || 100) > 12.5) {
    reason = "Best digit match-risk is still too high.";
  } else if (Number(best?.transitionRate || 100) > 18) {
    reason = "Transition risk for the best digit is too high.";
  } else if (confidence < 82) {
    reason = "Combined confidence is below 82%.";
  } else if (Number(best?.safetyScore || 0) < 78) {
    reason = "Safety score is below 78%.";
  }

  return {
    ready,
    reason,
    samples: digits.length,
    selectedDigit: best?.digit ?? null,
    confidence,
    safetyScore: Number(best?.safetyScore || 0),
    differsProbability: Number(best?.differsProbability || 0),
    estimatedMatchProbability: Number(best?.weightedMatchProbability || 0),
    transitionRisk: Number(best?.transitionRate || 0),
    recentRate: Number(best?.recentRate || 0),
    microRate: Number(best?.microRate || 0),
    entropy: distributionEntropy,
    separation,
    lastDigit,
    streak,
    repeatRisk: currentRepeatRisk,
    marketQuality,
    candidates,
  };
}

export default analyzeDiffersOneShot;
