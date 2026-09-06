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

const DRAW_TOOLS = [
  { id: "trendline", label: "↗ Trend" },
  { id: "horizontal", label: "━ H-Line" },
  { id: "ray", label: "→ Ray" },
  { id: "rectangle", label: "▭ Rect" },
  { id: "fibonacci", label: "Fib" },
  { id: "measure", label: "Measure" },
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
      ema = (candle.close - ema) * multiplier + ema;
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

function getPointFromEvent(event, chart, candleSeries, container) {
  const rect = container.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const time = chart.timeScale().coordinateToTime(x);
  const price = candleSeries.coordinateToPrice(y);

  if (time == null || price == null) return null;

  return {
    time: Number(time),
    price: Number(price),
  };
}

function fibLevels(first, second) {
  const diff = second.price - first.price;

  return [
    { ratio: 0, price: first.price },
    { ratio: 0.236, price: first.price + diff * 0.236 },
    { ratio: 0.382, price: first.price + diff * 0.382 },
    { ratio: 0.5, price: first.price + diff * 0.5 },
    { ratio: 0.618, price: first.price + diff * 0.618 },
    { ratio: 0.786, price: first.price + diff * 0.786 },
    { ratio: 1, price: second.price },
  ];
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

  const [activeTool, setActiveTool] = useState(null);
  const [drawings, setDrawings] = useState([]);
  const [pendingPoint, setPendingPoint] = useState(null);
  const [, forceOverlayUpdate] = useState(0);

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

      forceOverlayUpdate((value) => value + 1);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(containerRef.current);

    const updateOverlay = () => {
      forceOverlayUpdate((value) => value + 1);
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(updateOverlay);

    return () => {
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateOverlay);
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
    } else {
      markersRef.current?.setMarkers([]);
    }

    forceOverlayUpdate((value) => value + 1);
  }, [
    candles,
    levels,
    signal,
    confidence,
    showEMA,
    showLevels,
  ]);

  useEffect(() => {
    setPendingPoint(null);
  }, [activeTool, timeframe]);

  const handleDrawingClick = (event) => {
    if (!activeTool || !chartRef.current || !candleRef.current) {
      return;
    }

    const point = getPointFromEvent(
      event,
      chartRef.current,
      candleRef.current,
      containerRef.current
    );

    if (!point) return;

    if (activeTool === "horizontal") {
      setDrawings((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          type: "horizontal",
          a: point,
          b: point,
        },
      ]);

      setActiveTool(null);
      setPendingPoint(null);
      return;
    }

    if (!pendingPoint) {
      setPendingPoint(point);
      return;
    }

    setDrawings((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        type: activeTool,
        a: pendingPoint,
        b: point,
      },
    ]);

    setPendingPoint(null);
    setActiveTool(null);
  };

  const clearDrawings = () => {
    setDrawings([]);
    setPendingPoint(null);
    setActiveTool(null);
  };

  const getXY = (point) => {
    if (!chartRef.current) return null;

    const x = chartRef.current
      .timeScale()
      .timeToCoordinate(point.time);

    const y = candleRef.current?.priceToCoordinate(point.price);

    if (x == null || y == null) return null;

    return { x, y };
  };

  const renderDrawing = (drawing) => {
    const first = getXY(drawing.a);
    const second = getXY(drawing.b);

    if (!first || !second) return null;

    if (drawing.type === "horizontal") {
      return (
        <g key={drawing.id}>
          <line
            x1={0}
            y1={first.y}
            x2="100%"
            y2={first.y}
            stroke="#f5c542"
            strokeWidth="1.5"
            strokeDasharray="6 5"
          />
          <text
            x={8}
            y={first.y - 6}
            fill="#f5c542"
            fontSize="11"
          >
            H-Line {drawing.a.price.toFixed(2)}
          </text>
        </g>
      );
    }

    if (drawing.type === "rectangle") {
      const x = Math.min(first.x, second.x);
      const y = Math.min(first.y, second.y);
      const width = Math.abs(second.x - first.x);
      const height = Math.abs(second.y - first.y);

      return (
        <rect
          key={drawing.id}
          x={x}
          y={y}
          width={width}
          height={height}
          fill="rgba(92, 112, 128, 0.08)"
          stroke="#55a7ff"
          strokeWidth="1.5"
        />
      );
    }

    if (drawing.type === "fibonacci") {
      const levelsForDrawing = fibLevels(drawing.a, drawing.b);

      return (
        <g key={drawing.id}>
          <line
            x1={first.x}
            y1={first.y}
            x2={second.x}
            y2={second.y}
            stroke="#55a7ff"
            strokeWidth="1"
            strokeDasharray="4 4"
          />

          {levelsForDrawing.map((level) => {
            const y = candleRef.current?.priceToCoordinate(
              level.price
            );

            if (y == null) return null;

            return (
              <g key={level.ratio}>
                <line
                  x1={Math.min(first.x, second.x)}
                  y1={y}
                  x2={Math.max(first.x, second.x)}
                  y2={y}
                  stroke="#c77dff"
                  strokeWidth="1"
                />
                <text
                  x={Math.max(first.x, second.x) + 5}
                  y={y - 3}
                  fill="#c77dff"
                  fontSize="10"
                >
                  {(level.ratio * 100).toFixed(1)}%
                </text>
              </g>
            );
          })}
        </g>
      );
    }

    if (drawing.type === "measure") {
      const distance = Math.abs(drawing.b.price - drawing.a.price);
      const percent =
        drawing.a.price !== 0
          ? (distance / drawing.a.price) * 100
          : 0;

      return (
        <g key={drawing.id}>
          <line
            x1={first.x}
            y1={first.y}
            x2={second.x}
            y2={second.y}
            stroke="#f5c542"
            strokeWidth="2"
            strokeDasharray="5 4"
          />
          <circle
            cx={first.x}
            cy={first.y}
            r="4"
            fill="#f5c542"
          />
          <circle
            cx={second.x}
            cy={second.y}
            r="4"
            fill="#f5c542"
          />
          <text
            x={(first.x + second.x) / 2}
            y={(first.y + second.y) / 2 - 10}
            fill="#f5c542"
            fontSize="11"
            textAnchor="middle"
          >
            {distance.toFixed(2)} ({percent.toFixed(2)}%)
          </text>
        </g>
      );
    }

    const isRay = drawing.type === "ray";

    let endX = second.x;
    let endY = second.y;

    if (isRay) {
      const dx = second.x - first.x;
      const dy = second.y - first.y;

      if (Math.abs(dx) > 0.001) {
        const rightEdge = containerRef.current?.clientWidth || 700;
        const scale = (rightEdge - first.x) / dx;

        if (scale > 0) {
          endX = first.x + dx * scale;
          endY = first.y + dy * scale;
        }
      }
    }

    return (
      <g key={drawing.id}>
        <line
          x1={first.x}
          y1={first.y}
          x2={endX}
          y2={endY}
          stroke="#19c37d"
          strokeWidth="1.8"
        />
        <circle
          cx={first.x}
          cy={first.y}
          r="3.5"
          fill="#19c37d"
        />
        <circle
          cx={second.x}
          cy={second.y}
          r="3.5"
          fill="#19c37d"
        />
      </g>
    );
  };

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
          {DRAW_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={
                activeTool === tool.id
                  ? "chartTool active drawingActive"
                  : "chartTool"
              }
              onClick={() =>
                setActiveTool((current) =>
                  current === tool.id ? null : tool.id
                )
              }
            >
              {tool.label}
            </button>
          ))}

          <button
            type="button"
            className="chartTool"
            onClick={clearDrawings}
          >
            Clear
          </button>
        </div>

        <div className="chartToolGroup">
          <button
            type="button"
            className={showEMA ? "chartTool active" : "chartTool"}
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

      {activeTool && (
        <div
          style={{
            padding: "6px 10px",
            fontSize: "10px",
            color: "#8fa5b8",
            background: "#08151f",
            borderBottom: "1px solid #1b2a36",
          }}
        >
          {pendingPoint
            ? "Select the second point on the chart..."
            : `Drawing: ${activeTool}. Click on the chart to place the first point.`}
        </div>
      )}

      <div
        ref={containerRef}
        className="zentoraChartCanvas"
        style={{
          position: "relative",
          cursor: activeTool ? "crosshair" : "default",
        }}
        onClick={handleDrawingClick}
      >
        <svg
          width="100%"
          height="100%"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            pointerEvents: "none",
            overflow: "visible",
          }}
        >
          {drawings.map(renderDrawing)}

          {pendingPoint && (() => {
            const point = getXY(pendingPoint);

            if (!point) return null;

            return (
              <circle
                cx={point.x}
                cy={point.y}
                r="5"
                fill="none"
                stroke="#f5c542"
                strokeWidth="2"
              />
            );
          })()}
        </svg>

        {!candles.length && (
          <div className="zentoraChartEmpty">
            Waiting for live Deriv ticks...
          </div>
        )}
      </div>

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
