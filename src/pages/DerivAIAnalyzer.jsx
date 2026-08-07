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
      reasons: {
        trend: false,
        momentum: false,
        volatility: false,
        pattern: false,
      },
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

  const direction =
    !sameDirection
      ? "WAIT"
      : shortMove > 0
        ? "RISE"
        : "FALL";

  const vol = std(diffs);
  const avgMove = mean(diffs.map(Math.abs)) || 1e-9;
  const volScore = clamp(100 - (vol / avgMove) * 30);

  const momentumScore = clamp(
    Math.abs(shortMove) / (avgMove * Math.max(1, short.length - 1)) * 100
  );

  const confidence = clamp(
    (sameDirection ? 46 : 18) +
    consistency * 0.34 +
    momentumScore * 0.12 +
    volScore * 0.08
  );

  const reasons = {
    trend: sameDirection,
    momentum: momentumScore >= 55,
    volatility: volScore >= 45,
    pattern: consistency >= 60,
  };

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
    volatility: vol,
    reasons,
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

function qualityFromConfidence(confidence) {
  if (confidence >= 88) return { grade: "A+", label: "Very Strong" };
  if (confidence >= 80) return { grade: "A", label: "Strong" };
  if (confidence >= 72) return { grade: "B", label: "Good" };
  if (confidence >= 64) return { grade: "C", label: "Weak" };
  return { grade: "D", label: "Wait" };
}

function chartPath(records, width = 1000, height = 340) {
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
        ((r.price - min) / range) * (height - 30) -
        15;

      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function markerPosition(marker, records, width = 1000, height = 340) {
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
      ((marker.price - min) / range) * (height - 30) -
      15,
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
      ...old.slice(-199),
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
      last.ts - previous.ts < 5000
    ) {
      return;
    }

    const marker = {
      ts: last.ts,
      price: last.price,
      signal: best.signal,
    };

    lastSignal.current = marker;
    setMarkers((old) => [...old.slice(-7), marker]);
  }, [best.valid, best.signal, records]);

  const chartRecords = records.slice(-120);
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

  const remaining =
    unit === "ticks"
      ? Math.max(0, duration - windowRecords.length)
      : windowRecords.length
        ? Math.max(
            0,
            duration -
              (Date.now() - windowRecords[0].ts) / 1000
          )
        : duration;

  const progress =
    unit === "ticks"
      ? clamp((windowRecords.length / duration) * 100)
      : clamp(((duration - remaining) / duration) * 100);

  const displayPrice =
    Number.isFinite(Number(currentPrice))
      ? Number(currentPrice).toFixed(market?.decimals ?? 2)
      : "—";

  const fmt = (value) =>
    Number.isFinite(Number(value))
      ? Number(value).toFixed(market?.decimals ?? 2)
      : "—";

  const quality = qualityFromConfidence(best.confidence);

  const risk =
    best.confidence >= 82
      ? "LOW"
      : best.confidence >= 72
        ? "MEDIUM"
        : "HIGH";

  return (
    <div className="v12Shell">
      <Sidebar />

      <main className="v12Main">
        <Topbar
          title="Rise/Fall + Touch Analyzer"
          subtitle="Live signal analysis · manual execution only"
          connected={connected}
          connecting={status === "CONNECTING" || loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {statusDetail ? (
          <div className="v12Error">{statusDetail}</div>
        ) : null}

        <section className="v12Toolbar">
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

          <div className={`v12Live ${connected ? "on" : ""}`}>
            <i />
            {connected ? "DERIV LIVE" : status}
          </div>
        </section>

        <section className="v12Top">
          <article className={`v12SignalCard ${best.valid ? "valid" : ""}`}>
            <span>AI SIGNAL</span>
            <div className="v12SignalState">
              <strong>{best.valid ? "ENTRY VALID" : "WAIT"}</strong>
              <b>{best.signal}</b>
            </div>
            <div className="v12SignalMeta">
              <p><span>Confidence</span><b>{best.confidence.toFixed(1)}%</b></p>
              <p><span>Window</span><b>{durationLabel}</b></p>
              <p><span>Strength</span><b>{quality.label}</b></p>
            </div>
          </article>

          <article className="v12QualityCard">
            <span>TRADE QUALITY</span>
            <strong>{quality.grade}</strong>
            <b>{quality.label}</b>
            <small>{best.valid ? "Setup active" : "Wait for confirmation"}</small>
          </article>

          <article className="v12CountdownCard">
            <span>COUNTDOWN</span>
            <strong>
              {unit === "ticks"
                ? `${windowRecords.length} / ${duration}`
                : `${remaining.toFixed(1)}s`}
            </strong>
            <small>
              {unit === "ticks" ? "ticks collected" : "remaining"}
            </small>

            <div className="v12Progress">
              <i style={{ width: `${progress}%` }} />
            </div>
          </article>
        </section>

        <section className="v12ChartSection">
          <div className="v12ChartHead">
            <div>
              <span>LIVE CHART</span>
              <h3>{derivMarketName(symbol, market?.label)}</h3>
            </div>
            <strong>{displayPrice}</strong>
          </div>

          <div className="v12Chart">
            {path ? (
              <svg
                viewBox="0 0 1000 340"
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
                  const pos = markerPosition(marker, chartRecords);
                  if (!pos) return null;

                  const cls = marker.signal
                    .toLowerCase()
                    .replace(/\s+/g, "-");

                  return (
                    <g
                      key={`${marker.ts}-${index}`}
                      className={`v12Marker ${cls}`}
                    >
                      <line
                        x1={pos.x}
                        x2={pos.x}
                        y1="0"
                        y2="340"
                        className="entryLine"
                      />
                      <circle
                        cx={pos.x}
                        cy={pos.y}
                        r="8"
                      />
                      <circle
                        cx={pos.x}
                        cy={pos.y}
                        r="2.8"
                        className="inner"
                      />
                    </g>
                  );
                })}
              </svg>
            ) : (
              <div className="v12Empty">
                Waiting for live market data...
              </div>
            )}
          </div>
        </section>

        <section className="v12LowerGrid">
          <article className="v12ReasonPanel">
            <div className="v12SectionHead">
              <div>
                <span>AI REASON</span>
                <h3>Why this signal?</h3>
              </div>
              <b>{riseFall.signal}</b>
            </div>

            <div className="v12ReasonList">
              <div className={riseFall.reasons.trend ? "pass" : "wait"}>
                <span>{riseFall.reasons.trend ? "✓" : "×"}</span>
                <b>Trend aligned</b>
              </div>
              <div className={riseFall.reasons.momentum ? "pass" : "wait"}>
                <span>{riseFall.reasons.momentum ? "✓" : "×"}</span>
                <b>Momentum confirmed</b>
              </div>
              <div className={riseFall.reasons.volatility ? "pass" : "wait"}>
                <span>{riseFall.reasons.volatility ? "✓" : "×"}</span>
                <b>Volatility acceptable</b>
              </div>
              <div className={riseFall.reasons.pattern ? "pass" : "wait"}>
                <span>{riseFall.reasons.pattern ? "✓" : "×"}</span>
                <b>Pattern consistent</b>
              </div>
            </div>
          </article>

          <article className="v12MiniStats">
            <div>
              <span>TREND</span>
              <strong>{riseFall.trend}</strong>
            </div>
            <div>
              <span>MOMENTUM</span>
              <strong>{riseFall.momentum}</strong>
            </div>
            <div>
              <span>VOLATILITY</span>
              <strong>{riseFall.volatility.toFixed(5)}</strong>
            </div>
            <div>
              <span>RISK</span>
              <strong>{risk}</strong>
            </div>
          </article>

          <article className="v12TouchPanel">
            <div className="v12SectionHead">
              <div>
                <span>TOUCH / NO TOUCH</span>
                <h3>Barrier pressure</h3>
              </div>

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

            <div className="v12TouchBars">
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

            <div className="v12Barriers">
              <p><span>Upper</span><b>{fmt(touch.upperBarrier)}</b></p>
              <p><span>Lower</span><b>{fmt(touch.lowerBarrier)}</b></p>
            </div>
          </article>
        </section>

        <p className="v12Disclaimer">
          Analysis only. Signal strength and confidence are estimates from observed live data, not guaranteed outcomes.
        </p>
      </main>
    </div>
  );
}
