export function confirmationDiagnostics(signal) {
  if (!signal) {
    return { state: 'WAIT', reason: 'Waiting for a qualifying setup' };
  }
  if (signal.entered) {
    return {
      state: 'CONFIRMED',
      reason: `${signal.side} entry confirmed`,
    };
  }
  if (['Expired', 'Invalidated', 'SL touched', 'TP2 touched', 'TP3 touched'].includes(signal.status)) {
    return { state: 'CLOSED', reason: signal.reason || signal.status };
  }
  if (signal.gapUnverified) {
    return { state: 'BLOCKED', reason: 'Unverified data gap' };
  }
  if (!signal.tapEpoch) {
    return { state: 'WAIT', reason: 'Waiting for price to tap the zone' };
  }
  const seconds = Number(signal.seconds);
  const candles = signal.candles || [];
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { state: 'WAIT', reason: 'Invalid timeframe data' };
  }
  const tapCandleTime = Math.floor(signal.tapEpoch / seconds) * seconds;
  const candidates = candles
    .filter(c => c.time >= tapCandleTime)
    .sort((a, b) => b.time - a.time);
  const lastObservedEpoch = Number(signal.lastEpoch);
  const closed = candidates.find(c =>
    Number(c.time) + seconds <= lastObservedEpoch
  );
  if (!closed) {
    return { state: 'WAIT', reason: 'Waiting for candle close' };
  }
  const buy = signal.side === 'BUY';
  const body = (buy ? 1 : -1) * (closed.close - closed.open);
  const range = closed.high - closed.low;
  const bodyRatio = range > 0 ? body / range : 0;
  const touchedZone =
    closed.low <= signal.zoneHigh &&
    closed.high >= signal.zoneLow;
  const closeBeyondZone = buy
    ? closed.close > signal.zoneHigh
    : closed.close < signal.zoneLow;
  const candlePass =
    body > 0 &&
    bodyRatio >= 0.3 &&
    touchedZone &&
    closeBeyondZone;
  return {
    state: candlePass ? 'CHECKING' : 'WAIT',
    reason: !touchedZone
      ? 'Candle did not touch the zone'
      : !closeBeyondZone
        ? 'Candle did not close beyond the zone'
        : bodyRatio < 0.3
          ? 'Candle body too small'
          : candlePass
            ? 'Rejection candle passed; awaiting live quote confirmation'
            : 'Waiting for directional rejection',
    bodyPercent: Math.round(bodyRatio * 1000) / 10,
    requiredPercent: 30,
    touchedZone,
    closeBeyondZone,
    candleTime: closed.time,
  };
}
