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
  const nonZero = diffs.filter((d) => d !== 0);

  const up = nonZero.filter((d) => d > 0).length;
  const down = nonZero.filter((d) => d < 0).length;

  const consistency = nonZero.length
    ? (Math.max(up, down) / nonZero.length) * 100
    : 0;

  const sameDirection =
    Math.sign(shortMove) !== 0 &&
    Math.sign(shortMove) === Math.sign(mediumMove);

  const signal =
    !sameDirection
      ? "WAIT"
      : shortMove > 0
        ? "RISE"
        : "FALL";

  const confidence = clamp(
    (sameDirection ? 55 : 20) +
      consistency * 0.35
  );

  return {
    signal: confidence >= 68 ? signal : "WAIT",
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

function chartPath(records, width = 1000, height = 300) {
  if (!records || records.length < 2) return "";

  const values = records.map((r) => r.price);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return records
    .map((r, i) => {
      const x = (i / Math.max(1, records.length - 1)) * width;
      const y =
        height -
        ((r.price - min) / range) * (height - 26) -
        13;

      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function markerPosition(marker, records, width = 1000, height = 300) {
  if (!marker || !records.length) return null;

  const idx = records.findIndex((r) => r.ts === marker.ts);
  if (idx < 0) return null;

  const values = records.map((r) => r.price);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return {
    x: (idx / Math.max(1, records.length - 1)) * width,
    y:
      height -
      ((marker.price - min) / range) * (height - 26) -
      13,
  };
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
      ...old.slice(-179),
      { price, ts: now },
    ]);
  }, [currentPrice, connected]);

  useEffect(() => {
    setRecords([]);
    setMarkers([]);
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
      last.ts - previous.ts < 4000
    ) {
      return;
    }

    const marker = {
      ts: last.ts,
      price: last.price,
      signal: best.signal,
    };

    lastSignal.current = marker;
    setMarkers((old) => [...old.slice(-9), marker]);
  }, [best.valid, best.signal, records]);

  const chartRecords = records.slice(-100);
  const path = useMemo(
    () => chartPath(chartRecords),
    [chartRecords]
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

  return (
    <div className="cleanShell">
      <Sidebar />

      <main className="cleanMain">
        <Topbar
          title="Rise/Fall + Touch Analyzer"
          subtitle="Live market analysis · manual execution only"
          connected={connected}
          connecting={status === "CONNECTING" || loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {statusDetail ? (
          <div className="cleanError">{statusDetail}</div>
        ) : null}

        <section className="cleanToolbar">
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

          <div className={`cleanLive ${connected ? "on" : ""}`}>
            <i />
            {connected ? "DERIV LIVE" : status}
          </div>
        </section>

        <section className="cleanCards">
          <article className={best.valid ? "valid" : ""}>
            <span>BEST SETUP</span>
            <h2>{best.valid ? best.signal : "WAIT"}</h2>
            <strong>{best.confidence.toFixed(1)}%</strong>
            <small>{best.mode}</small>
          </article>

          <article>
            <span>CURRENT PRICE</span>
            <h2>{displayPrice}</h2>
            <small>{derivMarketName(symbol, market?.label)}</small>
          </article>

          <article>
            <span>WINDOW</span>
            <h2>{durationLabel}</h2>
            <strong>{windowRecords.length} samples</strong>
          </article>
        </section>

        <section className="cleanChartPanel">
          <div className="cleanHead">
            <div>
              <span>LIVE SIGNAL CHART</span>
              <h3>{derivMarketName(symbol, market?.label)}</h3>
            </div>

            <div className="cleanLegend">
              <b className="rise">RISE</b>
              <b className="fall">FALL</b>
              <b className="touch">TOUCH</b>
              <b className="no-touch">NO TOUCH</b>
            </div>
          </div>

          <div className="cleanChart">
            {path ? (
              <svg
                viewBox="0 0 1000 300"
                preserveAspectRatio="none"
              >
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  vectorEffect="non-scaling-stroke"
                />

                {markers.map((marker, index) => {
                  const pos = markerPosition(
                    marker,
                    chartRecords
                  );

                  if (!pos) return null;

                  const cls = marker.signal
                    .toLowerCase()
                    .replace(/\s+/g, "-");

                  return (
                    <g
                      key={`${marker.ts}-${index}`}
                      className={`cleanMarker ${cls}`}
                    >
                      <circle
                        cx={pos.x}
                        cy={pos.y}
                        r="7"
                      />
                      <circle
                        cx={pos.x}
                        cy={pos.y}
                        r="2.4"
                        className="inner"
                      />
                    </g>
                  );
                })}
              </svg>
            ) : (
              <div className="cleanEmpty">
                Waiting for live market data...
              </div>
            )}
          </div>
        </section>

        <section className="cleanAnalysisGrid">
          <article className={riseValid ? "cleanPanel valid" : "cleanPanel"}>
            <div className="cleanHead">
              <div>
                <span>RISE / FALL</span>
                <h3>Directional analysis</h3>
              </div>
              <b>{riseValid ? "ENTRY VALID" : "WAIT"}</b>
            </div>

            <div className={`cleanSignal ${riseValid ? "blink" : ""}`}>
              <strong>{riseFall.signal}</strong>
              <span>{riseFall.confidence.toFixed(1)}%</span>
            </div>

            <div className="cleanStats">
              <div><span>Trend</span><b>{riseFall.trend}</b></div>
              <div><span>Momentum</span><b>{riseFall.momentum}</b></div>
              <div><span>Consistency</span><b>{riseFall.consistency.toFixed(1)}%</b></div>
              <div><span>Volatility</span><b>{riseFall.volatility.toFixed(5)}</b></div>
            </div>
          </article>

          <article className={touchValid ? "cleanPanel valid" : "cleanPanel"}>
            <div className="cleanHead">
              <div>
                <span>TOUCH / NO TOUCH</span>
                <h3>Barrier analysis</h3>
              </div>
              <b>{touchValid ? "ENTRY VALID" : "WAIT"}</b>
            </div>

            <div className="barrierControl">
              <span>BARRIER DISTANCE</span>
              <select
                value={barrierDistance}
                onChange={(e) =>
                  setBarrierDistance(Number(e.target.value))
                }
              >
                <option value={1}>Near · 1.0σ</option>
                <option value={1.5}>Normal · 1.5σ</option>
                <option value={2}>Far · 2.0σ</option>
                <option value={2.5}>Very far · 2.5σ</option>
              </select>
            </div>

            <div className={`cleanSignal ${touchValid ? "blink" : ""}`}>
              <strong>{touch.signal}</strong>
              <span>{touch.confidence.toFixed(1)}%</span>
            </div>

            <div className="touchMiniBars">
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

            <div className="cleanStats">
              <div><span>Upper barrier</span><b>{fmt(touch.upperBarrier)}</b></div>
              <div><span>Lower barrier</span><b>{fmt(touch.lowerBarrier)}</b></div>
            </div>
          </article>
        </section>

        <p className="cleanDisclaimer">
          Analysis only. Signals and confidence values are estimates from observed live data and are not guaranteed outcomes.
        </p>
      </main>
    </div>
  );
}
