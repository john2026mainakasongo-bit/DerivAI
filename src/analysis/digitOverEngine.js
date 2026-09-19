const DIGITS = Array.from({ length: 10 }, (_, i) => i);

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

const countsFor = (digits) => {
  const counts = Object.fromEntries(DIGITS.map((d) => [d, 0]));
  digits.forEach((digit) => {
    if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit] += 1;
  });
  return counts;
};

const entropy = (digits) => {
  if (!digits.length) return 0;
  const counts = countsFor(digits);
  const h = DIGITS.reduce((sum, digit) => {
    const p = counts[digit] / digits.length;
    return p > 0 ? sum - p * Math.log2(p) : sum;
  }, 0);
  return h / Math.log2(10);
};

const eventProbability = (digits, barrier, direction) => {
  if (!digits.length) return 0.5;
  const wins = digits.filter((d) => direction === "OVER" ? d > barrier : d <= barrier).length;
  return (wins + 1) / (digits.length + 2);
};

const transitionProbability = (digits, barrier, direction) => {
  if (digits.length < 16) return null;
  const last = digits.at(-1);
  let total = 0;
  let wins = 0;
  for (let i = 0; i < digits.length - 1; i += 1) {
    if (digits[i] !== last) continue;
    total += 1;
    const next = digits[i + 1];
    if (direction === "OVER" ? next > barrier : next <= barrier) wins += 1;
  }
  return total >= 3 ? (wins + 1) / (total + 2) : null;
};

const stability = (digits, barrier, direction) => {
  if (digits.length < 40) return 0;
  const windows = [];
  for (let end = 20; end <= digits.length; end += 10) {
    windows.push(eventProbability(digits.slice(end - 20, end), barrier, direction));
  }
  const center = mean(windows);
  const dispersion = mean(windows.map((v) => Math.abs(v - center)));
  return clamp(1 - dispersion * 5);
};

const regimeFor = (digits, barrier, direction) => {
  if (digits.length < 60) return "BUILDING";
  const recent = digits.slice(-20);
  const e = entropy(recent);
  const p = eventProbability(recent, barrier, direction);
  const baseline = direction === "OVER" ? (9 - barrier) / 10 : (barrier + 1) / 10;
  const distance = Math.abs(p - baseline);
  const transition = transitionProbability(digits, barrier, direction);
  const transitionDistance = transition == null ? 0 : Math.abs(transition - p);
  if (e > 0.94 || transitionDistance > 0.30) return "NOISY";
  if (distance > 0.10 && e < 0.91) return "PRESSURE";
  if (e < 0.72) return "CONCENTRATED";
  return "BALANCED";
};

export function analyzeDigitContract(rawDigits = [], options = {}) {
  const barrier = Number(options.barrier ?? 2);
  const direction = options.direction === "UNDER" ? "UNDER" : "OVER";
  const digits = rawDigits.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 9).slice(-60);

  if (digits.length < 60) {
    return {
      ready: false, barrier, direction, signal: "WAIT", grade: "BUILDING",
      probability: 0.5, empirical: 0.5, transition: null, tail: 0.5,
      stability: 0, edgeVsBaseline: 0, score: 0, samples: digits.length,
      hotDigit: null, hotCount: 0, overCount: 0, entropy: entropy(digits),
      regime: "BUILDING", path: digits.slice(-20),
      reason: `Collecting ${Math.max(0, 60 - digits.length)} more digits for the rolling 60-digit model.`
    };
  }

  const counts = countsFor(digits);
  const hotDigit = DIGITS.reduce((best, d) => counts[d] > counts[best] ? d : best, 0);
  const hotCount = counts[hotDigit];
  const empirical = eventProbability(digits, barrier, direction);
  const tail = eventProbability(digits.slice(-15), barrier, direction);
  const transition = transitionProbability(digits, barrier, direction);
  const stable = stability(digits, barrier, direction);
  const baseline = direction === "OVER" ? (9 - barrier) / 10 : (barrier + 1) / 10;
  const edgeVsBaseline = empirical - baseline;
  const transitionValue = transition == null ? empirical : transition;
  const model = empirical * 0.45 + tail * 0.25 + transitionValue * 0.20 + stable * 0.10;
  const probability = clamp(model, 0.01, 0.99);
  const regime = regimeFor(digits, barrier, direction);
  const regimePenalty = regime === "NOISY" ? 20 : regime === "BALANCED" ? 5 : 0;
  const score = Math.max(0, Math.min(100, Math.round(
    (0.55 * probability + 0.25 * stable + 0.20 * (0.5 + edgeVsBaseline * 2)) * 100 - regimePenalty
  )));
  const threshold = barrier === 2 ? 0.55 : 0.58;
  const signal = regime !== "NOISY" && probability >= threshold && edgeVsBaseline >= 0.01 && stable >= 0.25
    ? `${direction} ${barrier}`
    : "WAIT";

  return {
    ready: true, barrier, direction, signal,
    grade: signal !== "WAIT" && score >= 72 ? "A+" : signal !== "WAIT" ? "A" : "WAIT",
    probability, empirical, transition, tail, stability: stable, edgeVsBaseline, score,
    samples: digits.length, hotDigit, hotCount,
    overCount: digits.filter((d) => d > barrier).length,
    entropy: entropy(digits), regime, path: digits.slice(-20),
    baseline,
    reason: signal === "WAIT"
      ? `${regime} market · probability ${(probability * 100).toFixed(1)}% · waiting for a clean ${direction} setup.`
      : `${direction} ${barrier} setup · ${(probability * 100).toFixed(1)}% model · ${score}/100 score · ${regime} regime.`
  };
}

export function analyzeDigitOver(rawDigits = [], options = {}) {
  return analyzeDigitContract(rawDigits, { ...options, direction: "OVER" });
}

export function analyzeDigitUnder(rawDigits = [], options = {}) {
  return analyzeDigitContract(rawDigits, { ...options, direction: "UNDER" });
}

export function selectBestDigitContract(rawDigits = [], options = {}) {
  const barriers = options.barriers || [2, 1];
  const candidates = [];
  barriers.forEach((barrier) => {
    ["OVER", "UNDER"].forEach((direction) => {
      candidates.push(analyzeDigitContract(rawDigits, { barrier, direction }));
    });
  });
  const ready = candidates.filter((a) => a.ready && a.signal !== "WAIT");
  const best = ready.sort((a, b) => (b.probability + b.edgeVsBaseline + b.stability * 0.25) - (a.probability + a.edgeVsBaseline + a.stability * 0.25))[0];
  const byKey = Object.fromEntries(candidates.map((a) => [`${a.direction}-${a.barrier}`, a]));
  return {
    analysis: best || candidates[0],
    candidates,
    alternatives: byKey,
    direction: best?.direction || candidates[0]?.direction || "OVER",
    barrier: best?.barrier || 2
  };
}

export function selectBestDigitOver(rawDigits = []) {
  const selected = selectBestDigitContract(rawDigits, { barriers: [2, 1] });
  const overCandidates = selected.candidates.filter((a) => a.direction === "OVER");
  const best = overCandidates.filter((a) => a.signal !== "WAIT").sort((a, b) => b.probability - a.probability)[0] || overCandidates[0];
  return {
    barrier: best?.barrier || 2,
    analysis: best,
    alternatives: {
      1: overCandidates.find((a) => a.barrier === 1) || best,
      2: overCandidates.find((a) => a.barrier === 2) || best
    }
  };
}

export function digitPathString(path = []) {
  return path.map((d) => String(d)).join(" → ");
}
