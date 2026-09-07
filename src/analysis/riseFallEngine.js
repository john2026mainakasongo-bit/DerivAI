const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const mean = (a) => (a.length ? a.reduce((sum, value) => sum + value, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};
const slope = (a) => {
  const n = a.length;
  if (n < 3) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(a);
  let p = 0;
  let d = 0;
  for (let i = 0; i < n; i += 1) {
    const x = i - xm;
    p += x * (a[i] - ym);
    d += x * x;
  }
  return d ? p / d : 0;
};
const ema = (a, period) => {
  if (!a.length) return null;
  const k = 2 / (period + 1);
  let value = a[0];
  for (let i = 1; i < a.length; i += 1) value = k * a[i] + (1 - k) * value;
  return value;
};
const dir = (a) => {
  if (a.length < 2) return 0;
  let up = 0;
  let down = 0;
  for (let i = 1; i < a.length; i += 1) {
    const move = a[i] - a[i - 1];
    if (move > 0) up += 1;
    if (move < 0) down += 1;
  }
  return (up - down) / (up + down || 1);
};
const persistence = (a) => {
  let same = 0;
  let moves = 0;
  let previous = 0;
  for (let i = 1; i < a.length; i += 1) {
    const current = Math.sign(a[i] - a[i - 1]);
    if (!current) continue;
    if (previous && current === previous) same += 1;
    previous = current;
    moves += 1;
  }
  return moves > 1 ? same / (moves - 1) : 0;
};
const reversals = (a) => {
  let changes = 0;
  let moves = 0;
  let previous = 0;
  for (let i = 1; i < a.length; i += 1) {
    const current = Math.sign(a[i] - a[i - 1]);
    if (!current) continue;
    if (previous && current !== previous) changes += 1;
    previous = current;
    moves += 1;
  }
  return moves > 1 ? changes / (moves - 1) : 0;
};
const move = (a, n) => {
  if (a.length <= n) return 0;
  const recent = a.slice(-Math.min(a.length, n + 1));
  const noise = std(recent.slice(1).map((v, i) => v - recent[i]));
  return noise ? clamp((a.at(-1) - a.at(-1 - n)) / (noise * Math.sqrt(n)), -3, 3) : 0;
};

export function analyzeRiseFall(prices = [], opts = {}) {
  const a = prices.map(Number).filter(Number.isFinite).slice(-240);
  const minSamples = Number(opts.minimumSamples ?? 60);
  const minConfidence = Number(opts.minimumConfidence ?? 70);

  if (a.length < minSamples) {
    return {
      ready: false,
      signal: "WAIT",
      contractType: null,
      confidence: 0,
      sampleSize: a.length,
      entryReady: false,
      entryScore: 0,
      entryTiming: "LEARNING",
      reason: `Collecting live data ${a.length}/${minSamples}.`,
      features: {},
    };
  }

  const short = a.slice(-12);
  const medium = a.slice(-30);
  const long = a.slice(-80);
  const base = std(long.slice(1).map((v, i) => v - long[i])) || 1;

  const m3 = move(a, 3);
  const m8 = move(a, 8);
  const m20 = move(a, 20);
  const ds = dir(short);
  const dm = dir(medium);
  const ps = persistence(medium);
  const rs = reversals(short);
  const shortSlope = slope(short) / base;
  const mediumSlope = slope(medium) / base;
  const e8 = ema(a.slice(-40), 8);
  const e21 = ema(a.slice(-80), 21);
  const emaGap = (e8 - e21) / base;
  const pricePosition = (a.at(-1) - e21) / base;
  const shortExtension = Math.abs(a.at(-1) - e8) / base;
  const vr = std(short.slice(1).map((v, i) => v - short[i])) / base;

  // Core directional score. Multiple windows are used so a single noisy tick
  // cannot decide the entry on its own.
  let score =
    m3 * 0.18 +
    m8 * 0.22 +
    m20 * 0.15 +
    ds * 0.10 +
    dm * 0.10 +
    clamp(shortSlope, -2, 2) * 0.07 +
    clamp(mediumSlope, -2, 2) * 0.06 +
    clamp(emaGap, -2, 2) * 0.08 +
    clamp(pricePosition / 2, -1, 1) * 0.04;

  const directionSign = Math.sign(score) || 1;
  score += directionSign * (ps - 0.5) * 0.30;
  score -= directionSign * Math.max(0, rs - 0.55) * 0.75;
  score -= directionSign * (vr > 2.35 ? Math.min(0.55, (vr - 2.35) * 0.20) : 0);
  score = clamp(score, -1.8, 1.8);

  const rawDirection = score >= 0 ? "RISE" : "FALL";
  const confidence = clamp(50 + (Math.abs(score) / 1.8) * 45, 50, 95);
  const agreement = [m8, m20, dm, emaGap]
    .map(Math.sign)
    .filter((value) => value === Math.sign(score)).length;
  const volatility = vr > 2.2 ? "HIGH" : vr < 0.60 ? "LOW" : "NORMAL";

  // Entry timing avoids chasing a stretched move while still allowing a clean
  // continuation when momentum, trend and price location agree.
  const trendAligned =
    Math.sign(emaGap || 0) === Math.sign(score) &&
    Math.sign(m20 || 0) === Math.sign(score);
  const pullbackWindow = shortExtension >= 0.08 && shortExtension <= 1.65;
  const notOverextended = shortExtension <= 1.95;
  const reversalSafe = rs < 0.68;
  const entryTiming =
    !notOverextended
      ? "EXTENDED"
      : trendAligned && pullbackWindow
        ? "PRIME"
        : trendAligned
          ? "GOOD"
          : "WAIT";

  const coreQualified =
    confidence >= minConfidence &&
    agreement >= 3 &&
    volatility !== "HIGH" &&
    reversalSafe &&
    notOverextended;

  const timingBonus = entryTiming === "PRIME" ? 5 : entryTiming === "GOOD" ? 2 : 0;
  const entryScore = clamp(
    confidence + agreement * 2 + timingBonus - (entryTiming === "EXTENDED" ? 10 : 0),
    0,
    100
  );

  const entryReady = coreQualified && entryTiming !== "EXTENDED";
  const signal = entryReady ? rawDirection : "WAIT";

  let reason = "Waiting for a stronger, cleaner entry.";
  if (entryReady) {
    reason = `${rawDirection} ${entryTiming} entry • ${agreement}/4 checks • ${confidence.toFixed(1)}% confidence.`;
  } else if (entryTiming === "EXTENDED") {
    reason = "Trend is stretched; waiting for a better entry price.";
  } else if (volatility === "HIGH") {
    reason = "Volatility is too high; waiting for a calmer setup.";
  } else if (agreement < 3) {
    reason = `Only ${agreement}/4 directional checks agree.`;
  }

  return {
    ready: true,
    signal,
    rawDirection,
    contractType: signal === "RISE" ? "CALL" : signal === "FALL" ? "PUT" : null,
    confidence: Number(confidence.toFixed(1)),
    score: Number(score.toFixed(3)),
    entryScore: Number(entryScore.toFixed(1)),
    entryReady,
    entryTiming,
    sampleSize: a.length,
    trend: mediumSlope > 0 ? "UP" : mediumSlope < 0 ? "DOWN" : "FLAT",
    momentum: m8 > 0.35 ? "BULLISH" : m8 < -0.35 ? "BEARISH" : "NEUTRAL",
    volatility,
    agreement,
    reason,
    features: {
      m3: Number(m3.toFixed(3)),
      m8: Number(m8.toFixed(3)),
      m20: Number(m20.toFixed(3)),
      persistence: Number(ps.toFixed(3)),
      reversal: Number(rs.toFixed(3)),
      volatilityRatio: Number(vr.toFixed(3)),
      emaGap: Number(emaGap.toFixed(3)),
      shortExtension: Number(shortExtension.toFixed(3)),
      pricePosition: Number(pricePosition.toFixed(3)),
    },
  };
}

export default analyzeRiseFall;
