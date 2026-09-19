const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map((v) => (v - m) ** 2))); };
const ema = (a, p) => { if (!a.length) return 0; const k = 2 / (p + 1); let x = a[0]; for (let i = 1; i < a.length; i += 1) x = a[i] * k + x * (1 - k); return x; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const rsi = (a, p = 14) => {
  if (a.length <= p) return 50;
  let g = 0; let l = 0;
  for (let i = a.length - p; i < a.length; i += 1) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
  if (!l && !g) return 50;
  return l ? 100 - 100 / (1 + g / l) : 100;
};

// V7 deliberately separates feature construction from outcome construction.
// Every historical sample is formed only from prices BEFORE the prediction tick.
export function featuresAt(values, i) {
  const end = i + 1;
  const short = values.slice(Math.max(0, end - 12), end);
  const medium = values.slice(Math.max(0, end - 30), end);
  const long = values.slice(Math.max(0, end - 100), end);
  if (short.length < 12 || medium.length < 24 || long.length < 60) return null;

  const tick = avg(long.slice(1).map((v, j) => Math.abs(v - long[j]))) || 1e-9;
  const e8 = ema(long.slice(-50), 8);
  const e21 = ema(long, 21);
  const e50 = ema(long, 50);
  const m6 = (short.at(-1) - short.at(-7)) / (tick * Math.sqrt(6));
  const m18 = (medium.at(-1) - medium.at(-19)) / (tick * Math.sqrt(18));
  const gapFast = (e8 - e21) / tick;
  const gapSlow = (e21 - e50) / tick;
  const vol = sd(short.slice(1).map((v, j) => v - short[j])) / tick;
  const extension = Math.abs(short.at(-1) - e8) / tick;
  const rv = rsi(long);
  let same = 0; let moves = 0; let prev = 0;
  for (let j = 1; j < medium.length; j += 1) {
    const d = sign(medium[j] - medium[j - 1]);
    if (!d) continue;
    if (prev && d === prev) same += 1;
    prev = d; moves += 1;
  }
  const persistence = moves > 1 ? same / (moves - 1) : 0;
  const direction = sign(gapFast * 0.9 + gapSlow * 0.65 + m6 * 0.45 + m18 * 0.35);
  const regime = Math.abs(gapSlow) > 0.45 && persistence >= 0.48 ? 'TREND' : vol < 0.35 ? 'QUIET' : 'RANGE';
  return { direction, gapFast, gapSlow, m6, m18, vol, extension, rsi: rv, persistence, regime };
}

const featureDistance = (a, b) => {
  if (!a || !b) return Infinity;
  const parts = [
    [a.direction, b.direction, 1.5], [a.gapFast, b.gapFast, 0.55], [a.gapSlow, b.gapSlow, 0.6],
    [a.m6, b.m6, 0.5], [a.m18, b.m18, 0.45], [a.vol, b.vol, 0.35],
    [a.extension, b.extension, 0.3], [(a.rsi - 50) / 20, (b.rsi - 50) / 20, 0.35],
    [a.persistence, b.persistence, 0.4], [a.regime === b.regime ? 0 : 1, 0, 0.8],
  ];
  return Math.sqrt(parts.reduce((s, [x, y, w]) => s + ((x - y) * w) ** 2, 0));
};

function walkForwardMatches(values, currentIndex, current, horizon, direction) {
  const matches = [];
  // No look-ahead: candidate outcome ends before currentIndex.
  const latestCandidate = currentIndex - horizon;
  for (let i = 100; i <= latestCandidate; i += 1) {
    const f = featuresAt(values, i);
    if (!f || f.direction !== direction || f.regime !== current.regime) continue;
    const distance = featureDistance(current, f);
    if (distance > 2.25) continue;
    const move = values[i + horizon] - values[i];
    const win = direction === 1 ? move > 0 : move < 0;
    matches.push({ distance, win });
  }
  matches.sort((a, b) => a.distance - b.distance);
  return matches.slice(0, 80);
}

function empiricalProbability(matches) {
  if (matches.length < 15) return { probability: 0.5, samples: matches.length, ciHalfWidth: 0.5 };
  // Weighted evidence + Beta(2,2) prior prevents tiny samples producing extreme values.
  let weight = 0; let weightedWins = 0;
  for (const m of matches) {
    const w = 1 / (0.25 + m.distance ** 2);
    weight += w; weightedWins += w * (m.win ? 1 : 0);
  }
  const effectiveWins = weightedWins + 2;
  const effectiveLosses = (weight - weightedWins) + 2;
  const p = effectiveWins / (effectiveWins + effectiveLosses);
  const n = matches.length;
  const ci = 1.96 * Math.sqrt(Math.max(p * (1 - p) / n, 0));
  return { probability: clamp(p, 0.35, 0.65), samples: n, ciHalfWidth: ci };
}

function setupQuality(f, direction) {
  if (!f || f.direction !== direction) return { ok: false, score: 0, reasons: [] };
  const trend = direction === 1 ? f.gapFast > 0.2 && f.gapSlow > 0.15 : f.gapFast < -0.2 && f.gapSlow < -0.15;
  const momentum = direction === 1 ? f.m6 > 0.2 && f.m18 > 0.15 : f.m6 < -0.2 && f.m18 < -0.15;
  const rsiAligned = direction === 1 ? f.rsi >= 50 && f.rsi <= 68 : f.rsi <= 50 && f.rsi >= 32;
  const pullback = f.extension >= 0.05 && f.extension <= 1.4;
  const volatility = f.vol >= 0.35 && f.vol <= 1.8;
  const persistence = f.persistence >= 0.48;
  const reasons = [trend, momentum, rsiAligned, pullback, volatility, persistence];
  return { ok: reasons.filter(Boolean).length >= 5 && f.regime === 'TREND', score: reasons.filter(Boolean).length, reasons };
}

export function analyzeAdaptiveTrend(prices = [], options = {}) {
  const values = prices.map((x) => Number(x?.quote ?? x)).filter(Number.isFinite).slice(-1000);
  const horizon = Math.max(2, Math.min(20, Math.round(Number(options.duration) || 5)));
  const minHistory = Math.max(220, Number(options.minHistory) || 220);
  if (values.length < minHistory) return {
    ready: false, signal: 'WAIT', rawDirection: 'WAIT', grade: 'BUILDING', score: 0, confidence: 0,
    probability: 0.5, lowerProbability: 0.5, samples: 0, trend: 'WAITING', momentum: 'WAITING',
    pullback: 'WAITING', volatility: 'WAITING', regime: 'BUILDING', reason: `Collecting market data ${values.length}/${minHistory}`,
    rsi: 50, horizon, edgeQuality: 'INSUFFICIENT'
  };

  const index = values.length - 1;
  const current = featuresAt(values, index);
  if (!current) return { ready: false, signal: 'WAIT', rawDirection: 'WAIT', grade: 'BUILDING', score: 0, confidence: 0, probability: 0.5, lowerProbability: 0.5, samples: 0, trend: 'WAITING', momentum: 'WAITING', pullback: 'WAITING', volatility: 'WAITING', regime: 'BUILDING', reason: 'Building feature window', rsi: 50, horizon, edgeQuality: 'INSUFFICIENT' };

  const direction = current.direction;
  const rawDirection = direction === 1 ? 'RISE' : direction === -1 ? 'FALL' : 'WAIT';
  if (rawDirection === 'WAIT') return { ready: true, signal: 'WAIT', rawDirection, grade: 'WAIT', score: 0, confidence: 50, probability: 0.5, lowerProbability: 0.5, samples: 0, trend: 'MIXED', momentum: 'FLAT', pullback: 'WAITING', volatility: current.vol < 0.35 ? 'LOW' : 'NORMAL', regime: current.regime, reason: `No directional regime · ${current.regime}`, rsi: current.rsi, horizon, edgeQuality: 'NO_EDGE' };

  const setup = setupQuality(current, direction);
  const matches = walkForwardMatches(values, index, current, horizon, direction);
  const empirical = empiricalProbability(matches);
  const lowerProbability = clamp(empirical.probability - empirical.ciHalfWidth, 0.35, 0.65);

  // Conservative score: probability is never inflated by the technical score.
  const score = Math.round(clamp(40 + setup.score * 9 + Math.min(12, Math.abs(current.gapSlow) * 7) + (current.regime === 'TREND' ? 8 : -12), 0, 100));
  const robustEdge = empirical.samples >= 25 && lowerProbability >= 0.54;
  const grade = setup.ok && empirical.samples >= 25 && empirical.probability >= 0.57 && robustEdge ? 'A+' : setup.score >= 4 && empirical.samples >= 15 ? 'A' : 'WAIT';
  const signal = grade === 'A+' ? rawDirection : 'WAIT';
  const confidence = Math.round(clamp(50 + (score - 50) * 0.65 + (empirical.probability - 0.5) * 65, 50, 92));

  return {
    ready: true, signal, rawDirection, grade, score, confidence,
    probability: Number(empirical.probability.toFixed(4)), lowerProbability: Number(lowerProbability.toFixed(4)),
    samples: empirical.samples, ciHalfWidth: Number(empirical.ciHalfWidth.toFixed(4)),
    trend: current.gapFast * direction > 0.2 ? (direction === 1 ? 'BULLISH' : 'BEARISH') : 'MIXED',
    momentum: current.m6 * direction > 0.2 ? (direction === 1 ? 'UP' : 'DOWN') : 'FLAT',
    pullback: current.extension >= 0.05 && current.extension <= 1.4 ? 'READY' : 'WAITING',
    volatility: current.vol > 1.8 ? 'HIGH' : current.vol < 0.35 ? 'LOW' : 'NORMAL',
    regime: current.regime, rsi: current.rsi, persistence: current.persistence,
    confirmations: setup.score, horizon, edgeQuality: robustEdge ? 'ROBUST' : 'BUILDING',
    reason: signal === 'WAIT'
      ? `WAIT · ${current.regime} · ${setup.score}/6 setup checks · ${(empirical.probability * 100).toFixed(1)}% empirical · lower bound ${(lowerProbability * 100).toFixed(1)}% · ${empirical.samples} walk-forward matches.`
      : `${rawDirection} A+ · ${current.regime} · ${setup.score}/6 setup checks · ${(empirical.probability * 100).toFixed(1)}% empirical · lower bound ${(lowerProbability * 100).toFixed(1)}% · ${empirical.samples} walk-forward matches.`
  };
}

export default analyzeAdaptiveTrend;
