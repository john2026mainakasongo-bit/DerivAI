import { useMemo } from "react";

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  return values.map((value, index) => {
    if (index === 0) return prev;
    prev = value * k + prev * (1 - k);
    return prev;
  });
}

function rsi(values, period = 14) {
  if (values.length < 2) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = Math.max(1, values.length - period); i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function makeCandles(prices) {
  const sorted = (prices || [])
    .map((item) => ({ quote: Number(item?.quote ?? item?.price ?? item), epoch: Number(item?.epoch ?? 0) }))
    .filter((item) => Number.isFinite(item.quote) && Number.isFinite(item.epoch))
    .slice(-1800);

  const map = new Map();
  sorted.forEach(({ quote, epoch }) => {
    const bucket = Math.floor(epoch / 60) * 60;
    const candle = map.get(bucket);
    if (!candle) map.set(bucket, { time: bucket, open: quote, high: quote, low: quote, close: quote });
    else {
      candle.high = Math.max(candle.high, quote);
      candle.low = Math.min(candle.low, quote);
      candle.close = quote;
    }
  });
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-72);
}

export default function CandlestickChart({ prices = [], currentPrice, signal = "WAIT", confidence = 0 }) {
  const candles = useMemo(() => makeCandles(prices), [prices]);
  const closes = useMemo(() => candles.map((c) => c.close), [candles]);
  const fast = useMemo(() => ema(closes, 9), [closes]);
  const slow = useMemo(() => ema(closes, 21), [closes]);
  const rsiValue = useMemo(() => rsi(closes), [closes]);

  if (candles.length < 2) {
    return <div className="zaChartEmpty">Waiting for live Deriv candles…</div>;
  }

  const width = 980;
  const height = 440;
  const left = 16;
  const right = 76;
  const top = 18;
  const bottom = 48;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const all = candles.flatMap((c) => [c.high, c.low]);
  const rawMin = Math.min(...all);
  const rawMax = Math.max(...all);
  const pad = (rawMax - rawMin || 1) * 0.1;
  const min = rawMin - pad;
  const max = rawMax + pad;
  const range = max - min || 1;
  const x = (i) => left + (i / Math.max(1, candles.length - 1)) * plotW;
  const y = (value) => top + ((max - value) / range) * plotH;
  const candleWidth = Math.max(4, Math.min(10, plotW / candles.length * 0.58));
  const yTicks = Array.from({ length: 6 }, (_, i) => max - (range * i) / 5);
  const signalUp = /CALL|RISE|OVER|EVEN|MATCH/i.test(signal);
  const last = candles.at(-1);
  const entry = last?.close ?? currentPrice;
  const resistance = Math.max(...candles.slice(-20).map((c) => c.high));
  const support = Math.min(...candles.slice(-20).map((c) => c.low));
  const zoneA = signalUp ? support : resistance;
  const zoneB = signalUp ? support + (max - min) * 0.025 : resistance - (max - min) * 0.025;

  const linePath = (values) => values.map((value, i) => `${i ? "L" : "M"} ${x(i).toFixed(2)} ${y(value).toFixed(2)}`).join(" ");

  return (
    <div className="zaChartWrap">
      <div className="zaChartToolbar">
        <div className="zaChartTools"><button className="active">1m</button><button>5m</button><button>15m</button><button>1h</button><span className="divider" /><button>Indicators</button></div>
        <div className="zaChartLegend"><span><i className="emaFast" /> EMA 9</span><span><i className="emaSlow" /> EMA 21</span><span>RSI {rsiValue.toFixed(1)}</span></div>
      </div>
      <svg className="zaChart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Live candlestick chart">
        <defs>
          <linearGradient id="zaZone" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopOpacity="0.16" /><stop offset="1" stopOpacity="0.02" /></linearGradient>
        </defs>
        {yTicks.map((value) => <g key={value}><line x1={left} x2={left + plotW} y1={y(value)} y2={y(value)} className="gridLine" /><text x={left + plotW + 9} y={y(value) + 4} className="axisText">{value.toFixed(2)}</text></g>)}
        <rect x={left} y={Math.min(y(zoneA), y(zoneB))} width={plotW} height={Math.max(2, Math.abs(y(zoneA) - y(zoneB)))} fill="url(#zaZone)" className="analysisZone" />
        <line x1={left} x2={left + plotW} y1={y(resistance)} y2={y(resistance)} className="resistanceLine" />
        <text x={left + 8} y={y(resistance) - 7} className="analysisLabel resistanceLabel">RESISTANCE</text>
        <line x1={left} x2={left + plotW} y1={y(support)} y2={y(support)} className="supportLine" />
        <text x={left + 8} y={y(support) + 15} className="analysisLabel supportLabel">SUPPORT</text>
        {candles.map((candle, i) => {
          const bullish = candle.close >= candle.open;
          const cx = x(i);
          const bodyTop = y(Math.max(candle.open, candle.close));
          const bodyBottom = y(Math.min(candle.open, candle.close));
          const bodyHeight = Math.max(2, bodyBottom - bodyTop);
          return <g key={candle.time} className={bullish ? "candle bullish" : "candle bearish"}><line x1={cx} x2={cx} y1={y(candle.high)} y2={y(candle.low)} /><rect x={cx - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} /></g>;
        })}
        <path d={linePath(fast)} className="emaPath fast" />
        <path d={linePath(slow)} className="emaPath slow" />
        <line x1={x(candles.length - 1)} x2={left + plotW} y1={y(entry)} y2={y(entry)} className="priceLine" />
        <rect x={left + plotW - 2} y={y(entry) - 11} width="74" height="22" rx="4" className="priceTag" />
        <text x={left + plotW + 6} y={y(entry) + 4} className="priceTagText">{Number(entry).toFixed(2)}</text>
        <g className={`signalMarker ${signalUp ? "up" : "down"}`} transform={`translate(${x(candles.length - 1)},${y(entry) + (signalUp ? 28 : -28)})`}>
          <circle r="13" /><text y="5" textAnchor="middle">{signalUp ? "↑" : "↓"}</text>
        </g>
        <text x={Math.max(left + 8, x(candles.length - 1) - 78)} y={y(entry) + (signalUp ? 49 : -49)} className="entryLabel">AI {signal} · {Number(confidence).toFixed(0)}%</text>
        {candles.filter((_, i) => i % 12 === 0).map((c) => <text key={c.time} x={x(candles.findIndex((item) => item.time === c.time))} y={height - 18} className="axisText">{new Date(c.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text>)}
      </svg>
      <div className="zaIndicatorStrip"><div><span>AI TREND</span><b className={signalUp ? "upText" : "downText"}>{signalUp ? "BULLISH" : /WAIT/i.test(signal) ? "NEUTRAL" : "BEARISH"}</b></div><div><span>RSI (14)</span><b>{rsiValue.toFixed(1)}</b></div><div><span>EMA ALIGNMENT</span><b>{fast.at(-1) >= slow.at(-1) ? "UP" : "DOWN"}</b></div><div><span>CONFIDENCE</span><b>{Number(confidence).toFixed(0)}/100</b></div></div>
    </div>
  );
}
