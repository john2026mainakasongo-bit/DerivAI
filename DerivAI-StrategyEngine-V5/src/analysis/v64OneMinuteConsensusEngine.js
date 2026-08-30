
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

function setupName(mode, digit) {
  if (mode === "EVEN" || mode === "ODD") return mode;
  return `${mode} ${digit}`;
}

function definitions() {
  return [
    ...[1, 2, 3, 4, 5, 6].map((digit) => ({ mode: "OVER", digit })),
    ...[3, 4, 5, 6, 7, 8].map((digit) => ({ mode: "UNDER", digit })),
    { mode: "EVEN", digit: null },
    { mode: "ODD", digit: null },
    ...Array.from({ length: 10 }, (_, digit) => ({ mode: "MATCH", digit })),
    ...Array.from({ length: 10 }, (_, digit) => ({ mode: "DIFFERS", digit })),
  ];
}

function fairProbability(mode, digit = null) {
  if (mode === "MATCH") return 0.1;
  if (mode === "DIFFERS") return 0.9;
  if (mode === "EVEN" || mode === "ODD") return 0.5;
  if (mode === "OVER") return (9 - Number(digit)) / 10;
  if (mode === "UNDER") return Number(digit) / 10;
  return 0.5;
}

function winFor(digitValue, mode, digit = null) {
  if (mode === "MATCH") return digitValue === digit;
  if (mode === "DIFFERS") return digitValue !== digit;
  if (mode === "EVEN") return digitValue % 2 === 0;
  if (mode === "ODD") return digitValue % 2 === 1;
  if (mode === "OVER") return digitValue > digit;
  if (mode === "UNDER") return digitValue < digit;
  return false;
}

function weightedProbability(digits, mode, digit = null) {
  if (!digits.length) return fairProbability(mode, digit);

  let weight = 1;
  let totalWeight = 0;
  let winWeight = 0;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const value = digits[index];

    if (winFor(value, mode, digit)) {
      winWeight += weight;
    }

    totalWeight += weight;
    weight *= 0.985;
  }

  return totalWeight ? winWeight / totalWeight : fairProbability(mode, digit);
}

function transitionProbability(digits, mode, digit = null) {
  if (digits.length < 4) return fairProbability(mode, digit);

  const last = digits[digits.length - 1];
  let seen = 0;
  let wins = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index - 1] !== last) continue;

    seen += 1;
    if (winFor(digits[index], mode, digit)) wins += 1;
  }

  return seen ? (wins + 1) / (seen + 2) : weightedProbability(digits, mode, digit);
}

function runLengthSignal(digits, mode, digit = null) {
  if (digits.length < 3) return 50;

  let streak = 0;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (winFor(digits[index], mode, digit)) streak += 1;
    else break;
  }

  return clamp(50 + Math.min(5, streak) * 8);
}

function parityStability(digits) {
  if (digits.length < 20) return 50;

  const sample = digits.slice(-60);
  const even = sample.filter((digit) => digit % 2 === 0).length / sample.length;
  return clamp(100 - Math.abs(even - 0.5) * 200);
}

function thresholdStability(digits, mode, digit = null) {
  if (digits.length < 20) return 50;

  const windows = [20, 40, 60]
    .map((size) => digits.slice(-Math.min(size, digits.length)))
    .filter((window) => window.length >= 10);

  const probabilities = windows.map(
    (window) =>
      window.filter((value) => winFor(value, mode, digit)).length / window.length
  );

  const max = Math.max(...probabilities);
  const min = Math.min(...probabilities);

  return clamp((1 - (max - min) / 0.16) * 100);
}

function autocorrelation(digits, lag = 1) {
  if (digits.length < lag + 12) return 0;

  const x = digits.slice(lag);
  const y = digits.slice(0, -lag);
  const meanX = x.reduce((a, b) => a + b, 0) / x.length;
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < x.length; i += 1) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denominator = Math.sqrt(denomX * denomY);
  return denominator ? numerator / denominator : 0;
}

function chiSquareDeviation(digits) {
  if (digits.length < 30) return 0;

  const counts = Array.from({ length: 10 }, () => 0);
  digits.forEach((digit) => {
    counts[digit] += 1;
  });

  const expected = digits.length / 10;
  let chi = 0;

  for (const count of counts) {
    chi += ((count - expected) ** 2) / Math.max(1, expected);
  }

  return clamp(chi * 6);
}

function bayesianProbability(observed, baseline, sampleSize) {
  const priorStrength =
    sampleSize < 40 ? 150 :
    sampleSize < 80 ? 100 :
    70;

  return (
    observed * sampleSize +
    baseline * priorStrength
  ) / (sampleSize + priorStrength);
}

function conservativeEv(probability, baseline) {
  const payoutMultiplier = (1 / Math.max(0.01, baseline)) * 0.95;
  return probability * payoutMultiplier - 1;
}

function backtestCandidate(digits, mode, digit = null) {
  if (digits.length < 45) {
    return {
      trades: 0,
      wins: 0,
      winRate: 0,
      profitUnits: 0,
      passed: false,
    };
  }

  const test = digits.slice(-Math.min(120, digits.length));
  const baseline = fairProbability(mode, digit);
  const payout = (1 / Math.max(0.01, baseline)) * 0.95;
  let wins = 0;

  for (const value of test) {
    if (winFor(value, mode, digit)) wins += 1;
  }

  const losses = test.length - wins;
  const profitUnits = wins * (payout - 1) - losses;
  const winRate = wins / test.length;

  return {
    trades: test.length,
    wins,
    winRate: winRate * 100,
    profitUnits,
    passed:
      profitUnits > 1.5 &&
      winRate > baseline + 0.015,
  };
}

export function rankV64ConsensusContracts({
  digitHistory = [],
  allowHighRisk = false,
  minimumConfidence = 82,
} = {}) {
  const digits = validDigits(digitHistory);
  const sampleSize = digits.length;

  if (sampleSize < 30) {
    return {
      ready: false,
      sampleSize,
      best: null,
      candidates: [],
      reason: `One-minute warm-up: ${sampleSize}/30 ticks.`,
    };
  }

  const oneMinute = digits.slice(-Math.min(120, digits.length));
  const auto1 = autocorrelation(oneMinute, 1);
  const auto2 = autocorrelation(oneMinute, 2);
  const chiDeviation = chiSquareDeviation(oneMinute);
  const parity = parityStability(oneMinute);

  const candidates = definitions().map(({ mode, digit }) => {
    const baseline = fairProbability(mode, digit);
    const recent30 = digits.slice(-30);
    const recent60 = digits.slice(-60);
    const recent120 = digits.slice(-120);

    const p30 = weightedProbability(recent30, mode, digit);
    const p60 = weightedProbability(recent60, mode, digit);
    const p120 = weightedProbability(recent120, mode, digit);
    const transition = transitionProbability(recent120, mode, digit);

    const observed =
      p30 * 0.45 +
      p60 * 0.3 +
      p120 * 0.15 +
      transition * 0.1;

    const probability = bayesianProbability(
      observed,
      baseline,
      sampleSize
    );

    const edge = probability - baseline;
    const ev = conservativeEv(probability, baseline);
    const highRisk = mode === "MATCH" || mode === "DIFFERS";
    const stability = thresholdStability(digits, mode, digit);
    const runSignal = runLengthSignal(digits, mode, digit);
    const backtest = backtestCandidate(digits, mode, digit);

    const autocorrelationScore = clamp(
      50 + Math.abs(auto1) * 120 + Math.abs(auto2) * 80
    );

    const distributionScore = clamp(
      50 + chiDeviation * 0.45
    );

    const parityScore =
      mode === "EVEN" || mode === "ODD"
        ? parity
        : 50;

    const votes = [
      ev >= (highRisk ? 0.12 : 0.02),
      edge >= (highRisk ? 0.035 : 0.015),
      transition >= baseline + (highRisk ? 0.035 : 0.012),
      stability >= (highRisk ? 78 : 68),
      runSignal >= 58,
      autocorrelationScore >= 58,
      distributionScore >= 56,
      parityScore >= 55 || (mode !== "EVEN" && mode !== "ODD"),
      backtest.passed,
      sampleSize >= (highRisk ? 300 : 45),
    ];

    const voteCount = votes.filter(Boolean).length;

    let confidence =
      55 +
      ev * 180 +
      edge * 280 +
      (stability - 50) * 0.14 +
      (voteCount - 5) * 4 +
      (backtest.passed ? 8 : 0);

    if (highRisk) {
      confidence -= 12;
      confidence = Math.min(86, confidence);
    } else {
      confidence = Math.min(96, confidence);
    }

    confidence = clamp(confidence);

    const executable =
      voteCount >= (highRisk ? 9 : 7) &&
      ev >= (highRisk ? 0.12 : 0.02) &&
      edge >= (highRisk ? 0.035 : 0.015) &&
      stability >= (highRisk ? 78 : 68) &&
      backtest.passed &&
      confidence >= minimumConfidence &&
      (!highRisk || allowHighRisk);

    return {
      setup: setupName(mode, digit),
      mode,
      digit,
      highRisk,
      sampleSize,
      probability: probability * 100,
      baseline: baseline * 100,
      probabilityEdge: edge * 100,
      expectedValue: ev * 100,
      transitionProbability: transition * 100,
      consistency: stability,
      qualityScore: confidence,
      confidence,
      voteCount,
      totalVotes: votes.length,
      backtestTrades: backtest.trades,
      backtestWinRate: backtest.winRate,
      backtestProfitUnits: backtest.profitUnits,
      executable,
      source: "V64 ONE-MINUTE CONSENSUS",
      detail:
        `${setupName(mode, digit)} · ${voteCount}/${votes.length} votes · ` +
        `EV ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}% · ` +
        `BT ${backtest.winRate.toFixed(1)}%.`,
    };
  });

  candidates.sort((left, right) => {
    if (left.executable !== right.executable) {
      return left.executable ? -1 : 1;
    }

    return (
      right.voteCount - left.voteCount ||
      right.expectedValue - left.expectedValue ||
      right.backtestProfitUnits - left.backtestProfitUnits ||
      right.qualityScore - left.qualityScore
    );
  });

  const best =
    candidates.find((candidate) => candidate.executable) || null;

  return {
    ready: sampleSize >= 45,
    sampleSize,
    best,
    candidates,
    reason: best
      ? `EXECUTE ${best.setup}: ${best.voteCount}/${best.totalVotes} analyses agree.`
      : sampleSize < 45
        ? `Collecting one-minute evidence: ${sampleSize}/45.`
        : "WAIT: no setup has enough consensus and positive backtest EV.",
  };
}
