function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}
function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n(v)));
}
function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function ema(a, p) {
  if (!a.length) return 0;
  const k = 2 / (p + 1);
  let x = a[0];
  for (let i = 1; i < a.length; i += 1) x = a[i] * k + x * (1 - k);
  return x;
}
function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
}
function rsi(a, p = 14) {
  if (a.length <= p) return 50;
  let g = 0, l = 0;
  for (let i = a.length - p; i < a.length; i += 1) {
    const d = a[i] - a[i - 1];
    if (d >= 0) g += d;
    else l += Math.abs(d);
  }
  if (!l) return g ? 100 : 50;
  return 100 - 100 / (1 + g / l);
}
function slope(a) {
  if (a.length < 3) return 0;
  const xm = (a.length - 1) / 2, ym = mean(a);
  let num = 0, den = 0;
  a.forEach((y, i) => {
    num += (i - xm) * (y - ym);
    den += (i - xm) ** 2;
  });
  return den ? num / den : 0;
}
function atr(a, p = 14) {
  if (a.length < 3) return std(a.slice(-20));
  const w = a.slice(-p - 1);
  return mean(w.slice(1).map((x, i) => Math.abs(x - w[i])));
}

export function analyzeRiseFallTouch(input = []) {
  const prices = (Array.isArray(input) ? input : [])
    .map(x => n(x?.quote ?? x?.price ?? x))
    .filter(Number.isFinite)
    .slice(-240);

  if (prices.length < 40) {
    return {
      ready: false,
      signal: "WAIT",
      family: "NONE",
      confidence: 0,
      probability: 0,
      entryQuality: "CALIBRATING",
      reason: `Collecting data ${prices.length}/40`,
      metrics: { samples: prices.length }
    };
  }

  const current = prices.at(-1);
  const fast = ema(prices.slice(-60), 9);
  const slow = ema(prices.slice(-120), 21);
  const volatility = Math.max(atr(prices, 14), 1e-9);
  const deviation = Math.max(std(prices.slice(-30)), volatility, 1e-9);
  const trendSlope = slope(prices.slice(-30));
  const momentum = current - prices.at(-Math.min(8, prices.length));
  const rsiValue = rsi(prices, 14);
  const mean30 = mean(prices.slice(-30));
  const z = (current - mean30) / deviation;

  const slopeNorm = trendSlope / volatility;
  const trendNorm = (fast - slow) / volatility;
  const momentumNorm = momentum / volatility;

  let rise = 50 + slopeNorm * 22 + trendNorm * 18 + momentumNorm * 8;
  let fall = 50 - slopeNorm * 22 - trendNorm * 18 - momentumNorm * 8;

  if (rsiValue > 52 && rsiValue < 72) rise += 7;
  if (rsiValue < 48 && rsiValue > 28) fall += 7;

  rise = clamp(rise);
  fall = clamp(fall);

  const trendDirection = rise >= fall ? "RISE" : "FALL";
  const directionProbability = Math.max(rise, fall);
  const directionGap = Math.abs(rise - fall);
  const directionConfidence = clamp(50 + directionGap * 0.95);

  const distance = Math.abs(z);
  const trendPressure = Math.min(1.5, Math.abs(trendNorm));
  const touchProbability = clamp(54 + Math.min(22, distance * 8) + trendPressure * 8);
  const noTouchProbability = clamp(100 - touchProbability + (trendPressure > 0.8 ? 6 : 0));
  const touchSignal = touchProbability >= noTouchProbability ? "TOUCH" : "NO TOUCH";
  const touchProbabilityBest = Math.max(touchProbability, noTouchProbability);
  const touchGap = Math.abs(touchProbability - noTouchProbability);
  const touchConfidence = clamp(50 + touchGap * 0.95);

  const barrierSide = trendDirection === "RISE" ? 1 : -1;
  const barrierDistance = Math.max(volatility * 0.8, deviation * 0.7);
  const barrier = current + barrierSide * barrierDistance;

  const sampleQuality = clamp(55 + ((prices.length - 40) / 200) * 45);
  const volatilityRatio = volatility / Math.max(deviation, 1e-9);
  const stability = clamp(100 - Math.abs(volatilityRatio - 0.5) * 80);

  const candidates = [
    {
      family: "RISE_FALL",
      setup: trendDirection,
      probability: directionProbability,
      confidence: directionConfidence,
      reason: `EMA ${fast >= slow ? "bullish" : "bearish"} · RSI ${rsiValue.toFixed(1)} · momentum ${momentumNorm.toFixed(2)}`
    },
    {
      family: "TOUCH_NO_TOUCH",
      setup: touchSignal,
      probability: touchProbabilityBest,
      confidence: touchConfidence,
      barrier,
      reason: `Distance ${distance.toFixed(2)}σ · trend pressure ${trendPressure.toFixed(2)}`
    }
  ].map(x => ({
    ...x,
    score: clamp(
      x.confidence * 0.62 +
      x.probability * 0.23 +
      sampleQuality * 0.10 +
      stability * 0.05
    )
  }));

  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  const agreementGap = best.score - second.score;

  const rsiExtreme = rsiValue > 78 || rsiValue < 22;
  const unstable = volatilityRatio > 1.35 || volatilityRatio < 0.12;
  const weakTrend = Math.abs(trendNorm) < 0.12 && Math.abs(momentumNorm) < 0.35;

  const entryConfidence = clamp(
    best.score * 0.72 +
    Math.min(100, 55 + agreementGap * 2.2) * 0.12 +
    sampleQuality * 0.08 +
    stability * 0.08
  );

  const blocked = rsiExtreme || unstable || weakTrend || agreementGap < 7;
  const entryQuality = blocked
    ? "WAIT"
    : entryConfidence >= 86
      ? "HIGH"
      : entryConfidence >= 80
        ? "GOOD"
        : "WAIT";

  const signal = entryQuality === "WAIT" ? "WAIT" : best.setup;

  return {
    ready: true,
    signal,
    family: signal === "WAIT" ? "NONE" : best.family,
    confidence: entryConfidence,
    probability: best.probability,
    entryQuality,
    barrier: best.barrier,
    reason: signal === "WAIT"
      ? `Filtered · ${blocked ? "market quality gate" : "confidence gate"}`
      : best.reason,
    metrics: {
      samples: prices.length,
      current,
      fast,
      slow,
      rsi: rsiValue,
      volatility,
      slope: trendSlope,
      momentum,
      zScore: z,
      stability,
      agreementGap
    },
    engines: candidates.map(x => ({ ...x, entryConfidence }))
  };
}