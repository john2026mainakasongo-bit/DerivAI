import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import useDerivTicks from "../hooks/useDerivTicks";
import { derivMarketName } from "../utils/derivMarketName";
import "./DerivAIAnalyzer.css";

const clamp = (n, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Number(n) || 0));

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values = []) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((x) => (x - m) ** 2)));
}

function buildRiseFall(prices = []) {
  const p = prices.map(Number).filter(Number.isFinite);

  if (p.length < 5) {
    return {
      signal: "WAIT",
      confidence: 0,
      momentum: "COLLECTING",
      trend: "COLLECTING",
      slope: 0,
      consistency: 0,
      volatility: 0,
    };
  }

  const shortLen = Math.max(5, Math.floor(p.length * 0.30));
  const mediumLen = Math.max(shortLen, Math.floor(p.length * 0.65));

  const short = p.slice(-shortLen);
  const medium = p.slice(-mediumLen);
  const long = p;

  const slope = (arr) =>
    arr.length >= 2 ? arr[arr.length - 1] - arr[0] : 0;

  const s = slope(short);
  const m = slope(medium);
  const l = slope(long);

  const diffs = short.slice(1).map((x, i) => x - short[i]);
  const up = diffs.filter((d) => d > 0).length;
  const down = diffs.filter((d) => d < 0).length;
  const consistency = diffs.length
    ? (Math.max(up, down) / diffs.length) * 100
    : 0;

  const directionScore =
    (s > 0 ? 1 : s < 0 ? -1 : 0) * 0.5 +
    (m > 0 ? 1 : m < 0 ? -1 : 0) * 0.3 +
    (l > 0 ? 1 : l < 0 ? -1 : 0) * 0.2;

  const signal =
    Math.abs(directionScore) < 0.45
      ? "WAIT"
      : directionScore > 0
        ? "RISE"
        : "FALL";

  const agreement = Math.abs(directionScore) * 100;
  const confidence = clamp(
    agreement * 0.58 + consistency * 0.42
  );

  return {
    signal,
    confidence,
    momentum: s > 0 ? "UP" : s < 0 ? "DOWN" : "FLAT",
    trend: m > 0 ? "BULLISH" : m < 0 ? "BEARISH" : "SIDEWAYS",
    slope: s,
    consistency,
    volatility: std(diffs),
  };
}

function buildTouchNoTouch(prices = [], barrierDistance = 1.5) {
  const p = prices.map(Number).filter(Number.isFinite);

  if (p.length < 8) {
    return {
      signal: "WAIT",
      confidence: 0,
      upperBarrier: null,
      lowerBarrier: null,
      expectedMove: 0,
      range: 0,
      touchScore: 0,
      noTouchScore: 0,
    };
  }

  const current = p[p.length - 1];
  const recent = p.slice(-Math.min(80, p.length));
  const diffs = recent.slice(1).map((x, i) => x - recent[i]);
  const sigma = std(diffs);

  const expectedMove = sigma * Math.sqrt(Math.max(1, recent.length));
  const distance = Math.max(
    sigma * Number(barrierDistance || 1.5),
    Math.abs(current) * 0.00001
  );

  const upperBarrier = current + distance;
  const lowerBarrier = current - distance;

  const recentRange = Math.max(...recent) - Math.min(...recent);
  const moveRatio = distance > 0 ? expectedMove / distance : 0;
  const rangeRatio = distance > 0 ? recentRange / distance : 0;

  const touchScore = clamp(
    moveRatio * 58 + Math.min(1.5, rangeRatio) * 18
  );
  const noTouchScore = clamp(100 - touchScore);

  const signal =
    Math.max(touchScore, noTouchScore) < 62
      ? "WAIT"
      : touchScore > noTouchScore
        ? "TOUCH"
        : "NO TOUCH";

  return {
    signal,
    confidence: Math.max(touchScore, noTouchScore),
    upperBarrier,
    lowerBarrier,
    expectedMove,
    range: recentRange,
    touchScore,
    noTouchScore,
  };
}

function chartPath(records, width = 1000, height = 280) {
  if (!records?.length || records.length < 2) return "";

  const values = records.map((r) => Number(r.price)).filter(Number.isFinite);
  if (values.length < 2) return "";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const firstTs = records[0].ts;
  const lastTs = records[records.length - 1].ts;
  const timeRange = Math.max(1, lastTs - firstTs);

  return records
    .map((r, i) => {
      const x = ((r.ts - firstTs) / timeRange) * width;
      const y =
        height -
        ((Number(r.price) - min) / range) * (height - 24) -
        12;

      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function markerPosition(marker, records, width = 1000, height = 280) {
  if (!marker || !records?.length) return null;

  const values = records.map((r) => Number(r.price)).filter(Number.isFinite);
  if (!values.length) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const firstTs = records[0].ts;
  const lastTs = records[records.length - 1].ts;
  const timeRange = Math.max(1, lastTs - firstTs);

  if (marker.ts < firstTs || marker.ts > lastTs) return null;

  const x = ((marker.ts - firstTs) / timeRange) * width;
  const y =
    height -
    ((Number(marker.price) - min) / range) * (height - 24) -
    12;

  return { x, y };
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

  const [durationUnit, setDurationUnit] = useState("ticks");
  const [durationValue, setDurationValue] = useState(10);
  const [barrierDistance, setBarrierDistance] = useState(1.5);

  const [records, setRecords] = useState([]);
  const [signalMarkers, setSignalMarkers] = useState([]);

  const lastRecordedPrice = useRef(null);
  const lastMarkerKey = useRef("");

  useEffect(() => {
    if (!connected || !Number.isFinite(Number(currentPrice))) return;

    const numeric = Number(currentPrice);

    // Some feeds can repeat the exact same quote. Keep it if enough time passed,
    // but avoid immediate duplicate React updates.
    const now = Date.now();
    const previous = lastRecordedPrice.current;

    if (
      previous &&
      previous.price === numeric &&
      now - previous.ts < 100
    ) {
      return;
    }

    lastRecordedPrice.current = { price: numeric, ts: now };

    setRecords((old) => [
      ...old.slice(-599),
      {
        price: numeric,
        ts: now,
        symbol,
      },
    ]);
  }, [currentPrice, connected, symbol]);

  useEffect(() => {
    // Do not mix records from a previous market with a newly selected market.
    setRecords([]);
    setSignalMarkers([]);
    lastMarkerKey.current = "";
    lastRecordedPrice.current = null;
  }, [symbol]);

  const durationRecords = useMemo(() => {
    if (!records.length) return [];

    if (durationUnit === "ticks") {
      return records.slice(-Math.max(5, Number(durationValue)));
    }

    const cutoff = Date.now() - Number(durationValue) * 1000;
    return records.filter((r) => r.ts >= cutoff);
  }, [records, durationUnit, durationValue]);

  const durationPrices = useMemo(
    () => durationRecords.map((r) => r.price),
    [durationRecords]
  );

  const riseFall = useMemo(
    () => buildRiseFall(durationPrices),
    [durationPrices]
  );

  const touchNoTouch = useMemo(
    () => buildTouchNoTouch(durationPrices, barrierDistance),
    [durationPrices, barrierDistance]
  );

  const enoughRise = durationPrices.length >= 8;
  const enoughTouch = durationPrices.length >= 8;

  const riseValid =
    connected &&
    enoughRise &&
    riseFall.signal !== "WAIT" &&
    riseFall.confidence >= 72;

  const touchValid =
    connected &&
    enoughTouch &&
    touchNoTouch.signal !== "WAIT" &&
    touchNoTouch.confidence >= 70;

  const bestMode =
    riseFall.confidence >= touchNoTouch.confidence
      ? "RISE/FALL"
      : "TOUCH/NO TOUCH";

  const bestSignal =
    bestMode === "RISE/FALL"
      ? riseFall.signal
      : touchNoTouch.signal;

  const bestConfidence =
    bestMode === "RISE/FALL"
      ? riseFall.confidence
      : touchNoTouch.confidence;

  const bestValid =
    bestMode === "RISE/FALL"
      ? riseValid
      : touchValid;

  useEffect(() => {
    if (!bestValid || !records.length) return;

    const last = records[records.length - 1];
    const key = `${symbol}:${bestMode}:${bestSignal}:${Math.round(bestConfidence)}:${last.ts}`;

    // Only add a new marker when signal/mode changed, or after a small cooldown.
    const previous = signalMarkers[signalMarkers.length - 1];
    const sameSignal =
      previous &&
      previous.signal === bestSignal &&
      previous.mode === bestMode;

    if (sameSignal && last.ts - previous.ts < 2500) return;
    if (lastMarkerKey.current === key) return;

    lastMarkerKey.current = key;

    setSignalMarkers((old) => [
      ...old.slice(-39),
      {
        ts: last.ts,
        price: last.price,
        signal: bestSignal,
        mode: bestMode,
        confidence: bestConfidence,
      },
    ]);
  }, [
    bestValid,
    bestMode,
    bestSignal,
    bestConfidence,
    records,
    symbol,
    signalMarkers,
  ]);

  const chartRecords = useMemo(
    () => records.slice(-120),
    [records]
  );

  const path = useMemo(
    () => chartPath(chartRecords),
    [chartRecords]
  );

  const displayPrice =
    Number.isFinite(Number(currentPrice))
      ? Number(currentPrice).toFixed(market?.decimals ?? 2)
      : "â€”";

  const fmt = (value) =>
    Number.isFinite(Number(value))
      ? Number(value).toFixed(market?.decimals ?? 2)
      : "â€”";

  const durationLabel =
    durationUnit === "ticks"
      ? `${durationValue} ticks`
      : `${durationValue}s`;

  const durationOptions =
    durationUnit === "ticks"
      ? [5, 10, 20, 50, 100]
      : [5, 10, 15, 30, 60];

  return (
    <div className="rfTouchShell">
      <Sidebar />

      <main className="rfTouchMain">
        <Topbar
          title="Rise/Fall + Touch Analyzer"
          subtitle="Live chart, tick/second windows and visible signal entries"
          connected={connected}
          connecting={status === "CONNECTING" || loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {statusDetail ? (
          <div className="rfTouchError">{statusDetail}</div>
        ) : null}

        <section className="rfTouchToolbar">
          <div>
            <span>MARKET</span>
            <select
              value={symbol || ""}
              disabled={loadingMarket}
              onChange={(e) => changeSymbol(e.target.value)}
            >
              {markets.map((m) => (
                <option key={m.symbol} value={m.symbol}>
                  {derivMarketName(m.symbol, m.label)}
                </option>
              ))}
            </select>
          </div>

          <div className="rfDurationControls">
            <span>DURATION</span>

            <select
              value={durationUnit}
              onChange={(e) => {
                const unit = e.target.value;
                setDurationUnit(unit);
                setDurationValue(unit === "ticks" ? 10 : 10);
              }}
            >
              <option value="ticks">Ticks</option>
              <option value="seconds">Seconds</option>
            </select>

            <select
              value={durationValue}
              onChange={(e) => setDurationValue(Number(e.target.value))}
            >
              {durationOptions.map((v) => (
                <option key={v} value={v}>
                  {durationUnit === "ticks" ? `${v} ticks` : `${v} sec`}
                </option>
              ))}
            </select>
          </div>

          <div className={`rfTouchLive ${connected ? "on" : ""}`}>
            <i />
            {connected ? "DERIV LIVE" : status}
          </div>
        </section>

        <section className="rfTouchHero">
          <article className={`rfTouchBest ${bestValid ? "valid" : ""}`}>
            <span>BEST CURRENT SETUP</span>
            <h2>{bestValid ? bestSignal : "WAIT"}</h2>
            <strong>{bestConfidence.toFixed(1)}%</strong>
            <p>{bestMode} Â· {durationLabel}</p>
          </article>

          <article>
            <span>CURRENT PRICE</span>
            <h2>{displayPrice}</h2>
            <p>{derivMarketName(symbol, market?.label)}</p>
          </article>

          <article>
            <span>RISE/FALL</span>
            <h2>{riseFall.signal}</h2>
            <strong>{riseFall.confidence.toFixed(1)}%</strong>
          </article>

          <article>
            <span>TOUCH/NO TOUCH</span>
            <h2>{touchNoTouch.signal}</h2>
            <strong>{touchNoTouch.confidence.toFixed(1)}%</strong>
          </article>
        </section>

        <section className="rfLiveChartPanel">
          <div className="rfTouchPanelHead">
            <div>
              <span>LIVE SIGNAL CHART</span>
              <h3>{derivMarketName(symbol, market?.label)} Â· {durationLabel}</h3>
            </div>

            <div className="rfChartLegend">
              <span className="rise">RISE</span>
              <span className="fall">FALL</span>
              <span className="touch">TOUCH</span>
              <span className="noTouch">NO TOUCH</span>
            </div>
          </div>

          <div className="rfChartWrap">
            {path ? (
              <svg
                viewBox="0 0 1000 280"
                preserveAspectRatio="none"
                className="rfChartSvg"
              >
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  vectorEffect="non-scaling-stroke"
                />

                {signalMarkers.map((marker, index) => {
                  const pos = markerPosition(marker, chartRecords);
                  if (!pos) return null;

                  const cls = marker.signal
                    .toLowerCase()
                    .replace(/\s+/g, "-");

                  return (
                    <g
                      key={`${marker.ts}-${index}`}
                      className={`rfSignalMarker ${cls}`}
                    >
                      <circle cx={pos.x} cy={pos.y} r="9" />
                      <circle cx={pos.x} cy={pos.y} r="3" className="inner" />
                      <text
                        x={Math.min(930, pos.x + 12)}
                        y={Math.max(18, pos.y - 12)}
                      >
                        {marker.signal} {marker.confidence.toFixed(0)}%
                      </text>
                    </g>
                  );
                })}
              </svg>
            ) : (
              <div className="rfChartEmpty">
                Waiting for live ticks to build chart...
              </div>
            )}
          </div>

          <div className="rfChartFooter">
            <span>Window samples: <b>{durationRecords.length}</b></span>
            <span>Chart samples: <b>{chartRecords.length}</b></span>
            <span>Signal markers: <b>{signalMarkers.length}</b></span>
            <span>Mode: <b>{durationUnit.toUpperCase()}</b></span>
          </div>
        </section>

        <section className="rfTouchGrid">
          <article className={`rfTouchPanel rfPanel ${riseValid ? "valid" : ""}`}>
            <div className="rfTouchPanelHead">
              <div>
                <span>RISE / FALL ANALYSIS</span>
                <h3>Directional setup</h3>
              </div>
              <b>{riseValid ? "ENTRY VALID" : "SCANNING"}</b>
            </div>

            <div className={`rfTouchSignalOrb ${riseValid ? "blink" : ""}`}>
              <strong>{riseFall.signal}</strong>
              <span>{riseFall.confidence.toFixed(1)}%</span>
            </div>

            <div className="rfTouchStats">
              <div><span>Duration</span><b>{durationLabel}</b></div>
              <div><span>Trend</span><b>{riseFall.trend}</b></div>
              <div><span>Momentum</span><b>{riseFall.momentum}</b></div>
              <div><span>Consistency</span><b>{riseFall.consistency.toFixed(1)}%</b></div>
              <div><span>Short slope</span><b>{riseFall.slope.toFixed(5)}</b></div>
              <div><span>Volatility</span><b>{riseFall.volatility.toFixed(5)}</b></div>
            </div>

            <div className="rfTouchReason">
              <span>READ</span>
              <p>
                {riseFall.signal === "WAIT"
                  ? "Directional windows are not aligned strongly enough yet."
                  : `${riseFall.signal} is leading inside the selected ${durationLabel} window. A valid signal is also stamped on the chart.`}
              </p>
            </div>
          </article>

          <article className={`rfTouchPanel touchPanel ${touchValid ? "valid" : ""}`}>
            <div className="rfTouchPanelHead">
              <div>
                <span>TOUCH / NO TOUCH ANALYSIS</span>
                <h3>Barrier pressure</h3>
              </div>
              <b>{touchValid ? "ENTRY VALID" : "SCANNING"}</b>
            </div>

            <div className="rfTouchControls">
              <label>
                <span>Barrier distance</span>
                <select
                  value={barrierDistance}
                  onChange={(e) => setBarrierDistance(Number(e.target.value))}
                >
                  <option value={1}>Near Â· 1.0Ïƒ</option>
                  <option value={1.5}>Normal Â· 1.5Ïƒ</option>
                  <option value={2}>Far Â· 2.0Ïƒ</option>
                  <option value={2.5}>Very far Â· 2.5Ïƒ</option>
                </select>
              </label>

              <label>
                <span>Duration window</span>
                <div className="rfReadonlyDuration">
                  {durationLabel}
                </div>
              </label>
            </div>

            <div className={`rfTouchSignalOrb touch ${touchValid ? "blink" : ""}`}>
              <strong>{touchNoTouch.signal}</strong>
              <span>{touchNoTouch.confidence.toFixed(1)}%</span>
            </div>

            <div className="touchScores">
              <div>
                <span>TOUCH</span>
                <i><b style={{ width: `${touchNoTouch.touchScore}%` }} /></i>
                <strong>{touchNoTouch.touchScore.toFixed(1)}%</strong>
              </div>

              <div>
                <span>NO TOUCH</span>
                <i><b style={{ width: `${touchNoTouch.noTouchScore}%` }} /></i>
                <strong>{touchNoTouch.noTouchScore.toFixed(1)}%</strong>
              </div>
            </div>

            <div className="rfTouchStats">
              <div><span>Upper barrier</span><b>{fmt(touchNoTouch.upperBarrier)}</b></div>
              <div><span>Lower barrier</span><b>{fmt(touchNoTouch.lowerBarrier)}</b></div>
              <div><span>Expected move</span><b>{touchNoTouch.expectedMove.toFixed(5)}</b></div>
              <div><span>Recent range</span><b>{touchNoTouch.range.toFixed(5)}</b></div>
            </div>
          </article>
        </section>

        <section className="rfTouchBottom">
          <div>
            <span>DURATION</span>
            <strong>{durationLabel}</strong>
          </div>
          <div>
            <span>RISE/FALL STATUS</span>
            <strong>{riseValid ? `${riseFall.signal} VALID` : "WAIT"}</strong>
          </div>
          <div>
            <span>TOUCH STATUS</span>
            <strong>{touchValid ? `${touchNoTouch.signal} VALID` : "WAIT"}</strong>
          </div>
          <div>
            <span>BEST SIGNAL</span>
            <strong>{bestValid ? bestSignal : "WAIT"}</strong>
          </div>
        </section>

        <p className="rfTouchDisclaimer">
          Analysis only. Chart markers show when the analyzer's filters became valid; they are not guaranteed outcomes.
        </p>
      </main>
    </div>
  );
}

