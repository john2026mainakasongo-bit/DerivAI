import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import useDerivTicks from "../hooks/useDerivTicks";
import "./DerivAIAnalyzer.css";

const clamp = (n, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Number(n) || 0));

const MASTER_THRESHOLD = 76;

function derivMarketName(symbol, fallback = "") {
  const exact = {
    "1HZ10V": "Volatility 10 (1s) Index",
    "1HZ15V": "Volatility 15 (1s) Index",
    "1HZ25V": "Volatility 25 (1s) Index",
    "1HZ30V": "Volatility 30 (1s) Index",
    "1HZ50V": "Volatility 50 (1s) Index",
    "1HZ75V": "Volatility 75 (1s) Index",
    "1HZ90V": "Volatility 90 (1s) Index",
    "1HZ100V": "Volatility 100 (1s) Index",
    "R_10": "Volatility 10 Index",
    "R_25": "Volatility 25 Index",
    "R_50": "Volatility 50 Index",
    "R_75": "Volatility 75 Index",
    "R_100": "Volatility 100 Index",
  };

  if (exact[symbol]) return exact[symbol];

  const one = String(symbol || "").match(/^1HZ(\d+)V$/i);
  if (one) return `Volatility ${one[1]} (1s) Index`;

  const normal = String(symbol || "").match(/^R_(\d+)$/i);
  if (normal) return `Volatility ${normal[1]} Index`;

  return fallback || symbol || "Deriv Market";
}

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values = []) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((x) => (x - m) ** 2)));
}

function median(values = []) {
  const v = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function robustStep(values = []) {
  const p = values.map(Number).filter(Number.isFinite);
  if (p.length < 3) return 0;
  const diffs = p.slice(1).map((x, i) => Math.abs(x - p[i])).filter((x) => x > 0);
  if (!diffs.length) return 0;
  const med = median(diffs);
  const cap = med > 0 ? med * 8 : Math.max(...diffs);
  const trimmed = diffs.filter((x) => x <= cap);
  return median(trimmed.length ? trimmed : diffs);
}

function cleanPriceRecords(records = []) {
  const out = [];
  for (const r of records) {
    const price = Number(r?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!out.length) { out.push({ ...r, price }); continue; }
    const recent = out.slice(-25).map((x) => x.price);
    const center = median(recent);
    const step = Math.max(robustStep(recent), Math.abs(center) * 0.000001);
    const allowedJump = Math.max(step * 35, Math.abs(center) * 0.02);
    if (Math.abs(price - center) > allowedJump) continue;
    out.push({ ...r, price });
  }
  return out;
}

function analyzeRiseFall(prices = []) {
  const p = prices.map(Number).filter(Number.isFinite);

  if (p.length < 6) {
    return {
      signal: "WAIT",
      confidence: 0,
      trend: "COLLECTING",
      momentum: "COLLECTING",
      consistency: 0,
      volatility: 0,
    };
  }

  const short = p.slice(-Math.min(12, p.length));
  const medium = p.slice(-Math.min(36, p.length));

  const shortMove = short.at(-1) - short[0];
  const mediumMove = medium.at(-1) - medium[0];

  const diffs = short.slice(1).map((x, i) => x - short[i]);
  const nz = diffs.filter((d) => d !== 0);

  const up = nz.filter((d) => d > 0).length;
  const down = nz.filter((d) => d < 0).length;

  const consistency = nz.length
    ? (Math.max(up, down) / nz.length) * 100
    : 0;

  const aligned =
    Math.sign(shortMove) !== 0 &&
    Math.sign(shortMove) === Math.sign(mediumMove);

  const direction =
    !aligned
      ? "WAIT"
      : shortMove > 0
        ? "RISE"
        : "FALL";

  const confidence = clamp(
    (aligned ? 47 : 18) + consistency * 0.41
  );

  return {
    signal: confidence >= 68 ? direction : "WAIT",
    confidence,
    trend:
      mediumMove > 0
        ? "BULLISH"
        : mediumMove < 0
          ? "BEARISH"
          : "SIDEWAYS",
    momentum:
      shortMove > 0
        ? "UP"
        : shortMove < 0
          ? "DOWN"
          : "FLAT",
    consistency,
    volatility: std(diffs),
  };
}


function analyzeTouch(prices = [], barrierGap = 0.15, horizon = 10, barrierDirection = "above") {
  const p = prices.map(Number).filter(Number.isFinite);
  const minSamples = Math.max(18, Math.min(40, Number(horizon) + 8));

  if (p.length < minSamples) {
    return {
      signal: "WAIT",
      confidence: 0,
      touchScore: 50,
      noTouchScore: 50,
      upperBarrier: null,
      lowerBarrier: null,
      setup: "COLLECTING",
      sampleCount: p.length,
      minSamples,
      travelRatio: 0,
      persistence: 0,
      expansion: 0,
      reason: `Collecting ${minSamples - p.length} more observations`,
    };
  }

  const current = p.at(-1);
  const recent = p.slice(-Math.min(90, p.length));
  const diffs = recent.slice(1).map((x, i) => x - recent[i]);
  const shortDiffs = diffs.slice(-Math.min(12, diffs.length));
  const longSigma = Math.max(std(diffs), Math.abs(current) * 0.000002);
  const shortSigma = Math.max(std(shortDiffs), longSigma * 0.15);

  const nz = shortDiffs.filter((d) => d !== 0);
  const up = nz.filter((d) => d > 0).length;
  const down = nz.filter((d) => d < 0).length;
  const persistence = nz.length ? Math.max(up, down) / nz.length : 0.5;

  const short = recent.slice(-Math.min(16, recent.length));
  const shortMove = short.at(-1) - short[0];
  const driftPerStep = Math.abs(shortMove) / Math.max(1, short.length - 1);

  const horizonSteps = Math.max(3, Math.min(60, Number(horizon) || 10));
  const expectedTravel =
    longSigma * Math.sqrt(horizonSteps) +
    driftPerStep * horizonSteps * 0.45;

  const recentRange = Math.max(...recent) - Math.min(...recent);
  // Use the same user-selected target distance shown in the Deriv-style barrier control.
  // Analysis and order execution must evaluate the exact same barrier.
  const barrier = Math.max(
    Math.abs(Number(barrierGap) || 0),
    Math.abs(current) * 0.000001
  );

  const upperBarrier = current + barrier;
  const lowerBarrier = current - barrier;
  const travelRatio = barrier > 0 ? expectedTravel / barrier : 0;
  const signedMove = shortMove;
  const towardBarrier = barrierDirection === "below" ? -signedMove : signedMove;
  const directionAlignment = clamp(towardBarrier / Math.max(barrier, longSigma), -1, 1);
  const expansion = longSigma > 0 ? shortSigma / longSigma : 1;

  const recentHigh = Math.max(...recent);
  const recentLow = Math.min(...recent);
  const range = Math.max(recentHigh - recentLow, barrier);
  const edgePosition = clamp(
    Math.max(
      (current - recentLow) / range,
      (recentHigh - current) / range
    ) * 100,
    0,
    100
  ) / 100;

  const touchRaw =
    44 +
    clamp((travelRatio - 0.65) * 30, -12, 25) +
    clamp((persistence - 0.5) * 32, -7, 14) +
    clamp((expansion - 0.9) * 13, -6, 10) +
    clamp((edgePosition - 0.55) * 12, -4, 6) +
    clamp(directionAlignment * 12, -10, 10);

  const noTouchRaw =
    44 +
    clamp((0.9 - travelRatio) * 34, -12, 25) +
    clamp((0.62 - persistence) * 24, -6, 11) +
    clamp((1.0 - expansion) * 13, -5, 8) +
    clamp(-directionAlignment * 8, -6, 6);

  const delta = touchRaw - noTouchRaw;
  const touchScore = clamp(50 + delta * 1.25, 12, 88);
  const noTouchScore = clamp(100 - touchScore, 12, 88);
  const confidence = Math.max(touchScore, noTouchScore);
  const dominance = Math.abs(touchScore - noTouchScore);

  const touchQualified =
    touchScore >= MASTER_THRESHOLD &&
    dominance >= 20 &&
    travelRatio >= 0.95 &&
    persistence >= 0.62;

  const noTouchQualified =
    noTouchScore >= MASTER_THRESHOLD &&
    dominance >= 20 &&
    travelRatio <= 0.72 &&
    persistence <= 0.68 &&
    expansion <= 1.12;

  let signal = "WAIT";
  if (touchQualified) signal = "TOUCH";
  if (noTouchQualified) signal = "NO TOUCH";

  const setup =
    signal !== "WAIT"
      ? "ENTRY READY"
      : confidence >= 68
        ? "SETUP FORMING"
        : "SCANNING";

  const reason =
    signal === "TOUCH"
      ? "Movement, persistence and expected travel support a barrier test"
      : signal === "NO TOUCH"
        ? "Low expected travel and contained movement support barrier avoidance"
        : travelRatio > 0.85
          ? "Movement is active, but confirmation is not strong enough yet"
          : "Barrier edge is not qualified; keep scanning";

  return {
    signal,
    confidence,
    touchScore,
    noTouchScore,
    upperBarrier,
    lowerBarrier,
    setup,
    sampleCount: p.length,
    minSamples,
    travelRatio,
    persistence,
    expansion,
    directionAlignment,
    reason,
  };
}

function buildCandles(records = [], size = 2) {
  const candles = [];

  for (let i = 0; i < records.length; i += size) {
    const chunk = records.slice(i, i + size);
    if (!chunk.length) continue;

    const prices = chunk.map((r) => r.price);

    candles.push({
      ts: chunk[0].ts,
      endTs: chunk.at(-1).ts,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices.at(-1),
    });
  }

  return candles;
}

function makeScale(values, height, top = 16, bottom = 24) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const pad = range * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const span = hi - lo || 1;

  const y = (value) =>
    top + ((hi - value) / span) * (height - top - bottom);

  return { min: lo, max: hi, span, y };
}

function signalColor(signal) {
  if (signal === "RISE") return "#22dda5";
  if (signal === "FALL") return "#ff7181";
  if (signal === "TOUCH") return "#5aa9ff";
  if (signal === "NO TOUCH") return "#ffd45d";
  return "#8fa6b5";
}

export default function DerivAIAnalyzer() {
  const deriv = useDerivTicks();

  const {
    markets = [],
    market = {},
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    currentPrice,
    ticks = [],
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
    quoteTrade,
    tradeBusy,
    tradeError,
    selectedAccountId,
    selectedAccountType,
    authenticatedFeed,
  } = deriv;

  const [unit, setUnit] = useState("ticks");
  const [duration, setDuration] = useState(10);
  const [barrierMode, setBarrierMode] = useState("above");
  const [barrierOffset, setBarrierOffset] = useState(0.15);
  const [fixedBarrier, setFixedBarrier] = useState("");
  const [stake, setStake] = useState(0.35);
  const [manualTradeStatus, setManualTradeStatus] = useState(null);
  const [proposalPreview, setProposalPreview] = useState({ touch: null, noTouch: null, loading: false, error: "" });

  const [records, setRecords] = useState([]);
  const [markers, setMarkers] = useState([]);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const [crosshair, setCrosshair] = useState(null);

  const dragRef = useRef(null);
  const lastQuote = useRef(null);
  const lastSignal = useRef(null);
  const signalCycle = useRef({ locked: false, waitTicks: 0 });
  const candidateConfirmation = useRef({ signal: "WAIT", count: 0, lastTs: 0 });

  // Seed the analyzer from Deriv tick history immediately, then keep it synced
  // with the live tick stream. useDerivTicks already loads history on market
  // selection, so the analyzer should not start from only the ticks received
  // after this page mounted.
  useEffect(() => {
    if (!connected || !Array.isArray(ticks) || !ticks.length) return;

    const mapped = ticks
      .map((tick) => ({
        price: Number(tick?.quote),
        ts: Number(tick?.epoch) > 0 ? Number(tick.epoch) * 1000 : Date.now(),
      }))
      .filter((r) => Number.isFinite(r.price) && r.price > 0)
      .slice(-500);

    if (!mapped.length) return;

    const last = mapped.at(-1);
    lastQuote.current = last || null;
    setRecords(mapped);
  }, [ticks, connected, symbol]);

  useEffect(() => {
    setRecords([]);
    setMarkers([]);
    setPan(0);
    setZoom(1);
    setCrosshair(null);
    lastQuote.current = null;
    lastSignal.current = null;
    signalCycle.current = { locked: false, waitTicks: 0 };
    candidateConfirmation.current = { signal: "WAIT", count: 0, lastTs: 0 };
  }, [symbol]);

  // Analysis history must be independent from contract duration.
  // Previously a 10-tick contract only supplied 10 samples while the
  // analyzer required at least 18, so it could stay in COLLECTING forever.
  const cleanRecords = useMemo(() => cleanPriceRecords(records), [records]);

  const analysisRecords = useMemo(() => {
    if (unit === "ticks") return cleanRecords.slice(-120);

    const cutoff = Date.now() - Math.max(90, Number(duration) * 4) * 1000;
    const byTime = cleanRecords.filter((r) => r.ts >= cutoff);
    return byTime.slice(-180);
  }, [cleanRecords, unit, duration]);

  const analysisPrices = useMemo(
    () => analysisRecords.map((r) => r.price),
    [analysisRecords]
  );

  const riseFall = useMemo(
    () => analyzeRiseFall(analysisPrices),
    [analysisPrices]
  );

  const selectedBarrierTarget = useMemo(() => {
    const spot = Number(currentPrice);
    if (!Number.isFinite(spot) || spot <= 0) return null;
    if (barrierMode === "fixed") {
      const fixed = Number(fixedBarrier);
      return Number.isFinite(fixed) && fixed > 0 ? fixed : null;
    }
    const offset = Math.max(0.000001, Math.abs(Number(barrierOffset) || 0));
    return barrierMode === "below" ? spot - offset : spot + offset;
  }, [currentPrice, barrierMode, barrierOffset, fixedBarrier]);

  const selectedBarrierGap = useMemo(() => {
    const spot = Number(currentPrice);
    const target = Number(selectedBarrierTarget);
    if (!Number.isFinite(spot) || !Number.isFinite(target)) return 0.15;
    return Math.max(Math.abs(target - spot), Math.abs(spot) * 0.000001);
  }, [currentPrice, selectedBarrierTarget]);

  const selectedBarrierDirection = useMemo(() => {
    const spot = Number(currentPrice);
    const target = Number(selectedBarrierTarget);
    if (barrierMode === "below") return "below";
    if (barrierMode === "above") return "above";
    return Number.isFinite(spot) && Number.isFinite(target) && target < spot ? "below" : "above";
  }, [barrierMode, currentPrice, selectedBarrierTarget]);

  const touch = useMemo(
    () => analyzeTouch(analysisPrices, selectedBarrierGap, duration, selectedBarrierDirection),
    [analysisPrices, selectedBarrierGap, duration, selectedBarrierDirection]
  );

  const riseValid =
    connected &&
    riseFall.signal !== "WAIT" &&
    riseFall.confidence >= MASTER_THRESHOLD;

  // The master entry engine is intentionally Touch / No Touch only.
  // Rise/Fall remains a secondary market-bias confirmation.
  const touchValid =
    connected &&
    touch.signal !== "WAIT" &&
    touch.confidence >= MASTER_THRESHOLD;

  const best = {
    mode: "TOUCH/NO TOUCH",
    signal: touchValid ? touch.signal : "WAIT",
    confidence: touch.confidence,
    valid: touchValid,
    setup: touch.setup,
  };

  useEffect(() => {
    const last = cleanRecords.at(-1);
    if (!last) return;

    // Never convert the historical seed into an entry. The first evaluated
    // timestamp only arms the scanner; a qualified entry must be confirmed by
    // fresh live ticks that arrive afterwards.
    if (!candidateConfirmation.current.lastTs) {
      candidateConfirmation.current = { signal: "WAIT", count: 0, lastTs: last.ts };
      return;
    }

    // React can re-render several times for one tick. Evaluate each market tick
    // once so a setup cannot accumulate fake confirmations from UI renders.
    if (candidateConfirmation.current.lastTs === last.ts) return;

    if (signalCycle.current.locked) {
      signalCycle.current.waitTicks += 1;
      candidateConfirmation.current = { signal: "WAIT", count: 0, lastTs: last.ts };
      if (signalCycle.current.waitTicks >= 12) {
        signalCycle.current = { locked: false, waitTicks: 0 };
      }
      return;
    }

    if (!best.valid) {
      candidateConfirmation.current = { signal: "WAIT", count: 0, lastTs: last.ts };
      return;
    }

    const previous = candidateConfirmation.current;
    const nextCount = previous.signal === best.signal ? previous.count + 1 : 1;
    candidateConfirmation.current = { signal: best.signal, count: nextCount, lastTs: last.ts };

    // A chart entry is not a raw analyzer candidate. Require the same qualified
    // Touch/No Touch decision on 3 consecutive fresh ticks before publishing it.
    if (nextCount < 3) return;

    const previousMarker = markers.at(-1);
    if (previousMarker && cleanRecords.length - Number(previousMarker.recordCount || 0) < 24) return;

    const marker = {
      ts: last.ts,
      price: last.price,
      signal: best.signal,
      mode: best.mode,
      confidence: best.confidence,
      upperBarrier: touch.upperBarrier,
      lowerBarrier: touch.lowerBarrier,
      reason: touch.reason,
      recordCount: cleanRecords.length,
      confirmations: nextCount,
      analyzed: true,
    };

    lastSignal.current = marker;
    signalCycle.current = { locked: true, waitTicks: 0 };
    candidateConfirmation.current = { signal: "WAIT", count: 0, lastTs: last.ts };
    setMarkers((old) => [...old.slice(-7), marker]);
  }, [
    best.valid,
    best.signal,
    best.mode,
    best.confidence,
    cleanRecords,
    markers,
    touch.upperBarrier,
    touch.lowerBarrier,
    touch.reason,
  ]);

  const visibleCount = Math.round(clamp(160 / zoom, 45, 220));
  const safePan = Math.max(
    0,
    Math.min(
      pan,
      Math.max(0, cleanRecords.length - visibleCount)
    )
  );

  const visibleEnd = cleanRecords.length - safePan;
  const visibleStart = Math.max(0, visibleEnd - visibleCount);
  const chartRecords = cleanRecords.slice(visibleStart, visibleEnd);

  const candleSize = Math.max(
    1,
    Math.round(3 / zoom)
  );

  const candles = useMemo(
    () => buildCandles(chartRecords, candleSize),
    [chartRecords, candleSize]
  );

  const chartValues = candles.flatMap((c) => [
    c.high,
    c.low,
  ]);

  const scale = chartValues.length
    ? makeScale(chartValues, 420)
    : null;

  const durationOptions =
    unit === "ticks"
      ? [5, 10, 20, 50, 100]
      : [5, 10, 15, 30, 60];

  const durationLabel =
    unit === "ticks"
      ? `${duration} ticks`
      : `${duration}s`;

  const displayPrice =
    Number.isFinite(Number(currentPrice))
      ? Number(currentPrice).toFixed(market?.decimals ?? 2)
      : "—";

  const fmt = (value) =>
    Number.isFinite(Number(value))
      ? Number(value).toFixed(market?.decimals ?? 2)
      : "—";

  const entry = markers.at(-1) || null;

  const signalQuality = best.valid
    ? best.confidence >= 84
      ? "HIGH CONVICTION"
      : "QUALIFIED"
    : touch.setup;

  const confirmationCount = candidateConfirmation.current.signal === best.signal
    ? candidateConfirmation.current.count
    : 0;

  const engineStage = signalCycle.current.locked
    ? "COOLDOWN"
    : touch.sampleCount < touch.minSamples
      ? "COLLECTING"
      : best.valid && confirmationCount >= 3
        ? "ENTRY READY"
        : best.valid || touch.confidence >= 64
          ? "SETUP FORMING"
          : "ANALYZING";


  // Never present an extreme Rise/Fall bias before there is enough history.
  // WAIT is intentionally neutral because the page is a Touch/No Touch entry
  // scanner and Rise/Fall is only supporting context.
  const riseFallReady = analysisPrices.length >= 12;
  const riseBias = !riseFallReady || riseFall.signal === "WAIT"
    ? 50
    : riseFall.signal === "RISE"
      ? clamp(riseFall.confidence, 50, 95)
      : clamp(100 - riseFall.confidence, 5, 50);
  const fallBias = 100 - riseBias;

  const manualBarrier = selectedBarrierTarget;

  const manualBarrierText = Number.isFinite(Number(manualBarrier))
    ? Number(manualBarrier).toFixed(market?.decimals ?? 2)
    : "—";

  // Deriv short-duration Touch/No Touch uses relative barriers (+/-).
  // Synthetic Indices also support absolute barriers, so Fixed Barrier sends
  // the exact absolute target while Above/Below Spot sends the exact offset.
  const manualOrderBarrier = useMemo(() => {
    const spot = Number(currentPrice);
    const target = Number(manualBarrier);
    if (!Number.isFinite(spot) || !Number.isFinite(target)) return null;
    const decimals = Math.max(2, Math.min(6, Number(market?.decimals ?? 2)));
    if (barrierMode === "fixed") return target.toFixed(decimals);
    const gap = Math.abs(target - spot);
    if (!(gap > 0)) return null;
    return `${barrierMode === "below" ? "-" : "+"}${gap.toFixed(decimals)}`;
  }, [currentPrice, manualBarrier, barrierMode, market?.decimals]);

  useEffect(() => {
    let cancelled = false;
    if (typeof quoteTrade !== "function" || !connected || !selectedAccountId || !manualOrderBarrier || !symbol) {
      setProposalPreview((old) => ({ ...old, touch: null, noTouch: null, loading: false, error: "" }));
      return undefined;
    }

    const timer = window.setTimeout(async () => {
      setProposalPreview((old) => ({ ...old, loading: true, error: "" }));
      const common = {
        amount: Number(stake),
        duration: Number(duration),
        durationUnit: unit === "ticks" ? "t" : "s",
        barrier: manualOrderBarrier,
        symbol,
      };
      try {
        const [touchQuote, noTouchQuote] = await Promise.all([
          quoteTrade({ ...common, contractType: "ONETOUCH" }),
          quoteTrade({ ...common, contractType: "NOTOUCH" }),
        ]);
        if (!cancelled) setProposalPreview({ touch: touchQuote, noTouch: noTouchQuote, loading: false, error: "" });
      } catch (error) {
        if (!cancelled) setProposalPreview({ touch: null, noTouch: null, loading: false, error: error instanceof Error ? error.message : "Proposal unavailable" });
      }
    }, 650);

    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [quoteTrade, connected, selectedAccountId, manualOrderBarrier, symbol, stake, duration, unit]);

  const touchPayout = Number(proposalPreview.touch?.payout || 0);
  const touchAsk = Number(proposalPreview.touch?.askPrice || 0);
  const noTouchPayout = Number(proposalPreview.noTouch?.payout || 0);
  const noTouchAsk = Number(proposalPreview.noTouch?.askPrice || 0);

  const placeManualTrade = async (signal) => {
    setManualTradeStatus(null);

    if (!selectedAccountId) {
      setManualTradeStatus({ type: "error", text: "Choose a Deriv Demo or Real account first." });
      return;
    }

    if (!connected) {
      setManualTradeStatus({ type: "error", text: "Connect the Deriv feed first." });
      return;
    }

    const amount = Number(stake);
    if (!Number.isFinite(amount) || amount <= 0) {
      setManualTradeStatus({ type: "error", text: "Enter a valid stake." });
      return;
    }

    if (!manualOrderBarrier || !Number.isFinite(Number(manualBarrier))) {
      setManualTradeStatus({ type: "error", text: "Barrier is not ready yet. Wait for clean market data." });
      return;
    }

    const barrierGap = Math.abs(Number(manualBarrier) - Number(currentPrice));
    if (!(barrierGap > 0)) {
      setManualTradeStatus({ type: "error", text: "Barrier must be different from the current spot." });
      return;
    }

    try {
      const result = await placeTrade({
        contractType: signal === "TOUCH" ? "ONETOUCH" : "NOTOUCH",
        amount,
        duration: Number(duration),
        durationUnit: unit === "ticks" ? "t" : "s",
        barrier: manualOrderBarrier,
        symbol,
      });

      setManualTradeStatus({
        type: "success",
        text: `${signal} opened on ${String(selectedAccountType || "Deriv").toUpperCase()} · Contract ${result?.contractId || "confirmed"}`,
      });
    } catch (error) {
      setManualTradeStatus({
        type: "error",
        text: error instanceof Error ? error.message : "Trade failed.",
      });
    }
  };

  const handleWheel = (e) => {
    e.preventDefault();

    setZoom((old) =>
      clamp(
        old + (e.deltaY < 0 ? 0.12 : -0.12),
        0.7,
        3
      )
    );
  };

  const startDrag = (e) => {
    dragRef.current = {
      x: e.clientX,
      pan,
    };
  };

  const dragMove = (e) => {
    if (!dragRef.current) return;

    const dx = e.clientX - dragRef.current.x;
    const ticksPerPixel = visibleCount / 900;

    const nextPan = Math.round(
      dragRef.current.pan - dx * ticksPerPixel
    );

    setPan(
      Math.max(
        0,
        Math.min(
          nextPan,
          Math.max(0, cleanRecords.length - visibleCount)
        )
      )
    );
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const handleCrosshair = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPct = clamp(
      (e.clientX - rect.left) / rect.width,
      0,
      1
    );
    const yPct = clamp(
      (e.clientY - rect.top) / rect.height,
      0,
      1
    );

    const index = Math.round(
      xPct * Math.max(0, chartRecords.length - 1)
    );

    const record = chartRecords[index];

    setCrosshair({
      x: xPct * 1000,
      y: yPct * 420,
      price:
        scale
          ? scale.max - yPct * scale.span
          : null,
      record,
    });
  };

  const markerData = markers
    .map((marker) => {
      if (!scale) return null;

      const idx = chartRecords.findIndex(
        (r) => r.ts === marker.ts
      );

      if (idx < 0) return null;

      return {
        ...marker,
        x:
          (idx /
            Math.max(1, chartRecords.length - 1)) *
          1000,
        y: scale.y(marker.price),
      };
    })
    .filter(Boolean);

  const marketStatus = connected ? "OPEN" : "OFFLINE";
  const volatilityLabel =
    riseFall.volatility > 1 ? "HIGH" :
    riseFall.volatility > 0.25 ? "NORMAL" : "LOW";
  const tickSpeed = cleanRecords.length > 1
    ? Math.max(
        0,
        1000 /
          Math.max(
            1,
            cleanRecords.at(-1).ts - cleanRecords.at(-2).ts
          )
      )
    : 0;

  const recentSignals = [...markers].reverse().slice(0, 6);

  return (
    <div className="terminalShell">
      <Sidebar />

      <main className="terminalMain">
        <Topbar
          title="Deriv AI Analyzer"
          subtitle="Touch / No Touch setup scanner · entries only after confirmation"
          connected={connected}
          connecting={
            status === "CONNECTING" || loadingMarket
          }
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {statusDetail ? (
          <div className="terminalError">
            {statusDetail}
          </div>
        ) : null}

        <section className="terminalControls">
          <label>
            <span>MARKET</span>
            <select
              value={symbol || ""}
              disabled={loadingMarket}
              onChange={(e) =>
                changeSymbol(e.target.value)
              }
            >
              {markets.map((m) => {
                const id = m.symbol || m.id;

                return (
                  <option key={id} value={id}>
                    {derivMarketName(id, m.label)}
                  </option>
                );
              })}
            </select>
          </label>

          <label>
            <span>TYPE</span>
            <select
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value);
                setDuration(10);
              }}
            >
              <option value="ticks">Ticks</option>
              <option value="seconds">Seconds</option>
            </select>
          </label>

          <label>
            <span>DURATION</span>
            <select
              value={duration}
              onChange={(e) =>
                setDuration(Number(e.target.value))
              }
            >
              {durationOptions.map((v) => (
                <option key={v} value={v}>
                  {unit === "ticks"
                    ? `${v} ticks`
                    : `${v} sec`}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setPan(0);
            }}
          >
            Reset chart
          </button>

          <div
            className={`terminalLive ${
              connected ? "on" : ""
            }`}
          >
            <i />
            {connected ? "DERIV LIVE" : status}
          </div>
        </section>

        <section className="terminalWorkspace">
          <article className="terminalChartCard">
            <div className="terminalChartHeader">
              <div>
                <span>LIVE MARKET</span>
                <h2>
                  {derivMarketName(
                    symbol,
                    market?.label
                  )}
                </h2>
              </div>

              <div className="terminalPrice">
                <strong>{displayPrice}</strong>
                <small>{durationLabel}</small>
              </div>
            </div>

            <div
              className="terminalChart"
              onWheel={handleWheel}
              onMouseDown={startDrag}
              onMouseMove={(e) => {
                dragMove(e);
                handleCrosshair(e);
              }}
              onMouseUp={endDrag}
              onMouseLeave={() => {
                endDrag();
                setCrosshair(null);
              }}
            >
              {scale && candles.length ? (
                <svg
                  viewBox="0 0 1080 420"
                  preserveAspectRatio="none"
                >
                  {candles.map((c, i) => {
                    const count = Math.max(
                      1,
                      candles.length
                    );

                    const x =
                      16 +
                      (i /
                        Math.max(1, count - 1)) *
                        930;

                    const candleW = Math.max(
                      4,
                      Math.min(
                        13,
                        (900 / count) * 0.64
                      )
                    );

                    const openY = scale.y(c.open);
                    const closeY = scale.y(c.close);
                    const highY = scale.y(c.high);
                    const lowY = scale.y(c.low);

                    const bullish =
                      c.close >= c.open;

                    const top = Math.min(
                      openY,
                      closeY
                    );

                    const bodyH = Math.max(
                      2,
                      Math.abs(
                        closeY - openY
                      )
                    );

                    return (
                      <g
                        key={`${c.ts}-${i}`}
                        className={
                          bullish
                            ? "terminalCandleUp"
                            : "terminalCandleDown"
                        }
                      >
                        <line
                          x1={x}
                          x2={x}
                          y1={highY}
                          y2={lowY}
                          className="wick"
                        />
                        <rect
                          x={x - candleW / 2}
                          y={top}
                          width={candleW}
                          height={bodyH}
                          rx="1"
                          className="body"
                        />
                      </g>
                    );
                  })}

                  {scale &&
                    Number.isFinite(
                      Number(currentPrice)
                    ) && (
                      <g className="currentPriceLine">
                        <line
                          x1="0"
                          x2="950"
                          y1={scale.y(
                            Number(currentPrice)
                          )}
                          y2={scale.y(
                            Number(currentPrice)
                          )}
                        />
                        <rect
                          x="957"
                          y={
                            scale.y(
                              Number(
                                currentPrice
                              )
                            ) - 10
                          }
                          width="74"
                          height="20"
                          rx="4"
                        />
                        <text
                          x="965"
                          y={
                            scale.y(
                              Number(
                                currentPrice
                              )
                            ) + 4
                          }
                        >
                          {displayPrice}
                        </text>
                      </g>
                    )}

                  {markerData.map((m, i) => {
                    const color = signalColor(
                      m.signal
                    );

                    const isRise =
                      m.signal === "RISE";
                    const isFall =
                      m.signal === "FALL";
                    const isTouch =
                      m.signal === "TOUCH";
                    const isNoTouch =
                      m.signal === "NO TOUCH";

                    return (
                      <g
                        key={`${m.ts}-${i}`}
                        className="terminalMarker"
                        style={{ color }}
                      >
                        <line
                          x1={m.x}
                          x2={m.x}
                          y1="0"
                          y2="420"
                          className="entryLine"
                        />

                        {(isRise || isFall) && (
                          <>
                            <polygon
                              points={
                                isRise
                                  ? `${m.x},${m.y - 22} ${m.x - 8},${m.y - 8} ${m.x + 8},${m.y - 8}`
                                  : `${m.x},${m.y + 22} ${m.x - 8},${m.y + 8} ${m.x + 8},${m.y + 8}`
                              }
                              className="signalArrow"
                            />
                            <text
                              x={Math.min(
                                850,
                                m.x + 10
                              )}
                              y={
                                isRise
                                  ? m.y - 18
                                  : m.y + 30
                              }
                              className="signalLabel"
                            >
                              {isRise
                                ? "BUY RISE"
                                : "BUY FALL"}
                            </text>
                          </>
                        )}

                        {(isTouch ||
                          isNoTouch) && (
                          <>
                            <circle
                              cx={m.x}
                              cy={m.y}
                              r="7"
                              className="touchDot"
                            />
                            <text
                              x={Math.min(
                                850,
                                m.x + 10
                              )}
                              y={m.y - 10}
                              className="signalLabel"
                            >
                              {m.signal}
                            </text>
                          </>
                        )}
                      </g>
                    );
                  })}

                  {[0, 1, 2, 3, 4].map((i) => {
                    const value =
                      scale.max -
                      (i / 4) * scale.span;

                    const y =
                      18 + (i / 4) * 370;

                    return (
                      <g
                        key={`price-${i}`}
                        className="terminalPriceScale"
                      >
                        <line
                          x1="952"
                          x2="968"
                          y1={y}
                          y2={y}
                        />
                        <text
                          x="976"
                          y={y + 4}
                        >
                          {fmt(value)}
                        </text>
                      </g>
                    );
                  })}

                  {[0, 1, 2, 3, 4, 5].map(
                    (i) => {
                      const x =
                        20 + (i / 5) * 900;

                      const idx = Math.round(
                        (i / 5) *
                          Math.max(
                            0,
                            chartRecords.length -
                              1
                          )
                      );

                      const rec =
                        chartRecords[idx];

                      let label = "";

                      if (rec) {
                        label =
                          unit === "ticks"
                            ? `T${visibleStart + idx + 1}`
                            : new Date(
                                rec.ts
                              ).toLocaleTimeString(
                                [],
                                {
                                  minute:
                                    "2-digit",
                                  second:
                                    "2-digit",
                                }
                              );
                      }

                      return (
                        <g
                          key={`time-${i}`}
                          className="terminalTimeScale"
                        >
                          <line
                            x1={x}
                            x2={x}
                            y1="392"
                            y2="400"
                          />
                          <text
                            x={x - 12}
                            y="415"
                          >
                            {label}
                          </text>
                        </g>
                      );
                    }
                  )}

                  {crosshair && (
                    <g className="terminalCrosshair">
                      <line
                        x1={crosshair.x}
                        x2={crosshair.x}
                        y1="0"
                        y2="392"
                      />
                      <line
                        x1="0"
                        x2="950"
                        y1={crosshair.y}
                        y2={crosshair.y}
                      />

                      {crosshair.price !=
                        null && (
                        <>
                          <rect
                            x="957"
                            y={
                              crosshair.y -
                              10
                            }
                            width="74"
                            height="20"
                            rx="4"
                          />
                          <text
                            x="965"
                            y={
                              crosshair.y + 4
                            }
                          >
                            {fmt(
                              crosshair.price
                            )}
                          </text>
                        </>
                      )}
                    </g>
                  )}
                </svg>
              ) : (
                <div className="terminalEmpty">
                  Waiting for live Deriv
                  ticks...
                </div>
              )}
            </div>

            <div className="terminalChartFooter">
              <span>
                Mouse wheel: <b>Zoom</b>
              </span>
              <span>
                Drag: <b>History</b>
              </span>
              <span>
                Visible ticks:{" "}
                <b>{chartRecords.length}</b>
              </span>
              <span>
                Zoom: <b>{zoom.toFixed(2)}x</b>
              </span>
            </div>
          </article>

          <aside className="terminalSide v8Side">
            <section className={`terminalSignalCard v8EntryCard ${best.valid ? "valid" : ""}`}>
              <div className="v8CardTitle"><span>ENTRY ENGINE</span><small>{durationLabel}</small></div>

              <div className="v8StageTrack" aria-label="Entry analysis stages">
                {["COLLECTING", "ANALYZING", "SETUP FORMING", "ENTRY READY", "COOLDOWN"].map((stage, i) => {
                  const stages = ["COLLECTING", "ANALYZING", "SETUP FORMING", "ENTRY READY", "COOLDOWN"];
                  const activeIndex = Math.max(0, stages.indexOf(engineStage));
                  const done = i < activeIndex;
                  const active = i === activeIndex;
                  return (
                    <div className={`v8Stage ${done ? "done" : ""} ${active ? "active" : ""}`} key={stage}>
                      <i>{done ? "✓" : i + 1}</i>
                      <span>{stage}</span>
                    </div>
                  );
                })}
              </div>

              <div className="v8EntryHero">
                <div>
                  <em>{engineStage}</em>
                  <strong>{engineStage === "ENTRY READY" ? best.signal : "WAIT"}</strong>
                  <p>{best.valid && engineStage !== "ENTRY READY" ? `Confirming ${best.signal} setup ${Math.min(confirmationCount, 3)}/3 live ticks` : touch.reason}</p>
                </div>
                <b>{best.confidence.toFixed(0)}%</b>
              </div>

              <div className="v8DataRows">
                <p><span>Contract</span><b>TOUCH / NO TOUCH</b></p>
                <p><span>Quality</span><b>{signalQuality}</b></p>
                <p><span>Live confirmation</span><b>{best.valid ? `${Math.min(confirmationCount, 3)}/3` : "—"}</b></p>
                <p><span>Trend</span><b>{riseFall.trend}</b></p>
                <p><span>Volatility</span><b>{volatilityLabel}</b></p>
                <p><span>Duration</span><b>{durationLabel}</b></p>
                <p><span>Last entry</span><b>{entry ? fmt(entry.price) : "—"}</b></p>
              </div>
            </section>

            <section className="terminalMiniCard v8BiasCard">
              <div className="v8CardTitle"><span>MARKET BIAS</span><small>Rise / Fall context</small></div>
              <div className="v8BiasGrid">
                <div className="rise"><span>RISE</span><strong>{riseBias.toFixed(0)}%</strong><i>↗</i></div>
                <div className="fall"><span>FALL</span><strong>{fallBias.toFixed(0)}%</strong><i>↘</i></div>
              </div>
            </section>

            <section className="terminalMiniCard v8LastSignalCard">
              <div className="v8CardTitle"><span>LAST SIGNAL</span><small>Qualified setup</small></div>
              <div className="v8LastSignal">
                <div><strong>{entry?.signal || "WAIT"}</strong><span>{entry ? `${entry.confidence.toFixed(0)}% confidence` : "Waiting for strong setup…"}</span></div>
                <i>◷</i>
              </div>
            </section>

            <section className="terminalMiniCard manualTradeCard v8ManualCard">
              <div className="manualTradeHead">
                <div><span>MANUAL ENTRY</span><strong>Direct Deriv trade</strong></div>
                <b className={`accountMode ${String(selectedAccountType || "").toLowerCase()}`}>
                  {selectedAccountId ? String(selectedAccountType || "ACCOUNT").toUpperCase() : "NO ACCOUNT"}
                </b>
              </div>

              <div className="v8ContractRow">
                <label><span>CONTRACT</span><select disabled value="touch"><option value="touch">Touch / No Touch</option></select></label>
              </div>

              <div className="derivBarrierBox">
                <div className="derivBarrierTitle"><strong>Barrier</strong><span title="Barrier target used for both analysis and order">ⓘ</span></div>
                <div className="derivBarrierTabs">
                  <button type="button" className={barrierMode === "above" ? "active" : ""} onClick={() => setBarrierMode("above")}>Above spot</button>
                  <button type="button" className={barrierMode === "below" ? "active" : ""} onClick={() => setBarrierMode("below")}>Below spot</button>
                  <button type="button" className={barrierMode === "fixed" ? "active" : ""} onClick={() => setBarrierMode("fixed")}>Fixed barrier</button>
                </div>

                {barrierMode === "fixed" ? (
                  <div className="derivBarrierInput">
                    <span>=</span>
                    <input type="number" step="0.01" value={fixedBarrier} placeholder={displayPrice} onChange={(e) => setFixedBarrier(e.target.value)} />
                  </div>
                ) : (
                  <div className="derivBarrierInput">
                    <span>{barrierMode === "below" ? "−" : "+"}</span>
                    <button type="button" onClick={() => setBarrierOffset((v) => Math.max(0.01, Number(v || 0) - 0.01))}>−</button>
                    <input type="number" min="0.01" step="0.01" value={barrierOffset} onChange={(e) => setBarrierOffset(Math.max(0.01, Number(e.target.value) || 0.01))} />
                    <button type="button" onClick={() => setBarrierOffset((v) => Number((Number(v || 0) + 0.01).toFixed(4)))}>+</button>
                  </div>
                )}

                <div className="derivSpotRow"><span>Current spot</span><strong>{displayPrice}</strong></div>
                <div className="derivSpotRow"><span>Barrier price</span><strong>{manualBarrierText}</strong></div>
                <div className="derivSpotRow"><span>Order barrier</span><strong>{manualOrderBarrier || "—"}</strong></div>
              </div>

              <div className="manualTradeGrid v8ManualGrid derivStakeRow">
                <label><span>STAKE (USD)</span><input type="number" min="0.01" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} /></label>
                <div className="derivDurationEcho"><span>DURATION</span><strong>{durationLabel}</strong></div>
              </div>

              <div className="derivProposalGrid">
                <div><span>TOUCH PAYOUT</span><strong>{proposalPreview.loading ? "…" : touchPayout > 0 ? `${touchPayout.toFixed(2)} USD` : "—"}</strong><small>{touchAsk > 0 ? `Price ${touchAsk.toFixed(2)}` : "Live proposal"}</small></div>
                <div><span>NO TOUCH PAYOUT</span><strong>{proposalPreview.loading ? "…" : noTouchPayout > 0 ? `${noTouchPayout.toFixed(2)} USD` : "—"}</strong><small>{noTouchAsk > 0 ? `Price ${noTouchAsk.toFixed(2)}` : "Live proposal"}</small></div>
              </div>

              <div className="manualTradeButtons">
                <button type="button" className="manualTouchButton" disabled={tradeBusy || !connected || !selectedAccountId || !manualOrderBarrier} onClick={() => placeManualTrade("TOUCH")}>{tradeBusy ? "PROCESSING…" : "BUY TOUCH"}</button>
                <button type="button" className="manualNoTouchButton" disabled={tradeBusy || !connected || !selectedAccountId || !manualOrderBarrier} onClick={() => placeManualTrade("NO TOUCH")}>{tradeBusy ? "PROCESSING…" : "BUY NO TOUCH"}</button>
              </div>
              {proposalPreview.error ? <div className="manualTradeStatus warning">{proposalPreview.error}</div> : null}

              <p className="manualTradeHint">Manual orders use the Demo/Real account selected in the top bar. Analyzer signals are guidance; only press buy when you choose to enter.</p>
              {(manualTradeStatus || tradeError) ? <div className={`manualTradeStatus ${(manualTradeStatus?.type || "error")}`}>{manualTradeStatus?.text || tradeError}</div> : null}
              {!authenticatedFeed && selectedAccountId ? <div className="manualTradeStatus warning">Trading connection authenticates when an order is submitted.</div> : null}
            </section>
          </aside>
        </section>

        <section className="v8LowerGrid">
          <article className="v8RecentPanel">
            <div className="v8SectionTitle"><div><span>RECENT SIGNALS</span><h3>Qualified setups only</h3></div><small>{markers.length} this session</small></div>
            <div className="v8SignalCards">
              {recentSignals.length ? recentSignals.slice(0,5).map((item) => (
                <div className={`v8SignalMini ${item.signal === "TOUCH" ? "touch" : "notouch"}`} key={item.ts}>
                  <span>{item.signal} · ANALYZED</span>
                  <strong>{fmt(item.price)}</strong>
                  <small>{new Date(item.ts).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"})}</small>
                  <b>{item.confidence.toFixed(0)}%</b>
                </div>
              )) : <div className="v8EmptySignal">No qualified entry yet. The engine is scanning.</div>}
            </div>
          </article>

          <article className="v8SummaryPanel">
            <div className="v8SectionTitle"><div><span>ANALYSIS SUMMARY</span><h3>Current market evidence</h3></div><small>Live</small></div>
            <div className="v8SummaryGrid">
              <div><span>Volatility</span><strong>{clamp(riseFall.volatility * 100,0,100).toFixed(0)}%</strong><small>{volatilityLabel}</small></div>
              <div><span>Momentum</span><strong>{riseFall.confidence.toFixed(0)}%</strong><small>{riseFall.momentum}</small></div>
              <div><span>Consistency</span><strong>{riseFall.consistency.toFixed(0)}%</strong><small>{riseFall.consistency >= 65 ? "Strong" : "Mixed"}</small></div>
              <div><span>Barrier Test</span><strong>{clamp(touch.travelRatio * 60,0,100).toFixed(0)}%</strong><small>{touch.travelRatio >= .9 ? "Active" : "Stable"}</small></div>
              <div><span>Touch Prob.</span><strong>{touch.touchScore.toFixed(0)}%</strong><small>{touch.touchScore >= MASTER_THRESHOLD ? "Qualified" : "Watching"}</small></div>
              <div><span>No Touch Prob.</span><strong>{touch.noTouchScore.toFixed(0)}%</strong><small>{touch.noTouchScore >= MASTER_THRESHOLD ? "Qualified" : "Watching"}</small></div>
            </div>
          </article>
        </section>

        <footer className="v8MarketFooter">
          <div><span>Market</span><b>{derivMarketName(symbol, market?.label)}</b></div>
          <div><span>Spot</span><b>{displayPrice}</b></div>
          <div><span>Ticks</span><b>{cleanRecords.length}</b></div>
          <div><span>Setup</span><b>{engineStage}</b></div>
          <div><span>Confidence</span><b>{best.confidence.toFixed(0)}%</b></div>
          <div><span>Deriv API</span><b className={connected ? "ok" : ""}>{connected ? "● Connected" : "○ Offline"}</b></div>
        </footer>
      </main>
    </div>
  );
}
