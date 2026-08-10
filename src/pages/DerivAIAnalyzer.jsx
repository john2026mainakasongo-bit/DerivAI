import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import useDerivTicks from "../hooks/useDerivTicks";
import "./DerivAIAnalyzer.css";

const clamp = (n, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Number(n) || 0));

const MASTER_THRESHOLD = 72;

function derivMarketName(symbol, fallback = "") {
  const exact = {
    "1HZ10V": "Volatility 10 (1s) Index",
    "1HZ15V": "Volatility 15 (1s) Index",
    "1HZ25V": "Volatility 25 (1s) Index",
    "1HZ30V": "Volatility 30 (1s) Index",
    "1HZ50V": "Volatility 50 (1s) Index",
    "1HZ75V": "Volatility 75 (1s) Index",
    "1HZ90V": "Volatility 90 (1s) Index",
    "1HZ100V": "Volatility 100 (1s) Index",
    "R_10": "Volatility 10 Index",
    "R_25": "Volatility 25 Index",
    "R_50": "Volatility 50 Index",
    "R_75": "Volatility 75 Index",
    "R_100": "Volatility 100 Index",
  };

  if (exact[symbol]) return exact[symbol];

  const one = String(symbol || "").match(/^1HZ(\d+)V$/i);
  if (one) return `Volatility ${one[1]} (1s) Index`;

  const normal = String(symbol || "").match(/^R_(\d+)$/i);
  if (normal) return `Volatility ${normal[1]} Index`;

  return fallback || symbol || "Deriv Market";
}

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values = []) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((x) => (x - m) ** 2)));
}

function analyzeRiseFall(prices = []) {
  const p = prices.map(Number).filter(Number.isFinite);

  if (p.length < 6) {
    return {
      signal: "WAIT",
      confidence: 0,
      trend: "COLLECTING",
      momentum: "COLLECTING",
      consistency: 0,
      volatility: 0,
    };
  }

  const short = p.slice(-Math.min(12, p.length));
  const medium = p.slice(-Math.min(36, p.length));

  const shortMove = short.at(-1) - short[0];
  const mediumMove = medium.at(-1) - medium[0];

  const diffs = short.slice(1).map((x, i) => x - short[i]);
  const nz = diffs.filter((d) => d !== 0);

  const up = nz.filter((d) => d > 0).length;
  const down = nz.filter((d) => d < 0).length;

  const consistency = nz.length
    ? (Math.max(up, down) / nz.length) * 100
    : 0;

  const aligned =
    Math.sign(shortMove) !== 0 &&
    Math.sign(shortMove) === Math.sign(mediumMove);

  const direction =
    !aligned
      ? "WAIT"
      : shortMove > 0
        ? "RISE"
        : "FALL";

  const confidence = clamp(
    (aligned ? 47 : 18) + consistency * 0.41
  );

  return {
    signal: confidence >= 68 ? direction : "WAIT",
    confidence,
    trend:
      mediumMove > 0
        ? "BULLISH"
        : mediumMove < 0
          ? "BEARISH"
          : "SIDEWAYS",
    momentum:
      shortMove > 0
        ? "UP"
        : shortMove < 0
          ? "DOWN"
          : "FLAT",
    consistency,
    volatility: std(diffs),
  };
}

function analyzeTouch(prices = [], barrierDistance = 1.5) {
  const p = prices.map(Number).filter(Number.isFinite);

  if (p.length < 10) {
    return {
      signal: "WAIT",
      confidence: 0,
      touchScore: 50,
      noTouchScore: 50,
      upperBarrier: null,
      lowerBarrier: null,
      movementScore: 0,
    };
  }

  const current = p.at(-1);
  const recent = p.slice(-Math.min(60, p.length));
  const diffs = recent.slice(1).map((x, i) => x - recent[i]);
  const sigma = std(diffs);

  const distance = Math.max(
    sigma * barrierDistance,
    Math.abs(current) * 0.00001
  );

  const upperBarrier = current + distance;
  const lowerBarrier = current - distance;

  const short = recent.slice(-Math.min(12, recent.length));
  const shortRange = Math.max(...short) - Math.min(...short);
  const fullRange = Math.max(...recent) - Math.min(...recent);
  const netMove = Math.abs(recent.at(-1) - recent[0]);

  const rangePressure = distance > 0 ? shortRange / distance : 0;
  const expansion = distance > 0 ? fullRange / (distance * 2) : 0;
  const drift = distance > 0 ? netMove / distance : 0;

  // Calibrated evidence score rather than an artificial 0/100 certainty.
  // The cap deliberately prevents repeated 100% "signals" from noisy ticks.
  const movementScore = clamp(
    46 + rangePressure * 15 + expansion * 8 + drift * 5,
    38,
    92
  );

  const touchScore = movementScore;
  const noTouchScore = 100 - touchScore;
  const confidence = Math.max(touchScore, noTouchScore);

  let signal = "WAIT";
  if (confidence >= MASTER_THRESHOLD) {
    signal = touchScore >= noTouchScore ? "TOUCH" : "NO TOUCH";
  }

  return {
    signal,
    confidence,
    touchScore,
    noTouchScore,
    upperBarrier,
    lowerBarrier,
    movementScore,
  };
}

function buildCandles(records = [], size = 2) {
  const candles = [];

  for (let i = 0; i < records.length; i += size) {
    const chunk = records.slice(i, i + size);
    if (!chunk.length) continue;

    const prices = chunk.map((r) => r.price);

    candles.push({
      ts: chunk[0].ts,
      endTs: chunk.at(-1).ts,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices.at(-1),
    });
  }

  return candles;
}

function makeScale(values, height, top = 16, bottom = 24) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const pad = range * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const span = hi - lo || 1;

  const y = (value) =>
    top + ((hi - value) / span) * (height - top - bottom);

  return { min: lo, max: hi, span, y };
}

function signalColor(signal) {
  if (signal === "RISE") return "#22dda5";
  if (signal === "FALL") return "#ff7181";
  if (signal === "TOUCH") return "#5aa9ff";
  if (signal === "NO TOUCH") return "#ffd45d";
  return "#8fa6b5";
}

export default function DerivAIAnalyzer() {
  const deriv = useDerivTicks();

  const {
    markets = [],
    market = {},
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    currentPrice,
    connect,
    disconnect,
    changeSymbol,
  } = deriv;

  const [unit, setUnit] = useState("ticks");
  const [duration, setDuration] = useState(10);
  const [barrierDistance, setBarrierDistance] = useState(1.5);

  const [records, setRecords] = useState([]);
  const [markers, setMarkers] = useState([]);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const [crosshair, setCrosshair] = useState(null);

  const dragRef = useRef(null);
  const lastQuote = useRef(null);
  const lastSignal = useRef(null);

  useEffect(() => {
    if (!connected || !Number.isFinite(Number(currentPrice))) return;

    const price = Number(currentPrice);
    const now = Date.now();

    if (
      lastQuote.current &&
      lastQuote.current.price === price &&
      now - lastQuote.current.ts < 80
    ) {
      return;
    }

    lastQuote.current = { price, ts: now };

    setRecords((old) => [
      ...old.slice(-499),
      { price, ts: now },
    ]);
  }, [currentPrice, connected]);

  useEffect(() => {
    setRecords([]);
    setMarkers([]);
    setPan(0);
    setZoom(1);
    setCrosshair(null);
    lastQuote.current = null;
    lastSignal.current = null;
  }, [symbol]);

  const windowRecords = useMemo(() => {
    if (unit === "ticks") {
      return records.slice(-Math.max(5, duration));
    }

    const cutoff = Date.now() - duration * 1000;
    return records.filter((r) => r.ts >= cutoff);
  }, [records, unit, duration, currentPrice]);

  const windowPrices = useMemo(
    () => windowRecords.map((r) => r.price),
    [windowRecords]
  );

  const riseFall = useMemo(
    () => analyzeRiseFall(windowPrices),
    [windowPrices]
  );

  const touch = useMemo(
    () => analyzeTouch(windowPrices, barrierDistance),
    [windowPrices, barrierDistance]
  );

  const riseValid =
    connected &&
    riseFall.signal !== "WAIT" &&
    riseFall.confidence >= MASTER_THRESHOLD;

  const touchValid =
    connected &&
    touch.signal !== "WAIT" &&
    touch.confidence >= MASTER_THRESHOLD;

  const qualifiedCandidates = [
    {
      mode: "RISE/FALL",
      signal: riseFall.signal,
      confidence: riseFall.confidence,
      valid: riseValid,
    },
    {
      mode: "TOUCH/NO TOUCH",
      signal: touch.signal,
      confidence: touch.confidence,
      valid: touchValid,
    },
  ].filter((candidate) => candidate.valid);

  const strongestQualified = qualifiedCandidates.sort(
    (a, b) => b.confidence - a.confidence
  )[0];

  const strongestEvidence = Math.max(
    riseFall.confidence,
    touch.confidence
  );

  const best = strongestQualified || {
    mode: "ANALYZER",
    signal: "WAIT",
    confidence: strongestEvidence,
    valid: false,
  };

  useEffect(() => {
    if (!best.valid || !records.length) return;

    const last = records.at(-1);
    const previous = lastSignal.current;
    const minimumGapMs = unit === "ticks"
      ? Math.max(8000, duration * 850)
      : Math.max(10000, duration * 1000);

    if (previous) {
      const sameSignal = previous.signal === best.signal;
      const tooSoon = last.ts - previous.ts < minimumGapMs;
      const notMateriallyStronger =
        best.confidence < previous.confidence + 8;

      if (tooSoon && (sameSignal || notMateriallyStronger)) {
        return;
      }
    }

    const marker = {
      ts: last.ts,
      price: last.price,
      signal: best.signal,
      mode: best.mode,
      confidence: best.confidence,
    };

    lastSignal.current = marker;
    setMarkers((old) => [...old.slice(-9), marker]);
  }, [
    best.valid,
    best.signal,
    best.mode,
    best.confidence,
    records,
    unit,
    duration,
  ]);

  const visibleCount = Math.round(clamp(160 / zoom, 45, 220));
  const safePan = Math.max(
    0,
    Math.min(
      pan,
      Math.max(0, records.length - visibleCount)
    )
  );

  const visibleEnd = records.length - safePan;
  const visibleStart = Math.max(0, visibleEnd - visibleCount);
  const chartRecords = records.slice(visibleStart, visibleEnd);

  const candleSize = Math.max(
    1,
    Math.round(3 / zoom)
  );

  const candles = useMemo(
    () => buildCandles(chartRecords, candleSize),
    [chartRecords, candleSize]
  );

  const chartValues = candles.flatMap((c) => [
    c.high,
    c.low,
  ]);

  const scale = chartValues.length
    ? makeScale(chartValues, 420)
    : null;

  const durationOptions =
    unit === "ticks"
      ? [5, 10, 20, 50, 100]
      : [5, 10, 15, 30, 60];

  const durationLabel =
    unit === "ticks"
      ? `${duration} ticks`
      : `${duration}s`;

  const displayPrice =
    Number.isFinite(Number(currentPrice))
      ? Number(currentPrice).toFixed(market?.decimals ?? 2)
      : "—";

  const fmt = (value) =>
    Number.isFinite(Number(value))
      ? Number(value).toFixed(market?.decimals ?? 2)
      : "—";

  const entry = markers.at(-1) || null;

  const signalQuality = !best.valid
    ? "WAIT"
    : best.confidence >= 86
      ? "VERY STRONG"
      : best.confidence >= 78
        ? "STRONG"
        : "QUALIFIED";

  const handleWheel = (e) => {
    e.preventDefault();

    setZoom((old) =>
      clamp(
        old + (e.deltaY < 0 ? 0.12 : -0.12),
        0.7,
        3
      )
    );
  };

  const startDrag = (e) => {
    dragRef.current = {
      x: e.clientX,
      pan,
    };
  };

  const dragMove = (e) => {
    if (!dragRef.current) return;

    const dx = e.clientX - dragRef.current.x;
    const ticksPerPixel = visibleCount / 900;

    const nextPan = Math.round(
      dragRef.current.pan - dx * ticksPerPixel
    );

    setPan(
      Math.max(
        0,
        Math.min(
          nextPan,
          Math.max(0, records.length - visibleCount)
        )
      )
    );
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const handleCrosshair = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPct = clamp(
      (e.clientX - rect.left) / rect.width,
      0,
      1
    );
    const yPct = clamp(
      (e.clientY - rect.top) / rect.height,
      0,
      1
    );

    const index = Math.round(
      xPct * Math.max(0, chartRecords.length - 1)
    );

    const record = chartRecords[index];

    setCrosshair({
      x: xPct * 1000,
      y: yPct * 420,
      price:
        scale
          ? scale.max - yPct * scale.span
          : null,
      record,
    });
  };

  const markerData = markers
    .map((marker) => {
      if (!scale) return null;

      const idx = chartRecords.findIndex(
        (r) => r.ts === marker.ts
      );

      if (idx < 0) return null;

      return {
        ...marker,
        x:
          (idx /
            Math.max(1, chartRecords.length - 1)) *
          1000,
        y: scale.y(marker.price),
      };
    })
    .filter(Boolean);

  const marketStatus = connected ? "OPEN" : "OFFLINE";
  const volatilityLabel =
    riseFall.volatility > 1 ? "HIGH" :
    riseFall.volatility > 0.25 ? "NORMAL" : "LOW";
  const tickSpeed = records.length > 1
    ? Math.max(
        0,
        1000 /
          Math.max(
            1,
            records.at(-1).ts - records.at(-2).ts
          )
      )
    : 0;

  const recentSignals = [...markers].reverse().slice(0, 6);

  return (
    <div className="terminalShell">
      <Sidebar />

      <main className="terminalMain">
        <Topbar
          title="Deriv AI Analyzer"
          subtitle="Real-time market analysis for clearer manual trading decisions"
          connected={connected}
          connecting={
            status === "CONNECTING" || loadingMarket
          }
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {statusDetail ? (
          <div className="terminalError">
            {statusDetail}
          </div>
        ) : null}

        <section className="terminalControls">
          <label>
            <span>MARKET</span>
            <select
              value={symbol || ""}
              disabled={loadingMarket}
              onChange={(e) =>
                changeSymbol(e.target.value)
              }
            >
              {markets.map((m) => {
                const id = m.symbol || m.id;

                return (
                  <option key={id} value={id}>
                    {derivMarketName(id, m.label)}
                  </option>
                );
              })}
            </select>
          </label>

          <label>
            <span>TYPE</span>
            <select
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value);
                setDuration(10);
              }}
            >
              <option value="ticks">Ticks</option>
              <option value="seconds">Seconds</option>
            </select>
          </label>

          <label>
            <span>DURATION</span>
            <select
              value={duration}
              onChange={(e) =>
                setDuration(Number(e.target.value))
              }
            >
              {durationOptions.map((v) => (
                <option key={v} value={v}>
                  {unit === "ticks"
                    ? `${v} ticks`
                    : `${v} sec`}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setPan(0);
            }}
          >
            Reset chart
          </button>

          <div
            className={`terminalLive ${
              connected ? "on" : ""
            }`}
          >
            <i />
            {connected ? "DERIV LIVE" : status}
          </div>
        </section>

        <section className="terminalWorkspace">
          <article className="terminalChartCard">
            <div className="terminalChartHeader">
              <div>
                <span>LIVE MARKET</span>
                <h2>
                  {derivMarketName(
                    symbol,
                    market?.label
                  )}
                </h2>
              </div>

              <div className="terminalPrice">
                <strong>{displayPrice}</strong>
                <small>{durationLabel}</small>
              </div>
            </div>

            <div
              className="terminalChart"
              onWheel={handleWheel}
              onMouseDown={startDrag}
              onMouseMove={(e) => {
                dragMove(e);
                handleCrosshair(e);
              }}
              onMouseUp={endDrag}
              onMouseLeave={() => {
                endDrag();
                setCrosshair(null);
              }}
            >
              {scale && candles.length ? (
                <svg
                  viewBox="0 0 1080 420"
                  preserveAspectRatio="none"
                >
                  {candles.map((c, i) => {
                    const count = Math.max(
                      1,
                      candles.length
                    );

                    const x =
                      16 +
                      (i /
                        Math.max(1, count - 1)) *
                        930;

                    const candleW = Math.max(
                      4,
                      Math.min(
                        13,
                        (900 / count) * 0.64
                      )
                    );

                    const openY = scale.y(c.open);
                    const closeY = scale.y(c.close);
                    const highY = scale.y(c.high);
                    const lowY = scale.y(c.low);

                    const bullish =
                      c.close >= c.open;

                    const top = Math.min(
                      openY,
                      closeY
                    );

                    const bodyH = Math.max(
                      2,
                      Math.abs(
                        closeY - openY
                      )
                    );

                    return (
                      <g
                        key={`${c.ts}-${i}`}
                        className={
                          bullish
                            ? "terminalCandleUp"
                            : "terminalCandleDown"
                        }
                      >
                        <line
                          x1={x}
                          x2={x}
                          y1={highY}
                          y2={lowY}
                          className="wick"
                        />
                        <rect
                          x={x - candleW / 2}
                          y={top}
                          width={candleW}
                          height={bodyH}
                          rx="1"
                          className="body"
                        />
                      </g>
                    );
                  })}

                  {scale &&
                    Number.isFinite(
                      Number(currentPrice)
                    ) && (
                      <g className="currentPriceLine">
                        <line
                          x1="0"
                          x2="950"
                          y1={scale.y(
                            Number(currentPrice)
                          )}
                          y2={scale.y(
                            Number(currentPrice)
                          )}
                        />
                        <rect
                          x="957"
                          y={
                            scale.y(
                              Number(
                                currentPrice
                              )
                            ) - 10
                          }
                          width="74"
                          height="20"
                          rx="4"
                        />
                        <text
                          x="965"
                          y={
                            scale.y(
                              Number(
                                currentPrice
                              )
                            ) + 4
                          }
                        >
                          {displayPrice}
                        </text>
                      </g>
                    )}

                  {markerData.map((m, i) => {
                    const color = signalColor(
                      m.signal
                    );

                    const isRise =
                      m.signal === "RISE";
                    const isFall =
                      m.signal === "FALL";
                    const isTouch =
                      m.signal === "TOUCH";
                    const isNoTouch =
                      m.signal === "NO TOUCH";

                    return (
                      <g
                        key={`${m.ts}-${i}`}
                        className="terminalMarker"
                        style={{ color }}
                      >
                        <line
                          x1={m.x}
                          x2={m.x}
                          y1="0"
                          y2="420"
                          className="entryLine"
                        />

                        {(isRise || isFall) && (
                          <>
                            <polygon
                              points={
                                isRise
                                  ? `${m.x},${m.y - 22} ${m.x - 8},${m.y - 8} ${m.x + 8},${m.y - 8}`
                                  : `${m.x},${m.y + 22} ${m.x - 8},${m.y + 8} ${m.x + 8},${m.y + 8}`
                              }
                              className="signalArrow"
                            />
                            <text
                              x={Math.min(
                                850,
                                m.x + 10
                              )}
                              y={
                                isRise
                                  ? m.y - 18
                                  : m.y + 30
                              }
                              className="signalLabel"
                            >
                              {isRise
                                ? "BUY RISE"
                                : "BUY FALL"}
                            </text>
                          </>
                        )}

                        {(isTouch ||
                          isNoTouch) && (
                          <>
                            <circle
                              cx={m.x}
                              cy={m.y}
                              r="7"
                              className="touchDot"
                            />
                            <text
                              x={Math.min(
                                850,
                                m.x + 10
                              )}
                              y={m.y - 10}
                              className="signalLabel"
                            >
                              {m.signal}
                            </text>
                          </>
                        )}
                      </g>
                    );
                  })}

                  {[0, 1, 2, 3, 4].map((i) => {
                    const value =
                      scale.max -
                      (i / 4) * scale.span;

                    const y =
                      18 + (i / 4) * 370;

                    return (
                      <g
                        key={`price-${i}`}
                        className="terminalPriceScale"
                      >
                        <line
                          x1="952"
                          x2="968"
                          y1={y}
                          y2={y}
                        />
                        <text
                          x="976"
                          y={y + 4}
                        >
                          {fmt(value)}
                        </text>
                      </g>
                    );
                  })}

                  {[0, 1, 2, 3, 4, 5].map(
                    (i) => {
                      const x =
                        20 + (i / 5) * 900;

                      const idx = Math.round(
                        (i / 5) *
                          Math.max(
                            0,
                            chartRecords.length -
                              1
                          )
                      );

                      const rec =
                        chartRecords[idx];

                      let label = "";

                      if (rec) {
                        label =
                          unit === "ticks"
                            ? `T${visibleStart + idx + 1}`
                            : new Date(
                                rec.ts
                              ).toLocaleTimeString(
                                [],
                                {
                                  minute:
                                    "2-digit",
                                  second:
                                    "2-digit",
                                }
                              );
                      }

                      return (
                        <g
                          key={`time-${i}`}
                          className="terminalTimeScale"
                        >
                          <line
                            x1={x}
                            x2={x}
                            y1="392"
                            y2="400"
                          />
                          <text
                            x={x - 12}
                            y="415"
                          >
                            {label}
                          </text>
                        </g>
                      );
                    }
                  )}

                  {crosshair && (
                    <g className="terminalCrosshair">
                      <line
                        x1={crosshair.x}
                        x2={crosshair.x}
                        y1="0"
                        y2="392"
                      />
                      <line
                        x1="0"
                        x2="950"
                        y1={crosshair.y}
                        y2={crosshair.y}
                      />

                      {crosshair.price !=
                        null && (
                        <>
                          <rect
                            x="957"
                            y={
                              crosshair.y -
                              10
                            }
                            width="74"
                            height="20"
                            rx="4"
                          />
                          <text
                            x="965"
                            y={
                              crosshair.y + 4
                            }
                          >
                            {fmt(
                              crosshair.price
                            )}
                          </text>
                        </>
                      )}
                    </g>
                  )}
                </svg>
              ) : (
                <div className="terminalEmpty">
                  Waiting for live Deriv
                  ticks...
                </div>
              )}
            </div>

            <div className="terminalChartFooter">
              <span>
                Mouse wheel: <b>Zoom</b>
              </span>
              <span>
                Drag: <b>History</b>
              </span>
              <span>
                Visible ticks:{" "}
                <b>{chartRecords.length}</b>
              </span>
              <span>
                Zoom: <b>{zoom.toFixed(2)}x</b>
              </span>
            </div>
          </article>

          <aside className="terminalSide">
            <section
              className={`terminalSignalCard ${
                best.valid ? "valid" : ""
              }`}
            >
              <span>AI SIGNAL</span>

              <strong>
                {best.valid
                  ? best.signal
                  : "WAIT"}
              </strong>

              <b>
                {best.confidence.toFixed(1)}%
              </b>

              <div className="signalRows">
                <p>
                  <span>Mode</span>
                  <b>{best.mode}</b>
                </p>

                <p>
                  <span>Quality</span>
                  <b>{signalQuality}</b>
                </p>

                <p>
                  <span>Threshold</span>
                  <b>{MASTER_THRESHOLD}%</b>
                </p>

                <p>
                  <span>Duration</span>
                  <b>{durationLabel}</b>
                </p>

                <p>
                  <span>Entry</span>
                  <b>
                    {entry
                      ? fmt(entry.price)
                      : "—"}
                  </b>
                </p>
              </div>
            </section>

            <section className="terminalMiniCard">
              <span>RISE / FALL</span>

              <div className="terminalDecision">
                <strong>
                  {riseFall.signal}
                </strong>
                <b>
                  {riseFall.confidence.toFixed(
                    1
                  )}
                  %
                </b>
              </div>

              <div className="miniRows">
                <p>
                  <span>Trend</span>
                  <b>{riseFall.trend}</b>
                </p>
                <p>
                  <span>Momentum</span>
                  <b>{riseFall.momentum}</b>
                </p>
                <p>
                  <span>Consistency</span>
                  <b>
                    {riseFall.consistency.toFixed(
                      0
                    )}
                    %
                  </b>
                </p>
              </div>
            </section>

            <section className="terminalMiniCard">
              <div className="terminalTouchHead">
                <span>TOUCH / NO TOUCH</span>

                <select
                  value={barrierDistance}
                  onChange={(e) =>
                    setBarrierDistance(
                      Number(e.target.value)
                    )
                  }
                >
                  <option value={1}>
                    1.0σ
                  </option>
                  <option value={1.5}>
                    1.5σ
                  </option>
                  <option value={2}>
                    2.0σ
                  </option>
                  <option value={2.5}>
                    2.5σ
                  </option>
                </select>
              </div>

              <div className="touchBars">
                <div>
                  <span>TOUCH</span>
                  <i>
                    <b
                      style={{
                        width: `${touch.touchScore}%`,
                      }}
                    />
                  </i>
                  <strong>
                    {touch.touchScore.toFixed(
                      0
                    )}
                    %
                  </strong>
                </div>

                <div>
                  <span>NO TOUCH</span>
                  <i>
                    <b
                      style={{
                        width: `${touch.noTouchScore}%`,
                      }}
                    />
                  </i>
                  <strong>
                    {touch.noTouchScore.toFixed(
                      0
                    )}
                    %
                  </strong>
                </div>
              </div>

              <div className="miniRows">
                <p>
                  <span>Upper</span>
                  <b>
                    {fmt(
                      touch.upperBarrier
                    )}
                  </b>
                </p>
                <p>
                  <span>Lower</span>
                  <b>
                    {fmt(
                      touch.lowerBarrier
                    )}
                  </b>
                </p>
              </div>
            </section>
          </aside>
        </section>

        <section className="terminalMetrics">
          <div><span>MARKET STATUS</span><strong>{marketStatus}</strong><small>{connected ? "Ticks streaming" : status}</small></div>
          <div><span>VOLATILITY</span><strong>{volatilityLabel}</strong><small>Live movement estimate</small></div>
          <div><span>TICK SPEED</span><strong>{tickSpeed ? `${tickSpeed.toFixed(1)} / sec` : "—"}</strong><small>Observed feed speed</small></div>
          <div><span>AI CONFIDENCE</span><strong>{best.confidence.toFixed(1)}%</strong><small>{signalQuality}</small></div>
          <div><span>DECISION</span><strong>{best.valid ? best.signal : "WAIT"}</strong><small>Threshold {MASTER_THRESHOLD}%</small></div>
          <div><span>SIGNALS LOGGED</span><strong>{markers.length}</strong><small>Current market session</small></div>
        </section>

        <section className="terminalBottomGrid">
          <article className="terminalLogCard">
            <div className="terminalSectionHead">
              <div><span>RECENT SIGNALS</span><h3>Signal history</h3></div>
              <small>Current session</small>
            </div>
            <div className="terminalTableWrap">
              <table className="terminalTable">
                <thead><tr><th>TIME</th><th>MODE</th><th>SIGNAL</th><th>ENTRY</th><th>CONFIDENCE</th></tr></thead>
                <tbody>
                  {recentSignals.length ? recentSignals.map((item) => (
                    <tr key={item.ts}>
                      <td>{new Date(item.ts).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"})}</td>
                      <td>{item.mode || (item.signal === "RISE" || item.signal === "FALL" ? "RISE/FALL" : "TOUCH/NO TOUCH")}</td>
                      <td><b style={{color: signalColor(item.signal)}}>{item.signal}</b></td>
                      <td>{fmt(item.price)}</td>
                      <td>{Number(item.confidence).toFixed(1)}%</td>
                    </tr>
                  )) : (
                    <tr><td colSpan="5" className="terminalNoRows">No qualified signals yet. Analyzer is watching the live market.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <article className="terminalExplainCard">
            <div className="terminalSectionHead">
              <div><span>HOW TO READ THIS</span><h3>Decision guide</h3></div>
            </div>
            <div className="terminalGuide">
              <p><i className="guideDot green" /><span><b>{MASTER_THRESHOLD}%+ confidence</b>Qualified signal. Confirm direction and duration before manual execution.</span></p>
              <p><i className="guideDot amber" /><span><b>Below {MASTER_THRESHOLD}%</b>WAIT means the current evidence is not strong enough.</span></p>
              <p><i className="guideDot blue" /><span><b>Touch / No Touch</b>Barrier probabilities are shown separately from Rise / Fall.</span></p>
              <p><i className="guideDot gray" /><span><b>Chart markers</b>Show where qualified signals were detected; they are not guaranteed outcomes.</span></p>
            </div>
          </article>
        </section>

        <p className="terminalDisclaimer">
          Analysis only · Deriv live market data · Manual execution · Signals are probabilistic and are not guaranteed outcomes.
        </p>
      </main>
    </div>
  );
}
