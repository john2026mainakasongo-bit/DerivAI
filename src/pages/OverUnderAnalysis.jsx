import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeOverUnder } from "../analysis/overUnderAnalysisEngine";
import "../styles/OverUnderAnalysis.css";

const pct = (value) => `${Number(value || 0).toFixed(1)}%`;

function contractIdOf(item = {}) {
  return String(item?.contract_id || item?.id || item?.contractId || "");
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
      (Number(item?.sell_price || 0) - Number(item?.buy_price || 0))
  );
  return Number.isFinite(value) ? value : 0;
}

export default function OverUnderAnalysis() {
  const {
    markets = [],
    market = null,
    symbol = "",
    connected = false,
    loadingMarket = false,
    prices = [],
    selectedAccountType = "demo",
    selectedAccountId = "",
    openContracts = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const [autoRunning, setAutoRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [durationTicks, setDurationTicks] = useState(1);
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [switchAfterSeconds, setSwitchAfterSeconds] = useState(8);
  const [runs, setRuns] = useState(0);
  const [switches, setSwitches] = useState(0);
  const [losses, setLosses] = useState(0);
  const [trades, setTrades] = useState([]);
  const [message, setMessage] = useState("Auto execution is stopped.");
  const [allowReal, setAllowReal] = useState(false);

  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const lossRef = useRef(0);
  const waitRef = useRef(Date.now());
  const switchRef = useRef(false);
  const lastSwitchRef = useRef(0);
  const processedRef = useRef(new Set());

  useEffect(() => {
    runningRef.current = autoRunning;
  }, [autoRunning]);

  useEffect(() => {
    lossRef.current = losses;
  }, [losses]);

  useEffect(() => {
    if (!connected && typeof connect === "function") {
      Promise.resolve(connect()).catch(() => {});
    }
  }, [connected, connect]);

  const analysis = useMemo(() => analyzeOverUnder(prices), [prices]);

  const marketSymbols = useMemo(
    () =>
      (Array.isArray(markets) ? markets : [])
        .map((item) => String(item?.symbol ?? item?.value ?? item?.id ?? ""))
        .filter(Boolean),
    [markets]
  );

  const hasOpenTrade = trades.some((trade) => trade.status === "OPEN");

  function stopAuto(text) {
    runningRef.current = false;
    setAutoRunning(false);
    setMessage(text);
  }

  function resetTransactions() {
    setTrades([]);
    setRuns(0);
    setLosses(0);
    lossRef.current = 0;
    processedRef.current = new Set();
    setMessage(
      runningRef.current
        ? "Transactions reset. Scanner continues."
        : "Transactions reset."
    );
  }

  function nextMarket() {
    if (!marketSymbols.length) return "";
    const current = marketSymbols.indexOf(symbol);
    return marketSymbols[current >= 0 ? (current + 1) % marketSymbols.length : 0];
  }

  async function switchMarket(reason) {
    if (
      switchRef.current ||
      hasOpenTrade ||
      tradeBusy ||
      typeof changeSymbol !== "function"
    ) return;

    const next = nextMarket();
    if (!next || next === symbol) return;

    switchRef.current = true;
    lastSwitchRef.current = Date.now();
    waitRef.current = Date.now();
    setMessage(`Switching ${symbol} → ${next} · ${reason}.`);

    try {
      await Promise.resolve(changeSymbol(next));
      setSwitches((value) => value + 1);
    } finally {
      window.setTimeout(() => {
        switchRef.current = false;
      }, 1200);
    }
  }

  async function executeTrade() {
    if (
      busyRef.current ||
      !runningRef.current ||
      hasOpenTrade ||
      !analysis.tradeNow ||
      analysis.best.side === "WAIT"
    ) return;

    if (!connected) {
      setMessage("Waiting for Deriv feed.");
      return;
    }

    if (!selectedAccountId) {
      stopAuto("Choose a Demo or Real account.");
      return;
    }

    if (selectedAccountType !== "demo" && !allowReal) {
      stopAuto("Real execution is locked.");
      return;
    }

    if (lossRef.current >= 3) {
      stopAuto("Hard stop: 3 consecutive losses.");
      return;
    }

    busyRef.current = true;

    try {
      const contractType =
        analysis.best.side === "OVER" ? "DIGITOVER" : "DIGITUNDER";

      const result = await placeTrade({
        symbol,
        contractType,
        amount: Math.max(0.35, Number(stake) || 0.35),
        basis: "stake",
        duration: Math.max(1, Number(durationTicks) || 1),
        durationUnit: "t",
        barrier: String(analysis.best.barrier),
      });

      const contractId = String(result?.contractId || "");

      setRuns((value) => value + 1);
      setTrades((current) => [
        {
          id: contractId || `${Date.now()}`,
          contractId,
          time: Date.now(),
          symbol,
          contract: `${analysis.best.side} ${analysis.best.barrier}`,
          duration: `${durationTicks} TICK`,
          stake: Math.max(0.35, Number(stake) || 0.35),
          confidence: analysis.confidence,
          score: analysis.best.score,
          status: "OPEN",
          profit: 0,
        },
        ...current,
      ].slice(0, 40));

      setMessage(
        `${analysis.best.side} ${analysis.best.barrier} opened immediately.`
      );
      waitRef.current = Date.now();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade failed.");
    } finally {
      busyRef.current = false;
    }
  }

  function toggleAuto() {
    if (autoRunning) {
      stopAuto("Stopped manually.");
      return;
    }

    if (selectedAccountType !== "demo" && !allowReal) {
      setMessage("Enable Real execution or switch to Demo.");
      return;
    }

    waitRef.current = Date.now();
    runningRef.current = true;
    setAutoRunning(true);
    setMessage("Scanning continuously. Valid entry executes immediately.");
  }

  useEffect(() => {
    if (
      autoRunning &&
      analysis.tradeNow &&
      !hasOpenTrade &&
      losses < 3
    ) {
      void executeTrade();
    }
  }, [
    autoRunning,
    analysis.tradeNow,
    analysis.best.side,
    analysis.best.barrier,
    analysis.best.score,
    hasOpenTrade,
    losses,
    symbol,
  ]);

  useEffect(() => {
    if (
      !autoRunning ||
      !autoSwitch ||
      hasOpenTrade ||
      tradeBusy ||
      marketSymbols.length < 2 ||
      losses >= 3
    ) return;

    if (analysis.tradeNow) {
      waitRef.current = Date.now();
      return;
    }

    const timer = window.setInterval(() => {
      const delay = Math.max(4, Number(switchAfterSeconds) || 8) * 1000;
      const now = Date.now();

      if (
        now - waitRef.current >= delay &&
        now - lastSwitchRef.current >= delay
      ) {
        void switchMarket(analysis.reason || "No executable entry");
      }
    }, 500);

    return () => window.clearInterval(timer);
  }, [
    autoRunning,
    autoSwitch,
    hasOpenTrade,
    tradeBusy,
    marketSymbols,
    symbol,
    analysis.tradeNow,
    analysis.reason,
    switchAfterSeconds,
    losses,
  ]);

  useEffect(() => {
    const contracts = Array.isArray(openContracts) ? openContracts : [];
    if (!contracts.length) return;

    let result = null;

    setTrades((current) =>
      current.map((trade) => {
        const match = contracts.find(
          (item) => contractIdOf(item) === trade.contractId
        );

        if (!match) return trade;

        const status = contractStatus(match);
        const closed = ["WON", "LOST", "SOLD", "EXPIRED"].includes(status);

        if (
          closed &&
          trade.contractId &&
          !processedRef.current.has(trade.contractId)
        ) {
          processedRef.current.add(trade.contractId);
          result = status;
        }

        return {
          ...trade,
          status,
          profit: profitOf(match),
        };
      })
    );

    if (result === "WON") {
      lossRef.current = 0;
      setLosses(0);
      waitRef.current = Date.now();
    } else if (result === "LOST") {
      const next = lossRef.current + 1;
      lossRef.current = next;
      setLosses(next);
      waitRef.current = Date.now();

      if (next >= 3 && runningRef.current) {
        stopAuto(
          "Hard stop: 3 consecutive losses. Reset transactions before restarting."
        );
      }
    }
  }, [openContracts]);

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent ouPage">
        <Topbar
          title="EdgePilot V72 · Over/Under Pro Analysis"
          subtitle="Standalone analysis, immediate execution, auto market switch and 3-loss hard stop"
          connected={connected}
          connecting={false}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="ouToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={loadingMarket}
            onChange={changeSymbol}
          />

          <div>
            <button type="button" className="ouReset" onClick={resetTransactions}>
              RESET TRANSACTIONS
            </button>
            <button
              type="button"
              className={autoRunning ? "ouStop" : "ouStart"}
              disabled={tradeBusy}
              onClick={toggleAuto}
            >
              {tradeBusy ? "SENDING..." : autoRunning ? "■ STOP" : "▶ START"}
            </button>
          </div>
        </section>

        <section className={`ouExecution ${autoRunning ? "running" : ""}`}>
          <div>
            <small>OVER/UNDER AUTO EXECUTION</small>
            <h2>{autoRunning ? "RUNNING" : "STOPPED"}</h2>
            <p>{message || tradeError}</p>
          </div>

          <div className="ouControlGrid">
            <label>
              <span>Stake</span>
              <input
                type="number"
                min="0.35"
                step="0.01"
                value={stake}
                onChange={(event) => setStake(event.target.value)}
              />
            </label>

            <label>
              <span>Duration</span>
              <select
                value={durationTicks}
                onChange={(event) => setDurationTicks(event.target.value)}
              >
                <option value="1">1 TICK</option>
                <option value="2">2 TICKS</option>
                <option value="3">3 TICKS</option>
                <option value="5">5 TICKS</option>
              </select>
            </label>

            <label>
              <span>Auto switch</span>
              <select
                value={autoSwitch ? "ON" : "OFF"}
                onChange={(event) => setAutoSwitch(event.target.value === "ON")}
              >
                <option value="ON">ON</option>
                <option value="OFF">OFF</option>
              </select>
            </label>

            <label>
              <span>Switch after</span>
              <input
                type="number"
                min="4"
                max="60"
                value={switchAfterSeconds}
                onChange={(event) => setSwitchAfterSeconds(event.target.value)}
              />
            </label>

            <div><span>Runs</span><strong>{runs} · UNTIL STOP</strong></div>
            <div><span>Loss streak</span><strong>{losses}/3</strong></div>
            <div><span>Market switches</span><strong>{switches}</strong></div>

            <label>
              <span>Real execution</span>
              <input
                type="checkbox"
                checked={allowReal}
                disabled={selectedAccountType === "demo"}
                onChange={(event) => setAllowReal(event.target.checked)}
              />
            </label>
          </div>
        </section>

        <section className={`ouHero ${analysis.tradeNow ? "ready" : analysis.prepare ? "prepare" : ""}`}>
          <div>
            <small>BEST OVER/UNDER SETUP</small>
            <h1>{analysis.decision}</h1>
            <p>{analysis.reason}</p>
          </div>

          <div className="ouHeroStats">
            <span><small>Grade</small><strong>{analysis.grade}</strong></span>
            <span><small>Confidence</small><strong>{pct(analysis.confidence)}</strong></span>
            <span><small>Quality</small><strong>{pct(analysis.quality)}</strong></span>
            <span><small>Risk</small><strong>{analysis.risk}</strong></span>
          </div>
        </section>

        <section className="ouCandidateGrid">
          <article><small>CONTRACT</small><strong>{analysis.best.side} {analysis.best.barrier}</strong><span>Best current setup.</span></article>
          <article><small>PROBABILITY</small><strong>{pct(analysis.best.probability)}</strong><span>Observed digit distribution.</span></article>
          <article><small>EXACT-DIGIT RISK</small><strong>{pct(analysis.best.exactRisk)}</strong><span>Risk of landing on barrier.</span></article>
          <article><small>TRANSITION</small><strong>{pct(analysis.best.transitionScore)}</strong><span>Recent transition support.</span></article>
          <article><small>ENTRY SCORE</small><strong>{pct(analysis.best.score)}</strong><span>Weighted opportunity.</span></article>
          <article><small>ENTROPY</small><strong>{pct(analysis.entropy)}</strong><span>Higher means more random.</span></article>
        </section>

        <section className="ouMainGrid">
          <article className="ouPanel">
            <div className="ouPanelHead">
              <div><small>DIGIT HEATMAP</small><h2>Live distribution 0–9</h2></div>
              <strong>{analysis.total} ticks</strong>
            </div>

            <div className="ouDigitBars">
              {analysis.counts.map((count, digit) => {
                const value = analysis.total ? count / analysis.total * 100 : 0;
                return (
                  <div key={digit}>
                    <span>{digit}</span>
                    <i><b style={{ width: `${value}%` }} /></i>
                    <strong>{pct(value)}</strong>
                  </div>
                );
              })}
            </div>
          </article>

          <article className="ouPanel">
            <div className="ouPanelHead">
              <div><small>LIVE DIGIT FLOW</small><h2>Most recent digits</h2></div>
              <strong>{market?.label || symbol}</strong>
            </div>

            <div className="ouRecentDigits">
              {analysis.recentDigits.map((digit, index) => (
                <span key={`${digit}-${index}`} className={digit === analysis.latestDigit ? "latest" : ""}>
                  {digit}
                </span>
              ))}
            </div>
          </article>
        </section>

        <section className="ouPanel">
          <div className="ouPanelHead">
            <div><small>BARRIER COMPARISON</small><h2>Over and Under probability</h2></div>
          </div>

          <div className="ouBarrierTable">
            <div className="head">
              <span>Barrier</span><span>Over</span><span>Under</span><span>Exact risk</span>
            </div>
            {analysis.rows.map((row) => (
              <div key={row.barrier} className={row.barrier === analysis.best.barrier ? "selected" : ""}>
                <strong>{row.barrier}</strong>
                <span>{pct(row.over)}</span>
                <span>{pct(row.under)}</span>
                <span>{pct(row.exact)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="ouPanel">
          <div className="ouPanelHead">
            <div><small>TRADE VIEWER</small><h2>Open and recent Over/Under trades</h2></div>
            <strong>{trades.length} session trades</strong>
          </div>

          <div className="ouTradeTable">
            <div className="head">
              <span>Time</span><span>Market</span><span>Contract</span><span>Duration</span>
              <span>Stake</span><span>Status</span><span>Confidence</span><span>Score</span><span>P/L</span>
            </div>

            {trades.map((trade) => (
              <div key={trade.id}>
                <span>{new Date(trade.time).toLocaleTimeString()}</span>
                <span>{trade.symbol}</span>
                <strong>{trade.contract}</strong>
                <span>{trade.duration}</span>
                <span>{trade.stake.toFixed(2)}</span>
                <b className={String(trade.status).toLowerCase()}>{trade.status}</b>
                <span>{pct(trade.confidence)}</span>
                <span>{pct(trade.score)}</span>
                <b className={trade.profit >= 0 ? "won" : "lost"}>{trade.profit.toFixed(2)}</b>
              </div>
            ))}

            {!trades.length ? <p>No trades in this session.</p> : null}
          </div>
        </section>

        <div className="ouDisclaimer">
          Analysis is probabilistic. Test on Demo before enabling Real execution.
        </div>
      </main>
    </div>
  );
}
