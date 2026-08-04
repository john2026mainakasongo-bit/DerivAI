import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import { analyzeOverUnder } from "../analysis/overUnderAnalysisEngine";
import "../styles/OverUnderAnalysis.css";

const pct = (value) => `${Number(value || 0).toFixed(1)}%`;

function accountId(account = {}) {
  return String(
    account.id ||
    account.account_id ||
    account.loginid ||
    account.login_id ||
    ""
  );
}

function accountBalance(account = {}) {
  const value = Number(
    account.balance ??
    account.amount ??
    account.account_balance ??
    account.display_balance ??
    0
  );
  return Number.isFinite(value) ? value : 0;
}

function accountType(account = {}) {
  const id = accountId(account).toUpperCase();
  const type = String(account.type || account.account_type || "").toLowerCase();
  return type.includes("demo") || id.startsWith("VRTC") ? "demo" : "real";
}

function contractIdOf(item = {}) {
  return String(item.contract_id || item.id || item.contractId || "");
}

function contractStatus(item = {}) {
  const status = String(item.status || "").toUpperCase();
  if (
    item.is_sold ||
    item.is_expired ||
    ["WON", "LOST", "SOLD", "EXPIRED"].includes(status)
  ) {
    return status || "CLOSED";
  }
  return status || "OPEN";
}

function profitOf(item = {}) {
  const value = Number(
    item.profit ??
    item.profit_loss ??
    item.pnl ??
    (Number(item.sell_price || 0) - Number(item.buy_price || 0))
  );
  return Number.isFinite(value) ? value : 0;
}

export default function OverUnderAnalysis() {
  const auth = useDerivAuth();
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
  const [switchAfterSeconds, setSwitchAfterSeconds] = useState(12);
  const [runs, setRuns] = useState(0);
  const [switches, setSwitches] = useState(0);
  const [losses, setLosses] = useState(0);
  const [trades, setTrades] = useState([]);
  const [message, setMessage] = useState("Scanner stopped.");
  const [allowReal, setAllowReal] = useState(false);
  const [manualSide, setManualSide] = useState("OVER");
  const [manualBarrier, setManualBarrier] = useState(1);

  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const lossRef = useRef(0);
  const waitRef = useRef(Date.now());
  const switchRef = useRef(false);
  const lastSwitchRef = useRef(0);
  const processedRef = useRef(new Set());
  const nextEntryAtRef = useRef(0);

  const accounts = useMemo(() => {
    const values =
      auth.accounts ||
      auth.session?.accounts ||
      auth.accountList ||
      [];
    return Array.isArray(values) ? values : [];
  }, [auth.accounts, auth.session?.accounts, auth.accountList]);

  const selectedAccount =
    auth.selectedAccount ||
    accounts.find((account) => accountId(account) === selectedAccountId) ||
    null;

  const selectedId = accountId(selectedAccount) || selectedAccountId;
  const currentType =
    auth.selectedAccountType ||
    selectedAccountType ||
    accountType(selectedAccount);
  const currency = selectedAccount?.currency || "USD";
  const balance = accountBalance(selectedAccount);

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

  useEffect(() => {
    if (!selectedId) return;

    const changed = derivPublicClient.configureAccount({
      accessToken: auth.session?.accessToken || "",
      appId: auth.config?.clientId || "",
      accountId: selectedId,
    });

    if (changed && connected) {
      void derivPublicClient.reconnect();
    }
  }, [
    selectedId,
    connected,
    auth.session?.accessToken,
    auth.config?.clientId,
  ]);

  const analysis = useMemo(() => analyzeOverUnder(prices), [prices]);

  useEffect(() => {
    if (analysis.best.side !== "WAIT") {
      setManualSide(analysis.best.side);
      setManualBarrier(analysis.best.barrier);
    }
  }, [analysis.best.side, analysis.best.barrier]);

  const marketSymbols = useMemo(
    () =>
      markets
        .map((item) => String(item.symbol ?? item.value ?? item.id ?? ""))
        .filter(Boolean),
    [markets]
  );

  const hasOpenTrade = trades.some((trade) => trade.status === "OPEN");

  function stopAuto(text) {
    runningRef.current = false;
    setAutoRunning(false);
    setMessage(text);
  }

  async function switchAccount(nextId) {
    const account = accounts.find((item) => accountId(item) === nextId);
    if (!account) return;

    const method =
      auth.selectAccount ||
      auth.setSelectedAccount ||
      auth.chooseAccount ||
      auth.switchAccount;

    if (typeof method === "function") {
      await Promise.resolve(method(account));
      setMessage(`Switched to ${accountType(account).toUpperCase()} account.`);
    } else {
      setMessage("Account switch method is unavailable. Use the Deriv account menu.");
    }
  }

  function resetTransactions() {
    setTrades([]);
    setRuns(0);
    setLosses(0);
    lossRef.current = 0;
    processedRef.current = new Set();
    setMessage(runningRef.current ? "Stats reset; scanner continues." : "Stats reset.");
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
    setMessage(`Switching ${symbol} → ${next}: ${reason}`);

    try {
      await Promise.resolve(changeSymbol(next));
      setSwitches((value) => value + 1);
    } finally {
      window.setTimeout(() => {
        switchRef.current = false;
      }, 800);
    }
  }

  async function sendTrade(side, barrier, source = "MANUAL") {
    if (busyRef.current || hasOpenTrade || Date.now() < nextEntryAtRef.current) return;

    if (!connected) {
      setMessage("Waiting for Deriv connection.");
      return;
    }

    if (!selectedId) {
      setMessage("Choose a Demo or Real account.");
      return;
    }

    if (currentType !== "demo" && !allowReal) {
      setMessage("Real execution is locked. Enable it first.");
      return;
    }

    if (lossRef.current >= 3) {
      stopAuto("Hard stop: 3 consecutive losses.");
      return;
    }

    busyRef.current = true;

    try {
      const result = await placeTrade({
        symbol,
        contractType: side === "OVER" ? "DIGITOVER" : "DIGITUNDER",
        amount: Math.max(0.35, Number(stake) || 0.35),
        basis: "stake",
        duration: Math.max(1, Number(durationTicks) || 1),
        durationUnit: "t",
        barrier: String(barrier),
      });

      const contractId = String(result?.contractId || "");
      setRuns((value) => value + 1);
      setTrades((current) => [
        {
          id: contractId || String(Date.now()),
          contractId,
          time: Date.now(),
          symbol,
          contract: `${side} ${barrier}`,
          source,
          duration: `${durationTicks} TICK`,
          stake: Math.max(0.35, Number(stake) || 0.35),
          confidence: analysis.confidence,
          score: analysis.best.score,
          status: "OPEN",
          profit: 0,
        },
        ...current,
      ].slice(0, 40));

      setMessage(`${source}: ${side} ${barrier} opened.`);
      nextEntryAtRef.current = Date.now() + 1500;
      waitRef.current = Date.now();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade failed.");
    } finally {
      busyRef.current = false;
    }
  }

  async function executeAutoTrade() {
    if (
      !runningRef.current ||
      !analysis.tradeNow ||
      analysis.best.side === "WAIT"
    ) return;
    await sendTrade(analysis.best.side, analysis.best.barrier, "AUTO");
  }

  function toggleAuto() {
    if (autoRunning) {
      stopAuto("Stopped manually.");
      return;
    }

    if (currentType !== "demo" && !allowReal) {
      setMessage("Enable Real execution or switch to Demo.");
      return;
    }

    waitRef.current = Date.now();
    runningRef.current = true;
    setAutoRunning(true);
    setMessage("Scanning every fresh tick; qualified entries execute immediately.");
  }

  useEffect(() => {
    if (autoRunning && analysis.tradeNow && !hasOpenTrade && losses < 3) {
      void executeAutoTrade();
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
      const delay = Math.max(5, Number(switchAfterSeconds) || 12) * 1000;
      const now = Date.now();

      if (
        now - waitRef.current >= delay &&
        now - lastSwitchRef.current >= delay
      ) {
        void switchMarket(analysis.reason);
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

        return { ...trade, status, profit: profitOf(match) };
      })
    );

    if (result === "WON") {
      lossRef.current = 0;
      setLosses(0);
      nextEntryAtRef.current = Date.now() + 1500;
      waitRef.current = Date.now();
    } else if (result === "LOST") {
      const next = lossRef.current + 1;
      lossRef.current = next;
      setLosses(next);
      nextEntryAtRef.current = Date.now() + 2500;
      waitRef.current = Date.now();

      if (next >= 3 && runningRef.current) {
        stopAuto("Hard stop: 3 consecutive losses.");
      }
    }
  }, [openContracts]);

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent ouPage">
        <Topbar
          title="EdgePilot V78 · Over/Under Layout Fix"
          subtitle="Clean non-overlapping layout, compact quick buttons and direct selected-duration manual trading"
          connected={connected}
          connecting={loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="ouTopStrip">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={loadingMarket || autoRunning}
            onChange={changeSymbol}
          />

          <div className={`ouAccountCard ${currentType}`}>
            <label>
              <span>Account</span>
              <select value={selectedId} onChange={(event) => void switchAccount(event.target.value)}>
                {accounts.length ? accounts.map((account) => (
                  <option key={accountId(account)} value={accountId(account)}>
                    {accountType(account).toUpperCase()} · {accountId(account)}
                  </option>
                )) : (
                  <option value={selectedId}>{currentType.toUpperCase()} · {selectedId || "Not selected"}</option>
                )}
              </select>
            </label>
            <div>
              <small>LIVE BALANCE</small>
              <strong>{balance.toFixed(2)} {currency}</strong>
            </div>
          </div>

          <div className="ouTopActions">
            <button type="button" className="ouReset" onClick={resetTransactions}>
              RESET
            </button>
            <button
              type="button"
              className={autoRunning ? "ouStop" : "ouStart"}
              disabled={tradeBusy}
              onClick={toggleAuto}
            >
              {tradeBusy ? "SENDING…" : autoRunning ? "■ STOP" : "▶ START"}
            </button>
          </div>
        </section>

        <section className={`ouExecution ${autoRunning ? "running" : ""}`}>
          <div className="ouExecutionStatus">
            <small>OVER/UNDER EXECUTION</small>
            <h2>{autoRunning ? "RUNNING" : "STOPPED"}</h2>
            <p>{message || tradeError}</p>
          </div>

          <div className="ouControlGrid">
            <label><span>Stake</span><input type="number" inputMode="decimal" min="0.35" step="0.01" value={stake} onChange={(event) => setStake(event.target.value)} /></label>
            <label><span>Duration</span><select value={durationTicks} onChange={(event) => setDurationTicks(event.target.value)}><option value="1">1 TICK</option><option value="2">2 TICKS</option><option value="3">3 TICKS</option><option value="5">5 TICKS</option></select></label>
            <label><span>Manual side</span><select value={manualSide} onChange={(event) => setManualSide(event.target.value)}><option value="OVER">OVER</option><option value="UNDER">UNDER</option></select></label>
            <label><span>Barrier</span><select value={manualBarrier} onChange={(event) => setManualBarrier(Number(event.target.value))}>{[1,2,3,4,5,6,7].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <div className="ouQuickTradeButtons">
              <button
                type="button"
                className="ouQuickOver"
                disabled={tradeBusy || hasOpenTrade}
                onClick={() => {
                  setManualSide("OVER");
                  void sendTrade("OVER", manualBarrier, "MANUAL OVER");
                }}
              >
                <span>BUY</span>
                <strong>OVER {manualBarrier} · {durationTicks}T</strong>
              </button>

              <button
                type="button"
                className="ouQuickUnder"
                disabled={tradeBusy || hasOpenTrade}
                onClick={() => {
                  setManualSide("UNDER");
                  void sendTrade("UNDER", manualBarrier, "MANUAL UNDER");
                }}
              >
                <span>BUY</span>
                <strong>UNDER {manualBarrier} · {durationTicks}T</strong>
              </button>
            </div>
            <label><span>Auto switch</span><select value={autoSwitch ? "ON" : "OFF"} onChange={(event) => setAutoSwitch(event.target.value === "ON")}><option>ON</option><option>OFF</option></select></label>
            <label><span>Switch after</span><input type="number" inputMode="numeric" min="5" max="60" value={switchAfterSeconds} onChange={(event) => setSwitchAfterSeconds(event.target.value)} /></label>
            <div><span>Runs</span><strong>{runs}</strong></div>
            <div><span>Loss streak</span><strong>{losses}/3</strong></div>
            <div><span>Markets</span><strong>{switches + 1}</strong></div>
            <label className="ouRealToggle"><span>Real execution</span><input type="checkbox" checked={allowReal} disabled={currentType === "demo"} onChange={(event) => setAllowReal(event.target.checked)} /></label>
          </div>
        </section>

        <div className="ouManualHint">
          Manual OVER/UNDER executes immediately using the selected barrier,
          stake and duration ({durationTicks} tick{Number(durationTicks) === 1 ? "" : "s"}).
        </div>

        <section className={`ouHero ${analysis.tradeNow ? "ready" : analysis.prepare ? "prepare" : ""}`}>
          <div className="ouHeroDecision">
            <small>NEXT ENTRY</small>
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

        <section className="ouSignalGrid">
          <article><small>ROW PRESSURE</small><strong>{analysis.rowPressure}</strong><span>Recent movement between 0–4 and 5–9.</span></article>
          <article><small>CURRENT DIGIT</small><strong>{analysis.latestDigit}</strong><span>Latest live digit.</span></article>
          <article><small>WAIT / TRIGGER</small><strong>{analysis.triggerDigits.join(" · ") || "—"}</strong><span>Digits supporting the selected entry.</span></article>
          <article><small>WINNING DIGITS</small><strong>{analysis.winningDigits.join(" · ") || "—"}</strong><span>Digits that win the selected contract.</span></article>
          <article><small>AVOID DIGITS</small><strong>{analysis.avoidDigits.join(" · ") || "—"}</strong><span>Barrier and losing side.</span></article>
          <article><small>BEST DIFFERS</small><strong>DIFFERS {analysis.bestDiffers.digit}</strong><span>{pct(analysis.bestDiffers.differsProbability)} observed differs probability.</span></article>
        </section>

        <section className="ouCandidateGrid">
          <article><small>CONTRACT</small><strong>{analysis.best.side} {analysis.best.barrier}</strong><span>Best ranked setup.</span></article>
          <article><small>PROBABILITY</small><strong>{pct(analysis.best.probability)}</strong><span>Observed distribution.</span></article>
          <article><small>EXACT RISK</small><strong>{pct(analysis.best.exactRisk)}</strong><span>Barrier landing risk.</span></article>
          <article><small>TRANSITION</small><strong>{pct(analysis.best.transitionScore)}</strong><span>Recent continuation support.</span></article>
          <article><small>ENTRY SCORE</small><strong>{pct(analysis.best.score)}</strong><span>Weighted opportunity.</span></article>
          <article><small>ENTROPY</small><strong>{pct(analysis.entropy)}</strong><span>Higher means more random.</span></article>
        </section>

        <section className="ouMainGrid">
          <article className="ouPanel">
            <div className="ouPanelHead"><div><small>DIGIT HEATMAP</small><h2>Live distribution 0–9</h2></div><strong>{analysis.total} ticks</strong></div>
            <div className="ouDigitBars">
              {analysis.counts.map((count, digit) => {
                const value = analysis.total ? count / analysis.total * 100 : 0;
                return <div key={digit}><span>{digit}</span><i><b style={{ width: `${value}%` }} /></i><strong>{pct(value)}</strong></div>;
              })}
            </div>
          </article>

          <article className="ouPanel">
            <div className="ouPanelHead"><div><small>LIVE DIGIT FLOW</small><h2>Most recent digits</h2></div><strong>{market?.label || symbol}</strong></div>
            <div className="ouRecentDigits">
              {analysis.recentDigits.map((digit, index) => <span key={`${digit}-${index}`} className={index === analysis.recentDigits.length - 1 ? "latest" : digit <= 4 ? "lower" : "upper"}>{digit}</span>)}
            </div>
            <div className="ouDiffersList">
              {analysis.differs.map((item) => <div key={item.digit}><strong>DIFFERS {item.digit}</strong><span>risk {pct(item.exactRisk)}</span><b>{pct(item.differsProbability)}</b></div>)}
            </div>
          </article>
        </section>

        <section className="ouPanel ouBarrierPanel">
          <div className="ouPanelHead"><div><small>BARRIER COMPARISON</small><h2>Over and Under probability</h2></div></div>
          <div className="ouBarrierTable">
            <div className="head"><span>Barrier</span><span>Over</span><span>Under</span><span>Exact risk</span></div>
            {analysis.rows.map((row) => <button type="button" key={row.barrier} className={row.barrier === analysis.best.barrier ? "selected" : ""} onClick={() => setManualBarrier(row.barrier)}><strong>{row.barrier}</strong><span>{pct(row.over)}</span><span>{pct(row.under)}</span><span>{pct(row.exact)}</span></button>)}
          </div>
        </section>

        <section className="ouPanel">
          <div className="ouPanelHead"><div><small>TRADE VIEWER</small><h2>Open and recent trades</h2></div><strong>{trades.length} trades</strong></div>
          <div className="ouTradeTable">
            <div className="head"><span>Time</span><span>Market</span><span>Contract</span><span>Mode</span><span>Stake</span><span>Status</span><span>P/L</span></div>
            {trades.map((trade) => <div key={trade.id}><span>{new Date(trade.time).toLocaleTimeString()}</span><span>{trade.symbol}</span><strong>{trade.contract}</strong><span>{trade.source}</span><span>{Number(trade.stake).toFixed(2)}</span><b className={String(trade.status).toLowerCase()}>{trade.status}</b><b className={trade.profit >= 0 ? "won" : "lost"}>{Number(trade.profit).toFixed(2)}</b></div>)}
            {!trades.length ? <p>No trades in this session.</p> : null}
          </div>
        </section>

        <div className="ouDisclaimer">Analysis is probabilistic. Test on Demo before enabling Real execution.</div>
      </main>
    </div>
  );
}
