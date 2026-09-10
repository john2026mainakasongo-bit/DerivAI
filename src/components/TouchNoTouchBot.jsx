import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import analyzeTouchNoTouch, { estimateQuoteProbability } from "../analysis/touchNoTouchEngine";
import DerivTradingChart from "./DerivTradingChart";
import "../styles/TouchNoTouchBot.css";

const money = (v, currency = "USD") => `$${Number(v || 0).toFixed(2)} ${String(currency).toUpperCase()}`;
const idOf = (v) => String(v?.contract_id || v?.contractId || v?.id || v?.buy?.contract_id || "");
const settled = (v) => Boolean(v?.is_sold || v?.is_expired || v?.is_settled || ["won","lost","sold","expired","settled"].includes(String(v?.status || v?.contract_status || "").toLowerCase()));
const pnlOf = (v) => Number(v?.profit ?? v?.profit_loss ?? v?.pnl ?? 0);
const timeOf = (v) => { const t = Number(v?.date_start || v?.transaction_time || v?.date || v?.purchase_time || v?.epoch); return Number.isFinite(t) ? new Date(t * 1000).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"}) : "—"; };
const typeOf = (v) => { const t = String(v?.contract_type || v?.contractType || v?.type || "").toUpperCase(); return t === "ONETOUCH" ? "TOUCH" : t === "NOTOUCH" ? "NO TOUCH" : t || "—"; };

const DERIV_MEMORY_KEY = "zentora_deriv_first_memory_v1";
const safeJson = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const readDerivMemory = () => {
  const fallback = { profiles: {}, pending: {} };
  if (typeof window === "undefined") return fallback;

  const parsed = safeJson(window.localStorage.getItem(DERIV_MEMORY_KEY), null);

  // Old/corrupt localStorage can contain `null`, an array, or another
  // unexpected value. Never let local learning memory break proposal flow.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback;
  }

  return {
    profiles: parsed.profiles && typeof parsed.profiles === "object" && !Array.isArray(parsed.profiles)
      ? parsed.profiles
      : {},
    pending: parsed.pending && typeof parsed.pending === "object" && !Array.isArray(parsed.pending)
      ? parsed.pending
      : {},
  };
};
const writeDerivMemory = (memory) => {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(DERIV_MEMORY_KEY, JSON.stringify(memory)); } catch {}
};
const memoryKey = ({ symbol, setup, duration, durationUnit, barrier }) =>
  `${symbol}|${setup}|${duration}${durationUnit}|${String(barrier)}`;
const recordDerivObservation = ({ symbol, setup, duration, durationUnit, barrier, accepted, ask, payout }) => {
  const memory = readDerivMemory();
  const key = memoryKey({ symbol, setup, duration, durationUnit, barrier });
  const old = memory.profiles[key] || {
    symbol, setup, duration, durationUnit, barrier,
    attempts: 0, accepted: 0, rejected: 0, wins: 0, losses: 0,
    lastAsk: null, lastPayout: null, lastSeen: 0,
  };
  old.attempts += 1;
  if (accepted) old.accepted += 1; else old.rejected += 1;
  if (Number.isFinite(Number(ask))) old.lastAsk = Number(ask);
  if (Number.isFinite(Number(payout))) old.lastPayout = Number(payout);
  old.lastSeen = Date.now();
  memory.profiles[key] = old;
  writeDerivMemory(memory);
  return old;
};
const recordDerivOutcome = ({ contractId, won }) => {
  if (!contractId) return;
  const memory = readDerivMemory();
  const pending = memory.pending?.[String(contractId)];
  if (!pending) return;
  const profile = memory.profiles?.[pending.key];
  if (profile) {
    if (won) profile.wins += 1; else profile.losses += 1;
    profile.lastSeen = Date.now();
    memory.profiles[pending.key] = profile;
  }
  delete memory.pending[String(contractId)];
  writeDerivMemory(memory);
};
const rememberPendingTrade = (contractId, details) => {
  if (!contractId) return;
  const memory = readDerivMemory();
  memory.pending[String(contractId)] = details;
  writeDerivMemory(memory);
};
const getMemoryProfile = (details) => readDerivMemory().profiles?.[memoryKey(details)] || null;
const medianTickMove = (prices = []) => {
  const values = prices.map((x) => Number(x?.quote ?? x)).filter(Number.isFinite);
  const diffs = values.slice(1).map((v, i) => Math.abs(v - values[i])).filter(Number.isFinite).sort((a,b) => a-b);
  if (!diffs.length) return 0;
  const m = Math.floor(diffs.length / 2);
  return diffs.length % 2 ? diffs[m] : (diffs[m-1] + diffs[m]) / 2;
};

const deriveTouchAnalysis = ({ prices = [], analysis, spot, barrier, decimals = 3 }) => {
  const values = prices.map((x) => Number(x?.quote ?? x)).filter(Number.isFinite);
  const recent = values.slice(-60);
  const deltas = recent.slice(1).map((v, i) => v - recent[i]).filter(Number.isFinite);
  const last12 = deltas.slice(-12);
  const last6 = deltas.slice(-6);
  const meanAbs = (arr) => arr.length ? arr.reduce((s, v) => s + Math.abs(v), 0) / arr.length : 0;

  const up12 = last12.length ? last12.filter((v) => v > 0).length / last12.length : 0.5;
  const down12 = last12.length ? last12.filter((v) => v < 0).length / last12.length : 0.5;
  const direction = Number(barrier) >= Number(spot) ? 1 : -1;
  const directionalConsistency = direction > 0 ? up12 : down12;

  let slope = 0;
  if (recent.length >= 12) {
    const n = recent.length;
    const xMean = (n - 1) / 2;
    const yMean = recent.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dx = i - xMean;
      num += dx * (recent[i] - yMean);
      den += dx * dx;
    }
    slope = den ? num / den : 0;
  }

  const pip = 10 ** (-Math.max(2, Number(decimals) || 3));
  const typicalMove = Math.max(meanAbs(last12), pip);
  const fastMove = meanAbs(last6);
  const slopeStrength = Math.min(1, Math.abs(slope) / Math.max(typicalMove, pip));
  const slopeAligned = direction > 0 ? slope > 0 : slope < 0;
  const accelerationAligned = fastMove >= typicalMove * 0.85 &&
    last6.reduce((s, v) => s + v, 0) * direction > 0;

  const barrierDistance = Math.abs(Number(barrier) - Number(spot));
  const reachability = Number.isFinite(barrierDistance)
    ? Math.max(0, Math.min(1, 1 - barrierDistance / Math.max(typicalMove * 4, pip * 8)))
    : 0;

  const engineScore = Math.max(0, Math.min(1, Number(analysis?.touchScore || 0) / 99));
  const engineProbability = Math.max(0, Math.min(1, Number(analysis?.touchProbability || 0)));
  const marketQuality = Math.max(0, Math.min(1, Number(analysis?.marketQuality || 0) / 100));
  const confidence = (
    engineScore * 0.24 +
    engineProbability * 0.24 +
    marketQuality * 0.16 +
    directionalConsistency * 0.18 +
    slopeStrength * 0.08 +
    reachability * 0.10
  );

  return {
    confidence,
    directionalConsistency,
    slopeStrength,
    accelerationAligned,
    slopeAligned,
    reachability,
    typicalMove,
    engineScore,
    engineProbability,
    marketQuality,
  };
};

const buildDerivNativeCandidates = ({ prices, decimals, direction, setup, modelOffset }) => {
  const pip = 10 ** (-Math.max(0, Number(decimals) || 2));
  const tickMove = Math.max(medianTickMove(prices), pip);
  const seeds = [
    pip * 5, pip * 10, pip * 20, pip * 30, pip * 50, pip * 75, pip * 100,
    tickMove, tickMove * 1.5, tickMove * 2, tickMove * 3, tickMove * 4,
    Math.max(Number(modelOffset) || 0, tickMove * 2),
  ];
  const unique = new Map();
  const multipliers = setup === "NO TOUCH"
    ? [0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4]
    : [0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.8, 2.2, 2.8, 3.5];
  for (const seed of seeds) {
    for (const multiplier of multipliers) {
      const offset = Math.max(seed * multiplier, pip * 5);
      const rounded = Number(offset.toFixed(Math.max(2, Number(decimals) || 2)));
      if (rounded > 0) unique.set(rounded.toFixed(Math.max(2, Number(decimals) || 2)), rounded);
    }
  }
  return [...unique.values()]
    .sort((a,b) => a-b)
    .slice(0, 12)
    .map((offset) => `${direction >= 0 ? "+" : "-"}${offset.toFixed(Math.max(2, Number(decimals) || 2))}`);
};

function readableError(error) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.toLowerCase();

  if (text.includes("profiles") && (text.includes("null") || text.includes("undefined") || text.includes("reading"))) {
    return "Deriv account session is incomplete. Reconnect the selected account, then retry the proposal.";
  }

  if (text.includes("401") || text.includes("unauthorized") || text.includes("authentication credentials")) {
    return "Deriv authorization expired or is invalid. Reconnect the selected account, then retry.";
  }

  if (text.includes("invalid account id")) {
    return "The selected Deriv account ID is invalid. Reconnect and select the account again.";
  }

  return raw || "Deriv proposal request failed.";
}

export function TouchNoTouchBotView({ feed }) {
  const auth = useDerivAuth();
  const { markets = [], market, symbol, connected, authenticatedFeed, status, ticks = [], prices = [], currentPrice, openContracts = [], transactions = [], changeSymbol, connect, quoteTrade, placeTrade, placeQuotedTrade, sellContract, selectedAccount, selectedAccountType, selectedAccountId, tradeBusy } = feed;
  const touchContracts = openContracts.filter((contract) => {
    const type = String(contract?.contract_type || contract?.contractType || contract?.type || "").toUpperCase();
    return type === "ONETOUCH" || type === "NOTOUCH" || type === "TOUCH" || type === "NO TOUCH";
  });

  const currency = String(selectedAccount?.currency || "USD").toUpperCase();
  const [running, setRunning] = useState(false);
  const [stakeMode, setStakeMode] = useState("FIXED");
  const [fixedStake, setFixedStake] = useState(0.35);
  const [duration, setDuration] = useState(5);
  const [durationUnit, setDurationUnit] = useState("t");
  const [barrierMultiplier, setBarrierMultiplier] = useState(1.8);
  const [minScore, setMinScore] = useState(50);
  const [sessionTPPct, setSessionTPPct] = useState(2);
  const [sessionSLPct, setSessionSLPct] = useState(1.5);
  const [recoveryEnabled, setRecoveryEnabled] = useState(false);
  const [recoveryUsed, setRecoveryUsed] = useState(false);
  const [allowReal, setAllowReal] = useState(true);
  const [sessionPnl, setSessionPnl] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [trades, setTrades] = useState(0);
  const [message, setMessage] = useState("AI scanner ready — waiting for the best valid proposal.");
  const [liveQuote, setLiveQuote] = useState(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [diagnosticQuote, setDiagnosticQuote] = useState(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticSide, setDiagnosticSide] = useState("");
  const [executionPulse, setExecutionPulse] = useState(0);
  const diagnosticRequestRef = useRef(0);
  const [flash, setFlash] = useState(null);
  const busyRef = useRef(false);
  const processedRef = useRef(new Set());
  const lastSignalRef = useRef("");
  const lastEntryRef = useRef(0);
  const qualificationConsumedRef = useRef(false);
  const latestAnalysisRef = useRef(null);
  const sessionStartBalanceRef = useRef(Number(selectedAccount?.balance) || 0);
  const recoveryPendingRef = useRef(false);
  const audioRef = useRef(null);
  const exitRequestedRef = useRef(new Set());
  const rescanTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const lastHeartbeatScanRef = useRef(0);

  const analysisPrices = useMemo(() => {
    if (ticks.length) return ticks.map((tick) => ({ quote: Number(tick?.quote), epoch: Number(tick?.epoch) }));
    return prices;
  }, [prices, ticks]);
  const analysis = useMemo(() => analyzeTouchNoTouch(analysisPrices, {
    minimumSamples: 80,
    maxSamples: 900,
    minScore,
    duration,
    durationUnit,
    decimals: market?.decimals,
  }), [analysisPrices, duration, durationUnit, minScore, market?.decimals]);

  // DERIV-NATIVE TOUCH ANALYSIS:
  // Analysis decides whether the market is worth considering. Deriv's proposal
  // decides the actual executable contract.
  const tickAnalysis = useMemo(() => deriveTouchAnalysis({
    prices: analysisPrices,
    analysis,
    spot: Number(analysis?.current),
    barrier: Number(analysis?.touchBarrier),
    decimals: market?.decimals,
  }), [analysis, analysisPrices, market?.decimals]);

  const touchFirstReady = useMemo(() => {
    // V183 EARLY QUALITY: let the detector reach the proposal stage earlier.
    // The final exact-barrier quality gate below still decides whether to buy. Deriv remains the pricing authority.
    const sampleReady = analysisPrices.length >= 30;
    const barrier = Number(analysis?.touchBarrier);
    const spot = Number(analysis?.current);
    const marketQuality = Number(analysis?.marketQuality || 0);
    const hasCandidate = Number.isFinite(barrier) && Number.isFinite(spot);
    const touchProbability = Number(analysis?.touchProbability || 0);
    // EARLY QUALITY: do not require the base barrier probability to be high.
    // A low base probability can still produce a better exact-barrier quote
    // after candidate discovery. The final quote gate remains strict enough
    // to stop a bad Touch buy.
    const probabilityFloor = touchProbability >= 0.20;
    const qualityFloor = marketQuality >= 45;

    return Boolean(sampleReady && hasCandidate && qualityFloor && probabilityFloor);
  }, [analysis, analysisPrices.length]);

  const touchFirstAnalysis = useMemo(() => {
    if (!touchFirstReady) return analysis;
    return {
      ...analysis,
      ready: true,
      signal: "TOUCH",
      candidate: "TOUCH",
      entryScore: Number(analysis.touchScore || 0),
      modelProbability: Number(analysis.touchProbability || 0),
      reason: `PROPOSAL-FIRST Touch candidate: ${analysis.touchScore}/99 local score, ${(Number(analysis.touchProbability || 0) * 100).toFixed(1)}% local model probability. Deriv pricing decides execution.`,
    };
  }, [analysis, touchFirstReady]);

  useEffect(() => {
    latestAnalysisRef.current = touchFirstAnalysis;
  }, [touchFirstAnalysis]);
  const balance = Number(selectedAccount?.balance) || 0;
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
    setSessionPnl(0); setWins(0); setLosses(0); setTrades(0); setRecoveryUsed(false); recoveryPendingRef.current = false; lastSignalRef.current = ""; processedRef.current.clear(); exitRequestedRef.current.clear(); setFlash(null); sessionStartBalanceRef.current = balance; setMessage("Session reset. Execution-first scanner is ready.");
  }, [balance]);

  // V5.3 TOUCH / NO TOUCH PROPOSAL DIAGNOSTIC
  // This function ONLY requests a proposal. It NEVER buys.
  const checkProposal = useCallback(async (requestedSide) => {
    const setup = "TOUCH";
    const contractType = "ONETOUCH";
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
      setMessage("RECONNECTING DERIV ACCOUNT · NO BUY…");
      try {
        await connect?.();
      } catch (error) {
        setQuoteError(readableError(error));
        setMessage("Deriv account connection failed.");
        return;
      }
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

    // Deriv Touch/No Touch uses signed barrier OFFSETS such as +1.37/-1.37.
    // Never convert the model barrier into an absolute spot price.
    const modelDistance = Math.abs(Number(rawBarrier) - spot);
    const pip = 10 ** (-decimals);
    const minimumOffset = Math.max(pip * 2, Math.abs(spot) * 0.00003);
    const distance = Math.max(modelDistance * Math.max(0.35, Number(barrierMultiplier) || 1.8), minimumOffset);
    const direction = Number(rawBarrier) >= spot ? 1 : -1;
    const relativeBarrier = `${direction >= 0 ? "+" : "-"}${distance.toFixed(decimals)}`;

    setDiagnosticBusy(true);
    setMessage(`TESTING TOUCH · ONETOUCH PROPOSAL — NO BUY…`);

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
          durationUnit,
          barrier: relativeBarrier,
        });
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }

      if (!quote) {
        throw new Error(
          `${setup} proposal rejected by Deriv for barrier ${relativeBarrier}. ${firstError || "No valid proposal returned."}`
        );
      }

      const ask = Number(quote?.askPrice);
      const payout = Number(quote?.payout);
      if (!Number.isFinite(ask) || ask <= 0 || !Number.isFinite(payout) || payout <= ask) {
        throw new Error(`${setup} proposal returned invalid pricing.`);
      }

      // A late response from an older click must never overwrite the latest side.
      if (requestId !== diagnosticRequestRef.current) return;

      const returnPct = ((payout - ask) / ask) * 100;
      const quoteModelProbability = estimateQuoteProbability(analysisPrices, {
        spot,
        barrier: usedBarrier,
        setup,
        horizonTicks: analysis.horizonTicks,
      });
      const impliedProbability = Math.max(0, Math.min(1, ask / payout));
      const probabilityGap = quoteModelProbability - impliedProbability;
      const result = {
        ...quote,
        modelProbability: quoteModelProbability,
        impliedProbability,
        probabilityGap,
        side: setup,
        contractType,
        barrier: usedBarrier,
        duration: Number(duration),
        durationUnit,
        returnPct,
      };

      setDiagnosticSide(setup);
      setDiagnosticQuote(result);
      setLiveQuote(result);
      setQuoteError("");
      setMessage(
        `${setup} PROPOSAL OK · ${contractType} · Ask ${ask.toFixed(2)} · Payout ${payout.toFixed(2)} · Model ${(quoteModelProbability * 100).toFixed(1)}% · Gap ${(probabilityGap * 100).toFixed(1)}% · Net return ${returnPct.toFixed(1)}%`
      );
    } catch (error) {
      if (requestId !== diagnosticRequestRef.current) return;
      setDiagnosticSide(setup);
      setDiagnosticQuote(null);
      setLiveQuote(null);
      setQuoteError(readableError(error));
      setMessage(`${setup} proposal test failed.`);
    } finally {
      if (requestId === diagnosticRequestRef.current) setDiagnosticBusy(false);
    }
  }, [
    analysis,
    authenticatedFeed,
    barrierMultiplier,
    currentPrice,
    connect,
    diagnosticBusy,
    duration,
    durationUnit,
    fixedStake,
    market?.decimals,
    quoteTrade,
    selectedAccountId,
    symbol,
    analysisPrices,
  ]);
  const execute = useCallback(async (mode = "AUTO", forcedAnalysis = analysis, forcedStake = null) => {
    if (busyRef.current || !selectedAccountId || !forcedAnalysis?.ready) return;
    if (forcedAnalysis.signal !== "TOUCH") return;
    // V184 CONTINUOUS TOUCH: never block AUTO on the UI score. The local model
    // ranks candidates; a broker-valid Deriv proposal decides execution.
    if (forcedAnalysis.signal === "WAIT") return;

    // AUTO execution must use the latest qualified analysis, never a stale
    // signal captured by an earlier render. The current engine only needs to
    // remain Touch-ready; score is ranking information, not an execution veto.
    if (mode === "AUTO" && touchContracts.some((c) => !settled(c))) return;
    if (mode === "AUTO") {
      const latest = latestAnalysisRef.current;
      if (!latest?.ready || latest.signal !== forcedAnalysis.signal) return;
    }



    const base = stakeMode === "FIXED"
      ? 0.35
      : Math.max(0.35, Math.min(0.35, balance * 0.0025));
    const isRecovery = mode === "RECOVERY";
    const tradeStake = isRecovery ? Math.min(0.70, base * 2) : 0.35;
    const setup = "TOUCH";
    const contractType = "ONETOUCH";
    const rawBarrier = setup === "TOUCH" ? forcedAnalysis.touchBarrier : forcedAnalysis.noTouchBarrier;
    const spot = Number(forcedAnalysis.current || currentPrice);
    const decimals = Math.max(2, market?.decimals ?? 3);
    const pip = 10 ** (-decimals);
    const minimumOffset = Math.max(pip * 2, Math.abs(spot) * 0.00003);
    const modelOffset = Math.max(Math.abs(Number(rawBarrier) - spot), minimumOffset);
    const direction = Number(rawBarrier) >= spot ? 1 : -1;
    // V184 CONTINUOUS TOUCH: keep proposal discovery deliberately small and parallel.
    // The goal is to reach a broker-priced Touch quickly, not to wait for a
    // large matrix of barriers/durations to finish.
    const durationCandidates = String(durationUnit).toLowerCase() === "t"
      ? [Number(duration), 10]
      : [Number(duration), 5];
    const durations = [...new Set(durationCandidates.filter((v) => Number.isFinite(v) && v > 0))];

    let opened = false;
    busyRef.current = true;
    setQuoteBusy(true);
    setQuoteError("");
    setMessage(`${isRecovery ? "RECOVERY X2" : "FAST TOUCH"} • FINDING QUALITY TOUCH PROPOSAL…`);
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

      // DERIV-FIRST: generate a broker-compatible offset ladder from live
      // tick movement + small native offsets. These are candidates only.
      // Deriv's proposal response is the authority on what can actually trade.
      const nativeBarriers = buildDerivNativeCandidates({
        prices: analysisPrices,
        decimals,
        direction,
        setup,
        modelOffset,
      });
      // V184 CONTINUOUS TOUCH: keep each scan small enough to avoid a burst of
      // proposal requests that can make the UI look frozen or trigger broker
      // throttling. Prefer the closest native offsets first.
      const scanBarriers = nativeBarriers.slice(0, 6);
      for (const tradeDuration of durations) {
        for (const relativeBarrier of scanBarriers) addCandidate(relativeBarrier, tradeDuration);
      }

      const primaryResults = await Promise.allSettled(
        candidates.map(({ barrier, tradeDuration }) =>
          quoteTrade({
            symbol,
            contractType,
            amount: tradeStake,
            basis: "stake",
            duration: tradeDuration,
            durationUnit,
            barrier,
          }).then((quote) => ({ quote, barrier, tradeDuration }))
        )
      );

      for (const result of primaryResults) {
        if (result.status === "rejected") {
          const failed = candidates[primaryResults.indexOf(result)];
          if (failed) recordDerivObservation({ symbol, setup, duration: failed.tradeDuration, durationUnit, barrier: failed.barrier, accepted: false });
          errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
          continue;
        }
        const { quote, barrier, tradeDuration } = result.value;
        const ask = Number(quote?.askPrice);
        const payout = Number(quote?.payout);
        if (Number.isFinite(ask) && ask > 0 && Number.isFinite(payout)) {
          recordDerivObservation({ symbol, setup, duration: tradeDuration, durationUnit, barrier, accepted: true, ask, payout });
          if (payout <= ask) {
            errors.push(`Deriv priced ${barrier}/${tradeDuration}${durationUnit} but payout <= stake`);
            continue;
          }
          const returnPct = ((payout - ask) / ask) * 100;
          const impliedProbability = Math.max(0, Math.min(1, ask / payout));
          // V10.3: probability belongs to the exact Deriv signed barrier being
          // priced. Never reuse the probability of the original model barrier.
          const quoteModelProbability = estimateQuoteProbability(analysisPrices, {
            spot,
            barrier,
            setup,
            horizonTicks: forcedAnalysis.horizonTicks,
          });
          const probabilityGap = quoteModelProbability - impliedProbability;
          const quoteProbabilityGate = quoteModelProbability >= 0.38;
          const expectedValue = quoteModelProbability * payout - ask;
          // V170: Deriv is the pricing authority. Once Deriv has returned a
          // valid proposal with a positive payout, do not discard the quote
          // because of a second local pricing gate. The analysis engine already
          // decides whether the market setup is ready; this layer only chooses
          // the best broker-valid quote from the candidates Deriv accepted.
          const pricingCompatible = Number.isFinite(ask) && ask > 0 && Number.isFinite(payout) && payout > ask;
          const memory = getMemoryProfile({ symbol, setup, duration: tradeDuration, durationUnit, barrier });
          const acceptanceRate = memory && memory.attempts > 0 ? memory.accepted / memory.attempts : 0.5;
          const outcomeTotal = (memory?.wins || 0) + (memory?.losses || 0);
          const historicalWinRate = outcomeTotal >= 3 ? memory.wins / outcomeTotal : 0.5;
          const learningBonus = Math.max(0, Math.min(8, (acceptanceRate - 0.5) * 8 + (historicalWinRate - 0.5) * 12));
          const quoteScore = Math.round(
            forcedAnalysis.entryScore * 0.52 +
            quoteModelProbability * 24 +
            Math.min(20, Math.max(0, probabilityGap * 100)) * 1.15 +
            Math.min(8, Math.max(0, expectedValue / Math.max(ask, 0.01) * 100)) +
            learningBonus
          );
          quotes.push({
            ...quote,
            barrier,
            duration: tradeDuration,
            durationUnit,
            returnPct,
            impliedProbability,
            modelProbability: quoteModelProbability,
            probabilityGap,
            quoteProbabilityGate,
            pricingCompatible,
            expectedValue,
            quoteScore,
            derivAcceptanceRate: acceptanceRate,
            derivHistoricalWinRate: historicalWinRate,
            derivLearningBonus: learningBonus,
          });
        } else {
          recordDerivObservation({ symbol, setup, duration: tradeDuration, durationUnit, barrier, accepted: false });
          errors.push(`invalid payout ${barrier}/${tradeDuration}${durationUnit}`);
        }
      }

      // No absolute-barrier fallback. If Deriv does not return a valid,
      // priceable proposal for these native offsets, we WAIT rather than
      // inventing a barrier that the broker cannot accept.

      // V184: broker-valid is necessary, but a valid price alone is NOT enough.
      // Discovery is fast, while the exact candidate being bought must still
      // have enough Touch probability. This separates early scanning from
      // final execution quality.
      const pricedQuotes = quotes.filter((q) => {
        if (!q.pricingCompatible) return false;
        const p = Number(q.modelProbability || 0);
        const noTouchP = Number(forcedAnalysis.noTouchProbability || 0);
        const minimumTouchProbability = forcedAnalysis.volatility === "HIGH" ? 0.32 : 0.28;
        const relativeFloor = forcedAnalysis.volatility === "HIGH" ? 0.34 : 0.30;
        const relativeEdge = noTouchP > 0 ? p >= Math.max(relativeFloor, noTouchP * 0.40) : p >= relativeFloor;
        const mildGap = Number(q.probabilityGap || 0) >= -0.08;
        return p >= minimumTouchProbability && relativeEdge && mildGap;
      });
      if (!pricedQuotes.length) {
        setLiveQuote(null);
        const diagnostic = [...new Set(errors)].slice(0, 3).join(" | ");
        setQuoteError(
          `No quality ${setup} proposal returned. ${diagnostic || "Waiting for a Touch-favorable Deriv proposal."}`
        );
        throw new Error(`Skipped ${setup}: Deriv returned no usable Touch proposal.`);
      }

      pricedQuotes.sort((a, b) => {
        const probabilityDelta = Number(b.modelProbability || 0) - Number(a.modelProbability || 0);
        if (Math.abs(probabilityDelta) > 0.015) return probabilityDelta;
        const edgeDelta = Number(b.probabilityGap || 0) - Number(a.probabilityGap || 0);
        if (Math.abs(edgeDelta) > 0.01) return edgeDelta;
        const returnDelta = Number(b.returnPct || 0) - Number(a.returnPct || 0);
        if (Math.abs(returnDelta) > 2) return returnDelta;
        return Number(b.quoteScore || 0) - Number(a.quoteScore || 0);
      });
      const best = pricedQuotes[0];
      // IMPORTANT: best.barrier is a Deriv signed OFFSET (+/-), not an absolute
      // market price. Comparing it directly with spot (e.g. 0.59 vs 926.97)
      // would incorrectly reject every valid proposal.
      const bestBarrierOffset = Number(best?.barrier);
      if (Number.isFinite(bestBarrierOffset)) {
        const minOffset = Math.max(pip * 2, 0.01);
        if (Math.abs(bestBarrierOffset) < minOffset) {
          throw new Error("Deriv barrier offset is too close to spot.");
        }
      }
      setLiveQuote(best);
      setMessage(
        `DERIV-FIRST • ${setup} • ${direction > 0 ? "ABOVE" : "BELOW"} • Barrier ${best.barrier} • Model ${(Number(best.modelProbability) * 100).toFixed(1)}% • Gap ${(Number(best.probabilityGap) * 100).toFixed(1)}% • Deriv memory ${(Number(best.derivHistoricalWinRate) * 100).toFixed(0)}% • Return ${best.returnPct.toFixed(1)}%`
      );

      const result = await placeQuotedTrade({ quote: best });
      const id = idOf(result);
      if (id) {
        rememberPendingTrade(id, {
          key: memoryKey({ symbol, setup, duration: best.duration, durationUnit: best.durationUnit, barrier: best.barrier }),
          symbol, setup, duration: best.duration, durationUnit: best.durationUnit, barrier: best.barrier,
        });
      }
      setTrades((v) => v + 1);
      lastEntryRef.current = Date.now();
      if (isRecovery) { setRecoveryUsed(true); recoveryPendingRef.current = false; }
      lastSignalRef.current = `${symbol}:${setup}:${forcedAnalysis.entryScore}:${best.barrier}`;
      opened = true;
      setMessage(`${setup} OPEN • ${id ? `#${id}` : "contract active"} • Stake ${money(tradeStake, currency)}`);
    } catch (error) {
      // Never leave the continuous scanner locked after a proposal/quote error.
      // A failed attempt is not a completed entry, so the qualification must be
      // released and the scanner gets another chance shortly.
      if (mode === "AUTO") {
        qualificationConsumedRef.current = false;
        lastSignalRef.current = "";
        if (rescanTimerRef.current) clearTimeout(rescanTimerRef.current);
        rescanTimerRef.current = setTimeout(() => {
          rescanTimerRef.current = null;
          setExecutionPulse((v) => v + 1);
        }, 1200);
      }
      setMessage(`${readableError(error)} • RESCANNING TOUCH`);
    } finally {
      setQuoteBusy(false);
      busyRef.current = false;
      if (!opened && mode === "AUTO") qualificationConsumedRef.current = false;
    }
  }, [analysis, analysisPrices, balance, barrierMultiplier, currency, currentPrice, duration, durationUnit, fixedStake, minScore, placeQuotedTrade, quoteTrade, selectedAccountId, stakeMode, symbol]);

  useEffect(() => {
    // V184 CONTINUOUS TOUCH: the scanner must keep moving even when the market
    // remains in the same READY state and no proposal passes the exact-barrier
    // quality filter. A lightweight heartbeat re-pulses the execution effect
    // instead of waiting indefinitely for a React analysis dependency to change.
    if (!running) {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
      return;
    }

    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = setInterval(() => {
      if (busyRef.current || touchContracts.some((c) => !settled(c))) return;
      const now = Date.now();
      if (now - lastHeartbeatScanRef.current < 1700) return;
      lastHeartbeatScanRef.current = now;
      setExecutionPulse((v) => v + 1);
    }, 1800);

    return () => {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    };
  }, [running, touchContracts]);

  useEffect(() => {
    // A qualified setup is consumed once. Do not re-enter simply because the
    // score/barrier changes on every tick while the same setup remains READY.
    // The engine must first leave READY/WAIT, then form a fresh qualification.
    if (!running) {
      qualificationConsumedRef.current = false;
      return;
    }

    const qualified = Boolean(
      touchFirstAnalysis.ready &&
      touchFirstAnalysis.signal === "TOUCH" &&
      Number.isFinite(Number(touchFirstAnalysis.current))
    );

    if (!qualified) {
      qualificationConsumedRef.current = false;
      return;
    }

    if (qualificationConsumedRef.current) return;
    qualificationConsumedRef.current = true;
    const key = `${symbol}:${touchFirstAnalysis.signal}:${Number(touchFirstAnalysis.current).toFixed(8)}`;
    lastSignalRef.current = key;
    void execute("AUTO", touchFirstAnalysis);
  }, [execute, executionPulse, minScore, running, symbol, touchFirstAnalysis]);

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
      recordDerivOutcome({ contractId: id, won });
      setSessionPnl((v) => v + pnl);
      if (won) { setWins((v) => v + 1); setRecoveryUsed(false); recoveryPendingRef.current = false; }
      else { setLosses((v) => v + 1); if (running && recoveryEnabled && !recoveryUsed && !recoveryPendingRef.current) recoveryPendingRef.current = true; }
      setFlash({ won, pnl, type: typeOf(c) }); sound(won);
      qualificationConsumedRef.current = false;
      lastSignalRef.current = "";
      setExecutionPulse((v) => v + 1);
      setMessage(`${won ? "✓ WIN" : "✕ LOSS"} • ${typeOf(c)} • ${pnl >= 0 ? "+" : ""}${money(pnl, currency)} • FAST RESCAN`);
    }
  }, [currency, touchContracts, recoveryEnabled, recoveryUsed, running, sound]);

  useEffect(() => {
    // Recovery also requires a fresh qualification. A loss must never cause the
    // same still-READY signal to be bought again immediately.
    if (!running || !recoveryPendingRef.current || recoveryUsed || !touchFirstAnalysis.ready || touchFirstAnalysis.signal !== "TOUCH") return;
    if (!Number.isFinite(Number(touchFirstAnalysis.current))) return;
    if (qualificationConsumedRef.current) return;
    qualificationConsumedRef.current = true;
    recoveryPendingRef.current = false;
    void execute("RECOVERY", touchFirstAnalysis);
  }, [execute, minScore, recoveryUsed, running, touchFirstAnalysis]);


  const recent = useMemo(() => touchContracts.filter(settled).sort((a,b) => Number(b?.date_start || b?.transaction_time || 0) - Number(a?.date_start || a?.transaction_time || 0)).slice(0, 8), [openContracts]);
  const open = touchContracts.filter((c) => !settled(c)).slice(0, 8);

  const toggle = () => {
    if (running) { setRunning(false); setMessage("Bot stopped — protection remains active."); return; }
    resetSession(); setRunning(true); setMessage("SCANNING • CONTINUOUS QUALITY TOUCH • 1.8s heartbeat • fixed $0.35 stake.");
  };

  return (
    <section className="tntShell">
      <header className="tntHero">
        <div><small>ZENTORA • CONTINUOUS QUALITY TOUCH V18.4</small><h1>Touch / No Touch Growth Desk</h1><p>Continuous proposal discovery • exact-barrier quality filter • broker-priced Touch</p></div>
        <div className="tntLive"><span className={connected ? "liveDot on" : "liveDot"} />{connected ? (authenticatedFeed ? "TRADING READY" : "LIVE FEED") : status}</div>
      </header>

      {flash && <div className={`tntFlash ${flash.won ? "win" : "loss"}`}><strong>{flash.won ? "✓ TRADE WON" : "✕ TRADE LOST"}</strong><span>{flash.type}</span><b>{flash.pnl >= 0 ? "+" : ""}{money(flash.pnl, currency)}</b></div>}

      <div className="tntTopGrid">
        <div className="tntBalance"><span>ACCOUNT</span><strong>{selectedAccountType === "real" ? "REAL" : "DEMO"}</strong><small>{selectedAccount?.displayLabel || selectedAccountId || "Not connected"}</small><em>{money(balance, currency)}</em></div>
        <div className="tntMetric"><span>TOUCH ENGINE</span><strong>{analysis.signal === "TOUCH" ? "TOUCH" : "WAIT"}</strong><small>Tick confidence {Math.round(Number(tickAnalysis.confidence || 0) * 100)}% • {analysis.state}</small><b>{analysis.touchScore}/99</b></div>
        <div className="tntMetric"><span>SESSION P/L</span><strong className={sessionPnl >= 0 ? "positive" : "negative"}>{sessionPnl >= 0 ? "+" : ""}{money(sessionPnl, currency)}</strong><small>Target +{sessionTPPct}% / Stop -{sessionSLPct}%</small><b>{wins}W • {losses}L • {winRate.toFixed(0)}%</b></div>
        <div className="tntMetric"><span>PROTECTION</span><strong>{recoveryPendingRef.current ? "RECOVERY READY" : "ARMED"}</strong><small>Execution mode • no local trade cap</small><b>{recoveryUsed ? "Recovery used" : "Recovery available"}</b></div>
      </div>

      <div className="tntControls">
        <label>MARKET<select value={symbol} disabled={!connected} onChange={(e) => void changeSymbol(e.target.value)}>{markets.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        <label>STAKE MODE<select value={stakeMode} onChange={(e) => setStakeMode(e.target.value)}><option value="FIXED">FIXED • $0.35</option><option value="ADAPTIVE">ADAPTIVE • capped $0.35</option></select></label>
        <label>STAKE<input type="number" min="0.35" max="0.35" step="0.05" value={0.35} disabled /></label>
        <div className="tntDurationControl">
          <span className="tntControlLabel">DURATION</span>
          <div className="tntDurationMode">
            <button type="button" className={durationUnit === "t" ? "active" : ""} onClick={() => setDurationUnit("t")}>TICKS</button>
            <button type="button" className={durationUnit === "m" ? "active" : ""} onClick={() => setDurationUnit("m")}>TIME</button>
          </div>
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {durationUnit === "t" ? (
              <>
                <option value="2">2 TICKS</option>
                <option value="3">3 TICKS</option>
                <option value="5">5 TICKS</option>
                <option value="10">10 TICKS</option>
                <option value="15">15 TICKS</option>
                <option value="20">20 TICKS</option>
                <option value="30">30 TICKS</option>
              </>
            ) : (
              <>
                <option value="1">1 MINUTE</option>
                <option value="5">5 MINUTES</option>
                <option value="10">10 MINUTES</option>
                <option value="15">15 MINUTES</option>
                <option value="30">30 MINUTES</option>
                <option value="60">60 MINUTES</option>
              </>
            )}
          </select>
        </div>
        <label>AI RANKING<select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}><option value="45">45 / 99</option><option value="50">50 / 99</option><option value="55">55 / 99</option><option value="60">60 / 99</option><option value="65">65 / 99</option></select></label><label>BARRIER<select value={barrierMultiplier} onChange={(e) => setBarrierMultiplier(Number(e.target.value))}><option value="1.5">AUTO • 1.5×</option><option value="1.8">AUTO • 1.8×</option><option value="2.2">AUTO • 2.2×</option><option value="2.5">AUTO • 2.5× SAFE</option></select></label>
        <button className={`tntMainBtn ${running ? "stop" : "start"}`} disabled={quoteBusy} onClick={toggle}>{running ? "STOP BOT" : "START BOT"}</button>
      </div>

      <div className="tntMainGrid">
        <div className="tntChartCard"><div className="tntCardHead"><div><b>{market?.label || "Market"}</b><span>● LIVE</span></div><strong>{Number.isFinite(Number(currentPrice)) ? Number(currentPrice).toFixed(market?.decimals ?? 3) : "—"}</strong></div><div className="tntTabs"><span className="active">TICKS</span><span>1M</span><span>5M</span><span>15M</span></div><DerivTradingChart values={chartTicks} candleHistory={feed.candleHistory} signal={analysis.signal} confidence={analysis.entryScore} analysis={analysis} />
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
              <strong>TOUCH PROPOSAL</strong>
              <span style={{fontSize: 10, opacity: .6}}>ONETOUCH • NO BUY TEST</span>
              <button
                type="button"
                onClick={() => void connect?.()}
                disabled={diagnosticBusy || !selectedAccountId}
                style={{ marginLeft: "auto" }}
              >RECONNECT ACCOUNT</button>
            </div>

            <div style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap"
            }}>
              <button
                type="button"
                onClick={() => void checkProposal("TOUCH")}
                disabled={diagnosticBusy || !selectedAccountId}
              >
                {diagnosticBusy ? "TESTING…" : "CHECK TOUCH"}
              </button>
            </div>


            <div style={{ marginTop: 10, fontSize: 11, opacity: .86 }}>
              <b>LIVE TOUCH ANALYSIS</b>
              {" • "}Direction {String(analysis?.trend || "—")}
              {" • "}Momentum {String(analysis?.momentum || "—")}
              {" • "}Consistency {(Number(tickAnalysis.directionalConsistency || 0) * 100).toFixed(0)}%
              {" • "}Confidence {(Number(tickAnalysis.confidence || 0) * 100).toFixed(0)}%
              {" • "}Quality {Number(analysis?.marketQuality || 0)}/100
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
                  <b>{diagnosticQuote.duration} {String(diagnosticQuote.durationUnit || durationUnit).toLowerCase() === "m" ? "minutes" : String(diagnosticQuote.durationUnit || durationUnit).toLowerCase() === "s" ? "seconds" : "ticks"}</b>
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
                  Model probability:
                  {" "}
                  <b>{(Number(diagnosticQuote.modelProbability || 0) * 100).toFixed(1)}%</b>
                  {" • "}
                  Pricing gap:
                  {" "}
                  <b>{(Number(diagnosticQuote.probabilityGap || 0) * 100).toFixed(1)}%</b>
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
          <div className={`tntEntryRadar ${analysis.ready ? "ready" : ""}`}>
            <div className="tntEntryRadarHead"><span>ENTRY RADAR</span><b>{analysis.ready ? "ENTRY READY" : "WAITING FOR A+"}</b></div>
            <h3>{analysis.ready ? analysis.candidate : "NO ENTRY"}</h3>
            <p>{analysis.ready ? `${analysis.candidate} setup detected. Execute using the live Deriv proposal shown below.` : analysis.reason}</p>
            <div className="tntEntryGrid">
              <div><span>Score</span><strong>{analysis.entryScore}/99</strong></div>
              <div><span>Probability</span><strong>{(Number(analysis.modelProbability || 0) * 100).toFixed(1)}%</strong></div>
              <div><span>Barrier</span><strong>{analysis.candidate === "TOUCH" ? (analysis.touchBarrier ?? "—") : (analysis.noTouchBarrier ?? "—")}</strong></div>
              <div><span>Horizon</span><strong>{analysis.duration} {analysis.durationUnit === "m" ? "MIN" : analysis.durationUnit === "s" ? "SEC" : "TICKS"}</strong></div>
            </div>
          </div>
          <div className="tntDecision"><span>MASTER DECISION</span><strong>{analysis.signal}</strong><b>{analysis.entryScore}/99</b><p>{analysis.reason}</p></div>
          <div className="tntCards"><div className={`tntSide ${analysis.candidate === "TOUCH" ? "best" : ""}`}><span>TOUCH</span><strong>{analysis.touchScore}</strong><small>Barrier {analysis.touchBarrier ? analysis.touchBarrier.toFixed(market?.decimals ?? 3) : "—"}</small><em>{analysis.touchScore >= minScore ? "QUALIFIED" : "WAIT"}</em></div><div className={`tntSide ${analysis.candidate === "NO TOUCH" ? "best" : ""}`}><span>NO TOUCH</span><strong>{analysis.noTouchScore}</strong><small>Barrier {analysis.noTouchBarrier ? analysis.noTouchBarrier.toFixed(market?.decimals ?? 3) : "—"}</small><em>{analysis.noTouchScore >= minScore ? "QUALIFIED" : "WAIT"}</em></div></div>
          <div className="tntQuote">
            <div><span>AI PROPOSAL</span><strong>{quoteBusy ? "SCANNING QUOTES…" : liveQuote ? `${typeOf(liveQuote)} • ${liveQuote.barrier}` : "WAITING"}</strong></div>
            <div><span>ASK / PAYOUT</span><b>{liveQuote ? `${money(liveQuote.askPrice, currency)} → ${money(liveQuote.payout, currency)}` : "—"}</b></div>
            <div><span>MODEL / GAP</span><b>{liveQuote ? `${(Number(liveQuote.modelProbability || 0) * 100).toFixed(1)}% / ${(Number(liveQuote.probabilityGap || 0) * 100).toFixed(1)}%` : "—"}</b></div>
            <div><span>NET RETURN</span><b>{liveQuote ? `${Number(liveQuote.returnPct || 0).toFixed(1)}%` : "—"}</b></div>
            <div><span>DERIV MEMORY</span><b>{liveQuote ? `${(Number(liveQuote.derivHistoricalWinRate || 0.5) * 100).toFixed(0)}% historical • ${(Number(liveQuote.derivAcceptanceRate || 0.5) * 100).toFixed(0)}% accepted` : "LEARNING"}</b></div>
          </div>
          {quoteError && <div className="tntQuoteError">DERIV QUOTE: {quoteError}</div>}
          <div className="tntChecks"><div><span>Trend</span><b>{analysis.trend}</b></div><div><span>Momentum</span><b>{analysis.momentum}</b></div><div><span>Volatility</span><b>{analysis.volatility}</b></div><div><span>Confirmations</span><b>{analysis.confirmations}/6</b></div><div><span>Market quality</span><b>{analysis.marketQuality}/100</b></div><div><span>Timing</span><b>{analysis.timing || (analysis.noChase ? "NO CHASE OK" : "LATE / WAIT")}</b></div><div><span>Horizon</span><b>{analysis.duration} {analysis.durationUnit === "m" ? "MIN" : analysis.durationUnit === "s" ? "SEC" : "TICKS"} · {analysis.horizonTicks || analysis.duration} TICKS</b></div><div><span>Model probability</span><b>{(Number(analysis.modelProbability || 0) * 100).toFixed(1)}%</b></div></div>
        </div>
      </div>

      <div className="tntProtection"><div><span>SESSION TAKE PROFIT</span><strong>+{sessionTPPct}%</strong><input type="range" min="1" max="5" step="0.5" value={sessionTPPct} onChange={(e) => setSessionTPPct(Number(e.target.value))}/></div><div><span>SESSION STOP LOSS</span><strong>-{sessionSLPct}%</strong><input type="range" min="0.5" max="3" step="0.5" value={sessionSLPct} onChange={(e) => setSessionSLPct(Number(e.target.value))}/></div><div><span>RECOVERY</span><strong>{recoveryEnabled ? "X2 • ONE TIME" : "OFF"}</strong><input type="checkbox" checked={recoveryEnabled} onChange={(e) => setRecoveryEnabled(e.target.checked)}/></div><div><span>REAL TRADING</span><strong>READY</strong><input type="checkbox" checked={allowReal} onChange={(e) => setAllowReal(e.target.checked)}/></div><button onClick={resetSession}>RESET SESSION</button></div>

      <section className="tntBottomDash">
        <div className="tntBottomDashHead"><strong>TOUCH / NO TOUCH ANALYSIS DASHBOARD</strong><span>LIVE • CHART-SYNCHRONIZED</span></div>
        <div className="tntBottomGrid">
          <article><span>STRUCTURE</span><b>{analysis.trend}</b><small>Live directional structure</small></article>
          <article><span>MOMENTUM</span><b>{analysis.momentum}</b><small>Current tick impulse</small></article>
          <article><span>VOLATILITY</span><b>{analysis.volatility}</b><small>Execution environment</small></article>
          <article><span>CONFIRMATIONS</span><b>{analysis.confirmations}/6</b><small>Independent gates passed</small></article>
          <article><span>MARKET QUALITY</span><b>{analysis.marketQuality}/100</b><small>Quality safety gate</small></article>
          <article><span>TOUCH</span><b>{analysis.touchScore}/99</b><small>{(Number(analysis.touchProbability || 0)*100).toFixed(1)}% model probability</small></article>
          <article><span>NO TOUCH</span><b>{analysis.noTouchScore}/99</b><small>{(Number(analysis.noTouchProbability || 0)*100).toFixed(1)}% model probability</small></article>
          <article><span>TIMING</span><b>{analysis.timing}</b><small>{analysis.horizonTicks || analysis.duration} tick horizon</small></article>
        </div>
      </section>

      <div className="tntTables"><div className="tntTableCard"><div className="tntTableTitle">OPEN TRADES <small>{open.length}</small></div>{open.length ? open.map((c) => <div className="tntRow" key={idOf(c)}><b>{typeOf(c)}</b><span>{money(c?.buy_price ?? c?.stake ?? 0, currency)}</span><strong className={pnlOf(c) >= 0 ? "positive" : "negative"}>{money(pnlOf(c), currency)}</strong></div>) : <div className="empty">No open trades</div>}</div><div className="tntTableCard"><div className="tntTableTitle">RECENT TRADES</div>{recent.map((c) => <div className="tntRow" key={idOf(c)}><span>{timeOf(c)}</span><b>{typeOf(c)}</b><span>{idOf(c) ? `#${idOf(c)}` : "—"}</span><strong className={pnlOf(c) >= 0 ? "positive" : "negative"}>{pnlOf(c) >= 0 ? "+" : ""}{money(pnlOf(c), currency)}</strong></div>)}{!recent.length && <div className="empty">No settled trades yet</div>}</div></div>

      <footer className="tntFooter"><span className={connected ? "ok" : ""}>● Deriv API {connected ? "Connected" : "Offline"}</span><span>● Live market feed</span><span>● {authenticatedFeed ? "Trading Ready" : "Trading Auth Pending"}</span><span>● {selectedAccountType === "real" ? "Real Account" : "Demo Account"}</span><span className="tntMessage">{tradeBusy ? "EXECUTING…" : message}</span></footer>
    </section>
  );
}


export default function TouchNoTouchBot() {
  const feed = useDerivTicks();
  return <TouchNoTouchBotView feed={feed} />;
}




