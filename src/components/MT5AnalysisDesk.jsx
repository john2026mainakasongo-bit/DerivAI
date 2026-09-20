import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, LineSeries, createChart, createSeriesMarkers } from "lightweight-charts";
import usePublicDerivTicks from "../hooks/usePublicDerivTicks";

const TF = {
  "1m": 60, "2m": 120, "3m": 180, "5m": 300, "10m": 600,
  "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
  "4h": 14400, "8h": 28800, "24h": 86400,
};
const WANTED = [100, 75, 25, 10];

const n = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const keyOf = (m) => String(m?.id || m?.symbol || "");
const labelOf = (m) => String(m?.label || m?.short || m?.id || "Volatility");
const avg = (a) => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));

function matches(m, v) {
  const id = String(m?.id || "").toUpperCase();
  const s = String(m?.symbol || "").toUpperCase();
  const label = labelOf(m);
  return id === `R_${v}` || id === `1HZ${v}V` || s === `R_${v}` || s === `1HZ${v}V` ||
    new RegExp(`Volatility\\s*${v}(?:\\s*\\([^)]*\\))?\\s*Index`, "i").test(label);
}

function matchesBTC(m) {
  const id = String(m?.id || m?.symbol || "").toUpperCase();
  const label = labelOf(m).toUpperCase();
  return id === "BTCUSD" || id === "CRYBTCUSD" || id.includes("BTCUSD") || /BTC\s*\/?\s*USD/.test(label);
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
      candidates.push({
        time: c.time,
        position: "aboveBar",
        color: "#24dfb0",
        shape: "arrowUp",
        text: "BREAKOUT",
        priority: 5,
      });
    }

    if (c.close < lo && c.open >= lo) {
      candidates.push({
        time: c.time,
        position: "belowBar",
        color: "#ff6685",
        shape: "arrowDown",
        text: "BREAKOUT",
        priority: 5,
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

  // Keep the chart readable: one event per candle and only the
  // strongest recent events, rather than painting every candle.
  const byTime = new Map();

  for (const event of candidates) {
    const existing = byTime.get(event.time);
    if (!existing || event.priority > existing.priority) {
      byTime.set(event.time, event);
    }
  }

  const recent = [...byTime.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-10);

  // Avoid repeated identical labels unless enough candles separate them.
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

function analyze(cs) {
  if (cs.length < 35) {
    return {
      signal:"WAIT", bias:"BUILDING", direction:"BUILDING", score:0, confidence:0,
      setup:"WAITING FOR DATA", structure:"BUILDING", liquidity:"WAITING",
      momentum:"WAITING", reason:`Need more candles (${cs.length}/35).`, confirmations:[],
      entry:null, stop:null, target:null, support:null,resistance:null,ema20:null,ema50:null,
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
  const lookback=cs.slice(-21,-1);
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

  const pullbackBuy=bullish&&nearEma20&&last.low<=e20+atr*0.35&&(strongBull||sharpRejectBuy);
  const pullbackSell=bearish&&nearEma20&&last.high>=e20-atr*0.35&&(strongBear||sharpRejectSell);
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
  const bb=bollinger(closes,20,2);
  const stoch=stochastic(cs,14);

  const macdBull=macdValue.line>macdValue.signal && macdValue.histogram>0;
  const macdBear=macdValue.line<macdValue.signal && macdValue.histogram<0;
  const rsiBull=rsiValue>=52 && rsiValue<=78;
  const rsiBear=rsiValue<=48 && rsiValue>=22;
  const trendStrength=adxValue.adx>=20;
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
  const strongSetup=raw!=="WAIT"&&confirmations>=7&&score>=62;
  const signal=strongSetup?raw:"WAIT";

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
  if(signal==="BUY"){
    entry=Number(last.close.toFixed(5));
    entryType=sharpRejectBuy?"REJECTION BUY":retestBuy?"RETEST BUY":pullbackBuy?"PULLBACK BUY":breakUp?"BREAKOUT BUY":"MOMENTUM BUY";
    const structureStop=Math.min(recentSwingLow,last.close-atrSafe*1.15);
    const risk=Math.max(last.close-structureStop,atrSafe*0.75);
    stop=Number((last.close-risk).toFixed(5));
    const firstTarget=Number((Math.max(last.close+risk*2, recentSwingHigh)).toFixed(5));
    target=Number(firstTarget.toFixed(5));
  }
  if(signal==="SELL"){
    entry=Number(last.close.toFixed(5));
    entryType=sharpRejectSell?"REJECTION SELL":retestSell?"RETEST SELL":pullbackSell?"PULLBACK SELL":breakDn?"BREAKOUT SELL":"MOMENTUM SELL";
    const structureStop=Math.max(recentSwingHigh,last.close+atrSafe*1.15);
    const risk=Math.max(structureStop-last.close,atrSafe*0.75);
    stop=Number((last.close+risk).toFixed(5));
    const firstTarget=Number((Math.min(last.close-risk*2,recentSwingLow)).toFixed(5));
    target=Number(firstTarget.toFixed(5));
  }

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

  const projectedPath=[];
  const step=Math.max(atrSafe,Math.abs(last.close-e20)*1.2);
  if(direction==="UP"){
    const p1=Math.min(Math.max(last.close+step*0.55,e20+step*0.4),recentSwingHigh+step*0.25);
    const p2=Math.max(p1,last.close+step*1.2);
    const p3=Number(Math.max(recentSwingHigh,last.close+step*2).toFixed(5));
    projectedPath.push({time:last.time,price:last.close},{time:last.time+TF_SECONDS_FOR_PATH(cs),price:Number(p1.toFixed(5))},{time:last.time+TF_SECONDS_FOR_PATH(cs)*2,price:Number(p2.toFixed(5))},{time:last.time+TF_SECONDS_FOR_PATH(cs)*3,price:p3});
  } else if(direction==="DOWN"){
    const p1=Math.max(Math.min(last.close-step*0.55,e20-step*0.4),recentSwingLow-step*0.25);
    const p2=Math.min(p1,last.close-step*1.2);
    const p3=Number(Math.min(recentSwingLow,last.close-step*2).toFixed(5));
    projectedPath.push({time:last.time,price:last.close},{time:last.time+TF_SECONDS_FOR_PATH(cs),price:Number(p1.toFixed(5))},{time:last.time+TF_SECONDS_FOR_PATH(cs)*2,price:Number(p2.toFixed(5))},{time:last.time+TF_SECONDS_FOR_PATH(cs)*3,price:p3});
  } else {
    const mid=(recentSwingHigh+recentSwingLow)/2;
    projectedPath.push({time:last.time,price:last.close},{time:last.time+TF_SECONDS_FOR_PATH(cs),price:Number(((last.close+mid)/2).toFixed(5))},{time:last.time+TF_SECONDS_FOR_PATH(cs)*2,price:Number(mid.toFixed(5))});
  }

  const confidence=clamp(Math.round(45+confirmations*3+Math.min(Math.abs(bc-sc)*4,15)+(trendStrength?8:0)),45,94);
  let reason="Market is transitioning/ranging. Wait for structure or momentum to resolve.";
  if(direction==="UP") reason=`Market heading UP: ${bc}/16 bullish checks vs ${sc}/16 bearish. Watch pullbacks, retests and resistance.`;
  if(direction==="DOWN") reason=`Market heading DOWN: ${sc}/16 bearish checks vs ${bc}/16 bullish. Watch rallies, retests and support.`;
  if(signal==="BUY") reason=`BUY setup detected from ${entryType}: ${bc}/16 bullish checks aligned. Confirm the level before manual execution.`;
  if(signal==="SELL") reason=`SELL setup detected from ${entryType}: ${sc}/16 bearish checks aligned. Confirm the level before manual execution.`;

  return {
    signal,bias,direction,score,confidence,setup,structure,liquidity,momentum:momentumLabel,reason,
    confirmations:(raw==="BUY"?buy:sell).map(([name,ok])=>({name,ok})),entry,stop,target,entryType,
    support:Number(Math.min(lo,recentSwingLow).toFixed(5)),
    resistance:Number(Math.max(hi,recentSwingHigh).toFixed(5)),
    ema20:Number(e20.toFixed(5)),ema50:Number(e50.toFixed(5)),ema200:Number(e200.toFixed(5)),atr:Number(atr.toFixed(5)),
    rsi:Number(rsiValue.toFixed(1)),macd:Number(macdValue.line.toFixed(5)),macdSignal:Number(macdValue.signal.toFixed(5)),macdHistogram:Number(macdValue.histogram.toFixed(5)),
    adx:Number(adxValue.adx.toFixed(1)),plusDI:Number(adxValue.plus.toFixed(1)),minusDI:Number(adxValue.minus.toFixed(1)),
    bollinger:{upper:Number(bb.upper.toFixed(5)),mid:Number(bb.mid.toFixed(5)),lower:Number(bb.lower.toFixed(5))},
    stoch:Number(stoch.toFixed(1)),
    pattern,fib,orderBlock,projectedPath,rr:signal==="WAIT"?null:2
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

function Chart({candles,analysis,chartKey}) {
  const el=useRef(null);
  const chartRef=useRef(null);
  const seriesRef=useRef(null);
  const priceLinesRef=useRef([]);
  const markerPrimitiveRef=useRef(null);
  const projectionSeriesRef=useRef(null);
  const firstDataKeyRef=useRef("");
  const lastDataKeyRef=useRef("");

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
      borderVisible:false
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

    return ()=>{
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

    const data=candles.map(c=>({
      time:c.time,
      open:c.open,
      high:c.high,
      low:c.low,
      close:c.close
    }));

    const firstKey=chartKey || String(candles[0]?.time || "");
    const datasetChanged=
      firstDataKeyRef.current &&
      firstDataKeyRef.current !== firstKey;

    if(!firstDataKeyRef.current || datasetChanged) {
      series.setData(data);
      firstDataKeyRef.current=firstKey;
      lastDataKeyRef.current="";
      chart.timeScale().fitContent();
      chart.timeScale().scrollToRealTime();
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

    for(const line of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch {}
    }
    priceLinesRef.current=[];

    const levels=[
      ["Support",analysis.support,"#27b9e7",1],
      ["Resistance",analysis.resistance,"#f39b62",1],
      ["EMA20",analysis.ema20,"#55a8ff",2],
      ["EMA50",analysis.ema50,"#f3a64b",2],
      ["Entry",analysis.entry,"#20dfb1",2],
      ["SL",analysis.stop,"#ff6685",2],
      ["TP",analysis.target,"#2bd6a3",2],
      ["Fib 38.2",analysis.fib?.level382,"#7b9cff",1],
      ["Fib 50",analysis.fib?.level50,"#8d7bff",1],
      ["Fib 61.8",analysis.fib?.level618,"#a76cff",1],
      ["BB Upper",analysis.bollinger?.upper,"#59758a",1],
      ["BB Mid",analysis.bollinger?.mid,"#4c6577",1],
      ["BB Lower",analysis.bollinger?.lower,"#59758a",1],
      [analysis.orderBlock?.type||"OB",analysis.orderBlock?.low,"#ffb454",1],
      [analysis.orderBlock?.type?`${analysis.orderBlock.type} TOP`:"OB TOP",analysis.orderBlock?.high,"#ffb454",1]
    ];

    for(const [title,price,color,width] of levels){
      if(!Number.isFinite(price)) continue;
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

    markerPrimitiveRef.current?.detach?.();

    const markers=[
      ...chartEvents(candles),
      ...structureEvents(candles),
      ...fvgEvents(candles)
    ].sort(
      (a,b)=>(a.time-b.time)||(b.priority-a.priority)
    );

    const byTime=new Map();
    for(const marker of markers){
      const existing=byTime.get(marker.time);
      if(!existing || marker.priority>existing.priority) {
        byTime.set(marker.time,marker);
      }
    }

    markerPrimitiveRef.current=createSeriesMarkers(
      series,
      [...byTime.values()].slice(-18)
    );

    if(projectionSeriesRef.current){
      try { chart.removeSeries(projectionSeriesRef.current); } catch {}
      projectionSeriesRef.current=null;
    }

    if(analysis?.projectedPath?.length>=2){
      const projectionColor=analysis.direction==="UP"?"#27dfb1":analysis.direction==="DOWN"?"#ff6685":"#a8b8c2";
      const projectionSeries=chart.addSeries(LineSeries,{
        color:projectionColor,
        lineWidth:3,
        lineStyle:2,
        crosshairMarkerVisible:false,
        lastValueVisible:false,
        priceLineVisible:false
      });
      projectionSeries.setData(analysis.projectedPath.map(point=>({time:point.time,value:point.price})));
      projectionSeriesRef.current=projectionSeries;
    }

    const latest=candles.at(-1)?.close;
    if(Number.isFinite(latest)){
      const currentLine=series.createPriceLine({
        price:latest,
        color:"#d7f5ff",
        lineWidth:1,
        lineStyle:3,
        axisLabelVisible:true,
        title:"PRICE"
      });
      priceLinesRef.current.push(currentLine);
    }
  },[candles,analysis,chartKey]);

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

    chart.timeScale().setVisibleLogicalRange({
      from:center-width/2,
      to:center+width/2
    });
  };

  const resetZoom=()=>{
    const chart=chartRef.current;
    if(!chart) return;

    chart.timeScale().fitContent();
    chart.timeScale().scrollToPosition(8,false);
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
        <b>PATH: {analysis.direction || "RANGE"} · {analysis.setup}</b>
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
    candleHistory={},
    status,
    connected,
    symbol,
    changeSymbol,
    loadingMarket,
    connect,
  }=usePublicDerivTicks({multiMarket:true});

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
    const volatility=WANTED.map(v=>markets.find(m=>matches(m,v))).filter(Boolean);
    const btc=markets.find(matchesBTC);
    return btc ? [...volatility, btc] : volatility;
  },[markets]);
  const [selected,setSelected]=useState("");
  const [tf,setTf]=useState("5m");

  useEffect(()=>{
    if(!selected&&supported[0]) setSelected(keyOf(supported[0]));
  },[selected,supported]);

  useEffect(()=>{
    if(!selected||!connected||selected===symbol) return;
    void changeSymbol(selected).catch(()=>{});
  },[selected,connected,symbol,changeSymbol]);

  const selectedMarket=supported.find(m=>keyOf(m)===selected)||supported[0];
  const selectedKey=keyOf(selectedMarket);
  const tickRows=selectedMarket?(marketTicks[selectedKey]||[]):[];

  const candlesByTf=useMemo(()=>{
    const out={};
    for(const [label,seconds] of Object.entries(TF)){
      const historical=normalizeCandles(candleHistory[seconds]);
      // Always merge the latest subscribed ticks into the historical base.
      // This keeps the currently forming candle live instead of waiting for
      // the next historical-candle refresh.
      out[label]=mergeLiveCandles(
        historical,
        tickRows,
        seconds
      );
    }
    return out;
  },[candleHistory,tickRows]);

  const cs=candlesByTf[tf]||[];
  const analyses=useMemo(()=>{
    const out={};
    for(const m of supported){
      const k=keyOf(m);
      out[k]=analyze(
        k===selectedKey
          ? (candlesByTf[tf]||[])
          : candlesFromTicks(marketTicks[k]||[],TF[tf])
      );
    }
    return out;
  },[supported,selectedKey,candlesByTf,marketTicks,tf]);

  const a=selectedMarket
    ? analyses[selectedKey]||analyze(cs)
    : analyze(cs);
  const cls=a.signal==="BUY"?"buy":a.signal==="SELL"?"sell":"wait";

  const mtf=Object.entries(TF).map(([label,seconds])=>{
    const data=selectedMarket && label
      ? mergeLiveCandles(
          normalizeCandles(candleHistory[seconds]),
          tickRows,
          seconds
        )
      : [];
    return {label,data,analysis:analyze(data)};
  });

  const mtfDirectional=mtf.filter(x=>x.analysis?.direction && x.analysis.direction!=="BUILDING");
  const upFrames=mtfDirectional.filter(x=>x.analysis.direction==="UP").length;
  const downFrames=mtfDirectional.filter(x=>x.analysis.direction==="DOWN").length;
  const rangeFrames=mtfDirectional.filter(x=>x.analysis.direction==="RANGE").length;
  const mtfHeading=upFrames>downFrames&&upFrames>=2?"UP":downFrames>upFrames&&downFrames>=2?"DOWN":"MIXED / RANGE";
  const mtfAgreement=mtfDirectional.length
    ? Math.round((Math.max(upFrames,downFrames)/mtfDirectional.length)*100)
    : 0;
  const mtfSummary=mtfHeading==="UP"
    ? `${upFrames}/${mtfDirectional.length} timeframes bullish`
    : mtfHeading==="DOWN"
      ? `${downFrames}/${mtfDirectional.length} timeframes bearish`
      : `${rangeFrames}/${mtfDirectional.length} timeframes ranging`;

  return <div className="mt5Desk">
    <div className="mt5Topbar">
      <div>
        <i className="mt5LiveDot"/>
        {connected?"LIVE DERIV FEED":"CONNECTING"}
        <small>{loadingMarket?"LOADING CANDLES":status||"DISCONNECTED"}</small>
      </div>
      <div className="mt5Timeframes">
        {Object.keys(TF).map(x=>
          <button key={x} type="button" className={tf===x?"active":""} onClick={()=>setTf(x)}>
            {x}
          </button>
        )}
      </div>
    </div>

    <div className="mt5Grid">
      <aside className="mt5Side">
        <div className="mt5Watchlist">
          <div className="mt5PanelTitle">MARKET SCANNER</div>
          {WANTED.map(v=>{
            const m=supported.find(x=>matches(x,v));
            const k=m&&keyOf(m);
            const x=k&&analyses[k];
            return <button key={v} type="button"
              className={`mt5WatchRow ${k===selectedKey?"active":""}`}
              onClick={()=>m&&setSelected(k)}>
              <b>V{v}</b>
              <span>{x?.bias||"WAITING"}</span>
              <strong className={x?.signal?.toLowerCase()}>{x?.signal||"WAIT"}</strong>
            </button>;
          })}
          {(()=>{
            const m=supported.find(matchesBTC);
            if(!m) return null;
            const k=keyOf(m);
            const x=analyses[k];
            return <button type="button"
              className={`mt5WatchRow mt5CryptoRow ${k===selectedKey?"active":""}`}
              onClick={()=>setSelected(k)}>
              <b>BTCUSD</b>
              <span>{x?.bias||"WAITING"}</span>
              <strong className={x?.signal?.toLowerCase()}>{x?.signal||"WAIT"}</strong>
            </button>;
          })()}
        </div>

        <div className="mt5Panel mt5MtfPanel">
          <div className="mt5PanelTitle">ALL TIMEFRAME ANALYSIS</div>
          {mtf.map(({label,analysis:z})=>
            <button key={label} type="button"
              className={`mt5MiniRow ${tf===label?"active":""}`}
              onClick={()=>setTf(label)}>
              <b>{label}</b>
              <span>{z.direction} · {z.setup}</span>
              <strong className={z.direction==="UP"?"buy":z.direction==="DOWN"?"sell":"wait"}>{z.direction}</strong>
            </button>
          )}
        </div>

        <div className="mt5Panel mt5Checklist">
          <div className="mt5PanelTitle">STRUCTURE CHECK</div>
          {(a.confirmations||[]).map(x=>
            <div key={x.name}><i className={x.ok?"on":""}>{x.ok?"✓":"·"}</i><span>{x.name}</span><b>{x.ok?"OK":"WAIT"}</b></div>
          )}
        </div>
      </aside>

      <main className="mt5Center">
        <div className="mt5ChartHead">
          <div><span>LIVE PRICE ACTION · {tf} · ENTRY / SL / TP</span><h2>{labelOf(selectedMarket)}</h2></div>
          <div className="mt5ChartMeta">
            <b>{cs.at(-1)?.close??"—"}</b>
            <small><i className="mt5LiveDot"/> FORMING · {cs.length} candles</small>
          </div>
        </div>
        <Chart candles={cs} analysis={a} chartKey={`${selectedKey}:${tf}`}/>
        <div className="mt5SetupStrip mt5DirectionStrip">
          <span>MARKET HEADING</span><b className={a.direction==="UP"?"buy":a.direction==="DOWN"?"sell":"wait"}>{a.direction}</b>
          <span>MTF</span><b>{mtfHeading} · {mtfAgreement}%</b>
          <span>SETUP</span><b>{a.setup}</b>
          <span>RSI / MACD</span><b>{a.rsi} · {a.macdHistogram>=0?"BULL":"BEAR"}</b>
          <span>ADX</span><b>{a.adx}</b>
        </div>
      </main>

      <aside className="mt5Right">
        <section className={`mt5Panel mt5HeadingCard ${a.direction==="UP"?"buy":a.direction==="DOWN"?"sell":"wait"}`}>
          <div className="mt5PanelTitle">MARKET DIRECTION</div>
          <div className="mt5HeadingWord">{a.direction}</div>
          <div className="mt5HeadingLine"><span>TIMEFRAME</span><b>{tf}</b></div>
          <div className="mt5HeadingLine"><span>MTF ALIGNMENT</span><b>{mtfSummary}</b></div>
          <div className="mt5HeadingLine"><span>PATH</span><b>{a.direction==="UP"?"→ RESISTANCE":a.direction==="DOWN"?"→ SUPPORT":"↔ RANGE"}</b></div>
          <p className="mt5HeadingReason">{a.reason}</p>
        </section>

        <section className={`mt5SignalCard ${cls}`}>
          <div className="mt5SignalTop"><span>MARKET DECISION</span><b>{a.confidence?a.confidence+"%":"—"}</b></div>
          <div className="mt5SignalWord">{a.signal}</div>
          <p>{a.reason}</p><div className="mt5SignalSetup"><span>SETUP</span><b>{a.setup}</b></div>
          <div className="mt5Levels">
            <div><span>Entry</span><b>{a.entry??"—"}</b></div>
            <div><span>Stop loss</span><b>{a.stop??"—"}</b></div>
            <div><span>Take profit</span><b>{a.target??"—"}</b></div>
            <div><span>Risk / reward</span><b>{a.rr?"1:"+a.rr:"—"}</b></div>
          </div>
          <div className="mt5ConfirmationList">
            {(a.confirmations||[]).map(x=>
              <div key={x.name}><i className={x.ok?"on":""}>{x.ok?"✓":"·"}</i><span>{x.name}</span><b>{x.ok?"CONFIRMED":"WAIT"}</b></div>
            )}
          </div>
          <button type="button" className="mt5CopyPlan"
            onClick={()=>navigator.clipboard?.writeText(`${a.signal} ${labelOf(selectedMarket)} ${tf} Entry ${a.entry} SL ${a.stop} TP ${a.target}`)}>
            COPY MT5 TRADE PLAN
          </button>
        </section>

        <section className="mt5Panel mt5IndicatorPanel">
          <div className="mt5PanelTitle">CONFIRMATION ENGINE</div>
          <div className="mt5LevelRow"><span>RSI 14</span><b>{a.rsi??"—"}</b></div>
          <div className="mt5LevelRow"><span>MACD</span><b>{a.macdHistogram>=0?"BULLISH":"BEARISH"}</b></div>
          <div className="mt5LevelRow"><span>ADX</span><b>{a.adx??"—"} {a.adx>=20?"TREND":"WEAK"}</b></div>
          <div className="mt5LevelRow"><span>STOCH 14</span><b>{a.stoch??"—"}</b></div>
          <div className="mt5LevelRow"><span>BOLLINGER</span><b>{a.bollinger?`${a.bollinger.lower.toFixed(2)} - ${a.bollinger.upper.toFixed(2)}`:"—"}</b></div>
          <div className="mt5LevelRow"><span>CANDLE</span><b>{a.pattern||"NONE"}</b></div>
          <div className="mt5LevelRow"><span>FIB 38.2 / 50 / 61.8</span><b>{a.fib?`${a.fib.level382.toFixed(2)} / ${a.fib.level50.toFixed(2)} / ${a.fib.level618.toFixed(2)}`:"—"}</b></div>
          <div className="mt5LevelRow"><span>ORDER BLOCK</span><b>{a.orderBlock?`${a.orderBlock.type} · ${a.orderBlock.low.toFixed(2)}-${a.orderBlock.high.toFixed(2)}`:"NONE"}</b></div>
        </section>

        <section className="mt5Panel">
          <div className="mt5PanelTitle">KEY LEVELS</div>
          {["support","resistance","ema20","ema50","ema200","atr"].map(k=>
            <div className="mt5LevelRow" key={k}>
              <span>{k==="ema20"?"EMA 20":k==="ema50"?"EMA 50":k.toUpperCase()}</span>
              <b>{a[k]??"—"}</b>
            </div>
          )}
        </section>

        <section className="mt5Panel mt5TradeMap">
          <div className="mt5PanelTitle">SETUP MAP</div>
          <div><span>BREAKOUT</span><b>{a.setup==="BREAKOUT"?"CONFIRMED":"WAIT"}</b></div>
          <div><span>RETEST</span><b>{a.setup==="RETEST"?"CONFIRMED":"WAIT"}</b></div>
          <div><span>LIQUIDITY</span><b>{a.liquidity}</b></div>
          <div><span>REJECTION</span><b>{a.setup==="REJECTION"?"CONFIRMED":"WAIT"}</b></div>
          <div><span>CONTINUATION</span><b>{a.setup==="CONTINUATION"?"CONFIRMED":"WAIT"}</b></div>
          <div><span>FAKE / FAILED RETEST</span><b>{a.setup==="FAKE RETEST"?"DETECTED":"CLEAR"}</b></div>
        </section>

        <section className="mt5Panel mt5Safety">
          <div className="mt5PanelTitle">MANUAL EXECUTION</div>
          <p>This desk does not place trades. Use the analysis plan as a manual reference, then execute yourself in MT5.</p>
        </section>
      </aside>
    </div>
  </div>;
}




