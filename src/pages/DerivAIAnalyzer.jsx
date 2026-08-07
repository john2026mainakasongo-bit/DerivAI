import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import useDerivTicks from "../hooks/useDerivTicks";
import "./DerivAIAnalyzer.css";

const clamp = (n, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Number(n) || 0));

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

  const short = p.slice(-Math.min(10, p.length));
  const medium = p.slice(-Math.min(30, p.length));

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

  const dir = !aligned
    ? "WAIT"
    : shortMove > 0
      ? "RISE"
      : "FALL";

  const confidence = clamp(
    (aligned ? 46 : 18) + consistency * 0.42
  );

  return {
    signal: confidence >= 68 ? dir : "WAIT",
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

  if (p.length < 8) {
    return {
      signal: "WAIT",
      confidence: 0,
      touchScore: 0,
      noTouchScore: 0,
      upperBarrier: null,
      lowerBarrier: null,
    };
  }

  const current = p.at(-1);
  const recent = p.slice(-Math.min(40, p.length));
  const diffs = recent.slice(1).map((x, i) => x - recent[i]);

  const sigma = std(diffs);
  const distance = Math.max(
    sigma * barrierDistance,
    Math.abs(current) * 0.00001
  );

  const upperBarrier = current + distance;
  const lowerBarrier = current - distance;
  const range = Math.max(...recent) - Math.min(...recent);
  const ratio = distance > 0 ? range / distance : 0;

  const touchScore = clamp(ratio * 45);
  const noTouchScore = clamp(100 - touchScore);
  const confidence = Math.max(touchScore, noTouchScore);

  const signal =
    confidence < 65
      ? "WAIT"
      : touchScore > noTouchScore
        ? "TOUCH"
        : "NO TOUCH";

  return {
    signal,
    confidence,
    touchScore,
    noTouchScore,
    upperBarrier,
    lowerBarrier,
  };
}

function buildCandles(records = [], size = 5) {
  const candles = [];
  for (let i = 0; i < records.length; i += size) {
    const chunk = records.slice(i, i + size);
    if (!chunk.length) continue;

    const prices = chunk.map((r) => r.price);
    candles.push({
      ts: chunk[0].ts,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices.at(-1),
    });
  }
  return candles;
}

function makeScale(values, height, pad = 20) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const y = (value) =>
    height - ((value - min) / range) * (height - pad * 2) - pad;

  return { min, max, range, y };
}

function linePath(records, width, height) {
  if (records.length < 2) return "";
  const values = records.map((r) => r.price);
  const { y } = makeScale(values, height);

  return records
    .map((r, i) => {
      const x = (i / Math.max(1, records.length - 1)) * width;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y(r.price).toFixed(2)}`;
    })
    .join(" ");
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
  const [chartType, setChartType] = useState("candles");
  const [zoom, setZoom] = useState(1);
  const [records, setRecords] = useState([]);
  const [markers, setMarkers] = useState([]);
  const [crosshair, setCrosshair] = useState(null);

  const lastQuote = useRef(null);
  const lastSignal = useRef(null);

  useEffect(() => {
    if (!connected || !Number.isFinite(Number(currentPrice))) return;

    const price = Number(currentPrice);
    const now = Date.now();

    if (
      lastQuote.current &&
      lastQuote.current.price === price &&
      now - lastQuote.current.ts < 100
    ) {
      return;
    }

    lastQuote.current = { price, ts: now };

    setRecords((old) => [
      ...old.slice(-299),
      { price, ts: now },
    ]);
  }, [currentPrice, connected]);

  useEffect(() => {
    setRecords([]);
    setMarkers([]);
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
    riseFall.confidence >= 72;

  const touchValid =
    connected &&
    touch.signal !== "WAIT" &&
    touch.confidence >= 70;

  const best =
    riseFall.confidence >= touch.confidence
      ? {
          mode: "RISE/FALL",
          signal: riseFall.signal,
          confidence: riseFall.confidence,
          valid: riseValid,
        }
      : {
          mode: "TOUCH/NO TOUCH",
          signal: touch.signal,
          confidence: touch.confidence,
          valid: touchValid,
        };

  useEffect(() => {
    if (!best.valid || !records.length) return;

    const last = records.at(-1);
    const previous = lastSignal.current;

    if (
      previous &&
      previous.signal === best.signal &&
      last.ts - previous.ts < 5000
    ) {
      return;
    }

    const marker = {
      ts: last.ts,
      price: last.price,
      signal: best.signal,
      confidence: best.confidence,
    };

    lastSignal.current = marker;
    setMarkers((old) => [...old.slice(-7), marker]);
  }, [best.valid, best.signal, best.confidence, records]);

  const visibleCount = Math.max(30, Math.round(120 / zoom));
  const chartRecords = records.slice(-visibleCount);
  const candles = useMemo(
    () => buildCandles(chartRecords, Math.max(2, Math.round(5 / zoom))),
    [chartRecords, zoom]
  );

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

  const chartValues =
    chartType === "candles"
      ? candles.flatMap((c) => [c.high, c.low])
      : chartRecords.map((r) => r.price);

  const scale = chartValues.length
    ? makeScale(chartValues, 340)
    : null;

  const line = chartType === "line"
    ? linePath(chartRecords, 1000, 340)
    : "";

  const markerData = markers
    .map((marker) => {
      const idx = chartRecords.findIndex((r) => r.ts === marker.ts);
      if (idx < 0 || !scale) return null;
      return {
        ...marker,
        x: (idx / Math.max(1, chartRecords.length - 1)) * 1000,
        y: scale.y(marker.price),
      };
    })
    .filter(Boolean);

  const handleMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const yPct = clamp((e.clientY - rect.top) / rect.height, 0, 1);

    setCrosshair({
      x: xPct * 1000,
      y: yPct * 340,
      price:
        scale
          ? scale.max - yPct * (scale.max - scale.min)
          : null,
    });
  };

  return (
    <div className="tvShell">
      <Sidebar />

      <main className="tvMain">
        <Topbar
          title="Rise/Fall + Touch Analyzer"
          subtitle="Deriv live chart with TradingView-style controls"
          connected={connected}
          connecting={status === "CONNECTING" || loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {statusDetail ? (
          <div className="tvError">{statusDetail}</div>
        ) : null}

        <section className="tvToolbar">
          <label>
            <span>MARKET</span>
            <select
              value={symbol || ""}
              disabled={loadingMarket}
              onChange={(e) => changeSymbol(e.target.value)}
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
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {durationOptions.map((v) => (
                <option key={v} value={v}>
                  {unit === "ticks" ? `${v} ticks` : `${v} sec`}
                </option>
              ))}
            </select>
          </label>

          <div className="tvChartButtons">
            <button
              type="button"
              className={chartType === "candles" ? "active" : ""}
              onClick={() => setChartType("candles")}
            >
              Candles
            </button>
            <button
              type="button"
              className={chartType === "line" ? "active" : ""}
              onClick={() => setChartType("line")}
            >
              Line
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => clamp(z + 0.25, 0.75, 2.5))}
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => clamp(z - 0.25, 0.75, 2.5))}
            >
              −
            </button>
          </div>

          <div className={`tvLive ${connected ? "on" : ""}`}>
            <i />
            {connected ? "DERIV LIVE" : status}
          </div>
        </section>

        <section className="tvSignalStrip">
          <div className={best.valid ? "valid" : ""}>
            <span>AI SIGNAL</span>
            <strong>{best.valid ? best.signal : "WAIT"}</strong>
            <b>{best.confidence.toFixed(1)}%</b>
          </div>

          <div>
            <span>PRICE</span>
            <strong>{displayPrice}</strong>
            <small>{derivMarketName(symbol, market?.label)}</small>
          </div>

          <div>
            <span>WINDOW</span>
            <strong>{durationLabel}</strong>
            <small>{windowRecords.length} samples</small>
          </div>

          <div>
            <span>RISE/FALL</span>
            <strong>{riseFall.signal}</strong>
            <b>{riseFall.confidence.toFixed(1)}%</b>
          </div>
        </section>

        <section className="tvChartPanel">
          <div className="tvChartHead">
            <div>
              <span>DERIV LIVE CHART</span>
              <h3>{derivMarketName(symbol, market?.label)}</h3>
            </div>

            <div className="tvLegend">
              <span className="rise">RISE</span>
              <span className="fall">FALL</span>
              <span className="touch">TOUCH</span>
              <span className="no-touch">NO TOUCH</span>
            </div>
          </div>

          <div
            className="tvChart"
            onMouseMove={handleMove}
            onMouseLeave={() => setCrosshair(null)}
          >
            {scale ? (
              <svg viewBox="0 0 1060 340" preserveAspectRatio="none">
                {chartType === "line" && (
                  <path
                    d={line}
                    fill="none"
                    stroke="#2c9cff"
                    strokeWidth="3"
                    vectorEffect="non-scaling-stroke"
                  />
                )}

                {chartType === "candles" &&
                  candles.map((c, i) => {
                    const candleW = Math.max(
                      4,
                      (930 / Math.max(1, candles.length)) * 0.62
                    );
                    const x =
                      20 +
                      (i / Math.max(1, candles.length - 1)) * 930;
                    const openY = scale.y(c.open);
                    const closeY = scale.y(c.close);
                    const highY = scale.y(c.high);
                    const lowY = scale.y(c.low);
                    const up = c.close >= c.open;
                    const top = Math.min(openY, closeY);
                    const bodyH = Math.max(2, Math.abs(closeY - openY));

                    return (
                      <g key={`${c.ts}-${i}`} className={up ? "candleUp" : "candleDown"}>
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

                {markerData.map((m, i) => (
                  <g
                    key={`${m.ts}-${i}`}
                    className={`tvMarker ${String(m.signal).toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    <line
                      x1={m.x}
                      x2={m.x}
                      y1="0"
                      y2="340"
                      className="entryLine"
                    />
                    <circle cx={m.x} cy={m.y} r="8" />
                    <circle cx={m.x} cy={m.y} r="2.6" className="inner" />
                  </g>
                ))}

                {[0, 1, 2, 3, 4].map((i) => {
                  const value =
                    scale.max - (i / 4) * (scale.max - scale.min);
                  const y = 20 + (i / 4) * 300;

                  return (
                    <g key={i} className="priceScale">
                      <line x1="970" x2="1000" y1={y} y2={y} />
                      <text x="1008" y={y + 4}>
                        {fmt(value)}
                      </text>
                    </g>
                  );
                })}

                {crosshair && (
                  <g className="crosshair">
                    <line x1={crosshair.x} x2={crosshair.x} y1="0" y2="340" />
                    <line x1="0" x2="1000" y1={crosshair.y} y2={crosshair.y} />
                    {crosshair.price != null && (
                      <text x="1008" y={crosshair.y + 4}>
                        {fmt(crosshair.price)}
                      </text>
                    )}
                  </g>
                )}
              </svg>
            ) : (
              <div className="tvEmpty">
                Waiting for Deriv live ticks...
              </div>
            )}
          </div>
        </section>

        <section className="tvBottomGrid">
          <article className={riseValid ? "tvPanel valid" : "tvPanel"}>
            <div className="tvPanelHead">
              <span>RISE / FALL</span>
              <b>{riseValid ? "ENTRY VALID" : "WAIT"}</b>
            </div>

            <div className="tvSignalBox">
              <strong>{riseFall.signal}</strong>
              <span>{riseFall.confidence.toFixed(1)}%</span>
            </div>

            <div className="tvStats">
              <div><span>Trend</span><b>{riseFall.trend}</b></div>
              <div><span>Momentum</span><b>{riseFall.momentum}</b></div>
              <div><span>Consistency</span><b>{riseFall.consistency.toFixed(1)}%</b></div>
              <div><span>Volatility</span><b>{riseFall.volatility.toFixed(5)}</b></div>
            </div>
          </article>

          <article className={touchValid ? "tvPanel valid" : "tvPanel"}>
            <div className="tvPanelHead">
              <span>TOUCH / NO TOUCH</span>
              <b>{touchValid ? "ENTRY VALID" : "WAIT"}</b>
            </div>

            <select
              className="tvBarrier"
              value={barrierDistance}
              onChange={(e) => setBarrierDistance(Number(e.target.value))}
            >
              <option value={1}>Near · 1.0σ</option>
              <option value={1.5}>Normal · 1.5σ</option>
              <option value={2}>Far · 2.0σ</option>
              <option value={2.5}>Very far · 2.5σ</option>
            </select>

            <div className="tvTouchBars">
              <div>
                <span>TOUCH</span>
                <i><b style={{ width: `${touch.touchScore}%` }} /></i>
                <strong>{touch.touchScore.toFixed(0)}%</strong>
              </div>
              <div>
                <span>NO TOUCH</span>
                <i><b style={{ width: `${touch.noTouchScore}%` }} /></i>
                <strong>{touch.noTouchScore.toFixed(0)}%</strong>
              </div>
            </div>

            <div className="tvStats">
              <div><span>Upper</span><b>{fmt(touch.upperBarrier)}</b></div>
              <div><span>Lower</span><b>{fmt(touch.lowerBarrier)}</b></div>
            </div>
          </article>
        </section>

        <p className="tvDisclaimer">
          Analysis only. The chart uses Deriv live data and is styled like TradingView; it is not TradingView market data.
        </p>
      </main>
    </div>
  );
}
