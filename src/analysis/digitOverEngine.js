const DIGITS = Array.from({ length: 10 }, (_, i) => i);

const clamp = (value, min = 0, max = 1) =>
  Math.max(min, Math.min(max, Number(value) || 0));

const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

const countsFor = (digits) => {
  const counts = Object.fromEntries(DIGITS.map((d) => [d, 0]));
  for (const digit of digits) {
    if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit] += 1;
  }
  return counts;
};

const entropy = (digits) => {
  if (!digits.length) return 0;
  const counts = countsFor(digits);
  return -DIGITS.reduce((sum, digit) => {
    const p = counts[digit] / digits.length;
    return p > 0 ? sum + p * Math.log2(p) : sum;
  }, 0) / Math.log2(10);
};

const overProbability = (digits, barrier) => {
  if (!digits.length) return 0.5;
  const wins = digits.filter((digit) => digit > barrier).length;
  // Mild Bayesian smoothing prevents a 60-tick window from producing 0%/100%
  // probabilities from a small count fluctuation.
  return (wins + 1) / (digits.length + 2);
};

const transitionProbability = (digits, barrier) => {
  if (digits.length < 12) return null;
  const last = digits.at(-1);
  let total = 0;
  let wins = 0;
  for (let i = 0; i < digits.length - 1; i += 1) {
    if (digits[i] !== last) continue;
    total += 1;
    if (digits[i + 1] > barrier) wins += 1;
  }
  if (total < 3) return null;
  return (wins + 1) / (total + 2);
};

const windowStability = (digits, barrier) => {
  if (digits.length < 40) return 0;
  const windows = [];
  for (let end = 20; end <= digits.length; end += 10) {
    windows.push(overProbability(digits.slice(end - 20, end), barrier));
  }
  if (!windows.length) return 0;
  const center = mean(windows);
  const dispersion = mean(windows.map((value) => Math.abs(value - center)));
  return clamp(1 - dispersion * 5);
};

const volatilityRegime = (digits, barrier) => {
  if (digits.length < 60) return "BUILDING";
  const recent = digits.slice(-20);
  const e = entropy(recent);
  const p = overProbability(recent, barrier);
  const distance = Math.abs(p - (10 - (barrier + 1)) / 10);
  const transition = transitionProbability(digits, barrier);
  const transitionDistance =
    transition == null ? 0 : Math.abs(transition - p);

  if (e > 0.93 || transitionDistance > 0.28) return "NOISY";
  if (distance > 0.12 && e < 0.9) return "PRESSURE";
  if (e < 0.72) return "CONCENTRATED";
  return "BALANCED";
};

export function analyzeDigitOver(rawDigits = [], options = {}) {
  const barrier = Number(options.barrier ?? 2);
  const digits = rawDigits
    .map(Number)
    .filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9)
    .slice(-60);

  if (digits.length < 60) {
    return {
      ready: false,
      barrier,
      signal: "WAIT",
      grade: "BUILDING",
      probability: 0.5,
      empirical: 0.5,
      transition: null,
      tail: 0.5,
      stability: 0,
      score: 0,
      samples: digits.length,
      hotDigit: null,
      hotCount: 0,
      overCount: 0,
      entropy: entropy(digits),
      regime: "BUILDING",
      path: digits.slice(-20),
      reason: `Collecting ${Math.max(0, 60 - digits.length)} more digits for the rolling 60-digit model.`,
    };
  }

  const counts = countsFor(digits);
  const hotDigit = DIGITS.reduce((best, digit) =>
    counts[digit] > counts[best] ? digit : best, 0);
  const hotCount = counts[hotDigit];
  const empirical = overProbability(digits, barrier);
  const tail = overProbability(digits.slice(-15), barrier);
  const transition = transitionProbability(digits, barrier);
  const stability = windowStability(digits, barrier);
  const hotSupport = hotDigit > barrier ? Math.min(1, hotCount / 10) : 0;
  const model =
    empirical * 0.45 +
    tail * 0.25 +
    (transition == null ? empirical : transition) * 0.20 +
    hotSupport * 0.10;

  const probability = clamp(model, 0.01, 0.99);
  const baseline = (10 - (barrier + 1)) / 10;
  const edgeVsBaseline = probability - baseline;
  const regime = volatilityRegime(digits, barrier);
  const regimePenalty = regime === "NOISY" ? 20 : regime === "BALANCED" ? 5 : 0;
  const score = Math.round(
    clamp(
      0.55 * probability +
        0.25 * stability +
        0.20 * (0.5 + edgeVsBaseline * 2),
      0,
      1
    ) * 100 - regimePenalty
  );

  // The engine deliberately requires a meaningful edge over the theoretical
  // base rate AND a stable/noisy-regime check. It does not assume that a hot
  // digit predicts the next tick; hot-digit pressure is only one feature.
  // V2 is intentionally easier to enter than V1, but it still refuses
  // noisy conditions. The final Deriv proposal/EV gate remains mandatory.
  const signal =
    regime !== "NOISY" &&
    probability >= (barrier === 2 ? 0.71 : 0.62) &&
    edgeVsBaseline >= 0.01 &&
    stability >= 0.35
      ? `OVER ${barrier}`
      : "WAIT";

  return {
    ready: true,
    barrier,
    signal,
    grade: signal !== "WAIT" && score >= 68 ? "A+" : signal !== "WAIT" ? "A" : "WAIT",
    probability,
    empirical,
    transition,
    tail,
    stability,
    score: Math.max(0, Math.min(100, score)),
    samples: digits.length,
    hotDigit,
    hotCount,
    overCount: digits.filter((digit) => digit > barrier).length,
    entropy: entropy(digits),
    regime,
    path: digits.slice(-20),
    reason:
      signal !== "WAIT"
        ? `Hot digit ${hotDigit} (${hotCount}/60), over-${barrier} rate ${(empirical * 100).toFixed(1)}%, tail ${(tail * 100).toFixed(1)}%, transition ${transition == null ? "n/a" : `${(transition * 100).toFixed(1)}%`}.`
        : `No clean entry: over-${barrier} ${(probability * 100).toFixed(1)}%, stability ${(stability * 100).toFixed(0)}%, regime ${regime}.`,
  };
}

export function selectBestDigitOver(rawDigits = []) {
  const over2 = analyzeDigitOver(rawDigits, { barrier: 2 });
  const over3 = analyzeDigitOver(rawDigits, { barrier: 3 });
  const candidates = [over2, over3].filter((item) => item.ready);

  if (!candidates.length) {
    return {
      barrier: 2,
      analysis: over2,
      alternatives: { 2: over2, 3: over3 },
    };
  }

  const ranked = [...candidates].sort((a, b) => {
    const aEdge = Number(a.edgeVsBaseline || a.probability - (10 - (a.barrier + 1)) / 10);
    const bEdge = Number(b.edgeVsBaseline || b.probability - (10 - (b.barrier + 1)) / 10);
    return (bEdge + b.stability * 0.25 + b.score / 500) -
      (aEdge + a.stability * 0.25 + a.score / 500);
  });

  return {
    barrier: ranked[0].barrier,
    analysis: ranked[0],
    alternatives: { 2: over2, 3: over3 },
  };
}

export function digitPathString(digits = []) {
  return digits.map((digit) => String(digit)).join(" → ");
}
