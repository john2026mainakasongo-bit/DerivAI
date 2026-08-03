const SAFE_AUTO_SETUPS = new Set([
  "RISE",
  "FALL",
  "EVEN",
  "ODD",
  "OVER 2",
]);

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function finiteNumber(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function variance(values = []) {
  if (values.length < 2) return 0;
  const center = mean(values);
  return mean(values.map((value) => (value - center) ** 2));
}

function stdDev(values = []) {
  return Math.sqrt(Math.max(0, variance(values)));
}

function sign(value, epsilon = 0) {
  if (value > epsilon) return 1;
  if (value < -epsilon) return -1;
  return 0;
}

function numericPrice(item) {
  if (typeof item === "number") return item;

  const candidates = [
    item?.quote,
    item?.price,
    item?.value,
    item?.close,
    item?.spot,
    item?.tick,
  ];

  for (const candidate of candidates) {
    const parsed = finiteNumber(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }

  return NaN;
}

function digitValue(item) {
  if (Number.isInteger(Number(item)) && Number(item) >= 0 && Number(item) <= 9) {
    return Number(item);
  }

  const candidates = [item?.digit, item?.lastDigit, item?.last_digit];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 9) {
      return parsed;
    }
  }

  return NaN;
}

function lastDigitFromPrice(value) {
  if (!Number.isFinite(value)) return NaN;
  const text = String(value).replace(/[^0-9]/g, "");
  if (!text) return NaN;
  return Number(text[text.length - 1]);
}

function getPrices(snapshot = {}) {
  const rows = Array.isArray(snapshot?.prices) ? snapshot.prices : [];
  const prices = rows.map(numericPrice).filter(Number.isFinite);

  const current = numericPrice(snapshot?.currentPrice);
  if (Number.isFinite(current) && prices[prices.length - 1] !== current) {
    prices.push(current);
  }

  return prices.slice(-120);
}

function getDigits(snapshot = {}, prices = []) {
  const rows = Array.isArray(snapshot?.digitHistory)
    ? snapshot.digitHistory
    : [];
  const digits = rows.map(digitValue).filter(Number.isFinite);

  if (digits.length) return digits.slice(-120);

  return prices
    .map(lastDigitFromPrice)
    .filter(Number.isFinite)
    .slice(-120);
}

function returnsOf(prices = []) {
  const rows = [];

  for (let index = 1; index < prices.length; index += 1) {
    const previous = prices[index - 1];
    const current = prices[index];
    const scale = Math.max(Math.abs(previous), 1e-9);
    rows.push((current - previous) / scale);
  }

  return rows;
}

function slope(values = []) {
  const size = values.length;
  if (size < 3) return 0;

  const xCenter = (size - 1) / 2;
  const yCenter = mean(values);
  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < size; index += 1) {
    const x = index - xCenter;
    numerator += x * (values[index] - yCenter);
    denominator += x * x;
  }

  return denominator > 0 ? numerator / denominator : 0;
}

function efficiencyRatio(values = []) {
  if (values.length < 3) return 0;

  const net = Math.abs(values[values.length - 1] - values[0]);
  let travel = 0;

  for (let index = 1; index < values.length; index += 1) {
    travel += Math.abs(values[index] - values[index - 1]);
  }

  return travel > 0 ? clamp((net / travel) * 100) : 0;
}

function correlation(values = [], lag = 1) {
  if (lag < 1 || values.length <= lag + 5) return 0;

  const left = values.slice(lag);
  const right = values.slice(0, values.length - lag);
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftEnergy += a * a;
    rightEnergy += b * b;
  }

  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  return denominator > 0 ? numerator / denominator : 0;
}

function spectralCycle(values = []) {
  const sample = values.slice(-72);
  if (sample.length < 24) {
    return {
      period: 0,
      strength: 0,
      direction: "NEUTRAL",
      forecast: 0,
    };
  }

  const centered = sample.map((value) => value - mean(sample));
  const amplitudes = [];

  for (let period = 3; period <= 24; period += 1) {
    const omega = (2 * Math.PI) / period;
    let cosine = 0;
    let sine = 0;

    for (let index = 0; index < centered.length; index += 1) {
      cosine += centered[index] * Math.cos(omega * index);
      sine += centered[index] * Math.sin(omega * index);
    }

    const amplitude = Math.sqrt(cosine ** 2 + sine ** 2);
    amplitudes.push({ period, amplitude, cosine, sine, omega });
  }

  const total = amplitudes.reduce((sum, row) => sum + row.amplitude, 0);
  const best = amplitudes.sort((a, b) => b.amplitude - a.amplitude)[0];
  const nextIndex = centered.length;
  const forecast =
    best.cosine * Math.cos(best.omega * nextIndex) +
    best.sine * Math.sin(best.omega * nextIndex);
  const strength = total > 0 ? clamp((best.amplitude / total) * 420) : 0;

  return {
    period: best.period,
    strength,
    direction: forecast > 0 ? "RISE" : forecast < 0 ? "FALL" : "NEUTRAL",
    forecast,
  };
}

function momentumAnalysis(prices = [], returns = []) {
  const windows = [5, 10, 20, 40]
    .filter((window) => prices.length >= window)
    .map((window) => {
      const sample = prices.slice(-window);
      const localReturns = returns.slice(-(window - 1));
      const localStd = stdDev(localReturns) || 1e-9;
      const normalizedSlope = slope(sample) / Math.max(Math.abs(mean(sample)), 1e-9);
      const score = clamp(50 + (normalizedSlope / localStd) * 18);
      return {
        window,
        score,
        direction: score > 53 ? "RISE" : score < 47 ? "FALL" : "NEUTRAL",
      };
    });

  const signedScores = windows.map((row) => (row.score - 50) * 2);
  const signed = signedScores.length ? mean(signedScores) : 0;
  const riseVotes = windows.filter((row) => row.direction === "RISE").length;
  const fallVotes = windows.filter((row) => row.direction === "FALL").length;
  const agreement = windows.length
    ? clamp((Math.max(riseVotes, fallVotes) / windows.length) * 100)
    : 0;

  return {
    direction: signed > 8 ? "RISE" : signed < -8 ? "FALL" : "NEUTRAL",
    signedScore: clamp(signed, -100, 100),
    strength: clamp(Math.abs(signed)),
    agreement,
    windows,
  };
}

function volatilityAnalysis(returns = []) {
  const shortSample = returns.slice(-12);
  const longSample = returns.slice(-50);
  const shortVol = stdDev(shortSample);
  const longVol = stdDev(longSample);
  const ratio = longVol > 0 ? shortVol / longVol : 1;
  const jump = returns.length
    ? Math.abs(returns[returns.length - 1]) / Math.max(longVol, 1e-9)
    : 0;

  let state = "NORMAL";
  if (ratio >= 1.65 || jump >= 3.2) state = "BURST";
  else if (ratio <= 0.58) state = "QUIET";
  else if (ratio >= 1.25) state = "EXPANDING";
  else if (ratio <= 0.78) state = "CONTRACTING";

  const stability = clamp(100 - Math.abs(ratio - 1) * 72 - Math.max(0, jump - 2) * 12);

  return {
    shortVol,
    longVol,
    ratio,
    jump,
    state,
    stability,
  };
}

function changePointAnalysis(returns = []) {
  if (returns.length < 30) {
    return { detected: false, score: 0, direction: "NEUTRAL" };
  }

  const recent = returns.slice(-12);
  const prior = returns.slice(-36, -12);
  const pooled = Math.max(stdDev([...recent, ...prior]), 1e-9);
  const meanShift = Math.abs(mean(recent) - mean(prior)) / pooled;
  const volShift = Math.abs(stdDev(recent) - stdDev(prior)) / pooled;
  const score = clamp(meanShift * 34 + volShift * 26);

  return {
    detected: score >= 62,
    score,
    direction:
      mean(recent) > mean(prior)
        ? "RISE"
        : mean(recent) < mean(prior)
        ? "FALL"
        : "NEUTRAL",
  };
}

function sequenceAnalysis(returns = []) {
  const directions = returns.map((value) => sign(value)).filter(Boolean);
  if (directions.length < 12) {
    return {
      direction: "NEUTRAL",
      persistence: 50,
      reversal: 50,
      confidence: 0,
      streak: 0,
    };
  }

  let same = 1;
  let changed = 1;
  for (let index = 1; index < directions.length; index += 1) {
    if (directions[index] === directions[index - 1]) same += 1;
    else changed += 1;
  }

  const persistence = (same / (same + changed)) * 100;
  const reversal = 100 - persistence;
  const last = directions[directions.length - 1];
  let streak = 1;

  for (let index = directions.length - 2; index >= 0; index -= 1) {
    if (directions[index] !== last) break;
    streak += 1;
  }

  const trendBias = persistence - 50;
  const streakPenalty = Math.max(0, streak - 4) * 4;
  const confidence = clamp(50 + Math.abs(trendBias) * 2 - streakPenalty);
  const continuation = persistence >= 54;
  const predictedSign = continuation ? last : -last;

  return {
    direction: predictedSign > 0 ? "RISE" : "FALL",
    persistence,
    reversal,
    confidence,
    streak,
  };
}

function autocorrelationAnalysis(returns = []) {
  const sample = returns.slice(-80);
  let bestLag = 0;
  let best = 0;

  for (let lag = 1; lag <= 12; lag += 1) {
    const value = correlation(sample, lag);
    if (Math.abs(value) > Math.abs(best)) {
      best = value;
      bestLag = lag;
    }
  }

  let forecast = 0;
  if (bestLag > 0 && sample.length > bestLag) {
    const lagValue = sample[sample.length - bestLag];
    forecast = best >= 0 ? lagValue : -lagValue;
  }

  return {
    lag: bestLag,
    value: best,
    strength: clamp(Math.abs(best) * 150),
    direction: forecast > 0 ? "RISE" : forecast < 0 ? "FALL" : "NEUTRAL",
  };
}

function entropyAnalysis(digits = []) {
  if (!digits.length) {
    return {
      normalized: 100,
      uniformity: 0,
      chiSquare: 0,
      label: "UNKNOWN",
      counts: Array(10).fill(0),
    };
  }

  const counts = Array(10).fill(0);
  digits.forEach((digit) => {
    if (digit >= 0 && digit <= 9) counts[digit] += 1;
  });

  const entropy = counts.reduce((total, count) => {
    if (!count) return total;
    const probability = count / digits.length;
    return total - probability * Math.log(probability);
  }, 0);
  const normalized = clamp((entropy / Math.log(10)) * 100);
  const expected = digits.length / 10;
  const chiSquare = expected > 0
    ? counts.reduce((total, count) => total + ((count - expected) ** 2) / expected, 0)
    : 0;
  const uniformity = clamp(100 - chiSquare * 3.2);

  return {
    normalized,
    uniformity,
    chiSquare,
    label:
      normalized >= 97
        ? "HIGH RANDOMNESS"
        : normalized >= 92
        ? "BALANCED"
        : "LOCAL BIAS",
    counts,
  };
}

function smoothedDistribution(digits = [], alpha = 1.2) {
  const counts = Array(10).fill(alpha);
  digits.forEach((digit) => {
    if (digit >= 0 && digit <= 9) counts[digit] += 1;
  });
  const total = counts.reduce((sum, value) => sum + value, 0);
  return counts.map((value) => (value / total) * 100);
}

function transitionDistribution(digits = [], alpha = 1.5) {
  const last = digits[digits.length - 1];
  const counts = Array(10).fill(alpha);
  let observed = 0;

  for (let index = 0; index < digits.length - 1; index += 1) {
    if (digits[index] === last) {
      counts[digits[index + 1]] += 1;
      observed += 1;
    }
  }

  const total = counts.reduce((sum, value) => sum + value, 0);
  return {
    lastDigit: Number.isFinite(last) ? last : null,
    observed,
    probabilities: counts.map((value) => (value / total) * 100),
  };
}

function probabilityForSetup(probabilities = [], setup = "") {
  const value = String(setup || "").toUpperCase().trim();

  if (value === "EVEN") {
    return [0, 2, 4, 6, 8].reduce((sum, digit) => sum + probabilities[digit], 0);
  }

  if (value === "ODD") {
    return [1, 3, 5, 7, 9].reduce((sum, digit) => sum + probabilities[digit], 0);
  }

  const match = value.match(/^(OVER|UNDER|MATCH|DIFFERS)\s*(\d)$/);
  if (!match) return 50;

  const [, action, digitText] = match;
  const digit = Number(digitText);

  if (action === "OVER") {
    return probabilities
      .slice(digit + 1)
      .reduce((sum, probability) => sum + probability, 0);
  }

  if (action === "UNDER") {
    return probabilities
      .slice(0, digit)
      .reduce((sum, probability) => sum + probability, 0);
  }

  if (action === "MATCH") return probabilities[digit] || 0;
  return 100 - (probabilities[digit] || 0);
}

function baselineForSetup(setup = "") {
  const value = String(setup || "").toUpperCase().trim();
  if (["RISE", "FALL", "EVEN", "ODD"].includes(value)) return 50;

  const match = value.match(/^(OVER|UNDER|MATCH|DIFFERS)\s*(\d)$/);
  if (!match) return 50;

  const [, action, digitText] = match;
  const digit = Number(digitText);
  if (action === "OVER") return (9 - digit) * 10;
  if (action === "UNDER") return digit * 10;
  if (action === "MATCH") return 10;
  return 90;
}

function digitSetupScores(digits = [], entropy = {}) {
  const global = smoothedDistribution(digits.slice(-80), 1.2);
  const recent = smoothedDistribution(digits.slice(-28), 1.5);
  const transition = transitionDistribution(digits.slice(-100), 1.5);
  const transitionWeight = clamp((transition.observed / 12) * 0.35, 0, 0.35);
  const recentWeight = 0.3;
  const globalWeight = 1 - transitionWeight - recentWeight;
  const combined = global.map(
    (probability, digit) =>
      probability * globalWeight +
      recent[digit] * recentWeight +
      transition.probabilities[digit] * transitionWeight
  );

  const setups = ["EVEN", "ODD"];
  for (let digit = 0; digit <= 8; digit += 1) setups.push(`OVER ${digit}`);
  for (let digit = 1; digit <= 9; digit += 1) setups.push(`UNDER ${digit}`);
  for (let digit = 0; digit <= 9; digit += 1) {
    setups.push(`MATCH ${digit}`, `DIFFERS ${digit}`);
  }

  const scores = {};
  setups.forEach((setup) => {
    const probability = probabilityForSetup(combined, setup);
    const baseline = baselineForSetup(setup);
    const edge = probability - baseline;
    const entropyPenalty = Math.max(0, Number(entropy.normalized || 100) - 96) * 1.4;
    const transitionBonus = Math.min(8, transition.observed * 0.65);
    const support = clamp(50 + edge * 5.4 + transitionBonus - entropyPenalty);

    scores[setup] = {
      setup,
      probability,
      baseline,
      edge,
      score: support,
      direction: edge >= 0 ? setup : "WAIT",
      detail: `${probability.toFixed(1)}% vs ${baseline.toFixed(1)}% baseline`,
    };
  });

  return {
    scores,
    combined,
    transition,
  };
}

function directionalScores({
  momentum,
  cycle,
  autocorrelation,
  sequence,
  volatility,
  changePoint,
  prices,
}) {
  const trendEfficiency = efficiencyRatio(prices.slice(-30));
  const directionValue = (direction) =>
    direction === "RISE" ? 1 : direction === "FALL" ? -1 : 0;

  const weighted =
    directionValue(momentum.direction) * momentum.strength * 0.34 +
    directionValue(cycle.direction) * cycle.strength * 0.22 +
    directionValue(autocorrelation.direction) * autocorrelation.strength * 0.17 +
    directionValue(sequence.direction) * sequence.confidence * 0.15 +
    directionValue(changePoint.direction) * changePoint.score * 0.12;

  const volatilityPenalty =
    volatility.state === "BURST" ? 16 : volatility.state === "EXPANDING" ? 7 : 0;
  const efficiencyBonus = trendEfficiency * 0.16;
  const absolute = clamp(Math.abs(weighted) + efficiencyBonus - volatilityPenalty);
  const preferred = weighted >= 0 ? "RISE" : "FALL";
  const riseScore = clamp(50 + weighted * 0.5 + efficiencyBonus - volatilityPenalty);
  const fallScore = clamp(50 - weighted * 0.5 + efficiencyBonus - volatilityPenalty);

  return {
    preferred,
    strength: absolute,
    trendEfficiency,
    scores: {
      RISE: {
        setup: "RISE",
        score: riseScore,
        edge: riseScore - 50,
        probability: riseScore,
        baseline: 50,
        direction: preferred,
        detail: `${momentum.direction} momentum · ${cycle.period || "—"}-tick observed cycle`,
      },
      FALL: {
        setup: "FALL",
        score: fallScore,
        edge: fallScore - 50,
        probability: fallScore,
        baseline: 50,
        direction: preferred,
        detail: `${momentum.direction} momentum · ${cycle.period || "—"}-tick observed cycle`,
      },
    },
  };
}

function classifyRegime({ momentum, cycle, volatility, entropy, changePoint }) {
  if (volatility.state === "BURST" || changePoint.detected) return "REGIME SHIFT";
  if (momentum.strength >= 62 && momentum.agreement >= 75) return "TRENDING";
  if (cycle.strength >= 58 && entropy.normalized < 97) return "CYCLIC";
  if (volatility.state === "QUIET") return "QUIET BUILDUP";
  if (entropy.normalized >= 98 && cycle.strength < 35) return "RANDOM / NO EDGE";
  return "MIXED";
}

export function analyzeSyntheticIntelligence(snapshot = {}) {
  const prices = getPrices(snapshot);
  const digits = getDigits(snapshot, prices);
  const returns = returnsOf(prices);
  const momentum = momentumAnalysis(prices, returns);
  const volatility = volatilityAnalysis(returns);
  const changePoint = changePointAnalysis(returns);
  const sequence = sequenceAnalysis(returns);
  const autocorrelation = autocorrelationAnalysis(returns);
  const cycle = spectralCycle(returns);
  const entropy = entropyAnalysis(digits);
  const directional = directionalScores({
    momentum,
    cycle,
    autocorrelation,
    sequence,
    volatility,
    changePoint,
    prices,
  });
  const digitLayer = digitSetupScores(digits, entropy);
  const setupScores = {
    ...digitLayer.scores,
    ...directional.scores,
  };
  const dataQuality = clamp(
    Math.min(100, prices.length * 1.45) * 0.55 +
      Math.min(100, digits.length * 1.25) * 0.45
  );
  const regime = classifyRegime({
    momentum,
    cycle,
    volatility,
    entropy,
    changePoint,
  });

  const rankedSafe = [...SAFE_AUTO_SETUPS]
    .map((setup) => setupScores[setup])
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.edge - a.edge);
  const best = rankedSafe[0] || {
    setup: "WAIT",
    score: 0,
    edge: 0,
    detail: "Insufficient data",
  };
  const second = rankedSafe[1] || { score: 0 };
  const separation = Math.max(0, best.score - second.score);
  const directionalBest = ["RISE", "FALL"].includes(best.setup);
  const directionVotes = directionalBest
    ? [
        momentum.direction,
        cycle.direction,
        autocorrelation.direction,
        sequence.direction,
        changePoint.score >= 45 ? changePoint.direction : "NEUTRAL",
      ].filter((direction) => direction === best.setup).length
    : 0;
  const supportAgreement = directionalBest
    ? clamp((directionVotes / 5) * 100)
    : clamp(
        Math.min(100, Number(digitLayer.transition.observed || 0) * 9) * 0.45 +
          Math.min(100, Math.max(0, best.edge) * 12) * 0.35 +
          Math.min(100, separation * 10) * 0.2
      );
  const consensus = clamp(
    best.score * 0.35 +
      dataQuality * 0.15 +
      volatility.stability * 0.15 +
      Math.min(100, separation * 8) * 0.1 +
      (100 - changePoint.score) * 0.1 +
      supportAgreement * 0.15
  );
  const setupSpecificFast = directionalBest
    ? directionVotes >= 4 && momentum.agreement >= 75
    : Number(digitLayer.transition.observed || 0) >= 7 &&
      entropy.normalized <= 97.5 &&
      best.edge >= 4;
  const fastLane =
    best.score >= 88 &&
    consensus >= 84 &&
    separation >= 8 &&
    dataQuality >= 75 &&
    setupSpecificFast &&
    volatility.state !== "BURST" &&
    !changePoint.detected;

  return {
    version: "V12_DEEP_CYCLE",
    sampleSize: prices.length,
    digitSamples: digits.length,
    dataQuality,
    regime,
    momentum,
    volatility,
    changePoint,
    sequence,
    autocorrelation,
    cycle,
    entropy,
    transition: digitLayer.transition,
    directional,
    setupScores,
    bestSetup: best.setup,
    bestScore: best.score,
    bestEdge: best.edge,
    bestDetail: best.detail,
    separation,
    supportAgreement,
    consensus,
    fastLane,
    components: [
      {
        key: "momentum",
        label: "Multi-window momentum",
        score: momentum.strength,
        detail: `${momentum.direction} · ${momentum.agreement.toFixed(0)}% agreement`,
      },
      {
        key: "cycle",
        label: "Observed cycle detector",
        score: cycle.strength,
        detail: `${cycle.period || "—"} ticks · ${cycle.direction}`,
      },
      {
        key: "autocorrelation",
        label: "Autocorrelation",
        score: autocorrelation.strength,
        detail: `lag ${autocorrelation.lag || "—"} · ${autocorrelation.direction}`,
      },
      {
        key: "sequence",
        label: "Sequence behaviour",
        score: sequence.confidence,
        detail: `${sequence.direction} · streak ${sequence.streak}`,
      },
      {
        key: "entropy",
        label: "Digit entropy",
        score: 100 - entropy.normalized,
        detail: `${entropy.label} · ${entropy.normalized.toFixed(1)}% entropy`,
      },
      {
        key: "regime",
        label: "Regime stability",
        score: volatility.stability,
        detail: `${regime} · ${volatility.state}`,
      },
    ],
  };
}

export function evaluateSyntheticSetup(
  intelligence = {},
  setup = "",
  options = {}
) {
  const normalized = String(setup || "").toUpperCase().trim();
  const scoreRow = intelligence?.setupScores?.[normalized];
  const minimumScore = Number(options.minimumScore ?? 70);
  const dataQuality = Number(intelligence?.dataQuality || 0);
  const score = Number(scoreRow?.score || 0);
  const edge = Number(scoreRow?.edge || 0);
  const directional = ["RISE", "FALL"].includes(normalized);
  const digitContract = !directional;
  const entropy = Number(intelligence?.entropy?.normalized || 100);
  const regime = String(intelligence?.regime || "UNKNOWN");
  const volatilityState = String(intelligence?.volatility?.state || "UNKNOWN");
  const changePoint = Boolean(intelligence?.changePoint?.detected);

  if (!scoreRow) {
    return {
      approved: false,
      score: 0,
      edge: 0,
      fastLane: false,
      reason: `Deep intelligence has no score for ${normalized || "this setup"}.`,
    };
  }

  const minimumData = directional ? 48 : 62;
  if (dataQuality < minimumData) {
    return {
      approved: false,
      score,
      edge,
      fastLane: false,
      reason: `Deep intelligence collecting data: ${dataQuality.toFixed(0)}%/${minimumData}%.`,
    };
  }

  if (volatilityState === "BURST" || changePoint) {
    return {
      approved: false,
      score,
      edge,
      fastLane: false,
      reason: `Deep intelligence paused for ${regime.toLowerCase()}.`,
    };
  }

  if (digitContract && entropy >= 99.2 && edge < 4.5) {
    return {
      approved: false,
      score,
      edge,
      fastLane: false,
      reason: `Digit entropy is too random for ${normalized} (${entropy.toFixed(1)}%).`,
    };
  }

  const approved = score >= minimumScore && edge >= (directional ? 7 : 2.2);
  const fastLane =
    approved &&
    Boolean(intelligence?.fastLane) &&
    normalized === String(intelligence?.bestSetup || "").toUpperCase() &&
    score >= 88 &&
    Number(intelligence?.consensus || 0) >= 84 &&
    dataQuality >= 75 &&
    !changePoint &&
    volatilityState !== "BURST";

  return {
    approved,
    score,
    edge,
    probability: Number(scoreRow.probability || 0),
    baseline: Number(scoreRow.baseline || 0),
    fastLane,
    reason: approved
      ? `${normalized} deep score ${score.toFixed(1)}% · ${scoreRow.detail}`
      : `Deep score ${score.toFixed(1)}% is below ${minimumScore}% for ${normalized}.`,
  };
}

export default analyzeSyntheticIntelligence;
