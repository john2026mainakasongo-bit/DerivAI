import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import analyzeTouchNoTouch from "../analysis/touchNoTouchEngine";
import DerivTradingChart from "./DerivTradingChart";
import "../styles/TouchNoTouchBot.css";

const money = (v, currency = "USD") => `$${Number(v || 0).toFixed(2)} ${String(currency).toUpperCase()}`;
const idOf = (v) => String(v?.contract_id || v?.contractId || v?.id || v?.buy?.contract_id || "");
const settled = (v) => Boolean(v?.is_sold || v?.is_expired || v?.is_settled || ["won","lost","sold","expired","settled"].includes(String(v?.status || v?.contract_status || "").toLowerCase()));
const pnlOf = (v) => Number(v?.profit ?? v?.profit_loss ?? v?.pnl ?? 0);
const timeOf = (v) => { const t = Number(v?.date_start || v?.transaction_time || v?.date || v?.purchase_time || v?.epoch); return Number.isFinite(t) ? new Date(t * 1000).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"}) : "â€”"; };
const typeOf = (v) => { const t = String(v?.contract_type || v?.contractType || v?.type || "").toUpperCase(); return t === "ONETOUCH" ? "TOUCH" : t === "NOTOUCH" ? "NO TOUCH" : t || "â€”"; };

export function TouchNoTouchBotView({ feed }) {
  const auth = useDerivAuth();
  const { markets = [], market, symbol, connected, authenticatedFeed, status, ticks = [], prices = [], currentPrice, openContracts = [], transactions = [], changeSymbol, quoteTrade, placeTrade, placeQuotedTrade, sellContract, selectedAccount, selectedAccountType, selectedAccountId, tradeBusy } = feed;
  const touchContracts = openContracts.filter((contract) => {
    const type = String(contract?.contract_type || contract?.contractType || contract?.type || "").toUpperCase();
    return type === "ONETOUCH" || type === "NOTOUCH" || type === "TOUCH" || type === "NO TOUCH";
  });

  const currency = String(selectedAccount?.currency || "USD").toUpperCase();
  const [running, setRunning] = useState(false);
  const [stakeMode, setStakeMode] = useState("FIXED");
  const [fixedStake, setFixedStake] = useState(0.35);
  const [duration, setDuration] = useState(5);
  const [barrierMultiplier, setBarrierMultiplier] = useState(1.8);
  const [minScore, setMinScore] = useState(95);
  const [sessionTPPct, setSessionTPPct] = useState(2);
  const [sessionSLPct, setSessionSLPct] = useState(1.5);
  const [recoveryEnabled, setRecoveryEnabled] = useState(false);
  const [recoveryUsed, setRecoveryUsed] = useState(false);
  const [allowReal, setAllowReal] = useState(false);
  const [sessionPnl, setSessionPnl] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [trades, setTrades] = useState(0);
  const [message, setMessage] = useState("AI scanner ready â€” waiting for the best valid proposal.");
  const [liveQuote, setLiveQuote] = useState(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [diagnosticQuote, setDiagnosticQuote] = useState(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticSide, setDiagnosticSide] = useState("");
  const diagnosticRequestRef = useRef(0);
  const [flash, setFlash] = useState(null);
  const busyRef = useRef(false);
  const processedRef = useRef(new Set());
  const lastSignalRef = useRef("");
  const lastEntryRef = useRef(0);
  const sessionStartBalanceRef = useRef(Number(selectedAccount?.balance) || 0);
  const recoveryPendingRef = useRef(false);
  const audioRef = useRef(null);
  const exitRequestedRef = useRef(new Set());

  const analysisPrices = useMemo(() => {
    if (prices.length) return prices;
    return ticks.map((tick) => Number(tick?.quote)).filter(Number.isFinite);
  }, [prices, ticks]);
  const analysis = useMemo(() => analyzeTouchNoTouch(analysisPrices, { minimumSamples: 120, maxSamples: 700 }), [analysisPrices]);
  const balance = Number(selectedAccount?.balance) || 0;
  const sessionTarget = sessionStartBalanceRef.current > 0 ? sessionStartBalanceRef.current * (sessionTPPct / 100) : 0;
  const sessionStop = sessionStartBalanceRef.current > 0 ? sessionStartBalanceRef.current * (sessionSLPct / 100) : 0;
  const winRate = wins + losses ? (wins / (wins + losses)) * 100 : 0;
  const chartTicks = ticks.slice(-500);

  useEffect(() => {
    if (selectedAccount?.balance != null && sessionStartBalanceRef.current <= 0) sessionStartBalanceRef.current = Number(selectedAccount.balance) || 0;
  }, [selectedAccount?.balance]);

  const sound = useCallback((won) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioRef.current || new Ctx();
      audioRef.current = ctx;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      [won ? 700 : 320, won ? 980 : 220].forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = won ? "sine" : "square";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, now + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.09, now + i * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.11);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now + i * 0.12); osc.stop(now + i * 0.12 + 0.13);
      });
    } catch {}
  }, []);

  const resetSession = useCallback(() => {
    setSessionPnl(0); setWins(0); setLosses(0); setTrades(0); setRecoveryUsed(false); recoveryPendingRef.current = false; lastSignalRef.current = ""; processedRef.current.clear(); exitRequestedRef.current.clear(); setFlash(null); sessionStartBalanceRef.current = balance; setMessage("Session reset. Waiting for A+ setup.");
  }, [balance]);

  // V5.3 TOUCH / NO TOUCH PROPOSAL DIAGNOSTIC
  // This function ONLY requests a proposal. It NEVER buys.
  const checkProposal = useCallback(async (requestedSide) => {
    const setup = String(requestedSide || "").trim().toUpperCase() === "NO TOUCH" ? "NO TOUCH" : "TOUCH";
    const contractType = setup === "NO TOUCH" ? "NOTOUCH" : "ONETOUCH";
    const requestId = diagnosticRequestRef.current + 1;
    diagnosticRequestRef.current = requestId;

    if (diagnosticBusy) return;

    // Clear the previous result immediately so TOUCH can never remain visible
    // while a NO TOUCH request is being processed (and vice versa).
    setDiagnosticSide(setup);
    setDiagnosticQuote(null);
    setLiveQuote(null);
    setQuoteError("");

    if (!selectedAccountId) {
      setQuoteError("No active Deriv account.");
      return;
    }
    if (!authenticatedFeed) {
      setQuoteError("Trading feed is not authenticated yet.");
      return;
    }

    const spot = Number(analysis.current ?? currentPrice);
    const decimals = Math.max(2, market?.decimals ?? 3);
    const analysisBarrier = setup === "TOUCH" ? analysis.touchBarrier : analysis.noTouchBarrier;
    const fallbackDistance = Math.max(Math.abs(spot) * 0.00015, 10 ** (-decimals) * 10);
    const rawBarrier = Number.isFinite(Number(analysisBarrier))
      ? Number(analysisBarrier)
      : Number.isFinite(spot)
        ? spot + (setup === "TOUCH" ? 1 : -1) * fallbackDistance
        : null;
    if (!Number.isFinite(rawBarrier) || !Number.isFinite(spot)) {
      setQuoteError(`No live spot available for ${setup} proposal yet.`);
      return;
    }

    const distance = Math.max(
      Math.abs(Number(rawBarrier) - spot) * Math.max(0.35, Number(barrierMultiplier) || 1.8),
      Math.abs(spot) * 0.0001
    );
    const direction = Number(rawBarrier) >= spot ? 1 : -1;
    const relativeBarrier = `${direction >= 0 ? "+" : "-"}${distance.toFixed(decimals)}`;
    const absoluteBarrier = (spot + direction * distance).toFixed(decimals);

    setDiagnosticBusy(true);
    setMessage(`TESTING ${setup} Â· ${contractType} PROPOSAL â€” NO BUYâ€¦`);

    try {
      let quote = null;
      let usedBarrier = relativeBarrier;
      let firstError = "";

      try {
        quote = await quoteTrade({
          symbol,
          contractType,
          amount: Number(fixedStake) || 0.35,
          basis: "stake",
          duration: Number(duration),
          durationUnit: "t",
          barrier: relativeBarrier,
        });
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }

      if (!quote) {
        usedBarrier = absoluteBarrier;
        quote = await quoteTrade({
          symbol,
          contractType,
          amount: Number(fixedStake) || 0.35,
          basis: "stake",
          duration: Number(duration),
          durationUnit: "t",
          barrier: absoluteBarrier,
        }).catch((error) => {
          const secondError = error instanceof Error ? error.message : String(error);
          throw new Error(
            `${setup} proposal rejected. Relative: ${firstError || "failed"} | Absolute: ${secondError || "failed"}`
          );
        });
      }

      const ask = Number(quote?.askPrice);
      const payout = Number(quote?.payout);
      if (!Number.isFinite(ask) || ask <= 0 || !Number.isFinite(payout) || payout <= ask) {
        throw new Error(`${setup} proposal returned invalid pricing.`);
      }

      // A late response from an older click must never overwrite the latest side.
      if (requestId !== diagnosticRequestRef.current) return;

      const returnPct = ((payout - ask) / ask) * 100;
      const result = {
        ...quote,
        side: setup,
        contractType,
        barrier: usedBarrier,
        duration: Number(duration),
        returnPct,
      };

      setDiagnosticSide(setup);
      setDiagnosticQuote(result);
      setLiveQuote(result);
      setQuoteError("");
      setMessage(
        `${setup} PROPOSAL OK Â· ${contractType} Â· Ask ${ask.toFixed(2)} Â· Payout ${payout.toFixed(2)} Â· Return ${returnPct.toFixed(1)}%`
      );
    } catch (error) {
      if (requestId !== diagnosticRequestRef.current) return;
      setDiagnosticSide(setup);
      setDiagnosticQuote(null);
      setLiveQuote(null);
      setQuoteError(error instanceof Error ? error.message : String(error));
      setMessage(`${setup} proposal test failed.`);
    } finally {
      if (requestId === diagnosticRequestRef.current) setDiagnosticBusy(false);
    }
  }, [
    analysis,
    authenticatedFeed,
    barrierMultiplier,
    currentPrice,
    diagnosticBusy,
    duration,
    fixedStake,
    market?.decimals,
    quoteTrade,
    selectedAccountId,
    symbol,
  ]);
  const execute = useCallback(async (mode = "AUTO", forcedAnalysis = analysis, forcedStake = null) => {
    if (busyRef.current || !selectedAccountId || !forcedAnalysis?.ready) return;
    if (String(selectedAccountType).toLowerCase() === "real" && !allowReal) { setMessage("REAL ACCOUNT LOCKED â€” enable Allow Real first."); return; }
    if (forcedAnalysis.signal === "WAIT" || forcedAnalysis.entryScore < minScore) return;
    if (Date.now() - lastEntryRef.current < 9000) return;
    if (trades >= 10) { setRunning(false); setMessage("MAX 10 TRADES â€” session protected."); return; }
    if (sessionStop > 0 && sessionPnl <= -sessionStop) { setRunning(false); setMessage(`SESSION STOP â€¢ ${money(sessionPnl, currency)}`); return; }
    if (sessionTarget > 0 && sessionPnl >= sessionTarget) { setRunning(false); setMessage(`SESSION TARGET â€¢ ${money(sessionPnl, currency)}`); return; }

    const base = stakeMode === "FIXED"
      ? 0.35
      : Math.max(0.35, Math.min(0.35, balance * 0.0025));
    const isRecovery = mode === "RECOVERY";
    const tradeStake = isRecovery ? Math.min(0.70, base * 2) : 0.35;
    const setup = forcedAnalysis.signal;
    const contractType = setup === "TOUCH" ? "ONETOUCH" : "NOTOUCH";
    const rawBarrier = setup === "TOUCH" ? forcedAnalysis.touchBarrier : forcedAnalysis.noTouchBarrier;
    const spot = Number(forcedAnalysis.current || currentPrice);
    const baseOffset = Math.max(
      Math.abs(rawBarrier - spot) * Math.max(0.35, Number(barrierMultiplier) || 1),
      Math.abs(spot) * 0.0001
    );
    const direction = rawBarrier >= spot ? 1 : -1;
    const decimals = Math.max(2, market?.decimals ?? 3);
    const durations = [Number(duration)];

    busyRef.current = true;
    setQuoteBusy(true);
    setQuoteError("");
    setMessage(`${isRecovery ? "RECOVERY X2" : "AI"} â€¢ FINDING BEST ${setup} PROPOSALâ€¦`);
    try {
      const quotes = [];
      const errors = [];

      // Keep discovery fast: request a small candidate set in parallel instead
      // of waiting up to 15s sequentially for every barrier candidate.
      const candidates = [];
      const seen = new Set();
      const addCandidate = (barrier, tradeDuration) => {
        const key = `${barrier}|${tradeDuration}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ barrier, tradeDuration });
      };

      const primaryMultipliers = setup === "NO TOUCH" ? [Math.max(1.35, Number(barrierMultiplier) || 1.8), 2.2, 2.8] : [0.75, 1, Math.min(1.35, Number(barrierMultiplier) || 1.35)];
      for (const tradeDuration of durations) {
        for (const multiplier of primaryMultipliers) {
          const offset = Math.max(baseOffset * multiplier, Math.abs(spot) * 0.0001);
          const relativeBarrier = `${direction >= 0 ? "+" : "-"}${offset.toFixed(decimals)}`;
          addCandidate(relativeBarrier, tradeDuration);
        }
      }

      const primaryResults = await Promise.allSettled(
        candidates.map(({ barrier, tradeDuration }) =>
          quoteTrade({
            symbol,
            contractType,
            amount: tradeStake,
            basis: "stake",
            duration: tradeDuration,
            durationUnit: "t",
            barrier,
          }).then((quote) => ({ quote, barrier, tradeDuration }))
        )
      );

      for (const result of primaryResults) {
        if (result.status === "rejected") {
          errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
          continue;
        }
        const { quote, barrier, tradeDuration } = result.value;
        const ask = Number(quote?.askPrice);
        const payout = Number(quote?.payout);
        if (Number.isFinite(ask) && ask > 0 && Number.isFinite(payout) && payout > ask) {
          const returnPct = ((payout - ask) / ask) * 100;
          const priceQuality = Math.min(100, Math.max(0, returnPct));
          const quoteScore = Math.round(forcedAnalysis.entryScore * 0.8 + Math.min(100, priceQuality) * 0.2);
          quotes.push({ ...quote, barrier, duration: tradeDuration, returnPct, quoteScore });
        } else {
          errors.push(`invalid payout ${barrier}/${tradeDuration}t`);
        }
      }

      // If relative barriers are rejected, make a short absolute-barrier fallback.
      if (!quotes.length) {
        const fallbackCandidates = [];
        for (const tradeDuration of durations) {
          for (const multiplier of [0.75, 1.5]) {
            const offset = Math.max(baseOffset * multiplier, Math.abs(spot) * 0.0001);
            const absoluteBarrier = (spot + direction * offset).toFixed(decimals);
            fallbackCandidates.push({ barrier: absoluteBarrier, tradeDuration });
          }
        }

        const fallbackResults = await Promise.allSettled(
          fallbackCandidates.map(({ barrier, tradeDuration }) =>
            quoteTrade({
              symbol,
              contractType,
              amount: tradeStake,
              basis: "stake",
              duration: tradeDuration,
              durationUnit: "t",
              barrier,
            }).then((quote) => ({ quote, barrier, tradeDuration }))
          )
        );

        for (const result of fallbackResults) {
          if (result.status === "rejected") {
            errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
            continue;
          }
          const { quote, barrier, tradeDuration } = result.value;
          const ask = Number(quote?.askPrice);
          const payout = Number(quote?.payout);
          if (Number.isFinite(ask) && ask > 0 && Number.isFinite(payout) && payout > ask) {
            const returnPct = ((payout - ask) / ask) * 100;
            const priceQuality = Math.min(100, Math.max(0, returnPct));
            const quoteScore = Math.round(forcedAnalysis.entryScore * 0.8 + Math.min(100, priceQuality) * 0.2);
            quotes.push({ ...quote, barrier, duration: tradeDuration, returnPct, quoteScore });
          } else {
            errors.push(`invalid payout ${barrier}/${tradeDuration}t`);
          }
        }
      }

      if (!quotes.length) {
        setLiveQuote(null);
        const diagnostic = [...new Set(errors)].slice(0, 3).join(" | ");
        setQuoteError(diagnostic || "No proposal was returned.");
        throw new Error(`Touch/No Touch proposal rejected: ${diagnostic || "no valid proposal"}`);
      }

      quotes.sort((a, b) => b.quoteScore - a.quoteScore);
      const best = quotes[0];
      const bestBarrier = Number(best?.barrier);
      const bestSpot = Number(best?.spot ?? spot);
      if (Number.isFinite(bestBarrier) && Number.isFinite(bestSpot)) {
        const minDistance = Math.max(Math.abs(bestSpot) * 0.00008, 0.01);
        if (Math.abs(bestBarrier - bestSpot) < minDistance) {
          throw new Error("Barrier too close to spot â€” skipping trade for risk protection.");
        }
      }
      setLiveQuote(best);
      setMessage(`AI BEST ENTRY â€¢ ${setup} â€¢ AUTO ${direction > 0 ? "ABOVE" : "BELOW"} â€¢ Barrier ${best.barrier} â€¢ ${forcedAnalysis.entryScore}/99 â€¢ Return ${best.returnPct.toFixed(1)}%`);

      const result = await placeQuotedTrade({ quote: best });
      const id = idOf(result);
      setTrades((v) => v + 1);
      lastEntryRef.current = Date.now();
      if (isRecovery) { setRecoveryUsed(true); recoveryPendingRef.current = false; }
      lastSignalRef.current = `${symbol}:${setup}:${forcedAnalysis.entryScore}:${best.barrier}`;
      setMessage(`${setup} OPEN â€¢ ${id ? `#${id}` : "contract active"} â€¢ Stake ${money(tradeStake, currency)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade failed.");
    } finally {
      setQuoteBusy(false);
      busyRef.current = false;
    }
  }, [allowReal, analysis, balance, barrierMultiplier, currency, currentPrice, duration, fixedStake, minScore, placeQuotedTrade, quoteTrade, selectedAccountId, selectedAccountType, sessionPnl, sessionStop, sessionTarget, stakeMode, symbol, trades]);

  useEffect(() => {
    if (!running || !analysis.ready || analysis.signal === "WAIT" || analysis.entryScore < minScore) return;
    const key = `${symbol}:${analysis.signal}:${analysis.entryScore}`;
    if (key === lastSignalRef.current) return;
    void execute("AUTO", analysis);
  }, [analysis, execute, minScore, running, symbol]);

  // Fixed-duration Touch/No Touch contracts are protected by session-level
  // entry limits and settlement monitoring. Do not force a sell here: some
  // Deriv contracts do not expose resale, which would otherwise create a
  // noisy "contract offers no return" error.

  useEffect(() => {
    for (const c of touchContracts) {
      if (!settled(c)) continue;
      const id = idOf(c);
      if (!id || processedRef.current.has(id)) continue;
      processedRef.current.add(id);
      const pnl = pnlOf(c);
      const won = pnl >= 0;
      setSessionPnl((v) => v + pnl);
      if (won) { setWins((v) => v + 1); setRecoveryUsed(false); recoveryPendingRef.current = false; }
      else { setLosses((v) => v + 1); if (running && recoveryEnabled && !recoveryUsed && !recoveryPendingRef.current) recoveryPendingRef.current = true; }
      setFlash({ won, pnl, type: typeOf(c) }); sound(won);
      setMessage(`${won ? "âœ“ WIN" : "âœ• LOSS"} â€¢ ${typeOf(c)} â€¢ ${pnl >= 0 ? "+" : ""}${money(pnl, currency)}`);
    }
  }, [currency, touchContracts, recoveryEnabled, recoveryUsed, running, sound]);

  useEffect(() => {
    if (!running || !recoveryPendingRef.current || recoveryUsed || !analysis.ready || analysis.signal === "WAIT") return;
    if (analysis.entryScore < Math.max(minScore, 95)) return;
    recoveryPendingRef.current = false;
    void execute("RECOVERY", analysis);
  }, [analysis, execute, minScore, recoveryUsed, running]);

  useEffect(() => {
    if (!running) return;
    if (sessionTarget > 0 && sessionPnl >= sessionTarget) { setRunning(false); setMessage(`TAKE PROFIT â€¢ ${money(sessionPnl, currency)}`); }
    if (sessionStop > 0 && sessionPnl <= -sessionStop) { setRunning(false); setMessage(`STOP LOSS â€¢ ${money(sessionPnl, currency)}`); }
  }, [currency, running, sessionPnl, sessionStop, sessionTarget]);

  const recent = useMemo(() => touchContracts.filter(settled).sort((a,b) => Number(b?.date_start || b?.transaction_time || 0) - Number(a?.date_start || a?.transaction_time || 0)).slice(0, 8), [openContracts]);
  const open = touchContracts.filter((c) => !settled(c)).slice(0, 8);

  const toggle = () => {
    if (running) { setRunning(false); setMessage("Bot stopped â€” protection remains active."); return; }
    resetSession(); setRunning(true); setMessage("SCANNING â€¢ AUTO side + protected barrier â€¢ fixed $0.35 stake.");
  };

  return (
    <section className="tntShell">
      <header className="tntHero">
        <div><small>ZENTORA â€¢ PROTECTED OPTIONS ENGINE</small><h1>Touch / No Touch Growth Desk</h1><p>Structure-first entries â€¢ fixed $0.35 stake â€¢ optional one-time recovery â€¢ hard session protection</p></div>
        <div className="tntLive"><span className={connected ? "liveDot on" : "liveDot"} />{connected ? (authenticatedFeed ? "TRADING READY" : "LIVE FEED") : status}</div>
      </header>

      {flash && <div className={`tntFlash ${flash.won ? "win" : "loss"}`}><strong>{flash.won ? "âœ“ TRADE WON" : "âœ• TRADE LOST"}</strong><span>{flash.type}</span><b>{flash.pnl >= 0 ? "+" : ""}{money(flash.pnl, currency)}</b></div>}

      <div className="tntTopGrid">
        <div className="tntBalance"><span>ACCOUNT</span><strong>{selectedAccountType === "real" ? "REAL" : "DEMO"}</strong><small>{selectedAccount?.displayLabel || selectedAccountId || "Not connected"}</small><em>{money(balance, currency)}</em></div>
        <div className="tntMetric"><span>ENTRY ENGINE</span><strong>{analysis.signal}</strong><small>{analysis.state}</small><b>{analysis.entryScore}/99</b></div>
        <div className="tntMetric"><span>SESSION P/L</span><strong className={sessionPnl >= 0 ? "positive" : "negative"}>{sessionPnl >= 0 ? "+" : ""}{money(sessionPnl, currency)}</strong><small>Target +{sessionTPPct}% / Stop -{sessionSLPct}%</small><b>{wins}W â€¢ {losses}L â€¢ {winRate.toFixed(0)}%</b></div>
        <div className="tntMetric"><span>PROTECTION</span><strong>{recoveryPendingRef.current ? "RECOVERY READY" : "ARMED"}</strong><small>Max 10 trades â€¢ one recovery</small><b>{recoveryUsed ? "Recovery used" : "Recovery available"}</b></div>
      </div>

      <div className="tntControls">
        <label>MARKET<select value={symbol} disabled={!connected} onChange={(e) => void changeSymbol(e.target.value)}>{markets.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        <label>STAKE MODE<select value={stakeMode} onChange={(e) => setStakeMode(e.target.value)}><option value="FIXED">FIXED â€¢ $0.35</option><option value="ADAPTIVE">ADAPTIVE â€¢ capped $0.35</option></select></label>
        <label>STAKE<input type="number" min="0.35" max="0.35" step="0.05" value={0.35} disabled /></label>
        <label>DURATION<select value={duration} onChange={(e) => setDuration(Number(e.target.value))}><option value="3">3 TICKS</option><option value="5">5 TICKS</option><option value="10">10 TICKS</option><option value="15">15 TICKS</option></select></label>
        <label>MIN ENTRY<select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}><option value="92">92 / 99</option><option value="95">95 / 99</option><option value="97">97 / 99</option></select></label><label>BARRIER<select value={barrierMultiplier} onChange={(e) => setBarrierMultiplier(Number(e.target.value))}><option value="1.5">AUTO â€¢ 1.5Ã—</option><option value="1.8">AUTO â€¢ 1.8Ã—</option><option value="2.2">AUTO â€¢ 2.2Ã—</option><option value="2.5">AUTO â€¢ 2.5Ã— SAFE</option></select></label>
        <button className={`tntMainBtn ${running ? "stop" : "start"}`} disabled={quoteBusy} onClick={toggle}>{running ? "STOP BOT" : "START A+ BOT"}</button>
      </div>

      <div className="tntMainGrid">
        <div className="tntChartCard"><div className="tntCardHead"><div><b>{market?.label || "Market"}</b><span>â— LIVE</span></div><strong>{Number.isFinite(Number(currentPrice)) ? Number(currentPrice).toFixed(market?.decimals ?? 3) : "â€”"}</strong></div><div className="tntTabs"><span className="active">TICKS</span><span>1M</span><span>5M</span><span>15M</span></div><DerivTradingChart values={chartTicks} candleHistory={feed.candleHistory} signal={analysis.signal} confidence={analysis.entryScore} />
          <div className="tntProposalTest" style={{
            marginTop: 10,
            padding: 12,
            border: "1px solid rgba(255,255,255,.10)",
            borderRadius: 10,
            background: "rgba(0,0,0,.18)"
          }}>
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8
            }}>
              <strong>TOUCH / NO TOUCH PROPOSAL</strong>
              <span style={{fontSize: 10, opacity: .6}}>NO BUY TEST</span>
            </div>

            <div style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap"
            }}>
              <button
                type="button"
                onClick={() => void checkProposal("TOUCH")}
                disabled={diagnosticBusy || !authenticatedFeed}
              >
                {diagnosticBusy ? "TESTING…" : "CHECK TOUCH"}
              </button>

              <button
                type="button"
                onClick={() => void checkProposal("NO TOUCH")}
                disabled={diagnosticBusy || !authenticatedFeed}
              >
                {diagnosticBusy ? "TESTING…" : "CHECK NO TOUCH"}
              </button>
            </div>

            {diagnosticQuote && (
              <div style={{
                marginTop: 10,
                fontSize: 12,
                lineHeight: 1.6
              }}>
                <div>
                  <b>{diagnosticQuote.side}</b>
                  {" • "}
                  {diagnosticQuote.contractType}
                </div>

                <div>
                  Barrier:
                  {" "}
                  <b>{diagnosticQuote.barrier}</b>
                  {" • "}
                  Duration:
                  {" "}
                  <b>{diagnosticQuote.duration} ticks</b>
                </div>

                <div>
                  Ask:
                  {" "}
                  <b>${Number(diagnosticQuote.askPrice || 0).toFixed(2)}</b>
                  {" • "}
                  Payout:
                  {" "}
                  <b>${Number(diagnosticQuote.payout || 0).toFixed(2)}</b>
                </div>

                <div>
                  Return:
                  {" "}
                  <b>{Number(diagnosticQuote.returnPct || 0).toFixed(1)}%</b>
                </div>
              </div>
            )}

            {quoteError && (
              <div style={{
                marginTop: 10,
                fontSize: 12,
                lineHeight: 1.5
              }}>
                <b>Proposal error:</b>{" "}
                {quoteError}
              </div>
            )}
          </div></div>
        <div className="tntAnalysis">
          <div className="tntDecision"><span>MASTER DECISION</span><strong>{analysis.signal}</strong><b>{analysis.entryScore}/99</b><p>{analysis.reason}</p></div>
          <div className="tntCards"><div className={`tntSide ${analysis.candidate === "TOUCH" ? "best" : ""}`}><span>TOUCH</span><strong>{analysis.touchScore}</strong><small>Barrier {analysis.touchBarrier ? analysis.touchBarrier.toFixed(market?.decimals ?? 3) : "â€”"}</small><em>{analysis.touchScore >= minScore ? "QUALIFIED" : "WAIT"}</em></div><div className={`tntSide ${analysis.candidate === "NO TOUCH" ? "best" : ""}`}><span>NO TOUCH</span><strong>{analysis.noTouchScore}</strong><small>Barrier {analysis.noTouchBarrier ? analysis.noTouchBarrier.toFixed(market?.decimals ?? 3) : "â€”"}</small><em>{analysis.noTouchScore >= minScore ? "QUALIFIED" : "WAIT"}</em></div></div>
          <div className="tntQuote"><div><span>AI PROPOSAL</span><strong>{quoteBusy ? "SCANNING QUOTESâ€¦" : liveQuote ? `${typeOf(liveQuote)} â€¢ ${liveQuote.barrier}` : "WAITING"}</strong></div><div><span>ASK / PAYOUT</span><b>{liveQuote ? `${money(liveQuote.askPrice, currency)} â†’ ${money(liveQuote.payout, currency)}` : "â€”"}</b></div><div><span>EXPECTED RETURN</span><b>{liveQuote ? `${liveQuote.returnPct.toFixed(1)}%` : "â€”"}</b></div></div>
          {quoteError && <div className="tntQuoteError">DERIV QUOTE: {quoteError}</div>}
          <div className="tntChecks"><div><span>Trend</span><b>{analysis.trend}</b></div><div><span>Momentum</span><b>{analysis.momentum}</b></div><div><span>Volatility</span><b>{analysis.volatility}</b></div><div><span>Confirmations</span><b>{analysis.confirmations}/6</b></div><div><span>Market quality</span><b>{analysis.marketQuality}/100</b></div><div><span>Timing</span><b>{analysis.noChase ? "NO CHASE OK" : "LATE â€” WAIT"}</b></div></div>
        </div>
      </div>

      <div className="tntProtection"><div><span>SESSION TAKE PROFIT</span><strong>+{sessionTPPct}%</strong><input type="range" min="1" max="5" step="0.5" value={sessionTPPct} onChange={(e) => setSessionTPPct(Number(e.target.value))}/></div><div><span>SESSION STOP LOSS</span><strong>-{sessionSLPct}%</strong><input type="range" min="0.5" max="3" step="0.5" value={sessionSLPct} onChange={(e) => setSessionSLPct(Number(e.target.value))}/></div><div><span>RECOVERY</span><strong>{recoveryEnabled ? "X2 â€¢ ONE TIME" : "OFF"}</strong><input type="checkbox" checked={recoveryEnabled} onChange={(e) => setRecoveryEnabled(e.target.checked)}/></div><div><span>REAL TRADING</span><strong>{allowReal ? "UNLOCKED" : "LOCKED"}</strong><input type="checkbox" checked={allowReal} onChange={(e) => setAllowReal(e.target.checked)}/></div><button onClick={resetSession}>RESET SESSION</button></div>

      <div className="tntTables"><div className="tntTableCard"><div className="tntTableTitle">OPEN TRADES <small>{open.length}</small></div>{open.length ? open.map((c) => <div className="tntRow" key={idOf(c)}><b>{typeOf(c)}</b><span>{money(c?.buy_price ?? c?.stake ?? 0, currency)}</span><strong className={pnlOf(c) >= 0 ? "positive" : "negative"}>{money(pnlOf(c), currency)}</strong></div>) : <div className="empty">No open trades</div>}</div><div className="tntTableCard"><div className="tntTableTitle">RECENT TRADES</div>{recent.map((c) => <div className="tntRow" key={idOf(c)}><span>{timeOf(c)}</span><b>{typeOf(c)}</b><span>{idOf(c) ? `#${idOf(c)}` : "â€”"}</span><strong className={pnlOf(c) >= 0 ? "positive" : "negative"}>{pnlOf(c) >= 0 ? "+" : ""}{money(pnlOf(c), currency)}</strong></div>)}{!recent.length && <div className="empty">No settled trades yet</div>}</div></div>

      <footer className="tntFooter"><span className={connected ? "ok" : ""}>â— Deriv API {connected ? "Connected" : "Offline"}</span><span>â— Live market feed</span><span>â— {authenticatedFeed ? "Trading Ready" : "Trading Auth Pending"}</span><span>â— {selectedAccountType === "real" ? "Real Account" : "Demo Account"}</span><span className="tntMessage">{tradeBusy ? "EXECUTINGâ€¦" : message}</span></footer>
    </section>
  );
}


export default function TouchNoTouchBot() {
  const feed = useDerivTicks();
  return <TouchNoTouchBotView feed={feed} />;
}




