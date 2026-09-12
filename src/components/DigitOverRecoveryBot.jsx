import { useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import { analyzeDigitOver, digitPathString } from "../analysis/digitOverEngine";
import "../styles/DigitOverRecoveryBot.css";

const STORAGE_KEY = "zentora_digit_over_recovery_v1";
const BARRIERS = [2, 3];
const MIN_STAKE = 0.35;
const money = (value, currency = "USD") =>
  `${Number(value || 0) >= 0 ? "+" : "-"}$${Math.abs(Number(value || 0)).toFixed(2)} ${String(currency).toUpperCase()}`;
const idOf = (value) =>
  String(value?.contract_id || value?.contractId || value?.id || value?.proposal_open_contract?.contract_id || "");
const settled = (value) =>
  Boolean(value?.is_sold || value?.is_expired || value?.is_settled || ["won", "lost", "sold", "expired", "settled"].includes(String(value?.status || value?.contract_status || "").toLowerCase()));
const profitOf = (value) => {
  const direct = Number(value?.profit ?? value?.profit_loss ?? value?.pnl);
  return Number.isFinite(direct) ? direct : 0;
};

const readState = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

export default function DigitOverRecoveryBot() {
  const auth = useDerivAuth();
  const {
    markets = [],
    market,
    symbol,
    prices = [],
    currentPrice,
    openContracts = [],
    selectedAccount,
    selectedAccountType = "demo",
    selectedAccountId,
    connected,
    status,
    statusDetail,
    digitHistory = [],
    changeSymbol,
    quoteTrade,
    placeQuotedTrade,
    tradeBusy,
    tradeError,
  } = useDerivTicks();

  const [barrier, setBarrier] = useState(2);
  const [running, setRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [duration, setDuration] = useState(5);
  const [scanEvery, setScanEvery] = useState(10);
  const [minEdge, setMinEdge] = useState(0.03);
  const [recoveryEnabled, setRecoveryEnabled] = useState(true);
  const [recoveryMultiplier, setRecoveryMultiplier] = useState(1.5);
  const [maxRecoverySteps, setMaxRecoverySteps] = useState(2);
  const [maxLosses, setMaxLosses] = useState(3);
  const [sessionStop, setSessionStop] = useState(3);
  const [allowReal, setAllowReal] = useState(false);
  const [message, setMessage] = useState("Digit scanner ready — DEMO first.");
  const [pnl, setPnl] = useState(0);
  const [losses, setLosses] = useState(0);
  const [recoveryStep, setRecoveryStep] = useState(0);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [buffers, setBuffers] = useState(() => readState().buffers || {});
  const [lastScanAt, setLastScanAt] = useState(0);

  const busyRef = useRef(false);
  const doneRef = useRef(new Set());
  const recoveryRef = useRef(0);
  const lastEntryRef = useRef(0);
  const analysisRef = useRef(null);

  const currentDigits = useMemo(() => {
    const incoming = digitHistory.slice(-60).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
    if (!symbol) return incoming;
    const previous = Array.isArray(buffers[symbol]) ? buffers[symbol] : [];
    const merged = [...previous, ...incoming];
    return merged.slice(-60);
  }, [buffers, digitHistory, symbol]);

  // Keep a separate rolling 60-digit book per selected market. Each new tick
  // replaces the oldest digit; switching markets preserves the other market's
  // last 60 digits instead of sharing one global history.
  useEffect(() => {
    if (!symbol || !digitHistory.length) return;
    const incoming = digitHistory.slice(-60).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
    if (!incoming.length) return;
    setBuffers((prev) => ({ ...prev, [symbol]: incoming.slice(-60) }));
  }, [digitHistory, symbol]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, updatedAt: Date.now(), buffers }));
    } catch {
      // Local evidence is best-effort; the live Deriv stream remains authoritative.
    }
  }, [buffers]);

  const analysis = useMemo(() => analyzeDigitOver(currentDigits, { barrier }), [currentDigits, barrier]);
  analysisRef.current = analysis;

  const currency = String(selectedAccount?.currency || "USD").toUpperCase();
  const real = String(selectedAccountType).toLowerCase() === "real";
  const balance = Number(selectedAccount?.balance);
  const accountId = String(selectedAccountId || selectedAccount?.id || "");
  const active = openContracts.find((contract) => !settled(contract));
  const riskCap = Number.isFinite(balance) && balance > 0 ? balance * 0.01 : Infinity;
  const baseStake = Math.max(MIN_STAKE, Number(stake) || MIN_STAKE);
  const recoveryStake = recoveryEnabled ? baseStake * Math.pow(Number(recoveryMultiplier) || 1.5, recoveryStep) : baseStake;
  const amount = Math.min(recoveryStake, riskCap);
  const safeAmount = Math.max(MIN_STAKE, amount);
  const contractKey = `${symbol}|${barrier}|${duration}|${currency}`;

  useEffect(() => {
    for (const contract of openContracts) {
      const id = idOf(contract);
      if (!id || !settled(contract) || doneRef.current.has(id)) continue;
      doneRef.current.add(id);
      const p = profitOf(contract);
      setPnl((value) => value + p);
      setTradeHistory((rows) => rows.map((row) => row.id === id ? { ...row, result: p >= 0 ? "WON" : "LOST", pnl: p } : row));
      if (p < 0) {
        const next = Math.min(Number(maxRecoverySteps) || 2, recoveryRef.current + 1);
        recoveryRef.current = next;
        setRecoveryStep(next);
        setLosses((value) => value + 1);
        setMessage(`LOSS ${id} · recovery step ${next}/${maxRecoverySteps}`);
      } else {
        recoveryRef.current = 0;
        setRecoveryStep(0);
        setMessage(`WIN ${id} · recovery reset`);
      }
    }
  }, [maxRecoverySteps, openContracts]);

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(async () => {
      const now = Date.now();
      setLastScanAt(now);
      if (busyRef.current || tradeBusy || active || !connected || !accountId || !symbol) return;

      const a = analysisRef.current;
      if (!a?.ready) {
        setMessage(`BUILDING 60-DIGIT WINDOW · ${a?.samples || 0}/60`);
        return;
      }
      if (pnl <= -Math.abs(Number(sessionStop))) {
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
      if (real && (!Number.isFinite(balance) || balance < 35)) {
        setMessage("REAL LOCK · balance must be at least $35 for the $0.35 / 1% risk rule.");
        return;
      }
      if (safeAmount < MIN_STAKE) {
        setMessage("RISK LOCK · calculated stake is below the Deriv minimum.");
        return;
      }
      if (Date.now() - lastEntryRef.current < Math.max(3, Number(scanEvery)) * 1000) return;

      // No forcing: if the regime/score/probability is not clean, the cycle is
      // intentionally skipped and the next 10-second scan starts fresh.
      if (a.signal === "WAIT") {
        setMessage(`SKIP · ${a.regime} · model ${(a.probability * 100).toFixed(1)}% · ${a.reason}`);
        return;
      }

      busyRef.current = true;
      const args = {
        contractType: "DIGITOVER",
        amount: safeAmount,
        basis: "stake",
        currency,
        duration: Math.max(1, Math.min(20, Number(duration) || 5)),
        durationUnit: "t",
        barrier: String(barrier),
        symbol,
      };

      try {
        setMessage(`PROPOSAL · OVER ${barrier} · ${symbol} · ${args.duration}t · ${real ? "REAL" : "DEMO"}`);
        const quote = await quoteTrade(args);
        const ask = Number(quote?.askPrice);
        const payout = Number(quote?.payout);
        if (!quote?.proposalId || !Number.isFinite(ask) || !Number.isFinite(payout) || payout <= ask) {
          throw new Error("Invalid Deriv DIGITOVER proposal.");
        }

        const implied = ask / payout;
        const edge = Number(a.probability) - implied;
        const ev = Number(a.probability) * payout - ask;
        if (edge < Number(minEdge) || ev <= 0) {
          setMessage(`SKIP · proposal BE ${(implied * 100).toFixed(1)}% · model ${(a.probability * 100).toFixed(1)}% · edge ${(edge * 100).toFixed(1)}% · EV ${ev.toFixed(3)}`);
          return;
        }
        if (real && safeAmount > balance * 0.01) {
          setMessage(`REAL RISK SKIP · ${money(safeAmount, currency)} exceeds 1% balance.`);
          return;
        }

        const result = await placeQuotedTrade({ quote });
        const contractId = idOf(result);
        lastEntryRef.current = Date.now();
        setTradeHistory((rows) => [
          {
            id: contractId || `pending-${Date.now()}`,
            result: "OPEN",
            contractType: "DIGITOVER",
            barrier,
            symbol,
            duration: args.duration,
            stake: safeAmount,
            model: a.probability,
            implied,
            edge,
            ev,
            hotDigit: a.hotDigit,
            regime: a.regime,
            path: digitPathString(a.path),
            pnl: null,
          },
          ...rows,
        ].slice(0, 8));
        setMessage(`${real ? "REAL" : "DEMO"} EXECUTED · OVER ${barrier} · C ${contractId || "accepted"}`);
      } catch (error) {
        setMessage(`EXECUTION FAILED · ${error instanceof Error ? error.message : String(error || tradeError || "unknown error")}`);
      } finally {
        busyRef.current = false;
      }
    }, Math.max(3000, Number(scanEvery) * 1000));
    return () => window.clearInterval(timer);
  }, [accountId, active, allowReal, balance, barrier, connected, currency, duration, losses, maxLosses, minEdge, pnl, placeQuotedTrade, quoteTrade, real, safeAmount, scanEvery, sessionStop, symbol, tradeBusy, tradeError, running]);

  const resetSession = () => {
    setRunning(false);
    setPnl(0);
    setLosses(0);
    recoveryRef.current = 0;
    setRecoveryStep(0);
    doneRef.current.clear();
    setTradeHistory([]);
    setMessage("Session reset — scanner ready.");
  };

  const resetDigitBooks = () => {
    setBuffers({});
    setMessage("All 60-digit market books reset. They will rebuild from live/history ticks.");
  };

  return (
    <section className="digitBot">
      <div className="digitHero">
        <div>
          <span>ZENTORA · DIGIT OVER RECOVERY V1</span>
          <h2>60 Digits → Cursor Path → Proposal → Execution</h2>
          <p>Separate rolling 60-digit data per market. OVER 2 and OVER 3 scan every 10 seconds and skip when volatility or proposal value is not clean.</p>
        </div>
        <div className={`digitRun ${running ? "on" : ""}`}>{running ? "SCANNING" : "STOPPED"}</div>
      </div>

      <div className="digitTopGrid">
        <div className="digitCard">
          <div className="digitCardTitle">DERIV MARKET</div>
          <div className="digitControls">
            <label>Market<select value={symbol} onChange={(e) => changeSymbol(e.target.value)}>{markets.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
            <label>Strategy<select value={barrier} onChange={(e) => setBarrier(Number(e.target.value))}><option value={2}>OVER 2</option><option value={3}>OVER 3</option></select></label>
            <label>Duration<input type="number" min="1" max="20" value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
            <label>Stake<input type="number" min="0.35" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} /></label>
          </div>
          <div className="digitStatus"><span className={connected ? "liveDot" : "deadDot"}></span><b>{status}</b><small>{statusDetail || "Waiting for Deriv"}</small></div>
          <div className="digitMarketLine"><span>Price</span><b>{Number(currentPrice || 0).toFixed(market?.decimals ?? 3)}</b><span>Last digit</span><strong>{currentDigits.at(-1) ?? "—"}</strong></div>
        </div>

        <div className="digitCard digitModelCard">
          <div className="digitCardTitle">AI DIGIT MAP · {symbol || "—"}</div>
          <div className="digitMetricGrid">
            <div><span>Window</span><b>{currentDigits.length}/60</b></div>
            <div><span>Model</span><b>{(analysis.probability * 100).toFixed(1)}%</b></div>
            <div><span>Over count</span><b>{analysis.overCount}/60</b></div>
            <div><span>Hot digit</span><b>{analysis.hotDigit ?? "—"} · {analysis.hotCount || 0}×</b></div>
            <div><span>Transition</span><b>{analysis.transition == null ? "—" : `${(analysis.transition * 100).toFixed(1)}%`}</b></div>
            <div><span>Stability</span><b>{(analysis.stability * 100).toFixed(0)}%</b></div>
            <div><span>Volatility</span><b>{analysis.regime}</b></div>
            <div><span>Signal</span><b className={analysis.signal === "WAIT" ? "wait" : "good"}>{analysis.signal}</b></div>
          </div>
          <div className="digitReason">{analysis.reason}</div>
        </div>
      </div>

      <div className="digitCard digitPathCard">
        <div className="digitCardTitle">CURSOR / DIGIT PATH · LAST 20 OF 60</div>
        <div className="digitPath">{analysis.path.length ? analysis.path.map((digit, index) => <span key={`${index}-${digit}`} className={digit > barrier ? "over" : "under"}>{digit}</span>) : <em>Waiting for digits…</em>}</div>
        <div className="digitPathText">{digitPathString(analysis.path)}</div>
      </div>

      <div className="digitLowerGrid">
        <div className="digitCard">
          <div className="digitCardTitle">RECOVERY + RISK</div>
          <div className="digitControls compact">
            <label>Scan seconds<input type="number" min="3" max="30" value={scanEvery} onChange={(e) => setScanEvery(e.target.value)} /></label>
            <label>Min edge<input type="number" min="0.01" max="0.15" step="0.01" value={minEdge} onChange={(e) => setMinEdge(e.target.value)} /></label>
            <label>Recovery<input type="checkbox" checked={recoveryEnabled} onChange={(e) => setRecoveryEnabled(e.target.checked)} /></label>
            <label>Multiplier<input type="number" min="1" max="2" step="0.1" value={recoveryMultiplier} onChange={(e) => setRecoveryMultiplier(e.target.value)} /></label>
            <label>Max recovery<input type="number" min="0" max="2" value={maxRecoverySteps} onChange={(e) => setMaxRecoverySteps(e.target.value)} /></label>
            <label>Max losses<input type="number" min="1" max="5" value={maxLosses} onChange={(e) => setMaxLosses(e.target.value)} /></label>
          </div>
          <div className="digitStats"><span>Recovery step <b>{recoveryStep}/{maxRecoverySteps}</b></span><span>Current stake <b>${safeAmount.toFixed(2)}</b></span><span>Session P/L <b className={pnl >= 0 ? "profit" : "loss"}>{money(pnl, currency)}</b></span><span>Losses <b>{losses}/{maxLosses}</b></span></div>
          <p className="digitNote">Recovery is capped and never forces an entry. If the next 10-second scan has no clean setup, the bot skips it.</p>
        </div>

        <div className="digitCard">
          <div className="digitCardTitle">PROPOSAL GATE</div>
          <div className="digitGate"><span>Contract</span><b>DIGITOVER · {barrier}</b></div>
          <div className="digitGate"><span>Current key</span><b>{contractKey}</b></div>
          <div className="digitGate"><span>Real trading</span><b>{real ? (allowReal ? "ARMED" : "LOCKED") : "OFF · DEMO"}</b></div>
          <div className="digitGate"><span>Execution</span><b>{active ? `OPEN · ${idOf(active)}` : "NO OPEN CONTRACT"}</b></div>
          <div className="digitMessage">{message}</div>
        </div>
      </div>

      <div className="digitActions">
        <label><input type="checkbox" checked={allowReal} onChange={(e) => setAllowReal(e.target.checked)} disabled={!real} /> Arm REAL trading</label>
        <button onClick={resetSession}>RESET SESSION</button>
        <button onClick={resetDigitBooks}>RESET 60-DIGIT BOOKS</button>
        <button className={running ? "danger" : "primary"} onClick={() => setRunning((value) => !value)}>{running ? "STOP BOT" : "START BOT"}</button>
      </div>

      <div className="digitCard digitJournal">
        <div className="digitCardTitle">DIGIT OVER JOURNAL · {tradeHistory.length}/8</div>
        {tradeHistory.length === 0 ? <div className="digitEmpty">No executions yet. Scanner will skip until a clean setup + positive Deriv proposal appears.</div> : tradeHistory.map((row) => <div className="digitJournalRow" key={row.id}><b className={row.result === "WON" ? "profit" : row.result === "LOST" ? "loss" : "open"}>{row.result}</b><span>OVER {row.barrier}</span><span>{row.symbol}</span><span>{row.duration}t</span><span>Model {(Number(row.model || 0) * 100).toFixed(1)}%</span><span>Edge {(Number(row.edge || 0) * 100).toFixed(1)}%</span><span>{row.pnl == null ? "—" : money(row.pnl, currency)}</span></div>)}
      </div>

      <div className="digitFooter"><span>Markets: {Object.keys(buffers).length}</span><span>Current 60: {currentDigits.length}/60</span><span>Barrier: OVER {barrier}</span><span>Last scan: {lastScanAt ? new Date(lastScanAt).toLocaleTimeString() : "—"}</span><span className="spacer">{real ? "REAL" : "DEMO"} · {currency}</span></div>
    </section>
  );
}
