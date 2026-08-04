
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeRiseFall } from "../analysis/riseFallAnalysisEngine";
import "../styles/RiseFallAnalysis.css";

function clamp(value, minimum = 0, maximum = 100) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return minimum;
  }

  return Math.max(minimum, Math.min(maximum, numeric));
}
function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function num(value, digits = 5) {
  return Number.isFinite(Number(value))
    ? Number(value).toFixed(digits)
    : "—";
}

function signalClass(value) {
  return String(value || "WAIT").toLowerCase();
}

const LEARNING_STORAGE_KEY = "edgepilot-rise-fall-learning-v70";
const MAX_LEARNING_RECORDS = 300;

function safeReadLearningHistory() {
  if (typeof window === "undefined") return [];

  try {
    const value = JSON.parse(
      window.localStorage.getItem(LEARNING_STORAGE_KEY) || "[]"
    );

    return Array.isArray(value)
      ? value.slice(0, MAX_LEARNING_RECORDS)
      : [];
  } catch {
    return [];
  }
}

function scoreBucket(value) {
  const score = Number(value || 0);

  if (score >= 90) return "90+";
  if (score >= 82) return "82-89";
  if (score >= 74) return "74-81";
  return "<74";
}

function noiseBucket(value) {
  const noise = Number(value || 0);

  if (noise >= 75) return "HIGH";
  if (noise >= 55) return "MEDIUM";
  return "LOW";
}

function rate(records = []) {
  if (!records.length) return 0;

  const wins = records.filter((item) => item.result === "WON").length;
  return wins / records.length * 100;
}

function currentLossStreak(records = []) {
  let streak = 0;

  for (const item of records) {
    if (item.result === "LOST") {
      streak += 1;
      continue;
    }

    if (item.result === "WON") break;
  }

  return streak;
}


const RF_HISTORY_STORAGE_KEY = "edgepilot-rf-price-history-v73";
const RF_MARKET_SNAPSHOT_KEY = "edgepilot-rf-market-snapshots-v73";
const RF_MAX_HISTORY_POINTS = 2400;
const RF_MAX_MARKET_SNAPSHOTS = 40;

function normalizedTick(item, fallbackTime = Date.now()) {
  const quote = Number(
    typeof item === "number"
      ? item
      : item?.quote ??
          item?.price ??
          item?.value ??
          item?.tick ??
          item?.currentPrice ??
          0
  );

  const rawTime =
    typeof item === "object" && item
      ? item.epoch ??
        item.time ??
        item.timestamp ??
        item.createdAt ??
        fallbackTime
      : fallbackTime;

  const parsedTime = Number(rawTime);
  const time =
    parsedTime > 0 && parsedTime < 1e12
      ? parsedTime * 1000
      : parsedTime > 0
        ? parsedTime
        : fallbackTime;

  if (!Number.isFinite(quote) || quote <= 0) return null;

  return {
    quote,
    time,
  };
}

function readStoredMap(key) {
  if (typeof window === "undefined") return {};

  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeStoredMap(key, value) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Continue with in-memory data when browser storage is unavailable.
  }
}

function mergeTickHistory(existing = [], incoming = []) {
  const merged = new Map();

  [...existing, ...incoming].forEach((item, index) => {
    const point = normalizedTick(item, Date.now() + index);
    if (!point) return;

    const key = `${Math.round(point.time)}:${point.quote}`;
    merged.set(key, point);
  });

  return [...merged.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-RF_MAX_HISTORY_POINTS);
}

function candleBucketSize(mode) {
  if (mode === "10S") return 10000;
  if (mode === "15S") return 15000;
  if (mode === "30S") return 30000;
  if (mode === "1M") return 60000;
  if (mode === "5M") return 300000;
  return 0;
}

function buildCandles(points = [], mode = "10T") {
  const ticks = points
    .map((item, index) => normalizedTick(item, Date.now() + index))
    .filter(Boolean);

  if (!ticks.length) return [];

  if (mode.endsWith("T")) {
    const tickCount = Math.max(1, Number(mode.replace("T", "")) || 10);
    const candles = [];

    for (let index = 0; index < ticks.length; index += tickCount) {
      const group = ticks.slice(index, index + tickCount);
      if (!group.length) continue;

      const values = group.map((item) => item.quote);
      candles.push({
        time: group[0].time,
        open: values[0],
        high: Math.max(...values),
        low: Math.min(...values),
        close: values.at(-1),
        ticks: group.length,
      });
    }

    return candles.slice(-80);
  }

  const bucketSize = candleBucketSize(mode);
  const buckets = new Map();

  ticks.forEach((point) => {
    const bucket = Math.floor(point.time / bucketSize) * bucketSize;
    const current = buckets.get(bucket);

    if (!current) {
      buckets.set(bucket, {
        time: bucket,
        open: point.quote,
        high: point.quote,
        low: point.quote,
        close: point.quote,
        ticks: 1,
      });
      return;
    }

    current.high = Math.max(current.high, point.quote);
    current.low = Math.min(current.low, point.quote);
    current.close = point.quote;
    current.ticks += 1;
  });

  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-80);
}

function candleSignal(candle) {
  if (!candle) return "WAIT";
  if (candle.close > candle.open) return "RISE";
  if (candle.close < candle.open) return "FALL";
  return "WAIT";
}


function freezeClosedCandles(previous = [], next = []) {
  if (!next.length) return [];

  const previousMap = new Map(
    previous.slice(0, -1).map((item) => [item.time, item])
  );

  return next.map((item, index) => {
    const isLive = index === next.length - 1;
    if (isLive) return item;
    return previousMap.get(item.time) || item;
  });
}


function candleStructure(candles = []) {
  if (!candles.length) {
    return {
      support: 0,
      resistance: 0,
      breakout: "NONE",
      breakoutStrength: 0,
      rangeWidth: 0,
      trend: "WAIT",
      closedCount: 0,
    };
  }

  const current = candles.at(-1);
  const closed = candles.slice(0, -1);
  const sample = closed.slice(-20);
  const usable = sample.length ? sample : candles.slice(-20);

  const support = Math.min(...usable.map((item) => item.low));
  const resistance = Math.max(...usable.map((item) => item.high));
  const rangeWidth = Math.max(0.000001, resistance - support);
  const close = Number(current?.close || 0);

  let breakout = "NONE";
  let breakoutStrength = 0;

  if (close > resistance) {
    breakout = "BULLISH";
    breakoutStrength = (close - resistance) / rangeWidth * 100;
  } else if (close < support) {
    breakout = "BEARISH";
    breakoutStrength = (support - close) / rangeWidth * 100;
  }

  const recentCloses = usable.slice(-8).map((item) => item.close);
  const trend =
    recentCloses.length >= 2
      ? recentCloses.at(-1) > recentCloses[0]
        ? "RISE"
        : recentCloses.at(-1) < recentCloses[0]
          ? "FALL"
          : "WAIT"
      : "WAIT";

  return {
    support,
    resistance,
    breakout,
    breakoutStrength: clamp(breakoutStrength),
    rangeWidth,
    trend,
    closedCount: closed.length,
  };
}

function structureEntryChecklist({
  structure,
  active,
  currentCandle,
}) {
  const direction = active?.signal || "WAIT";
  const candleDirection = candleSignal(currentCandle);

  const breakoutAligned =
    structure.breakout === "NONE" ||
    (structure.breakout === "BULLISH" && direction === "RISE") ||
    (structure.breakout === "BEARISH" && direction === "FALL");

  const trendAligned =
    structure.trend === "WAIT" ||
    structure.trend === direction;

  const candleAligned =
    candleDirection === "WAIT" ||
    candleDirection === direction;

  const confidencePassed =
    Number(active?.confidence || 0) >= 70;

  const qualityPassed =
    Number(active?.opportunityScore || active?.scores?.final || 0) >= 75;

  const pressurePassed =
    Number(active?.dominantPressure || 0) >= 58 ||
    Number(active?.pressure?.buying || 0) >= 58 ||
    Number(active?.pressure?.selling || 0) >= 58;

  const items = [
    { label: "Closed-candle trend", passed: trendAligned, value: structure.trend },
    { label: "Live candle direction", passed: candleAligned, value: candleDirection },
    { label: "Breakout alignment", passed: breakoutAligned, value: structure.breakout },
    { label: "Confidence", passed: confidencePassed, value: `${Number(active?.confidence || 0).toFixed(1)}%` },
    { label: "Entry quality", passed: qualityPassed, value: `${Number(active?.opportunityScore || active?.scores?.final || 0).toFixed(1)}%` },
    { label: "Directional pressure", passed: pressurePassed, value: `${Number(active?.dominantPressure || 0).toFixed(1)}%` },
  ];

  return {
    items,
    passed: items.filter((item) => item.passed).length,
    total: items.length,
    ready:
      direction !== "WAIT" &&
      items.filter((item) => item.passed).length >= 5,
  };
}


function emaSeries(candles = [], period = 20) {
  const multiplier = 2 / (period + 1);
  let previous = null;

  return candles.map((candle) => {
    const close = Number(candle?.close || 0);
    previous =
      previous === null
        ? close
        : close * multiplier + previous * (1 - multiplier);
    return previous;
  });
}

function chartTimeLabel(value) {
  const date = new Date(Number(value || Date.now()));
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function CandleChart({
  candles = [],
  signal = "WAIT",
  probabilityRise = 0,
  probabilityFall = 0,
  structure = null,
}) {
  const [visibleCount, setVisibleCount] = useState(56);
  const [hoverIndex, setHoverIndex] = useState(-1);

  if (!candles.length) {
    return (
      <div className="rfEmptyChart">
        Building professional candlestick history…
      </div>
    );
  }

  const displayed = candles.slice(-Math.max(18, visibleCount));
  const width = 1280;
  const height = 520;
  const left = 22;
  const right = 104;
  const top = 24;
  const bottom = 48;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;

  const ema20 = emaSeries(displayed, 20);
  const ema50 = emaSeries(displayed, 50);

  const rawValues = displayed.flatMap((item, index) => [
    Number(item.high || 0),
    Number(item.low || 0),
    Number(ema20[index] || 0),
    Number(ema50[index] || 0),
  ]);

  const rawMin = Math.min(...rawValues);
  const rawMax = Math.max(...rawValues);
  const rawRange = Math.max(0.000001, rawMax - rawMin);
  const minimum = rawMin - rawRange * 0.08;
  const maximum = rawMax + rawRange * 0.08;
  const range = Math.max(0.000001, maximum - minimum);

  const xStep = chartWidth / Math.max(1, displayed.length);
  const bodyWidth = Math.max(4, Math.min(15, xStep * 0.58));

  const x = (index) => left + index * xStep + xStep / 2;
  const y = (value) =>
    top + ((maximum - Number(value || 0)) / range) * chartHeight;

  const priceTicks = Array.from({ length: 7 }, (_, index) => {
    const ratio = index / 6;
    return maximum - range * ratio;
  });

  const timeIndexes = Array.from(
    new Set([
      0,
      Math.floor((displayed.length - 1) * 0.25),
      Math.floor((displayed.length - 1) * 0.5),
      Math.floor((displayed.length - 1) * 0.75),
      displayed.length - 1,
    ])
  ).filter((index) => index >= 0);

  const emaPoints = (series) =>
    series
      .map((value, index) => `${x(index)},${y(value)}`)
      .join(" ");

  const current = displayed.at(-1);
  const currentPrice = Number(current?.close || 0);
  const currentY = y(currentPrice);
  const hovered =
    hoverIndex >= 0 && hoverIndex < displayed.length
      ? displayed[hoverIndex]
      : current;
  const hoveredIndex =
    hoverIndex >= 0 && hoverIndex < displayed.length
      ? hoverIndex
      : displayed.length - 1;

  const supportY =
    Number(structure?.support || 0) > 0 ? y(structure.support) : null;
  const resistanceY =
    Number(structure?.resistance || 0) > 0
      ? y(structure.resistance)
      : null;

  return (
    <div className={`rfTvChart ${signalClass(signal)}`}>
      <div className="rfTvToolbar">
        <div>
          <strong>{chartTimeLabel(hovered?.time)}</strong>
          <span>O {num(hovered?.open, 5)}</span>
          <span>H {num(hovered?.high, 5)}</span>
          <span>L {num(hovered?.low, 5)}</span>
          <span>C {num(hovered?.close, 5)}</span>
        </div>

        <div>
          <button
            type="button"
            onClick={() =>
              setVisibleCount((value) => Math.max(18, value - 10))
            }
          >
            ＋
          </button>
          <button
            type="button"
            onClick={() =>
              setVisibleCount((value) =>
                Math.min(Math.max(candles.length, 18), value + 10)
              )
            }
          >
            －
          </button>
          <button
            type="button"
            onClick={() => {
              setVisibleCount(56);
              setHoverIndex(-1);
            }}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="rfTvCanvas">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          onMouseLeave={() => setHoverIndex(-1)}
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const localX =
              ((event.clientX - bounds.left) / bounds.width) * width;
            const index = Math.round(
              (localX - left - xStep / 2) / xStep
            );
            setHoverIndex(
              Math.max(0, Math.min(displayed.length - 1, index))
            );
          }}
        >
          <rect
            x={left}
            y={top}
            width={chartWidth}
            height={chartHeight}
            className="rfTvBackground"
          />

          <g className="rfTvGrid">
            {priceTicks.map((price) => (
              <line
                key={price}
                x1={left}
                x2={left + chartWidth}
                y1={y(price)}
                y2={y(price)}
              />
            ))}

            {timeIndexes.map((index) => (
              <line
                key={index}
                x1={x(index)}
                x2={x(index)}
                y1={top}
                y2={top + chartHeight}
              />
            ))}
          </g>

          {supportY !== null ? (
            <g className="rfTvLevel support">
              <line
                x1={left}
                x2={left + chartWidth}
                y1={supportY}
                y2={supportY}
              />
              <text x={left + 9} y={supportY - 7}>
                SUPPORT
              </text>
            </g>
          ) : null}

          {resistanceY !== null ? (
            <g className="rfTvLevel resistance">
              <line
                x1={left}
                x2={left + chartWidth}
                y1={resistanceY}
                y2={resistanceY}
              />
              <text x={left + 9} y={resistanceY - 7}>
                RESISTANCE
              </text>
            </g>
          ) : null}

          <polyline
            points={emaPoints(ema50)}
            className="rfTvEma ema50"
          />
          <polyline
            points={emaPoints(ema20)}
            className="rfTvEma ema20"
          />

          {displayed.map((candle, index) => {
            const rising =
              Number(candle.close) >= Number(candle.open);
            const candleX = x(index);
            const bodyTop = y(
              Math.max(Number(candle.open), Number(candle.close))
            );
            const bodyBottom = y(
              Math.min(Number(candle.open), Number(candle.close))
            );
            const bodyHeight = Math.max(2, bodyBottom - bodyTop);
            const live = index === displayed.length - 1;

            return (
              <g
                key={`${candle.time}-${index}`}
                className={`rfTvCandle ${
                  rising ? "rise" : "fall"
                } ${live ? "live" : ""}`}
              >
                <line
                  x1={candleX}
                  x2={candleX}
                  y1={y(candle.high)}
                  y2={y(candle.low)}
                  className="wick"
                />
                <rect
                  x={candleX - bodyWidth / 2}
                  y={bodyTop}
                  width={bodyWidth}
                  height={bodyHeight}
                  className="body"
                />
              </g>
            );
          })}

          <g className="rfTvCurrentPrice">
            <line
              x1={left}
              x2={left + chartWidth}
              y1={currentY}
              y2={currentY}
            />
            <rect
              x={left + chartWidth + 4}
              y={currentY - 14}
              width={96}
              height={28}
              rx="4"
            />
            <text
              x={left + chartWidth + 12}
              y={currentY + 5}
            >
              {num(currentPrice, 5)}
            </text>
          </g>

          {hoverIndex >= 0 ? (
            <g className="rfTvCrosshair">
              <line
                x1={x(hoveredIndex)}
                x2={x(hoveredIndex)}
                y1={top}
                y2={top + chartHeight}
              />
              <line
                x1={left}
                x2={left + chartWidth}
                y1={y(hovered?.close)}
                y2={y(hovered?.close)}
              />
            </g>
          ) : null}

          <g className="rfTvPriceScale">
            {priceTicks.map((price) => (
              <text
                key={price}
                x={left + chartWidth + 10}
                y={y(price) + 4}
              >
                {num(price, 5)}
              </text>
            ))}
          </g>

          <g className="rfTvTimeScale">
            {timeIndexes.map((index) => (
              <text
                key={index}
                x={x(index)}
                y={height - 15}
                textAnchor="middle"
              >
                {chartTimeLabel(displayed[index]?.time)}
              </text>
            ))}
          </g>
        </svg>
      </div>

      <div className="rfTvFooter">
        <div>
          <span className="rise">Bull candle</span>
          <span className="fall">Bear candle</span>
          <span className="ema20">EMA 20</span>
          <span className="ema50">EMA 50</span>
        </div>

        <div>
          <strong>{signal}</strong>
          <span>
            Rise {Number(probabilityRise || 0).toFixed(1)}%
          </span>
          <span>
            Fall {Number(probabilityFall || 0).toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note = "",
  tone = "",
}) {
  return (
    <article className={`rfMetricCard ${tone || ""}`}>
      <small>{label}</small>
      <strong>{value ?? "—"}</strong>
      {note ? <span>{note}</span> : null}
    </article>
  );
}
function ModeSummary({
  label,
  analysis,
  active = false,
  onClick,
}) {
  const safeAnalysis = analysis || {};
  const signal = safeAnalysis.signal || "WAIT";
  const confidence = Number(safeAnalysis.confidence || 0);
  const regime =
    safeAnalysis.regime ||
    safeAnalysis.marketRegime ||
    "WAIT";

  return (
    <button
      type="button"
      className={`rfModeSummary ${signalClass(signal)} ${
        active ? "active" : ""
      }`}
      onClick={onClick}
    >
      <small>{label}</small>
      <strong>{signal}</strong>
      <span>{pct(confidence)}</span>
      <em>{regime}</em>
    </button>
  );
}
function MiniChart({
  points = [],
  signal = "WAIT",
}) {
  const values = (Array.isArray(points) ? points : [])
    .map((item) =>
      Number(
        typeof item === "number"
          ? item
          : item?.quote ??
              item?.price ??
              item?.value ??
              item?.close ??
              item?.currentPrice ??
              0
      )
    )
    .filter(Number.isFinite)
    .slice(-120);

  if (values.length < 2) {
    return (
      <div className="rfMiniChartEmpty">
        Waiting for enough live price points…
      </div>
    );
  }

  const width = 1000;
  const height = 260;
  const padding = 18;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(0.000001, maximum - minimum);

  const coordinates = values.map((value, index) => {
    const x =
      padding +
      index / Math.max(1, values.length - 1) *
        (width - padding * 2);

    const y =
      padding +
      (maximum - value) / range *
        (height - padding * 2);

    return `${x},${y}`;
  });

  const areaCoordinates = [
    `${padding},${height - padding}`,
    ...coordinates,
    `${width - padding},${height - padding}`,
  ].join(" ");

  return (
    <div className={`rfMiniChart ${signalClass(signal)}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        <g className="rfMiniChartGrid">
          {[0.25, 0.5, 0.75].map((ratio) => (
            <line
              key={ratio}
              x1={padding}
              x2={width - padding}
              y1={height * ratio}
              y2={height * ratio}
            />
          ))}
        </g>

        <polygon
          points={areaCoordinates}
          className="rfMiniChartArea"
        />

        <polyline
          points={coordinates.join(" ")}
          className="rfMiniChartLine"
        />
      </svg>

      <div className="rfMiniChartStatus">
        <span>{signal}</span>
        <strong>{values.at(-1).toFixed(6)}</strong>
      </div>
    </div>
  );
}
export default function RiseFallAnalysis() {
  const {
    markets = [],
    market = null,
    symbol = "",
    connected = false,
    loadingMarket = false,
    prices = [],
    currentPrice = null,
    selectedAccountType = "demo",
    selectedAccountId = "",
    openContracts = [],
    transactions = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
    refreshContract,
  } = useDerivTicks();

  const [mode, setMode] = useState("15s");
  const [feedMessage, setFeedMessage] = useState(
    "Connecting live feed…"
  );
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [signalLog, setSignalLog] = useState([]);
  const [autoRunning, setAutoRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [allowReal, setAllowReal] = useState(false);
  const [autoSwitchMarket, setAutoSwitchMarket] = useState(true);
  const [switchAfterSeconds, setSwitchAfterSeconds] = useState(4);
  const [marketSwitches, setMarketSwitches] = useState(0);
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);
  const [durationMode, setDurationMode] = useState("AUTO");
  const [allowOneTick, setAllowOneTick] = useState(false);
  const [oneTickMinimumScore, setOneTickMinimumScore] = useState(90);
  const [oneTickMinimumConfidence, setOneTickMinimumConfidence] = useState(88);
  const [executionMessage, setExecutionMessage] = useState(
    "Auto execution is stopped."
  );
  const [executionRuns, setExecutionRuns] = useState(0);
  const [sessionRunTarget, setSessionRunTarget] = useState(100);
  const [burstMode, setBurstMode] = useState(true);
  const [burstRuns, setBurstRuns] = useState(0);
  const [sessionTrades, setSessionTrades] = useState([]);
  const [manualPanelOpen, setManualPanelOpen] = useState(false);
  const [manualStake, setManualStake] = useState(0.35);
  const [manualDuration, setManualDuration] = useState("2T");
  const [manualBarrier, setManualBarrier] = useState(1);
  const [manualStatus, setManualStatus] = useState(
    "Ready for a direct manual contract."
  );
  const [learningHistory, setLearningHistory] = useState(
    safeReadLearningHistory
  );
  const [candleMode, setCandleMode] = useState("10S");
  const [displayedCandles, setDisplayedCandles] = useState([]);
  const [persistentHistory, setPersistentHistory] = useState([]);
  const [marketSnapshots, setMarketSnapshots] = useState(() =>
    readStoredMap(RF_MARKET_SNAPSHOT_KEY)
  );
  const previousSignalRef = useRef("WAIT");
  const lastResultSoundRef = useRef("");
  const lastAlertAtRef = useRef(0);
  const lastExecutedSignalRef = useRef("");
  const executionBusyRef = useRef(false);
  const autoRunningRef = useRef(false);
  const executionRunsRef = useRef(0);
  const learnedContractsRef = useRef(new Set());
  const consecutiveLossesRef = useRef(0);
  const waitStartedAtRef = useRef(Date.now());
  const marketSwitchingRef = useRef(false);
  const lastMarketSwitchAtRef = useRef(0);
  const historySeededRef = useRef(new Set());
  const lastLiveTickRef = useRef({ symbol: "", key: "" });
  const stopGenerationRef = useRef(0);
  const settlementRefreshRef = useRef(new Map());
  const burstDirectionRef = useRef("WAIT");
  const burstRunsRef = useRef(0);
  const nextAutoEntryAtRef = useRef(0);

  const connectingRef = useRef(false);

  useEffect(() => {
    autoRunningRef.current = autoRunning;
  }, [autoRunning]);

  useEffect(() => {
    executionRunsRef.current = executionRuns;
  }, [executionRuns]);

  useEffect(() => {
    burstRunsRef.current = burstRuns;
  }, [burstRuns]);

  useEffect(() => {
    consecutiveLossesRef.current = consecutiveLosses;
  }, [consecutiveLosses]);

  useEffect(() => {
    if (
      connected ||
      connectingRef.current ||
      typeof connect !== "function"
    ) {
      return;
    }

    connectingRef.current = true;

    Promise.resolve(connect())
      .then(() =>
        setFeedMessage(
          "Deriv live feed requested."
        )
      )
      .catch((error) =>
        setFeedMessage(
          error instanceof Error
            ? error.message
            : "Feed connection failed."
        )
      )
      .finally(() => {
        connectingRef.current = false;
      });
  }, [connected, connect]);

  useEffect(() => {
    if (!symbol) return;

    const stored = readStoredMap(RF_HISTORY_STORAGE_KEY);
    const saved = Array.isArray(stored[symbol]) ? stored[symbol] : [];
    setPersistentHistory(saved);
  }, [symbol]);

  useEffect(() => {
    if (!symbol || !Array.isArray(prices) || !prices.length) return;

    setPersistentHistory((current) => {
      const now = Date.now();
      let incoming = [];

      if (!historySeededRef.current.has(symbol) && !current.length) {
        incoming = prices
          .map((item, index) =>
            normalizedTick(
              item,
              now - (prices.length - index) * 1000
            )
          )
          .filter(Boolean);

        historySeededRef.current.add(symbol);
      } else {
        const latestRaw = prices.at(-1);
        const latest = normalizedTick(latestRaw, now);

        if (latest) {
          const explicitTime =
            typeof latestRaw === "object" && latestRaw
              ? latestRaw.epoch ??
                latestRaw.time ??
                latestRaw.timestamp ??
                latestRaw.createdAt
              : null;

          const key = explicitTime
            ? `${explicitTime}:${latest.quote}`
            : `${prices.length}:${latest.quote}:${now}`;

          if (
            lastLiveTickRef.current.symbol !== symbol ||
            lastLiveTickRef.current.key !== key
          ) {
            incoming = [latest];
            lastLiveTickRef.current = { symbol, key };
          }
        }
      }

      if (!incoming.length) return current;

      const next = mergeTickHistory(current, incoming);
      const stored = readStoredMap(RF_HISTORY_STORAGE_KEY);
      stored[symbol] = next;
      writeStoredMap(RF_HISTORY_STORAGE_KEY, stored);
      return next;
    });
  }, [prices, symbol]);

  const combinedPriceHistory = useMemo(
    () => mergeTickHistory(persistentHistory, prices),
    [persistentHistory, prices]
  );

  const rawCandles = useMemo(
    () => buildCandles(combinedPriceHistory, candleMode),
    [combinedPriceHistory, candleMode]
  );

  useEffect(() => {
    setDisplayedCandles((current) =>
      freezeClosedCandles(current, rawCandles)
    );
  }, [rawCandles]);

  const candles = displayedCandles;


  const candleMarketStructure = useMemo(
    () => candleStructure(candles),
    [candles]
  );

  const analysis15 = useMemo(
    () => analyzeRiseFall(combinedPriceHistory, "15s"),
    [combinedPriceHistory]
  );

  const analysis10 = useMemo(
    () => analyzeRiseFall(combinedPriceHistory, "10ticks"),
    [combinedPriceHistory]
  );

  const active =
    mode === "15s" ? analysis15 : analysis10;


  const syntheticScore = useMemo(
    () =>
      Math.max(
        Number(active.opportunityScore || 0),
        Number(active.scores?.final || 0),
        Number(active.confidence || 0)
      ),
    [
      active.opportunityScore,
      active.scores?.final,
      active.confidence,
    ]
  );

  useEffect(() => {
    if (!symbol || !active.samples) return;

    setMarketSnapshots((current) => {
      const next = {
        ...current,
        [symbol]: {
          symbol,
          label: market?.label || symbol,
          score: syntheticScore,
          confidence: Number(active.confidence || 0),
          signal: active.signal || "WAIT",
          risk: active.risk || "HIGH",
          regime: active.regime || "UNKNOWN",
          updatedAt: Date.now(),
        },
      };

      const trimmed = Object.fromEntries(
        Object.entries(next)
          .sort(([, a], [, b]) => Number(b.updatedAt) - Number(a.updatedAt))
          .slice(0, RF_MAX_MARKET_SNAPSHOTS)
      );

      writeStoredMap(RF_MARKET_SNAPSHOT_KEY, trimmed);
      return trimmed;
    });
  }, [
    symbol,
    market?.label,
    active.samples,
    active.signal,
    active.confidence,
    active.risk,
    active.regime,
    syntheticScore,
  ]);

  const strongSyntheticMarkets = useMemo(
    () =>
      Object.values(marketSnapshots)
        .filter((item) => Number(item.score || 0) >= 90)
        .sort((a, b) => Number(b.score) - Number(a.score)),
    [marketSnapshots]
  );


  const preBuyStructure = useMemo(
    () =>
      structureEntryChecklist({
        structure: candleMarketStructure,
        active,
        currentCandle: candles.at(-1),
      }),
    [
      candleMarketStructure,
      active.signal,
      active.confidence,
      active.opportunityScore,
      active.scores?.final,
      active.dominantPressure,
      active.pressure?.buying,
      active.pressure?.selling,
      candles,
    ]
  );

  const learningProfile = useMemo(() => {
    const records = Array.isArray(learningHistory)
      ? learningHistory
      : [];

    const symbolRecords = records.filter(
      (item) => item.symbol === symbol
    );

    const directionRecords = symbolRecords.filter(
      (item) => item.signal === active.signal
    );

    const durationRecords = directionRecords.filter(
      (item) => item.durationMode === durationMode
    );

    const setupRecords = durationRecords.filter(
      (item) =>
        item.regime === active.regime &&
        item.scoreBucket === scoreBucket(active.opportunityScore) &&
        item.noiseBucket === noiseBucket(active.noiseRatio)
    );

    const referenceRecords =
      setupRecords.length >= 5
        ? setupRecords
        : durationRecords.length >= 8
          ? durationRecords
          : directionRecords;

    const sampleCount = referenceRecords.length;
    const winRate = rate(referenceRecords);
    const lossStreak = currentLossStreak(symbolRecords);

    let thresholdAdjustment = 0;

    if (sampleCount >= 12 && winRate < 42) {
      thresholdAdjustment = 8;
    } else if (sampleCount >= 8 && winRate < 48) {
      thresholdAdjustment = 5;
    } else if (sampleCount >= 8 && winRate >= 68) {
      thresholdAdjustment = -2;
    }

    if (lossStreak >= 3) {
      thresholdAdjustment = Math.max(thresholdAdjustment, 8);
    }

    const baseBuy = Number(active.adaptiveThresholds?.buy || 72);
    const learnedBuyThreshold = Math.max(
      70,
      Math.min(92, baseBuy + thresholdAdjustment)
    );

    const setupRejected =
      sampleCount >= 6 &&
      winRate < 40;

    return {
      sampleCount,
      winRate,
      lossStreak,
      thresholdAdjustment,
      learnedBuyThreshold,
      setupRejected,
      directionSamples: directionRecords.length,
      directionRate: rate(directionRecords),
      durationSamples: durationRecords.length,
      durationRate: rate(durationRecords),
      totalSamples: symbolRecords.length,
      totalRate: rate(symbolRecords),
    };
  }, [
    learningHistory,
    symbol,
    active.signal,
    active.regime,
    active.opportunityScore,
    active.noiseRatio,
    active.adaptiveThresholds?.buy,
    durationMode,
  ]);

  const learnedEntryAllowed =
    !active.autoSkip &&
    !learningProfile.setupRejected &&
    Number(active.opportunityScore || 0) >=
      Number(learningProfile.learnedBuyThreshold || 72) &&
    learningProfile.lossStreak < 3;

  const consensus =
    analysis15.signal !== "WAIT" &&
    analysis15.signal === analysis10.signal
      ? analysis15.signal
      : "WAIT";

  const consensusConfidence =
    consensus === "WAIT"
      ? Math.min(
          analysis15.confidence,
          analysis10.confidence
        )
      : (
          analysis15.confidence +
          analysis10.confidence
        ) / 2;


  const marketSymbols = useMemo(
    () =>
      (Array.isArray(markets) ? markets : [])
        .map((item) =>
          String(
            item?.symbol ??
              item?.value ??
              item?.id ??
              ""
          )
        )
        .filter(Boolean),
    [markets]
  );

  const hasOpenSessionTrade = sessionTrades.some(
    (trade) => String(trade.status || "OPEN").toUpperCase() === "OPEN"
  );

  const activeDirectionProbability =
    active.signal === "RISE"
      ? Number(active.probabilityRise || 0)
      : active.signal === "FALL"
        ? Number(active.probabilityFall || 0)
        : 0;

  const activeConfidence = Number(
    active.smartConfidence ?? active.confidence ?? 0
  );

  const activeOpportunity = Number(
    active.opportunityScore ?? active.scores?.final ?? 0
  );

  const activeContinuation = Number(
    active.continuation ??
      active.continuationProbability ??
      active.continuationReversal?.continuation ??
      0
  );

  const activeNoise = Number(
    active.noiseRatio ?? active.noise ?? 100
  );

  const activeReversalRisk = Number(
    active.reversalProbability ??
      active.reversal ??
      active.continuationReversal?.reversal ??
      100
  );

  const burstEntryReady =
    burstMode &&
    burstRunsRef.current < 5 &&
    learnedEntryAllowed &&
    active.signal !== "WAIT" &&
    activeDirectionProbability >= 90 &&
    activeConfidence >= 87 &&
    activeOpportunity >= 84 &&
    activeContinuation >= 76 &&
    activeReversalRisk <= 20 &&
    activeNoise <= 50 &&
    active.risk === "LOW" &&
    preBuyStructure.passed >= 5;

  const immediateEntryReady =
    learnedEntryAllowed &&
    active.signal !== "WAIT" &&
    (
      (
        preBuyStructure.ready &&
        (
          active.tradeNow ||
          active.fastScalpReady ||
          active.instantOneTick
        )
      ) ||
      burstEntryReady
    );

  function nextMarketSymbol() {
    if (!marketSymbols.length) return "";

    const currentIndex = marketSymbols.indexOf(symbol);

    return marketSymbols[
      currentIndex >= 0
        ? (currentIndex + 1) % marketSymbols.length
        : 0
    ];
  }

  async function switchToNextMarket(reason = "WAIT timeout") {
    if (
      marketSwitchingRef.current ||
      hasOpenSessionTrade ||
      tradeBusy ||
      typeof changeSymbol !== "function"
    ) {
      return;
    }

    const nextSymbol = nextMarketSymbol();

    if (!nextSymbol || nextSymbol === symbol) return;

    marketSwitchingRef.current = true;
    lastMarketSwitchAtRef.current = Date.now();
    waitStartedAtRef.current = Date.now();

    setExecutionMessage(
      `Switching volatility ${symbol || "market"} → ${nextSymbol} · ${reason}.`
    );

    try {
      await Promise.resolve(changeSymbol(nextSymbol));
      setMarketSwitches((value) => value + 1);
      lastExecutedSignalRef.current = "";
    } catch (error) {
      setExecutionMessage(
        error instanceof Error
          ? error.message
          : "Automatic market switch failed."
      );
    } finally {
      window.setTimeout(() => {
        marketSwitchingRef.current = false;
      }, 1200);
    }
  }

  function resetTransactions() {
    setSessionTrades([]);
    setExecutionRuns(0);
    executionRunsRef.current = 0;
    setConsecutiveLosses(0);
    consecutiveLossesRef.current = 0;
    setBurstRuns(0);
    burstDirectionRef.current = "WAIT";
    learnedContractsRef.current = new Set();
    lastExecutedSignalRef.current = "";
    setExecutionMessage(
      autoRunningRef.current
        ? "Transaction view reset. Auto execution continues."
        : "Transaction view and run counter reset."
    );
  }



  function contractIdOf(item = {}) {
    return String(
      item?.contract_id ||
        item?.id ||
        item?.contractId ||
        ""
    );
  }

  function contractStatus(item = {}) {
    const status = String(item?.status || "").toUpperCase();

    if (
      item?.is_sold ||
      item?.is_expired ||
      ["WON", "LOST", "SOLD", "EXPIRED"].includes(status)
    ) {
      return status || "CLOSED";
    }

    return status || "OPEN";
  }

  function profitOf(item = {}) {
    const value = Number(
      item?.profit ??
        item?.profit_loss ??
        item?.pnl ??
        (
          Number(item?.sell_price || 0) -
          Number(item?.buy_price || 0)
        )
    );

    return Number.isFinite(value) ? value : 0;
  }

  function tradeParameters(signal, analysis) {
    const rise = signal === "RISE";
    const finalScore = Number(analysis?.scores?.final || 0);
    const confidence = Number(
      analysis?.smartConfidence ??
        analysis?.confidence ??
        0
    );
    const probability =
      signal === "RISE"
        ? Number(analysis?.probabilityRise || 0)
        : Number(analysis?.probabilityFall || 0);
    const continuation = Number(
      analysis?.continuation ??
        analysis?.continuationProbability ??
        analysis?.continuationReversal?.continuation ??
        0
    );
    const reversal = Number(
      analysis?.reversalProbability ??
        analysis?.reversal ??
        analysis?.continuationReversal?.reversal ??
        100
    );
    const noise = Number(
      analysis?.noiseRatio ?? analysis?.noise ?? 100
    );
    const confirmations = Number(analysis?.confirmationsPassed || 0);
    const pressure = Number(
      analysis?.dominantPressure ??
        Math.max(
          Number(analysis?.pressure?.buying || 0),
          Number(analysis?.pressure?.selling || 0)
        )
    );

    const base = {
      contractType: rise ? "CALL" : "PUT",
      label: rise ? "RISE" : "FALL",
    };

    const exceptionalOneTick = false;

    const twoTickQualified =
      probability >= 94 &&
      confidence >= 92 &&
      finalScore >= 89 &&
      continuation >= 84 &&
      reversal <= 13 &&
      noise <= 34 &&
      confirmations >= 9 &&
      pressure >= 70 &&
      analysis?.risk === "LOW";

    const fiveTickQualified =
      probability >= 89 &&
      confidence >= 86 &&
      finalScore >= 83 &&
      continuation >= 77 &&
      reversal <= 20 &&
      noise <= 48 &&
      confirmations >= 7 &&
      pressure >= 62 &&
      analysis?.risk === "LOW";

    const tenSecondQualified =
      probability >= 85 &&
      confidence >= 82 &&
      finalScore >= 79 &&
      continuation >= 70 &&
      reversal <= 26 &&
      noise <= 58 &&
      confirmations >= 6 &&
      analysis?.risk !== "HIGH";

    const fifteenSecondQualified =
      probability >= 80 &&
      confidence >= 77 &&
      finalScore >= 74 &&
      continuation >= 64 &&
      reversal <= 32 &&
      noise <= 68 &&
      confirmations >= 5 &&
      analysis?.risk !== "HIGH";

    if (durationMode === "2T") {
      if (!twoTickQualified) {
        return {
          blocked: true,
          reason:
            "2-tick entry is not safe enough. Scanning or switching market.",
          requestMarketSwitch: true,
        };
      }

      return {
        ...base,
        duration: 2,
        durationUnit: "t",
        fastEntry: true,
        displayDuration: "2 TICKS",
      };
    }

    if (durationMode === "AUTO") {
      if (twoTickQualified) {
        return {
          ...base,
          duration: 2,
          durationUnit: "t",
          fastEntry: true,
          displayDuration: "2 TICKS",
        };
      }

      if (fiveTickQualified) {
        return {
          ...base,
          duration: 5,
          durationUnit: "t",
          fastEntry: true,
          displayDuration: "5 TICKS",
        };
      }

      if (tenSecondQualified) {
        return {
          ...base,
          duration: 10,
          durationUnit: "s",
          fastEntry: false,
          displayDuration: "10 SECONDS",
        };
      }

      if (fifteenSecondQualified) {
        return {
          ...base,
          duration: 15,
          durationUnit: "s",
          fastEntry: false,
          displayDuration: "15 SECONDS",
        };
      }

      return {
        blocked: true,
        reason:
          "No safe duration: weak probability, high reversal/noise, or insufficient confirmations. Switching market.",
        requestMarketSwitch: true,
      };
    }

    if (durationMode === "10T") {
      if (!fiveTickQualified) {
        return {
          blocked: true,
          reason: "10-tick setup is weak. Waiting or switching market.",
          requestMarketSwitch: true,
        };
      }

      return {
        ...base,
        duration: 10,
        durationUnit: "t",
        fastEntry: false,
        displayDuration: "10 TICKS",
      };
    }

    if (durationMode === "15S") {
      if (!fifteenSecondQualified) {
        return {
          blocked: true,
          reason: "15-second setup is weak. Waiting or switching market.",
          requestMarketSwitch: true,
        };
      }

      return {
        ...base,
        duration: 15,
        durationUnit: "s",
        fastEntry: false,
        displayDuration: "15 SECONDS",
      };
    }

    if (mode === "15s" && fifteenSecondQualified) {
      return {
        ...base,
        duration: 15,
        durationUnit: "s",
        fastEntry: false,
        displayDuration: "15 SECONDS",
      };
    }

    if (fiveTickQualified) {
      return {
        ...base,
        duration: 10,
        durationUnit: "t",
        fastEntry: false,
        displayDuration: "10 TICKS",
      };
    }

    return {
      blocked: true,
      reason: "Current market is not clean enough. Switching market.",
      requestMarketSwitch: true,
    };
  }

  async function placeManualContract(contractType, barrier) {
    if (tradeBusy) {
      setManualStatus("Wait for the current order request to finish.");
      return;
    }

    if (hasOpenSessionTrade) {
      setManualStatus(
        "A contract is already open. Wait for it to settle first."
      );
      return;
    }

    if (
      selectedAccountType === "real" &&
      !allowReal
    ) {
      setManualStatus(
        "Enable Real-account execution before buying on the Real account."
      );
      return;
    }

    const amount = Math.max(
      0.35,
      Number(manualStake || stake || 0.35)
    );

    const isDigitContract = contractType.startsWith("DIGIT");
    let duration = 2;
    let durationUnit = "t";
    let displayDuration = "2 TICKS";

    if (isDigitContract) {
      duration = 1;
      durationUnit = "t";
      displayDuration = "1 TICK";
    } else if (manualDuration === "5T") {
      duration = 5;
      displayDuration = "5 TICKS";
    } else if (manualDuration === "10S") {
      duration = 10;
      durationUnit = "s";
      displayDuration = "10 SECONDS";
    } else if (manualDuration === "15S") {
      duration = 15;
      durationUnit = "s";
      displayDuration = "15 SECONDS";
    }

    const signal =
      contractType === "CALL"
        ? "RISE"
        : contractType === "PUT"
          ? "FALL"
          : contractType;

    try {
      setManualStatus(`Sending ${signal} contract…`);

      const response = await placeTrade({
        contractType,
        amount,
        basis: "stake",
        duration,
        durationUnit,
        barrier:
          barrier === undefined || barrier === null
            ? undefined
            : String(barrier),
      });

      const contractId =
        response?.buy?.contract_id ||
        response?.contract_id ||
        response?.proposal_open_contract?.contract_id ||
        Date.now();

      setSessionTrades((current) => [
        {
          id: `manual-${contractId}`,
          contractId,
          signal,
          mode: "manual",
          displayDuration,
          stake: amount,
          status: "OPEN",
          confidence: 0,
          finalScore: 0,
          profit: 0,
          time: Date.now(),
          manual: true,
        },
        ...current,
      ].slice(0, 100));

      setManualStatus(
        `${signal} bought directly · ${displayDuration} · ${amount.toFixed(2)}`
      );
    } catch (error) {
      setManualStatus(
        error instanceof Error
          ? error.message
          : "Manual trade failed."
      );
    }
  }

  function stopAuto(message) {
    stopGenerationRef.current += 1;
    autoRunningRef.current = false;
    executionBusyRef.current = false;
    marketSwitchingRef.current = false;
    nextAutoEntryAtRef.current = Number.POSITIVE_INFINITY;
    lastExecutedSignalRef.current = "";
    setAutoRunning(false);
    setExecutionMessage(message || "STOPPED MANUALLY");
  }

  async function executeConfirmedSignal(signal, analysis) {
    if (
      executionBusyRef.current ||
      !autoRunningRef.current ||
      executionRunsRef.current >= Math.max(1, Number(sessionRunTarget) || 100) ||
      Date.now() < nextAutoEntryAtRef.current ||
      burstRunsRef.current >= 5 ||
      hasOpenSessionTrade ||
      !signal ||
      signal === "WAIT" ||
      !(
        analysis?.tradeNow ||
        analysis?.fastScalpReady ||
        analysis?.instantOneTick ||
        burstEntryReady
      )
    ) {
      return;
    }

    if (!connected) {
      setExecutionMessage("Waiting for Deriv feed connection.");
      return;
    }

    if (!selectedAccountId) {
      stopAuto("Choose a Demo or Real Deriv account first.");
      return;
    }

    if (selectedAccountType !== "demo" && !allowReal) {
      stopAuto(
        "Real auto execution is locked. Enable Real execution explicitly or switch to Demo."
      );
      return;
    }

    if (typeof placeTrade !== "function") {
      stopAuto("Trade execution function is unavailable.");
      return;
    }

    const signature = [
      signal,
      mode,
      symbol,
      Number(analysis?.scores?.final || 0).toFixed(0),
      Number(analysis?.confirmationsPassed || 0),
      Math.floor(Date.now() / 1500),
    ].join(":");

    if (lastExecutedSignalRef.current === signature) return;

    const executionGeneration = stopGenerationRef.current;
    executionBusyRef.current = true;
    lastExecutedSignalRef.current = signature;

    const parameters = tradeParameters(signal, analysis);
    const safeStake = Math.max(0.35, Number(stake) || 0.35);

    if (parameters.blocked) {
      lastExecutedSignalRef.current = "";
      executionBusyRef.current = false;
      setExecutionMessage(parameters.reason);

      if (
        parameters.requestMarketSwitch &&
        autoSwitchMarket &&
        !hasOpenSessionTrade
      ) {
        window.setTimeout(() => {
          if (autoRunningRef.current) {
            void switchToNextMarket(parameters.reason);
          }
        }, 250);
      }

      return;
    }

    setExecutionMessage(
      `Sending ${parameters.label} · ${parameters.displayDuration} · stake ${safeStake.toFixed(2)}.`
    );

    try {
      playSignalTone(signal);

      const result = await placeTrade({
        symbol,
        contractType: parameters.contractType,
        amount: safeStake,
        basis: "stake",
        duration: parameters.duration,
        durationUnit: parameters.durationUnit,
      });

      const contractId = String(result?.contractId || "");
      const nextRuns = executionRunsRef.current + 1;
      const stoppedDuringPurchase =
        executionGeneration !== stopGenerationRef.current ||
        !autoRunningRef.current;

      executionRunsRef.current = nextRuns;
      setExecutionRuns(nextRuns);

      setSessionTrades((current) => [
        {
          id: contractId || `${Date.now()}-${signal}`,
          contractId,
          time: Date.now(),
          signal,
          mode,
          duration: parameters.duration,
          durationUnit: parameters.durationUnit,
          displayDuration: parameters.displayDuration,
          fastEntry: parameters.fastEntry,
          stake: safeStake,
          confidence: Number(
            analysis?.smartConfidence ??
              analysis?.confidence ??
              0
          ),
          finalScore: Number(analysis?.scores?.final || 0),
          opportunityScore: Number(analysis?.opportunityScore || 0),
          regime: String(analysis?.regime || "UNKNOWN"),
          noiseRatio: Number(analysis?.noiseRatio || 0),
          quality: String(analysis?.quality || "REJECT"),
          learnedBuyThreshold: Number(
            learningProfile.learnedBuyThreshold || 72
          ),
          status: "OPEN",
          openedAt: Date.now(),
          settlementChecks: 0,
          profit: 0,
          learned: false,
        },
        ...current,
      ].slice(0, 30));

      if (burstDirectionRef.current === signal) {
        const nextBurst = burstRunsRef.current + 1;
        burstRunsRef.current = nextBurst;
        setBurstRuns(nextBurst);
      } else {
        burstDirectionRef.current = signal;
        burstRunsRef.current = 1;
        setBurstRuns(1);
      }

      nextAutoEntryAtRef.current = Date.now() + 1200;

      if (nextRuns >= Math.max(1, Number(sessionRunTarget) || 100)) {
        stopAuto(`Session target completed: ${nextRuns} runs.`);
      } else {
        setExecutionMessage(
          stoppedDuringPurchase
            ? `${parameters.label} opened before STOP completed. No new trade will open.`
            : `${parameters.label} trade opened${
                contractId ? ` · Contract ${contractId}` : ""
              }.`
        );
      }

    } catch (error) {
      lastExecutedSignalRef.current = "";
      setExecutionMessage(
        error instanceof Error
          ? error.message
          : "Trade execution failed."
      );
    } finally {
      executionBusyRef.current = false;
    }
  }

  function toggleAutoExecution() {
    if (autoRunning) {
      stopAuto("Auto execution stopped manually.");
      return;
    }

    if (selectedAccountType !== "demo" && !allowReal) {
      setExecutionMessage(
        "Enable Real execution explicitly or switch to Demo."
      );
      return;
    }

    if (consecutiveLossesRef.current >= 3) {
      setExecutionMessage(
        "Reset transactions before restarting after 3 consecutive losses."
      );
      return;
    }

    stopGenerationRef.current += 1;
    lastExecutedSignalRef.current = "";
    waitStartedAtRef.current = Date.now();
    setAutoRunning(true);
    autoRunningRef.current = true;
    setExecutionMessage(
      allowOneTick
        ? "Running continuously. A valid entry executes immediately; weak markets switch automatically."
        : "Running continuously until STOP. Confirmed entries execute immediately."
    );
  }

  function playResultFeedback(result) {
    if (!soundEnabled || typeof window === "undefined") return;

    const normalized = String(result || "").toUpperCase();
    const isWin = normalized === "WON";
    const frequencies = isWin
      ? [660, 880, 1040]
      : [420, 300, 220];

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (AudioContextClass) {
      const context = new AudioContextClass();

      frequencies.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const startAt = context.currentTime + index * 0.16;

        oscillator.type = isWin ? "sine" : "sawtooth";
        oscillator.frequency.value = frequency;

        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(
          isWin ? 0.22 : 0.15,
          startAt + 0.02
        );
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          startAt + 0.14
        );

        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.15);
      });

      window.setTimeout(() => {
        context.close().catch(() => {});
      }, 850);
    }

    if ("vibrate" in navigator) {
      navigator.vibrate(
        isWin ? [80, 55, 80] : [180, 80, 180]
      );
    }

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(
        isWin ? "Trade won" : "Trade lost"
      );
      utterance.rate = 1.05;
      utterance.pitch = isWin ? 1.2 : 0.8;
      utterance.volume = 0.9;
      window.speechSynthesis.speak(utterance);
    }
  }

  function playSignalTone(signal) {
    if (!soundEnabled || typeof window === "undefined") return;

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = signal === "RISE" ? "sine" : "triangle";
    oscillator.frequency.value = signal === "RISE" ? 880 : 430;

    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.18,
      context.currentTime + 0.02
    );
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      context.currentTime + 0.45
    );

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.48);

    oscillator.addEventListener("ended", () => {
      context.close().catch(() => {});
    });
  }

  useEffect(() => {
    const currentSignal = active.tradeNow ? active.signal : "WAIT";
    const previousSignal = previousSignalRef.current;
    const now = Date.now();

    if (
      currentSignal !== "WAIT" &&
      currentSignal !== previousSignal &&
      now - lastAlertAtRef.current > 3000
    ) {
      lastAlertAtRef.current = now;
      playSignalTone(currentSignal);

      setSignalLog((current) =>
        [
          {
            id: `${now}-${currentSignal}`,
            time: now,
            signal: currentSignal,
            mode,
            confidence: active.confidence,
            probability:
              currentSignal === "RISE"
                ? active.probabilityRise
                : active.probabilityFall,
            price: currentPrice,
            grade: active.setupGrade,
          },
          ...current,
        ].slice(0, 12)
      );
    }

    previousSignalRef.current = currentSignal;
  }, [
    active.signal,
    active.confidence,
    active.probabilityRise,
    active.probabilityFall,
    active.setupGrade,
    currentPrice,
    mode,
    soundEnabled,
  ]);


  useEffect(() => {
    if (
      !autoRunning ||
      !immediateEntryReady ||
      hasOpenSessionTrade ||
      consecutiveLosses >= 3 ||
      executionRuns >= Math.max(1, Number(sessionRunTarget) || 100)
    ) {
      return;
    }

    waitStartedAtRef.current = Date.now();
    void executeConfirmedSignal(active.signal, active);
  }, [
    autoRunning,
    immediateEntryReady,
    hasOpenSessionTrade,
    consecutiveLosses,
    executionRuns,
    sessionRunTarget,
    burstEntryReady,
    active.signal,
    active.tradeNow,
    active.fastScalpReady,
    active.instantOneTick,
    active.confirmationsPassed,
    active.scores?.final,
    active.opportunityScore,
    learnedEntryAllowed,
    learningProfile.learnedBuyThreshold,
    symbol,
    mode,
  ]);

  useEffect(() => {
    if (
      !autoRunning ||
      !autoSwitchMarket ||
      hasOpenSessionTrade ||
      tradeBusy ||
      marketSymbols.length < 2 ||
      consecutiveLosses >= 3
    ) {
      return;
    }

    const weakMarket =
      active.risk === "HIGH" ||
      activeNoise > 60 ||
      activeReversalRisk > 30 ||
      activeConfidence < 76 ||
      activeOpportunity < 74 ||
      activeContinuation < 62;

    const cleanEntry =
      immediateEntryReady &&
      !weakMarket &&
      !active.autoSkip &&
      Number(active.opportunityScore || 0) >=
        Number(learningProfile.learnedBuyThreshold || 72);

    if (cleanEntry) {
      waitStartedAtRef.current = Date.now();
      return;
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      const waitedMs = now - waitStartedAtRef.current;
      const switchDelay = Math.max(
        3,
        weakMarket
          ? 3
          : Number(switchAfterSeconds) || 4
      ) * 1000;

      if (
        waitedMs >= switchDelay &&
        now - lastMarketSwitchAtRef.current >= switchDelay
      ) {
        void switchToNextMarket(
          active.skipReason ||
            `No executable entry for ${Math.round(waitedMs / 1000)}s`
        );
      }
    }, 500);

    return () => window.clearInterval(timer);
  }, [
    autoRunning,
    autoSwitchMarket,
    hasOpenSessionTrade,
    tradeBusy,
    marketSymbols,
    symbol,
    immediateEntryReady,
    active.autoSkip,
    active.skipReason,
    active.opportunityScore,
    active.risk,
    activeNoise,
    activeReversalRisk,
    activeConfidence,
    activeOpportunity,
    learningProfile.learnedBuyThreshold,
    switchAfterSeconds,
    consecutiveLosses,
  ]);


  useEffect(() => {
    if (!sessionTrades.length || typeof refreshContract !== "function") return;

    const timer = window.setInterval(() => {
      const now = Date.now();

      sessionTrades.forEach((trade) => {
        if (String(trade.status || "").toUpperCase() !== "OPEN") return;
        if (!trade.contractId || !trade.openedAt) return;

        const expectedMs =
          trade.durationUnit === "s"
            ? Number(trade.duration || 1) * 1000
            : Math.max(5000, Number(trade.duration || 1) * 1500);

        const age = now - Number(trade.openedAt);
        const previous = settlementRefreshRef.current.get(trade.contractId) || 0;

        if (age >= expectedMs + 3500 && now - previous >= 4000) {
          settlementRefreshRef.current.set(trade.contractId, now);
          Promise.resolve(refreshContract(trade.contractId)).catch(() => {});

          setSessionTrades((current) =>
            current.map((item) =>
              item.contractId === trade.contractId
                ? {
                    ...item,
                    settlementChecks: Number(item.settlementChecks || 0) + 1,
                  }
                : item
            )
          );
        }

        if (age >= expectedMs + 30000 && autoRunningRef.current) {
          stopAuto(
            `Settlement timeout for contract ${trade.contractId}. Auto stopped safely.`
          );
        }
      });
    }, 1500);

    return () => window.clearInterval(timer);
  }, [sessionTrades, refreshContract]);


  useEffect(() => {
    const contracts = Array.isArray(openContracts) ? openContracts : [];

    if (!contracts.length) return;

    const learningRecords = [];

    setSessionTrades((current) =>
      current.map((trade) => {
        const match = contracts.find(
          (contract) =>
            contractIdOf(contract) === String(trade.contractId || "")
        );

        if (!match) return trade;

        const status = contractStatus(match);
        const closed = ["WON", "LOST", "SOLD", "EXPIRED"].includes(status);
        const contractId = String(trade.contractId || "");

        if (
          closed &&
          contractId &&
          !learnedContractsRef.current.has(contractId)
        ) {
          learnedContractsRef.current.add(contractId);

          learningRecords.push({
            id: contractId,
            time: Date.now(),
            symbol,
            signal: trade.signal,
            durationMode,
            duration: trade.displayDuration,
            regime: trade.regime || "UNKNOWN",
            opportunityScore: Number(trade.opportunityScore || 0),
            smartConfidence: Number(trade.confidence || 0),
            quality: trade.quality || "REJECT",
            noiseRatio: Number(trade.noiseRatio || 0),
            scoreBucket: scoreBucket(trade.opportunityScore),
            noiseBucket: noiseBucket(trade.noiseRatio),
            result: status === "WON" ? "WON" : "LOST",
            profit: profitOf(match),
          });
        }

        return {
          ...trade,
          status,
          learned: trade.learned || closed,
          profit: profitOf(match),
          currentSpot: Number(
            match?.current_spot ??
              match?.current_spot_display_value ??
              0
          ),
          entrySpot: Number(
            match?.entry_spot ??
              match?.entry_tick ??
              0
          ),
          exitSpot: Number(
            match?.exit_tick ??
              match?.exit_spot ??
              0
          ),
        };
      })
    );

    if (learningRecords.length) {
      setLearningHistory((current) => {
        const next = [
          ...learningRecords,
          ...current.filter(
            (item) =>
              !learningRecords.some(
                (record) => record.id === item.id
              )
          ),
        ].slice(0, MAX_LEARNING_RECORDS);

        try {
          window.localStorage.setItem(
            LEARNING_STORAGE_KEY,
            JSON.stringify(next)
          );
        } catch {
          // Browser storage unavailable: keep session memory only.
        }

        return next;
      });
    }

    const closedSessionContracts = contracts.filter((contract) => {
      const id = contractIdOf(contract);

      return (
        id &&
        sessionTrades.some(
          (trade) => String(trade.contractId || "") === id
        ) &&
        ["WON", "LOST", "SOLD", "EXPIRED"].includes(
          contractStatus(contract)
        )
      );
    });

    const latestClosed = closedSessionContracts[0];

    if (latestClosed) {
      const latestId = contractIdOf(latestClosed);
      const latestStatus = contractStatus(latestClosed);
      const latestTrade = sessionTrades.find(
        (trade) => String(trade.contractId || "") === latestId
      );

      if (latestTrade && !latestTrade.lossStreakProcessed) {
        setSessionTrades((current) =>
          current.map((trade) =>
            String(trade.contractId || "") === latestId
              ? { ...trade, lossStreakProcessed: true }
              : trade
          )
        );

        lastExecutedSignalRef.current = "";
        waitStartedAtRef.current = Date.now();

        const resultSoundKey = `${latestId}:${latestStatus}`;
        if (lastResultSoundRef.current !== resultSoundKey) {
          lastResultSoundRef.current = resultSoundKey;
          playResultFeedback(latestStatus);
        }

        if (latestStatus === "WON") {
          consecutiveLossesRef.current = 0;
          setConsecutiveLosses(0);
          nextAutoEntryAtRef.current = Date.now() + 1500;

          if (burstRunsRef.current >= 5) {
            burstRunsRef.current = 0;
            setBurstRuns(0);
            burstDirectionRef.current = "WAIT";
            waitStartedAtRef.current = 0;
          }
        } else if (latestStatus === "LOST") {
          burstRunsRef.current = 0;
          setBurstRuns(0);
          burstDirectionRef.current = "WAIT";
          nextAutoEntryAtRef.current = Date.now() + 8000;
          waitStartedAtRef.current = 0;
          const nextLosses = consecutiveLossesRef.current + 1;
          consecutiveLossesRef.current = nextLosses;
          setConsecutiveLosses(nextLosses);

          if (nextLosses >= 3 && autoRunningRef.current) {
            stopAuto(
              `Hard stop: ${nextLosses} consecutive losses. Press RESET TRANSACTIONS before starting again.`
            );
          }
        }
      }
    }
  }, [
    openContracts,
    symbol,
    durationMode,
    sessionTrades,
  ]);

  return (
    <div className="appShell rfMobileReady">
      <Sidebar />

      <main className="mainContent rfPage">
        <Topbar
          title="EdgePilot V81 · Compact Mobile Trader"
          subtitle="Compact phone controls, account visibility, result sound/vibration and adaptive execution"
          connected={connected}
          connecting={false}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="rfToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={loadingMarket}
            onChange={changeSymbol}
          />

          <div className="rfCompactAccount">
            <span>{String(selectedAccountType).toUpperCase()}</span>
            <strong>
              {selectedAccountId
                ? String(selectedAccountId).slice(-8)
                : connected
                  ? "CONNECTED"
                  : "LOG IN"}
            </strong>
          </div>

          <div className="rfToolbarActions">
            <button
              type="button"
              className={`rfSideStartButton ${
                autoRunning ? "running" : "stopped"
              }`}
              disabled={tradeBusy}
              onClick={toggleAutoExecution}
            >
              {tradeBusy
                ? "SENDING..."
                : autoRunning
                  ? "■ STOP"
                  : "▶ START"}
            </button>

            <button
              type="button"
              className={`rfSoundToggle ${soundEnabled ? "on" : "off"}`}
              onClick={() => setSoundEnabled((value) => !value)}
            >
              {soundEnabled ? "🔊 SOUND" : "🔇 MUTED"}
            </button>

            <select
              className="rfDurationSelect"
              value={durationMode}
              disabled={autoRunning}
              onChange={(event) => setDurationMode(event.target.value)}
            >
              <option value="AUTO">AUTO · 2T / 5T / 10S / 15S</option>
              <option value="2T">2 TICKS · STRONG ONLY</option>
              <option value="10T">10 TICKS</option>
              <option value="15S">15 SECONDS</option>
            </select>

            <div className="rfModeSwitch">
            <button
              type="button"
              className={
                mode === "15s" ? "active" : ""
              }
              onClick={() => setMode("15s")}
            >
              15 SECONDS
            </button>

            <button
              type="button"
              className={
                mode === "10ticks" ? "active" : ""
              }
              onClick={() => setMode("10ticks")}
            >
              10 TICKS
            </button>
            </div>
          </div>
        </section>

        <div
          className={`rfFeed ${
            connected ? "live" : "waiting"
          }`}
        >
          {connected
            ? `LIVE FEED · ${
                market?.label || symbol
              }`
            : feedMessage}
        </div>


        <section className={`rfAutoPanel ${autoRunning ? "running" : "stopped"}`}>
          <div className="rfAutoPanelHead">
            <div>
              <small>RISE/FALL AUTO EXECUTION</small>
              <h2>{autoRunning ? "RUNNING" : "STOPPED"}</h2>
              <p>{executionMessage || tradeError}</p>
            </div>

            <div className="rfAutoPanelButtons">
              <button
                type="button"
                className="reset"
                onClick={resetTransactions}
              >
                RESET TRANSACTIONS
              </button>

              <button
                type="button"
                className={autoRunning ? "stop" : "start"}
                disabled={tradeBusy}
                onClick={toggleAutoExecution}
              >
                {tradeBusy
                  ? "SENDING..."
                  : autoRunning
                    ? "STOP"
                    : "START"}
              </button>
            </div>
          </div>

          <div className="rfAutoControls">
            <label>
              <span>Stake</span>
              <input
                type="number"
                min="0.35"
                step="0.01"
                value={stake}
                disabled={autoRunning}
                onChange={(event) => setStake(event.target.value)}
              />
            </label>

            <label>
              <span>Session run target</span>
              <input
                type="number"
                min="1"
                max="100"
                value={sessionRunTarget}
                disabled={autoRunning}
                onChange={(event) =>
                  setSessionRunTarget(
                    Math.max(1, Math.min(100, Number(event.target.value) || 100))
                  )
                }
              />
            </label>

            <div>
              <span>Auto market</span>
              <strong>
                {autoSwitchMarket
                  ? `ON · ${switchAfterSeconds}s`
                  : "OFF"}
              </strong>
            </div>

            <div>
              <span>Contract</span>
              <strong>
                {durationMode === "2T"
                  ? "RISE/FALL · 2 TICKS"
                  : durationMode === "10T"
                    ? "RISE/FALL · 10 TICKS"
                    : durationMode === "15S"
                      ? "RISE/FALL · 15 SECONDS"
                      : "RISE/FALL · AUTO"}
              </strong>
            </div>

            <div>
              <span>Session runs</span>
              <strong>{executionRuns}/{sessionRunTarget}</strong>
            </div>

            <label>
              <span>Fast-entry minimum score</span>
              <input
                type="number"
                min="70"
                max="100"
                value={oneTickMinimumScore}
                disabled={autoRunning || !allowOneTick}
                onChange={(event) =>
                  setOneTickMinimumScore(event.target.value)
                }
              />
            </label>

            <label>
              <span>Fast-entry minimum confidence</span>
              <input
                type="number"
                min="55"
                max="100"
                value={oneTickMinimumConfidence}
                disabled={autoRunning || !allowOneTick}
                onChange={(event) =>
                  setOneTickMinimumConfidence(event.target.value)
                }
              />
            </label>
          </div>

          <div className="rfAutoChecks">
            <label>
              <input
                type="checkbox"
                checked={burstMode}
                disabled={autoRunning}
                onChange={(event) => setBurstMode(event.target.checked)}
              />
              Strong-signal burst mode · maximum 5 trades before a fresh reset
            </label>

            <label>
              <input
                type="checkbox"
                checked={allowOneTick}
                disabled={autoRunning}
                onChange={(event) => setAllowOneTick(event.target.checked)}
              />
              Auto 1-tick disabled · manual digit contracts remain 1 tick
            </label>

            <label>
              <input
                type="checkbox"
                checked={autoSwitchMarket}
                onChange={(event) => setAutoSwitchMarket(event.target.checked)}
              />
              Change volatility automatically when entry stays blocked
            </label>

            <label>
              Switch after
              <input
                className="rfInlineNumber"
                type="number"
                min="4"
                max="60"
                value={switchAfterSeconds}
                onChange={(event) => setSwitchAfterSeconds(event.target.value)}
              />
              seconds
            </label>

            <span>
              Loss streak: <strong>{consecutiveLosses}/3</strong>
            </span>

            <span>
              Market switches: <strong>{marketSwitches}</strong>
            </span>

            <span>
              Burst chain: <strong>{burstRuns}</strong>
            </span>

            <span>
              Direction probability: <strong>{pct(activeDirectionProbability)}</strong>
            </span>

            <label className={selectedAccountType === "demo" ? "disabled" : ""}>
              <input
                type="checkbox"
                checked={allowReal}
                disabled={selectedAccountType === "demo" || autoRunning}
                onChange={(event) => setAllowReal(event.target.checked)}
              />
              I understand and enable Real-account execution
            </label>

            <span>
              Account: <strong>{String(selectedAccountType).toUpperCase()}</strong>
            </span>
          </div>
        </section>

        <section
          className={`rfEntryBanner ${signalClass(active.signal)}`}
        >
          <div>
            <small>VISIBLE ENTRY ALERT</small>
            <strong>
              {active.decision || "NO TRADE"}
            </strong>
            <span>{active.reason}</span>
          </div>

          <div className="rfEntryBannerStats">
            <span>
              <small>Grade</small>
              <strong>{active.setupGrade || "WAIT"}</strong>
            </span>

            <span>
              <small>Confirmations</small>
              <strong>
                {active.confirmationsPassed || 0}/
                {active.confirmationChecks?.length || 8}
              </strong>
            </span>

            <span>
              <small>Direction probability</small>
              <strong>
                {active.rawDirection === "RISE"
                  ? pct(active.probabilityRise)
                  : active.rawDirection === "FALL"
                    ? pct(active.probabilityFall)
                    : "—"}
              </strong>
            </span>

            <span>
              <small>Duration</small>
              <strong>{active.duration}</strong>
            </span>
          </div>
        </section>

        <section className="rfFastDecisionRow">
          <article className={active.tradeNow ? "active trade" : ""}>
            <small>TRADE NOW</small>
            <strong>
              {active.tradeNow ? active.signal : "NO"}
            </strong>
            <span>
              {active.tradeNow
                ? `${pct(active.confidence)} confidence`
                : "Waiting for final alignment"}
            </span>
          </article>

          <article className={active.prepare ? "active prepare" : ""}>
            <small>PREPARE</small>
            <strong>
              {active.prepare
                ? active.rawDirection
                : "NO"}
            </strong>
            <span>
              {active.prepare
                ? "Signal is forming"
                : "No early setup"}
            </span>
          </article>

          <article className={!active.tradeNow && !active.prepare ? "active wait" : ""}>
            <small>NO TRADE</small>
            <strong>
              {!active.tradeNow && !active.prepare
                ? "WAIT"
                : "—"}
            </strong>
            <span>
              {!active.tradeNow && !active.prepare
                ? active.reason
                : "A directional setup exists"}
            </span>
          </article>
        </section>

        <section
          className={`rfHero ${signalClass(
            active.signal
          )}`}
        >
          <div className="rfHeroDecision">
            <small>
              ACTIVE{" "}
              {mode === "15s"
                ? "15-SECOND"
                : "10-TICK"}{" "}
              SIGNAL
            </small>

            <h1>{active.signal}</h1>
            <p>{active.reason}</p>

            <div className="rfDecisionChips">
              <span>{active.regime}</span>
              <span>{active.duration}</span>
              <span>{active.risk} RISK</span>
              <span>{active.breakout}</span>
              <span>{active.pullback}</span>
            </div>
          </div>

          <div className="rfProbabilityBlock">
            <div className="rfProbability rise">
              <small>RISE PROBABILITY</small>
              <strong>
                {pct(active.probabilityRise)}
              </strong>
              <i>
                <b
                  style={{
                    width: `${active.probabilityRise}%`,
                  }}
                />
              </i>
            </div>

            <div className="rfProbability fall">
              <small>FALL PROBABILITY</small>
              <strong>
                {pct(active.probabilityFall)}
              </strong>
              <i>
                <b
                  style={{
                    width: `${active.probabilityFall}%`,
                  }}
                />
              </i>
            </div>
          </div>

          <div className="rfHeroStats">
            <div>
              <small>Confidence</small>
              <strong>
                {pct(active.confidence)}
              </strong>
            </div>

            <div>
              <small>Votes</small>
              <strong>
                {active.riseVotes}/
                {active.fallVotes}
              </strong>
            </div>

            <div>
              <small>Samples</small>
              <strong>{active.samples || 0}</strong>
            </div>

            <div>
              <small>Price</small>
              <strong>{num(currentPrice)}</strong>
            </div>
          </div>
        </section>

        <section className="rfModeCards">
          <ModeSummary
            label="15 SECONDS"
            analysis={analysis15}
            active={mode === "15s"}
            onClick={() => setMode("15s")}
          />

          <ModeSummary
            label="10 TICKS"
            analysis={analysis10}
            active={mode === "10ticks"}
            onClick={() => setMode("10ticks")}
          />

          <article
            className={`rfConsensus ${signalClass(
              consensus
            )}`}
          >
            <small>CONSENSUS</small>
            <strong>{consensus}</strong>
            <span>{pct(consensusConfidence)}</span>
            <em>
              {consensus === "WAIT"
                ? "MIXED WINDOWS"
                : "BOTH WINDOWS ALIGNED"}
            </em>
          </article>
        </section>

        <section className="rfSyntheticScanner">
          <div className="rfPanelHead">
            <div>
              <small>SYNTHETIC INDEX INTELLIGENCE</small>
              <h2>90%+ volatility and synthetic setups</h2>
            </div>
            <strong>{strongSyntheticMarkets.length} qualified</strong>
          </div>

          <div className="rfSyntheticRows">
            {strongSyntheticMarkets.length ? (
              strongSyntheticMarkets.map((item) => (
                <button
                  type="button"
                  key={item.symbol}
                  onClick={() => changeSymbol(item.symbol)}
                >
                  <span>
                    <small>{item.label}</small>
                    <strong>{item.signal}</strong>
                  </span>
                  <span>
                    <small>Score</small>
                    <strong>{Number(item.score).toFixed(1)}%</strong>
                  </span>
                  <span>
                    <small>Confidence</small>
                    <strong>{Number(item.confidence).toFixed(1)}%</strong>
                  </span>
                  <span>
                    <small>State</small>
                    <strong>{item.regime}</strong>
                  </span>
                </button>
              ))
            ) : (
              <p>
                No cached market is above 90% yet. Auto-switch will keep
                scanning and save every visited synthetic index.
              </p>
            )}
          </div>
        </section>

        <section className="rfCandleSection">
          <div className="rfPanelHead">
            <div>
              <small>TRADINGVIEW-STYLE CANDLESTICK CHART</small>
              <h2>Professional market price action</h2>
            </div>

            <div className="rfCandleModes">
              {["10S", "15S", "30S", "1M", "5M", "5T", "10T", "20T"].map((item) => (
                <button
                  type="button"
                  key={item}
                  className={candleMode === item ? "active" : ""}
                  onClick={() => setCandleMode(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <CandleChart
            candles={candles}
            signal={active.signal}
            probabilityRise={active.probabilityRise}
            probabilityFall={active.probabilityFall}
            structure={candleMarketStructure}
          />

          <div className="rfCandleMetrics">
            <span>
              <small>Last candle</small>
              <strong>{candleSignal(candles.at(-1))}</strong>
            </span>
            <span>
              <small>Stored ticks</small>
              <strong>{combinedPriceHistory.length}</strong>
            </span>
            <span>
              <small>Chart survives refresh</small>
              <strong>YES</strong>
            </span>
            <span>
              <small>Current synthetic score</small>
              <strong>{pct(syntheticScore)}</strong>
            </span>
          </div>

          <div className="rfStructureGrid">
            <article>
              <small>SUPPORT</small>
              <strong>{num(candleMarketStructure.support, 6)}</strong>
              <span>Calculated from closed candles only.</span>
            </article>
            <article>
              <small>RESISTANCE</small>
              <strong>{num(candleMarketStructure.resistance, 6)}</strong>
              <span>Calculated from closed candles only.</span>
            </article>
            <article>
              <small>BREAKOUT</small>
              <strong>{candleMarketStructure.breakout}</strong>
              <span>{pct(candleMarketStructure.breakoutStrength)} strength</span>
            </article>
            <article>
              <small>CLOSED TREND</small>
              <strong>{candleMarketStructure.trend}</strong>
              <span>{candleMarketStructure.closedCount} frozen candles.</span>
            </article>
          </div>

          <div className={`rfPreBuyChecklist ${preBuyStructure.ready ? "ready" : ""}`}>
            <div className="rfPanelHead">
              <div>
                <small>PRE-BUY MARKET STRUCTURE</small>
                <h2>
                  {preBuyStructure.ready
                    ? `READY TO BUY ${active.signal}`
                    : "WAIT FOR STRUCTURE"}
                </h2>
              </div>
              <strong>{preBuyStructure.passed}/{preBuyStructure.total}</strong>
            </div>

            <div>
              {preBuyStructure.items.map((item) => (
                <span
                  key={item.label}
                  className={item.passed ? "passed" : "failed"}
                >
                  <b>{item.passed ? "✓" : "×"} {item.label}</b>
                  <strong>{item.value}</strong>
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="rfGrid">
          <article className="rfPanel rfChartPanel">
            <div className="rfPanelHead">
              <div>
                <small>PRICE ACTION</small>
                <h2>
                  {mode === "15s"
                    ? "Last 15 seconds"
                    : "Last 10 ticks"}
                </h2>
              </div>

              <span>
                {active.rawDirection || "WAIT"}
              </span>
            </div>

            <MiniChart
              points={
                active.points?.length
                  ? active.points
                  : combinedPriceHistory
              }
              signal={active.signal}
            />
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>INDICATOR STACK</small>
                <h2>Directional confirmation</h2>
              </div>
            </div>

            <div className="rfIndicatorStack">
              <div>
                <span>EMA 5</span>
                <strong>
                  {num(
                    active.indicators?.emaFast,
                    6
                  )}
                </strong>
              </div>

              <div>
                <span>EMA 9</span>
                <strong>
                  {num(
                    active.indicators?.emaSlow,
                    6
                  )}
                </strong>
              </div>

              <div>
                <span>RSI 9</span>
                <strong>
                  {Number(
                    active.indicators?.rsi || 0
                  ).toFixed(1)}
                </strong>
              </div>

              <div>
                <span>MACD</span>
                <strong>
                  {num(
                    active.indicators?.macd
                      ?.histogram,
                    7
                  )}
                </strong>
              </div>

              <div>
                <span>ATR</span>
                <strong>
                  {num(
                    active.indicators?.atr,
                    7
                  )}
                </strong>
              </div>

              <div>
                <span>Stochastic</span>
                <strong>
                  {Number(
                    active.indicators?.stochastic || 0
                  ).toFixed(1)}
                </strong>
              </div>

              <div>
                <span>ROC</span>
                <strong>
                  {num(active.indicators?.roc, 5)}
                </strong>
              </div>

              <div>
                <span>Z-score</span>
                <strong>
                  {num(active.indicators?.zScore, 3)}
                </strong>
              </div>

              <div>
                <span>Streak</span>
                <strong>
                  {active.streak?.direction || "FLAT"}{" "}
                  {active.streak?.length || 0}
                </strong>
              </div>

              <div>
                <span>Regime</span>
                <strong>{active.regime}</strong>
              </div>
            </div>
          </article>
        </section>

        <section className="rfMetrics">
          <MetricCard
            label="Net move"
            value={num(active.netMove, 6)}
            note="Difference between first and latest price."
          />

          <MetricCard
            label="Linear slope"
            value={num(active.slope, 7)}
            note="Overall direction of the selected window."
          />

          <MetricCard
            label="Consistency"
            value={pct(active.consistency)}
            note="Share of moves agreeing with one direction."
          />

          <MetricCard
            label="Volatility"
            value={num(active.volatility, 7)}
            note="Noise across the fresh price changes."
          />

          <MetricCard
            label="Reversals"
            value={active.reversalCount || 0}
            note="Direction changes reducing signal quality."
          />

          <MetricCard
            label="Decision"
            value={active.decision || "NO TRADE"}
            note="Fast decision updates on every fresh tick."
            tone={active.tradeNow ? "ready" : ""}
          />

          <MetricCard
            label="Support"
            value={num(
              active.supportResistance?.support,
              6
            )}
            note="Lowest recent price in the analysis window."
          />

          <MetricCard
            label="Resistance"
            value={num(
              active.supportResistance
                ?.resistance,
              6
            )}
            note="Highest recent price in the analysis window."
          />
        </section>

        <section className="rfGrid">
          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>MULTI-WINDOW MOMENTUM</small>
                <h2>Fast, medium and slow</h2>
              </div>
            </div>

            <div className="rfMomentum">
              <div>
                <span>Fast 3</span>
                <strong>
                  {num(
                    active.momentum?.fast,
                    6
                  )}
                </strong>
                <i
                  className={
                    Number(
                      active.momentum?.fast
                    ) >= 0
                      ? "up"
                      : "down"
                  }
                />
              </div>

              <div>
                <span>Medium 5</span>
                <strong>
                  {num(
                    active.momentum?.medium,
                    6
                  )}
                </strong>
                <i
                  className={
                    Number(
                      active.momentum?.medium
                    ) >= 0
                      ? "up"
                      : "down"
                  }
                />
              </div>

              <div>
                <span>Slow 10</span>
                <strong>
                  {num(
                    active.momentum?.slow,
                    6
                  )}
                </strong>
                <i
                  className={
                    Number(
                      active.momentum?.slow
                    ) >= 0
                      ? "up"
                      : "down"
                  }
                />
              </div>
            </div>

            <div className="rfVotes">
              <span>
                RISE votes{" "}
                <strong>
                  {active.riseVotes || 0}/
                  {active.totalVotes || 8}
                </strong>
              </span>

              <span>
                FALL votes{" "}
                <strong>
                  {active.fallVotes || 0}/
                  {active.totalVotes || 8}
                </strong>
              </span>
            </div>
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>ENTRY CONDITIONS</small>
                <h2>What the engine sees</h2>
              </div>
            </div>

            <div className="rfConditionList">
              <div>
                <span>EMA direction</span>
                <strong>
                  {Number(
                    active.indicators?.emaFast
                  ) >
                  Number(
                    active.indicators?.emaSlow
                  )
                    ? "BULLISH"
                    : Number(
                          active.indicators
                            ?.emaFast
                        ) <
                        Number(
                          active.indicators
                            ?.emaSlow
                        )
                      ? "BEARISH"
                      : "FLAT"}
                </strong>
              </div>

              <div>
                <span>RSI state</span>
                <strong>
                  {Number(
                    active.indicators?.rsi
                  ) >= 55
                    ? "BULLISH"
                    : Number(
                          active.indicators
                            ?.rsi
                        ) <= 45
                      ? "BEARISH"
                      : "NEUTRAL"}
                </strong>
              </div>

              <div>
                <span>MACD state</span>
                <strong>
                  {Number(
                    active.indicators?.macd
                      ?.histogram
                  ) > 0
                    ? "POSITIVE"
                    : Number(
                          active.indicators
                            ?.macd?.histogram
                        ) < 0
                      ? "NEGATIVE"
                      : "FLAT"}
                </strong>
              </div>

              <div>
                <span>Breakout</span>
                <strong>{active.breakout}</strong>
              </div>

              <div>
                <span>Pullback</span>
                <strong>{active.pullback}</strong>
              </div>

              <div>
                <span>Recommended duration</span>
                <strong>{active.duration}</strong>
              </div>
            </div>
          </article>
        </section>

        <section className="rfLearningPanel">
          <article>
            <small>LEARNING MEMORY</small>
            <strong>{learningProfile.totalSamples}</strong>
            <span>Saved outcomes for {symbol || "current market"}.</span>
          </article>

          <article>
            <small>HISTORICAL WIN RATE</small>
            <strong>{pct(learningProfile.totalRate)}</strong>
            <span>
              Direction {pct(learningProfile.directionRate)} from{" "}
              {learningProfile.directionSamples} samples.
            </span>
          </article>

          <article>
            <small>LEARNED BUY LEVEL</small>
            <strong>
              {Number(learningProfile.learnedBuyThreshold).toFixed(0)}
            </strong>
            <span>
              Base {Number(active.adaptiveThresholds?.buy || 72).toFixed(0)}
              {" · "}
              Adjustment {learningProfile.thresholdAdjustment >= 0 ? "+" : ""}
              {learningProfile.thresholdAdjustment}
            </span>
          </article>

          <article>
            <small>LEARNING FILTER</small>
            <strong>
              {consecutiveLosses >= 3
                ? "HARD STOP"
                : learningProfile.setupRejected
                  ? "REJECT SETUP"
                  : learnedEntryAllowed
                    ? "ENTRY ALLOWED"
                    : "WAIT"}
            </strong>
            <span>
              Setup {pct(learningProfile.winRate)} from{" "}
              {learningProfile.sampleCount} relevant samples.
            </span>
          </article>
        </section>

        <section className="rfConsensusHero">
          <div>
            <small>AI CONSENSUS ENGINE</small>
            <h2>{active.aiDecision || "WAIT"}</h2>
            <p>
              {active.autoSkip
                ? active.skipReason || "Searching for a cleaner setup."
                : `${active.consensus?.riseVotes || 0} RISE · ${active.consensus?.fallVotes || 0} FALL · ${active.consensus?.waitVotes || 0} WAIT`}
            </p>
          </div>

          <div className="rfConsensusStats">
            <span>
              <small>Opportunity</small>
              <strong>{pct(active.opportunityScore)}</strong>
            </span>
            <span>
              <small>Consensus</small>
              <strong>
                {active.consensus?.riseVotes || 0}/{active.consensus?.total || 12} R ·{" "}
                {active.consensus?.fallVotes || 0}/{active.consensus?.total || 12} F
              </strong>
            </span>
            <span>
              <small>Quality</small>
              <strong>{active.quality || "REJECT"}</strong>
            </span>
            <span>
              <small>Entry window</small>
              <strong>{active.entryWindow?.label || "WAIT"}</strong>
            </span>
          </div>
        </section>

        <section className="rfProfessionalSummary">
          <article>
            <small>SMART CONFIDENCE</small>
            <strong>{pct(active.smartConfidence)}</strong>
            <span>Built from weighted trend, pressure, momentum and order flow.</span>
          </article>

          <article>
            <small>AI ENTRY SCORE</small>
            <strong>{pct(active.entryScore)}</strong>
            <span>{active.aiDecision || "WAIT"}</span>
          </article>

          <article>
            <small>DYNAMIC BUY LEVEL</small>
            <strong>
              {Number(active.adaptiveThresholds?.buy || 72).toFixed(0)}
            </strong>
            <span>
              {active.regime || "UNKNOWN"} regime · {pct(active.noiseRatio)} noise
            </span>
          </article>

          <article>
            <small>RISK</small>
            <strong>{active.risk || "HIGH"}</strong>
            <span>
              Instant level {Number(active.adaptiveThresholds?.instant || 88).toFixed(0)}
            </span>
          </article>
        </section>

        <section className="rfQuantumMetrics">
          <article>
            <small>ADAPTIVE CONFIDENCE</small>
            <strong>{pct(active.smartConfidence)}</strong>
            <span>Trend, momentum, pressure, EMA, order flow and rhythm.</span>
          </article>

          <article>
            <small>FRESH TICK COMPOSITE</small>
            <strong>
              {active.freshTick?.passed || 0}/{active.freshTick?.total || 5}
            </strong>
            <span>
              {active.freshTick?.ready ? "READY" : "FORMING"} · {pct(active.freshTick?.score)}
            </span>
          </article>

          <article>
            <small>LIQUIDITY QUALITY</small>
            <strong>{pct(active.liquidityQualityScore)}</strong>
            <span>Liquidity sweep and level reaction strength.</span>
          </article>

          <article>
            <small>SMART 1-TICK</small>
            <strong>{active.instantOneTick ? "READY" : "WAIT"}</strong>
            <span>
              Requires fresh-tick composite, consensus, rhythm and persistence.
            </span>
          </article>
        </section>

        <section className="rfConsensusBoard">
          <div className="rfPanelHead">
            <div>
              <small>ANALYSIS VOTES</small>
              <h2>Consensus by engine</h2>
            </div>
            <span>
              {pct(active.consensus?.score)}
            </span>
          </div>

          <div className="rfVoteGrid">
            {(active.consensus?.votes || []).map((item) => (
              <article
                key={item.name}
                className={String(item.vote || "WAIT").toLowerCase()}
              >
                <small>{item.name}</small>
                <strong>{item.vote || "WAIT"}</strong>
              </article>
            ))}
          </div>
        </section>

        <section className="rfNextTickPanel">
          <div>
            <small>NEXT 5 TICKS</small>
            <h2>
              {(active.nextTicks?.ticks || []).map((tick, index) => (
                <span
                  key={`${tick}-${index}`}
                  className={String(tick).toLowerCase()}
                >
                  {tick === "RISE" ? "↑" : tick === "FALL" ? "↓" : "—"}
                </span>
              ))}
            </h2>
          </div>

          <div>
            <small>PREDICTION CONFIDENCE</small>
            <strong>{pct(active.nextTicks?.confidence)}</strong>
          </div>

          <div>
            <small>MARKET REGIME</small>
            <strong>{active.regime || "UNKNOWN"}</strong>
          </div>

          <div>
            <small>TRADE STRENGTH</small>
            <strong>
              {active.quality === "A+"
                ? "EXTREME"
                : active.quality === "A"
                  ? "STRONG"
                  : active.quality === "B"
                    ? "MEDIUM"
                    : active.quality === "C"
                      ? "WEAK"
                      : "REJECT"}
            </strong>
          </div>
        </section>

        <section className="rfAiEntryTerminal">
          <div className="rfPanelHead">
            <div>
              <small>AI ENTRY ENGINE</small>
              <h2>
                {active.aiDecision || "WAIT"}
              </h2>
            </div>

            <span
              className={
                active.instantOneTick
                  ? "instant"
                  : active.strongTrade
                    ? "strong"
                    : active.fastScalpReady
                      ? "ready"
                      : "wait"
              }
            >
              {pct(active.entryScore)}
            </span>
          </div>

          <div className="rfAiEntryGrid">
            {[
              ["Micro trend", active.weightedScores?.microTrend],
              ["Pressure", active.weightedScores?.pressure],
              ["Momentum", active.weightedScores?.momentum],
              ["EMA", active.weightedScores?.ema],
              ["Continuation", active.weightedScores?.continuation],
              ["Direction stability", active.weightedScores?.stability],
              ["Order flow", active.weightedScores?.orderFlow],
              ["EMA ribbon", active.weightedScores?.ribbon],
              ["Candle sequence", active.weightedScores?.sequence],
              ["Pullback quality", active.weightedScores?.pullback],
              ["Tick rhythm", active.weightedScores?.rhythm],
              ["Noise safety", active.weightedScores?.noise],
              ["Base entry score", active.baseEntryScore],
              ["Impulse booster", active.weightedScores?.impulseBoost],
              ["Acceleration booster", active.weightedScores?.accelerationBoost],
              ["Smart confidence", active.smartConfidence],
              ["AI final score", active.entryScore],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{Number(value || 0).toFixed(0)}</strong>
                <i>
                  <b
                    style={{
                      width: `${Math.max(
                        0,
                        Math.min(100, Number(value || 0))
                      )}%`,
                    }}
                  />
                </i>
              </div>
            ))}
          </div>

          <div className="rfEntryThresholds">
            <span
              className={
                active.entryScore >=
                Number(active.adaptiveThresholds?.prepare || 65)
                  ? "passed"
                  : ""
              }
            >
              {Number(active.adaptiveThresholds?.prepare || 65).toFixed(0)}+ PREPARE
            </span>

            <span
              className={
                active.entryScore >=
                Number(active.adaptiveThresholds?.buy || 72)
                  ? "passed"
                  : ""
              }
            >
              {Number(active.adaptiveThresholds?.buy || 72).toFixed(0)}+ AUTO BUY
            </span>

            <span
              className={
                active.entryScore >=
                Number(active.adaptiveThresholds?.strong || 80)
                  ? "passed"
                  : ""
              }
            >
              {Number(active.adaptiveThresholds?.strong || 80).toFixed(0)}+ STRONG BUY
            </span>

            <span
              className={
                active.entryScore >=
                Number(active.adaptiveThresholds?.instant || 88)
                  ? "passed instant"
                  : ""
              }
            >
              {Number(active.adaptiveThresholds?.instant || 88).toFixed(0)}+ INSTANT 1 TICK
            </span>
          </div>

          <div className="rfMicroVotes">
            {(active.microTrend?.windows || []).map((item) => (
              <span
                key={item.size}
                className={String(item.direction).toLowerCase()}
              >
                {item.size} {item.direction === "RISE" ? "↑" : item.direction === "FALL" ? "↓" : "—"}
              </span>
            ))}
          </div>

          <div className="rfAiTelemetry">
            <span>
              Velocity <strong>{num(active.velocity, 6)}</strong>
            </span>
            <span>
              Acceleration <strong>{num(active.acceleration, 6)}</strong>
            </span>
            <span>
              Compression <strong>{pct(active.compression)}</strong>
            </span>
            <span>
              Expansion <strong>{pct(active.expansion)}</strong>
            </span>
            <span>
              Exhaustion <strong>{pct(active.exhaustion)}</strong>
            </span>
          </div>
        </section>

        <section className="rfMicroGrid">
          <article>
            <small>FAST SCALP STATUS</small>
            <strong>
              {active.fastScalpReady
                ? "1-TICK READY"
                : active.entryScore >= 70
                  ? "PREPARE"
                  : "WAIT"}
            </strong>
            <span>
              Entry uses the weighted score. Impulse and acceleration only add bonus points.
            </span>
          </article>

          <article>
            <small>TICK IMPULSE</small>
            <strong>
              {active.impulse?.direction || "FLAT"}{" "}
              {pct(active.impulse?.score)}
            </strong>
            <span>
              Acceleration {num(active.impulse?.acceleration, 6)}
            </span>
          </article>

          <article>
            <small>PERSISTENCE</small>
            <strong>{pct(active.persistence)}</strong>
            <span>Recent ticks moving consistently.</span>
          </article>

          <article>
            <small>NOISE RATIO</small>
            <strong>{pct(active.noiseRatio)}</strong>
            <span>Lower is cleaner for fast entry.</span>
          </article>
        </section>

        <section className="rfGrid">
          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>ENTRY CONFIRMATIONS</small>
                <h2>Buy/Wait checklist</h2>
              </div>
              <span>
                {active.confirmationsPassed || 0}/
                {active.confirmationChecks?.length || 8}
              </span>
            </div>

            <div className="rfConfirmationList">
              {(active.confirmationChecks || []).map((check) => (
                <div
                  key={check.id}
                  className={check.passed ? "passed" : "failed"}
                >
                  <span>
                    {check.passed ? "✓" : "×"} {check.label}
                  </span>
                  <strong>{check.detail}</strong>
                </div>
              ))}
            </div>
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>SESSION SIGNAL LOG</small>
                <h2>Recent visible/audio alerts</h2>
              </div>
              <button
                type="button"
                className="rfClearLog"
                onClick={() => setSignalLog([])}
              >
                Clear
              </button>
            </div>

            <div className="rfSignalLog">
              {signalLog.map((item) => (
                <div key={item.id} className={signalClass(item.signal)}>
                  <span>
                    {new Date(item.time).toLocaleTimeString()}
                  </span>
                  <strong>BUY {item.signal}</strong>
                  <em>{item.mode === "15s" ? "15 SEC" : "10 TICKS"}</em>
                  <b>{pct(item.confidence)}</b>
                  <small>Grade {item.grade}</small>
                </div>
              ))}

              {!signalLog.length ? (
                <p>No confirmed signal alerts in this session.</p>
              ) : null}
            </div>
          </article>
        </section>


        <section className="rfDeepAnalysisGrid">
          <article>
            <small>ORDER FLOW DELTA</small>
            <strong>
              {Number(active.flowDelta?.delta || 0).toFixed(1)}
            </strong>
            <span>
              Buy {pct(active.flowDelta?.buy)} · Sell {pct(active.flowDelta?.sell)}
            </span>
          </article>

          <article>
            <small>DIRECTION STABILITY</small>
            <strong>{pct(active.stability)}</strong>
            <span>Agreement across short, medium and long windows.</span>
          </article>

          <article>
            <small>EMA RIBBON</small>
            <strong>{active.ribbon?.state || "MIXED"}</strong>
            <span>
              3 / 5 / 8 / 13 EMA structure.
            </span>
          </article>

          <article>
            <small>CANDLE SEQUENCE</small>
            <strong>
              {active.sequence?.direction || "FLAT"}{" "}
              {pct(active.sequence?.score)}
            </strong>
            <span>Recent directional sequence.</span>
          </article>

          <article>
            <small>PULLBACK QUALITY</small>
            <strong>{pct(active.pullbackScore)}</strong>
            <span>Continuation, pressure and consistency combined.</span>
          </article>

          <article>
            <small>MEAN REVERSION</small>
            <strong>{pct(active.meanReversion)}</strong>
            <span>Higher means stronger snap-back risk.</span>
          </article>

          <article>
            <small>ATR EXPANSION</small>
            <strong>{pct(active.atrExpansion)}</strong>
            <span>Fresh move size versus recent baseline.</span>
          </article>

          <article>
            <small>TICK RHYTHM</small>
            <strong>{pct(active.rhythm)}</strong>
            <span>How consistently consecutive ticks repeat direction.</span>
          </article>
        </section>

        <section className="rfAdvancedTools">
          <article>
            <small>CONSECUTIVE TICK BIAS</small>
            <strong>
              {active.bias?.direction || "FLAT"}{" "}
              {active.bias?.count || 0}
            </strong>
            <span>Score {pct(active.bias?.score)}</span>
          </article>

          <article>
            <small>VOLATILITY STATE</small>
            <strong>{active.squeeze?.state || "NORMAL"}</strong>
            <span>
              Breakout readiness {pct(active.squeeze?.breakoutReadiness)}
            </span>
          </article>

          <article>
            <small>LIQUIDITY SWEEP</small>
            <strong>{active.liquiditySweep?.state || "NONE"}</strong>
            <span>Score {pct(active.liquiditySweep?.score)}</span>
          </article>

          <article>
            <small>MICRO REVERSAL</small>
            <strong>{active.microReversal?.direction || "NONE"}</strong>
            <span>Score {pct(active.microReversal?.score)}</span>
          </article>

          <article>
            <small>SUPPORT REACTION</small>
            <strong>{pct(active.supportReaction)}</strong>
            <span>Recent response from support.</span>
          </article>

          <article>
            <small>RESISTANCE REACTION</small>
            <strong>{pct(active.resistanceReaction)}</strong>
            <span>Recent response from resistance.</span>
          </article>
        </section>

        <section className="rfProGrid">
          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>MARKET PRESSURE</small>
                <h2>Buying vs selling pressure</h2>
              </div>
            </div>

            <div className="rfPressureBars">
              <div className="buy">
                <span>Buying pressure</span>
                <strong>{pct(active.pressure?.buying)}</strong>
                <i>
                  <b
                    style={{
                      width: `${active.pressure?.buying || 0}%`,
                    }}
                  />
                </i>
              </div>

              <div className="sell">
                <span>Selling pressure</span>
                <strong>{pct(active.pressure?.selling)}</strong>
                <i>
                  <b
                    style={{
                      width: `${active.pressure?.selling || 0}%`,
                    }}
                  />
                </i>
              </div>
            </div>

            <div className="rfConditionList">
              <div>
                <span>Trend age</span>
                <strong>
                  {active.trend?.direction || "FLAT"}{" "}
                  {active.trend?.ticks || 0} ticks
                </strong>
              </div>

              <div>
                <span>Continuation probability</span>
                <strong>
                  {pct(active.continuationProbability)}
                </strong>
              </div>

              <div>
                <span>Reversal probability</span>
                <strong>
                  {pct(active.reversalProbability)}
                </strong>
              </div>
            </div>
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>BOLLINGER & BREAKOUT</small>
                <h2>Range and breakout quality</h2>
              </div>
            </div>

            <div className="rfConditionList">
              <div>
                <span>Bollinger position</span>
                <strong>{active.bollinger?.position || "MIDDLE"}</strong>
              </div>

              <div>
                <span>Upper band</span>
                <strong>{num(active.bollinger?.upper, 6)}</strong>
              </div>

              <div>
                <span>Middle band</span>
                <strong>{num(active.bollinger?.middle, 6)}</strong>
              </div>

              <div>
                <span>Lower band</span>
                <strong>{num(active.bollinger?.lower, 6)}</strong>
              </div>

              <div>
                <span>Fake breakout probability</span>
                <strong>{pct(active.breakoutFakeProbability)}</strong>
              </div>
            </div>
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>LEVEL STRENGTH</small>
                <h2>Support and resistance tests</h2>
              </div>
            </div>

            <div className="rfStrengthMeters">
              <div>
                <span>Support strength</span>
                <strong>{pct(active.supportStrength)}</strong>
                <i>
                  <b
                    style={{
                      width: `${active.supportStrength || 0}%`,
                    }}
                  />
                </i>
              </div>

              <div>
                <span>Resistance strength</span>
                <strong>{pct(active.resistanceStrength)}</strong>
                <i>
                  <b
                    style={{
                      width: `${active.resistanceStrength || 0}%`,
                    }}
                  />
                </i>
              </div>
            </div>
          </article>
        </section>

        <section className="rfScoreTerminal">
          <div className="rfPanelHead">
            <div>
              <small>SMART SCORE TERMINAL</small>
              <h2>Final analysis quality</h2>
            </div>

            <span className="rfFinalGrade">
              Grade {active.setupGrade || "WAIT"}
            </span>
          </div>

          <div className="rfScoreGrid">
            {[
              ["Trend", active.scores?.trend],
              ["Pattern", active.scores?.pattern],
              ["Momentum", active.scores?.momentum],
              ["Volatility", active.scores?.volatility],
              ["Quality", active.scores?.quality],
              ["Final score", active.scores?.final],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{Number(value || 0).toFixed(0)}</strong>
                <i>
                  <b
                    style={{
                      width: `${Math.max(0, Math.min(100, Number(value || 0)))}%`,
                    }}
                  />
                </i>
              </div>
            ))}
          </div>
        </section>


        <section className="rfTradeViewer">
          <div className="rfPanelHead">
            <div>
              <small>TRADE VIEWER</small>
              <h2>Open and recent Rise/Fall trades</h2>
            </div>

            <span>
              {sessionTrades.length} session trade
              {sessionTrades.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="rfTradeTableWrap">
            <table className="rfTradeTable">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Contract</th>
                  <th>Duration</th>
                  <th>Stake</th>
                  <th>Status</th>
                  <th>Confidence</th>
                  <th>Score</th>
                  <th>P/L</th>
                  <th>ID</th>
                </tr>
              </thead>

              <tbody>
                {sessionTrades.map((trade) => (
                  <tr key={trade.id}>
                    <td>
                      {new Date(trade.time).toLocaleTimeString()}
                    </td>
                    <td className={signalClass(trade.signal)}>
                      {trade.signal}
                    </td>
                    <td>
                      {trade.displayDuration ||
                        (trade.mode === "15s"
                          ? "15 sec"
                          : "10 ticks")}
                    </td>
                    <td>{Number(trade.stake || 0).toFixed(2)}</td>
                    <td>{trade.status || "OPEN"}</td>
                    <td>{pct(trade.confidence)}</td>
                    <td>{Number(trade.finalScore || 0).toFixed(0)}</td>
                    <td
                      className={
                        Number(trade.profit || 0) > 0
                          ? "profit"
                          : Number(trade.profit || 0) < 0
                            ? "loss"
                            : ""
                      }
                    >
                      {Number(trade.profit || 0).toFixed(2)}
                    </td>
                    <td>{trade.contractId || "—"}</td>
                  </tr>
                ))}

                {!sessionTrades.length ? (
                  <tr>
                    <td colSpan="9" className="empty">
                      Press START. Confirmed trades will appear here.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <details className="rfRawTrades">
            <summary>
              View Deriv open-contract and transaction feed
            </summary>

            <div>
              <article>
                <h3>Open contract feed</h3>
                <pre>
                  {JSON.stringify(
                    (Array.isArray(openContracts) ? openContracts : []).slice(0, 5),
                    null,
                    2
                  )}
                </pre>
              </article>

              <article>
                <h3>Recent transactions</h3>
                <pre>
                  {JSON.stringify(
                    (Array.isArray(transactions) ? transactions : []).slice(0, 10),
                    null,
                    2
                  )}
                </pre>
              </article>
            </div>
          </details>
        </section>


        <button
          type="button"
          className="rfManualLauncher"
          onClick={() => setManualPanelOpen((open) => !open)}
          aria-expanded={manualPanelOpen}
        >
          {manualPanelOpen ? "CLOSE MANUAL" : "MANUAL BUY"}
        </button>

        {manualPanelOpen ? (
          <aside className="rfManualPanel">
            <div className="rfManualHead">
              <div>
                <small>DIRECT EXECUTION</small>
                <h2>Manual Trading</h2>
              </div>

              <button
                type="button"
                onClick={() => setManualPanelOpen(false)}
                aria-label="Close manual trading panel"
              >
                ×
              </button>
            </div>

            <div className="rfManualInputs">
              <label>
                Stake
                <input
                  type="number"
                  min="0.35"
                  step="0.01"
                  value={manualStake}
                  onChange={(event) =>
                    setManualStake(event.target.value)
                  }
                />
              </label>

              <label>
                Rise/Fall duration
                <select
                  value={manualDuration}
                  onChange={(event) =>
                    setManualDuration(event.target.value)
                  }
                >
                  <option value="2T">2 TICKS</option>
                  <option value="5T">5 TICKS</option>
                  <option value="10S">10 SECONDS</option>
                  <option value="15S">15 SECONDS</option>
                </select>
              </label>

              <label>
                Digit barrier
                <select
                  value={manualBarrier}
                  onChange={(event) =>
                    setManualBarrier(Number(event.target.value))
                  }
                >
                  {Array.from({ length: 10 }, (_, digit) => (
                    <option key={digit} value={digit}>
                      {digit}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="rfManualRiseFall">
              <button
                type="button"
                className="rise"
                disabled={tradeBusy || hasOpenSessionTrade}
                onClick={() => placeManualContract("CALL")}
              >
                BUY RISE
              </button>

              <button
                type="button"
                className="fall"
                disabled={tradeBusy || hasOpenSessionTrade}
                onClick={() => placeManualContract("PUT")}
              >
                BUY FALL
              </button>
            </div>

            <div className="rfManualDigitGrid">
              <button
                type="button"
                disabled={tradeBusy || hasOpenSessionTrade}
                onClick={() => placeManualContract("DIGITEVEN")}
              >
                EVEN
              </button>

              <button
                type="button"
                disabled={tradeBusy || hasOpenSessionTrade}
                onClick={() => placeManualContract("DIGITODD")}
              >
                ODD
              </button>

              <button
                type="button"
                disabled={
                  tradeBusy ||
                  hasOpenSessionTrade ||
                  manualBarrier >= 9
                }
                onClick={() =>
                  placeManualContract(
                    "DIGITOVER",
                    manualBarrier
                  )
                }
              >
                OVER {manualBarrier}
              </button>

              <button
                type="button"
                disabled={
                  tradeBusy ||
                  hasOpenSessionTrade ||
                  manualBarrier <= 0
                }
                onClick={() =>
                  placeManualContract(
                    "DIGITUNDER",
                    manualBarrier
                  )
                }
              >
                UNDER {manualBarrier}
              </button>

              <button
                type="button"
                disabled={tradeBusy || hasOpenSessionTrade}
                onClick={() =>
                  placeManualContract(
                    "DIGITMATCH",
                    manualBarrier
                  )
                }
              >
                MATCH {manualBarrier}
              </button>

              <button
                type="button"
                disabled={tradeBusy || hasOpenSessionTrade}
                onClick={() =>
                  placeManualContract(
                    "DIGITDIFF",
                    manualBarrier
                  )
                }
              >
                DIFFER {manualBarrier}
              </button>
            </div>

            <p className="rfManualNote">
              Digit contracts execute at 1 tick. Rise/Fall uses
              the duration selected above.
            </p>

            <div className="rfManualStatus">
              {manualStatus}
            </div>
          </aside>
        ) : null}

        <div className="rfSafety">
          Analysis only. A high confidence score does not guarantee
          that the next price will rise or fall.
        </div>
      </main>
    </div>
  );
}


