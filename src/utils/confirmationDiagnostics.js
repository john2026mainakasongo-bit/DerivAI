export function confirmationDiagnostics(signal) {
  const base = {
    state: 'WAIT',
    reason: 'Waiting for a qualifying setup',
    requiredPercent: 30,
    tapped: false,
    touchedZone: null,
    closeBeyondZone: null,
    candleValid: null,
    timingValid: null,
    quoteValid: null,
    stopValid: null,
    dataVerified: true,
    bodyPercent: null
  };
  if (!signal) return base;
  const result = {
    ...base,
    tapped: Boolean(signal.tapEpoch),
    dataVerified: !signal.gapUnverified
  };
  if (signal.gapUnverified) {
    return {
      ...result,
      state: 'BLOCKED',
      reason: 'Unverified data gap'
    };
  }
  if (['Expired', 'Invalidated', 'SL touched',
       'TP2 touched', 'TP3 touched'].includes(signal.status)) {
    return {
      ...result,
      state: 'CLOSED',
      reason: signal.reason || signal.status
    };
  }
  if (signal.entered) {
    return {
      ...result,
      state: 'CONFIRMED',
      reason: `${signal.side} entry confirmed`
    };
  }

  if (!signal.tapEpoch) {
    return {
      ...result,
      reason: 'Waiting for price to tap the zone'
    };
  }
  const seconds = Number(signal.seconds);
  const epoch = Number(signal.lastEpoch);
  const candles = signal.candles || [];
  if (!Number.isFinite(seconds) || seconds <= 0 ||
      !Number.isFinite(epoch)) {
    return {
      ...result,
      reason: 'Invalid timeframe or tick data'
    };
  }
  const expectedClosedTime =
    Math.floor(epoch / seconds) * seconds - seconds;
  const closed = candles.find(
    c => Number(c.time) === expectedClosedTime
  );
  if (!closed) {
    return {
      ...result,
      reason: 'Waiting for latest completed candle'
    };
  }
  const buy = signal.side === 'BUY';
  const sign = buy ? 1 : -1;
  const body = sign * (closed.close - closed.open);
  const range = closed.high - closed.low;
  const ratio = range > 0 ? body / range : 0;
  const touchedZone =
    closed.low <= signal.zoneHigh &&
    closed.high >= signal.zoneLow;
  const closeBeyondZone = buy
    ? closed.close > signal.zoneHigh
    : closed.close < signal.zoneLow;
  const candleValid =
    body > 0 &&
    ratio >= 0.3 &&
    touchedZone &&
    closeBeyondZone;
  const timingValid =
    closed.time + seconds > signal.tapEpoch &&
    epoch >= closed.time + seconds &&
    epoch < closed.time + seconds * 2;
  const resultInfo = {
    ...result,
    bodyPercent: Math.round(ratio * 1000) / 10,
    touchedZone,
    closeBeyondZone,
    candleValid,
    timingValid,
    candleTime: closed.time
  };
  if (!timingValid) {
    return {
      ...resultInfo,
      reason: 'Waiting for a valid post-tap rejection candle'
    };
  }
  if (!touchedZone) {
    return {
      ...resultInfo,
      reason: 'Rejection candle did not touch the zone'
    };
  }
  if (!closeBeyondZone) {
    return {
      ...resultInfo,
      reason: 'Candle did not close beyond the zone'
    };
  }
  if (ratio < 0.3 || body <= 0) {
    return {
      ...resultInfo,
      reason: 'Candle body below required 30%'
    };
  }
  return {
    ...resultInfo,
    state: candleValid ? 'CHECKING' : 'WAIT',
    reason: 'Rejection candle passed; scanner confirmation pending'
  };
}
