const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};

export function estimateTouchBarrier(prices = [], decimals = 3, requested = 0.3) {
  const p = prices.map(Number).filter(Number.isFinite).slice(-120);
  if (!p.length) return Number(requested) || 0.3;

  const diffs = p.slice(1).map((v, i) => Math.abs(v - p[i]));
  const tickMove = mean(diffs) || 10 ** -Math.max(0, Number(decimals) || 3);
  const safe = clamp(tickMove * 10, tickMove * 5, tickMove * 30);
  const requestedBarrier = Math.abs(Number(requested) || 0.3);

  return Number(Math.max(requestedBarrier, safe).toFixed(Math.max(1, Number(decimals) || 3)));
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

  // Proposal pricing is a market-priced reference, not a guaranteed probability.
  // Use conservative gates and require both proposals to be valid.
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

export default evaluateTouchNoTouch;
