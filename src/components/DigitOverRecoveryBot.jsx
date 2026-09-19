import { useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import {
  analyzeDigitContract,
  digitPathString,
  selectBestDigitContract,
} from "../analysis/digitOverEngine";
import "../styles/DigitOverRecoveryBot.css";

const STORAGE_KEY = "zentora_digit_over_under_v10";
const roundStakeDown = (value) => Math.floor((Number(value) + 1e-9) * 100) / 100;
const money = (value, currency = "USD") =>
  `${Number(value || 0) >= 0 ? "+" : "-"}$${Math.abs(Number(value || 0)).toFixed(2)} ${String(currency).toUpperCase()}`;
const idOf = (value) =>
  String(value?.contract_id || value?.contractId || value?.id || value?.proposal_open_contract?.contract_id || "");
const settled = (value) =>
  Boolean(value?.is_sold || value?.is_expired || value?.is_settled ||
    ["won", "lost", "sold", "expired", "settled"].includes(
      String(value?.status || value?.contract_status || "").toLowerCase()
    ));
const profitOf = (value) => {
  const direct = Number(value?.profit ?? value?.profit_loss ?? value?.pnl);
  return Number.isFinite(direct) ? direct : 0;
};

const readState = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
};

export default function DigitOverRecoveryBot() {
  const auth = useDerivAuth();
  const {
    markets = [], market, symbol, digitHistory = [], currentPrice,
    openContracts = [], selectedAccount, selectedAccountType = "demo",
    selectedAccountId, connected, status, statusDetail, changeSymbol,
    quoteTrade, placeQuotedTrade, tradeBusy, tradeError,
  } = useDerivTicks();

  const [barrierMode, setBarrierMode] = useState("AUTO");
  const [running, setRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [duration, setDuration] = useState(5);
  const [scanEvery, setScanEvery] = useState(1);
  const [minEdge, setMinEdge] = useState(0.015);
  const [minProbability, setMinProbability] = useState(0.72);
  const [recoveryEnabled, setRecoveryEnabled] = useState(true);
  const [recoveryMultiplier, setRecoveryMultiplier] = useState(1.5);
  const [maxRecoverySteps, setMaxRecoverySteps] = useState(3);
  const [maxLosses, setMaxLosses] = useState(3);
  const [cooldownSeconds, setCooldownSeconds] = useState(10);
  const [allowReal, setAllowReal] = useState(false);
  const [pnl, setPnl] = useState(0);
  const [losses, setLosses] = useState(0);
  const [recoveryStep, setRecoveryStep] = useState(0);
  const [message, setMessage] = useState("Scanner ready — DEMO first.");
  const [tradeHistory, setTradeHistory] = useState([]);
  const [buffers, setBuffers] = useState(() => readState().buffers || {});
  const [lastScanAt, setLastScanAt] = useState(0);
  const [lastDecision, setLastDecision] = useState(null);

  const busyRef = useRef(false);
  const doneRef = useRef(new Set());
  const recoveryRef = useRef(0);
  const blockedKeyRef = useRef("");
  const blockedUntilRef = useRef(0);
  const lastEntryRef = useRef(0);
  const analysisRef = useRef(null);

  const currentDigits = useMemo(() => {
    const incoming = digitHistory.slice(-60).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
    if (!symbol) return incoming;
    const previous = Array.isArray(buffers[symbol]) ? buffers[symbol] : [];
    return [...previous, ...incoming].slice(-60);
  }, [buffers, digitHistory, symbol]);

  useEffect(() => {
    if (!symbol || !digitHistory.length) return;
    const incoming = digitHistory.slice(-60).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
    if (incoming.length) setBuffers((prev) => ({ ...prev, [symbol]: incoming.slice(-60) }));
  }, [digitHistory, symbol]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 10, updatedAt: Date.now(), buffers }));
    } catch {}
  }, [buffers]);

  const empty = useMemo(() => ({
    ready: false, barrier: 2, direction: "OVER", signal: "WAIT", grade: "BUILDING",
    probability: 0.5, empirical: 0.5, transition: null, tail: 0.5, stability: 0,
    edgeVsBaseline: 0, score: 0, samples: currentDigits.length, hotDigit: null,
    hotCount: 0, overCount: 0, entropy: 0, regime: "BUILDING",
    path: currentDigits.slice(-20), reason: "Waiting for the 60-digit model to initialize."
  }), [currentDigits]);

  const selection = useMemo(() => {
    if (barrierMode === "AUTO") return selectBestDigitContract(currentDigits, { barriers: [2, 1] });
    const barrier = Number(barrierMode) || 2;
    const over = analyzeDigitContract(currentDigits, { barrier, direction: "OVER" });
    const under = analyzeDigitContract(currentDigits, { barrier, direction: "UNDER" });
    const best = [over, under].filter((x) => x.signal !== "WAIT").sort((a, b) => b.probability - a.probability)[0] || over;
    return { analysis: best, candidates: [over, under], barrier, direction: best.direction, alternatives: {
      [`OVER-${barrier}`]: over, [`UNDER-${barrier}`]: under
    }};
  }, [barrierMode, currentDigits]);

  const analysis = selection?.analysis || empty;
  analysisRef.current = analysis;

  const currency = String(selectedAccount?.currency || "USD").toUpperCase();
  const real = String(selectedAccountType).toLowerCase() === "real";
  const accountId = String(selectedAccountId || selectedAccount?.id || "");
  const balance = Number(selectedAccount?.balance);
  const liveBalance = Number.isFinite(balance) && balance > 0 ? balance : 0;
  const accounts = Array.isArray(auth.accounts) ? auth.accounts : [];
  const realAccount = accounts.find((account) => {
    const id = String(account?.id || account?.account_id || account?.loginid || "").toUpperCase();
    const type = String(account?.accountType || account?.account_type || account?.type || "").toLowerCase();
    return type.includes("real") || type.includes("financial") || (!id.startsWith("VRTC") && !id.startsWith("VR") && !id.includes("DEMO"));
  }) || null;
  const active = openContracts.find((contract) => !settled(contract));

  const currentKey = `${symbol}|${analysis.direction}|${analysis.barrier}|${duration}`;
  const baseStake = Math.max(0.01, Number(stake) || 0.01);
  const recoveryStake = recoveryEnabled
    ? baseStake * Math.pow(Number(recoveryMultiplier) || 1.5, recoveryStep)
    : baseStake;
  const usableAmount = real ? Math.min(recoveryStake, liveBalance) : recoveryStake;
  const safeAmount = roundStakeDown(usableAmount);

  const path = analysis.path || [];
  const signalValid = analysis.ready && analysis.signal !== "WAIT";
  const setupChecks = [
    analysis.ready,
    analysis.probability >= Number(minProbability),
    analysis.score >= 72,
    analysis.stability >= 0.25,
    analysis.regime !== "NOISY",
    analysis.edgeVsBaseline >= 0.01,
  ];
  const setupCount = setupChecks.filter(Boolean).length;

  useEffect(() => {
    for (const contract of openContracts) {
      const id = idOf(contract);
      if (!id || !settled(contract) || doneRef.current.has(id)) continue;
      doneRef.current.add(id);
      const profit = profitOf(contract);
      setPnl((v) => v + profit);
      setTradeHistory((rows) => rows.map((row) =>
        row.id === id ? { ...row, result: profit >= 0 ? "WON" : "LOST", pnl: profit } : row
      ));

      const row = tradeHistory.find((item) => item.id === id);
      const failedKey = row?.key || currentKey;

      if (profit < 0) {
        const nextStep = recoveryEnabled ? recoveryRef.current + 1 : 0;
        recoveryRef.current = Math.min(nextStep, Number(maxRecoverySteps) || 0);
        setRecoveryStep(recoveryRef.current);
        setLosses((v) => v + 1);

        // A losing signal is CLOSED. The engine must not immediately re-fire the
        // same contract key. It waits for a fresh setup or a different key.
        blockedKeyRef.current = failedKey;
        blockedUntilRef.current = Date.now() + Math.max(1, Number(cooldownSeconds)) * 1000;

        setMessage(
          `LOSS · ${row?.direction || analysis.direction} ${row?.barrier || analysis.barrier} closed · `
          + `cooldown ${cooldownSeconds}s · searching for a fresh setup.`
        );
      } else {
        recoveryRef.current = 0;
        setRecoveryStep(0);
        blockedKeyRef.current = "";
        blockedUntilRef.current = 0;
        setMessage("WIN · recovery reset · scanning for the next independent setup.");
      }
    }
  }, [openContracts, tradeHistory, currentKey, analysis.direction, analysis.barrier, cooldownSeconds, maxRecoverySteps, recoveryEnabled]);

  useEffect(() => {
    if (!running) return undefined;

    const timer = window.setInterval(async () => {
      const now = Date.now();
      setLastScanAt(now);

      if (busyRef.current || tradeBusy || active || !connected || !accountId || !symbol) return;
      if (!analysisRef.current?.ready) {
        setMessage(`BUILDING 60-DIGIT WINDOW · ${analysisRef.current?.samples || 0}/60`);
        return;
      }
      if (pnl <= -Math.abs(Number(stake) * Number(maxLosses))) {
        setRunning(false);
        setMessage(`SESSION STOP · ${money(pnl, currency)}`);
        return;
      }
      if (losses >= Number(maxLosses)) {
        setRunning(false);
        setMessage(`MAX LOSSES · ${losses}/${maxLosses}`);
        return;
      }
      if (real && !allowReal) {
        setMessage("REAL selected · Arm REAL trading to permit execution.");
        return;
      }
      if (real && liveBalance <= 0) {
        setMessage("REAL waiting · live balance unavailable.");
        return;
      }
      if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
        setMessage("NO USABLE STAKE · waiting for a positive balance.");
        return;
      }
      if (Date.now() - lastEntryRef.current < Math.max(1, Number(scanEvery)) * 1000) return;

      const a = analysisRef.current;
      const key = `${symbol}|${a.direction}|${a.barrier}|${duration}`;

      if (blockedKeyRef.current === key && Date.now() < blockedUntilRef.current) {
        setMessage(`COOLDOWN · closed ${a.direction} ${a.barrier} · waiting for a different/fresh setup.`);
        return;
      }

      if (a.signal === "WAIT" || a.probability < Number(minProbability) || a.score < 72 || a.stability < 0.25 || a.edgeVsBaseline < 0.01) {
        setMessage(`WAIT · ${a.regime} · ${setupCount}/6 setup checks · ${(a.probability * 100).toFixed(1)}% model.`);
        return;
      }

      busyRef.current = true;
      const contractType = a.direction === "UNDER" ? "DIGITUNDER" : "DIGITOVER";
      const args = {
        contractType,
        amount: safeAmount,
        basis: "stake",
        currency,
        duration: Math.max(1, Math.min(20, Number(duration) || 5)),
        durationUnit: "t",
        barrier: String(a.barrier),
        symbol,
      };

      try {
        setMessage(`PROPOSAL · ${a.direction} ${a.barrier} · ${args.duration}t · ${real ? "REAL" : "DEMO"}`);
        const quote = await quoteTrade(args);
        const ask = Number(quote?.askPrice);
        const payout = Number(quote?.payout);
        if (!quote?.proposalId || !Number.isFinite(ask) || !Number.isFinite(payout) || payout <= ask) {
          throw new Error("Invalid Deriv proposal.");
        }

        const implied = ask / payout;
        const edge = Number(a.probability) - implied;
        const ev = Number(a.probability) * payout - ask;
        if (edge < Number(minEdge) || ev <= 0) {
          setMessage(`SKIP · payout ${(payout / ask * 100).toFixed(1)}% · model ${(a.probability * 100).toFixed(1)}% · edge ${(edge * 100).toFixed(1)}% · EV ${ev.toFixed(3)}`);
          return;
        }

        const result = await placeQuotedTrade({ quote });
        const contractId = idOf(result);
        lastEntryRef.current = Date.now();

        setTradeHistory((rows) => [{
          id: contractId || `pending-${Date.now()}`,
          result: "OPEN",
          contractType,
          direction: a.direction,
          barrier: a.barrier,
          symbol,
          duration: args.duration,
          stake: safeAmount,
          model: a.probability,
          implied,
          edge,
          ev,
          score: a.score,
          regime: a.regime,
          path: digitPathString(a.path),
          key,
          pnl: null,
        }, ...rows].slice(0, 8));

        setLastDecision({
          direction: a.direction, barrier: a.barrier, probability: a.probability,
          payout, edge, ev, score: a.score, valid: true, at: Date.now()
        });
        setMessage(`${real ? "REAL" : "DEMO"} EXECUTED · ${a.direction} ${a.barrier} · ${contractId || "accepted"}`);
      } catch (error) {
        setMessage(`EXECUTION FAILED · ${error instanceof Error ? error.message : String(error || tradeError || "unknown error")}`);
      } finally {
        busyRef.current = false;
      }
    }, Math.max(1000, Number(scanEvery) * 1000));

    return () => window.clearInterval(timer);
  }, [
    running, active, connected, accountId, symbol, tradeBusy, tradeError, quoteTrade,
    placeQuotedTrade, real, allowReal, liveBalance, safeAmount, duration, currency,
    minProbability, minEdge, scanEvery, pnl, losses, maxLosses, stake, currentKey,
    setupCount, cooldownSeconds
  ]);

  const resetSession = () => {
    setRunning(false); setPnl(0); setLosses(0); recoveryRef.current = 0;
    blockedKeyRef.current = ""; blockedUntilRef.current = 0; setRecoveryStep(0);
    doneRef.current.clear(); setTradeHistory([]); setLastDecision(null);
    setMessage("Session reset · scanner ready.");
  };

  const resetDigitBooks = () => {
    setBuffers({});
    setMessage("60-digit books reset · rebuilding from live ticks.");
  };

  const directionColor = analysis.direction === "UNDER" ? "underSignal" : "overSignal";
  const currentSignal = signalValid ? `${analysis.direction} ${analysis.barrier}` : "WAIT";
  const statusLabel = running ? "ANALYZING" : "STOPPED";
  const payoutDisplay = lastDecision?.payout ? `${((lastDecision.payout / Math.max(0.01, safeAmount)) * 100).toFixed(1)}%` : "—";

  return (
    <section className="digitBot digitV10">
      <header className="digitHero">
        <div>
          <span>ZENTORA · DIGIT OVER / UNDER V10</span>
          <h2>Analyze → Validate → Execute → Settle → Re-analyze</h2>
          <p>One decision engine for DEMO and REAL. OVER and UNDER compete from the same 60-digit history, live proposal, probability, payout and risk gates.</p>
        </div>
        <div className={`digitRun ${running ? "on" : ""}`}><i />{statusLabel}</div>
      </header>

      <div className="digitAccountBar">
        <div><small>ACCOUNT</small><b>{selectedAccount?.name || (real ? "Real Account" : "Demo Account")}</b></div>
        <div><small>MODE</small><b>{real ? "REAL" : "DEMO"}</b></div>
        <div><small>BALANCE</small><b>${Number(balance || 0).toFixed(2)} {currency}</b></div>
        <div className="accountMode"><button className={!real ? "active" : ""} onClick={() => setMessage("DEMO account active.")}>DEMO</button><button className={real ? "active" : ""} onClick={() => {
          const targetId = String(realAccount?.id || realAccount?.account_id || realAccount?.loginid || "");
          if (targetId && typeof auth.selectAccount === "function") { auth.selectAccount(targetId); setAllowReal(false); }
        }}>REAL</button></div>
      </div>

      <div className="digitTopGrid v10grid">
        <div className="digitCard settingsCard">
          <div className="digitCardTitle">DIGIT OVER / UNDER SETTINGS</div>
          <div className="digitControls v10controls">
            <label>Contract type<select value="DIGIT" onChange={() => {}}><option>DIGIT OVER / UNDER</option></select></label>
            <label>Digits<select value={barrierMode} onChange={(e) => setBarrierMode(e.target.value)}><option value="AUTO">AUTO · BEST EDGE</option><option value="2">2</option><option value="1">1</option></select></label>
            <label>Duration (ticks)<input type="number" min="1" max="20" value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
            <label>Stake (USD)<input type="number" min="0.01" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} /></label>
            <label>Prediction threshold (%)<input type="number" min="50" max="95" value={Math.round(Number(minProbability) * 100)} onChange={(e) => setMinProbability(Number(e.target.value) / 100)} /></label>
            <label>Min edge (%)<input type="number" min="0.5" max="15" step="0.1" value={(Number(minEdge) * 100).toFixed(1)} onChange={(e) => setMinEdge(Number(e.target.value) / 100)} /></label>
            <label>Auto trade<input type="checkbox" checked={running} onChange={() => setRunning((v) => !v)} /></label>
            <label>Use recovery<input type="checkbox" checked={recoveryEnabled} onChange={(e) => setRecoveryEnabled(e.target.checked)} /></label>
            <label>Max consecutive losses<select value={maxLosses} onChange={(e) => setMaxLosses(Number(e.target.value))}>{[1,2,3,4,5].map((n) => <option key={n}>{n}</option>)}</select></label>
            <label>Cooldown after loss (s)<input type="number" min="1" max="120" value={cooldownSeconds} onChange={(e) => setCooldownSeconds(e.target.value)} /></label>
            <label>Multiplier<input type="number" min="1" max="2" step="0.1" value={recoveryMultiplier} onChange={(e) => setRecoveryMultiplier(e.target.value)} /></label>
            <label>Max recovery steps<input type="number" min="0" max="5" value={maxRecoverySteps} onChange={(e) => setMaxRecoverySteps(e.target.value)} /></label>
          </div>
          <button className="saveSettings" onClick={() => setMessage("Settings applied to the same DEMO/REAL strategy engine.")}>SAVE SETTINGS</button>
        </div>

        <div className="digitCard decisionCard">
          <div className="digitCardTitle">OVER / UNDER DECISION LOGIC</div>
          <div className="modePills"><span className="active">AUTO</span><span>MANUAL</span><span>HYBRID</span></div>
          <div className="flowBox"><b>ANALYZE LAST 60 DIGITS</b><small>Frequency · transition · stability · regime</small></div>
          <div className="flowArrow">↓</div>
          <div className="flowBox"><b>CALCULATE PROBABILITY</b><small>OVER vs UNDER · live proposal · expected value</small></div>
          <div className="flowArrow">↓</div>
          <div className="flowBox"><b>CHECK TRADE CONDITIONS</b><small>{setupCount}/6 setup checks · payout + EV · risk · cooldown</small></div>
          <div className="flowArrow">↓</div>
          <div className="flowBox executeBox"><b>EXECUTE {currentSignal}</b><small>Only after the live Deriv proposal passes</small></div>
          <div className="lossBox"><b>IF LOSS</b><span>Close the failed signal → cooldown → reject same key → re-analyze → find a fresh OVER/UNDER setup. Recovery is only used on a new validated setup.</span></div>
          <div className="winBox">✓ WIN → reset recovery → continue scanning</div>
        </div>

        <div className="digitCard signalCard">
          <div className="signalHeader"><div><small>LIVE SIGNAL</small><strong>{statusLabel}</strong></div><span className="signalDot" /></div>
          <div className={`bigSignal ${directionColor}`}>{currentSignal}</div>
          <div className="signalStats"><div><small>Model probability</small><b>{(analysis.probability * 100).toFixed(1)}%</b></div><div><small>Score</small><b>{analysis.score}/100</b></div><div><small>Edge baseline</small><b>{(analysis.edgeVsBaseline * 100).toFixed(1)}%</b></div></div>
          <div className="digitPath compactPath">{path.map((digit, i) => <span key={`${i}-${digit}`} className={digit > analysis.barrier ? "over" : "under"}>{digit}</span>)}</div>
          <div className="signalChecks">
            {[
              [`Probability ≥ ${Math.round(Number(minProbability)*100)}%`, analysis.probability >= Number(minProbability)],
              ["Score ≥ 72", analysis.score >= 72],
              ["Stability ≥ 25%", analysis.stability >= 0.25],
              ["Regime safe", analysis.regime !== "NOISY"],
              ["Edge baseline ≥ 1%", analysis.edgeVsBaseline >= 0.01],
              ["Cooldown clear", !(blockedKeyRef.current === currentKey && Date.now() < blockedUntilRef.current)]
            ].map(([label, ok]) => <div key={label}><span className={ok ? "check on" : "check"}>✓</span><span>{label}</span><b>{ok ? "PASS" : "WAIT"}</b></div>)}
          </div>
          <button className="executeButton" disabled={!signalValid || !connected || !!active} onClick={() => setRunning(true)}>▶ EXECUTE / START AUTO</button>
          <button className="skipButton" onClick={() => setMessage(`SKIP SIGNAL · ${currentSignal} · searching next setup.`)}>▸ SKIP SIGNAL</button>
        </div>
      </div>

      <div className="digitLowerGrid v10lower">
        <div className="digitCard recoveryCard">
          <div className="digitCardTitle">RECOVERY STRATEGY</div>
          <div className="recoveryRow"><span>Current step</span><b>{recoveryStep}/{maxRecoverySteps}</b></div>
          <div className="recoveryRow"><span>Current stake</span><b>${safeAmount.toFixed(2)}</b></div>
          <div className="recoveryRow"><span>Session P/L</span><b className={pnl >= 0 ? "profit" : "loss"}>{money(pnl, currency)}</b></div>
          <div className="recoveryRow"><span>Loss count</span><b>{losses}/{maxLosses}</b></div>
          <p className="digitNote">Recovery never forces the same losing signal. After a loss, that exact contract key is closed and blocked during cooldown. The next recovery stake can only be used after a fresh validated setup.</p>
        </div>

        <div className="digitCard proposalCard">
          <div className="digitCardTitle">PROPOSAL GATE</div>
          <div className="digitGate"><span>Contract</span><b>{analysis.direction === "UNDER" ? "DIGITUNDER" : "DIGITOVER"} · {analysis.barrier}</b></div>
          <div className="digitGate"><span>Current key</span><b>{currentKey}</b></div>
          <div className="digitGate"><span>Selected account</span><b>{real ? "REAL" : "DEMO"} · {accountId || "NOT CONNECTED"}</b></div>
          <div className="digitGate"><span>Trading connection</span><b>{connected ? (real ? "REAL CONNECTED" : "DEMO CONNECTED") : "NOT CONNECTED"}</b></div>
          <div className="digitGate"><span>Last payout</span><b>{payoutDisplay}</b></div>
          <div className="digitGate"><span>Execution</span><b>{active ? `OPEN · ${idOf(active)}` : "NO OPEN CONTRACT"}</b></div>
          <div className="digitMessage">{message}</div>
        </div>
      </div>

      <div className="digitActions">
        {!real && realAccount ? <button onClick={() => { auth.selectAccount(realAccount.id || realAccount.account_id || realAccount.loginid); setAllowReal(false); }}>USE REAL ACCOUNT</button> : null}
        <label><input type="checkbox" checked={allowReal} onChange={(e) => setAllowReal(e.target.checked)} disabled={!real} /> Arm REAL trading</label>
        <button onClick={resetSession}>RESET SESSION</button>
        <button onClick={resetDigitBooks}>RESET 60-DIGIT BOOKS</button>
        <button className={running ? "danger" : "primary"} onClick={() => setRunning((v) => !v)}>{running ? "STOP BOT" : "START BOT"}</button>
      </div>

      <div className="digitCard digitJournal">
        <div className="digitCardTitle">DIGIT OVER / UNDER JOURNAL · {tradeHistory.length}/8</div>
        {tradeHistory.length === 0 ? <div className="digitEmpty">No executions yet. The engine will wait until a valid setup and positive Deriv proposal appear.</div> :
          tradeHistory.map((row) => <div className="digitJournalRow v10journal" key={row.id}>
            <b className={row.result === "WON" ? "profit" : row.result === "LOST" ? "loss" : "open"}>{row.result}</b>
            <span>{row.direction} {row.barrier}</span><span>{row.symbol}</span><span>{row.duration}t</span>
            <span>Model {(Number(row.model || 0) * 100).toFixed(1)}%</span><span>Edge {(Number(row.edge || 0) * 100).toFixed(1)}%</span>
            <span>{row.pnl == null ? "OPEN" : money(row.pnl, currency)}</span>
          </div>)}
      </div>

      <footer className="digitFooter">
        <span>Markets: {Object.keys(buffers).length}</span><span>Current: {currentDigits.length}/60</span>
        <span>Strategy: AUTO OVER / UNDER</span><span>Last scan: {lastScanAt ? new Date(lastScanAt).toLocaleTimeString() : "—"}</span>
        <span className="spacer">{real ? "REAL" : "DEMO"} · {currency}</span>
      </footer>
    </section>
  );
}
