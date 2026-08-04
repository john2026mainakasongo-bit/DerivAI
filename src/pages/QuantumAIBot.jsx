import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import QuantumTradingChart from "../components/QuantumTradingChart";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeQuantumFiveAI } from "../analysis/quantumFiveAIEngine";
import "../styles/QuantumAIBot.css";

const INITIAL_STATS = {
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  history: [],
};

function money(value) {
  return Number(value || 0).toFixed(2);
}

function contractIdOf(value) {
  return String(
    value?.contractId ||
      value?.contract_id ||
      value?.buy?.contract_id ||
      value?.raw?.buy?.contract_id ||
      value?.raw?.data?.buy?.contract_id ||
      value?.proposal_open_contract?.contract_id ||
      value?.data?.contract_id ||
      value?.data?.contractId ||
      value?.id ||
      ""
  );
}

function settled(contract) {
  const status = String(
    contract?.status ||
      contract?.contract_status ||
      contract?.action ||
      ""
  ).toLowerCase();

  return Boolean(
    contract?.is_sold ||
      contract?.is_expired ||
      contract?.is_settleable === false ||
      ["won", "lost", "sold", "expired", "settled"].includes(status)
  );
}

function contractProfit(contract) {
  const candidates = [
    contract?.profit,
    contract?.profit_loss,
    contract?.pnl,
    contract?.data?.profit,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }

  const payout = Number(
    contract?.payout ??
      contract?.sell_price ??
      contract?.sellPrice ??
      0
  );

  const buy = Number(
    contract?.buy_price ??
      contract?.purchase_price ??
      contract?.buyPrice ??
      0
  );

  return payout - buy;
}

export default function QuantumAIBot() {
  const {
    markets,
    market,
    symbol,
    status,
    statusDetail,
    connected,
    authenticatedFeed,
    loadingMarket,
    prices,
    currentPrice,
    openContracts,
    transactions,
    tradeBusy,
    tradeError,
    selectedAccountType,
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
    refreshContract,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("Quantum AI is ready.");
  const [settings, setSettings] = useState({
    stake: 0.35,
    minConfidence: 64,
    maxNoise: 68,
    maxReversalRisk: 60,
    maxOpenTrades: 2,
    marketSwitchSeconds: 8,
    minimumTradeGapSeconds: 3,
    takeProfit: 5,
    stopLoss: 3,
    oneLossCooldownSeconds: 20,
    repeatLossBlockSeconds: 90,
    marketLossBlockSeconds: 60,
    entryDeadlineSeconds: 60,
    deadlineminConfidence: 64,
    deadlinemaxNoise: 68,
    deadlineMaxReversal: 64,
  });
  const [activeTrades, setActiveTrades] = useState([]);
  const [stats, setStats] = useState(INITIAL_STATS);
  const [marketScores, setMarketScores] = useState({});

  const lastTradeAtRef = useRef(0);
  const scanStartedAtRef = useRef(Date.now());
  const processedContractsRef = useRef(new Set());
  const buyingRef = useRef(false);
  const autoConnectStartedRef = useRef(false);
  const marketWarmupStartedRef = useRef(Date.now());
  const previousSymbolRef = useRef("");
  const entryDeadlineStartedRef = useRef(Date.now());
  const adaptiveMarketBlockRef = useRef(new Map());

  const connecting = status === "CONNECTING" || loadingMarket;

  useEffect(() => {
    if (!symbol) return;

    if (previousSymbolRef.current !== symbol) {
      previousSymbolRef.current = symbol;
      marketWarmupStartedRef.current = Date.now();
      scanStartedAtRef.current = Date.now();
      setMessage(`Warming ${market?.label || symbol} before scoring all five AI models...`);
    }
  }, [symbol, market?.label]);

  const marketWarmup = useMemo(() => {
    const sampleCount = Array.isArray(prices) ? prices.length : 0;
    const elapsedSeconds =
      (Date.now() - marketWarmupStartedRef.current) / 1000;

    const oneSecondMarket =
      String(symbol || "").includes("1HZ") ||
      String(market?.label || "").includes("(1s)");

    const minimumSamples = oneSecondMarket ? 45 : 70;
    const minimumSeconds = oneSecondMarket ? 8 : 18;

    /*
     * V15: release warmup as soon as either enough live ticks OR enough
     * wall-clock time has been collected. Previously both conditions were
     * required, which could leave fast 1-second markets showing
     * "Warming 168/45 ticks" even though the sample requirement had passed.
     */
    const ready =
      sampleCount >= minimumSamples ||
      elapsedSeconds >= minimumSeconds;

    return {
      ready,
      sampleCount,
      minimumSamples,
      elapsedSeconds,
      minimumSeconds,
      oneSecondMarket,
    };
  }, [prices, symbol, market?.label]);

  useEffect(() => {
    if (connected || connecting || autoConnectStartedRef.current) return;

    autoConnectStartedRef.current = true;
    setMessage("Connecting Quantum AI to Deriv live feed...");

    Promise.resolve(connect())
      .then(() => setMessage("Deriv live feed connected. Collecting market ticks..."))
      .catch((error) => {
        autoConnectStartedRef.current = false;
        setMessage(error instanceof Error ? error.message : "Unable to connect Deriv feed.");
      });
  }, [connected, connecting, connect]);

  const analysis = useMemo(
    () =>
      analyzeQuantumFiveAI(prices, {
        minConfidence: settings.minConfidence,
        maxNoise: settings.maxNoise,
        maxReversalRisk: settings.maxReversalRisk,
      }),
    [prices, settings.minConfidence, settings.maxNoise, settings.maxReversalRisk]
  );  const minuteEntry = useMemo(() => {
    const elapsedSeconds =
      (Date.now() - Number(entryDeadlineStartedRef.current || Date.now())) / 1000;

    const candidate =
      analysis.candidate ||
      analysis.fiveAI?.candidate ||
      "WAIT";

    const agreement = Number(analysis.fiveAI?.agreement || 0);
    const confidence = Number(analysis.confidence || 0);
    const noise = Number(analysis.noiseScore || 100);
    const reversal = Number(analysis.reversalRisk || 100);
    const consistency = Number(analysis.consistency || 0);
    const voteConsensus = Number(analysis.metrics?.voteConsensus || 0);

    const safetyPassed =
      candidate !== "WAIT" &&
      agreement >= 2 &&
      confidence >= Number(settings.deadlineMinConfidence || 62) &&
      noise <= Number(settings.deadlineMaxNoise || 72) &&
      reversal <= Number(settings.deadlineMaxReversal || 64) &&
      consistency >= 18 &&
      voteConsensus >= 58;

    const ready =
      running &&
      marketWarmup.ready &&
      elapsedSeconds >= Number(settings.entryDeadlineSeconds || 60) &&
      safetyPassed;

    return {
      ready,
      candidate,
      elapsedSeconds,
      agreement,
      confidence,
      noise,
      reversal,
      consistency,
      voteConsensus,
      duration: 10,
      durationUnit: "s",
      displayDuration: "10 SECONDS",
      reason: ready
        ? `One-minute lane selected ${candidate} at ${confidence.toFixed(1)}%.`
        : elapsedSeconds >= Number(settings.entryDeadlineSeconds || 60)
        ? `Deadline reached but current setup is unsafe: ${agreement}/5 AI, noise ${noise.toFixed(0)}%, reversal ${reversal.toFixed(0)}%.`
        : `Searching best entry: ${Math.max(
            0,
            Math.ceil(Number(settings.entryDeadlineSeconds || 60) - elapsedSeconds)
          )}s remaining.`,
    };
  }, [
    running,
    marketWarmup.ready,
    analysis.candidate,
    analysis.fiveAI?.candidate,
    analysis.fiveAI?.agreement,
    analysis.confidence,
    analysis.noiseScore,
    analysis.reversalRisk,
    analysis.consistency,
    analysis.metrics?.voteConsensus,
    settings.entryDeadlineSeconds,
    settings.deadlineMinConfidence,
    settings.deadlineMaxNoise,
    settings.deadlineMaxReversal,
  ]);


  const adaptiveLossGuard = useMemo(() => {
    const history = Array.isArray(stats.history) ? stats.history : [];
    const now = Date.now();

    const symbolHistory = history
      .filter((item) => item.symbol === symbol)
      .sort((a, b) => Number(b.settledAt || 0) - Number(a.settledAt || 0));

    const recent = symbolHistory.slice(0, 8);
    const last = recent[0] || null;

    let sameDirectionLossStreak = 0;
    let marketLossStreak = 0;
    let sessionLossStreak = 0;

    for (const item of history) {
      if (item.result !== "LOST") break;
      sessionLossStreak += 1;
    }

    for (const item of recent) {
      if (item.result !== "LOST") break;
      marketLossStreak += 1;
    }

    if (last?.result === "LOST") {
      for (const item of recent) {
        if (item.result !== "LOST" || item.direction !== last.direction) break;
        sameDirectionLossStreak += 1;
      }
    }

    const lastLossAgeSeconds =
      last?.result === "LOST"
        ? Math.max(0, (now - Number(last.settledAt || now)) / 1000)
        : Number.POSITIVE_INFINITY;

    const candidate = analysis.candidate || analysis.decision || "WAIT";
    const sameAsLastLoss =
      last?.result === "LOST" && candidate === last.direction;

    const oppositeOfLastLoss =
      last?.result === "LOST" &&
      candidate !== "WAIT" &&
      candidate !== last.direction;

    const voteConsensus = Number(analysis.metrics?.voteConsensus || 0);
    const consistency = Number(analysis.consistency || 0);
    const fullTimeframePassed = Boolean(
      (analysis.checks || []).find((item) => item.label === "Full timeframe")?.passed
    );

    const oppositeConfirmed =
      oppositeOfLastLoss &&
      analysis.entryMode === "STRONG" &&
      Number(analysis.confidence || 0) >= Number(settings.minConfidence || 72) + 6 &&
      Number(analysis.noiseScore || 100) <= Math.max(20, Number(settings.maxNoise || 66) - 8) &&
      Number(analysis.reversalRisk || 100) <= Math.max(15, Number(settings.maxReversalRisk || 60) - 10) &&
      voteConsensus >= 68 &&
      consistency >= 35 &&
      fullTimeframePassed;

    const oneLossCooldown =
      sameAsLastLoss &&
      sameDirectionLossStreak === 1 &&
      lastLossAgeSeconds < Number(settings.oneLossCooldownSeconds || 20);

    const repeatedDirectionBlock =
      sameAsLastLoss &&
      sameDirectionLossStreak >= 2 &&
      lastLossAgeSeconds < Number(settings.repeatLossBlockSeconds || 90);

    const marketBlockedUntil = Number(adaptiveMarketBlockRef.current.get(symbol) || 0);
    const marketBlocked = marketLossStreak >= 2 && now < marketBlockedUntil;

    const sessionCooldown = sessionLossStreak >= 3 && lastLossAgeSeconds < 120;

    let reason = "Loss memory clear. Normal confirmed-entry rules apply.";

    if (sessionCooldown) {
      reason = "Three consecutive session losses: scanner cooling down for 120 seconds.";
    } else if (marketBlocked) {
      reason = "This market is temporarily blocked after repeated losses.";
    } else if (repeatedDirectionBlock) {
      reason = `${candidate} is blocked after repeated same-direction losses. Switching market.`;
    } else if (oneLossCooldown) {
      reason = `${candidate} lost recently. Waiting for a fresh setup instead of repeating immediately.`;
    } else if (oppositeOfLastLoss && !oppositeConfirmed) {
      reason = `Opposite ${candidate} is not accepted automatically; strong independent confirmation is required.`;
    } else if (oppositeConfirmed) {
      reason = `Opposite ${candidate} passed strong independent confirmation after the previous loss.`;
    }

    const ready =
      analysis.ready &&
      !sessionCooldown &&
      !marketBlocked &&
      !oneLossCooldown &&
      !repeatedDirectionBlock &&
      (!oppositeOfLastLoss || oppositeConfirmed);

    return {
      ready,
      reason,
      candidate,
      lastLossDirection: last?.result === "LOST" ? last.direction : "—",
      sameDirectionLossStreak,
      marketLossStreak,
      sessionLossStreak,
      oppositeConfirmed,
      shouldSwitchMarket: repeatedDirectionBlock || marketBlocked || sessionCooldown,
    };
  }, [
    stats.history,
    symbol,
    analysis.ready,
    analysis.candidate,
    analysis.decision,
    analysis.entryMode,
    analysis.confidence,
    analysis.noiseScore,
    analysis.reversalRisk,
    analysis.consistency,
    analysis.metrics?.voteConsensus,
    analysis.checks,
    settings.minConfidence,
    settings.maxNoise,
    settings.maxReversalRisk,
    settings.oneLossCooldownSeconds,
    settings.repeatLossBlockSeconds,
  ]);

  useEffect(() => {
    const symbolHistory = (Array.isArray(stats.history) ? stats.history : [])
      .filter((item) => item.symbol === symbol)
      .sort((a, b) => Number(b.settledAt || 0) - Number(a.settledAt || 0));

    let losses = 0;
    for (const item of symbolHistory) {
      if (item.result !== "LOST") break;
      losses += 1;
    }

    if (losses >= 2 && symbol) {
      adaptiveMarketBlockRef.current.set(
        symbol,
        Date.now() + Number(settings.marketLossBlockSeconds || 60) * 1000
      );
    }
  }, [stats.history, symbol, settings.marketLossBlockSeconds]);
  useEffect(() => {
    if (!symbol) return;
    setMarketScores((current) => ({
      ...current,
      [symbol]: {
        symbol,
        label: market?.label || symbol,
        confidence: analysis.confidence,
        decision: analysis.decision,
        score: analysis.confidence - analysis.reversalRisk * 0.15,
        updatedAt: Date.now(),
      },
    }));
  }, [symbol, market?.label, analysis.confidence, analysis.decision, analysis.reversalRisk]);

  useEffect(() => {
    const contractRows = Array.isArray(openContracts) ? openContracts : [];
    const transactionRows = Array.isArray(transactions) ? transactions : [];

    const combined = [...contractRows, ...transactionRows];
    const updates = [];

    for (const contract of combined) {
      const id = contractIdOf(contract);

      if (
        !id ||
        !settled(contract) ||
        processedContractsRef.current.has(id)
      ) {
        continue;
      }

      const original = activeTrades.find(
        (item) => String(item.contractId) === id
      );

      if (!original) continue;

      processedContractsRef.current.add(id);

      const profit = contractProfit(contract);
      const rawStatus = String(
        contract?.status ||
          contract?.contract_status ||
          ""
      ).toUpperCase();

      const result =
        rawStatus === "WON" || profit > 0
          ? "WON"
          : "LOST";

      updates.push({
        ...original,
        result,
        profit,
        settledAt: Date.now(),
      });
    }

    if (!updates.length) return;

    setActiveTrades((current) =>
      current.filter(
        (item) =>
          !updates.some(
            (done) =>
              String(done.contractId) === String(item.contractId)
          )
      )
    );

    setStats((current) => {
      const wins = updates.filter(
        (item) => item.result === "WON"
      ).length;

      const losses = updates.length - wins;

      const profit = updates.reduce(
        (sum, item) => sum + Number(item.profit || 0),
        0
      );

      return {
        runs: current.runs,
        wins: current.wins + wins,
        losses: current.losses + losses,
        profit: current.profit + profit,
        history: [
          ...updates.reverse(),
          ...current.history,
        ].slice(0, 40),
      };
    });
  }, [openContracts, transactions, activeTrades]);

  useEffect(() => {
    if (
      !activeTrades.length ||
      typeof refreshContract !== "function"
    ) {
      return;
    }

    const refreshAll = () => {
      activeTrades.forEach((trade) => {
        if (!trade.contractId) return;

        Promise.resolve(
          refreshContract(trade.contractId)
        ).catch(() => {
          // Subscription may still deliver the settlement.
        });
      });
    };

    refreshAll();
    const timer = window.setInterval(refreshAll, 2000);

    return () => window.clearInterval(timer);
  }, [activeTrades, refreshContract]);

  useEffect(() => {
    if (!running) return;
    if (stats.profit >= Number(settings.takeProfit)) {
      setRunning(false);
      setMessage("Take Profit reached. Bot stopped safely.");
    } else if (stats.profit <= -Math.abs(Number(settings.stopLoss))) {
      setRunning(false);
      setMessage("Stop Loss reached. Bot stopped safely.");
    }
  }, [running, stats.profit, settings.takeProfit, settings.stopLoss]);

  useEffect(() => {
    if (
      !running ||
      loadingMarket ||
      activeTrades.length > 0 ||
      markets.length < 2 ||
      !marketWarmup.ready
    ) {
      if (running && !marketWarmup.ready) {
        setMessage(
          marketWarmup.sampleCount >= marketWarmup.minimumSamples
            ? `${market?.label || symbol} has enough ticks. Finalizing Five-AI score...`
            : `Warming ${market?.label || symbol}: ${marketWarmup.sampleCount}/${marketWarmup.minimumSamples} ticks, ` +
              `${Math.floor(marketWarmup.elapsedSeconds)}/${marketWarmup.minimumSeconds}s.`
        );
      }
      return;
    }
    if (adaptiveLossGuard.ready) {
      scanStartedAtRef.current = Date.now();
      return;
    }

    if (adaptiveLossGuard.shouldSwitchMarket) {
      const index = Math.max(0, markets.findIndex((item) => item.id === symbol));
      const next = markets[(index + 1) % markets.length];

      if (next?.id && next.id !== symbol) {
        setMessage(adaptiveLossGuard.reason);
        scanStartedAtRef.current = Date.now();
        void changeSymbol(next.id);
      }
      return;
    }

    const timer = window.setInterval(() => {
      const elapsed = (Date.now() - scanStartedAtRef.current) / 1000;
      if (elapsed < Number(settings.marketSwitchSeconds || 12)) return;

      const index = Math.max(0, markets.findIndex((item) => item.id === symbol));
      const next = markets[(index + 1) % markets.length];
      if (next?.id && next.id !== symbol) {
        setMessage(`Market unclear. Switching to ${next.label}...`);
        scanStartedAtRef.current = Date.now();
        void changeSymbol(next.id);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [
    running,
    loadingMarket,
    activeTrades.length,
    markets,
    symbol,
    analysis.ready,
    adaptiveLossGuard.ready,
    adaptiveLossGuard.reason,
    adaptiveLossGuard.shouldSwitchMarket,
    settings.marketSwitchSeconds,
    changeSymbol,
    marketWarmup.ready,
    marketWarmup.sampleCount,
    marketWarmup.minimumSamples,
    marketWarmup.elapsedSeconds,
    marketWarmup.minimumSeconds,
    market?.label,
  ]);

  useEffect(() => {
    if (
      !running ||
      !marketWarmup.ready ||
      !(adaptiveLossGuard.ready || minuteEntry.ready) ||
      buyingRef.current ||
      tradeBusy
    ) {
      if (running && !marketWarmup.ready) {
        setMessage(
          marketWarmup.sampleCount >= marketWarmup.minimumSamples
            ? `${market?.label || symbol} tick sample is ready. Final entry vote is being calculated.`
            : `Warming ${market?.label || symbol}: ${marketWarmup.sampleCount}/${marketWarmup.minimumSamples} ticks.`
        );
      } else if (running && analysis.ready && !(adaptiveLossGuard.ready || minuteEntry.ready)) {
        setMessage(adaptiveLossGuard.reason);
      }
      return;
    }
    if (!authenticatedFeed) {
      setMessage("Choose a Deriv Demo or Real account and reconnect first.");
      return;
    }
    if (activeTrades.length >= Number(settings.maxOpenTrades || 2)) return;

    const gapMs = Number(settings.minimumTradeGapSeconds || 3) * 1000;
    if (Date.now() - lastTradeAtRef.current < gapMs) return;

    buyingRef.current = true;

    void (async () => {
      try {
        const direction = minuteEntry.ready
          ? minuteEntry.candidate
          : adaptiveLossGuard.candidate;
        setMessage(
          `${direction} sharp entry found at ${analysis.confidence.toFixed(1)}%. Buying ${analysis.duration}s...`
        );

        const tradeRequest = Promise.resolve(
          placeTrade({
            contractType: direction === "RISE" ? "CALL" : "PUT",
            amount: Math.max(0.35, Number(settings.stake || 0.35)),
            basis: "stake",
            duration: minuteEntry.ready
            ? minuteEntry.duration
            : analysis.duration,
          durationUnit: minuteEntry.ready
            ? minuteEntry.durationUnit
            : analysis.durationUnit || "s",
          displayDuration:
            analysis.displayDuration ||
            `${analysis.duration}${analysis.durationUnit === "t" ? " ticks" : "s"}`,
            durationUnit: "s",
            symbol,
          })
        );

        const timeoutRequest = new Promise((_, reject) => {
          window.setTimeout(() => {
            reject(
              new Error(
                "Deriv purchase confirmation timed out after 15 seconds. Scanner has been released."
              )
            );
          }, 15000);
        });

        const response = await Promise.race([
          tradeRequest,
          timeoutRequest,
        ]);

        const contractId = contractIdOf(response);
        if (!contractId) throw new Error("Deriv did not return a contract ID.");

        const trade = {
          contractId,
          market: market?.label || symbol,
          symbol,
          direction,
          confidence: analysis.confidence,
          duration: minuteEntry.ready
            ? minuteEntry.duration
            : analysis.duration,
          durationUnit: minuteEntry.ready
            ? minuteEntry.durationUnit
            : analysis.durationUnit || "s",
          displayDuration:
            analysis.displayDuration ||
            `${analysis.duration}${analysis.durationUnit === "t" ? " ticks" : "s"}`,
          stake: Number(settings.stake || 0.35),
          entryPrice: currentPrice,
          openedAt: Date.now(),
        };

        lastTradeAtRef.current = Date.now();
        entryDeadlineStartedRef.current = Date.now();
        setActiveTrades((current) => [trade, ...current]);
        setStats((current) => ({ ...current, runs: current.runs + 1 }));
        setMessage(`Trade ${contractId} opened. Quantum AI continues scanning for slot 2.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to open trade.");
      } finally {
        buyingRef.current = false;
      }
    })();


  }, [
    running,
    analysis,
    adaptiveLossGuard.ready,
    adaptiveLossGuard.reason,
    adaptiveLossGuard.candidate,
    minuteEntry.ready,
    minuteEntry.candidate,
    minuteEntry.duration,
    minuteEntry.durationUnit,
    minuteEntry.displayDuration,    authenticatedFeed,
    activeTrades.length,
    settings,
    tradeBusy,
    placeTrade,
    symbol,
    market?.label,
    currentPrice,
  ]);

  async function startBot() {
    if (!connected) {
      try {
        setMessage("Connecting to Deriv...");
        await connect();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Connection failed.");
        return;
      }
    }

    scanStartedAtRef.current = Date.now();
    entryDeadlineStartedRef.current = Date.now();
    setRunning(true);
    setMessage("Quantum AI is scanning all conditions. It will trade only confirmed entries.");
  }

  function stopBot() {
    setRunning(false);
    setMessage("Bot stopped. Open contracts will continue settling on Deriv.");
  }

  function resetSession() {
    if (running || activeTrades.length) return;
    setStats(INITIAL_STATS);
    processedContractsRef.current.clear();
    setMessage("Session reset. Quantum AI is ready.");
  }

  const rankedMarkets = Object.values(marketScores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return (
    <div className="appShell quantumShell">
      <Sidebar />
      <main className="mainContent quantumPage">
        <Topbar
          title="MetaBinary Quantum AI"
          subtitle="Adaptive Rise/Fall scanner Â· smart seconds Â· two-run execution"
          connected={connected}
          connecting={connecting}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className={`quantumHero ${running ? "running" : "idle"}`}>
          <div>
            <small>METABINARY SYNTHETIC INTELLIGENCE</small>
            <h1>MetaBinary Quantum AI</h1>
            <p>Rise/Fall sharp-entry scanner with smart seconds, market switching and two live trade slots.</p>
          </div>
          <div className="quantumHeroStatus">
            <span>{running ? "â— LIVE" : "â—‹ IDLE"}</span>
            <strong>{running ? (analysis.ready ? "ENTRY READY" : "SCANNING") : "STOPPED"}</strong>
          </div>
        </section>

        <section className="quantumToolbar">
          <div>
            <span>Market</span>
            <MarketSelector
              markets={markets}
              value={symbol}
              disabled={loadingMarket || activeTrades.length > 0}
              onChange={changeSymbol}
            />
          </div>
          <div className="quantumAccount">
            <span>Account</span>
            <strong>{selectedAccountType || "Not selected"}</strong>
          </div>
          <button className="quantumStart" onClick={startBot} disabled={running}>RUN AI</button>
          <button className="quantumStop" onClick={stopBot} disabled={!running}>STOP</button>
          <button className="quantumReset" onClick={resetSession} disabled={running || activeTrades.length > 0}>RESET</button>
        </section>

        <section className={`quantumDecision ${analysis.ready ? "ready" : "wait"}`}>
          <div>
            <small>AI DECISION</small>
            <h2>{analysis.decision}</h2>
            <p>{analysis.reason}</p>
          </div>
          <div className="quantumDecisionStats">
            <article><span>Confidence</span><strong>{analysis.confidence.toFixed(1)}%</strong></article>
            <article><span>Candidate</span><strong>{analysis.candidate || "â€”"}</strong></article>
            <article>
              <span>Smart duration</span>
              <strong>
                {analysis.displayDuration ||
                  `${analysis.duration}${analysis.durationUnit === "t" ? " ticks" : "s"}`}
              </strong>
            </article>
            <article><span>Active slots</span><strong>{activeTrades.length}/{settings.maxOpenTrades}</strong></article>
          </div>
        </section>

        <section className="quantumSettings">
          {[
            ["Stake USD", "stake", 0.35, 100, 0.01],
            ["Min confidence", "minConfidence", 60, 98, 1],
            ["Max noise", "maxNoise", 20, 90, 1],
            ["Max reversal", "maxReversalRisk", 15, 90, 1],
            ["Trade slots", "maxOpenTrades", 1, 2, 1],
            ["Switch sec", "marketSwitchSeconds", 5, 60, 1],
            ["Take profit", "takeProfit", 0.5, 1000, 0.5],
            ["Stop loss", "stopLoss", 0.5, 1000, 0.5],
            ["Entry deadline sec", "entryDeadlineSeconds", 30, 180, 5],
            ["Deadline confidence", "deadlineMinConfidence", 55, 90, 1],
            ["Deadline max noise", "deadlineMaxNoise", 40, 85, 1],
            ["Deadline reversal", "deadlineMaxReversal", 30, 80, 1],
          ].map(([label, key, min, max, step]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="number"
                min={min}
                max={max}
                step={step}
                disabled={running}
                value={settings[key]}
                onChange={(event) => setSettings((current) => ({ ...current, [key]: Number(event.target.value) }))}
              />
            </label>
          ))}
        </section>

        <section className="quantumMetrics">
          <article><span>Regime</span><strong>{analysis.regime}</strong></article>
          <article><span>Trend</span><strong>{analysis.trend}</strong></article>
          <article><span>Momentum</span><strong>{analysis.momentum}</strong></article>
          <article><span>Noise</span><strong>{analysis.noise}</strong></article>
          <article><span>Volatility</span><strong>{analysis.volatility.toFixed(0)}%</strong></article>
          <article><span>Consistency</span><strong>{analysis.consistency.toFixed(0)}%</strong></article>
          <article><span>Reversal risk</span><strong>{analysis.reversalRisk.toFixed(0)}%</strong></article>
          <article><span>Price</span><strong>{currentPrice ?? "â€”"}</strong></article>
        </section>

        <QuantumTradingChart prices={prices} analysis={analysis} />

        <section className="quantumToolsPanel">
          <header>
            <div>
              <small>VISIBLE ANALYSIS TOOLS</small>
              <h3>What Quantum AI is reading now</h3>
            </div>
            <strong>{analysis.entryMode || "WAIT"} LANE</strong>
          </header>

          <div className="quantumToolGrid">
            {[
              ["RSI 14", analysis.metrics?.rsi?.toFixed?.(1) ?? "â€”"],
              ["EMA 6", analysis.metrics?.fastEma?.toFixed?.(5) ?? "â€”"],
              ["EMA 14", analysis.metrics?.mediumEma?.toFixed?.(5) ?? "â€”"],
              ["EMA 30", analysis.metrics?.slowEma?.toFixed?.(5) ?? "â€”"],
              ["Fast slope", analysis.metrics?.fastSlope?.toFixed?.(6) ?? "â€”"],
              ["Medium slope", analysis.metrics?.mediumSlope?.toFixed?.(6) ?? "â€”"],
              ["Slow slope", analysis.metrics?.slowSlope?.toFixed?.(6) ?? "â€”"],
              ["Impulse", `${Number(analysis.metrics?.impulse || 0).toFixed(0)}%`],
              ["Trend strength", `${Number(analysis.metrics?.trendStrength || 0).toFixed(0)}%`],
              ["Vote consensus", `${Number(analysis.metrics?.voteConsensus || 0).toFixed(0)}%`],
              ["RISE votes", Number(analysis.votes?.rise || 0).toFixed(2)],
              ["FALL votes", Number(analysis.votes?.fall || 0).toFixed(2)],
              ["ROC 3", Number(analysis.metrics?.roc3 || 0).toFixed(5)],
              ["ROC 8", Number(analysis.metrics?.roc8 || 0).toFixed(5)],
              ["Acceleration", Number(analysis.metrics?.acceleration || 0).toFixed(6)],
              ["Z-score", Number(analysis.metrics?.zScore || 0).toFixed(2)],
              ["Entropy", `${Number(analysis.metrics?.entropy || 0).toFixed(0)}%`],
              ["Transition", `${Number(analysis.metrics?.transition || 0).toFixed(0)}%`],
              ["Reversal bias", `${Number(analysis.metrics?.reversalBias || 0).toFixed(0)}%`],
              ["Range position", `${Number(analysis.metrics?.rangePosition || 0).toFixed(0)}%`],
              ["Breakout", analysis.metrics?.breakout || "NONE"],
              ["Cycle 4", Number(analysis.metrics?.cycle4 || 0).toFixed(2)],
              ["Cycle 7", Number(analysis.metrics?.cycle7 || 0).toFixed(2)],
              ["Micro slope", Number(analysis.metrics?.microSlope || 0).toFixed(6)],
              ["Trend score", `${Number(analysis.scoreBreakdown?.trend || 0).toFixed(0)}/100`],
              ["Momentum score", `${Number(analysis.scoreBreakdown?.momentum || 0).toFixed(0)}/100`],
              ["Reversal score", `${Number(analysis.scoreBreakdown?.reversal || 0).toFixed(0)}/100`],
              ["Pattern score", `${Number(analysis.scoreBreakdown?.pattern || 0).toFixed(0)}/100`],
              ["Probability score", `${Number(analysis.scoreBreakdown?.probability || 0).toFixed(0)}/100`],
              ["AI total score", `${Number(analysis.scoreBreakdown?.total || 0).toFixed(1)}/100`],
            ].map(([label, value]) => (
              <article key={label}><span>{label}</span><strong>{value}</strong></article>
            ))}
          </div>

          <div className="quantumGateGrid">
            {(analysis.checks || []).map((check) => (
              <article key={check.label} className={check.passed ? "passed" : "failed"}>
                <span>{check.label}</span>
                <strong>{check.passed ? "PASS" : "WAIT"}</strong>
                <b>{check.value}</b>
              </article>
            ))}
          </div>
        </section>

        <section className={`quantumLossGuard ${adaptiveLossGuard.ready ? "ready" : "blocked"}`}>
          <header>
            <div>
              <small>ADAPTIVE LOSS MEMORY</small>
              <h3>Loss-aware market protection</h3>
            </div>
            <strong>{adaptiveLossGuard.ready ? "ENTRY ALLOWED" : "FILTERING"}</strong>
          </header>

          <div>
            <article><span>Last losing side</span><strong>{adaptiveLossGuard.lastLossDirection}</strong></article>
            <article><span>Same-side loss streak</span><strong>{adaptiveLossGuard.sameDirectionLossStreak}</strong></article>
            <article><span>Market loss streak</span><strong>{adaptiveLossGuard.marketLossStreak}</strong></article>
            <article><span>Session loss streak</span><strong>{adaptiveLossGuard.sessionLossStreak}</strong></article>
            <article><span>Opposite confirmation</span><strong>{adaptiveLossGuard.oppositeConfirmed ? "STRONG PASS" : "NOT CONFIRMED"}</strong></article>
          </div>

          <p>{adaptiveLossGuard.reason}</p>
        </section>        <section className={`quantumLossGuard ${minuteEntry.ready ? "ready" : "blocked"}`}>
          <header>
            <div>
              <small>ONE-MINUTE OPPORTUNITY ENGINE</small>
              <h3>Best acceptable entry deadline</h3>
            </div>
            <strong>
              {minuteEntry.ready
                ? "ENTRY READY"
                : `${Math.floor(minuteEntry.elapsedSeconds)}s`}
            </strong>
          </header>

          <div>
            <article><span>Candidate</span><strong>{minuteEntry.candidate}</strong></article>
            <article><span>Five-AI</span><strong>{minuteEntry.agreement}/5</strong></article>
            <article><span>Confidence</span><strong>{minuteEntry.confidence.toFixed(1)}%</strong></article>
            <article><span>Noise</span><strong>{minuteEntry.noise.toFixed(0)}%</strong></article>
            <article><span>Reversal</span><strong>{minuteEntry.reversal.toFixed(0)}%</strong></article>
          </div>

          <p>{minuteEntry.reason}</p>
        </section>

        <section className="quantumMessage">
          <strong>{message}</strong>
          {(tradeError || statusDetail || !authenticatedFeed) && (
            <span>
              {tradeError || statusDetail || (connected
                ? "Public analysis feed is connected. Reconnect the selected Demo/Real account for trading."
                : "Deriv feed is disconnected. Press Connect feed.")}
            </span>
          )}
        </section>

        <section className="quantumBottomGrid">
          <div className="quantumPanel">
            <header><div><small>LIVE EXECUTION</small><h3>Two-run monitor</h3></div><strong>{activeTrades.length} OPEN</strong></header>
            <div className="quantumTrades">
              {!activeTrades.length && <p>No open Quantum AI trades.</p>}
              {activeTrades.map((trade) => (
                <article key={trade.contractId}>
                  <div><strong>{trade.direction}</strong><span>{trade.market}</span></div>
                  <div><span>Confidence</span><strong>{trade.confidence.toFixed(1)}%</strong></div>
                  <div>
                    <span>Duration</span>
                    <strong>
                      {trade.displayDuration ||
                        `${trade.duration}${trade.durationUnit === "t" ? " ticks" : "s"}`}
                    </strong>
                  </div>
                  <div><span>Contract</span><strong>{trade.contractId}</strong></div>
                </article>
              ))}
            </div>
          </div>

          <div className="quantumPanel">
            <header><div><small>PERFORMANCE</small><h3>Current session</h3></div></header>
            <div className="quantumPerformance">
              <article><span>Runs</span><strong>{stats.runs}</strong></article>
              <article><span>Wins</span><strong>{stats.wins}</strong></article>
              <article><span>Losses</span><strong>{stats.losses}</strong></article>
              <article><span>P/L</span><strong className={stats.profit >= 0 ? "positive" : "negative"}>{money(stats.profit)}</strong></article>
            </div>
          </div>
        </section>

        <section className="quantumPanel quantumRanking">
          <header><div><small>MARKET MEMORY</small><h3>Recently scanned markets</h3></div></header>
          <div>
            {!rankedMarkets.length && <p>Market scores will appear after scanning.</p>}
            {rankedMarkets.map((item) => (
              <article key={item.symbol}>
                <strong>{item.label}</strong><span>{item.decision}</span><b>{item.confidence.toFixed(1)}%</b>
              </article>
            ))}
          </div>
        </section>

        <section className="quantumPanel quantumHistory">
          <header><div><small>TRADE JOURNAL</small><h3>Settled Quantum trades</h3></div></header>
          <div className="quantumHistoryTable">
            {!stats.history.length && <p>No settled trades yet.</p>}
            {stats.history.map((trade) => (
              <article key={`${trade.contractId}-${trade.settledAt}`}>
                <span>{trade.market}</span>
                <strong>{trade.direction}</strong>
                <span>
                  {trade.displayDuration ||
                    `${trade.duration}${trade.durationUnit === "t" ? " ticks" : "s"}`}
                </span>
                <b className={trade.result === "WON" ? "positive" : "negative"}>{trade.result}</b>
                <strong>{money(trade.profit)} USD</strong>
              </article>
            ))}
          </div>
        </section>

        <p className="quantumRiskNote">Trading carries risk. Quantum AI filters entries but cannot guarantee wins. Test on Demo before enabling Real execution.</p>
      </main>
    </div>
  );
}












