import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";

const TIMEFRAMES = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
];

function buildCandles(ticks, seconds) {
  const map = new Map();

  for (const tick of ticks || []) {
    const time = Number(tick?.epoch);
    const price = Number(tick?.quote);

    if (!Number.isFinite(time) || !Number.isFinite(price)) continue;

    const bucket = Math.floor(time / seconds) * seconds;
    const previous = map.get(bucket);

    if (!previous) {
      map.set(bucket, {
        time: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
      });
      continue;
    }

    previous.high = Math.max(previous.high, price);
    previous.low = Math.min(previous.low, price);
    previous.close = price;
  }

  return [...map.values()].sort((a, b) => a.time - b.time);
}

function calculateEMA(candles, period) {
  if (!candles.length) return [];

  const multiplier = 2 / (period + 1);
  let ema = candles[0].close;

  return candles.map((candle, index) => {
    if (index > 0) {
      ema =
        (candle.close - ema) * multiplier +
        ema;
    }

    return {
      time: candle.time,
      value: ema,
    };
  });
}

function findLevels(candles) {
  if (candles.length < 10) {
    return { support: null, resistance: null };
  }

  const recent = candles.slice(-30);

  let support = Infinity;
  let resistance = -Infinity;

  for (const candle of recent) {
    support = Math.min(support, candle.low);
    resistance = Math.max(resistance, candle.high);
  }

  return {
    support: Number.isFinite(support) ? support : null,
    resistance: Number.isFinite(resistance) ? resistance : null,
  };
}

export default function DerivTradingChart({
  values = [],
  signal = "",
  confidence = 0,
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const ema9Ref = useRef(null);
  const ema21Ref = useRef(null);
  const ema50Ref = useRef(null);
  const supportRef = useRef(null);
  const resistanceRef = useRef(null);
  const markersRef = useRef(null);

  const [timeframe, setTimeframe] = useState(60);
  const [showEMA, setShowEMA] = useState(true);
  const [showLevels, setShowLevels] = useState(true);

  const candles = useMemo(
    () => buildCandles(values, timeframe),
    [values, timeframe]
  );

  const levels = useMemo(
    () => findLevels(candles),
    [candles]
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 430,
      layout: {
        background: { color: "#071018" },
        textColor: "#8fa5b8",
      },
      grid: {
        vertLines: { color: "#13212c" },
        horzLines: { color: "#13212c" },
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: "#5c7080",
          width: 1,
          style: 2,
          labelBackgroundColor: "#1b2a36",
        },
        horzLine: {
          color: "#5c7080",
          width: 1,
          style: 2,
          labelBackgroundColor: "#1b2a36",
        },
      },
      rightPriceScale: {
        borderColor: "#20313d",
        scaleMargins: {
          top: 0.08,
          bottom: 0.12,
        },
      },
      timeScale: {
        borderColor: "#20313d",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 8,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#19c37d",
      downColor: "#ef476f",
      borderUpColor: "#19c37d",
      borderDownColor: "#ef476f",
      wickUpColor: "#19c37d",
      wickDownColor: "#ef476f",
      priceLineVisible: true,
      lastValueVisible: true,
    });

    const ema9 = chart.addSeries(LineSeries, {
      color: "#f5c542",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const ema21 = chart.addSeries(LineSeries, {
      color: "#55a7ff",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const ema50 = chart.addSeries(LineSeries, {
      color: "#c77dff",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const support = chart.addSeries(LineSeries, {
      color: "#19c37d",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const resistance = chart.addSeries(LineSeries, {
      color: "#ef476f",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    ema9Ref.current = ema9;
    ema21Ref.current = ema21;
    ema50Ref.current = ema50;
    supportRef.current = support;
    resistanceRef.current = resistance;
    markersRef.current = createSeriesMarkers(candleSeries, []);

    const resize = () => {
      if (!containerRef.current) return;

      chart.applyOptions({
        width: containerRef.current.clientWidth,
      });
    };

    const observer = new ResizeObserver(resize);
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      ema9Ref.current = null;
      ema21Ref.current = null;
      ema50Ref.current = null;
      supportRef.current = null;
      resistanceRef.current = null;
      markersRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleRef.current) return;

    candleRef.current.setData(candles);

    ema9Ref.current?.setData(
      showEMA ? calculateEMA(candles, 9) : []
    );

    ema21Ref.current?.setData(
      showEMA ? calculateEMA(candles, 21) : []
    );

    ema50Ref.current?.setData(
      showEMA ? calculateEMA(candles, 50) : []
    );

    if (showLevels && levels.support != null && candles.length) {
      const first = candles[0].time;
      const last = candles[candles.length - 1].time;

      supportRef.current?.setData([
        { time: first, value: levels.support },
        { time: last, value: levels.support },
      ]);

      resistanceRef.current?.setData([
        { time: first, value: levels.resistance },
        { time: last, value: levels.resistance },
      ]);
    } else {
      supportRef.current?.setData([]);
      resistanceRef.current?.setData([]);
    }

    if (markersRef.current && candles.length && signal) {
      const latest = candles[candles.length - 1];

      markersRef.current.setMarkers([
        {
          time: latest.time,
          position:
            signal === "RISE"
              ? "belowBar"
              : "aboveBar",
          color:
            signal === "RISE"
              ? "#19c37d"
              : "#ef476f",
          shape:
            signal === "RISE"
              ? "arrowUp"
              : "arrowDown",
          text: `${signal} ${confidence || 0}%`,
        },
      ]);
    }

    if (candles.length) {
      chartRef.current?.timeScale().fitContent();
    }
  }, [
    candles,
    levels,
    signal,
    confidence,
    showEMA,
    showLevels,
  ]);

  return (
    <div className="zentoraChart">
      <div className="zentoraChartToolbar">
        <div className="chartToolGroup">
          <span className="chartLabel">TIMEFRAME</span>

          {TIMEFRAMES.map((item) => (
            <button
              key={item.seconds}
              type="button"
              className={
                timeframe === item.seconds
                  ? "chartTool active"
                  : "chartTool"
              }
              onClick={() => setTimeframe(item.seconds)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="chartToolGroup">
          <button
            type="button"
            className={
              showEMA
                ? "chartTool active"
                : "chartTool"
            }
            onClick={() => setShowEMA((value) => !value)}
          >
            EMA
          </button>

          <button
            type="button"
            className={
              showLevels
                ? "chartTool active"
                : "chartTool"
            }
            onClick={() =>
              setShowLevels((value) => !value)
            }
          >
            S/R
          </button>
        </div>

        <div className="chartSignal">
          <span>AI</span>
          <strong
            className={
              signal === "RISE"
                ? "rise"
                : signal === "FALL"
                ? "fall"
                : ""
            }
          >
            {signal || "WAIT"}
          </strong>
          {signal && (
            <small>{confidence || 0}%</small>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className="zentoraChartCanvas"
      />

      {!candles.length && (
        <div className="zentoraChartEmpty">
          Waiting for live Deriv ticks...
        </div>
      )}

      <div className="zentoraChartLegend">
        <span><i className="ema9" /> EMA 9</span>
        <span><i className="ema21" /> EMA 21</span>
        <span><i className="ema50" /> EMA 50</span>
        <span><i className="support" /> Support</span>
        <span><i className="resistance" /> Resistance</span>
      </div>
    </div>
  );
}
