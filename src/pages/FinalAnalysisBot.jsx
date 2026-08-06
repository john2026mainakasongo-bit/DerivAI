import { useEffect, useMemo, useRef, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyseTicks } from "../analysis/finalAnalysisEngine";

import "./FinalAnalysisBot.css";

const FINAL_AI_HISTORY_KEY = "edgepilot:final-ai:v8:transactions";
const FINAL_AI_MEMORY_KEY = "edgepilot:final-ai:v8:pattern-memory";

const money = (value) =>
  Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function quoteOf(item) {
  if (typeof item === "number") return item;

  return Number(
    item?.quote ??
      item?.price ??
      item?.tick ??
      item?.value ??
      NaN
  );
}

function contractIdOf(item = {}) {
  return String(
    item?.contract_id ||
      item?.contractId ||
      item?.id ||
      ""
  );
}

function profitOf(item = {}) {
  const value = Number(
    item?.profit ??
      item?.profit_loss ??
      item?.pnl ??
      (Number(item?.sell_price || 0) -
        Number(item?.buy_price || 0))
  );

  return Number.isFinite(value) ? value : 0;
}

function statusOf(item = {}) {
  const raw = String(item?.status || "").toUpperCase();
  const profit = profitOf(item);

  if (
    item?.is_sold ||
    item?.is_expired ||
    ["WON", "LOST", "SOLD", "EXPIRED"].includes(raw)
  ) {
    if (raw === "WON" || raw === "LOST") return raw;
    if (profit > 0) return "WON";
    if (profit < 0) return "LOST";
    return "CLOSED";
  }

  return raw || "OPEN";
}

function Metric({ label, value }) {
  return (
    <article className="final-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

export default function FinalAnalysisBot() {
  const {
    markets = [],
    symbol = "",
    connected = false,
    authenticatedFeed = false,
    loadingMarket = false,
    prices = [],
    currentPrice = null,
    selectedAccountType = "demo",
    selectedAccountId = "",
    openContracts = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
    refreshContract,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState("paper");
  const [stake, setStake] = useState(0.35);
  const [minimumConfidence, setMinimumConfidence] =
    useState(82);
  const [allowReal, setAllowReal] = useState(false);
  const [journal, setJournal] = useState([]);
  const [transactions, setTransactions] = useState(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(FINAL_AI_HISTORY_KEY) || "[]"
      );

      return Array.isArray(saved) ? saved.slice(0, 120) : [];
    } catch {
      return [];
    }
  });
  const [paperTrade, setPaperTrade] = useState(null);
  const [tickSerial, setTickSerial] = useState(0);
  const [adaptiveMemory, setAdaptiveMemory] = useState(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(FINAL_AI_MEMORY_KEY) || "{}"
      );
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  });
  const [message, setMessage] = useState(
    "Final AI is using the shared EdgePilot Deriv connection."
  );
  const [cooldownUntil, setCooldownUntil] = useState(0);

  const lastDecisionRef = useRef("");
  const buyLockRef = useRef(false);
  const trackedContractsRef = useRef(new Set());

  const numericTicks = useMemo(
    () =>
      (Array.isArray(prices) ? prices : [])
        .map(quoteOf)
        .filter(Number.isFinite)
        .slice(-160),
    [prices]
  );

  const liveQuote = Number.isFinite(Number(currentPrice))
    ? Number(currentPrice)
    : numericTicks.at(-1) || 0;

  const analysis = useMemo(
    () => analyseTicks(numericTicks, adaptiveMemory),
    [numericTicks, adaptiveMemory]
  );

  const stats = useMemo(() => {
    const settled = transactions.filter((item) =>
      ["WON", "LOST"].includes(item.result)
    );
    const wins = settled.filter(
      (item) => item.result === "WON"
    ).length;
    const losses = settled.filter(
      (item) => item.result === "LOST"
    ).length;
    const profit = settled.reduce(
      (sum, item) => sum + Number(item.profit || 0),
      0
    );

    return {
      runs: settled.length,
      wins,
      losses,
      profit,
      rate: settled.length
        ? Math.round((wins / settled.length) * 100)
        : 0,
    };
  }, [transactions]);

  const executionReady =
    connected &&
    authenticatedFeed &&
    Boolean(selectedAccountId);

  const previousQuoteRef = useRef(null);

  useEffect(() => {
    if (!Number.isFinite(Number(liveQuote))) return;

    if (
      previousQuoteRef.current !== null &&
      Number(previousQuoteRef.current) !== Number(liveQuote)
    ) {
      setTickSerial((value) => value + 1);
    }

    previousQuoteRef.current = Number(liveQuote);
  }, [liveQuote]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FINAL_AI_HISTORY_KEY,
        JSON.stringify(transactions.slice(0, 120))
      );
    } catch {
      // Storage can be unavailable in private browsing.
    }
  }, [transactions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FINAL_AI_MEMORY_KEY,
        JSON.stringify(adaptiveMemory)
      );
    } catch {
      // Ignore storage errors.
    }
  }, [adaptiveMemory]);

  useEffect(() => {
    if (!analysis.ready) return;

    const key = [
      analysis.decision,
      analysis.contract,
      analysis.confidence,
      analysis.reason,
    ].join("|");

    if (key === lastDecisionRef.current) return;
    lastDecisionRef.current = key;

    setJournal((current) =>
      [
        {
          id: crypto.randomUUID(),
          time: new Date().toLocaleTimeString(),
          decision: analysis.decision,
          contract: analysis.contract,
          confidence: analysis.confidence,
          risk: analysis.risk,
          reason: analysis.reason,
        },
        ...current,
      ].slice(0, 60)
    );
  }, [analysis]);

  useEffect(() => {
    if (
      !running ||
      mode !== "paper" ||
      paperTrade ||
      buyLockRef.current ||
      analysis.decision !== "BUY" ||
      analysis.confidence < minimumConfidence ||
      Date.now() < cooldownUntil ||
      !liveQuote
    ) {
      return;
    }

    buyLockRef.current = true;

    setPaperTrade({
      id: crypto.randomUUID(),
      market: symbol,
      contract: analysis.contract,
      entry: liveQuote,
      stake: Number(stake),
      confidence: analysis.confidence,
      memorySignature:
        analysis.metrics.memorySignature || "",
      entrySerial: tickSerial,
      openedAt: new Date().toLocaleTimeString(),
    });

    setMessage(
      `PAPER ENTRY · ${analysis.contract} · ${analysis.confidence}%`
    );

    window.setTimeout(() => {
      buyLockRef.current = false;
    }, 1400);
  }, [
    analysis,
    liveQuote,
    minimumConfidence,
    mode,
    numericTicks.length,
    paperTrade,
    running,
    stake,
    symbol,
    tickSerial,
    cooldownUntil,
  ]);

  useEffect(() => {
    if (
      !paperTrade ||
      tickSerial <= Number(paperTrade.entrySerial || 0) + 4
    ) {
      return;
    }

    const exit = liveQuote;
    const won =
      paperTrade.contract === "RISE"
        ? exit > paperTrade.entry
        : exit < paperTrade.entry;

    const profit = won
      ? Number(paperTrade.stake) * 0.92
      : -Number(paperTrade.stake);

    setTransactions((current) =>
      [
        {
          ...paperTrade,
          exit,
          result: won ? "WON" : "LOST",
          profit,
          source: "PAPER",
          closedAt: new Date().toLocaleTimeString(),
        },
        ...current,
      ].slice(0, 120)
    );

    if (paperTrade.memorySignature) {
      setAdaptiveMemory((current) => {
        const previous =
          current[paperTrade.memorySignature] || {
            wins: 0,
            losses: 0,
            profit: 0,
          };

        return {
          ...current,
          [paperTrade.memorySignature]: {
            wins:
              Number(previous.wins || 0) +
              (won ? 1 : 0),
            losses:
              Number(previous.losses || 0) +
              (won ? 0 : 1),
            profit:
              Number(previous.profit || 0) +
              Number(profit || 0),
            updatedAt: Date.now(),
          },
        };
      });
    }

    setMessage(
      `PAPER ${won ? "WON" : "LOST"} · ${
        profit >= 0 ? "+" : ""
      }$${money(profit)}`
    );
    setPaperTrade(null);
    setCooldownUntil(Date.now() + 5000);
  }, [liveQuote, paperTrade, tickSerial]);

  useEffect(() => {
    for (const contract of Array.isArray(openContracts)
      ? openContracts
      : []) {
      const id = contractIdOf(contract);
      if (!id) continue;

      const status = statusOf(contract);

      if (status === "OPEN") {
        if (typeof refreshContract === "function") {
          void refreshContract(id);
        }
        continue;
      }

      if (trackedContractsRef.current.has(id)) continue;
      trackedContractsRef.current.add(id);

      const profit = profitOf(contract);

      setTransactions((current) =>
        [
          {
            id,
            market:
              contract?.underlying ||
              contract?.symbol ||
              symbol,
            contract:
              contract?.contract_type ||
              contract?.contractType ||
              "LIVE",
            entry:
              contract?.entry_spot ??
              contract?.entry_tick ??
              "—",
            exit:
              contract?.exit_tick ??
              contract?.exit_spot ??
              "—",
            stake:
              contract?.buy_price ??
              contract?.stake ??
              stake,
            confidence:
              contract?.confidence ??
              analysis.confidence,
            result: status,
            profit,
            source: "DERIV",
            closedAt: new Date().toLocaleTimeString(),
          },
          ...current,
        ].slice(0, 120)
      );

      setMessage(
        `DERIV ${status} · ${
          profit >= 0 ? "+" : ""
        }$${money(profit)}`
      );
    }
  }, [
    analysis.confidence,
    openContracts,
    refreshContract,
    stake,
    symbol,
  ]);

  async function executeLiveSignal() {
    if (buyLockRef.current || tradeBusy) return;

    if (!executionReady) {
      setMessage(
        "Log in with Deriv and select an account before live execution."
      );
      return;
    }

    if (
      selectedAccountType !== "demo" &&
      !allowReal
    ) {
      setMessage(
        "Real account is locked. Enable real execution manually."
      );
      return;
    }

    if (
      analysis.decision !== "BUY" ||
      analysis.contract === "NONE" ||
      analysis.confidence < minimumConfidence
    ) {
      setMessage(
        "Signal has not passed the Final AI execution gate."
      );
      return;
    }

    buyLockRef.current = true;

    try {
      setMessage(
        `SENDING DERIV BUY · ${analysis.contract} · ${analysis.confidence}%`
      );

      const response = await placeTrade({
        symbol,
        contractType:
          analysis.contract === "RISE"
            ? "CALL"
            : "PUT",
        amount: Math.max(
          0.35,
          Number(stake || 0.35)
        ),
        basis: "stake",
        duration: 5,
        durationUnit: "t",
      });

      const contractId = contractIdOf(
        response?.buy ||
          response?.proposal_open_contract ||
          response
      );

      setMessage(
        contractId
          ? `DERIV BUY SENT · CONTRACT ${contractId}`
          : "DERIV BUY SENT · waiting for contract update"
      );
    } catch (error) {
      setMessage(
        error?.message ||
          tradeError ||
          "Deriv rejected the buy request."
      );
    } finally {
      window.setTimeout(() => {
        buyLockRef.current = false;
      }, 1800);
    }
  }

  useEffect(() => {
    if (
      !running ||
      mode !== "live" ||
      buyLockRef.current ||
      tradeBusy ||
      analysis.decision !== "BUY" ||
      analysis.confidence < minimumConfidence
    ) {
      return;
    }

    void executeLiveSignal();
    // execute only when a new qualified decision appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    analysis.decision,
    analysis.contract,
    analysis.confidence,
    minimumConfidence,
    mode,
    running,
    symbol,
  ]);

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent final-integrated-page final-v7-page">
        <Topbar
          title="EdgePilot Final AI"
          subtitle="Shared Deriv login · live analysis · decision journal · paper and guarded live execution"
          connected={connected}
          connecting={loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="final-account-strip">
          <div>
            <span>Feed</span>
            <strong>
              {connected ? "LIVE" : "OFFLINE"}
            </strong>
          </div>
          <div>
            <span>Trading auth</span>
            <strong>
              {authenticatedFeed && selectedAccountId
                ? "READY"
                : "BLOCKED"}
            </strong>
          </div>
          <div>
            <span>Account</span>
            <strong>
              {selectedAccountType || "—"}
            </strong>
          </div>
          <div>
            <span>Account ID</span>
            <strong>
              {selectedAccountId || "Not selected"}
            </strong>
          </div>
          <div className="final-wide-message">
            <span>Status</span>
            <strong>{tradeError || message}</strong>
          </div>
        </section>

        <section className="final-control-grid">
          <label>
            Market
            <MarketSelector
              markets={markets}
              value={symbol}
              disabled={loadingMarket}
              onChange={(next) => {
                setPaperTrade(null);
                void changeSymbol(next);
              }}
            />
          </label>

          <label>
            Stake
            <input
              min="0.35"
              step="0.01"
              type="number"
              value={stake}
              onChange={(event) =>
                setStake(event.target.value)
              }
            />
          </label>

          <label>
            Minimum confidence
            <input
              min="60"
              max="95"
              type="number"
              value={minimumConfidence}
              onChange={(event) =>
                setMinimumConfidence(
                  Number(event.target.value)
                )
              }
            />
          </label>

          <label>
            Execution mode
            <select
              value={mode}
              onChange={(event) => {
                setRunning(false);
                setMode(event.target.value);
              }}
            >
              <option value="paper">
                Paper trading
              </option>
              <option value="live">
                Deriv live execution
              </option>
              <option value="analysis">
                Analysis only
              </option>
            </select>
          </label>

          <label className="final-real-lock">
            Real account
            <select
              value={allowReal ? "enabled" : "locked"}
              onChange={(event) =>
                setAllowReal(
                  event.target.value === "enabled"
                )
              }
            >
              <option value="locked">
                LOCKED
              </option>
              <option value="enabled">
                ENABLED
              </option>
            </select>
          </label>

          <button
            className={
              running ? "final-stop" : "final-start"
            }
            onClick={() =>
              setRunning((value) => !value)
            }
          >
            {running ? "STOP FINAL AI" : "START FINAL AI"}
          </button>

          {mode === "live" && (
            <button
              className="final-test-buy"
              disabled={
                tradeBusy ||
                !executionReady ||
                analysis.decision !== "BUY"
              }
              onClick={() => void executeLiveSignal()}
            >
              BUY QUALIFIED SIGNAL
            </button>
          )}
        </section>

        <section className="final-hero-grid">
          <article
            className={`final-decision final-decision-${analysis.decision.toLowerCase()}`}
          >
            <div className="final-decision-head">
              <span>FINAL AI DECISION</span>
              <div className="final-stage-badges">
                <em>{analysis.stage || "SCAN"}</em>
                <strong>{analysis.decision}</strong>
              </div>
            </div>

            <div className="final-contract">
              {analysis.contract}
            </div>

            <p>{analysis.reason}</p>

            <div className="final-filter-list">
              {(analysis.checks || []).map((item) => (
                <div
                  key={item.label}
                  className={
                    item.passed
                      ? "final-filter-pass"
                      : "final-filter-fail"
                  }
                >
                  <span>{item.passed ? "✓" : "✗"}</span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </div>
              ))}
            </div>

            <div className="final-score-row">
              <div>
                <small>Confidence</small>
                <strong>
                  {analysis.confidence}%
                </strong>
              </div>
              <div>
                <small>Probability</small>
                <strong>
                  {analysis.probability}%
                </strong>
              </div>
              <div>
                <small>Risk</small>
                <strong>{analysis.risk}</strong>
              </div>
              <div>
                <small>Live quote</small>
                <strong>{liveQuote || "—"}</strong>
              </div>
            </div>
          </article>

          <article className="final-open-card">
            <span>EXECUTION STATE</span>
            <strong>
              {mode === "live"
                ? executionReady
                  ? `${analysis.stage || "SCAN"} · DERIV READY`
                  : "DERIV BLOCKED"
                : paperTrade
                  ? `${paperTrade.contract} PAPER TRADE`
                  : `${analysis.stage || "SCAN"} · ${mode.toUpperCase()}`}
            </strong>
            <p>
              {paperTrade
                ? `Entry ${paperTrade.entry} · Stake $${money(
                    paperTrade.stake
                  )}`
                : message}
            </p>
            <small>
              Selected account:{" "}
              {selectedAccountType || "none"}
            </small>
          </article>
        </section>

        <section className="final-metrics-grid">
          <Metric
            label="Momentum"
            value={analysis.metrics.momentum}
          />
          <Metric
            label="Trend"
            value={analysis.metrics.trend}
          />
          <Metric
            label="Volatility"
            value={analysis.metrics.volatility}
          />
          <Metric
            label="Entropy"
            value={`${analysis.metrics.entropy}%`}
          />
          <Metric
            label="Bayesian"
            value={`${analysis.metrics.bayesian}%`}
          />
          <Metric
            label="Transition"
            value={`${analysis.metrics.transition}%`}
          />
          <Metric
            label="Observed cycle"
            value={analysis.metrics.cycle || "None"}
          />
          <Metric
            label="Regime"
            value={analysis.metrics.regime}
          />
          <Metric
            label="Reversal risk"
            value={`${analysis.metrics.reversalRisk ?? 0}%`}
          />
          <Metric
            label="Consecutive"
            value={analysis.metrics.consecutiveDirection ?? 0}
          />
          <Metric
            label="Momentum decay"
            value={analysis.metrics.momentumDecay ?? "NO"}
          />
          <Metric
            label="Signal age"
            value={analysis.metrics.signalAge ?? 0}
          />
          <Metric
            label="Learned sample"
            value={analysis.metrics.learnedSample ?? 0}
          />
          <Metric
            label="Learned win rate"
            value={`${analysis.metrics.learnedWinRate ?? 50}%`}
          />
          <Metric
            label="Expected value"
            value={
              Number(analysis.metrics.expectedValue || 0) >= 0
                ? `+${analysis.metrics.expectedValue ?? 0}`
                : analysis.metrics.expectedValue ?? 0
            }
          />
        </section>

        <section className="final-stats-grid">
          <Metric label="Runs" value={stats.runs} />
          <Metric label="Wins" value={stats.wins} />
          <Metric label="Losses" value={stats.losses} />
          <Metric
            label="Win rate"
            value={`${stats.rate}%`}
          />
          <Metric
            label="Net P/L"
            value={`${stats.profit >= 0 ? "+" : ""}$${money(
              stats.profit
            )}`}
          />
        </section>

        <section className="final-bottom-grid">
          <article className="final-panel">
            <div className="final-panel-title">
              <div>
                <span>TRANSACTIONS</span>
                <h2>
                  Paper and Deriv contract results
                </h2>
              </div>
              <div className="final-clear-actions">
                <button
                  onClick={() => {
                    setTransactions([]);
                    try {
                      window.localStorage.removeItem(
                        FINAL_AI_HISTORY_KEY
                      );
                    } catch {
                      // Ignore storage errors.
                    }
                  }}
                >
                  Clear trades
                </button>
                <button
                  onClick={() => {
                    setAdaptiveMemory({});
                    try {
                      window.localStorage.removeItem(
                        FINAL_AI_MEMORY_KEY
                      );
                    } catch {
                      // Ignore storage errors.
                    }
                  }}
                >
                  Reset memory
                </button>
              </div>
            </div>

            <div className="final-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Source</th>
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
                      <td>{item.source}</td>
                      <td>{item.market}</td>
                      <td>{item.contract}</td>
                      <td>
                        {item.entry} / {item.exit}
                      </td>
                      <td>
                        {item.confidence ?? "—"}%
                      </td>
                      <td
                        className={
                          item.result === "WON"
                            ? "final-win"
                            : "final-loss"
                        }
                      >
                        {item.result}
                      </td>
                      <td
                        className={
                          item.profit >= 0
                            ? "final-win"
                            : "final-loss"
                        }
                      >
                        {item.profit >= 0 ? "+" : ""}$
                        {money(item.profit)}
                      </td>
                    </tr>
                  ))}

                  {!transactions.length && (
                    <tr>
                      <td
                        colSpan="8"
                        className="final-empty"
                      >
                        No completed transactions yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <article className="final-panel">
            <div className="final-panel-title">
              <div>
                <span>DECISION JOURNAL</span>
                <h2>
                  Why Final AI waited or entered
                </h2>
              </div>
              <button onClick={() => setJournal([])}>
                Clear
              </button>
            </div>

            <div className="final-journal">
              {journal.map((item) => (
                <div
                  key={item.id}
                  className="final-journal-row"
                >
                  <time>{item.time}</time>
                  <strong>{item.decision}</strong>
                  <span>{item.contract}</span>
                  <span>{item.confidence}%</span>
                  <span>{item.risk}</span>
                  <p>{item.reason}</p>
                </div>
              ))}

              {!journal.length && (
                <div className="final-empty">
                  Waiting for shared Deriv ticks…
                </div>
              )}
            </div>
          </article>
        </section>

        <footer className="final-disclaimer">
          Live execution is guarded by Deriv authentication,
          account selection, confidence threshold and a manual
          real-account lock. No analysis score guarantees profit.
        </footer>
      </main>
    </div>
  );
}
