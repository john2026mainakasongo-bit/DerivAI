import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeHigherHigh } from "../analysis/higherHighEngine";
import "../styles/HigherHighBot.css";

const INITIAL_STATS = {
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  history: [],
};

function contractIdOf(value) {
  return String(
    value?.contractId ||
      value?.contract_id ||
      value?.buy?.contract_id ||
      value?.raw?.buy?.contract_id ||
      value?.raw?.data?.buy?.contract_id ||
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
      ["won", "lost", "sold", "expired", "settled"].includes(status)
  );
}

function profitOf(contract) {
  const direct = Number(
    contract?.profit ??
      contract?.profit_loss ??
      contract?.pnl
  );

  if (Number.isFinite(direct)) return direct;

  return (
    Number(contract?.sell_price ?? contract?.payout ?? 0) -
    Number(contract?.buy_price ?? contract?.purchase_price ?? 0)
  );
}

function number(value, digits = 4) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toFixed(digits)
    : "—";
}

function nextAvailableMarket(markets, symbol, blockedMarkets) {
  if (!Array.isArray(markets) || markets.length < 2) return null;

  const currentIndex = Math.max(
    0,
    markets.findIndex((item) => item.id === symbol)
  );

  for (let offset = 1; offset <= markets.length; offset += 1) {
    const candidate =
      markets[(currentIndex + offset) % markets.length];

    const blockedUntil = Number(
      blockedMarkets.get(candidate?.id) || 0
    );

    if (
      candidate?.id &&
      candidate.id !== symbol &&
      Date.now() >= blockedUntil
    ) {
      return candidate;
    }
  }

  return markets[(currentIndex + 1) % markets.length] || null;
}


function classifyLoss(trade = {}) {
  const snapshot = trade.entrySnapshot || {};
  const entropy = Number(snapshot.entropy18 || 0);
  const efficiency = Number(snapshot.efficiency28 || 0);
  const transition = Number(snapshot.transition || 0);
  const spike = Number(snapshot.spikeRatio || 0);
  const tf = Number(snapshot.timeframeAgreement || 0);
  const momentum3 = Number(snapshot.momentum3 || 0);
  const momentum5 = Number(snapshot.momentum5 || 0);
  const momentum12 = Number(snapshot.momentum12 || 0);

  if (spike > 1.35) {
    return {
      code: "SPIKE_REVERSAL",
      label: "Entry followed a stretched move and reversed.",
    };
  }

  if (entropy > 0.84) {
    return {
      code: "HIGH_NOISE",
      label: "Market was too random near entry.",
    };
  }

  if (efficiency < 0.32) {
    return {
      code: "LOW_EFFICIENCY",
      label: "Trend did not travel cleanly enough.",
    };
  }

  if (transition < 0.58) {
    return {
      code: "WEAK_CONTINUATION",
      label: "Continuation probability was marginal.",
    };
  }

  if (
    tf < 3 ||
    momentum3 <= 0 ||
    momentum5 <= 0 ||
    momentum12 <= 0
  ) {
    return {
      code: "MOMENTUM_BREAK",
      label: "Momentum alignment weakened around entry.",
    };
  }

  return {
    code: "EXPIRY_VARIANCE",
    label: "Qualified setup lost to short-term expiry variance.",
  };
}

export default function HigherHighBot() {
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
  const [message, setMessage] = useState(
    "Higher High AI PRO V7 is ready."
  );

  const [settings, setSettings] = useState({
    stake: 0.35,
    minimumConfidence: 78,
    minimumEfficiency: 0.22,
    maximumEntropy: 0.92,
    minimumTransition: 0.50,
    maximumSpikeRatio: 1.55,
    minimumTicks: 120,
    confirmationTicks: 3,
    duration: 10,
    durationUnit: "t",
    cooldownSeconds: 25,
    marketSwitchSeconds: 18,
    lossMarketBlockSeconds: 120,
    takeProfit: 3,
    stopLoss: 1.5,
    maxConsecutiveLosses: 2,
    minimumVoteScore: 78,
    minimumProbability: 54,
    maximumWaitSeconds: 120,
    fallbackStartSeconds: 105,
    fallbackVoteScore: 68,
    fallbackProbability: 51,
    fallbackMinimumVotes: 2,
    maximumMarketsPerCycle: 6,
    finalConfirmationSeconds: 12,
    learningEnabled: true,
    learningRate: 0.04,
    learningMinimumTrades: 8,
    recoveryEnabled: true,
    recoveryConfidenceBonus: 6,
    recoveryProbabilityMinimum: 60,
    recoveryConfirmationTicks: 4,
    recoveryCooldownSeconds: 45,
    recoveryStakeMultiplier: 1,
    maximumRecoveryAttempts: 1,
  });

  const [activeTrades, setActiveTrades] = useState([]);
  const [stats, setStats] = useState(INITIAL_STATS);
  const [readyStreak, setReadyStreak] = useState(0);
  const [forceMarketSwitch, setForceMarketSwitch] = useState(0);
  const [recovery, setRecovery] = useState({
    active: false,
    attempts: 0,
    previousLoss: null,
  });

  const [scanCycle, setScanCycle] = useState({
    startedAt: Date.now(),
    visited: [],
    candidates: {},
    deadlineStopped: false,
    finalCandidate: null,
    finalCandidateStartedAt: 0,
  });

  const [learningModel, setLearningModel] = useState(() => {
    try {
      const saved = window.localStorage.getItem(
        "higherHighV7LearningModel"
      );

      if (saved) {
        const parsed = JSON.parse(saved);

        return {
          trades: Number(parsed.trades || 0),
          wins: Number(parsed.wins || 0),
          losses: Number(parsed.losses || 0),
          weights: {
            trend: Number(parsed.weights?.trend || 1),
            momentum: Number(parsed.weights?.momentum || 1),
            volatility: Number(parsed.weights?.volatility || 1),
            pattern: Number(parsed.weights?.pattern || 1),
            transition: Number(parsed.weights?.transition || 1),
          },
        };
      }
    } catch {
      // Ignore invalid stored data.
    }

    return {
      trades: 0,
      wins: 0,
      losses: 0,
      weights: {
        trend: 1,
        momentum: 1,
        volatility: 1,
        pattern: 1,
        transition: 1,
      },
    };
  });

  const buyingRef = useRef(false);
  const lastTradeAtRef = useRef(0);
  const scanStartedAtRef = useRef(Date.now());
  const processedRef = useRef(new Set());
  const blockedMarketsRef = useRef(new Map());
  const deadlineHandledRef = useRef(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "higherHighV7LearningModel",
        JSON.stringify(learningModel)
      );
    } catch {
      // Storage may be unavailable in private browsing.
    }
  }, [learningModel]);

  const connecting =
    status === "CONNECTING" || loadingMarket;

  const analysis = useMemo(
    () =>
      analyzeHigherHigh(prices, {
        ...settings,
        learningWeights:
          settings.learningEnabled &&
          learningModel.trades >=
            Number(settings.learningMinimumTrades)
            ? learningModel.weights
            : null,
      }),
    [
      prices,
      settings,
      learningModel.trades,
      learningModel.weights,
    ]
  );

  const requiredHoldTicks = recovery.active
    ? Number(settings.recoveryConfirmationTicks)
    : Number(settings.confirmationTicks);

  const recoveryQualified =
    !recovery.active ||
    (
      analysis.confidence >=
        Number(settings.minimumConfidence) +
          Number(settings.recoveryConfidenceBonus) &&
      analysis.probability >=
        Number(settings.recoveryProbabilityMinimum)
    );

  const elapsedScanSeconds = Math.max(
    0,
    (Date.now() - Number(scanCycle.startedAt || Date.now())) / 1000
  );

  const fallbackWindow =
    elapsedScanSeconds >= Number(settings.fallbackStartSeconds);

  const fallbackSafe =
    !Boolean(analysis.metrics?.hardRiskBlock) &&
    Number(analysis.confidence || 0) >=
      Number(settings.fallbackVoteScore) &&
    Number(analysis.probability || 0) >=
      Number(settings.fallbackProbability) &&
    Number(analysis.metrics?.votePasses || 0) >=
      Number(settings.fallbackMinimumVotes) &&
    Number(analysis.metrics?.momentum3 || 0) > 0 &&
    Number(analysis.metrics?.momentum5 || 0) > 0 &&
    (
      Boolean(analysis.metrics?.higherHigh) ||
      Boolean(analysis.metrics?.higherLow) ||
      Boolean(analysis.metrics?.cleanBreakout)
    );

  const entrySignalReady =
    analysis.ready ||
    (fallbackWindow && fallbackSafe);

  const finalCandidateMatches =
    !scanCycle.finalCandidate ||
    scanCycle.finalCandidate.symbol === symbol;

  const confirmedReady =
    entrySignalReady &&
    recoveryQualified &&
    finalCandidateMatches &&
    readyStreak >= requiredHoldTicks;

  useEffect(() => {
    if (!running || !symbol) return;

    const candidate = {
      symbol,
      label: market?.label || symbol,
      score: Number(analysis.confidence || 0),
      probability: Number(analysis.probability || 0),
      votes: Number(analysis.metrics?.votePasses || 0),
      hardRiskBlock: Boolean(analysis.metrics?.hardRiskBlock),
      momentum3: Number(analysis.metrics?.momentum3 || 0),
      momentum5: Number(analysis.metrics?.momentum5 || 0),
      structure:
        Boolean(analysis.metrics?.higherHigh) ||
        Boolean(analysis.metrics?.higherLow) ||
        Boolean(analysis.metrics?.cleanBreakout),
      updatedAt: Date.now(),
    };

    setScanCycle((current) => ({
      ...current,
      visited: current.visited.includes(symbol)
        ? current.visited
        : [...current.visited, symbol],
      candidates: {
        ...current.candidates,
        [symbol]: candidate,
      },
    }));
  }, [
    running,
    symbol,
    market?.label,
    analysis.confidence,
    analysis.probability,
    analysis.metrics?.votePasses,
    analysis.metrics?.hardRiskBlock,
    analysis.metrics?.momentum3,
    analysis.metrics?.momentum5,
    analysis.metrics?.higherHigh,
    analysis.metrics?.higherLow,
    analysis.metrics?.cleanBreakout,
  ]);

  const consecutiveLosses = useMemo(() => {
    let losses = 0;

    for (const item of stats.history) {
      if (item.result !== "LOST") break;
      losses += 1;
    }

    return losses;
  }, [stats.history]);

  useEffect(() => {
    if (!running || !entrySignalReady) {
      setReadyStreak(0);
      return;
    }

    setReadyStreak((current) =>
      Math.min(
        requiredHoldTicks,
        current + 1
      )
    );
  }, [
    running,
    entrySignalReady,
    currentPrice,
    requiredHoldTicks,
    fallbackWindow,
    elapsedScanSeconds,
  ]);

  useEffect(() => {
    const all = [
      ...(openContracts || []),
      ...(transactions || []),
    ];

    const updates = [];

    for (const contract of all) {
      const id = contractIdOf(contract);

      if (
        !id ||
        !settled(contract) ||
        processedRef.current.has(id)
      ) {
        continue;
      }

      const original = activeTrades.find(
        (trade) => String(trade.contractId) === id
      );

      if (!original) continue;

      processedRef.current.add(id);

      const profit = profitOf(contract);
      const result = profit > 0 ? "WON" : "LOST";

      const exitPrice = Number(
        contract?.exit_tick ??
          contract?.exit_spot ??
          contract?.current_spot ??
          contract?.sell_spot ??
          NaN
      );

      updates.push({
        ...original,
        profit,
        result,
        exitPrice: Number.isFinite(exitPrice)
          ? exitPrice
          : null,
        settledAt: Date.now(),
      });

      if (settings.learningEnabled) {
        const snapshot = original.entrySnapshot || {};
        const won = result === "WON";
        const direction = won ? 1 : -1;
        const rate = Math.max(
          0.005,
          Math.min(0.12, Number(settings.learningRate))
        );

        const normalize = (value) =>
          Math.max(0, Math.min(1, Number(value || 0) / 100));

        const contributions = {
          trend: normalize(snapshot.trendScore),
          momentum: normalize(snapshot.momentumScore),
          volatility: normalize(snapshot.volatilityScore),
          pattern: normalize(snapshot.patternScore),
          transition: normalize(snapshot.transitionScore),
        };

        setLearningModel((current) => {
          const nextWeights = { ...current.weights };

          Object.entries(contributions).forEach(
            ([key, contribution]) => {
              const adjustment =
                direction *
                rate *
                Math.max(0.15, contribution);

              nextWeights[key] = Math.max(
                0.72,
                Math.min(
                  1.28,
                  Number(nextWeights[key] || 1) +
                    adjustment
                )
              );
            }
          );

          return {
            trades: current.trades + 1,
            wins: current.wins + (won ? 1 : 0),
            losses: current.losses + (won ? 0 : 1),
            weights: nextWeights,
          };
        });
      }

      if (result === "LOST") {
        const lossCause = classifyLoss(original);
        updates[updates.length - 1].lossCause = lossCause;

        blockedMarketsRef.current.set(
          original.symbol,
          Date.now() +
            Number(settings.lossMarketBlockSeconds) * 1000
        );

        if (
          settings.recoveryEnabled &&
          recovery.attempts <
            Number(settings.maximumRecoveryAttempts)
        ) {
          setRecovery({
            active: true,
            attempts: recovery.attempts + 1,
            previousLoss: {
              symbol: original.symbol,
              cause: lossCause,
              settledAt: Date.now(),
            },
          });
        } else {
          setRecovery({
            active: false,
            attempts: recovery.attempts,
            previousLoss: {
              symbol: original.symbol,
              cause: lossCause,
              settledAt: Date.now(),
            },
          });
        }

        setForceMarketSwitch((current) => current + 1);
      } else if (recovery.active) {
        setRecovery({
          active: false,
          attempts: 0,
          previousLoss: null,
        });
      }
    }

    if (!updates.length) return;

    setActiveTrades((current) =>
      current.filter(
        (trade) =>
          !updates.some(
            (done) =>
              String(done.contractId) ===
              String(trade.contractId)
          )
      )
    );

    setStats((current) => ({
      runs: current.runs,
      wins:
        current.wins +
        updates.filter((item) => item.result === "WON").length,
      losses:
        current.losses +
        updates.filter((item) => item.result === "LOST").length,
      profit:
        current.profit +
        updates.reduce(
          (sum, item) => sum + Number(item.profit || 0),
          0
        ),
      history: [
        ...updates.reverse(),
        ...current.history,
      ].slice(0, 50),
    }));
  }, [
    openContracts,
    transactions,
    activeTrades,
    settings.lossMarketBlockSeconds,
    settings.recoveryEnabled,
    settings.maximumRecoveryAttempts,
    recovery.active,
    recovery.attempts,
    settings.learningEnabled,
    settings.learningRate,
  ]);

  useEffect(() => {
    if (!activeTrades.length) return;

    const refresh = () =>
      activeTrades.forEach((trade) =>
        Promise.resolve(
          refreshContract(trade.contractId)
        ).catch(() => {})
      );

    refresh();

    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [activeTrades, refreshContract]);

  useEffect(() => {
    if (!running) return;

    if (stats.profit >= Number(settings.takeProfit)) {
      setRunning(false);
      setMessage(
        "Take Profit reached. Higher High AI stopped safely."
      );
    } else if (
      stats.profit <= -Math.abs(Number(settings.stopLoss))
    ) {
      setRunning(false);
      setMessage(
        "Stop Loss reached. Higher High AI stopped safely."
      );
    } else if (
      consecutiveLosses >=
      Number(settings.maxConsecutiveLosses)
    ) {
      setRunning(false);
      setMessage(
        "Maximum consecutive losses reached. Session stopped."
      );
    }
  }, [
    running,
    stats.profit,
    consecutiveLosses,
    settings,
  ]);

  useEffect(() => {
    if (
      !running ||
      !forceMarketSwitch ||
      activeTrades.length ||
      markets.length < 2 ||
      scanCycle.finalCandidate
    ) {
      return;
    }

    const next = nextAvailableMarket(
      markets,
      symbol,
      blockedMarketsRef.current
    );

    if (next?.id && next.id !== symbol) {
      scanStartedAtRef.current = Date.now();
      setReadyStreak(0);
      setMessage(
        `Previous ${symbol} trade lost. Blocking it temporarily and switching to ${next.label}.`
      );
      void changeSymbol(next.id);
    }
  }, [
    forceMarketSwitch,
    running,
    activeTrades.length,
    markets,
    symbol,
    changeSymbol,
  ]);

  useEffect(() => {
    if (
      !running ||
      confirmedReady ||
      activeTrades.length ||
      markets.length < 2
    ) {
      if (confirmedReady) {
        scanStartedAtRef.current = Date.now();
      }
      return;
    }

    const timer = window.setInterval(() => {
      if (
        Number(analysis.metrics?.ticksCollected || 0) <
        Number(settings.minimumTicks)
      ) {
        return;
      }

      if (
        scanCycle.visited.length >=
          Number(settings.maximumMarketsPerCycle) &&
        elapsedScanSeconds <
          Number(settings.fallbackStartSeconds)
      ) {
        return;
      }

      if (
        (Date.now() - scanStartedAtRef.current) / 1000 <
        Number(settings.marketSwitchSeconds)
      ) {
        return;
      }

      const next = nextAvailableMarket(
        markets,
        symbol,
        blockedMarketsRef.current
      );

      if (next?.id && next.id !== symbol) {
        scanStartedAtRef.current = Date.now();
        setReadyStreak(0);
        setMessage(
          `No V7 hard two-minute cycle setup after ${settings.marketSwitchSeconds}s. Switching to ${next.label}.`
        );
        void changeSymbol(next.id);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [
    running,
    confirmedReady,
    activeTrades.length,
    markets,
    symbol,
    analysis.metrics?.ticksCollected,
    settings.minimumTicks,
    settings.marketSwitchSeconds,
    settings.maximumMarketsPerCycle,
    settings.fallbackStartSeconds,
    scanCycle.visited.length,
    scanCycle.finalCandidate,
    elapsedScanSeconds,
    changeSymbol,
  ]);

  useEffect(() => {
    if (!running) return;

    const timer = window.setInterval(() => {
      const now = Date.now();
      const elapsed =
        (now - Number(scanCycle.startedAt || now)) / 1000;

      const finalCandidate = scanCycle.finalCandidate;
      const finalElapsed = finalCandidate
        ? (now -
            Number(scanCycle.finalCandidateStartedAt || now)) /
          1000
        : 0;

      if (
        finalCandidate &&
        finalElapsed >=
          Number(settings.finalConfirmationSeconds)
      ) {
        setRunning(false);
        setReadyStreak(0);
        setScanCycle((current) => ({
          ...current,
          deadlineStopped: true,
        }));
        setMessage(
          `Final candidate ${finalCandidate.label} failed live confirmation within ${settings.finalConfirmationSeconds}s. Bot stopped safely.`
        );
        return;
      }

      if (
        elapsed < Number(settings.maximumWaitSeconds) ||
        finalCandidate
      ) {
        return;
      }

      const candidates = Object.values(
        scanCycle.candidates || {}
      )
        .filter(
          (item) =>
            !item.hardRiskBlock &&
            item.momentum3 > 0 &&
            item.momentum5 > 0 &&
            item.structure &&
            now - Number(item.updatedAt || 0) <= 45000
        )
        .sort(
          (a, b) =>
            b.score +
              b.probability +
              b.votes * 4 -
            (a.score +
              a.probability +
              a.votes * 4)
        );

      const best = candidates[0];

      if (
        best &&
        best.score >=
          Number(settings.fallbackVoteScore) &&
        best.probability >=
          Number(settings.fallbackProbability) &&
        best.votes >=
          Number(settings.fallbackMinimumVotes)
      ) {
        deadlineHandledRef.current = true;

        setScanCycle((current) => ({
          ...current,
          finalCandidate: best,
          finalCandidateStartedAt: Date.now(),
        }));

        setMessage(
          `Two-minute deadline reached. Final live confirmation on ${best.label}: ${best.score}% score, ${best.probability}% probability.`
        );

        if (best.symbol !== symbol) {
          scanStartedAtRef.current = Date.now();
          setReadyStreak(0);
          void changeSymbol(best.symbol);
        }
      } else {
        setRunning(false);
        setReadyStreak(0);
        setScanCycle((current) => ({
          ...current,
          deadlineStopped: true,
        }));
        setMessage(
          "Two-minute deadline reached. No recent market passed the safety floor, so the bot stopped without forcing a trade."
        );
      }
    }, 400);

    return () => window.clearInterval(timer);
  }, [
    running,
    scanCycle.startedAt,
    scanCycle.candidates,
    scanCycle.finalCandidate,
    scanCycle.finalCandidateStartedAt,
    settings.maximumWaitSeconds,
    settings.finalConfirmationSeconds,
    settings.fallbackVoteScore,
    settings.fallbackProbability,
    settings.fallbackMinimumVotes,
    symbol,
    changeSymbol,
  ]);

  useEffect(() => {
    if (
      !running ||
      !confirmedReady ||
      activeTrades.length ||
      buyingRef.current ||
      tradeBusy
    ) {
      return;
    }

    if (!authenticatedFeed) {
      setMessage(
        "Log in, select Demo/Real, then reconnect the authenticated Deriv feed."
      );
      return;
    }

    const blockedUntil = Number(
      blockedMarketsRef.current.get(symbol) || 0
    );

    if (Date.now() < blockedUntil) {
      setMessage(
        `${symbol} remains blocked after its previous loss.`
      );
      setForceMarketSwitch((current) => current + 1);
      return;
    }

    const cooldown =
      Number(
        recovery.active
          ? settings.recoveryCooldownSeconds
          : settings.cooldownSeconds
      ) * 1000;

    if (
      Date.now() - lastTradeAtRef.current <
      cooldown
    ) {
      return;
    }

    buyingRef.current = true;

    void (async () => {
      try {
        setMessage(
          `${recovery.active ? "Recovery" : fallbackWindow && !analysis.ready ? "Two-minute fallback" : "Normal"} signal held ${readyStreak}/${requiredHoldTicks} ticks. Buying HIGHER at ${analysis.confidence}% score and ${analysis.probability}% probability.`
        );

        const response = await placeTrade({
          contractType: "CALL",
          amount: Math.max(
            0.35,
            Number(settings.stake) *
              Math.min(
                1.15,
                Math.max(
                  0.5,
                  recovery.active
                    ? Number(settings.recoveryStakeMultiplier)
                    : 1
                )
              )
          ),
          basis: "stake",
          duration: Number(settings.duration),
          durationUnit: settings.durationUnit,
          symbol,
        });

        const contractId = contractIdOf(response);

        if (!contractId) {
          throw new Error(
            "Deriv did not return a contract ID."
          );
        }

        const metrics = analysis.metrics || {};

        const trade = {
          contractId,
          symbol,
          market: market?.label || symbol,
          direction: "HIGHER",
          confidence: analysis.confidence,
          probability: analysis.probability,
          stake: Number(settings.stake),
          entryPrice: currentPrice,
          duration: Number(settings.duration),
          durationUnit: settings.durationUnit,
          recoveryTrade: recovery.active,
          recoveryAttempt: recovery.attempts,
          fallbackTrade: fallbackWindow && !analysis.ready,
          scanElapsedSeconds: elapsedScanSeconds,
          openedAt: Date.now(),
          entrySnapshot: {
            regime: analysis.regime,
            structure: analysis.structure,
            pullback: analysis.pullback,
            transition: Number(
              metrics.transitionProbability || 0
            ),
            entropy18: Number(metrics.entropy18 || 0),
            entropy36: Number(metrics.entropy36 || 0),
            efficiency12: Number(
              metrics.efficiency12 || 0
            ),
            efficiency28: Number(
              metrics.efficiency28 || 0
            ),
            timeframeAgreement: Number(
              metrics.timeframeAgreement || 0
            ),
            momentum3: Number(metrics.momentum3 || 0),
            momentum5: Number(metrics.momentum5 || 0),
            momentum12: Number(
              metrics.momentum12 || 0
            ),
            spikeRatio: Number(metrics.spikeRatio || 0),
            trendScore: Number(metrics.trendScore || 0),
            momentumScore: Number(metrics.momentumScore || 0),
            volatilityScore: Number(metrics.volatilityScore || 0),
            patternScore: Number(metrics.patternScore || 0),
            transitionScore: Number(metrics.transitionScore || 0),
            learnedWeights: { ...learningModel.weights },
          },
        };

        lastTradeAtRef.current = Date.now();
        setReadyStreak(0);
        setActiveTrades([trade]);
        setScanCycle({
          startedAt: Date.now(),
          visited: [symbol],
          candidates: {},
          deadlineStopped: false,
          finalCandidate: null,
          finalCandidateStartedAt: 0,
        });
        deadlineHandledRef.current = false;
        setStats((current) => ({
          ...current,
          runs: current.runs + 1,
        }));

        setMessage(
          `Trade ${contractId} opened for ${settings.duration} ticks. Waiting for settlement.`
        );
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "Unable to place Higher trade."
        );
      } finally {
        buyingRef.current = false;
      }
    })();
  }, [
    running,
    confirmedReady,
    readyStreak,
    activeTrades.length,
    tradeBusy,
    authenticatedFeed,
    settings,
    placeTrade,
    symbol,
    market?.label,
    currentPrice,
    analysis,
    recovery.active,
    recovery.attempts,
    requiredHoldTicks,
  ]);

  async function startBot() {
    if (!connected) {
      try {
        setMessage(
          "Connecting Higher High AI to Deriv..."
        );
        await connect();
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "Connection failed."
        );
        return;
      }
    }

    scanStartedAtRef.current = Date.now();
    deadlineHandledRef.current = false;
    setScanCycle({
      startedAt: Date.now(),
      visited: symbol ? [symbol] : [],
      candidates: {},
      deadlineStopped: false,
      finalCandidate: null,
      finalCandidateStartedAt: 0,
    });
    setReadyStreak(0);
    setRunning(true);
    setMessage(
      "V6 started a two-minute scan cycle. It will use the best safe market found, but will stop rather than force an unsafe trade."
    );
  }

  const winRate =
    stats.wins + stats.losses
      ? (stats.wins /
          (stats.wins + stats.losses)) *
        100
      : 0;

  const metrics = analysis.metrics || {};

  return (
    <div className="appShell hhShell">
      <Sidebar />

      <main className="mainContent hhPage">
        <Topbar
          title="Higher High AI PRO V7"
          subtitle="Hard 2-minute cycle · adaptive learning · best-safe setup · CALL execution"
          connected={connected}
          connecting={connecting}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section
          className={`hhHero ${
            running ? "running" : ""
          }`}
        >
          <div>
            <small>STRICT CONFIRMATION BOT</small>
            <h1>Higher High AI PRO V7</h1>
            <p>
              Scans several markets for a hard two-minute cycle, learns from settled
              entries and stops if the final live candidate cannot confirm.
            </p>
          </div>

          <div className="hhHeroStatus">
            <span>
              {running ? "RUNNING" : "STOPPED"}
            </span>
            <strong>
              {confirmedReady
                ? "CONFIRMED"
                : analysis.decision}
            </strong>
          </div>
        </section>

        <section className="hhToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            onChange={changeSymbol}
            disabled={
              loadingMarket ||
              running ||
              activeTrades.length > 0
            }
          />

          <div className="hhAccount">
            <span>ACCOUNT</span>
            <strong>
              {selectedAccountType || "Not selected"}
            </strong>
          </div>

          <button
            className="hhStart"
            onClick={startBot}
            disabled={running || connecting}
          >
            Start
          </button>

          <button
            className="hhStop"
            onClick={() => {
              setRunning(false);
              setReadyStreak(0);
              setMessage(
                "Bot stopped. Open contract will settle normally."
              );
            }}
            disabled={!running}
          >
            Stop
          </button>

          <button
            className="hhReset"
            onClick={() => {
              if (!running && !activeTrades.length) {
                setStats(INITIAL_STATS);
                processedRef.current.clear();
                blockedMarketsRef.current.clear();
                setReadyStreak(0);
                setMessage("Session reset.");
              }
            }}
            disabled={
              running || activeTrades.length > 0
            }
          >
            Reset
          </button>
        </section>

        <section
          className={`hhDecision ${
            confirmedReady
              ? "ready"
              : analysis.decision === "WATCH"
              ? "watch"
              : ""
          }`}
        >
          <div>
            <small>AI DECISION</small>
            <h2>
              {confirmedReady
                ? "BUY HIGHER"
                : analysis.decision}
            </h2>
            <p>{analysis.reason}</p>
          </div>

          <div className="hhDecisionGrid">
            <article>
              <span>Confidence</span>
              <strong>{analysis.confidence}%</strong>
            </article>

            <article>
              <span>Vote gate</span>
              <strong>
                {settings.minimumVoteScore}%
              </strong>
            </article>

            <article>
              <span>Probability</span>
              <strong>{analysis.probability}%</strong>
            </article>

            <article>
              <span>Signal hold</span>
              <strong>
                {readyStreak}/
                {requiredHoldTicks}
              </strong>
            </article>

            <article>
              <span>Regime</span>
              <strong>{analysis.regime}</strong>
            </article>

            <article>
              <span>Scan timer</span>
              <strong>
                {Math.min(
                  Number(settings.maximumWaitSeconds),
                  Math.floor(elapsedScanSeconds)
                )}s / {settings.maximumWaitSeconds}s
              </strong>
            </article>

            <article>
              <span>Entry mode</span>
              <strong>
                {scanCycle.finalCandidate
                  ? "FINAL CONFIRM"
                  : fallbackWindow
                  ? "FALLBACK SAFE"
                  : "NORMAL"}
              </strong>
            </article>

            <article>
              <span>Recovery</span>
              <strong>
                {recovery.active
                  ? `ACTIVE ${recovery.attempts}/${settings.maximumRecoveryAttempts}`
                  : "OFF"}
              </strong>
            </article>

            <article>
              <span>Learning</span>
              <strong>
                {settings.learningEnabled
                  ? `${learningModel.trades} trades`
                  : "OFF"}
              </strong>
            </article>

            <article>
              <span>Model rate</span>
              <strong>
                {learningModel.trades
                  ? `${(
                      (learningModel.wins /
                        learningModel.trades) *
                      100
                    ).toFixed(1)}%`
                  : "0.0%"}
              </strong>
            </article>

            <article>
              <span>Price</span>
              <strong>
                {number(
                  currentPrice,
                  market?.decimals ?? 3
                )}
              </strong>
            </article>
          </div>
        </section>

        <section className="hhSettings">
          {[
            ["Stake", "stake", 0.01],
            ["Confidence", "minimumConfidence", 1],
            ["Min efficiency", "minimumEfficiency", 0.01],
            ["Max entropy", "maximumEntropy", 0.01],
            ["Min transition", "minimumTransition", 0.01],
            ["Max spike", "maximumSpikeRatio", 0.01],
            ["Min ticks", "minimumTicks", 1],
            ["Confirm ticks", "confirmationTicks", 1],
            ["Duration", "duration", 1],
            ["Cooldown sec", "cooldownSeconds", 1],
            ["Switch sec", "marketSwitchSeconds", 1],
            ["Loss block sec", "lossMarketBlockSeconds", 1],
            ["Recovery +conf", "recoveryConfidenceBonus", 1],
            ["Recovery prob", "recoveryProbabilityMinimum", 1],
            ["Recovery hold", "recoveryConfirmationTicks", 1],
            ["Recovery cooldown", "recoveryCooldownSeconds", 1],
            ["Recovery stake x", "recoveryStakeMultiplier", 0.05],
            ["Vote score", "minimumVoteScore", 1],
            ["Min probability", "minimumProbability", 1],
            ["Max wait sec", "maximumWaitSeconds", 1],
            ["Fallback start", "fallbackStartSeconds", 1],
            ["Fallback score", "fallbackVoteScore", 1],
            ["Fallback prob", "fallbackProbability", 1],
            ["Fallback votes", "fallbackMinimumVotes", 1],
            ["Markets/cycle", "maximumMarketsPerCycle", 1],
            ["Final confirm sec", "finalConfirmationSeconds", 1],
            ["Learning rate", "learningRate", 0.01],
            ["Learn after", "learningMinimumTrades", 1],
          ].map(([label, key, step]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="number"
                step={step}
                value={settings[key]}
                disabled={running}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    [key]: Number(event.target.value),
                  }))
                }
              />
            </label>
          ))}
        </section>

        <section className="hhMetrics">
          <article>
            <span>EMA 9</span>
            <strong>{number(metrics.fastEma)}</strong>
          </article>
          <article>
            <span>EMA 21</span>
            <strong>{number(metrics.mediumEma)}</strong>
          </article>
          <article>
            <span>EMA 50</span>
            <strong>{number(metrics.slowEma)}</strong>
          </article>
          <article>
            <span>Momentum 3</span>
            <strong>{number(metrics.momentum3, 5)}</strong>
          </article>
          <article>
            <span>Momentum 5</span>
            <strong>{number(metrics.momentum5, 5)}</strong>
          </article>
          <article>
            <span>Momentum 12</span>
            <strong>{number(metrics.momentum12, 5)}</strong>
          </article>
          <article>
            <span>Efficiency 28</span>
            <strong>{number(metrics.efficiency28, 2)}</strong>
          </article>
          <article>
            <span>Spike ratio</span>
            <strong>{number(metrics.spikeRatio, 2)}</strong>
          </article>
        </section>

        <section className="hhAdaptiveStrip">
          <article>
            <span>Micro up</span>
            <strong>
              {number(
                Number(metrics.microUpRatio || 0) * 100,
                0
              )}
              %
            </strong>
          </article>

          <article>
            <span>Short up</span>
            <strong>
              {number(
                Number(metrics.shortUpRatio || 0) * 100,
                0
              )}
              %
            </strong>
          </article>

          <article>
            <span>Medium up</span>
            <strong>
              {number(
                Number(metrics.mediumUpRatio || 0) * 100,
                0
              )}
              %
            </strong>
          </article>

          <article>
            <span>TF agreement</span>
            <strong>
              {metrics.timeframeAgreement || 0}/3
            </strong>
          </article>

          <article>
            <span>Transition up</span>
            <strong>
              {number(
                Number(
                  metrics.transitionProbability || 0
                ) * 100,
                0
              )}
              %
            </strong>
          </article>

          <article>
            <span>Entropy 18</span>
            <strong>
              {number(metrics.entropy18, 2)}
            </strong>
          </article>

          <article>
            <span>Entropy 36</span>
            <strong>
              {number(metrics.entropy36, 2)}
            </strong>
          </article>

          <article>
            <span>Ticks</span>
            <strong>
              {metrics.ticksCollected || 0}
            </strong>
          </article>

          <article>
            <span>Trend AI</span>
            <strong>{metrics.trendScore || 0}%</strong>
          </article>

          <article>
            <span>Momentum AI</span>
            <strong>{metrics.momentumScore || 0}%</strong>
          </article>

          <article>
            <span>Volatility AI</span>
            <strong>{metrics.volatilityScore || 0}%</strong>
          </article>

          <article>
            <span>Pattern AI</span>
            <strong>{metrics.patternScore || 0}%</strong>
          </article>

          <article>
            <span>Risk penalty</span>
            <strong>{metrics.riskPenalty || 0}</strong>
          </article>

          <article>
            <span>Votes passed</span>
            <strong>{metrics.votePasses || 0}/5</strong>
          </article>
        </section>

        <section className="hhLearning">
          <article>
            <span>Trend weight</span>
            <strong>{Number(learningModel.weights.trend).toFixed(2)}</strong>
          </article>
          <article>
            <span>Momentum weight</span>
            <strong>{Number(learningModel.weights.momentum).toFixed(2)}</strong>
          </article>
          <article>
            <span>Volatility weight</span>
            <strong>{Number(learningModel.weights.volatility).toFixed(2)}</strong>
          </article>
          <article>
            <span>Pattern weight</span>
            <strong>{Number(learningModel.weights.pattern).toFixed(2)}</strong>
          </article>
          <article>
            <span>Transition weight</span>
            <strong>{Number(learningModel.weights.transition).toFixed(2)}</strong>
          </article>
        </section>

        <section className="hhChecks">
          {(analysis.checks || []).map((check) => (
            <article
              key={check.label}
              className={
                check.passed ? "passed" : "failed"
              }
            >
              <span>{check.label}</span>
              <strong>
                {check.passed ? "PASS" : "WAIT"}
              </strong>
              <b>{check.weight} pts</b>
            </article>
          ))}
        </section>

        <section className="hhMessage">
          <strong>{message}</strong>
          {statusDetail || tradeError ? (
            <span>
              {statusDetail || tradeError}
            </span>
          ) : null}
        </section>

        <section className="hhBottom">
          <div className="hhPanel">
            <header>
              <div>
                <small>PERFORMANCE</small>
                <h3>Session statistics</h3>
              </div>
            </header>

            <div className="hhPerformance">
              <article>
                <span>Runs</span>
                <strong>{stats.runs}</strong>
              </article>
              <article>
                <span>Wins</span>
                <strong className="positive">
                  {stats.wins}
                </strong>
              </article>
              <article>
                <span>Losses</span>
                <strong className="negative">
                  {stats.losses}
                </strong>
              </article>
              <article>
                <span>Win rate</span>
                <strong>{winRate.toFixed(1)}%</strong>
              </article>
              <article>
                <span>P/L</span>
                <strong
                  className={
                    stats.profit >= 0
                      ? "positive"
                      : "negative"
                  }
                >
                  {stats.profit.toFixed(2)}
                </strong>
              </article>
              <article>
                <span>Open</span>
                <strong>{activeTrades.length}</strong>
              </article>
            </div>
          </div>

          <div className="hhPanel">
            <header>
              <div>
                <small>ENTRY AUDIT</small>
                <h3>Trade journal</h3>
              </div>
            </header>

            <div className="hhHistory hhHistoryV3">
              {stats.history.length ? (
                stats.history.slice(0, 8).map((item) => {
                  const snapshot =
                    item.entrySnapshot || {};

                  return (
                    <article
                      key={`${item.contractId}-${item.settledAt}`}
                    >
                      <div>
                        <strong>{item.market}</strong>
                        <small>
                          {item.recoveryTrade
                            ? "RECOVERY · "
                            : item.fallbackTrade
                            ? "2-MIN FALLBACK · "
                            : ""}
                          C {item.confidence}% · P{" "}
                          {item.probability}% · TF{" "}
                          {snapshot.timeframeAgreement || 0}/3
                        </small>
                      </div>

                      <div>
                        <span>
                          Ent{" "}
                          {number(snapshot.entropy18, 2)} ·
                          Eff{" "}
                          {number(snapshot.efficiency28, 2)}
                        </span>
                        <small>
                          Tr{" "}
                          {number(
                            Number(snapshot.transition || 0) *
                              100,
                            0
                          )}
                          % · Spike{" "}
                          {number(snapshot.spikeRatio, 2)}
                        </small>
                        {item.lossCause ? (
                          <small className="hhLossCause">
                            {item.lossCause.code}:{" "}
                            {item.lossCause.label}
                          </small>
                        ) : null}
                      </div>

                      <span>{item.result}</span>

                      <b
                        className={
                          item.profit >= 0
                            ? "positive"
                            : "negative"
                        }
                      >
                        {Number(item.profit).toFixed(2)}
                      </b>
                    </article>
                  );
                })
              ) : (
                <p>No settled Higher trades yet.</p>
              )}
            </div>
          </div>
        </section>

        <p className="hhRisk">
          Demo test first. V4 diagnoses losses and uses one safe recovery attempt but cannot
          guarantee a fixed win rate.
        </p>
      </main>
    </div>
  );
}
