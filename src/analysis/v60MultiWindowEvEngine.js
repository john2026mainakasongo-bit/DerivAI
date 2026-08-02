
function clamp(value, minimum = 0, maximum = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function validDigits(values = []) {
  return values
    .map(Number)
    .filter(
      (value) =>
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 9
    );
}

function frequencyProbabilities(digits = []) {
  const counts = Array.from({ length: 10 }, () => 0);

  for (const digit of digits) {
    counts[digit] += 1;
  }

  const total = Math.max(1, digits.length);
  return counts.map((count) => count / total);
}

function transitionProbabilities(digits = []) {
  if (digits.length < 2) {
    return Array.from({ length: 10 }, () => 0.1);
  }

  const matrix = Array.from({ length: 10 }, () =>
    Array.from({ length: 10 }, () => 0)
  );

  for (let index = 1; index < digits.length; index += 1) {
    matrix[digits[index - 1]][digits[index]] += 1;
  }

  const previous = digits[digits.length - 1];
  const row = matrix[previous];
  const total = row.reduce((sum, count) => sum + count, 0);

  if (!total) {
    return frequencyProbabilities(digits);
  }

  return row.map((count) => (count + 1) / (total + 10));
}

function entropyQuality(digits = []) {
  const probabilities = frequencyProbabilities(digits)
    .filter((value) => value > 0);

  let entropy = 0;

  for (const probability of probabilities) {
    entropy -= probability * Math.log2(probability);
  }

  const maximum = Math.log2(10);
  return maximum
    ? clamp((1 - entropy / maximum) * 100)
    : 0;
}

function probabilityFor(probabilities, mode, digit = null) {
  if (mode === "MATCH") return probabilities[digit] || 0;
  if (mode === "DIFFERS") return 1 - (probabilities[digit] || 0);

  if (mode === "EVEN") {
    return [0, 2, 4, 6, 8].reduce(
      (sum, value) => sum + (probabilities[value] || 0),
      0
    );
  }

  if (mode === "ODD") {
    return [1, 3, 5, 7, 9].reduce(
      (sum, value) => sum + (probabilities[value] || 0),
      0
    );
  }

  let total = 0;

  for (let value = 0; value <= 9; value += 1) {
    if (mode === "OVER" && value > digit) {
      total += probabilities[value] || 0;
    }

    if (mode === "UNDER" && value < digit) {
      total += probabilities[value] || 0;
    }
  }

  return total;
}

function fairProbability(mode, digit = null) {
  if (mode === "MATCH") return 0.1;
  if (mode === "DIFFERS") return 0.9;
  if (mode === "EVEN" || mode === "ODD") return 0.5;
  if (mode === "OVER") return (9 - Number(digit)) / 10;
  if (mode === "UNDER") return Number(digit) / 10;
  return 0.5;
}

function conservativeEv(probability, baseline) {
  const payoutMultiplier = (1 / Math.max(0.01, baseline)) * 0.96;
  return probability * payoutMultiplier - 1;
}

function bayesianShrink(probability, baseline, sampleSize) {
  const priorStrength = 150;

  return (
    probability * sampleSize +
    baseline * priorStrength
  ) / (sampleSize + priorStrength);
}

function windowEvidence(digits, mode, digit) {
  const sizes = [200, 500, 1000];
  const windows = sizes
    .map((size) => digits.slice(-Math.min(size, digits.length)))
    .filter((items) => items.length >= 30);

  if (!windows.length) {
    return {
      probability: fairProbability(mode, digit),
      consistency: 0,
      entropy: 0,
      windows: [],
    };
  }

  const weights =
    windows.length === 3
      ? [0.5, 0.3, 0.2]
      : windows.length === 2
        ? [0.65, 0.35]
        : [1];

  const results = windows.map((items, index) => {
    const frequency = frequencyProbabilities(items);
    const transition = transitionProbabilities(items);
    const blendedDigits = frequency.map(
      (value, digitIndex) =>
        value * 0.6 +
        (transition[digitIndex] || 0) * 0.4
    );

    return {
      size: items.length,
      probability: probabilityFor(
        blendedDigits,
        mode,
        digit
      ),
      entropy: entropyQuality(items),
      weight: weights[index] || 0,
    };
  });

  const probability = results.reduce(
    (sum, item) => sum + item.probability * item.weight,
    0
  );

  const values = results.map((item) => item.probability);
  const spread = Math.max(...values) - Math.min(...values);

  return {
    probability,
    consistency: clamp((1 - spread / 0.18) * 100),
    entropy: results.reduce(
      (sum, item) => sum + item.entropy * item.weight,
      0
    ),
    windows: results,
  };
}

function setup(mode, digit) {
  if (mode === "EVEN" || mode === "ODD") return mode;
  return `${mode} ${digit}`;
}

function definitions() {
  return [
    ...[1, 2, 3, 4, 5, 6].map((digit) => ({ mode: "OVER", digit })),
    ...[3, 4, 5, 6, 7, 8].map((digit) => ({ mode: "UNDER", digit })),
    { mode: "EVEN", digit: null },
    { mode: "ODD", digit: null },
    ...Array.from({ length: 10 }, (_, digit) => ({
      mode: "MATCH",
      digit,
    })),
    ...Array.from({ length: 10 }, (_, digit) => ({
      mode: "DIFFERS",
      digit,
    })),
  ];
}

export function rankV60DigitContracts({
  digitHistory = [],
  minimumSamples = 200,
  allowHighRisk = false,
} = {}) {
  const digits = validDigits(digitHistory);
  const sampleSize = digits.length;

  if (sampleSize < 30) {
    return {
      ready: false,
      sampleSize,
      reason: `Collecting ticks: ${sampleSize}/30.`,
      candidates: [],
      best: null,
    };
  }

  const candidates = definitions().map(({ mode, digit }) => {
    const baseline = fairProbability(mode, digit);
    const evidence = windowEvidence(digits, mode, digit);
    const probability = bayesianShrink(
      evidence.probability,
      baseline,
      sampleSize
    );
    const ev = conservativeEv(probability, baseline);
    const edge = probability - baseline;
    const highRisk = mode === "MATCH" || mode === "DIFFERS";

    let quality =
      55 +
      ev * 150 +
      edge * 90 +
      (evidence.consistency - 50) * 0.2 +
      (evidence.entropy - 50) * 0.04;

    if (highRisk) {
      quality -= 15;
      quality = Math.min(84, quality);
    } else {
      quality = Math.min(95, quality);
    }

    quality = clamp(quality);

    const standardExecutable =
      !highRisk &&
      sampleSize >= minimumSamples &&
      ev >= 0.03 &&
      edge >= 0.018 &&
      evidence.consistency >= 60 &&
      quality >= 74;

    const highRiskExecutable =
      highRisk &&
      allowHighRisk &&
      sampleSize >= 400 &&
      ev >= 0.15 &&
      edge >= 0.04 &&
      evidence.consistency >= 78 &&
      quality >= 82;

    return {
      setup: setup(mode, digit),
      mode,
      digit,
      highRisk,
      sampleSize,
      baseline: baseline * 100,
      probability: probability * 100,
      expectedValue: ev * 100,
      probabilityEdge: edge * 100,
      consistency: evidence.consistency,
      entropyQuality: evidence.entropy,
      qualityScore: quality,
      executable: standardExecutable || highRiskExecutable,
      source: "V60 MULTI-WINDOW EV",
      detail:
        `${setup(mode, digit)} · P ${(
          probability * 100
        ).toFixed(1)}% · EV ${
          ev >= 0 ? "+" : ""
        }${(ev * 100).toFixed(1)}% · consistency ${evidence.consistency.toFixed(1)}%.`,
      windows: evidence.windows,
    };
  });

  candidates.sort((left, right) => {
    if (left.executable !== right.executable) {
      return left.executable ? -1 : 1;
    }

    return (
      right.expectedValue - left.expectedValue ||
      right.qualityScore - left.qualityScore ||
      right.consistency - left.consistency
    );
  });

  const best = candidates.find(
    (candidate) => candidate.executable
  ) || null;

  return {
    ready: sampleSize >= minimumSamples,
    sampleSize,
    reason: best
      ? "Positive EV and multi-window consistency confirmed."
      : "WAIT: no contract passes EV, sample and consistency filters.",
    candidates,
    best,
  };
}
