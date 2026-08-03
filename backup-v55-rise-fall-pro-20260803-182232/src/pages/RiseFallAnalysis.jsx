import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeRiseFall } from "../analysis/riseFallAnalysisEngine";
import "../styles/RiseFallAnalysis.css";

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function num(value, digits = 5) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
}

function MiniChart({ points = [], signal = "WAIT" }) {
  const values = points.map((point) => Number(point.quote)).filter(Number.isFinite);
  if (values.length < 2) return <div className="rfEmptyChart">Waiting for live prices…</div>;
  const width = 900;
  const height = 240;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(0.00001, max - min);
  const coordinates = values.map((value, index) => {
    const x = index / Math.max(1, values.length - 1) * width;
    const y = height - ((value - min) / range) * (height - 26) - 13;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <div className={`rfChart ${signal.toLowerCase()}`}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
        <defs>
          <linearGradient id="rfFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity=".25" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polyline points={coordinates} fill="none" stroke="currentColor" strokeWidth="5" vectorEffect="non-scaling-stroke" />
        <polygon points={`0,${height} ${coordinates} ${width},${height}`} fill="url(#rfFill)" />
      </svg>
      <span>{num(min)}</span><span>{num(max)}</span>
    </div>
  );
}

export default function RiseFallAnalysis() {
  const {
    markets = [], market = null, symbol = "", connected = false,
    loadingMarket = false, prices = [], currentPrice = null,
    connect, disconnect, changeSymbol,
  } = useDerivTicks();
  const [mode, setMode] = useState("15s");
  const [feedMessage, setFeedMessage] = useState("Connecting live feed…");
  const connectingRef = useRef(false);

  useEffect(() => {
    if (connected || connectingRef.current || typeof connect !== "function") return;
    connectingRef.current = true;
    Promise.resolve(connect())
      .then(() => setFeedMessage("Deriv live feed requested."))
      .catch((error) => setFeedMessage(error instanceof Error ? error.message : "Feed connection failed."))
      .finally(() => { connectingRef.current = false; });
  }, [connected, connect]);

  const analysis15 = useMemo(() => analyzeRiseFall(prices, "15s"), [prices]);
  const analysis10 = useMemo(() => analyzeRiseFall(prices, "10ticks"), [prices]);
  const active = mode === "15s" ? analysis15 : analysis10;

  return (
    <div className="appShell">
      <Sidebar />
      <main className="mainContent rfPage">
        <Topbar
          title="EdgePilot V54 · Rise/Fall Analysis"
          subtitle="Standalone 15-second and 10-tick directional intelligence"
          connected={connected}
          connecting={false}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="rfToolbar">
          <MarketSelector markets={markets} value={symbol} disabled={loadingMarket} onChange={changeSymbol} />
          <div className="rfModeSwitch">
            <button className={mode === "15s" ? "active" : ""} onClick={() => setMode("15s")}>15 SECONDS</button>
            <button className={mode === "10ticks" ? "active" : ""} onClick={() => setMode("10ticks")}>10 TICKS</button>
          </div>
        </section>

        <div className={`rfFeed ${connected ? "live" : "waiting"}`}>
          {connected ? `LIVE FEED · ${market?.label || symbol}` : feedMessage}
        </div>

        <section className={`rfHero ${active.signal.toLowerCase()}`}>
          <div>
            <small>ACTIVE {mode === "15s" ? "15-SECOND" : "10-TICK"} SIGNAL</small>
            <h1>{active.signal}</h1>
            <p>{active.reason}</p>
          </div>
          <div className="rfHeroStats">
            <div><small>Confidence</small><strong>{pct(active.confidence)}</strong></div>
            <div><small>Risk</small><strong>{active.risk}</strong></div>
            <div><small>Samples</small><strong>{active.samples || 0}</strong></div>
            <div><small>Price</small><strong>{num(currentPrice)}</strong></div>
          </div>
        </section>

        <section className="rfGrid">
          <article className="rfPanel rfChartPanel">
            <div className="rfPanelHead"><div><small>PRICE ACTION</small><h2>{mode === "15s" ? "Last 15 seconds" : "Last 10 ticks"}</h2></div><span>{active.rawDirection || "WAIT"}</span></div>
            <MiniChart points={active.points} signal={active.signal} />
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead"><div><small>MULTI-WINDOW MOMENTUM</small><h2>Direction agreement</h2></div></div>
            <div className="rfMomentum">
              <div><span>Fast 3</span><strong>{num(active.momentum?.fast, 6)}</strong><i className={Number(active.momentum?.fast) >= 0 ? "up" : "down"} /></div>
              <div><span>Medium 5</span><strong>{num(active.momentum?.medium, 6)}</strong><i className={Number(active.momentum?.medium) >= 0 ? "up" : "down"} /></div>
              <div><span>Slow 10</span><strong>{num(active.momentum?.slow, 6)}</strong><i className={Number(active.momentum?.slow) >= 0 ? "up" : "down"} /></div>
            </div>
            <div className="rfVotes"><span>RISE votes <strong>{active.riseVotes || 0}/3</strong></span><span>FALL votes <strong>{active.fallVotes || 0}/3</strong></span></div>
          </article>
        </section>

        <section className="rfMetrics">
          <article><small>Net move</small><strong>{num(active.netMove, 6)}</strong><p>Difference between first and latest price.</p></article>
          <article><small>Linear slope</small><strong>{num(active.slope, 7)}</strong><p>Overall direction of the selected window.</p></article>
          <article><small>Consistency</small><strong>{pct(active.consistency)}</strong><p>Percentage of moves agreeing with one direction.</p></article>
          <article><small>Volatility</small><strong>{num(active.volatility, 7)}</strong><p>Noise level across fresh price changes.</p></article>
          <article><small>Reversals</small><strong>{active.reversalCount || 0}</strong><p>Direction changes that reduce signal quality.</p></article>
          <article><small>Decision</small><strong>{active.ready ? "READY" : "WAIT"}</strong><p>Ready requires aligned slope, momentum and consistency.</p></article>
        </section>

        <section className="rfCompare">
          <article className={analysis15.signal.toLowerCase()}><small>15 SECONDS</small><strong>{analysis15.signal}</strong><span>{pct(analysis15.confidence)}</span><p>{analysis15.reason}</p></article>
          <article className={analysis10.signal.toLowerCase()}><small>10 TICKS</small><strong>{analysis10.signal}</strong><span>{pct(analysis10.confidence)}</span><p>{analysis10.reason}</p></article>
          <article className="consensus"><small>CONSENSUS</small><strong>{analysis15.signal !== "WAIT" && analysis15.signal === analysis10.signal ? analysis15.signal : "WAIT"}</strong><span>{analysis15.signal === analysis10.signal ? "ALIGNED" : "MIXED"}</span><p>Strongest signal appears when both windows agree.</p></article>
        </section>
      </main>
    </div>
  );
}
