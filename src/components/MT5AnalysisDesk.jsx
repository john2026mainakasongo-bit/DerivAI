import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, LineSeries, createChart, createSeriesMarkers } from "lightweight-charts";
import { readStored, writeStored, freshTick, captureSignal, advanceSignals, SIGNAL_KEY } from "../utils/mt5ViewerState";
import usePublicDerivTicks from "../hooks/usePublicDerivTicks";

const TF = {
  "1m": 60, "2m": 120, "3m": 180, "5m": 300, "10m": 600,
  "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
  "4h": 14400, "8h": 28800, "24h": 86400,
};
const n = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const keyOf = (m) => String(m?.id || m?.symbol || "");
const labelOf = (m) => String(m?.label || m?.short || m?.id || "Market");
const avg = (a) => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));

function chartPriceFormat(chartKey, price) {
  const key = String(chartKey || "").toUpperCase();

  if (key.includes("JPY")) {
    return { type:"price", precision:3, minMove:0.001 };
  }

  if (
    key.includes("XAU") ||
    key.includes("XAG") ||
    key.includes("BTC") ||
    key.includes("ETH")
  ) {
    return { type:"price", precision:2, minMove:0.01 };
  }

  if (
    key.includes("EURUSD") ||
    key.includes("GBPUSD") ||
    key.includes("AUDUSD") ||
    key.includes("NZDUSD") ||
    key.includes("USDCAD") ||
    key.includes("USDCHF") ||
    key.includes("EURGBP")
  ) {
    return { type:"price", precision:5, minMove:0.00001 };
  }

  if (Number(price) >= 1000) {
    return { type:"price", precision:2, minMove:0.01 };
  }

  return { type:"price", precision:5, minMove:0.00001 };
}

function candlesFromTicks(rows, seconds) {
  const map = new Map();
  for (const r of rows || []) {
    const t = Math.floor(n(r?.epoch) / seconds) * seconds;
    const p = n(r?.quote, NaN);
    if (!t || !Number.isFinite(p)) continue;
    const c = map.get(t);
    if (!c) map.set(t,{time:t,open:p,high:p,low:p,close:p});
    else { c.high=Math.max(c.high,p); c.low=Math.min(c.low,p); c.close=p; }
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
}

function mergeLiveCandles(historical, ticks, seconds) {
  const base = normalizeCandles(historical);
  const live = candlesFromTicks(ticks, seconds);
  if (!live.length) return base;

  const map = new Map(base.map((c) => [c.time, c]));
  const newestBase = base.at(-1)?.time ?? -Infinity;

  for (const candle of live) {
    if (candle.time >= newestBase) {
      map.set(candle.time, candle);
    }
  }

  return [...map.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-500);
}
function ema(values, period) {
  if (!values.length) return [];
  const k=2/(period+1); let e=values[0];
  return values.map((v,i)=>{ if(i) e=v*k+e*(1-k); return e; });
}

function normalizeCandles(rows) {
  return (rows || [])
    .map((c) => ({
      time: Number(c?.time ?? c?.epoch),
      open: Number(c?.open),
      high: Number(c?.high),
      low: Number(c?.low),
      close: Number(c?.close),
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a,b)=>a.time-b.time);
}

function chartEvents(cs) {
  if (cs.length < 20) return [];

  const candidates = [];

  for (let i = 8; i < cs.length; i++) {
    const c = cs[i];
    const prior = cs.slice(Math.max(0, i - 12), i);
    const hi = Math.max(...prior.map((x) => x.high));
    const lo = Math.min(...prior.map((x) => x.low));
    const range = Math.max(c.high - c.low, 1e-9);
    const body = Math.abs(c.close - c.open);
    const upper = (c.high - Math.max(c.open, c.close)) / range;
    const lower = (Math.min(c.open, c.close) - c.low) / range;

    if (c.close > hi && c.open <= hi) {
      const future = cs.slice(i + 1, Math.min(cs.length, i + 6));
      const failed = future.some(x => x.close < hi);

      candidates.push({
        time: c.time,
        position: "aboveBar",
        color: failed ? "#ffb454" : "#24dfb0",
        shape: failed ? "circle" : "arrowUp",
        text: failed ? "FAILED BREAK" : "BULL BREAK",
        priority: failed ? 7 : 8,
      });
    }

    if (c.close < lo && c.open >= lo) {
      const future = cs.slice(i + 1, Math.min(cs.length, i + 6));
      const failed = future.some(x => x.close > lo);

      candidates.push({
        time: c.time,
        position: "belowBar",
        color: failed ? "#ffb454" : "#ff6685",
        shape: failed ? "circle" : "arrowDown",
        text: failed ? "FAILED BREAK" : "BEAR BREAK",
        priority: failed ? 7 : 8,
      });
    }

    if (upper > 0.45 && c.close < c.open && c.high >= hi && body / range > 0.18) {
      candidates.push({
        time: c.time,
        position: "aboveBar",
        color: "#ff9a66",
        shape: "circle",
        text: "LIQ",
        priority: 4,
      });
    }

    if (lower > 0.45 && c.close > c.open && c.low <= lo && body / range > 0.18) {
      candidates.push({
        time: c.time,
        position: "belowBar",
        color: "#27dabb",
        shape: "circle",
        text: "LIQ",
        priority: 4,
      });
    }

    const breakoutUp = cs
      .slice(Math.max(0, i - 8), i)
      .some((x) => x.close > hi);

    const breakoutDn = cs
      .slice(Math.max(0, i - 8), i)
      .some((x) => x.close < lo);

    if (breakoutUp && c.low <= hi && c.close > hi) {
      candidates.push({
        time: c.time,
        position: "belowBar",
        color: "#55e6bf",
        shape: "circle",
        text: "RETEST",
        priority: 6,
      });
    }

    if (breakoutDn && c.high >= lo && c.close < lo) {
      candidates.push({
        time: c.time,
        position: "aboveBar",
        color: "#ff8aa0",
        shape: "circle",
        text: "RETEST",
        priority: 6,
      });
    }

    if (lower > 0.5 && c.close > c.open && body / range > 0.2) {
      candidates.push({
        time: c.time,
        position: "belowBar",
        color: "#62efc6",
        shape: "circle",
        text: "REJECT",
        priority: 3,
      });
    }

    if (upper > 0.5 && c.close < c.open && body / range > 0.2) {
      candidates.push({
        time: c.time,
        position: "aboveBar",
        color: "#ff7f98",
        shape: "circle",
        text: "REJECT",
        priority: 3,
      });
    }
  }

  const byTime = new Map();

  for (const event of candidates) {
    const existing = byTime.get(event.time);
    if (!existing || event.priority > existing.priority) {
      byTime.set(event.time, event);
    }
  }

  // Only show the strongest recent events. A failed break is intentionally
  // kept visible so a historical breakout cannot be mistaken for a current
  // entry signal after price has reclaimed the level.
  const recent = [...byTime.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-8);

  const result = [];
  let lastText = "";
  let lastTime = 0;

  for (const event of recent) {
    const tooClose =
      event.text === lastText &&
      event.time - lastTime < 180;

    if (tooClose) continue;

    result.push(event);
    lastText = event.text;
    lastTime = event.time;
  }

  return result;
}
function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const gain = Math.max(d, 0);
    const loss = Math.max(-d, 0);
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function macd(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (values.length < slowPeriod + signalPeriod) {
    return { line: 0, signal: 0, histogram: 0 };
  }
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const lineSeries = values.map((_, i) => fast[i] - slow[i]);
  const signalSeries = ema(lineSeries.slice(slowPeriod - 1), signalPeriod);
  const line = lineSeries.at(-1) || 0;
  const signal = signalSeries.at(-1) || 0;
  return { line, signal, histogram: line - signal };
}

function bollinger(values, period = 20, multiplier = 2) {
  if (values.length < period) return { mid:0, upper:0, lower:0, width:0 };
  const slice=values.slice(-period);
  const mid=avg(slice);
  const variance=avg(slice.map(v=>(v-mid)*(v-mid)));
  const deviation=Math.sqrt(Math.max(variance,0));
  return { mid, upper:mid+deviation*multiplier, lower:mid-deviation*multiplier, width:deviation*multiplier*2 };
}

function stochastic(cs, period = 14) {
  if (cs.length < period) return 50;
  const slice=cs.slice(-period);
  const high=Math.max(...slice.map(c=>c.high));
  const low=Math.min(...slice.map(c=>c.low));
  return high===low ? 50 : ((cs.at(-1).close-low)/(high-low))*100;
}

function adx(cs, period = 14) {
  if (cs.length < period * 2 + 2) return { adx: 0, plus: 0, minus: 0 };
  const tr = [];
  const plusDm = [];
  const minusDm = [];
  for (let i = 1; i < cs.length; i++) {
    const cur = cs[i];
    const prev = cs[i - 1];
    const trueRange = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    const up = cur.high - prev.high;
    const down = prev.low - cur.low;
    tr.push(trueRange);
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  let atr = avg(tr.slice(0, period));
  let p = avg(plusDm.slice(0, period));
  let m = avg(minusDm.slice(0, period));
  const dx = [];
  let plus = 0;
  let minus = 0;
  for (let i = period; i < tr.length; i++) {
    atr = ((atr * (period - 1)) + tr[i]) / period;
    p = ((p * (period - 1)) + plusDm[i]) / period;
    m = ((m * (period - 1)) + minusDm[i]) / period;
    plus = atr ? (100 * p / atr) : 0;
    minus = atr ? (100 * m / atr) : 0;
    const sum = plus + minus;
    dx.push(sum ? 100 * Math.abs(plus - minus) / sum : 0);
  }
  const adxValue = dx.length ? avg(dx.slice(-period)) : 0;
  return { adx: adxValue, plus, minus };
}

function candlePattern(cs) {
  if (cs.length < 3) return "NONE";
  const a = cs.at(-2);
  const b = cs.at(-1);
  const range = Math.max(b.high - b.low, 1e-9);
  const body = Math.abs(b.close - b.open);
  const upper = b.high - Math.max(b.open, b.close);
  const lower = Math.min(b.open, b.close) - b.low;

  const bullishEngulf =
    a.close < a.open &&
    b.close > b.open &&
    b.open <= a.close &&
    b.close >= a.open;
  const bearishEngulf =
    a.close > a.open &&
    b.close < b.open &&
    b.open >= a.close &&
    b.close <= a.open;
  const bullishPin = lower / range >= 0.55 && body / range <= 0.4 && b.close > b.open;
  const bearishPin = upper / range >= 0.55 && body / range <= 0.4 && b.close < b.open;

  if (bullishEngulf) return "BULLISH ENGULFING";
  if (bearishEngulf) return "BEARISH ENGULFING";
  if (bullishPin) return "BULLISH PIN BAR";
  if (bearishPin) return "BEARISH PIN BAR";
  return "NONE";
}

function fibonacciLevels(high, low, bullish) {
  const range = Math.max(high - low, 0);
  if (!range) return null;
  return {
    level382: bullish ? high - range * 0.382 : low + range * 0.382,
    level50: bullish ? high - range * 0.5 : low + range * 0.5,
    level618: bullish ? high - range * 0.618 : low + range * 0.618,
  };
}

function strategyForVolatility(marketKey = "", marketLabel = "") {
  const text = `${marketKey} ${marketLabel}`.toUpperCase();
  const highFrequency = /HIGH\s*FREQUENCY|\bHF\b/.test(text);
  const m = text.match(/(?:VOLATILITY|VOL|VSI)[^0-9]*(\d+(?:\.\d+)?)/);
  const level = m ? Number(m[1]) : null;

  if (highFrequency) {
    return {
      name: "HFV TREND + RETEST",
      mode: "FAST",
      minAdx: 23,
      breakoutLookback: 12,
      pullbackAtr: 0.55,
      stopAtr: 1.25,
      minRR: 1.8,
    };
  }

  if (level !== null && level >= 100) {
    return {
      name: "HIGH-VOL BREAKOUT + RETEST",
      mode: "BREAKOUT",
      minAdx: 22,
      breakoutLookback: 18,
      pullbackAtr: 0.70,
      stopAtr: 1.35,
      minRR: 2.0,
    };
  }

  if (level !== null && level <= 30) {
    return {
      name: "LOW-VOL PULLBACK + REJECTION",
      mode: "PULLBACK",
      minAdx: 18,
      breakoutLookback: 20,
      pullbackAtr: 0.80,
      stopAtr: 1.10,
      minRR: 1.8,
    };
  }

  return {
    name: "ADAPTIVE TREND + BREAKOUT RETEST",
    mode: "ADAPTIVE",
    minAdx: 20,
    breakoutLookback: 16,
    pullbackAtr: 0.65,
    stopAtr: 1.20,
    minRR: 1.9,
  };
}

function analyze(cs, marketKey = "", marketLabel = "") {
  const strategy = strategyForVolatility(marketKey, marketLabel);
  if (cs.length < 35) {
    return {
      signal:"WAIT", bias:"BUILDING", direction:"BUILDING", score:0, confidence:0,
      setup:"WAITING FOR DATA", strategy:strategy.name, structure:"BUILDING", liquidity:"WAITING",
      momentum:"WAITING", reason:`Need more candles (${cs.length}/35).`, confirmations:[],
      entry:null, stop:null, target:null, tp1:null, tp2:null, tp3:null, riskDistance:null, support:null,resistance:null,ema20:null,ema50:null,
      ema200:null,atr:null,rsi:50,macd:0,macdSignal:0,macdHistogram:0,adx:0,stoch:50,bollinger:null,
      fib:null, orderBlock:null, pattern:"NONE", projectedPath:[] , rr:null
    };
  }

  const closes=cs.map(c=>c.close);
  const last=cs.at(-1);
  const prev=cs.at(-2);
  const e20=ema(closes,20).at(-1);
  const e50=ema(closes,50).at(-1);
  const e200=ema(closes,Math.min(200,closes.length)).at(-1);
  const e20Prev=ema(closes,20).at(-2);
  const e50Prev=ema(closes,50).at(-2);

  const ranges=cs.slice(-20).map((c,i)=>{
    if(!i) return Math.max(c.high-c.low,1e-9);
    const p=cs.at(-21+i);
    return Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));
  });
  const atr=Math.max(avg(ranges),1e-9);
  const lookback=cs.slice(-(strategy.breakoutLookback+1),-1);
  const hi=Math.max(...lookback.map(c=>c.high));
  const lo=Math.min(...lookback.map(c=>c.low));
  const recentSwingHigh=Math.max(...cs.slice(-12,-1).map(c=>c.high));
  const recentSwingLow=Math.min(...cs.slice(-12,-1).map(c=>c.low));

  const bullish=last.close>e20 && e20>e50 && e50>=e200;
  const bearish=last.close<e20 && e20<e50 && e50<=e200;
  const emaSlopeUp=e20>e20Prev && e50>=e50Prev;
  const emaSlopeDown=e20<e20Prev && e50<=e50Prev;

  const range=Math.max(last.high-last.low,1e-9);
  const body=Math.abs(last.close-last.open);
  const upper=(last.high-Math.max(last.open,last.close))/range;
  const lower=(Math.min(last.open,last.close)-last.low)/range;
  const strongBull=last.close>last.open && body/range>=0.45;
  const strongBear=last.close<last.open && body/range>=0.45;

  const breakUp=last.close>hi+atr*0.05;
  const breakDn=last.close<lo-atr*0.05;
  const sweepDn=last.low<lo-atr*0.08 && last.close>lo;
  const sweepUp=last.high>hi+atr*0.08 && last.close<hi;
  const sharpRejectBuy=lower>=0.42 && last.close>last.open && (last.close-last.low)>=range*0.55;
  const sharpRejectSell=upper>=0.42 && last.close<last.open && (last.high-last.close)>=range*0.55;
  const nearEma20=Math.abs(last.close-e20)<=atr*0.65;

  // Pullback is tracked as a live phase instead of only becoming visible
  // after the confirmation candle has already closed. This gives the desk a
  // useful "entry watch" state while the pullback is still developing.
  const priorHigh8=Math.max(...cs.slice(-9,-1).map(c=>c.high));
  const priorLow8=Math.min(...cs.slice(-9,-1).map(c=>c.low));
  const retracingIntoBuyZone=bullish&&nearEma20&&last.low<=e20+atr*(strategy.pullbackAtr+0.18)&&priorHigh8-last.close>=atr*0.30;
  const retracingIntoSellZone=bearish&&nearEma20&&last.high>=e20-atr*(strategy.pullbackAtr+0.18)&&last.close-priorLow8>=atr*0.30;
  const pullbackBuy=retracingIntoBuyZone&&(strongBull||sharpRejectBuy);
  const pullbackSell=retracingIntoSellZone&&(strongBear||sharpRejectSell);
  const recentBreakUp=cs.slice(-8,-1).some(c=>c.close>hi);
  const recentBreakDn=cs.slice(-8,-1).some(c=>c.close<lo);
  const retestBuy=recentBreakUp&&last.low<=hi+atr*0.45&&last.close>hi&&last.close>last.open;
  const retestSell=recentBreakDn&&last.high>=lo-atr*0.45&&last.close<lo&&last.close<last.open;
  const continuationBuy=bullish&&last.close>prev.high&&last.close>e20&&strongBull;
  const continuationSell=bearish&&last.close<prev.low&&last.close<e20&&strongBear;

  const momentum=avg(cs.slice(-5).map(c=>c.close-c.open))/atr;
  const structureBull=last.high>Math.max(...cs.slice(-8,-3).map(c=>c.high));
  const structureBear=last.low<Math.min(...cs.slice(-8,-3).map(c=>c.low));
  const rsiValue=rsi(closes,14);
  const macdValue=macd(closes);
  const adxValue=adx(cs,14);
  const pattern=candlePattern(cs);
  const pullbackExhaustBuy=retracingIntoBuyZone && momentum>-0.05 && (pattern==="BULLISH ENGULFING" || pattern==="BULLISH PIN BAR" || strongBull || sharpRejectBuy);
  const pullbackExhaustSell=retracingIntoSellZone && momentum<0.05 && (pattern==="BEARISH ENGULFING" || pattern==="BEARISH PIN BAR" || strongBear || sharpRejectSell);
  const bb=bollinger(closes,20,2);
  const stoch=stochastic(cs,14);

  const macdBull=macdValue.line>macdValue.signal && macdValue.histogram>0;
  const macdBear=macdValue.line<macdValue.signal && macdValue.histogram<0;
  const rsiBull=rsiValue>=52 && rsiValue<=78;
  const rsiBear=rsiValue<=48 && rsiValue>=22;
  const trendStrength=adxValue.adx>=strategy.minAdx;
  const bbBull=last.close>bb.mid && last.close<bb.upper*1.01;
  const bbBear=last.close<bb.mid && last.close>bb.lower*0.99;
  const stochBull=stoch>=50 && stoch<=92;
  const stochBear=stoch<=50 && stoch>=8;
  const priorRangeRows=cs.slice(Math.max(1,cs.length-40),Math.max(1,cs.length-20));
  const priorAvgRange=priorRangeRows.length
    ? avg(priorRangeRows.map(c=>{
        const idx=cs.indexOf(c);
        const p=cs[idx-1] || c;
        return Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));
      }))
    : atr;
  const volatilityExpansion=atr > priorAvgRange*1.05;

  const buy=[
    ["Trend alignment",bullish],
    ["EMA slope",emaSlopeUp],
    ["Market structure",structureBull],
    ["MACD momentum",macdBull],
    ["RSI regime",rsiBull],
    ["Breakout",breakUp],
    ["Retest",retestBuy],
    ["Liquidity sweep",sweepDn],
    ["Sharp rejection",sharpRejectBuy],
    ["Pullback entry",pullbackBuy],
    ["Continuation",continuationBuy],
    ["Trend strength",trendStrength],
    ["Bollinger regime",bbBull],
    ["Stochastic",stochBull],
    ["Volatility expansion",volatilityExpansion],
    ["Bullish candle",pattern==="BULLISH ENGULFING"||pattern==="BULLISH PIN BAR"]
  ];
  const sell=[
    ["Trend alignment",bearish],
    ["EMA slope",emaSlopeDown],
    ["Market structure",structureBear],
    ["MACD momentum",macdBear],
    ["RSI regime",rsiBear],
    ["Breakout",breakDn],
    ["Retest",retestSell],
    ["Liquidity sweep",sweepUp],
    ["Sharp rejection",sharpRejectSell],
    ["Pullback entry",pullbackSell],
    ["Continuation",continuationSell],
    ["Trend strength",trendStrength],
    ["Bollinger regime",bbBear],
    ["Stochastic",stochBear],
    ["Volatility expansion",volatilityExpansion],
    ["Bearish candle",pattern==="BEARISH ENGULFING"||pattern==="BEARISH PIN BAR"]
  ];

  const bc=buy.filter(x=>x[1]).length;
  const sc=sell.filter(x=>x[1]).length;
  const raw=bc===sc?"WAIT":bc>sc?"BUY":"SELL";
  const confirmations=Math.max(bc,sc);
  const score=clamp(Math.round((confirmations/16)*72 + (Math.abs(bc-sc)*3) + (trendStrength?8:0) + ((raw==="BUY"&&bullish)||(raw==="SELL"&&bearish)?10:0)),0,100);
  const regimeSetup =
    strategy.mode==="BREAKOUT"
      ? (breakUp || retestBuy || breakDn || retestSell)
      : strategy.mode==="PULLBACK"
        ? (pullbackBuy || pullbackSell || sharpRejectBuy || sharpRejectSell)
        : (pullbackBuy || pullbackSell || retestBuy || retestSell || continuationBuy || continuationSell);

  // Require trend/structure confirmation plus a concrete entry trigger.
  // WAIT is preferred to forcing a trade when the regime is unclear.
  const strongSetup=raw!=="WAIT" &&
    confirmations>=7 &&
    score>=62 &&
    trendStrength &&
    regimeSetup;
  const signal=strongSetup?raw:"WAIT";

  // A watchable setup can exist before the final confirmation candle. It is
  // intentionally NOT reported as BUY/SELL yet; it is an actionable trigger
  // with a pre-calculated risk plan.
  const buyEntryWatch=signal==="WAIT" && raw==="BUY" && bullish && score>=55 &&
    (retracingIntoBuyZone || recentBreakUp || retestBuy || continuationBuy || sharpRejectBuy);
  const sellEntryWatch=signal==="WAIT" && raw==="SELL" && bearish && score>=55 &&
    (retracingIntoSellZone || recentBreakDn || retestSell || continuationSell || sharpRejectSell);
  const watchSide=buyEntryWatch?"BUY":sellEntryWatch?"SELL":null;

  const structure=bullish?"BULLISH STRUCTURE":bearish?"BEARISH STRUCTURE":"RANGE / TRANSITION";
  const direction=bullish&&bc>=sc+1?"UP":bearish&&sc>=bc+1?"DOWN":"RANGE";
  const bias=direction==="UP"?"BULLISH":direction==="DOWN"?"BEARISH":"NEUTRAL";
  const liquidity=sweepDn?"SELL-SIDE SWEPT":sweepUp?"BUY-SIDE SWEPT":"NO CLEAR SWEEP";
  const momentumLabel=momentum>.35?"STRONG BULLISH":momentum<-.35?"STRONG BEARISH":momentum>.1?"BULLISH":momentum<-.1?"BEARISH":"NEUTRAL";

  const buySetup=sharpRejectBuy?"SHARP REJECTION":retestBuy?"BREAKOUT RETEST":pullbackBuy?"PULLBACK ENTRY":breakUp?"BREAKOUT":continuationBuy?"CONTINUATION":sweepDn?"LIQUIDITY SWEEP":"WAITING SETUP";
  const sellSetup=sharpRejectSell?"SHARP REJECTION":retestSell?"BREAKOUT RETEST":pullbackSell?"PULLBACK ENTRY":breakDn?"BREAKOUT":continuationSell?"CONTINUATION":sweepUp?"LIQUIDITY SWEEP":"WAITING SETUP";
  const setup=raw==="BUY"?buySetup:raw==="SELL"?sellSetup:(sharpRejectBuy||sharpRejectSell)?"SHARP REJECTION WATCH":(pullbackBuy||pullbackSell)?"PULLBACK WATCH":(breakUp||breakDn)?"BREAKOUT WATCH":"WAITING SETUP";

  const atrSafe=Math.max(atr,1e-9);
  let entry=null,stop=null,target=null,entryType="WAIT";
  let tp1=null,tp2=null,tp3=null,riskDistance=null;
  const planSide=signal!=="WAIT"?signal:watchSide;
  if(planSide==="BUY"){
    // Confirmed entries use the current close. Entry-watch setups use the
    // current candle high so the desk only triggers if price starts to push.
    entry=Number((signal==="BUY"?last.close:Math.max(last.high,last.close)).toFixed(5));
    entryType=signal==="BUY"
      ? (sharpRejectBuy?"REJECTION BUY":retestBuy?"RETEST BUY":pullbackBuy?"PULLBACK BUY":breakUp?"BREAKOUT BUY":"MOMENTUM BUY")
      : (retracingIntoBuyZone?"PULLBACK ENTRY WATCH":"BREAKOUT ENTRY WATCH");
    const pullbackLow=Math.min(...cs.slice(-4).map(c=>c.low));
    const structureStop=Math.min(recentSwingLow,pullbackLow,last.close-atrSafe*strategy.stopAtr);
    riskDistance=Math.max(entry-structureStop,atrSafe*0.75);
    stop=Number((entry-riskDistance).toFixed(5));
    tp1=Number((entry+riskDistance*1.0).toFixed(5));
    tp2=Number((entry+riskDistance*2.0).toFixed(5));
    tp3=Number((Math.max(entry+riskDistance*2.5,recentSwingHigh)).toFixed(5));
    target=tp2;
  }
  if(planSide==="SELL"){
    entry=Number((signal==="SELL"?last.close:Math.min(last.low,last.close)).toFixed(5));
    entryType=signal==="SELL"
      ? (sharpRejectSell?"REJECTION SELL":retestSell?"RETEST SELL":pullbackSell?"PULLBACK SELL":breakDn?"BREAKOUT SELL":"MOMENTUM SELL")
      : (retracingIntoSellZone?"PULLBACK ENTRY WATCH":"BREAKDOWN ENTRY WATCH");
    const pullbackHigh=Math.max(...cs.slice(-4).map(c=>c.high));
    const structureStop=Math.max(recentSwingHigh,pullbackHigh,last.close+atrSafe*strategy.stopAtr);
    riskDistance=Math.max(structureStop-entry,atrSafe*0.75);
    stop=Number((entry+riskDistance).toFixed(5));
    tp1=Number((entry-riskDistance*1.0).toFixed(5));
    tp2=Number((entry-riskDistance*2.0).toFixed(5));
    tp3=Number((Math.min(entry-riskDistance*2.5,recentSwingLow)).toFixed(5));
    target=tp2;
  }

  const pullbackState=
    pullbackExhaustBuy?"BUY PULLBACK EXHAUSTION":
    pullbackExhaustSell?"SELL PULLBACK EXHAUSTION":
    retracingIntoBuyZone?"BUY PULLBACK ACTIVE":
    retracingIntoSellZone?"SELL PULLBACK ACTIVE":
    "NO ACTIVE PULLBACK";
  const planStatus=signal!=="WAIT"?"ENTRY CONFIRMED":watchSide?"ENTRY WATCH":"NO TRADE";

  const rangeHigh=Math.max(...cs.slice(-50).map(c=>c.high));
  const rangeLow=Math.min(...cs.slice(-50).map(c=>c.low));
  const fib=fibonacciLevels(rangeHigh,rangeLow,direction!=="DOWN");

  let orderBlock=null;
  for(let i=cs.length-2;i>=Math.max(2,cs.length-18);i--){
    const c=cs[i];
    const next=cs[i+1];
    if(direction==="UP"&&c.close<c.open&&next.close>c.high+atr*0.35){
      orderBlock={type:"BULLISH OB",low:c.low,high:c.high}; break;
    }
    if(direction==="DOWN"&&c.close>c.open&&next.close<c.low-atr*0.35){
      orderBlock={type:"BEARISH OB",low:c.low,high:c.high}; break;
    }
  }

  const rangeHigh50=rangeHigh;
  const rangeLow50=rangeLow;
  const bullTrigger=Number(Math.max(hi,recentSwingHigh).toFixed(5));
  const bearTrigger=Number(Math.min(lo,recentSwingLow).toFixed(5));
  const midpoint=(bullTrigger+bearTrigger)/2;
  const pressure=bullish || (bc>sc && momentum>=0) ? "BULLISH" : bearish || (sc>bc && momentum<=0) ? "BEARISH" : "NEUTRAL";
  const pathBias=direction==="UP"
    ? "→ RESISTANCE"
    : direction==="DOWN"
      ? "→ SUPPORT"
      : pressure==="BULLISH"
        ? "→ RESISTANCE · BREAKOUT WATCH"
        : pressure==="BEARISH"
          ? "→ SUPPORT · BREAKDOWN WATCH"
          : (last.close-midpoint)>=0 ? "→ RESISTANCE" : "→ SUPPORT";

  const projectedPath=[];
  // Keep projected paths proportional to the selected market. A stale
  // cross-market EMA must never create a 2x/3x price projection that
  // destroys the chart scale.
  const rawStep=Math.max(atrSafe,Math.abs(last.close-e20)*0.5);
  const step=Math.min(rawStep,Math.max(Math.abs(last.close)*0.03,atrSafe));
  const pathSeconds=TF_SECONDS_FOR_PATH(cs);
  if(direction==="UP"){
    const target=Math.max(bullTrigger,last.close+step);
    projectedPath.push(
      {time:last.time,price:last.close},
      {time:last.time+pathSeconds*2,price:Number(target.toFixed(5))},
      {time:last.time+pathSeconds*3,price:Number((target+step*0.55).toFixed(5))}
    );
  } else if(direction==="DOWN"){
    const target=Math.min(bearTrigger,last.close-step);
    projectedPath.push(
      {time:last.time,price:last.close},
      {time:last.time+pathSeconds*2,price:Number(target.toFixed(5))},
      {time:last.time+pathSeconds*3,price:Number((target-step*0.55).toFixed(5))}
    );
  } else {
    const target=pathBias.includes("RESISTANCE") ? bullTrigger : bearTrigger;
    const distance=Math.abs(target-last.close);
    const safeTarget=distance>step*0.35 ? target : last.close+(target>=last.close?step: -step);
    const continuation=safeTarget>=last.close ? safeTarget+step*0.35 : safeTarget-step*0.35;
    projectedPath.push(
      {time:last.time,price:last.close},
      {time:last.time+pathSeconds*2,price:Number(safeTarget.toFixed(5))},
      {time:last.time+pathSeconds*3,price:Number(continuation.toFixed(5))}
    );
  }

  const confidence=clamp(Math.round(45+confirmations*3+Math.min(Math.abs(bc-sc)*4,15)+(trendStrength?8:0)),45,94);
  let reason=`Market is ranging. ${pressure} pressure is present, but structure is not fully resolved.`;
  if(direction==="UP") reason=`Market structure is UP with ${bc}/16 bullish checks vs ${sc}/16 bearish. Path is toward resistance; watch pullbacks and retests.`;
  if(direction==="DOWN") reason=`Market structure is DOWN with ${sc}/16 bearish checks vs ${bc}/16 bullish. Path is toward support; watch rallies and retests.`;
  if(direction==="RANGE" && pressure==="BULLISH") reason=`Range with bullish pressure. Watch ${bullTrigger.toFixed(2)} for a confirmed breakout/retest; below ${bearTrigger.toFixed(2)} would invalidate the bullish scenario.`;
  if(direction==="RANGE" && pressure==="BEARISH") reason=`Range with bearish pressure. Watch ${bearTrigger.toFixed(2)} for a confirmed breakdown/retest; above ${bullTrigger.toFixed(2)} would weaken the bearish scenario.`;
  if(direction==="RANGE" && pressure==="NEUTRAL") reason=`Price is inside the current range between ${bearTrigger.toFixed(2)} and ${bullTrigger.toFixed(2)}. Wait for a clean break and retest.`;
  if(signal==="BUY") reason=`BUY setup detected from ${entryType}: ${bc}/16 bullish checks aligned. Confirm the level before manual execution.`;
  if(signal==="SELL") reason=`SELL setup detected from ${entryType}: ${sc}/16 bearish checks aligned. Confirm the level before manual execution.`;
  if(signal==="WAIT" && watchSide==="BUY") reason=`BUY ENTRY WATCH: ${pullbackState}. Trigger above ${entry}. SL ${stop}; wait for the push/confirmation.`;
  if(signal==="WAIT" && watchSide==="SELL") reason=`SELL ENTRY WATCH: ${pullbackState}. Trigger below ${entry}. SL ${stop}; wait for the push/confirmation.`;

  return {
    signal,bias,direction,score,confidence,setup,strategy:strategy.name,structure,liquidity,momentum:momentumLabel,reason,pressure,pathBias,
    confirmations:(raw==="BUY"?buy:sell).map(([name,ok])=>({name,ok})),entry,stop,target,tp1,tp2,tp3,riskDistance,entryType,
    planSide,planStatus,watchSide,pullbackState,pullbackExhaustion:pullbackExhaustBuy||pullbackExhaustSell,
    support:Number(Math.min(lo,recentSwingLow).toFixed(5)),
    resistance:Number(Math.max(hi,recentSwingHigh).toFixed(5)),
    bullTrigger,bearTrigger,rangeHigh:rangeHigh50,rangeLow:rangeLow50,
    ema20:Number(e20.toFixed(5)),ema50:Number(e50.toFixed(5)),ema200:Number(e200.toFixed(5)),atr:Number(atr.toFixed(5)),
    rsi:Number(rsiValue.toFixed(1)),macd:Number(macdValue.line.toFixed(5)),macdSignal:Number(macdValue.signal.toFixed(5)),macdHistogram:Number(macdValue.histogram.toFixed(5)),
    adx:Number(adxValue.adx.toFixed(1)),plusDI:Number(adxValue.plus.toFixed(1)),minusDI:Number(adxValue.minus.toFixed(1)),
    bollinger:{upper:Number(bb.upper.toFixed(5)),mid:Number(bb.mid.toFixed(5)),lower:Number(bb.lower.toFixed(5))},
    stoch:Number(stoch.toFixed(1)),
    pattern,fib,orderBlock,projectedPath,rr:planSide?2:null
  };
}

function TF_SECONDS_FOR_PATH(cs) {
  if (cs.length < 2) return 60;
  const delta=Math.max(60,Number(cs.at(-1).time)-Number(cs.at(-2).time));
  return delta;
}

function structureEvents(cs) {
  if (cs.length < 12) return [];
  const out = [];
  let lastSwingHigh = null;
  let lastSwingLow = null;
  for (let i = 3; i < cs.length - 3; i++) {
    const c = cs[i];
    const left = cs.slice(i - 3, i);
    const right = cs.slice(i + 1, i + 4);
    const swingHigh = c.high > Math.max(...left.map(x => x.high)) && c.high >= Math.max(...right.map(x => x.high));
    const swingLow = c.low < Math.min(...left.map(x => x.low)) && c.low <= Math.min(...right.map(x => x.low));
    if (swingHigh) lastSwingHigh = c.high;
    if (swingLow) lastSwingLow = c.low;
    if (lastSwingHigh != null && c.close > lastSwingHigh) {
      out.push({time:c.time,position:"aboveBar",color:"#23dfb4",shape:"arrowUp",text:"BOS",priority:8});
      lastSwingHigh = null;
    }
    if (lastSwingLow != null && c.close < lastSwingLow) {
      out.push({time:c.time,position:"belowBar",color:"#ff6685",shape:"arrowDown",text:"BOS",priority:8});
      lastSwingLow = null;
    }
  }
  return out;
}

function fvgEvents(cs) {
  if (cs.length < 5) return [];
  const out = [];
  for (let i = 2; i < cs.length; i++) {
    const a = cs[i - 2], c = cs[i];
    if (c.low > a.high) {
      out.push({time:c.time,position:"belowBar",color:"#36b7ff",shape:"square",text:"FVG",priority:5});
    } else if (c.high < a.low) {
      out.push({time:c.time,position:"aboveBar",color:"#b38cff",shape:"square",text:"FVG",priority:5});
    }
  }
  return out;
}

function chartViewStorageKey(chartKey) {
  // v2 intentionally invalidates the older raw logical ranges, which could
  // be tied to a different candle count after a refresh/timeframe switch.
  return `derivai:mt5:chart-view:v2:${chartKey || "default"}`;
}

function readSavedChartRange(chartKey) {
  try {
    const raw = window.localStorage.getItem(chartViewStorageKey(chartKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Number.isFinite(parsed?.from) || !Number.isFinite(parsed?.to)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveChartRange(chartKey, range, dataCount = 0) {
  try {
    if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return;
    window.localStorage.setItem(chartViewStorageKey(chartKey), JSON.stringify({
      from: range.from,
      to: range.to,
      dataCount: Number.isFinite(dataCount) ? dataCount : 0,
      savedAt: Date.now()
    }));
  } catch {}
}

function defaultVisibleBars(dataCount) {
  if (!Number.isFinite(dataCount) || dataCount <= 0) return { from: 0, to: 0 };
  const bars = Math.min(80, Math.max(36, dataCount - 1));
  return {
    from: Math.max(-1, dataCount - bars - 1),
    to: dataCount + 5,
  };
}

function Chart({candles,analysis,chartKey,signalHistory=[],focusedSignal,tools}) {
  const el=useRef(null);
  const chartRef=useRef(null);
  const seriesRef=useRef(null);
  const priceLinesRef=useRef([]);
  const markerPrimitiveRef=useRef(null);
  const projectionSeriesRef=useRef(null);
  const overlaysRef=useRef([]);
  const firstDataKeyRef=useRef("");
  const lastDataKeyRef=useRef("");
  const datasetSignatureRef=useRef("");
  const chartKeyRef=useRef(chartKey || "default");
  const restoringRangeRef=useRef(false);
  const dataCountRef=useRef(0);

  useEffect(()=>{
    if(!el.current) return;

    const chart=createChart(el.current,{
      autoSize:true,
      layout:{
        background:{color:"#03111d"},
        textColor:"#8faab8",
        fontFamily:"Inter, system-ui, sans-serif"
      },
      grid:{
        vertLines:{color:"rgba(26,67,86,.22)"},
        horzLines:{color:"rgba(26,67,86,.22)"}
      },
      rightPriceScale:{
        borderColor:"#18445a",
        scaleMargins:{top:0.08,bottom:0.08},
        autoScale:true
      },
      timeScale:{
        borderColor:"#18445a",
        timeVisible:true,
        secondsVisible:false,
        barSpacing:8,
        minBarSpacing:2,
        maxBarSpacing:28,
        rightOffset:8,
        shiftVisibleRangeOnNewBar:true,
        lockVisibleTimeRangeOnResize:true
      },
      crosshair:{
        mode:1,
        vertLine:{
          color:"#4e91aa",
          width:1,
          style:2,
          labelBackgroundColor:"#0b3347"
        },
        horzLine:{
          color:"#4e91aa",
          width:1,
          style:2,
          labelBackgroundColor:"#0b3347"
        }
      },
      handleScale:{
        mouseWheel:true,
        pinch:true,
        axisPressedMouseMove:true,
        axisDoubleClickReset:true
      },
      handleScroll:{
        mouseWheel:true,
        pressedMouseMove:true,
        horzTouchDrag:true,
        vertTouchDrag:true
      }
    });

    const series=chart.addSeries(CandlestickSeries,{
      upColor:"#18d6a1",
      downColor:"#ef607d",
      borderUpColor:"#18d6a1",
      borderDownColor:"#ef607d",
      wickUpColor:"#18d6a1",
      wickDownColor:"#ef607d",
      lastValueVisible:true,
      priceLineVisible:true,
      borderVisible:false,
        priceFormat:chartPriceFormat(chartKey, 0)
    });

    chartRef.current=chart;
    seriesRef.current=series;

    const ro=new ResizeObserver(()=>{
      if(el.current) {
        chart.resize(
          el.current.clientWidth,
          el.current.clientHeight
        );
      }
    });
    ro.observe(el.current);

    const persistRange = (range) => {
      if (restoringRangeRef.current) return;
      saveChartRange(chartKeyRef.current, range, dataCountRef.current);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(persistRange);

    return ()=>{
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(persistRange); } catch {}
      ro.disconnect();
      markerPrimitiveRef.current?.detach?.();
      markerPrimitiveRef.current=null;
      if(projectionSeriesRef.current){
        try { chart.removeSeries(projectionSeriesRef.current); } catch {}
      }
      projectionSeriesRef.current=null;
      chartRef.current=null;
      seriesRef.current=null;
      chart.remove();
    };
  },[]);

  useEffect(()=>{
    const chart=chartRef.current;
    const series=seriesRef.current;
    if(!chart || !series || !candles.length) return;

    // Keep the analysis on the full dataset, but render a recent window.
    // Also reject an obviously cross-market/bad-history candle from the
    // visual chart so one rogue quote cannot flatten the whole price scale.
    const visibleCandles = candles.slice(-180);
    const recentCloses = visibleCandles.slice(-20).map(c=>Number(c.close)).filter(Number.isFinite);
    const referencePrice = recentCloses.length
      ? recentCloses[recentCloses.length - 1]
      : Number(visibleCandles.at(-1)?.close);
    const displayCompatible=(c)=>{
      if(!Number.isFinite(referencePrice) || referencePrice===0) return true;
      const values=[c.open,c.high,c.low,c.close].map(Number);
      if(values.some(v=>!Number.isFinite(v))) return false;
      const minValue=Math.min(...values);
      const maxValue=Math.max(...values);
      const minRatio=Math.abs(minValue/referencePrice);
      const maxRatio=Math.abs(maxValue/referencePrice);
      return minRatio>=0.5 && maxRatio<=2 && maxValue>=minValue;
    };
    const safeVisibleCandles = visibleCandles.filter(displayCompatible);
    const data=safeVisibleCandles.map(c=>({
      time:c.time,
      open:c.open,
      high:c.high,
      low:c.low,
      close:c.close
    }));
    dataCountRef.current=data.length;

    
      // Keep the price axis precise for each instrument.
      // Example: EUR/USD 1.14633 must not display as 1.15.
      const latestPrice = Number(data.at(-1)?.close ?? candles.at(-1)?.close);

      series.applyOptions({
        priceFormat:chartPriceFormat(chartKey, latestPrice)
      });

      chartKeyRef.current = chartKey || "default";
    const firstKey=chartKey || String(candles[0]?.time || "");
    const dataSignature = [
      chartKey || "default",
      data.length,
      data[0]?.time || "",
      data.at(-1)?.time || ""
    ].join("|");
    const datasetChanged =
      !datasetSignatureRef.current ||
      datasetSignatureRef.current !== dataSignature;

    if(datasetChanged) {
      series.setData(data);
      firstDataKeyRef.current=firstKey;
      lastDataKeyRef.current="";
      datasetSignatureRef.current=dataSignature;

      // Restore the user's last zoom/pan for this exact market + timeframe.
      // Browser refreshes and component remounts therefore keep the same view.
      chartKeyRef.current = chartKey || "default";
      const savedRange = readSavedChartRange(chartKeyRef.current);
      const dataCount = data.length;
      const savedWidth = savedRange ? savedRange.to - savedRange.from : 0;
      const savedCount = Number(savedRange?.dataCount);
      const savedRightGap = Number.isFinite(savedCount)
        ? savedCount - savedRange.to
        : Infinity;
      const savedRangeIsValid = Boolean(
        savedRange &&
        dataCount >= 20 &&
        Number.isFinite(savedWidth) &&
        savedWidth >= 12 &&
        savedWidth <= Math.max(40, dataCount * 0.95) &&
        Number.isFinite(savedRightGap) &&
        savedRightGap >= -8 &&
        savedRightGap <= 40
      );
      restoringRangeRef.current = true;
      if (savedRangeIsValid) {
        // Re-anchor the saved range to the newest candle count. This prevents
        // a refresh or timeframe switch from opening in the middle of history.
        const to = dataCount - savedRightGap;
        const from = to - savedWidth;
        const normalizedRange = {
          from: Math.max(-1, from),
          to: Math.min(dataCount + 6, to),
        };
        requestAnimationFrame(() => {
          try {
            chart.timeScale().setVisibleLogicalRange(normalizedRange);
          } finally {
            restoringRangeRef.current = false;
          }
        });
      } else {
        // Always open a timeframe at the latest readable candle window.
        try { window.localStorage.removeItem(chartViewStorageKey(chartKeyRef.current)); } catch {}
        const initialRange = defaultVisibleBars(dataCount);
        chart.timeScale().setVisibleLogicalRange(initialRange);
        requestAnimationFrame(() => {
          saveChartRange(
            chartKeyRef.current,
            chart.timeScale().getVisibleLogicalRange(),
            dataCount
          );
        });
        requestAnimationFrame(() => { restoringRangeRef.current = false; });
      }
    } else {
      const last=candles.at(-1);

      if(last) {
        // This is the critical realtime path: the active candle is updated
        // from the newest Deriv tick without resetting the whole chart.
        series.update({
          time:last.time,
          open:last.open,
          high:last.high,
          low:last.low,
          close:last.close
        });
      }
    }

    lastDataKeyRef.current=String(candles.at(-1)?.time || "");
    datasetSignatureRef.current=dataSignature;

    for(const line of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch {}
    }
    priceLinesRef.current=[];

    // Keep the chart readable: only structural levels and actionable lines
    // stay on the price axis. The full indicator set remains in the dashboard.
    const plan=focusedSignal;
    const levels=[
      ["Support",analysis.support,"#27b9e7",1],
      ["Resistance",analysis.resistance,"#f3b756",1],
      ...(tools.scenarios?[["BUY trigger",analysis.bullTrigger,"#18d6a1",1],["SELL trigger",analysis.bearTrigger,"#ff6685",1]]:[]),
      ...(plan?[
        [`${plan.side} entry`,plan.entry,plan.side==='BUY'?"#18d6a1":"#ff6685",2],
        ["SL",plan.stop,"#ff6685",2],
        ["TP1",plan.tp1,"#18d6a1",1],
        ["TP2",plan.tp2,"#18d6a1",1],
        ["TP3",plan.tp3,"#18d6a1",1],
      ]:[])
    ];

    const visibleLow=data.length ? Math.min(...data.map(x=>x.low)) : -Infinity;
    const visibleHigh=data.length ? Math.max(...data.map(x=>x.high)) : Infinity;
    const lastPrice=candles.at(-1)?.close;

    // Never let a stale/cross-market analysis level distort the selected
    // chart. Indicator levels must be close to the chart's current price.
    const levelCompatible=(price)=>{
      if(!Number.isFinite(price) || !Number.isFinite(lastPrice) || lastPrice===0) return false;
      const ratio=Math.abs(price/lastPrice);
      const relative=Math.abs(price-lastPrice)/Math.max(Math.abs(lastPrice),1e-9);
      return ratio>=0.5 && ratio<=2 && relative<=0.75;
    };
    const chartPad=Math.max(analysis?.atr*3 || 0, Math.abs(visibleHigh-visibleLow)*0.08, Math.abs(lastPrice||0)*0.002);

    for(const [title,price,color,width] of levels){
      if(price==null || !levelCompatible(price)) continue;
      if(Number.isFinite(lastPrice) && (price < visibleLow-chartPad || price > visibleHigh+chartPad)) continue;
      const line=series.createPriceLine({
        price,
        color,
        lineWidth:width,
        lineStyle:title==="EMA20"||title==="EMA50"?0:2,
        axisLabelVisible:true,
        title
      });
      priceLinesRef.current.push(line);
    }


    for(const overlay of overlaysRef.current){try{chart.removeSeries(overlay);}catch{}}
    overlaysRef.current=[];
    const line=(points,color,style=0)=>{
      if(points.length<2) return;
      const overlay=chart.addSeries(LineSeries,{color,lineWidth:2,lineStyle:style,lastValueVisible:false,priceLineVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null});
      overlay.setData(points);overlaysRef.current.push(overlay);
    };
    if(tools.ema){
      for(const [period,color] of [[20,'#6faaff'],[50,'#e8ae63']]){
        const values=ema(data.map(c=>c.close),period);
        line(data.map((c,i)=>({time:c.time,value:values[i]})),color);
      }
    }
    if(tools.scenarios && data.length>35){
      const last=data.at(-1),seconds=TF_SECONDS_FOR_PATH(data);
      const step=Math.max(analysis.atr || 0,Math.abs(last.close)*0.0005);
      // Conditional paths, not predicted future prices; excluded from autoscale.
      for(const [trigger,sign,color] of [[analysis.bullTrigger,1,'#18d6a188'],[analysis.bearTrigger,-1,'#ff668588']]){
        if(trigger!=null && levelCompatible(trigger)) line([{time:last.time,value:last.close},{time:last.time+seconds*2,value:trigger},{time:last.time+seconds*4,value:trigger+sign*step}],color,2);
      }
    }
    const times=new Set(data.map(c=>c.time));
    const entryMarkers=signalHistory.filter(row=>times.has(row.time)).map(row=>({time:row.time,position:row.side==='BUY'?'belowBar':'aboveBar',color:row.side==='BUY'?'#18d6a1':'#ff6685',shape:row.side==='BUY'?'arrowUp':'arrowDown',text:`${row.side} · ${row.entry}`}));
    const structure=tools.structure?structureEvents(data).slice(-4):[];
    const markers=[...structure,...entryMarkers].sort((a,b)=>a.time-b.time);
    if(markerPrimitiveRef.current) markerPrimitiveRef.current.setMarkers(markers);
    else markerPrimitiveRef.current=createSeriesMarkers(series,markers);
  },[candles,analysis,chartKey,signalHistory,focusedSignal,tools]);

  const zoomBy=(factor)=>{
    const chart=chartRef.current;
    if(!chart) return;

    const range=chart.timeScale().getVisibleLogicalRange();
    if(!range) return;

    const center=(range.from+range.to)/2;
    const width=Math.max(
      8,
      (range.to-range.from)*factor
    );

    const nextRange={
      from:center-width/2,
      to:center+width/2
    };
    chart.timeScale().setVisibleLogicalRange(nextRange);
    saveChartRange(chartKeyRef.current, nextRange, candles.length);
  };

  const resetZoom=()=>{
    const chart=chartRef.current;
    if(!chart) return;

    chart.timeScale().fitContent();
    chart.timeScale().scrollToPosition(8,false);
    requestAnimationFrame(()=>saveChartRange(chartKeyRef.current, chart.timeScale().getVisibleLogicalRange(), candles.length));
  };

  const goRealtime=()=>{
    const chart=chartRef.current;
    if(!chart) return;

    chart.timeScale().scrollToRealTime();
  };

  return <div className="mt5ChartWrap">
    <div className="mt5ChartToolbar">
      <div className="mt5ChartToolsLeft">
        <span>CHART</span>
        <b>Price action</b>
      </div>
      <div className="mt5ChartToolsRight">
        <button type="button" onClick={()=>zoomBy(0.78)} title="Zoom in">+</button>
        <button type="button" onClick={()=>zoomBy(1.28)} title="Zoom out">−</button>
        <button type="button" onClick={goRealtime}>LIVE</button>
        <button type="button" onClick={resetZoom}>RESET</button>
      </div>
    </div>
    <div ref={el} className="mt5Chart"/>
  </div>;
}
export default function MT5AnalysisDesk(){
  const {
    markets=[],
    marketTicks={},
    marketCandleHistory={},
    candleHistory={},
    status,
    connected,
    symbol,
    changeSymbol,
    loadingMarket,
    connect,
    cacheWarning,
  }=usePublicDerivTicks({multiMarket:true,persistViewer:true});

  // Recover the Deriv feed after Chrome back-forward cache,
  // tab suspension, network changes, or returning to the MT5 desk.
  useEffect(()=>{
    let timer=null;

    const resumeFeed=()=>{
      if(document.visibilityState !== "visible") return;

      if(
        status === "OFFLINE" ||
        status === "DISCONNECTED"
      ){
        window.clearTimeout(timer);

        timer=window.setTimeout(()=>{
          void connect().catch(()=>{});
        },250);
      }
    };

    window.addEventListener("pageshow",resumeFeed);
    window.addEventListener("online",resumeFeed);
    document.addEventListener("visibilitychange",resumeFeed);

    resumeFeed();

    return ()=>{
      window.removeEventListener("pageshow",resumeFeed);
      window.removeEventListener("online",resumeFeed);
      document.removeEventListener("visibilitychange",resumeFeed);
      window.clearTimeout(timer);
    };
  },[connected,status,connect]);

  const supported=useMemo(()=>{
    // The hook already returns Deriv Volatility/Synthetic markets only.
    // Keep every returned volatility instrument instead of maintaining a
    // stale hand-written Forex/crypto watchlist.
    return [...markets].sort((a,b)=>{
      const la=labelOf(a).toUpperCase();
      const lb=labelOf(b).toUpperCase();
      const rank=(x)=>{
        const hf=/HIGH\s*FREQUENCY/.test(x)?1:0;
        const m=x.match(/(?:VOLATILITY|VOL|VSI)[^0-9]*(\d+(?:\.\d+)?)/);
        return [hf,m?Number(m[1]):9999,x];
      };
      const ra=rank(la), rb=rank(lb);
      return ra[0]-rb[0] || ra[1]-rb[1] || ra[2].localeCompare(rb[2]);
    });
  },[markets]);
  const [selected,setSelected]=useState(()=>readStored('derivai:mt5:prefs:v2',{}).market || '');
  const [tf,setTf]=useState(()=>{const saved=readStored('derivai:mt5:prefs:v2',{}).tf;return TF[saved]?saved:'5m';});
  const [tools,setTools]=useState({ema:true,scenarios:true,structure:false});
  const [clock,setClock]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return ()=>clearInterval(timer);},[]);
  useEffect(()=>{if(selected) writeStored('derivai:mt5:prefs:v2',{market:selected,tf});},[selected,tf]);
  const [signals,setSignals]=useState(()=>{const rows=readStored(SIGNAL_KEY,[]);return Array.isArray(rows)?rows.filter(r=>r && r.id && r.market && TF[r.tf] && ['BUY','SELL'].includes(r.side) && [r.entry,r.stop,r.tp1,r.tp2,r.tp3,r.time,r.detectedAt,r.lastEpoch].every(Number.isFinite)).slice(0,120):[];});
  const [signalWarning,setSignalWarning]=useState('');
  const signalsRef=useRef(signals);
  signalsRef.current=signals;
  const signalPersistRef=useRef(0);
  useEffect(()=>{
    const save=()=>{const ok=writeStored(SIGNAL_KEY,signalsRef.current);setSignalWarning(ok?'':'Signal history could not be saved.');};
    const timer=setInterval(save,5000);
    window.addEventListener('pagehide',save);
    return ()=>{save();clearInterval(timer);window.removeEventListener('pagehide',save);};
  },[]);
  const [focusId,setFocusId]=useState('');
  const [activeTrade,setActiveTrade]=useState(()=>{
    const saved=readStored('derivai:mt5:monitor:v2',null);
    return saved?.market===selected && saved?.tf===tf?saved:null;
  });
  const monitorContext=useRef(`${selected}:${tf}`);
  useEffect(()=>{writeStored('derivai:mt5:monitor:v2',activeTrade);},[activeTrade]);
  const analysisDialog=useRef(null);
  const journalDialog=useRef(null);
  const [journal,setJournal]=useState(()=>{try {const rows=JSON.parse(localStorage.getItem("derivai:mt5:journal:v1")||"[]"); return Array.isArray(rows)?rows:[];} catch {return [];}});
  const [journalNotice,setJournalNotice]=useState("");
  const savePlan=()=>{
    if(!focusedSignal) return;
    const row={id:Date.now(),market:labelOf(selectedMarket),tf,side:focusedSignal.side,entry:focusedSignal.entry,stop:focusedSignal.stop,tp1:focusedSignal.tp1,result:"Open"};
    const next=[row,...journal].slice(0,200);
    try { localStorage.setItem("derivai:mt5:journal:v1",JSON.stringify(next)); setJournal(next); setJournalNotice("Plan saved on this device."); } catch {setJournalNotice("Could not save: browser storage is unavailable.");}
  };
  const updateResult=(id,result)=>{
    const next=journal.map(row=>row.id===id?{...row,result}:row);
    try {localStorage.setItem("derivai:mt5:journal:v1",JSON.stringify(next));setJournal(next);} catch {setJournalNotice("Could not save result.");}
  };

  useEffect(()=>{
    if(supported.length && !supported.some(m=>keyOf(m)===selected)) setSelected(keyOf(supported[0]));
  },[selected,supported]);

  useEffect(()=>{
    if(!selected||!connected||selected===symbol) return;
    void changeSymbol(selected).catch(()=>{});
  },[selected,connected,symbol,changeSymbol]);

  // A manual trade monitor is deliberately opt-in. The desk never assumes
  // that a user entered a position merely because an analysis signal fired.
  useEffect(()=>{
    const context=`${selected}:${tf}`;
    if(monitorContext.current!==context) setActiveTrade(null);
    monitorContext.current=context;
  },[selected,tf]);

  const selectedMarket=supported.find(m=>keyOf(m)===selected)||supported[0];
  const selectedKey=keyOf(selectedMarket);
  const tickRows=selectedMarket?(marketTicks[selectedKey]||[]):[];

  const candlesByTf=useMemo(()=>{
    const out={};
    const perMarketHistory=marketCandleHistory?.[selectedKey] || {};

    for(const [label,seconds] of Object.entries(TF)){
      const historical=normalizeCandles(
        perMarketHistory[seconds] || []
      );

      // Always merge the latest subscribed ticks into the history for THIS
      // market. This prevents V100/V75 data from ever becoming the BTC chart
      // after a market switch or refresh.
      out[label]=mergeLiveCandles(
        historical,
        tickRows,
        seconds
      );
    }
    return out;
  },[marketCandleHistory,selectedKey,candleHistory,tickRows]);

  const cs=candlesByTf[tf]||[];
  const latestTick=tickRows.at(-1);
  const isLive=freshTick(connected,latestTick,clock);
  const closedAnalysis=useMemo(()=>analyze(cs.slice(0,-1),selectedKey,labelOf(selectedMarket)),[cs,selectedKey,selectedMarket]);
  const detector=useRef(readStored('derivai:mt5:detector:v2',{}));
  useEffect(()=>{
    if(!isLive || cs.length<36) return;
    const key=`${selectedKey}:${tf}`;
    const closedTime=cs.at(-2).time;
    if(closedTime!==Math.floor(Number(latestTick?.epoch)/TF[tf])*TF[tf]-TF[tf]) return;
    // Revisit once per closed candle; never generate signals from cached history.
    if(detector.current[key]?.time===closedTime) return;
    const signature=['BUY','SELL'].includes(closedAnalysis.signal)?`${closedAnalysis.signal}:${closedAnalysis.setup}`:'WAIT';
    const previous=detector.current[key];
    detector.current[key]={time:closedTime,signature};
    writeStored('derivai:mt5:detector:v2',detector.current);
    if(signature==='WAIT' || previous?.signature===signature) return;
    const now=Date.now();
    setSignals(rows=>{
      const next=captureSignal(rows,closedAnalysis,{market:selectedKey,tf,time:closedTime,now});
      writeStored(SIGNAL_KEY,next);
      return next;
    });
    setFocusId('');
  },[isLive,cs,closedAnalysis,selectedKey,tf]);
  useEffect(()=>{
    if(!latestTick || !isLive) return;
    setSignals(rows=>{
      const next=advanceSignals(rows,selectedKey,latestTick,true);
      const transition=next.some((r,i)=>r.status!==rows[i]?.status || r.entered!==rows[i]?.entered);
      if(transition || Date.now()-signalPersistRef.current>5000){writeStored(SIGNAL_KEY,next);signalPersistRef.current=Date.now();}
      return next;
    });
  },[latestTick,isLive,selectedKey]);
  const marketSignals=useMemo(()=>signals.filter(r=>r.market===selectedKey && r.tf===tf),[signals,selectedKey,tf]);
  const focusedSignal=marketSignals.find(r=>r.id===focusId)||marketSignals[0]||null;
  useEffect(()=>{
    if(isLive || !selectedKey) return;
    let busy=false;
    const timer=setInterval(()=>{if(!busy && document.visibilityState==='visible'){busy=true;Promise.resolve(connect()).catch(()=>{}).finally(()=>{busy=false;});}},15000);
    return ()=>clearInterval(timer);
  },[isLive,selectedKey,connect]);
  const analyses=useMemo(()=>{
    const out={};
    for(const m of supported){
      const k=keyOf(m);
      const scannerHistory=normalizeCandles(
        marketCandleHistory?.[k]?.[TF[tf]] || []
      );
      const liveTicks=marketTicks[k]||[];
      const market = supported.find(m=>keyOf(m)===k);
      out[k]=analyze(
        k===selectedKey
          ? (candlesByTf[tf]||[])
          : mergeLiveCandles(scannerHistory,liveTicks,TF[tf]),
        k,
        labelOf(market)
      );
    }
    return out;
  },[supported,selectedKey,candlesByTf,marketCandleHistory,marketTicks,tf]);

  const a=selectedMarket
    ? analyses[selectedKey]||analyze(cs, selectedKey, labelOf(selectedMarket))
    : analyze(cs, selectedKey, labelOf(selectedMarket));

  const livePrice=Number.isFinite(Number(cs.at(-1)?.close)) ? Number(cs.at(-1)?.close) : NaN;
  const tradeMonitor=useMemo(()=>{
    if(!activeTrade || !Number.isFinite(livePrice)) return null;
    const side=activeTrade.side;
    const entry=Number(activeTrade.entry);
    const stop=Number(activeTrade.stop);
    const tp1=Number(activeTrade.tp1);
    const tp2=Number(activeTrade.tp2);
    const tp3=Number(activeTrade.tp3);
    const favorable=side==="BUY"?livePrice-entry:entry-livePrice;
    const totalToTp2=side==="BUY"?tp2-entry:entry-tp2;
    const progress=totalToTp2>0?clamp(favorable/totalToTp2,0,1.25):0;
    const stopHit=side==="BUY"?livePrice<=stop:livePrice>=stop;
    const tp3Hit=side==="BUY"?livePrice>=tp3:livePrice<=tp3;
    const tp1Hit=side==="BUY"?livePrice>=tp1:livePrice<=tp1;
    const oppositeStructure=side==="BUY"
      ? (a.direction==="DOWN" || String(a.momentum||"").includes("BEARISH") || livePrice<a.ema20)
      : (a.direction==="UP" || String(a.momentum||"").includes("BULLISH") || livePrice>a.ema20);
    const invalidated=side==="BUY"?livePrice<=a.bearTrigger:livePrice>=a.bullTrigger;
    let status="HOLD";
    let reason="Structure and momentum are still supportive.";
    if(stopHit){
      status="EXIT NOW";
      reason="Stop-loss level has been reached. Protect the account; do not widen the stop.";
    } else if(invalidated){
      status="EXIT NOW";
      reason=`Market invalidation reached at ${side==="BUY"?a.bearTrigger:a.bullTrigger}.`;
    } else if(tp3Hit){
      status="TAKE PROFIT";
      reason="Final target zone reached. Protect/close the remaining position.";
    } else if(tp1Hit && oppositeStructure){
      status="EXIT WARNING";
      reason="TP1 was reached but continuation is weakening. Protect profit instead of waiting blindly for TP2.";
    } else if(progress>=0.75 && oppositeStructure){
      status="EXIT WARNING";
      reason="Price is deep into the target path while momentum/structure is turning against the position.";
    } else if(tp1Hit){
      status="TP1 REACHED";
      reason="TP1 reached and structure is still supportive. Consider protecting the position.";
    }
    return {status,reason,progress,tp1Hit,tp3Hit,stopHit,livePrice,favorable};
  },[activeTrade,livePrice,a]);

  const startTradeMonitor=()=>{
    if(!isLive || !focusedSignal) return;
    setActiveTrade({...focusedSignal,market:selectedKey,tf,startedAt:Date.now()});
  };

  const stopTradeMonitor=()=>setActiveTrade(null);

  const mtf=Object.entries(TF).map(([label,seconds])=>{
    const data=selectedMarket && label
      ? mergeLiveCandles(
          normalizeCandles(
            marketCandleHistory?.[selectedKey]?.[seconds] || []
          ),
          tickRows,
          seconds
        )
      : [];
    return {label,data,analysis:analyze(data, selectedKey, labelOf(selectedMarket))};
  });

  // Separate the active timeframe from the higher-timeframe context so a
  // short-term move does not get presented as the whole-market direction.
  const htfLabels=["1h","2h","4h","8h","24h"];
  const htfDirectional=mtf.filter(x=>htfLabels.includes(x.label)&&x.analysis?.direction&&x.analysis.direction!=="BUILDING");
  const htfUp=htfDirectional.filter(x=>x.analysis.direction==="UP").length;
  const htfDown=htfDirectional.filter(x=>x.analysis.direction==="DOWN").length;
  const htfBias=htfUp>htfDown&&htfUp>=2?"BULLISH":htfDown>htfUp&&htfDown>=2?"BEARISH":"MIXED / RANGE";
  const nextCondition=a.direction==="UP"
    ? `Hold above ${a.bullTrigger}. Watch retest toward resistance.`
    : a.direction==="DOWN"
      ? `Break below ${a.bearTrigger} confirms downside continuation.`
      : a.pressure==="BULLISH"
        ? `Break and retest above ${a.bullTrigger} confirms upside.`
        : a.pressure==="BEARISH"
          ? `Break and retest below ${a.bearTrigger} confirms downside.`
          : `Wait for a clean break of ${a.bullTrigger} or ${a.bearTrigger}.`;

  const confirmed=isLive && ["BUY","SELL"].includes(closedAnalysis.signal);
  const plan=activeTrade || focusedSignal;
  const shownSignal=isLive?(confirmed?closedAnalysis.signal:"WAIT"):"SYNCING";
  const signalClass=confirmed?closedAnalysis.signal.toLowerCase():"wait";
  const directionLabel=(value)=>value==="UP"?"Bullish":value==="DOWN"?"Bearish":value==="BUILDING"?"Loading":"Range";
  return <div className="mt5Desk">
    <header className="deskHeader">
      <a href="/dashboard" className="deskBrand" aria-label="DerivAI dashboard"><span>ϟ</span> DerivAI</a>
      <span className="deskTitle">MT5 Analysis Desk</span>
      <span className={`deskConnection ${isLive?"online":""}`}><i/>{isLive?"Live ticks":cs.length?"Cached · reconnecting":"Connecting"}</span>
    </header>
    <nav className="deskToolbar" aria-label="Market and timeframe">
      <select aria-label="Select market" value={selectedKey} onChange={e=>setSelected(e.target.value)}>
        {!supported.length && <option value="">Loading markets…</option>}
        {supported.map(m=><option key={keyOf(m)} value={keyOf(m)}>{labelOf(m)}</option>)}
      </select>
      <div className="deskFrames">{["1m","5m","15m","1h","4h","24h"].map(x=><button type="button" key={x} aria-pressed={tf===x} className={tf===x?"active":""} onClick={()=>setTf(x)}>{x==="24h"?"1D":x}</button>)}
        <select aria-label="All timeframes" value={tf} onChange={e=>setTf(e.target.value)}>{Object.keys(TF).map(x=><option key={x} value={x}>{x}</option>)}</select>
      </div>
    </nav>
    <div className="deskMain">
      <main className="deskChartColumn">
        <section className="deskChartPanel">
          <div className="deskChartHeading"><h1>{labelOf(selectedMarket)}</h1><b>{cs.at(-1)?.close??"—"}</b></div>
          <div className="deskToolRow">{[['ema','EMA 20/50'],['scenarios','BUY / SELL paths'],['structure','Structure']].map(([key,label])=><button type="button" key={key} aria-pressed={tools[key]} onClick={()=>setTools(value=>({...value,[key]:!value[key]}))}>{label}</button>)}<span>Dashed paths = conditional scenarios</span></div>
          <div className="deskChartArea"><Chart candles={cs} analysis={a} chartKey={`${selectedKey}:${tf}`} tools={tools} signalHistory={marketSignals} focusedSignal={activeTrade || focusedSignal}/>
          {!cs.length && <div className="deskEmpty">{loadingMarket?"Loading candles…":status||"Waiting for market data…"}</div>}</div>
        </section>
        <section className="deskOverview"><h2>TIMEFRAME OVERVIEW</h2><div>{mtf.filter(x=>["15m","1h","4h"].includes(x.label)).map(({label,analysis:z})=><button type="button" key={label} onClick={()=>setTf(label)}><b>{label}</b><span className={z.direction==="UP"?"buy":z.direction==="DOWN"?"sell":"wait"}>{directionLabel(z.direction)}</span></button>)}</div></section>
      </main>
      <aside className="deskSetup">
        <h2>CURRENT SETUP</h2><div className={`deskSignal ${signalClass}`}>{shownSignal}</div>
        <p className="deskSubtitle">{confirmed?closedAnalysis.setup:'Scanning for the next confirmed entry'}</p>
        <div className="deskBias"><b className={a.direction==='UP'?'buy':a.direction==='DOWN'?'sell':'wait'}>{a.direction==='UP'?'↑':a.direction==='DOWN'?'↓':'↔'} {directionLabel(a.direction)} bias</b><span>{a.pathBias || 'Waiting for data'}</span></div>
        <div className="deskTriggers"><div className="buy"><span>BUY ABOVE</span><b>{a.bullTrigger??"—"}</b></div><div className="sell"><span>SELL BELOW</span><b>{a.bearTrigger??"—"}</b></div></div>
        {focusedSignal && <div className="deskSignalPicker"><select aria-label="Chart signal" value={focusedSignal.id} onChange={e=>setFocusId(e.target.value)}>{marketSignals.map(r=><option key={r.id} value={r.id}>{r.side} · {new Date(r.detectedAt).toLocaleTimeString()} · {r.status}</option>)}</select><small>{focusedSignal.status}{focusedSignal.gapUnverified?' · Offline gap unverified':''}</small></div>}
        {activeTrade && <small>Monitoring your saved {activeTrade.side} entry</small>}
        <dl className="deskLevels"><div><dt>Entry</dt><dd>{plan?.entry??"—"}</dd></div><div><dt>Stop loss</dt><dd className="sell">{plan?.stop??"—"}</dd></div><div><dt>Take profit 1</dt><dd className="buy">{plan?.tp1??"—"}</dd></div></dl>
        {tradeMonitor ? <div className="deskMonitor"><b>{isLive?tradeMonitor.status:"OFFLINE — monitor paused"}</b><p>{isLive?tradeMonitor.reason:"Reconnect to resume live monitoring."}</p><button type="button" onClick={stopTradeMonitor}>Stop monitor</button></div> : <p className="deskHint">{confirmed?"Plan confirmed. Enter manually in MT5.":focusedSignal?"Saved signal on chart · scanning continues.":"New confirmed entries appear on the chart automatically."}</p>}
        {isLive && focusedSignal && !activeTrade && !["SL touched","TP3 touched","Expired"].includes(focusedSignal.status) && <button type="button" onClick={startTradeMonitor}>I entered {focusedSignal.side} · Monitor</button>}
        <button type="button" className="deskAnalysisButton" onClick={()=>analysisDialog.current.showModal()}>View analysis <span>›</span></button>
      </aside>
    </div>
    <footer className="deskFooter"><span>{cacheWarning || signalWarning || (isLive?`Last tick ${new Date(latestTick.epoch*1000).toLocaleTimeString()} · Auto-scanning` : "Saved chart · awaiting fresh ticks")}</span><button type="button" onClick={()=>journalDialog.current.showModal()}>Signal journal</button></footer>
    <dialog ref={analysisDialog} className="deskDialog"><form method="dialog"><h2>Analysis · {tf}</h2><button aria-label="Close analysis">✕</button></form>
      <p>{a.reason}</p><p>{nextCondition}</p>
      <dl className="deskLevels">{[["Strategy",a.strategy],["Higher timeframe bias",htfBias],["Structure",a.structure],["TP2",plan?.tp2],["TP3",plan?.tp3],["RSI",a.rsi],["ADX",a.adx]].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v??"—"}</dd></div>)}</dl>
      <h3>Confirmations</h3>{(a.confirmations||[]).map(x=><p key={x.name}>{x.ok?"✓":"○"} {x.name}</p>)}
      {focusedSignal && <button type="button" onClick={savePlan}>Save plan to journal</button>}<p role="status">{journalNotice}</p>
    </dialog>
    <dialog ref={journalDialog} className="deskDialog deskJournal"><form method="dialog"><h2>Signal journal</h2><button aria-label="Close journal">✕</button></form>
      <p>Saved on this browser. Level touches describe observed quotes, not executed trades. Offline gaps cannot be verified.</p>
      <h3>Automatic signals</h3>{signals.length?<div className="deskTableWrap"><table><thead><tr>{['Market','TF','Side','Entry','SL','TP1','Status'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{signals.map(r=><tr key={r.id}><td>{r.market}</td><td>{r.tf}</td><td>{r.side}</td><td>{r.entry}</td><td>{r.stop}</td><td>{r.tp1}</td><td>{r.status}{r.gapUnverified?' · Gap unverified':''}</td></tr>)}</tbody></table></div>:<p>Waiting for the first confirmed signal.</p>}<h3>Manual journal</h3>{focusedSignal && <button type="button" onClick={savePlan}>Save current plan</button>}<p role="status">{journalNotice}</p>
      {journal.length?<div className="deskTableWrap"><table><thead><tr>{["Date","Market","TF","Side","Entry","SL","TP1","Result"].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{journal.map(row=><tr key={row.id}><td>{new Date(row.id).toLocaleString()}</td><td>{row.market}</td><td>{row.tf}</td><td>{row.side}</td><td>{row.entry}</td><td>{row.stop}</td><td>{row.tp1}</td><td><select aria-label={`Result for ${row.market}`} value={row.result} onChange={e=>updateResult(row.id,e.target.value)}>{["Open","Win","Loss","Breakeven","Cancelled"].map(x=><option key={x}>{x}</option>)}</select></td></tr>)}</tbody></table></div>:<p>No saved plans yet.</p>}
    </dialog>
  </div>;
}
