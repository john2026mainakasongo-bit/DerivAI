const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};

function inferDecimals(value) {
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n)) return 3;
  if (n >= 1000) return 2;
  if (n >= 100) return 2;
  if (n >= 10) return 3;
  return 4;
}

export function estimateTouchBarrier(prices = [], decimals = 3, requested = 0.3) {
  const p = prices.map(Number).filter(Number.isFinite).slice(-120);
  if (!p.length) return Number(requested) || 0.3;

  const diffs = p.slice(1).map((v, i) => Math.abs(v - p[i])).filter(Number.isFinite);
  const tickMove = mean(diffs) || 10 ** -Math.max(0, Number(decimals) || 3);
  const safe = clamp(tickMove * 10, tickMove * 5, tickMove * 30);
  const requestedBarrier = Math.abs(Number(requested) || 0.3);

  return Number(Math.max(requestedBarrier, safe).toFixed(Math.max(1, Number(decimals) || 3)));
}

function slope(values = []) {
  const p = values.map(Number).filter(Number.isFinite);
  if (p.length < 2) return 0;
  const first = p[0];
  const last = p[p.length - 1];
  return (last - first) / Math.max(1, p.length - 1);
}

/**
 * Build the complete Touch / No Touch analysis object consumed by the desk.
 *
 * Important: the new Deriv API no longer puts spot data in active_symbols or
 * contracts_for. The live tick stream is therefore the source of truth for
 * `current`, and barriers are derived from that live spot before proposals
 * are requested.
 */
export function analyzeTouchNoTouch(prices = [], options = {}) {
  const clean = prices.map(Number).filter(Number.isFinite);
  const minimumSamples = Math.max(20, Number(options.minimumSamples) || 120);
  const maxSamples = Math.max(minimumSamples, Number(options.maxSamples) || 700);
  const entryThreshold = clamp(Number(options.minScore) || 95, 80, 99);
  const sample = clean.slice(-maxSamples);
  const current = Number(sample.at(-1));

  if (!Number.isFinite(current) || sample.length < 2) {
    return {
      ready: false,
      signal: "WAIT",
      candidate: "WAIT",
      entryScore: 0,
      current: Number.isFinite(current) ? current : null,
      touchBarrier: null,
      noTouchBarrier: null,
      touchScore: 0,
      noTouchScore: 0,
      trend: "WAIT",
      momentum: "WAIT",
      volatility: "WAIT",
      confirmations: 0,
      marketQuality: 0,
      noChase: false,
      state: "COLLECTING",
      reason: `Collecting live ticks (${sample.length}/${minimumSamples}).`,
    };
  }

  const decimals = Number.isFinite(Number(options.decimals))
    ? Number(options.decimals)
    : inferDecimals(current);
  const recent = sample.slice(-30);
  const previous = sample.slice(-60, -30);
  const recentSlope = slope(recent);
  const previousSlope = slope(previous);
  const move = current - Number(sample[0]);
  const recentMove = current - Number(recent[0]);
  const diffs = sample.slice(1).map((v, i) => Math.abs(v - sample[i]));
  const tickMove = mean(diffs) || 10 ** -Math.max(1, decimals);
  const volatilityValue = std(diffs);
  const range = Math.max(...sample) - Math.min(...sample);

  const trendUp = recentSlope > 0;
  const trendDown = recentSlope < 0;
  const trend = Math.abs(recentSlope) < tickMove * 0.12 ? "RANGING" : trendUp ? "BULLISH" : "BEARISH";
  const momentum = Math.abs(recentMove) >= tickMove * 5
    ? (recentMove > 0 ? "STRONG UP" : "STRONG DOWN")
    : Math.abs(recentMove) >= tickMove * 2
      ? (recentMove > 0 ? "UP" : "DOWN")
      : "NEUTRAL";

  const volatility = volatilityValue <= tickMove * 0.35
    ? "LOW"
    : volatilityValue <= tickMove * 0.8
      ? "MEDIUM"
      : "HIGH";

  const distance = estimateTouchBarrier(
    sample,
    decimals,
    Math.max(tickMove * 10, Math.abs(current) * 0.00015)
  );

  // Touch barrier is placed in the direction of the current short-term move;
  // No Touch uses the opposite side. Both are absolute prices because that is
  // what the analysis/UI needs. The proposal layer can convert to relative
  // barriers when requesting Deriv pricing.
  const direction = trendUp ? 1 : trendDown ? -1 : recentMove >= 0 ? 1 : -1;
  const touchBarrier = Number((current + direction * distance).toFixed(decimals));
  const noTouchBarrier = Number((current - direction * distance).toFixed(decimals));

  const trendStrength = clamp(
    Math.abs(recentSlope) / Math.max(tickMove * 0.8, 10 ** -decimals),
    0,
    1
  );
  const momentumStrength = clamp(
    Math.abs(recentMove) / Math.max(tickMove * 8, 10 ** -decimals),
    0,
    1
  );
  const stability = clamp(1 - Math.abs(previousSlope - recentSlope) / Math.max(tickMove, 10 ** -decimals), 0, 1);

  const confirmations = [
    sample.length >= minimumSamples,
    Math.abs(recentMove) >= tickMove * 2,
    trend !== "RANGING",
    stability >= 0.25,
    volatility !== "HIGH",
    range > distance * 1.5,
  ].filter(Boolean).length;

  const baseQuality = clamp(
    52 +
      trendStrength * 16 +
      momentumStrength * 14 +
      stability * 10 +
      Math.min(6, confirmations),
    0,
    99
  );

  // Keep No Touch competitive when the market is stable, while Touch wins
  // when directional movement is strong. The score is deliberately capped at
  // 99 and remains below the user's 95 entry gate until enough evidence exists.
  const touchScore = Math.round(clamp(
    baseQuality + (trend !== "RANGING" ? momentumStrength * 8 : -4),
    0,
    99
  ));
  const noTouchScore = Math.round(clamp(
    baseQuality + stability * 8 - momentumStrength * 7,
    0,
    99
  ));

  const candidate = touchScore >= noTouchScore ? "TOUCH" : "NO TOUCH";
  const candidateScore = Math.max(touchScore, noTouchScore);
  const candidateBarrier = candidate === "TOUCH" ? touchBarrier : noTouchBarrier;
  const sampleReady = sample.length >= minimumSamples;

  // Timing / no-chase should measure whether price is currently extending into
  // the proposed barrier, not whether the whole 30-tick window moved a lot.
  // A strong trend can legitimately travel more than the barrier distance while
  // still offering a clean entry after a pause/retest.
  const micro = sample.slice(-8);
  const microStart = Number(micro[0]);
  const microMove = Number.isFinite(microStart) ? current - microStart : 0;
  const priorMicro = sample.slice(-16, -8);
  const priorMicroStart = Number(priorMicro[0]);
  const priorMicroEnd = Number(priorMicro.at(-1));
  const priorMicroMove = Number.isFinite(priorMicroStart) && Number.isFinite(priorMicroEnd)
    ? priorMicroEnd - priorMicroStart
    : 0;
  const barrierDirection = Math.sign(candidateBarrier - current) || direction;
  const directionalMove = barrierDirection * recentMove;
  const directionalMicroMove = barrierDirection * microMove;
  const directionalPriorMicroMove = barrierDirection * priorMicroMove;
  const microCooling = directionalMicroMove <= directionalPriorMicroMove * 0.85;
  const microRetrace = directionalMicroMove < 0;
  const extended = directionalMove > distance * 1.25;
  const noChase = !extended || microCooling || microRetrace;
  const timing = !sampleReady
    ? "WARMING UP"
    : noChase
      ? (microRetrace || microCooling ? "RETEST / IDEAL" : "EARLY / OK")
      : "LATE — WAIT RETEST";

  // Keep the entry gate strict: score, confirmations and timing must all pass.
  // The selected MIN ENTRY value is now the actual threshold used by the
  // engine, so the UI control and execution gate cannot disagree.
  const ready = sampleReady && confirmations >= 5 && candidateScore >= entryThreshold && noChase;
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
    trend,
    momentum,
    volatility,
    confirmations,
    marketQuality: Math.round(baseQuality),
    noChase,
    timing,
    state: ready ? "ENTRY READY" : confirmations >= 3 ? "SETUP FORMING" : "ANALYZING",
    reason: ready
      ? `${candidate} setup confirmed from live price structure.`
      : timing === "LATE — WAIT RETEST"
        ? `Entry timing is late; waiting for a retest/cooldown (${candidateScore}/99).`
        : `Waiting for valid Touch / No Touch proposal and stronger confirmation (${candidateScore}/99).`,
  };
}

export function evaluateTouchNoTouch({
  direction,
  touchQuote,
  noTouchQuote,
  barrier,
  duration,
} = {}) {
  const touchAsk = Number(touchQuote?.askPrice);
  const touchPayout = Number(touchQuote?.payout);
  const noTouchAsk = Number(noTouchQuote?.askPrice);
  const noTouchPayout = Number(noTouchQuote?.payout);

  const touchImplied = touchPayout > 0 ? (touchAsk / touchPayout) * 100 : 0;
  const noTouchImplied = noTouchPayout > 0 ? (noTouchAsk / noTouchPayout) * 100 : 0;

  const aligned = direction === "RISE" ? "UP" : direction === "FALL" ? "DOWN" : "NONE";
  const strength = aligned === "NONE" ? 0 : touchImplied;

  const valid = Boolean(
    touchQuote?.proposalId &&
      noTouchQuote?.proposalId &&
      touchAsk > 0 &&
      touchPayout > touchAsk &&
      noTouchAsk > 0 &&
      noTouchPayout > noTouchAsk
  );

  const edge = touchImplied - noTouchImplied;
  const pass = valid && strength >= 52 && edge >= 4;

  return {
    valid,
    pass,
    direction: aligned,
    barrier: Number(barrier) || 0,
    duration: Number(duration) || 0,
    touchAsk: Number.isFinite(touchAsk) ? touchAsk : null,
    touchPayout: Number.isFinite(touchPayout) ? touchPayout : null,
    noTouchAsk: Number.isFinite(noTouchAsk) ? noTouchAsk : null,
    noTouchPayout: Number.isFinite(noTouchPayout) ? noTouchPayout : null,
    touchImplied: Number(touchImplied.toFixed(1)),
    noTouchImplied: Number(noTouchImplied.toFixed(1)),
    edge: Number(edge.toFixed(1)),
    label: !valid ? "WAIT" : pass ? "CONFIRMED" : "FILTERED",
    status: !valid ? "WAIT" : pass ? "CONFIRMED" : "FILTERED",
    reason: !valid
      ? "Waiting for valid Deriv Touch / No Touch proposals."
      : pass
        ? `${aligned} barrier is supported by live Deriv proposal pricing.`
        : "Deriv proposal pricing does not confirm the directional entry strongly enough.",
  };
}

export default analyzeTouchNoTouch;
