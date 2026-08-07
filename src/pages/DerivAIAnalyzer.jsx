import { useMemo, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import useDerivTicks from "../hooks/useDerivTicks";
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
  const v = mean(values.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

function buildRiseFall(prices = []) {
  const p = prices.map(Number).filter(Number.isFinite);
  const short = p.slice(-12);
  const medium = p.slice(-35);
  const long = p.slice(-90);

  if (short.length < 5) {
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

  const slope = (arr) =>
    arr.length >= 2 ? arr[arr.length - 1] - arr[0] : 0;

  const s = slope(short);
  const m = slope(medium);
  const l = slope(long);

  const diffs = short.slice(1).map((x, i) => x - short[i]);
  const up = diffs.filter((d) => d > 0).length;
  const down = diffs.filter((d) => d < 0).length;
  const consistency = diffs.length
    ? Math.max(up, down) / diffs.length * 100
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
  const confidence = clamp(agreement * 0.58 + consistency * 0.42);

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

function buildTouchNoTouch(prices = [], barrierDistance = 1.5, horizon = 10) {
  const p = prices.map(Number).filter(Number.isFinite);
  if (p.length < 20) {
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
  const recent = p.slice(-60);
  const diffs = recent.slice(1).map((x, i) => x - recent[i]);
  const sigma = std(diffs);
  const expectedMove = sigma * Math.sqrt(Math.max(1, horizon));
  const distance = Math.max(
    sigma * Number(barrierDistance || 1.5),
    Math.abs(current) * 0.00001
  );

  const upperBarrier = current + distance;
  const lowerBarrier = current - distance;

  const recentRange = Math.max(...recent) - Math.min(...recent);
  const rangeRatio = distance > 0 ? recentRange / distance : 0;

  // Heuristic, not a contract price/probability:
  // higher expected movement relative to selected barrier -> more touch-like conditions.
  const moveRatio = distance > 0 ? expectedMove / distance : 0;
  const touchScore = clamp(moveRatio * 62 + Math.min(1.5, rangeRatio) * 18);
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
    prices = [],
    currentPrice,
    connect,
    disconnect,
    changeSymbol,
  } = deriv;

  const [barrierDistance, setBarrierDistance] = useState(1.5);
  const [horizon, setHorizon] = useState(10);

  const riseFall = useMemo(
    () => buildRiseFall(prices),
    [prices]
  );

  const touchNoTouch = useMemo(
    () => buildTouchNoTouch(prices, barrierDistance, horizon),
    [prices, barrierDistance, horizon]
  );

  const enoughRise = prices.length >= 35;
  const enoughTouch = prices.length >= 20;

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

  const displayPrice =
    Number.isFinite(Number(currentPrice))
      ? Number(currentPrice).toFixed(market?.decimals ?? 2)
      : "—";

  const fmt = (value) =>
    Number.isFinite(Number(value))
      ? Number(value).toFixed(market?.decimals ?? 2)
      : "—";

  return (
    <div className="rfTouchShell">
      <Sidebar />

      <main className="rfTouchMain">
        <Topbar
          title="Rise/Fall + Touch Analyzer"
          subtitle="Focused live market analysis — manual execution only"
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
                  {m.label || m.symbol}
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
            <p>{bestMode}</p>
          </article>

          <article>
            <span>CURRENT PRICE</span>
            <h2>{displayPrice}</h2>
            <p>{market?.label || symbol || "—"}</p>
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
              <div><span>Trend</span><b>{riseFall.trend}</b></div>
              <div><span>Momentum</span><b>{riseFall.momentum}</b></div>
              <div><span>Directional consistency</span><b>{riseFall.consistency.toFixed(1)}%</b></div>
              <div><span>Short slope</span><b>{riseFall.slope.toFixed(5)}</b></div>
              <div><span>Volatility</span><b>{riseFall.volatility.toFixed(5)}</b></div>
              <div><span>Samples</span><b>{prices.length}</b></div>
            </div>

            <div className="rfTouchReason">
              <span>READ</span>
              <p>
                {riseFall.signal === "WAIT"
                  ? "Short, medium and longer directional windows are not aligned strongly enough yet."
                  : `${riseFall.signal} is leading because recent price direction and tick consistency are aligned. Confidence updates every tick.`}
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
                  <option value={1}>Near · 1.0σ</option>
                  <option value={1.5}>Normal · 1.5σ</option>
                  <option value={2}>Far · 2.0σ</option>
                  <option value={2.5}>Very far · 2.5σ</option>
                </select>
              </label>

              <label>
                <span>Analysis horizon</span>
                <select
                  value={horizon}
                  onChange={(e) => setHorizon(Number(e.target.value))}
                >
                  <option value={5}>5 ticks</option>
                  <option value={10}>10 ticks</option>
                  <option value={20}>20 ticks</option>
                  <option value={50}>50 ticks</option>
                </select>
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

            <div className="rfTouchReason">
              <span>READ</span>
              <p>
                {touchNoTouch.signal === "WAIT"
                  ? "Barrier pressure is balanced. The analyzer is waiting for a clearer movement-vs-distance imbalance."
                  : `${touchNoTouch.signal} currently has the stronger movement-vs-barrier score for the selected horizon. This is an analytical heuristic, not a guaranteed contract probability.`}
              </p>
            </div>
          </article>
        </section>

        <section className="rfTouchBottom">
          <div>
            <span>RISE/FALL STATUS</span>
            <strong>{riseValid ? `${riseFall.signal} VALID` : "WAIT"}</strong>
          </div>
          <div>
            <span>TOUCH STATUS</span>
            <strong>{touchValid ? `${touchNoTouch.signal} VALID` : "WAIT"}</strong>
          </div>
          <div>
            <span>BEST MODE</span>
            <strong>{bestMode}</strong>
          </div>
          <div>
            <span>BEST CONFIDENCE</span>
            <strong>{bestConfidence.toFixed(1)}%</strong>
          </div>
        </section>

        <p className="rfTouchDisclaimer">
          Analysis only. Scores are live-data heuristics and do not guarantee a trading outcome.
        </p>
      </main>
    </div>
  );
}
