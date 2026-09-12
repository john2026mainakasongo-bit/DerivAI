const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(avg(a.map((v) => (v - m) ** 2)));
};
const ema = (a, p) => {
  if (!a.length) return 0;
  const k = 2 / (p + 1);
  let x = a[0];
  for (let i = 1; i < a.length; i += 1) x = a[i] * k + x * (1 - k);
  return x;
};
const rsi = (a, p = 14) => {
  if (a.length <= p) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = a.length - p; i < a.length; i += 1) {
    const d = a[i] - a[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  return losses ? 100 - 100 / (1 + gains / losses) : 100;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

const featureAt = (a, i) => {
  const end = i + 1;
  const short = a.slice(Math.max(0, end - 12), end);
  const med = a.slice(Math.max(0, end - 30), end);
  const long = a.slice(Math.max(0, end - 80), end);
  if (short.length < 12 || med.length < 20 || long.length < 40) return null;

  const tick = avg(long.slice(1).map((v, j) => Math.abs(v - long[j]))) || 1e-9;
  const e9 = ema(long.slice(-40), 9);
  const e21 = ema(long.slice(-60), 21);
  const eGap = (e9 - e21) / tick;
  const m8 = (short.at(-1) - short[0]) / (tick * Math.sqrt(8));
  const m20 = (med.at(-1) - med[0]) / (tick * Math.sqrt(20));
  const recent = short.slice(1).map((v, j) => v - short[j]);
  const vol = sd(recent) / tick;
  const extension = Math.abs(short.at(-1) - e9) / tick;
  const rv = rsi(long);
  const persistence = (() => {
    let same = 0, moves = 0, prev = 0;
    for (let j = 1; j < med.length; j += 1) {
      const d = sign(med[j] - med[j - 1]);
      if (!d) continue;
      if (prev && d === prev) same += 1;
      prev = d;
      moves += 1;
    }
    return moves > 1 ? same / (moves - 1) : 0;
  })();

  return {
    direction: sign(eGap + m8 * 0.35 + m20 * 0.25),
    eGap, m8, m20, vol, extension, rsi: rv, persistence,
  };
};

const featureDistance = (x, y) => {
  if (!x || !y) return Infinity;
  const parts = [
    [x.direction, y.direction, 1.4],
    [x.eGap, y.eGap, 0.45],
    [x.m8, y.m8, 0.55],
    [x.m20, y.m20, 0.40],
    [x.vol, y.vol, 0.35],
    [x.extension, y.extension, 0.25],
    [(x.rsi - 50) / 20, (y.rsi - 50) / 20, 0.35],
    [x.persistence, y.persistence, 0.35],
  ];
  return Math.sqrt(parts.reduce((s, [a, b, w]) => s + ((a - b) * w) ** 2, 0));
};

/*
 * Estimate the probability of the next N-tick direction using historical
 * situations that looked like the current market. This is deliberately
 * conservative: only sufficiently similar historical states contribute and
 * the result is shrunk toward 50%.
 */
const conditionalProbability = (values, currentFeature, horizon = 5, direction = 1) => {
  if (!currentFeature || values.length < 180) return 0.5;
  const candidates = [];
  const start = 80;
  const end = values.length - Math.max(2, horizon);
  for (let i = start; i < end; i += 2) {
    const f = featureAt(values, i);
    if (!f || sign(f.direction) !== direction) continue;
    const future = values[i + horizon] - values[i];
    const outcome = sign(future) === direction ? 1 : 0;
    const distance = featureDistance(currentFeature, f);
    if (distance < 2.0) candidates.push({ distance, outcome });
  }
  if (candidates.length < 12) return 0.5;
  candidates.sort((a, b) => a.distance - b.distance);
  const nearest = candidates.slice(0, 40);
  let weight = 0;
  let wins = 0;
  for (const item of nearest) {
    const w = 1 / (0.20 + item.distance ** 2);
    weight += w;
    wins += item.outcome * w;
  }
  const raw = wins / Math.max(weight, 1e-9);
  const confidence = clamp((nearest.length - 12) / 28, 0, 1);
  return clamp(0.5 + (raw - 0.5) * (0.35 + confidence * 0.65), 0.35, 0.65);
};

export function analyzeAdaptiveTrend(prices = [], options = {}) {
  const v = prices
    .map((x) => Number(x?.quote ?? x))
    .filter(Number.isFinite)
    .slice(-600);

  const horizon = Math.max(2, Math.round(Number(options.duration) || 5));
  const minSamples = 100;

  if (v.length < minSamples) {
    return {
      ready: false, signal: "WAIT", grade: "BUILDING", score: 0, confidence: 0,
      probability: 0.5, trend: "WAITING", momentum: "WAITING",
      pullback: "WAITING", volatility: "WAITING", reason: `Collecting market data ${v.length}/${minSamples}`, rsi: 50,
    };
  }

  const cur = v.at(-1);
  const long = v.slice(-120);
  const short = v.slice(-12);
  const medium = v.slice(-30);
  const tick = avg(long.slice(1).map((x, i) => Math.abs(x - long[i]))) || Math.max(Math.abs(cur) * 1e-7, 1e-9);
  const e9 = ema(long.slice(-60), 9);
  const e21 = ema(long, 21);
  const gap = (e9 - e21) / tick;
  const m8 = (cur - v.at(-9)) / (tick * Math.sqrt(8));
  const m20 = (cur - v.at(-21)) / (tick * Math.sqrt(20));
  const rv = rsi(long);
  const vol = sd(short.slice(1).map((x, i) => x - short[i])) / tick;
  const extension = Math.abs(cur - e9) / tick;

  let same = 0, moves = 0, prev = 0;
  for (let i = 1; i < medium.length; i += 1) {
    const d = sign(medium[i] - medium[i - 1]);
    if (!d) continue;
    if (prev && d === prev) same += 1;
    prev = d;
    moves += 1;
  }
  const persistence = moves > 1 ? same / (moves - 1) : 0;

  const bull = gap > 0.25 && m20 > 0.25;
  const bear = gap < -0.25 && m20 < -0.25;
  const rawDirection = bull && !bear ? "RISE" : bear && !bull ? "FALL" : "WAIT";
  const direction = rawDirection === "RISE" ? 1 : -1;

  const pullback = extension <= 1.25 && extension >= 0.05;
  const momentumAligned = direction && sign(m8) === direction && Math.abs(m8) >= 0.25;
  const rsiAligned = rawDirection === "RISE" ? rv >= 51 && rv <= 68 : rawDirection === "FALL" ? rv <= 49 && rv >= 32 : false;
  const calm = vol >= 0.35 && vol <= 1.85;
  const stable = persistence >= 0.48;

  const historicalP = rawDirection === "WAIT"
    ? 0.5
    : conditionalProbability(v, featureAt(v, v.length), horizon, direction);

  const confirmations = [bull || bear, momentumAligned, pullback, rsiAligned, calm, stable].filter(Boolean).length;
  const probability = rawDirection === "WAIT"
    ? 0.5
    : clamp(0.5 + (historicalP - 0.5) * 1.05 + (confirmations - 3) * 0.012, 0.35, 0.65);

  let score = 48;
  score += Math.min(16, Math.abs(gap) * 3.2);
  score += Math.min(12, Math.abs(m20) * 4);
  score += momentumAligned ? 9 : -8;
  score += pullback ? 9 : -7;
  score += rsiAligned ? 6 : -4;
  score += calm ? 5 : -7;
  score += stable ? 5 : -5;
  score = Math.round(clamp(score, 0, 100));

  const grade = rawDirection !== "WAIT" && score >= 82 && confirmations >= 5 && probability >= 0.56 ? "A+" :
    rawDirection !== "WAIT" && score >= 74 && confirmations >= 4 ? "A" : "WAIT";

  const valid = grade === "A+";
  const signal = valid ? rawDirection : "WAIT";
  const confidence = Math.round(clamp(50 + (score - 50) * 0.9 + (probability - 0.5) * 100, 50, 95));

  return {
    ready: true, signal, rawDirection, grade, score, confidence,
    probability: Number(probability.toFixed(4)),
    trend: bull ? "BULLISH" : bear ? "BEARISH" : "MIXED",
    momentum: m8 > 0.2 ? "UP" : m8 < -0.2 ? "DOWN" : "FLAT",
    pullback: pullback ? "READY" : "WAITING",
    volatility: vol > 1.85 ? "HIGH" : vol < 0.35 ? "LOW" : "NORMAL",
    rsi: rv, emaFast: e9, emaSlow: e21, persistence,
    confirmations, horizon,
    reason: valid
      ? `${rawDirection} A+ · ${confirmations}/6 confirmations · historical-state probability ${(probability * 100).toFixed(1)}%.`
      : `Waiting · ${confirmations}/6 confirmations · probability ${(probability * 100).toFixed(1)}%.`,
  };
}
export default analyzeAdaptiveTrend;
