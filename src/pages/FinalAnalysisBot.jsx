import { useEffect, useMemo, useRef, useState } from "react";
import { analyseTicks } from "../analysis/finalAnalysisEngine";
import useFinalDerivTicks from "../hooks/useFinalDerivTicks";
import "./FinalAnalysisBot.css";

const MARKETS = [
  ["R_10", "Volatility 10"],
  ["R_25", "Volatility 25"],
  ["R_50", "Volatility 50"],
  ["R_75", "Volatility 75"],
  ["R_100", "Volatility 100"],
  ["1HZ10V", "Volatility 10 (1s)"],
  ["1HZ25V", "Volatility 25 (1s)"],
  ["1HZ50V", "Volatility 50 (1s)"],
  ["1HZ75V", "Volatility 75 (1s)"],
  ["1HZ100V", "Volatility 100 (1s)"],
];

const money = (value) =>
  Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function Metric({ label, value }) {
  return (
    <div className="final-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function FinalAnalysisBot() {
  const [symbol, setSymbol] = useState("R_75");
  const [stake, setStake] = useState(1);
  const [minimumConfidence, setMinimumConfidence] = useState(82);
  const [paperMode, setPaperMode] = useState(true);
  const [running, setRunning] = useState(false);
  const [journal, setJournal] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [openTrade, setOpenTrade] = useState(null);
  const lastDecisionRef = useRef("");
  const tradeLockRef = useRef(false);

  const { ticks, status, error, reconnect } = useFinalDerivTicks(symbol);
  const analysis = useMemo(() => analyseTicks(ticks), [ticks]);
  const quote = ticks.at(-1) || 0;

  const stats = useMemo(() => {
    const wins = transactions.filter((item) => item.result === "WON").length;
    const losses = transactions.filter((item) => item.result === "LOST").length;
    const profit = transactions.reduce((sum, item) => sum + item.profit, 0);
    return {
      runs: transactions.length,
      wins,
      losses,
      profit,
      rate: transactions.length ? Math.round((wins / transactions.length) * 100) : 0,
    };
  }, [transactions]);

  useEffect(() => {
    const key = `${analysis.decision}-${analysis.contract}-${analysis.confidence}-${analysis.reason}`;
    if (!analysis.ready || key === lastDecisionRef.current) return;
    lastDecisionRef.current = key;

    setJournal((current) =>
      [
        {
          id: crypto.randomUUID(),
          time: new Date().toLocaleTimeString(),
          decision: analysis.decision,
          contract: analysis.contract,
          confidence: analysis.confidence,
          reason: analysis.reason,
        },
        ...current,
      ].slice(0, 40)
    );
  }, [analysis]);

  useEffect(() => {
    if (!running || !paperMode || openTrade || tradeLockRef.current) return;
    if (analysis.decision !== "BUY") return;
    if (analysis.confidence < minimumConfidence) return;
    if (!quote) return;

    tradeLockRef.current = true;
    const trade = {
      id: crypto.randomUUID(),
      symbol,
      market: MARKETS.find(([value]) => value === symbol)?.[1] || symbol,
      contract: analysis.contract,
      entry: quote,
      stake: Number(stake),
      confidence: analysis.confidence,
      openedAt: new Date().toLocaleTimeString(),
      entryTickCount: ticks.length,
    };
    setOpenTrade(trade);
    setTimeout(() => {
      tradeLockRef.current = false;
    }, 1500);
  }, [
    analysis,
    minimumConfidence,
    openTrade,
    paperMode,
    quote,
    running,
    stake,
    symbol,
    ticks.length,
  ]);

  useEffect(() => {
    if (!openTrade || ticks.length <= openTrade.entryTickCount + 4) return;

    const exit = quote;
    const directionWon =
      openTrade.contract === "RISE"
        ? exit > openTrade.entry
        : exit < openTrade.entry;
    const profit = directionWon
      ? Number(openTrade.stake) * 0.92
      : -Number(openTrade.stake);

    setTransactions((current) =>
      [
        {
          ...openTrade,
          exit,
          result: directionWon ? "WON" : "LOST",
          profit,
          closedAt: new Date().toLocaleTimeString(),
        },
        ...current,
      ].slice(0, 100)
    );
    setOpenTrade(null);
  }, [openTrade, quote, ticks.length]);

  return (
    <main className="final-bot-shell">
      <header className="final-topbar">
        <div>
          <p className="final-kicker">STANDALONE ANALYSIS DASHBOARD</p>
          <h1>EdgePilot Final AI</h1>
          <p>Live analysis, decisions, journal and paper transactions.</p>
        </div>

        <div className="final-feed">
          <span className={`final-dot final-dot-${status.toLowerCase()}`} />
          <div>
            <small>Deriv feed</small>
            <strong>{status}</strong>
          </div>
          {status !== "LIVE" && <button onClick={reconnect}>Reconnect</button>}
        </div>
      </header>

      {error && <div className="final-alert">{error}</div>}

      <section className="final-control-grid">
        <label>
          Market
          <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
            {MARKETS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>

        <label>
          Stake
          <input
            min="0.35"
            step="0.01"
            type="number"
            value={stake}
            onChange={(event) => setStake(event.target.value)}
          />
        </label>

        <label>
          Minimum confidence
          <input
            min="60"
            max="95"
            type="number"
            value={minimumConfidence}
            onChange={(event) => setMinimumConfidence(Number(event.target.value))}
          />
        </label>

        <label>
          Mode
          <select value={paperMode ? "paper" : "analysis"} onChange={(event) => setPaperMode(event.target.value === "paper")}>
            <option value="paper">Paper trading</option>
            <option value="analysis">Analysis only</option>
          </select>
        </label>

        <button
          className={running ? "final-stop" : "final-start"}
          onClick={() => setRunning((value) => !value)}
        >
          {running ? "Stop scanner" : "Run scanner"}
        </button>
      </section>

      <section className="final-hero-grid">
        <article className={`final-decision final-decision-${analysis.decision.toLowerCase()}`}>
          <div className="final-decision-head">
            <span>AI DECISION</span>
            <strong>{analysis.decision}</strong>
          </div>
          <div className="final-contract">{analysis.contract}</div>
          <p>{analysis.reason}</p>
          <div className="final-score-row">
            <div><small>Confidence</small><strong>{analysis.confidence}%</strong></div>
            <div><small>Probability</small><strong>{analysis.probability}%</strong></div>
            <div><small>Risk</small><strong>{analysis.risk}</strong></div>
            <div><small>Live quote</small><strong>{quote || "—"}</strong></div>
          </div>
        </article>

        <article className="final-open-card">
          <span>ACTIVE PAPER TRADE</span>
          {openTrade ? (
            <>
              <strong>{openTrade.contract} · {openTrade.market}</strong>
              <p>Entry {openTrade.entry} · Stake ${money(openTrade.stake)}</p>
              <small>Closes after 5 live ticks</small>
            </>
          ) : (
            <>
              <strong>No open trade</strong>
              <p>{running ? "Scanner is waiting for a qualified entry." : "Start the scanner."}</p>
            </>
          )}
        </article>
      </section>

      <section className="final-metrics-grid">
        <Metric label="Momentum" value={analysis.metrics.momentum} />
        <Metric label="Trend" value={analysis.metrics.trend} />
        <Metric label="Volatility" value={analysis.metrics.volatility} />
        <Metric label="Entropy" value={`${analysis.metrics.entropy}%`} />
        <Metric label="Bayesian" value={`${analysis.metrics.bayesian}%`} />
        <Metric label="Transition" value={`${analysis.metrics.transition}%`} />
        <Metric label="Observed cycle" value={analysis.metrics.cycle || "None"} />
        <Metric label="Regime" value={analysis.metrics.regime} />
      </section>

      <section className="final-stats-grid">
        <Metric label="Runs" value={stats.runs} />
        <Metric label="Wins" value={stats.wins} />
        <Metric label="Losses" value={stats.losses} />
        <Metric label="Win rate" value={`${stats.rate}%`} />
        <Metric label="Net P/L" value={`${stats.profit >= 0 ? "+" : ""}$${money(stats.profit)}`} />
      </section>

      <section className="final-bottom-grid">
        <article className="final-panel">
          <div className="final-panel-title">
            <div>
              <span>TRANSACTIONS</span>
              <h2>Paper trade results</h2>
            </div>
            <button onClick={() => setTransactions([])}>Clear</button>
          </div>

          <div className="final-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Market</th>
                  <th>Contract</th>
                  <th>Entry / Exit</th>
                  <th>Confidence</th>
                  <th>Result</th>
                  <th>P/L</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((item) => (
                  <tr key={item.id}>
                    <td>{item.closedAt}</td>
                    <td>{item.market}</td>
                    <td>{item.contract}</td>
                    <td>{item.entry} / {item.exit}</td>
                    <td>{item.confidence}%</td>
                    <td className={item.result === "WON" ? "final-win" : "final-loss"}>{item.result}</td>
                    <td className={item.profit >= 0 ? "final-win" : "final-loss"}>
                      {item.profit >= 0 ? "+" : ""}${money(item.profit)}
                    </td>
                  </tr>
                ))}
                {!transactions.length && (
                  <tr><td colSpan="7" className="final-empty">No transactions yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </article>

        <article className="final-panel">
          <div className="final-panel-title">
            <div>
              <span>DECISION JOURNAL</span>
              <h2>Why the AI waited or entered</h2>
            </div>
            <button onClick={() => setJournal([])}>Clear</button>
          </div>

          <div className="final-journal">
            {journal.map((item) => (
              <div key={item.id} className="final-journal-row">
                <time>{item.time}</time>
                <strong>{item.decision}</strong>
                <span>{item.contract}</span>
                <span>{item.confidence}%</span>
                <p>{item.reason}</p>
              </div>
            ))}
            {!journal.length && <div className="final-empty">Collecting live data…</div>}
          </div>
        </article>
      </section>

      <footer className="final-disclaimer">
        This build uses live market data but executes paper trades only. A high confidence score is not a guarantee of profit.
      </footer>
    </main>
  );
}
