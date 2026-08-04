import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeOverUnder } from "../analysis/overUnderAnalysisEngine";
import "../styles/OverUnderAnalysis.css";

const pct = (value) => `${Number(value || 0).toFixed(1)}%`;

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

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
  return safeNumber(
    item?.profit ??
      item?.profit_loss ??
      item?.pnl ??
      (safeNumber(item?.sell_price) - safeNumber(item?.buy_price))
  );
}

function normalizeAnalysis(value) {
  const best = value?.best || {};
  const counts = Array.isArray(value?.counts)
    ? value.counts.slice(0, 10)
    : [];

  while (counts.length < 10) counts.push(0);

  return {
    total: safeNumber(value?.total),
    recentDigits: Array.isArray(value?.recentDigits)
      ? value.recentDigits.filter((digit) => Number.isFinite(Number(digit)))
      : [],
    counts,
    latestDigit: safeNumber(value?.latestDigit),
    rows: Array.isArray(value?.rows) ? value.rows : [],
    candidates: Array.isArray(value?.candidates)
      ? value.candidates
      : [],
    confidence: safeNumber(value?.confidence),
    quality: safeNumber(value?.quality),
    risk: String(value?.risk || "HIGH"),
    tradeNow: Boolean(value?.tradeNow),
    prepare: Boolean(value?.prepare),
    decision: String(value?.decision || "SCANNING OVER + UNDER"),
    grade: String(value?.grade || "WAIT"),
    reason: String(
      value?.reason ||
        "Comparing every OVER and UNDER barrier from live Deriv ticks."
    ),
    best: {
      side: String(best?.side || "WAIT"),
      barrier: Math.max(1, Math.min(7, safeNumber(best?.barrier, 2))),
      probability: safeNumber(best?.probability),
      probabilityEdge: safeNumber(best?.probabilityEdge),
      transitionEdge: safeNumber(best?.transitionEdge),
      consistency: safeNumber(best?.consistency),
      exactRisk: safeNumber(best?.exactRisk, 100),
      score: safeNumber(best?.score),
    },
  };
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
  const [stake, setStake] = useState("0.35");
  const [durationTicks, setDurationTicks] = useState("1");
  const [manualSide, setManualSide] = useState("OVER");
  const [manualBarrier, setManualBarrier] = useState("2");
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [switchAfterSeconds, setSwitchAfterSeconds] = useState("5");
  const [allowReal, setAllowReal] = useState(false);

  const [runs, setRuns] = useState(0);
  const [losses, setLosses] = useState(0);
  const [switches, setSwitches] = useState(0);
  const [trades, setTrades] = useState([]);
  const [message, setMessage] = useState("Auto execution is stopped.");

  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const lossesRef = useRef(0);
  const nextEntryAtRef = useRef(0);
  const waitStartedAtRef = useRef(Date.now());
  const switchingRef = useRef(false);
  const processedContractsRef = useRef(new Set());

  useEffect(() => {
    runningRef.current = autoRunning;
  }, [autoRunning]);

  useEffect(() => {
    lossesRef.current = losses;
  }, [losses]);

  useEffect(() => {
    if (!connected && typeof connect === "function") {
      Promise.resolve(connect()).catch(() => {});
    }
  }, [connected, connect]);

  const analysis = useMemo(
    () => normalizeAnalysis(analyzeOverUnder(prices)),
    [prices]
  );

  const marketSymbols = useMemo(
    () =>
      (Array.isArray(markets) ? markets : [])
        .map((item) => String(item?.symbol ?? item?.value ?? item?.id ?? ""))
        .filter(Boolean),
    [markets]
  );

  const hasOpenTrade = trades.some((trade) => trade.status === "OPEN");

  const selectedStake = Math.max(0.35, safeNumber(stake, 0.35));
  const selectedDuration = Math.max(1, safeNumber(durationTicks, 1));

  function stopAuto(text) {
    runningRef.current = false;
    setAutoRunning(false);
    setMessage(text);
  }

  function resetSession() {
    setRuns(0);
    setLosses(0);
    setSwitches(0);
    setTrades([]);
    lossesRef.current = 0;
    processedContractsRef.current = new Set();
    nextEntryAtRef.current = 0;
    waitStartedAtRef.current = Date.now();
    setMessage(autoRunning ? "Session reset. Scanner continues." : "Session reset.");
  }

  function canTradeReal() {
    return selectedAccountType === "demo" || allowReal;
  }

  function nextMarketSymbol() {
    if (!marketSymbols.length) return "";
    const currentIndex = marketSymbols.indexOf(symbol);
    return marketSymbols[
      currentIndex >= 0 ? (currentIndex + 1) % marketSymbols.length : 0
    ];
  }

  async function switchMarket(reason) {
    if (
      switchingRef.current ||
      hasOpenTrade ||
      tradeBusy ||
      typeof changeSymbol !== "function"
    ) {
      return;
    }

    const next = nextMarketSymbol();
    if (!next || next === symbol) return;

    switchingRef.current = true;
    setMessage(`Switching ${symbol || "market"} → ${next}. ${reason}`);

    try {
      await Promise.resolve(changeSymbol(next));
      setSwitches((value) => value + 1);
      waitStartedAtRef.current = Date.now();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Market switch failed.");
    } finally {
      window.setTimeout(() => {
        switchingRef.current = false;
      }, 900);
    }
  }

  async function sendTrade({
    side,
    barrier,
    mode,
    score = 0,
    confidence = 0,
  }) {
    if (busyRef.current || tradeBusy || hasOpenTrade) return;

    if (!connected) {
      setMessage("Waiting for Deriv live feed.");
      return;
    }

    if (!selectedAccountId) {
      setMessage("Choose a Demo or Real account.");
      return;
    }

    if (!canTradeReal()) {
      setMessage("Real execution is locked. Enable it first.");
      return;
    }

    if (mode === "AUTO" && lossesRef.current >= 2) {
      stopAuto("Hard stop: 2 consecutive losses.");
      return;
    }

    busyRef.current = true;

    try {
      const contractType = side === "OVER" ? "DIGITOVER" : "DIGITUNDER";

      const result = await placeTrade({
        symbol,
        contractType,
        amount: selectedStake,
        basis: "stake",
        duration: selectedDuration,
        durationUnit: "t",
        barrier: String(barrier),
      });

      const contractId = String(result?.contractId || "");

      setRuns((value) => value + 1);
      setTrades((current) =>
        [
          {
            id: contractId || `${Date.now()}`,
            contractId,
            time: Date.now(),
            symbol,
            contract: `${side} ${barrier}`,
            mode,
            duration: `${selectedDuration}T`,
            stake: selectedStake,
            confidence,
            score,
            status: "OPEN",
            profit: 0,
          },
          ...current,
        ].slice(0, 50)
      );

      setMessage(`${mode} ${side} ${barrier} opened.`);
      nextEntryAtRef.current = Date.now() + 5000;
      waitStartedAtRef.current = Date.now();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade failed.");
    } finally {
      busyRef.current = false;
    }
  }

  function startOrStopAuto() {
    if (autoRunning) {
      stopAuto("Stopped manually.");
      return;
    }

    if (!canTradeReal()) {
      setMessage("Enable Real execution or switch to Demo.");
      return;
    }

    if (lossesRef.current >= 2) {
      setMessage("Reset the session before restarting after 2 losses.");
      return;
    }

    runningRef.current = true;
    setAutoRunning(true);
    waitStartedAtRef.current = Date.now();
    setMessage("Scanning all OVER and UNDER candidates.");
  }

  useEffect(() => {
    if (
      !autoRunning ||
      !analysis.tradeNow ||
      analysis.best.side === "WAIT" ||
      hasOpenTrade ||
      Date.now() < nextEntryAtRef.current ||
      losses >= 2
    ) {
      return;
    }

    void sendTrade({
      side: analysis.best.side,
      barrier: analysis.best.barrier,
      mode: "AUTO",
      score: analysis.best.score,
      confidence: analysis.confidence,
    });
  }, [
    autoRunning,
    analysis.tradeNow,
    analysis.best.side,
    analysis.best.barrier,
    analysis.best.score,
    analysis.confidence,
    hasOpenTrade,
    losses,
    symbol,
  ]);

  useEffect(() => {
    if (
      !autoRunning ||
      !autoSwitch ||
      analysis.tradeNow ||
      hasOpenTrade ||
      tradeBusy ||
      marketSymbols.length < 2 ||
      losses >= 2
    ) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      const delay = Math.max(4, safeNumber(switchAfterSeconds, 5)) * 1000;

      if (Date.now() - waitStartedAtRef.current >= delay) {
        void switchMarket("No qualified entry found.");
      }
    }, 500);

    return () => window.clearInterval(timer);
  }, [
    autoRunning,
    autoSwitch,
    analysis.tradeNow,
    hasOpenTrade,
    tradeBusy,
    marketSymbols.length,
    switchAfterSeconds,
    losses,
    symbol,
  ]);

  useEffect(() => {
    const contracts = Array.isArray(openContracts) ? openContracts : [];
    if (!contracts.length) return;

    let settledResult = "";

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
          !processedContractsRef.current.has(trade.contractId)
        ) {
          processedContractsRef.current.add(trade.contractId);
          settledResult = status;
        }

        return {
          ...trade,
          status,
          profit: profitOf(match),
        };
      })
    );

    if (settledResult === "WON") {
      lossesRef.current = 0;
      setLosses(0);
      nextEntryAtRef.current = Date.now() + 5000;
      waitStartedAtRef.current = Date.now();
      setMessage("Trade won. Fresh scan started.");
    } else if (settledResult === "LOST") {
      const nextLosses = lossesRef.current + 1;
      lossesRef.current = nextLosses;
      setLosses(nextLosses);
      nextEntryAtRef.current = Date.now() + 5000;
      waitStartedAtRef.current = Date.now();

      if (nextLosses >= 2 && runningRef.current) {
        stopAuto("Hard stop: 2 consecutive losses.");
      } else if (runningRef.current && autoSwitch) {
        void switchMarket("Loss settled. Rotating market.");
      }
    }
  }, [openContracts, autoSwitch]);

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent ouPage">
        <Topbar
          title="EdgePilot V101 · Over/Under Trader"
          subtitle="Fast manual entry · live multi-contract scanner · compact responsive layout"
          connected={connected}
          connecting={loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="ouTopRow">
          <div className="ouMarketBox">
            <span>VOLATILITY MARKET</span>
            <MarketSelector
              markets={markets}
              value={symbol}
              disabled={loadingMarket}
              onChange={changeSymbol}
            />
          </div>

          <div className="ouTopActions">
            <button type="button" className="ouReset" onClick={resetSession}>
              RESET
            </button>

            <button
              type="button"
              className={autoRunning ? "ouStop" : "ouStart"}
              disabled={tradeBusy}
              onClick={startOrStopAuto}
            >
              {tradeBusy ? "SENDING..." : autoRunning ? "■ STOP" : "▶ START"}
            </button>
          </div>
        </section>

        <section className="ouExecutionCard">
          <div className="ouStatusBlock">
            <small>OVER/UNDER AUTO EXECUTION</small>
            <strong>{autoRunning ? "RUNNING" : "STOPPED"}</strong>
            <span>{message || tradeError}</span>
          </div>

          <div className="ouCompactControls">
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

            <div>
              <span>Runs</span>
              <strong>{runs}</strong>
            </div>

            <div>
              <span>Loss streak</span>
              <strong>{losses}/2</strong>
            </div>

            <div>
              <span>Market switches</span>
              <strong>{switches}</strong>
            </div>

            <label className="ouRealToggle">
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

        <section className="ouManualCard">
          <div className="ouSectionTitle">
            <small>DIRECT EXECUTION</small>
            <h2>Manual Over/Under</h2>
            <p>Manual trade sends immediately using your selected settings.</p>
          </div>

          <div className="ouManualControls">
            <label>
              <span>Side</span>
              <select
                value={manualSide}
                onChange={(event) => setManualSide(event.target.value)}
              >
                <option value="OVER">OVER</option>
                <option value="UNDER">UNDER</option>
              </select>
            </label>

            <label>
              <span>Barrier</span>
              <select
                value={manualBarrier}
                onChange={(event) => setManualBarrier(event.target.value)}
              >
                {[1, 2, 3, 4, 5, 6, 7].map((barrier) => (
                  <option key={barrier} value={barrier}>
                    {barrier}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="ouBuyOver"
              disabled={tradeBusy || hasOpenTrade}
              onClick={() =>
                void sendTrade({
                  side: "OVER",
                  barrier: safeNumber(manualBarrier, 2),
                  mode: "MANUAL",
                })
              }
            >
              BUY OVER {manualBarrier}
            </button>

            <button
              type="button"
              className="ouBuyUnder"
              disabled={tradeBusy || hasOpenTrade}
              onClick={() =>
                void sendTrade({
                  side: "UNDER",
                  barrier: safeNumber(manualBarrier, 2),
                  mode: "MANUAL",
                })
              }
            >
              BUY UNDER {manualBarrier}
            </button>
          </div>
        </section>

        <section
          className={`ouSignalCard ${
            analysis.tradeNow ? "ready" : analysis.prepare ? "prepare" : ""
          }`}
        >
          <div>
            <small>NEXT ENTRY</small>
            <h1>{analysis.decision}</h1>
            <p>{analysis.reason}</p>
          </div>

          <div className="ouSignalStats">
            <article>
              <span>Grade</span>
              <strong>{analysis.grade}</strong>
            </article>
            <article>
              <span>Confidence</span>
              <strong>{pct(analysis.confidence)}</strong>
            </article>
            <article>
              <span>Quality</span>
              <strong>{pct(analysis.quality)}</strong>
            </article>
            <article>
              <span>Risk</span>
              <strong>{analysis.risk}</strong>
            </article>
          </div>
        </section>

        <section className="ouMetricGrid">
          <article>
            <span>Contract</span>
            <strong>
              {analysis.best.side} {analysis.best.barrier}
            </strong>
          </article>
          <article>
            <span>Probability</span>
            <strong>{pct(analysis.best.probability)}</strong>
          </article>
          <article>
            <span>Probability edge</span>
            <strong>{pct(analysis.best.probabilityEdge)}</strong>
          </article>
          <article>
            <span>Transition edge</span>
            <strong>{pct(analysis.best.transitionEdge)}</strong>
          </article>
          <article>
            <span>Entry score</span>
            <strong>{pct(analysis.best.score)}</strong>
          </article>
          <article>
            <span>Consistency</span>
            <strong>{pct(analysis.best.consistency)}</strong>
          </article>
        </section>

        <section className="ouTwoColumns">
          <article className="ouPanel">
            <header>
              <div>
                <small>DIGIT HEATMAP</small>
                <h2>Live distribution 0–9</h2>
              </div>
              <strong>{analysis.total} ticks</strong>
            </header>

            <div className="ouDigitBars">
              {analysis.counts.map((count, digit) => {
                const value = analysis.total
                  ? (safeNumber(count) / analysis.total) * 100
                  : 0;

                return (
                  <div key={digit}>
                    <span>{digit}</span>
                    <i>
                      <b style={{ width: `${value}%` }} />
                    </i>
                    <strong>{pct(value)}</strong>
                  </div>
                );
              })}
            </div>
          </article>

          <article className="ouPanel">
            <header>
              <div>
                <small>LIVE DIGIT FLOW</small>
                <h2>Most recent digits</h2>
              </div>
              <strong>{market?.label || symbol}</strong>
            </header>

            <div className="ouRecentDigits">
              {analysis.recentDigits.map((digit, index) => (
                <span
                  key={`${digit}-${index}`}
                  className={digit === analysis.latestDigit ? "latest" : ""}
                >
                  {digit}
                </span>
              ))}
            </div>
          </article>
        </section>

        <section className="ouPanel">
          <header>
            <div>
              <small>ALL CONTRACT RANKING</small>
              <h2>OVER and UNDER candidates</h2>
            </div>
            <strong>{analysis.candidates.length} scanned</strong>
          </header>

          <div className="ouRankingGrid">
            {analysis.candidates.slice(0, 8).map((candidate, index) => (
              <article
                key={`${candidate?.side || "WAIT"}-${candidate?.barrier ?? index}`}
              >
                <span>
                  {candidate?.side || "WAIT"} {candidate?.barrier ?? "—"}
                </span>
                <strong>{pct(candidate?.score)}</strong>
                <small>Edge {pct(candidate?.probabilityEdge)}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="ouPanel">
          <header>
            <div>
              <small>BARRIER COMPARISON</small>
              <h2>Over and Under probability</h2>
            </div>
          </header>

          <div className="ouTable ouBarrierTable">
            <div className="head">
              <span>Barrier</span>
              <span>Over</span>
              <span>Under</span>
              <span>Exact risk</span>
            </div>

            {analysis.rows.map((row) => (
              <div
                key={row?.barrier}
                className={
                  safeNumber(row?.barrier) === analysis.best.barrier
                    ? "selected"
                    : ""
                }
              >
                <strong>{row?.barrier}</strong>
                <span>{pct(row?.over)}</span>
                <span>{pct(row?.under)}</span>
                <span>{pct(row?.exact)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="ouPanel">
          <header>
            <div>
              <small>TRADE VIEWER</small>
              <h2>Open and recent trades</h2>
            </div>
            <strong>{trades.length} session trades</strong>
          </header>

          <div className="ouTable ouTradeTable">
            <div className="head">
              <span>Time</span>
              <span>Market</span>
              <span>Contract</span>
              <span>Mode</span>
              <span>Duration</span>
              <span>Stake</span>
              <span>Status</span>
              <span>P/L</span>
            </div>

            {trades.map((trade) => (
              <div key={trade.id}>
                <span>{new Date(trade.time).toLocaleTimeString()}</span>
                <span>{trade.symbol}</span>
                <strong>{trade.contract}</strong>
                <span>{trade.mode}</span>
                <span>{trade.duration}</span>
                <span>{safeNumber(trade.stake).toFixed(2)}</span>
                <b className={String(trade.status).toLowerCase()}>
                  {trade.status}
                </b>
                <b className={safeNumber(trade.profit) >= 0 ? "won" : "lost"}>
                  {safeNumber(trade.profit).toFixed(2)}
                </b>
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
