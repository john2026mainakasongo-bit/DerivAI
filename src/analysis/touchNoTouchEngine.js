const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const median = (a) => {
  const values = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!values.length) return 0;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
};
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};
const percentile = (a, p) => {
  const values = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!values.length) return 0;
  const index = (values.length - 1) * clamp(p, 0, 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return values[low];
  return values[low] + (values[high] - values[low]) * (index - low);
};

function inferDecimals(value) {
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n)) return 3;
  if (n >= 100) return 2;
  if (n >= 10) return 3;
  return 4;
}

function normalizeTicks(input = []) {
  return input
    .map((item, index) => {
      if (typeof item === "object" && item !== null) {
        const quote = Number(item.quote ?? item.price ?? item.value);
        const epoch = Number(item.epoch ?? item.time ?? item.timestamp);
        return { quote, epoch, index };
      }
      return { quote: Number(item), epoch: NaN, index };
    })
    .filter((item) => Number.isFinite(item.quote));
}

function slope(values = []) {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  return (last - first) / Math.max(1, values.length - 1);
}

function estimateHorizonTicks(items, duration, durationUnit) {
  const d = Math.max(1, Number(duration) || 5);
  if (String(durationUnit).toLowerCase() !== "s") return Math.round(d);

  const intervals = [];
  for (let i = 1; i < items.length; i += 1) {
    const a = Number(items[i - 1].epoch);
    const b = Number(items[i].epoch);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a && b - a <= 10) {
      intervals.push(b - a);
    }
  }
  const secondsPerTick = median(intervals) || 1;
  return Math.max(2, Math.round(d / secondsPerTick));
}

function historicalHitRate(values, distance, horizon, direction) {
  const p = values.filter(Number.isFinite);
  const h = Math.max(1, Math.round(horizon));
  if (p.length <= h + 12 || !Number.isFinite(distance) || distance <= 0) return 0.5;

  let hits = 0;
  let total = 0;
  const start = Math.max(0, p.length - 360 - h);
  for (let i = start; i < p.length - h; i += 1) {
    const entry = p[i];
    let extreme = direction > 0 ? -Infinity : Infinity;
    for (let j = i + 1; j <= i + h; j += 1) {
      extreme = direction > 0 ? Math.max(extreme, p[j]) : Math.min(extreme, p[j]);
    }
    const moved = direction > 0 ? extreme - entry : entry - extreme;
    if (moved >= distance) hits += 1;
    total += 1;
  }
  return total ? hits / total : 0.5;
}

function weightedHistoricalHitRate(values, distance, horizon, direction) {
  const p = values.filter(Number.isFinite);
  const h = Math.max(1, Math.round(horizon));
  if (p.length <= h + 20 || !Number.isFinite(distance) || distance <= 0) return 0.5;

  const end = p.length - h;
  const start = Math.max(0, end - 360);
  let weightedHits = 0;
  let weightTotal = 0;

  for (let i = start; i < end; i += 1) {
    const entry = p[i];
    let extreme = direction > 0 ? -Infinity : Infinity;
    for (let j = i + 1; j <= i + h; j += 1) {
      extreme = direction > 0 ? Math.max(extreme, p[j]) : Math.min(extreme, p[j]);
    }
    const moved = direction > 0 ? extreme - entry : entry - extreme;
    const age = end - i;
    const weight = Math.exp(-age / 150);
    if (moved >= distance) weightedHits += weight;
    weightTotal += weight;
  }
  return weightTotal ? weightedHits / weightTotal : 0.5;
}

function excursionSamples(values, horizon, direction) {
  const p = values.filter(Number.isFinite);
  const h = Math.max(1, Math.round(horizon));
  const out = [];
  const start = Math.max(0, p.length - 420 - h);
  for (let i = start; i < p.length - h; i += 1) {
    const entry = p[i];
    let extreme = direction > 0 ? -Infinity : Infinity;
    for (let j = i + 1; j <= i + h; j += 1) {
      extreme = direction > 0 ? Math.max(extreme, p[j]) : Math.min(extreme, p[j]);
    }
    const moved = direction > 0 ? extreme - entry : entry - extreme;
    if (Number.isFinite(moved) && moved >= 0) out.push(moved);
  }
  return out;
}

export function estimateTouchBarrier(prices = [], decimals = 3, requested = 0.3) {
  const p = normalizeTicks(prices).map((x) => x.quote).slice(-180);
  if (!p.length) return Number(requested) || 0.3;
  const diffs = p.slice(1).map((v, i) => Math.abs(v - p[i])).filter(Number.isFinite);
  const tickMove = median(diffs) || 10 ** -Math.max(0, Number(decimals) || 3);
  const safe = tickMove * 8;
  const requestedBarrier = Math.abs(Number(requested) || 0.3);
  return Number(Math.max(requestedBarrier, safe).toFixed(Math.max(1, Number(decimals) || 3)));
}

/**
 * Touch / No Touch analysis is duration-aware. It uses the live tick stream,
 * estimates the number of ticks in the selected duration, and checks historical
 * excursions over that same horizon before allowing an entry.
 *
 * No model can guarantee a winning trade. The purpose of this engine is to
 * reject weak setups and only expose high-quality candidates for proposal
 * pricing and the final execution gate.
 */
export function analyzeTouchNoTouch(prices = [], options = {}) {
  const items = normalizeTicks(prices);
  const values = items.map((x) => x.quote);
  const minimumSamples = Math.max(60, Number(options.minimumSamples) || 120);
  const maxSamples = Math.max(minimumSamples, Number(options.maxSamples) || 900);
  const entryThreshold = clamp(Number(options.minScore) || 80, 80, 99);
  const duration = Math.max(1, Number(options.duration) || 5);
  const durationUnit = String(options.durationUnit || "t").toLowerCase() === "s" ? "s" : "t";
  const sampleItems = items.slice(-maxSamples);
  const sample = sampleItems.map((x) => x.quote);
  const current = Number(sample.at(-1));

  if (!Number.isFinite(current) || sample.length < 2) {
    return {
      ready: false, signal: "WAIT", candidate: "WAIT", entryScore: 0,
      current: Number.isFinite(current) ? current : null,
      touchBarrier: null, noTouchBarrier: null, touchScore: 0, noTouchScore: 0,
      trend: "WAIT", momentum: "WAIT", volatility: "WAIT", confirmations: 0,
      marketQuality: 0, noChase: false, timing: "WARMING UP", state: "COLLECTING",
      duration, durationUnit, horizonTicks: durationUnit === "t" ? duration : null,
      modelProbability: 0, reason: `Collecting live ticks (${sample.length}/${minimumSamples}).`,
    };
  }

  const decimals = Number.isFinite(Number(options.decimals)) ? Number(options.decimals) : inferDecimals(current);
  const horizonTicks = Math.max(2, estimateHorizonTicks(sampleItems, duration, durationUnit));
  const structuralWindow = Math.max(18, Math.min(60, horizonTicks * 6));
  const recent = sample.slice(-structuralWindow);
  const previous = sample.slice(-(structuralWindow * 2), -structuralWindow);
  const recentSlope = slope(recent);
  const previousSlope = slope(previous);
  const diffs = sample.slice(1).map((v, i) => Math.abs(v - sample[i])).filter(Number.isFinite);
  const tickMove = median(diffs) || 10 ** -Math.max(1, decimals);
  const tickStd = std(diffs);
  const trend = Math.abs(recentSlope) < tickMove * 0.10 ? "RANGING" : recentSlope > 0 ? "BULLISH" : "BEARISH";
  const recentMove = current - Number(recent[0]);
  const momentum = Math.abs(recentMove) >= tickMove * Math.max(4, horizonTicks * 0.75)
    ? (recentMove > 0 ? "STRONG UP" : "STRONG DOWN")
    : Math.abs(recentMove) >= tickMove * Math.max(2, horizonTicks * 0.35)
      ? (recentMove > 0 ? "UP" : "DOWN")
      : "NEUTRAL";
  const volatility = tickStd <= tickMove * 0.35 ? "LOW" : tickStd <= tickMove * 0.85 ? "MEDIUM" : "HIGH";

  const direction = recentSlope > 0 ? 1 : recentSlope < 0 ? -1 : recentMove >= 0 ? 1 : -1;
  const favorableExcursions = excursionSamples(sample, horizonTicks, direction);
  const adverseExcursions = excursionSamples(sample, horizonTicks, -direction);
  const favorableQ55 = percentile(favorableExcursions, 0.55);
  const favorableQ70 = percentile(favorableExcursions, 0.70);
  const adverseQ70 = percentile(adverseExcursions, 0.70);
  const baseUnit = Math.max(tickMove * Math.sqrt(horizonTicks) * 1.35, tickMove * 2);
  const touchDistance = Math.max(baseUnit, favorableQ55 || 0, tickMove * 2);
  const noTouchDistance = Math.max(baseUnit * 1.25, adverseQ70 * 1.15 || 0, tickMove * 3);

  const touchBarrier = Number((current + direction * touchDistance).toFixed(decimals));
  const noTouchBarrier = Number((current - direction * noTouchDistance).toFixed(decimals));
  const touchBaseHit = historicalHitRate(sample, touchDistance, horizonTicks, direction);
  const touchRecentHit = weightedHistoricalHitRate(sample.slice(-220), touchDistance, horizonTicks, direction);
  const touchHit = clamp(touchBaseHit * 0.40 + touchRecentHit * 0.60, 0.01, 0.99);

  const noTouchBaseHit = 1 - historicalHitRate(sample, noTouchDistance, horizonTicks, -direction);
  const noTouchRecentHit = 1 - weightedHistoricalHitRate(sample.slice(-220), noTouchDistance, horizonTicks, -direction);
  const noTouchHit = clamp(noTouchBaseHit * 0.40 + noTouchRecentHit * 0.60, 0.01, 0.99);

  const trendStrength = clamp(Math.abs(recentSlope) / Math.max(tickMove * 0.75, 10 ** -decimals), 0, 1);
  const momentumStrength = clamp(Math.abs(recentMove) / Math.max(tickMove * Math.max(5, horizonTicks), 10 ** -decimals), 0, 1);
  const stability = clamp(1 - Math.abs(previousSlope - recentSlope) / Math.max(tickMove * 1.5, 10 ** -decimals), 0, 1);
  const quality = clamp(50 + trendStrength * 18 + momentumStrength * 12 + stability * 12 - (volatility === "HIGH" ? 12 : 0), 0, 100);

  const micro = sample.slice(-Math.max(6, Math.min(12, horizonTicks * 2)));
  const microMove = current - Number(micro[0]);
  const prior = sample.slice(-micro.length * 2, -micro.length);
  const priorMove = prior.length > 1 ? Number(prior.at(-1)) - Number(prior[0]) : microMove;
  const candidateBarrier = touchHit >= noTouchHit ? touchBarrier : noTouchBarrier;
  const candidateDirection = Math.sign(candidateBarrier - current) || direction;
  const directionalMicro = candidateDirection * microMove;
  const directionalPrior = candidateDirection * priorMove;
  const cooling = directionalMicro <= directionalPrior * 0.85;
  const retrace = directionalMicro < 0;
  const extension = candidateDirection * (current - Number(sample[Math.max(0, sample.length - structuralWindow)]));
  const expectedCandidateDistance = candidateBarrier === touchBarrier ? touchDistance : noTouchDistance;
  const extended = extension > expectedCandidateDistance * 1.15;
  const noChase = !extended || cooling || retrace;
  const timing = noChase
    ? (retrace || cooling ? "RETEST / IDEAL" : "EARLY / OK")
    : "LATE / WAIT RETEST";

  const confirmations = [
    sample.length >= minimumSamples,
    trend !== "RANGING",
    Math.abs(recentMove) >= tickMove * 2,
    stability >= 0.30,
    volatility !== "HIGH",
    favorableExcursions.length >= 40,
  ].filter(Boolean).length;

  // Touch needs evidence that the barrier is reachable inside the selected
  // horizon. No Touch needs evidence that the opposite barrier is rarely hit.
  const probabilityEdge = Math.abs(touchHit - noTouchHit);
  const touchScore = Math.round(clamp(
    touchHit * 70 + quality * 0.20 + stability * 6 + probabilityEdge * 18 + Math.min(5, confirmations),
    0, 99
  ));
  const noTouchScore = Math.round(clamp(
    noTouchHit * 70 + quality * 0.20 + stability * 6 + probabilityEdge * 18 + Math.min(5, confirmations),
    0, 99
  ));

  const candidate = touchScore >= noTouchScore ? "TOUCH" : "NO TOUCH";
  const candidateScore = candidate === "TOUCH" ? touchScore : noTouchScore;
  const modelProbability = candidate === "TOUCH" ? touchHit : noTouchHit;
  const probabilityGate = modelProbability >= 0.78;
  const edgeGate = probabilityEdge >= 0.08;
  const sampleReady = sample.length >= minimumSamples;
  const highVolatilityAllowed = volatility === "HIGH" && modelProbability >= 0.80 && quality >= 65 && stability >= 0.35;
  const volatilityGate = volatility !== "HIGH" || highVolatilityAllowed;
  const ready = Boolean(
    sampleReady &&
    confirmations >= 5 &&
    candidateScore >= entryThreshold &&
    probabilityGate &&
    edgeGate &&
    quality >= 60 &&
    noChase &&
    volatilityGate
  );
  const signal = ready ? candidate : "WAIT";

  return {
    ready,
    signal,
    candidate,
    entryScore: candidateScore,
    entryThreshold,
    current,
    touchBarrier,
    noTouchBarrier,
    touchScore,
    noTouchScore,
    touchProbability: Number(touchHit.toFixed(3)),
    noTouchProbability: Number(noTouchHit.toFixed(3)),
    modelProbability: Number(modelProbability.toFixed(3)),
    trend,
    momentum,
    volatility,
    confirmations,
    marketQuality: Math.round(quality),
    probabilityEdge: Number(probabilityEdge.toFixed(3)),
    highVolatilityAllowed,
    strategy: "ADAPTIVE A+ V10",
    noChase,
    timing,
    duration,
    durationUnit,
    horizonTicks,
    state: ready ? "ENTRY READY" : confirmations >= 4 ? "SETUP FORMING" : "ANALYZING",
    reason: ready
      ? `${candidate} confirmed for ${duration} ${durationUnit === "s" ? "seconds" : "ticks"}; model probability ${(modelProbability * 100).toFixed(1)}%.`
      : !probabilityGate
        ? `Waiting: model probability ${(modelProbability * 100).toFixed(1)}% is below the 78% probability gate.`
        : quality < 70
          ? `Waiting: market quality ${Math.round(quality)}/100 is below the 60 safety gate.`
          : timing === "LATE / WAIT RETEST"
          ? `Entry is extended; waiting for a retest before ${candidate}.`
          : `Waiting for stronger ${candidate} evidence (${candidateScore}/99, ${(modelProbability * 100).toFixed(1)}% probability, ${confirmations}/6).`,
  };
}

export function evaluateTouchNoTouch({ touchQuote, noTouchQuote, barrier, duration } = {}) {
  const touchAsk = Number(touchQuote?.askPrice);
  const touchPayout = Number(touchQuote?.payout);
  const noTouchAsk = Number(noTouchQuote?.askPrice);
  const noTouchPayout = Number(noTouchQuote?.payout);
  const touchImplied = touchPayout > 0 ? (touchAsk / touchPayout) * 100 : 0;
  const noTouchImplied = noTouchPayout > 0 ? (noTouchAsk / noTouchPayout) * 100 : 0;
  const valid = Boolean(
    touchQuote?.proposalId && noTouchQuote?.proposalId && touchAsk > 0 && touchPayout > touchAsk && noTouchAsk > 0 && noTouchPayout > noTouchAsk
  );
  const edge = touchImplied - noTouchImplied;
  const pass = valid && edge >= 4;
  return {
    valid, pass, barrier: Number(barrier) || 0, duration: Number(duration) || 0,
    touchAsk: Number.isFinite(touchAsk) ? touchAsk : null,
    touchPayout: Number.isFinite(touchPayout) ? touchPayout : null,
    noTouchAsk: Number.isFinite(noTouchAsk) ? noTouchAsk : null,
    noTouchPayout: Number.isFinite(noTouchPayout) ? noTouchPayout : null,
    touchImplied: Number(touchImplied.toFixed(1)),
    noTouchImplied: Number(noTouchImplied.toFixed(1)),
    edge: Number(edge.toFixed(1)),
    label: !valid ? "WAIT" : pass ? "CONFIRMED" : "FILTERED",
    status: !valid ? "WAIT" : pass ? "CONFIRMED" : "FILTERED",
    reason: !valid ? "Waiting for valid Deriv Touch / No Touch proposals." : pass ? "Proposal pricing passes the comparison filter." : "Proposal pricing does not confirm enough edge.",
  };
}

export default analyzeTouchNoTouch;
