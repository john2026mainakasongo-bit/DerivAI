const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mean = (values) => values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0;

function ema(values, period) {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i += 1) out = values[i] * k + out * (1 - k);
  return out;
}

function returns(values, lookback = 20) {
  if (values.length <= lookback) return 0;
  const a = Number(values[values.length - lookback - 1]);
  const b = Number(values[values.length - 1]);
  return a && Number.isFinite(a) && Number.isFinite(b) ? (b - a) / Math.abs(a) : 0;
}

function volatility(values, lookback = 30) {
  const slice = values.slice(-lookback);
  if (slice.length < 5) return 0;
  const diffs = [];
  for (let i = 1; i < slice.length; i += 1) diffs.push(Math.abs(slice[i] - slice[i - 1]));
  return mean(diffs);
}

function trendLabel(slope, fast, slow) {
  if (fast > slow && slope > 0) return "BULLISH";
  if (fast < slow && slope < 0) return "BEARISH";
  return "RANGE";
}

export function analyzeTouchNoTouch(prices = [], options = {}) {
  const clean = prices.map(Number).filter(Number.isFinite).slice(-Math.max(80, options.maxSamples || 500));
  const minimumSamples = Number(options.minimumSamples || 120);
  if (clean.length < minimumSamples) {
    return {
      ready: false,
      state: "WARMING UP",
      signal: "WAIT",
      entryScore: 0,
      confidence: 0,
      confirmations: 0,
      reason: `Collecting market data ${clean.length}/${minimumSamples}`,
      current: clean.at(-1) || null,
      trend: "WAIT",
      momentum: "WAIT",
      volatility: "WAIT",
      touchScore: 0,
      noTouchScore: 0,
      touchBarrier: null,
      noTouchBarrier: null,
      barrierDistance: 0,
      marketQuality: 0,
      noChase: true,
    };
  }

  const current = clean.at(-1);
  const fast = ema(clean.slice(-80), 9);
  const mid = ema(clean.slice(-120), 21);
  const slow = ema(clean, 50);
  const v = volatility(clean, 40);
  const move20 = returns(clean, 20);
  const move60 = returns(clean, 60);
  const range = Math.max(...clean.slice(-60)) - Math.min(...clean.slice(-60));
  const recentHigh = Math.max(...clean.slice(-35));
  const recentLow = Math.min(...clean.slice(-35));
  const rangePos = range > 0 ? (current - recentLow) / range : 0.5;
  const slope = returns(clean, 12);
  const trend = trendLabel(slope, fast, slow);

  const momentumScore = clamp(50 + move20 * 7000 + move60 * 3000, 0, 100);
  const directional = trend === "BULLISH" ? 1 : trend === "BEARISH" ? -1 : 0;
  const momentum = Math.abs(momentumScore - 50) > 18 ? (momentumScore > 50 ? "UP" : "DOWN") : "NEUTRAL";

  const avgStep = Math.max(v, Math.abs(current) * 0.00001);
  const volatilityPct = current ? (avgStep / Math.abs(current)) * 100 : 0;
  const qualityVol = volatilityPct > 0.0004 && volatilityPct < 0.08 ? 88 : volatilityPct <= 0.0004 ? 52 : 38;

  const extension = directional > 0 ? rangePos : directional < 0 ? 1 - rangePos : 0.5;
  const noChase = extension < 0.86;
  const trendAgreement = directional === 0 ? 55 : 92;
  const emaAgreement = (fast > mid && mid > slow) || (fast < mid && mid < slow) ? 95 : 50;
  const persistence = Math.abs(move60) > Math.abs(move20) * 0.55 ? 86 : 58;
  const containment = range > 0 ? clamp(100 - Math.abs(move20) * 5000, 30, 96) : 50;
  const momentumAgreement = directional === 0 ? 55 : (directional > 0 ? momentumScore : 100 - momentumScore);

  const touchBase = mean([trendAgreement, emaAgreement, persistence, momentumAgreement, qualityVol, noChase ? 92 : 20]);
  const noTouchBase = mean([containment, qualityVol, 100 - Math.abs(move20) * 4200, noChase ? 90 : 35, trend === "RANGE" ? 92 : 62]);

  const touchDirection = directional >= 0 ? 1 : -1;
  const touchDistance = Math.max(avgStep * (1.7 + Math.max(0, 1 - Math.abs(move20) * 900)), Math.abs(current) * 0.00035);
  const noTouchDirection = directional >= 0 ? -1 : 1;
  const noTouchDistance = Math.max(avgStep * 2.8, Math.abs(current) * 0.00055);

  const touchBarrier = current + touchDirection * touchDistance;
  const noTouchBarrier = current + noTouchDirection * noTouchDistance;

  const touchScore = clamp(Math.round(touchBase), 0, 99);
  const noTouchScore = clamp(Math.round(noTouchBase), 0, 99);
  const selected = touchScore >= noTouchScore ? "TOUCH" : "NO TOUCH";
  const bestScore = Math.max(touchScore, noTouchScore);
  const secondScore = Math.min(touchScore, noTouchScore);
  const dominance = bestScore - secondScore;
  const confirmations = [
    Math.abs(fast - mid) / Math.max(Math.abs(current), 1) > 0.00002,
    Math.abs(move20) > 0.00003,
    emaAgreement >= 90,
    persistence >= 80,
    qualityVol >= 80,
    noChase,
  ].filter(Boolean).length;

  const hardConflict = trend === "RANGE" && Math.abs(move20) > 0.0015;
  const entryScore = clamp(Math.round(bestScore * 0.62 + dominance * 0.9 + confirmations * 3.2 + (hardConflict ? -18 : 0)), 0, 99);
  const qualified = !hardConflict && noChase && confirmations >= 4 && bestScore >= 90 && dominance >= 8 && entryScore >= 92;

  return {
    ready: true,
    state: qualified ? "ENTRY READY" : bestScore >= 80 ? "SETUP FORMING" : "SCANNING",
    signal: qualified ? selected : "WAIT",
    candidate: selected,
    entryScore,
    confidence: entryScore,
    confirmations,
    reason: qualified
      ? `${selected} setup confirmed by trend, momentum, barrier reachability and market quality.`
      : hardConflict
        ? "Conflicting market structure — waiting."
        : !noChase
          ? "Price is extended — no chase."
          : "Waiting for stronger confluence.",
    current,
    trend,
    momentum,
    volatility: qualityVol >= 80 ? "STABLE" : qualityVol >= 55 ? "MIXED" : "HIGH RISK",
    touchScore,
    noTouchScore,
    touchBarrier,
    noTouchBarrier,
    barrierDistance: selected === "TOUCH" ? touchDistance : noTouchDistance,
    marketQuality: Math.round(mean([qualityVol, emaAgreement, noChase ? 92 : 20, containment])),
    noChase,
    emaFast: fast,
    emaMid: mid,
    emaSlow: slow,
    avgStep,
    range,
    move20,
    move60,
    dominance,
    hardConflict,
  };
}

export default analyzeTouchNoTouch;
