import { evaluateAnalysisAssistedSignal } from "../analysis/analysisAssistedGate";
import { evaluateSyntheticSetup } from "../analysis/syntheticIntelligenceEngine";

const DEFAULTS = {
  maxRuns: 56,
  minConfidence: 75,
  minVotes: 1,
  stake: 1,
  duration: 5,
  delaySeconds: 5,
  takeProfit: 20,
  stopLoss: 6,
  cooldownAfterLosses: 1,
  cooldownSeconds: 45,
  hardStopLossStreak: 3,
  martingaleEnabled: false,
  maxMartingaleSteps: 1,
  recoveryMultipliers: [1.35],
  analysisAssisted: true,
  contractMode: "AUTO",
  prediction: 2,
  durationUnit: "t",
  confirmationCount: 1,
  confirmationSeconds: 1,
  signalMaxAgeSeconds: 6,
  lossSetupBlockSeconds: 90,
  minimumTradeGapSeconds: 5,
  deepMinimumScore: 70,
  deepOverrideScore: 90,
};

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function durationText(duration, durationUnit) {
  const value = Math.max(1, number(duration, 1));
  return `${value} ${durationUnit === "s" ? "seconds" : "ticks"}`;
}

function normalizeContractMode(value = "AUTO") {
  const mode = String(value || "AUTO").trim().toUpperCase();
  const allowed = new Set([
    "AUTO",
    "RISE",
    "FALL",
    "EVEN",
    "ODD",
    "OVER",
    "UNDER",
    "MATCH",
    "DIFFERS",
  ]);

  return allowed.has(mode) ? mode : "AUTO";
}

function contractFromSetup(setup = "") {
  const value = String(setup).toUpperCase();

  if (value.includes("RISE")) {
    return { contractType: "CALL", barrier: undefined, label: "RISE" };
  }

  if (value.includes("FALL")) {
    return { contractType: "PUT", barrier: undefined, label: "FALL" };
  }

  if (value.includes("OVER")) {
    const match = value.match(/OVER\s*(\d)/);
    return {
      contractType: "DIGITOVER",
      barrier: match?.[1] || "2",
      label: `OVER ${match?.[1] || "2"}`,
    };
  }

  if (value.includes("UNDER")) {
    const match = value.match(/UNDER\s*(\d)/);
    return {
      contractType: "DIGITUNDER",
      barrier: match?.[1] || "2",
      label: `UNDER ${match?.[1] || "2"}`,
    };
  }

  if (value.includes("EVEN")) {
    return { contractType: "DIGITEVEN", barrier: undefined, label: "EVEN" };
  }

  if (value.includes("ODD")) {
    return { contractType: "DIGITODD", barrier: undefined, label: "ODD" };
  }

  if (value.includes("MATCH")) {
    const match = value.match(/MATCH\s*(\d)/);
    return {
      contractType: "DIGITMATCH",
      barrier: match?.[1] || "0",
      label: `MATCH ${match?.[1] || "0"}`,
    };
  }

  if (value.includes("DIFFERS")) {
    const match = value.match(/DIFFERS\s*(\d)/);
    return {
      contractType: "DIGITDIFF",
      barrier: match?.[1] || "0",
      label: `DIFFERS ${match?.[1] || "0"}`,
    };
  }

  return null;
}

function isFinished(contract = {}) {
  const status = String(contract.status || "").toLowerCase();

  return Boolean(
    contract.is_sold ||
      contract.is_expired ||
      contract.is_settleable === false ||
      ["sold", "won", "lost", "expired", "cancelled"].includes(status)
  );
}

function contractProfit(contract = {}) {
  const value = Number(
    contract.profit ??
      contract.profit_loss ??
      contract.pnl ??
      contract.sell_price - contract.buy_price
  );

  return Number.isFinite(value) ? value : 0;
}

function contractNumber(contract = {}, keys = [], fallback = 0) {
  for (const key of keys) {
    const value = Number(contract?.[key]);

    if (Number.isFinite(value)) {
      return value;
    }
  }

  return fallback;
}

function contractDetails(contract = {}, bought = {}) {
  const buy = bought?.buy || {};
  const proposal = bought?.proposal || {};

  const buyPrice = contractNumber(
    contract,
    ["buy_price", "purchase_price", "stake"],
    contractNumber(buy, ["buy_price", "price"], contractNumber(proposal, ["ask_price"], 0))
  );

  const sellPrice = contractNumber(
    contract,
    ["sell_price", "payout", "bid_price"],
    0
  );

  return {
    buyPrice,
    sellPrice,
    payout: contractNumber(contract, ["payout", "sell_price"], sellPrice),
    entrySpot: contractNumber(
      contract,
      ["entry_spot", "entry_tick", "entry_value"],
      contractNumber(buy, ["start_spot"], 0)
    ),
    exitSpot: contractNumber(
      contract,
      ["exit_spot", "exit_tick", "current_spot", "sell_spot"],
      0
    ),
  };
}


function smartRecoveryMultiplier(step, schedule = DEFAULTS.recoveryMultipliers) {
  const safeStep = Math.max(1, Math.floor(number(step, 1)));
  const values = (Array.isArray(schedule) ? schedule : DEFAULTS.recoveryMultipliers)
    .map((value) => Math.max(1, number(value, 1)))
    .filter(Number.isFinite);

  if (!values.length) {
    return 1;
  }

  return values[Math.min(safeStep - 1, values.length - 1)];
}

function normalizeSetup(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function validationAction(row = {}) {
  return normalizeSetup(row?.action || row?.candidate || row?.setup || "WAIT");
}

function isDigitContract(contract = {}) {
  return String(contract?.contractType || "").startsWith("DIGIT");
}

export default class DerivBotEngine {
  constructor({ client, onState }) {
    this.client = client;
    this.onState = typeof onState === "function" ? onState : () => {};

    this.settings = { ...DEFAULTS };
    this.signal = null;
    this.symbol = "";
    this.currency = "USD";

    this.running = false;
    this.paused = false;
    this.stopping = false;
    this.activeContractId = "";

    this.signalUpdatedAt = 0;
    this.pendingSetupKey = "";
    this.pendingSignalCount = 0;
    this.pendingSignalSince = 0;
    this.pendingSignalVersion = 0;
    this.blockedSetups = new Map();
    this.lastTradeAt = 0;
    this.lastLossSetup = "";

    this.state = {
      status: "IDLE",
      message: "Bot is ready.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      totalStake: 0,
      totalPayout: 0,
      completedAt: 0,
      stopReason: "",
      consecutiveLosses: 0,
      lossesSinceWin: 0,
      cooldownUntil: 0,
      cooldownCount: 0,
      currentWinStreak: 0,
      largestWinStreak: 0,
      largestLossStreak: 0,
      martingaleStep: 0,
      currentStake: DEFAULTS.stake,
      activeSetup: "—",
      activeContractId: "",
      scanStartedAt: 0,
      scanElapsedSeconds: 0,
      lastBlockReason: "",
      fallbackTrades: 0,
      signalConfirmations: 0,
      requiredConfirmations: DEFAULTS.confirmationCount,
      blockedSetupUntil: 0,
      lastLossSetup: "—",
      lossProtectionCount: 0,
      deepScore: 0,
      deepConsensus: 0,
      deepRegime: "UNKNOWN",
      cyclePeriod: 0,
      fastLane: false,
      history: [],
    };

    this.removeContractListener = this.client.onContract((contract) => {
      this.handleContractUpdate(contract);
    });

    this.contractWaiters = new Map();
  }

  destroy() {
    this.stop("Bot page closed.");

    if (this.removeContractListener) {
      this.removeContractListener();
      this.removeContractListener = null;
    }
  }

  configure(input = {}) {
    const durationUnit = input.durationUnit === "s" ? "s" : "t";
    const durationMin = durationUnit === "s" ? 15 : 1;
    const durationMax = durationUnit === "s" ? 3600 : 10;

    this.settings = {
      ...DEFAULTS,
      ...input,
      maxRuns: Math.max(1, Math.min(1000, number(input.maxRuns, 56))),
      minConfidence: Math.max(
        60,
        Math.min(95, number(input.minConfidence, DEFAULTS.minConfidence))
      ),
      minVotes: 1,
      stake: Math.max(0.35, number(input.stake, 1)),
      contractMode: normalizeContractMode(input.contractMode),
      prediction: Math.max(
        0,
        Math.min(9, Math.floor(number(input.prediction, 2)))
      ),
      durationUnit,
      duration: Math.max(
        durationMin,
        Math.min(
          durationMax,
          number(input.duration, durationUnit === "s" ? 30 : 5)
        )
      ),
      delaySeconds: Math.max(
        0,
        Math.min(60, number(input.delaySeconds, DEFAULTS.delaySeconds))
      ),
      takeProfit: Math.max(0, number(input.takeProfit, DEFAULTS.takeProfit)),
      stopLoss: Math.max(0, number(input.stopLoss, DEFAULTS.stopLoss)),
      cooldownAfterLosses: Math.max(
        1,
        Math.min(10, number(input.cooldownAfterLosses, DEFAULTS.cooldownAfterLosses))
      ),
      cooldownSeconds: Math.max(
        10,
        Math.min(900, number(input.cooldownSeconds, DEFAULTS.cooldownSeconds))
      ),
      hardStopLossStreak: Math.max(
        2,
        Math.min(20, number(input.hardStopLossStreak, DEFAULTS.hardStopLossStreak))
      ),
      maxMartingaleSteps: Math.max(
        0,
        Math.min(3, number(input.maxMartingaleSteps, DEFAULTS.maxMartingaleSteps))
      ),
      recoveryMultipliers: DEFAULTS.recoveryMultipliers,
      confirmationCount: Math.max(
        2,
        Math.min(6, number(input.confirmationCount, DEFAULTS.confirmationCount))
      ),
      confirmationSeconds: Math.max(
        1,
        Math.min(10, number(input.confirmationSeconds, DEFAULTS.confirmationSeconds))
      ),
      signalMaxAgeSeconds: Math.max(
        3,
        Math.min(30, number(input.signalMaxAgeSeconds, DEFAULTS.signalMaxAgeSeconds))
      ),
      lossSetupBlockSeconds: Math.max(
        30,
        Math.min(900, number(input.lossSetupBlockSeconds, DEFAULTS.lossSetupBlockSeconds))
      ),
      minimumTradeGapSeconds: Math.max(
        3,
        Math.min(60, number(input.minimumTradeGapSeconds, DEFAULTS.minimumTradeGapSeconds))
      ),
      deepMinimumScore: Math.max(
        55,
        Math.min(95, number(input.deepMinimumScore, DEFAULTS.deepMinimumScore))
      ),
      deepOverrideScore: Math.max(
        70,
        Math.min(99, number(input.deepOverrideScore, DEFAULTS.deepOverrideScore))
      ),
      analysisAssisted:
        input.analysisAssisted === undefined
          ? true
          : Boolean(input.analysisAssisted),
    };

    if (!this.running) {
      this.patch({ currentStake: this.settings.stake });
    }
  }

  setMarket({ symbol, currency = "USD" }) {
    const nextSymbol = String(symbol || "");
    const changed = Boolean(this.symbol && nextSymbol && this.symbol !== nextSymbol);

    this.symbol = nextSymbol;
    this.currency = String(currency || "USD");

    if (changed) {
      // Never carry an approved signal from the previous market into the new one.
      this.signal = null;
      this.signalUpdatedAt = 0;
      this.pendingSetupKey = "";
      this.pendingSignalCount = 0;
      this.pendingSignalSince = 0;
      this.pendingSignalVersion = 0;
    }
  }

  updateSignal(signal) {
    this.signal = signal;
    this.signalUpdatedAt = Number(signal?.updatedAt || Date.now());
  }

  snapshot() {
    return { ...this.state };
  }

  patch(next) {
    this.state = {
      ...this.state,
      ...next,
    };

    this.onState(this.snapshot());
  }

  addHistory(item) {
    this.patch({
      history: [item, ...this.state.history].slice(0, 100),
    });
  }

  validSignal() {
    const signal = this.signal;

    if (!signal) {
      return {
        ok: false,
        reason: "Waiting for fresh market analysis.",
        elapsedSeconds: 0,
        confirmations: 0,
      };
    }

    if (signal.symbol && this.symbol && String(signal.symbol) !== this.symbol) {
      return {
        ok: false,
        reason: "Market changed. Waiting for analysis from the selected market.",
        elapsedSeconds: 0,
        confirmations: 0,
      };
    }

    const ageMilliseconds = Date.now() - Number(
      signal.updatedAt || this.signalUpdatedAt || 0
    );

    if (
      !Number.isFinite(ageMilliseconds) ||
      ageMilliseconds > this.settings.signalMaxAgeSeconds * 1000
    ) {
      return {
        ok: false,
        reason: "Analysis is stale. Waiting for a fresh tick.",
        elapsedSeconds: 0,
        confirmations: 0,
      };
    }

    if (this.settings.analysisAssisted === false) {
      return {
        ok: false,
        reason: "Analysis Assisted is disabled.",
        elapsedSeconds: 0,
        confirmations: 0,
      };
    }

    const analysis = signal.analysis || {};
    const intelligence = signal.syntheticIntelligence || {};
    let gate = evaluateAnalysisAssistedSignal(analysis, {
      minimumConfidence: this.settings.minConfidence,
      contractMode: this.settings.contractMode,
      prediction: this.settings.prediction,
      durationUnit: this.settings.durationUnit,
    });

    /*
     * V19_2_DEMO_EXECUTION_BRIDGE
     *
     * Demo-only fallback. The dashboard was finding strong candidates while
     * the strict execution gate stayed WAIT because entropy/regime filters
     * rejected every setup. After a short scan period, this bridge permits
     * the best non-random candidate to enter on DEMO only.
     *
     * Real accounts are never allowed through this fallback.
     */
    const isDemoExecution =
      this.demoOnly === true ||
      this.isDemo === true ||
      this.accountType === "demo" ||
      String(this.accountType || "").toLowerCase().includes("demo");

    const scanAgeMs = Date.now() - number(this.startedAt, Date.now());
    const demoFallbackReady = scanAgeMs >= 20000;

    if (
      !gate.approved &&
      isDemoExecution &&
      demoFallbackReady &&
      this.settings.contractMode === "AUTO"
    ) {
      const candidates = Array.isArray(gate.candidates)
        ? gate.candidates.filter(Boolean)
        : [];

      const ranked = candidates
        .filter((candidate) => {
          const setup = String(candidate.setup || "").toUpperCase();
          return setup && !setup.includes("WAIT") && !setup.includes("RANDOM");
        })
        .sort(
          (a, b) =>
            number(b.confidence) - number(a.confidence) ||
            number(b.probability) - number(a.probability) ||
            number(b.edge) - number(a.edge)
        );

      const best = ranked[0];

      if (best) {
        const confidence = number(best.confidence);
        const probability = number(best.probability);
        const edge = number(best.edge);
        const family = String(best.family || "").toUpperCase();
        const setup = String(best.setup || "").toUpperCase();

        const usableDigit =
          family === "PARITY" ||
          family === "OVER_UNDER" ||
          family === "MATCH_DIFFERS";

        const usableRiseFall = family === "RISE_FALL";

        const demoQuality =
          confidence >= 62 ||
          probability >= 58 ||
          edge >= 2.5;

        if ((usableDigit || usableRiseFall) && demoQuality) {
          gate = {
            ...gate,
            approved: true,
            setup: best.setup,
            confidence: Math.max(confidence, probability),
            prediction:
              best.prediction ?? gate.prediction ?? this.settings.prediction,
            selectedProbability: probability,
            baselineProbability: number(best.baseline),
            edge,
            reason:
              `DEMO FAST ENTRY · ${best.setup} · confidence ${confidence.toFixed(
                1
              )}% · probability ${probability.toFixed(1)}%`,
            executionLane: "V19_2_DEMO_FAST_ENTRY",
            requiredConfirmations: 1,
          };
        }
      }
    }

    /*
     * V19_1_EXECUTION_SYNC
     *
     * The deep dashboard and the execution gate were using different
     * acceptance layers. This caused the UI to show DEEP READY / strong
     * OVER, UNDER, EVEN or ODD setups while the engine remained WAITING.
     *
     * This fallback uses the gate's own ranked candidates. It is only
     * available in AUTO mode and still requires a meaningful statistical
     * edge. It does not manufacture a random setup.
     */
    if (!gate.approved && this.settings.contractMode === "AUTO") {
      const candidates = Array.isArray(gate.candidates)
        ? gate.candidates.filter(Boolean)
        : [];

      const nearest = candidates
        .slice()
        .sort(
          (a, b) =>
            number(b.confidence) - number(a.confidence) ||
            number(b.edge) - number(a.edge) ||
            number(b.priority) - number(a.priority)
        )[0];

      if (nearest) {
        const confidence = number(nearest.confidence);
        const edge = number(nearest.edge);
        const probability = number(nearest.probability);
        const family = String(nearest.family || "").toUpperCase();
        const setup = String(nearest.setup || "").toUpperCase();
        const executionThreshold = Math.max(
          65,
          number(this.settings.minConfidence, 75) - 5
        );

        const strongOverUnder =
          family === "OVER_UNDER" &&
          edge >= 5 &&
          confidence >= executionThreshold;

        const strongParity =
          family === "PARITY" &&
          probability >= 56 &&
          edge >= 6 &&
          confidence >= executionThreshold;

        const strongRiseFall =
          family === "RISE_FALL" &&
          confidence >= executionThreshold + 3;

        const strongDiffers =
          family === "MATCH_DIFFERS" &&
          setup.includes("DIFFERS") &&
          edge >= 3 &&
          confidence >= executionThreshold + 2;

        if (
          strongOverUnder ||
          strongParity ||
          strongRiseFall ||
          strongDiffers
        ) {
          gate = {
            ...gate,
            approved: true,
            setup: nearest.setup,
            confidence,
            prediction:
              nearest.prediction ?? gate.prediction ?? this.settings.prediction,
            selectedProbability: probability,
            baselineProbability: number(nearest.baseline),
            edge,
            reason:
              `FAST EXECUTION · ${nearest.setup} · confidence ${confidence.toFixed(
                1
              )}% · edge ${edge.toFixed(1)}%`,
            executionLane: "V19_1_FAST_VALIDATED",
          };
        }
      }
    }

    const startedAt =
      Number(this.state.scanStartedAt) > 0
        ? Number(this.state.scanStartedAt)
        : Date.now();

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - startedAt) / 1000)
    );

    let setup = gate.approved ? normalizeSetup(gate.setup) : "";
    let deepOverride = false;
    let deepAssessment = null;

    // V12 can use a high-quality deep setup when the conservative digit gate
    // is silent, but only in AUTO and only for the same safe contract family.
    if (!setup && this.settings.contractMode === "AUTO") {
      const deepBest = normalizeSetup(intelligence?.bestSetup);
      const safeDeepSetups = new Set(["RISE", "FALL", "EVEN", "ODD", "OVER 2"]);
      const overrideAssessment = evaluateSyntheticSetup(
        intelligence,
        deepBest,
        { minimumScore: this.settings.deepOverrideScore }
      );

      if (
        safeDeepSetups.has(deepBest) &&
        overrideAssessment.approved &&
        overrideAssessment.fastLane
      ) {
        setup = deepBest;
        deepOverride = true;
        deepAssessment = overrideAssessment;
      }
    }

    if (!setup) {
      this.pendingSetupKey = "";
      this.pendingSignalCount = 0;
      this.pendingSignalSince = 0;
      this.pendingSignalVersion = 0;

      const deepStatus = Number(intelligence?.bestScore || 0) > 0
        ? ` Deep best ${intelligence.bestSetup} ${Number(intelligence.bestScore).toFixed(1)}%.`
        : "";

      return {
        ok: false,
        reason: `${gate.reason}${deepStatus}`,
        elapsedSeconds,
        confirmations: 0,
        gate,
        intelligence,
      };
    }

    const contract = contractFromSetup(setup);

    if (!contract) {
      return {
        ok: false,
        reason: `Unsupported analysis setup: ${setup}.`,
        elapsedSeconds,
        confirmations: 0,
        gate,
        intelligence,
      };
    }

    const setupKey = `${this.symbol}:${setup}`;
    const blockedUntil = Number(this.blockedSetups.get(setupKey) || 0);

    if (blockedUntil > Date.now()) {
      const remaining = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));

      return {
        ok: false,
        reason: `Loss protection: ${setup} is blocked on this market for ${remaining}s.`,
        elapsedSeconds,
        confirmations: 0,
        blockedSetupUntil: blockedUntil,
        gate,
        intelligence,
      };
    }

    if (blockedUntil) {
      this.blockedSetups.delete(setupKey);
    }

    const tradeGapRemaining = Math.ceil(
      (this.lastTradeAt + this.settings.minimumTradeGapSeconds * 1000 - Date.now()) /
        1000
    );

    if (tradeGapRemaining > 0) {
      return {
        ok: false,
        reason: `Trade spacing protection: waiting ${tradeGapRemaining}s for new ticks.`,
        elapsedSeconds,
        confirmations: 0,
        gate,
        intelligence,
      };
    }

    const validatedSignals = signal.validatedSignals || {};
    const validationRows = Array.isArray(validatedSignals?.signals)
      ? validatedSignals.signals
      : [];
    const matchingValidation = validationRows.find(
      (row) => row?.approved && validationAction(row) === setup
    );
    const bestValidation = validatedSignals?.best;
    const bestValidationAction = bestValidation?.approved
      ? validationAction(bestValidation)
      : "WAIT";

    if (this.settings.contractMode === "AUTO") {
      if (!matchingValidation || bestValidationAction !== setup) {
        return {
          ok: false,
          reason: `Walk-forward validation has not selected ${setup} as the best live setup.`,
          elapsedSeconds,
          confirmations: 0,
          gate,
          intelligence,
        };
      }
    }

    const professionalDecision = signal.professionalDecision || {};

    if (["RISE", "FALL"].includes(setup)) {
      const professionalSetup = normalizeSetup(professionalDecision.setup);

      if (
        !professionalDecision.validated ||
        professionalSetup !== setup ||
        Number(professionalDecision.confidence || 0) < this.settings.minConfidence
      ) {
        return {
          ok: false,
          reason: `Professional direction engine has not validated ${setup}.`,
          elapsedSeconds,
          confirmations: 0,
          gate,
          intelligence,
        };
      }
    }

    if (!deepAssessment) {
      deepAssessment = evaluateSyntheticSetup(
        intelligence,
        setup,
        { minimumScore: this.settings.deepMinimumScore }
      );
    }

    if (!deepAssessment.approved) {
      return {
        ok: false,
        reason: deepAssessment.reason,
        elapsedSeconds,
        confirmations: 0,
        gate,
        intelligence,
        deepAssessment,
      };
    }

    const intelligenceBest = normalizeSetup(intelligence?.bestSetup);
    const intelligenceBestScore = Number(intelligence?.bestScore || 0);
    if (
      this.settings.contractMode === "AUTO" &&
      intelligenceBest &&
      intelligenceBest !== setup &&
      intelligenceBestScore >= Number(deepAssessment.score || 0) + 8
    ) {
      return {
        ok: false,
        reason: `Deep engines disagree: ${setup} vs stronger ${intelligenceBest}.`,
        elapsedSeconds,
        confirmations: 0,
        gate,
        intelligence,
        deepAssessment,
      };
    }

    const version = Number(signal.updatedAt || this.signalUpdatedAt || Date.now());

    if (this.pendingSetupKey !== setupKey) {
      this.pendingSetupKey = setupKey;
      this.pendingSignalCount = 1;
      this.pendingSignalSince = Date.now();
      this.pendingSignalVersion = version;
    } else if (version > this.pendingSignalVersion) {
      this.pendingSignalCount += 1;
      this.pendingSignalVersion = version;
    }

    const fastLane = Boolean(deepAssessment.fastLane);
    const requiredConfirmations = fastLane
      ? 1
      : Math.max(1, this.settings.confirmationCount);
    const requiredMilliseconds = fastLane
      ? 500
      : this.settings.confirmationSeconds * 1000;
    const confirmationAge = Date.now() - this.pendingSignalSince;
    const enoughConfirmations = this.pendingSignalCount >= requiredConfirmations;
    const enoughTime = confirmationAge >= requiredMilliseconds;

    if (!enoughConfirmations || !enoughTime) {
      return {
        ok: false,
        reason: `${fastLane ? "FAST AI" : "Deep confirming"} ${setup}: ${this.pendingSignalCount}/${requiredConfirmations} fresh ticks.`,
        elapsedSeconds,
        confirmations: this.pendingSignalCount,
        requiredConfirmations,
        gate,
        intelligence,
        deepAssessment,
      };
    }

    const timing = signal.entryTiming || {};
    const timingSetup = normalizeSetup(timing.setup);

    if (timingSetup === setup && timing.readyNow === false) {
      return {
        ok: false,
        reason: timing.instruction || `Waiting for the ${setup} entry trigger.`,
        elapsedSeconds,
        confirmations: this.pendingSignalCount,
        requiredConfirmations,
        gate,
        intelligence,
        deepAssessment,
      };
    }

    const effectiveConfidence = Math.max(
      Number(gate.confidence || 0),
      Number(deepAssessment.score || 0)
    );

    return {
      ok: true,
      mode: "V12_DEEP_CYCLE_AI",
      decision: {
        setup,
        bestContract: setup,
        confidence: effectiveConfidence,
        professionalScore: Number(
          professionalDecision.confidence || effectiveConfidence
        ),
        marketQuality: Number(
          professionalDecision.marketQuality || intelligence.consensus || 0
        ),
        riskLevel: fastLane ? "FAST-VALIDATED" : "DEEP-VALIDATED",
        passedCount: Number(
          professionalDecision.passedCount ||
            validationRows.filter((item) => item?.approved).length ||
            1
        ),
        validated: true,
        gateReason: deepOverride
          ? `Deep override: ${deepAssessment.reason}`
          : gate.reason,
        historicalHitRate: Number(matchingValidation?.hitRate || 0),
        historicalLowerBound: Number(matchingValidation?.lowerBound || 0),
        deepScore: Number(deepAssessment.score || 0),
        deepConsensus: Number(intelligence?.consensus || 0),
        deepRegime: intelligence?.regime || "UNKNOWN",
        cyclePeriod: Number(intelligence?.cycle?.period || 0),
        fastLane,
        deepOverride,
      },
      timing: {
        ...timing,
        state: timing.state || "ENTER",
        readyNow: true,
      },
      contract,
      elapsedSeconds,
      confirmations: this.pendingSignalCount,
      requiredConfirmations,
      gate: {
        ...gate,
        approved: true,
        setup,
        confidence: effectiveConfidence,
      },
      intelligence,
      deepAssessment,
    };
  }

  async start() {
    if (this.running) return;

    if (!this.symbol) {
      throw new Error("Connect the Deriv feed and select a market first.");
    }

    this.running = true;
    this.paused = false;
    this.stopping = false;
    this.pendingSetupKey = "";
    this.pendingSignalCount = 0;
    this.pendingSignalSince = 0;
    this.pendingSignalVersion = 0;

    this.patch({
      status: "RUNNING",
      message:
        "V12 Deep Cycle AI is scanning momentum, volatility regimes, entropy, transitions, autocorrelation, observed cycles, walk-forward validation and entry timing.",
      scanStartedAt: Date.now(),
      scanElapsedSeconds: 0,
      lastBlockReason: "",
    });

    void this.loop();
  }

  pause() {
    if (!this.running) return;

    this.paused = true;
    this.patch({
      status: "PAUSED",
      message: "Bot paused. Active trade will still be monitored.",
    });
  }

  resume() {
    if (!this.running) return;

    this.paused = false;
    this.patch({
      status: "RUNNING",
      message: "Bot resumed.",
    });
  }

  stop(message = "Bot stopped.", status = "STOPPED") {
    this.stopping = true;
    this.running = false;
    this.paused = false;

    this.contractWaiters.forEach((waiter) => {
      window.clearTimeout(waiter.timeout);
      waiter.reject(new Error("Bot stopped."));
    });

    this.contractWaiters.clear();

    this.patch({
      status,
      message,
      stopReason: message,
      completedAt:
        status === "COMPLETED" ? Date.now() : this.state.completedAt,
      cooldownUntil: 0,
      activeContractId: "",
    });
  }

  reset() {
    if (this.running) return;

    this.state = {
      status: "IDLE",
      message: "Bot statistics reset.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      totalStake: 0,
      totalPayout: 0,
      completedAt: 0,
      stopReason: "",
      consecutiveLosses: 0,
      lossesSinceWin: 0,
      cooldownUntil: 0,
      cooldownCount: 0,
      currentWinStreak: 0,
      largestWinStreak: 0,
      largestLossStreak: 0,
      martingaleStep: 0,
      currentStake: this.settings.stake,
      activeSetup: "—",
      activeContractId: "",
      scanStartedAt: 0,
      scanElapsedSeconds: 0,
      lastBlockReason: "",
      fallbackTrades: 0,
      signalConfirmations: 0,
      requiredConfirmations: this.settings.confirmationCount,
      blockedSetupUntil: 0,
      lastLossSetup: "—",
      lossProtectionCount: 0,
      deepScore: 0,
      deepConsensus: 0,
      deepRegime: "UNKNOWN",
      cyclePeriod: 0,
      fastLane: false,
      history: [],
    };

    this.pendingSetupKey = "";
    this.pendingSignalCount = 0;
    this.pendingSignalSince = 0;
    this.pendingSignalVersion = 0;
    this.blockedSetups.clear();
    this.lastTradeAt = 0;
    this.lastLossSetup = "";

    this.onState(this.snapshot());
  }

  riskStopReason() {
    if (this.state.runs >= this.settings.maxRuns) {
      return {
        message: `Completed ${this.settings.maxRuns} runs.`,
        status: "COMPLETED",
      };
    }

    if (
      this.settings.takeProfit > 0 &&
      this.state.profit >= this.settings.takeProfit
    ) {
      return {
        message: `Take profit reached: ${this.state.profit.toFixed(2)} ${
          this.currency
        }.`,
        status: "COMPLETED",
      };
    }

    if (
      this.settings.stopLoss > 0 &&
      this.state.profit <= -this.settings.stopLoss
    ) {
      return {
        message: `Stop loss reached: ${this.state.profit.toFixed(2)} ${
          this.currency
        }.`,
        status: "STOPPED",
      };
    }

    if (
      this.state.lossesSinceWin >=
      this.settings.hardStopLossStreak
    ) {
      return {
        message: `Hard stop reached after ${this.state.lossesSinceWin} losses without a recovery win.`,
        status: "STOPPED",
      };
    }

    return null;
  }

  async runRiskCooldown() {
    const until = Number(this.state.cooldownUntil || 0);

    if (!until || until <= Date.now()) {
      return;
    }

    while (
      this.running &&
      !this.stopping &&
      Date.now() < until
    ) {
      if (this.paused) {
        await sleep(500);
        continue;
      }

      const remaining = Math.max(
        1,
        Math.ceil((until - Date.now()) / 1000)
      );

      this.patch({
        status: "RISK_COOLDOWN",
        message: `Risk cooldown active. Waiting ${remaining}s for better conditions.`,
      });

      await sleep(1000);
    }

    if (!this.running || this.stopping) {
      return;
    }

    this.patch({
      status: "RUNNING",
      message: "Risk cooldown completed. Waiting for a new validated setup.",
      cooldownUntil: 0,
      cooldownCount: this.state.cooldownCount + 1,
      consecutiveLosses: 0,
      martingaleStep: 0,
      currentStake: this.settings.stake,
      activeSetup: "—",
      signalConfirmations: 0,
      lastBlockReason: "",
    });
  }

  async loop() {
    while (this.running && !this.stopping) {
      if (Number(this.state.cooldownUntil || 0) > Date.now()) {
        await this.runRiskCooldown();
        continue;
      }

      const stopReason = this.riskStopReason();

      if (stopReason) {
        this.stop(stopReason.message, stopReason.status);
        return;
      }

      if (this.paused) {
        await sleep(500);
        continue;
      }

      const check = this.validSignal();

      if (!check.ok) {
        this.patch({
          status: "WAITING",
          message: check.reason,
          activeSetup: "—",
          scanElapsedSeconds: number(check.elapsedSeconds),
          lastBlockReason: check.reason,
          signalConfirmations: number(check.confirmations),
          requiredConfirmations: number(
            check.requiredConfirmations,
            this.settings.confirmationCount
          ),
          blockedSetupUntil: number(check.blockedSetupUntil),
          deepScore: number(
            check.deepAssessment?.score ?? check.intelligence?.bestScore
          ),
          deepConsensus: number(check.intelligence?.consensus),
          deepRegime: check.intelligence?.regime || "UNKNOWN",
          cyclePeriod: number(check.intelligence?.cycle?.period),
          fastLane: Boolean(check.deepAssessment?.fastLane),
        });

        await sleep(1000);
        continue;
      }

      try {
        await this.executeTrade(check);
      } catch (error) {
        console.error("===== EXECUTE TRADE ERROR =====");
        console.error(error);
        console.error(error?.stack);

        const message =
          error instanceof Error ? error.message : "Trade execution failed.";

        this.addHistory({
          id: `error-${Date.now()}`,
          time: Date.now(),
          setup: `${check.contract.label} · ${message}`,
          result: "ERROR",
          profit: 0,
          stake: this.state.currentStake,
          message,
        });

        this.patch({
          status: "ERROR",
          message,
          activeContractId: "",
        });

        await sleep(3000);
      }

      if (
        this.running &&
        Number(this.state.cooldownUntil || 0) <= Date.now() &&
        this.settings.delaySeconds > 0
      ) {
        this.patch({
          status: "COOLDOWN",
          message: `Waiting ${this.settings.delaySeconds}s before the next scan.`,
        });

        await sleep(this.settings.delaySeconds * 1000);
      }
    }
  }

  async testOneDemoTrade(setup = "RISE") {
    if (this.running || this.activeContractId) {
      throw new Error(
        "Stop or pause the automatic bot before running a test trade."
      );
    }

    if (!this.symbol) {
      throw new Error(
        "Connect the Deriv feed and select a market first."
      );
    }

    const contract = contractFromSetup(setup);

    if (!contract) {
      throw new Error(`Unsupported test setup: ${setup}.`);
    }

    const check = {
      mode: "MANUAL_TEST",
      contract,
      decision: {
        setup: contract.label,
        confidence: 100,
        passedCount: 7,
        validated: true,
      },
      timing: {
        state: "TEST",
        readyNow: true,
      },
    };

    this.patch({
      status: "TESTING",
      message: `Opening one Demo test trade: ${contract.label}.`,
      activeSetup: contract.label,
    });

    await this.executeTrade(check);

    this.patch({
      status: "IDLE",
      message:
        "Demo test trade completed. The automatic bot remains stopped.",
      cooldownUntil: 0,
    });
  }

  async executeTrade(check) {
    const stake = Number(this.state.currentStake.toFixed(2));
    const digitContract = isDigitContract(check.contract);

    // AUTO digit analysis/backtesting validates the next digit, so V12 uses
    // one tick for AUTO digit contracts. Rise/Fall keeps the configured time.
    
    const tradeDuration =
      this.settings.contractMode === "AUTO" && digitContract
        ? 1
        : this.settings.duration;
    const tradeDurationUnit = digitContract
      ? "t"
      : this.settings.durationUnit;

    this.patch({
      status: "BUYING",
      message:
        `V12 Deep AI confirmed ${check.contract.label} for ${durationText(
          tradeDuration,
          tradeDurationUnit
        )}. Requesting ${stake.toFixed(2)} ${this.currency}.`,
      activeSetup: `${check.contract.label} · V12 DEEP CONFIRMED`,
      signalConfirmations: number(
        check.requiredConfirmations,
        this.settings.confirmationCount
      ),
      lastBlockReason: "",
      requiredConfirmations: number(
        check.requiredConfirmations,
        this.settings.confirmationCount
      ),
      deepScore: number(check.decision?.deepScore),
      deepConsensus: number(check.decision?.deepConsensus),
      deepRegime: check.decision?.deepRegime || "UNKNOWN",
      cyclePeriod: number(check.decision?.cyclePeriod),
      fastLane: Boolean(check.decision?.fastLane),
    });

    console.log("===== DERIV BUY REQUEST =====", {
      symbol: this.symbol,
      contractType: check.contract.contractType,
      barrier: check.contract.barrier,
      amount: stake,
      basis: "stake",
      currency: this.currency,
      duration: tradeDuration,
      durationUnit: tradeDurationUnit,
    });

    const bought = await this.client.buyContract({
      symbol: this.symbol,
      contractType: check.contract.contractType,
      barrier: check.contract.barrier,
      amount: stake,
      basis: "stake",
      currency: this.currency,
      duration: tradeDuration,
      durationUnit: tradeDurationUnit,
    });

    console.log("===== DERIV BUY RESPONSE =====", bought);

    if (!bought.contractId) {
      throw new Error("Deriv did not return a contract ID.");
    }

    this.activeContractId = String(bought.contractId);

    this.patch({
      status: "MONITORING",
      message: `Monitoring contract ${this.activeContractId}.`,
      activeContractId: this.activeContractId,
    });

    const settled = await this.waitForContract(
      this.activeContractId,
      tradeDuration,
      tradeDurationUnit
    );
    const profit = contractProfit(settled);
    const details = contractDetails(settled, bought);
    const won = profit > 0;

    const runs = this.state.runs + 1;
    const wins = this.state.wins + (won ? 1 : 0);
    const losses = this.state.losses + (won ? 0 : 1);
    const totalProfit = this.state.profit + profit;
    const totalStake = this.state.totalStake + stake;
    const totalPayout =
      this.state.totalPayout + Math.max(0, details.payout);
    const consecutiveLosses = won ? 0 : this.state.consecutiveLosses + 1;
    const lossesSinceWin = won ? 0 : this.state.lossesSinceWin + 1;
    const currentWinStreak = won ? this.state.currentWinStreak + 1 : 0;
    const largestWinStreak = Math.max(
      this.state.largestWinStreak,
      currentWinStreak
    );
    const largestLossStreak = Math.max(
      this.state.largestLossStreak,
      consecutiveLosses
    );

    let martingaleStep = 0;
    let nextStake = this.settings.stake;

    if (
      !won &&
      this.settings.martingaleEnabled &&
      this.state.martingaleStep < this.settings.maxMartingaleSteps
    ) {
      martingaleStep = this.state.martingaleStep + 1;
      nextStake =
        this.settings.stake *
        smartRecoveryMultiplier(
          martingaleStep,
          this.settings.recoveryMultipliers
        );
    }

    const setup = normalizeSetup(check.contract.label);
    const setupKey = `${this.symbol}:${setup}`;
    const now = Date.now();
    let blockedSetupUntil = 0;
    let lossProtectionCount = this.state.lossProtectionCount;

    if (!won) {
      blockedSetupUntil =
        now + this.settings.lossSetupBlockSeconds * 1000;
      this.blockedSetups.set(setupKey, blockedSetupUntil);
      this.lastLossSetup = setup;
      lossProtectionCount += 1;
    }

    this.addHistory({
      id: this.activeContractId,
      time: now,
      setup: check.contract.label,
      result: won ? "WIN" : "LOSS",
      profit,
      stake,
      payout: details.payout,
      buyPrice: details.buyPrice,
      sellPrice: details.sellPrice,
      entrySpot: details.entrySpot,
      exitSpot: details.exitSpot,
      duration: tradeDuration,
      durationUnit: tradeDurationUnit,
      prediction: check.contract.barrier ?? null,
      symbol: this.symbol,
      contractId: this.activeContractId,
      confidence: number(
        check.decision.professionalScore ?? check.decision.confidence
      ),
      marketQuality: number(check.decision.marketQuality),
      riskLevel: String(check.decision.riskLevel || "—"),
      entryStage: String(check.timing.state || "—"),
      votes: number(check.decision.passedCount),
      martingaleStep: this.state.martingaleStep,
      executionMode: check.mode || "V12_DEEP_CYCLE_AI",
      historicalHitRate: number(check.decision.historicalHitRate),
      historicalLowerBound: number(check.decision.historicalLowerBound),
      deepScore: number(check.decision.deepScore),
      deepConsensus: number(check.decision.deepConsensus),
      deepRegime: String(check.decision.deepRegime || "UNKNOWN"),
      cyclePeriod: number(check.decision.cyclePeriod),
      fastLane: Boolean(check.decision.fastLane),
      deepOverride: Boolean(check.decision.deepOverride),
    });

    this.activeContractId = "";
    this.lastTradeAt = now;
    this.pendingSetupKey = "";
    this.pendingSignalCount = 0;
    this.pendingSignalSince = 0;
    this.pendingSignalVersion = 0;

    this.patch({
      status: won ? "WON" : "LOST",
      message: `${won ? "Won" : "Lost"} ${profit.toFixed(2)} ${
        this.currency
      }. Run ${runs}/${this.settings.maxRuns}.${
        won
          ? " Waiting for a new confirmed setup."
          : ` ${setup} is now blocked on this market.`
      }`,
      runs,
      wins,
      losses,
      profit: totalProfit,
      totalStake,
      totalPayout,
      consecutiveLosses,
      lossesSinceWin,
      currentWinStreak,
      largestWinStreak,
      largestLossStreak,
      martingaleStep,
      currentStake: Math.max(0.35, Number(nextStake.toFixed(2))),
      activeContractId: "",
      scanStartedAt: Date.now(),
      scanElapsedSeconds: 0,
      fallbackTrades: this.state.fallbackTrades,
      signalConfirmations: 0,
      requiredConfirmations: number(
        check.requiredConfirmations,
        this.settings.confirmationCount
      ),
      blockedSetupUntil,
      lastLossSetup: this.lastLossSetup || "—",
      lossProtectionCount,
      lastBlockReason: won
        ? ""
        : `Loss protection: ${setup} blocked on ${this.symbol}.`,
    });

    const finalStop = this.riskStopReason();

    if (finalStop) {
      this.stop(finalStop.message, finalStop.status);
      return;
    }

    if (
      !won &&
      consecutiveLosses >= this.settings.cooldownAfterLosses
    ) {
      const cooldownUntil =
        Date.now() + this.settings.cooldownSeconds * 1000;

      this.patch({
        status: "RISK_COOLDOWN",
        message:
          `Loss protection active. Cooling down for ${this.settings.cooldownSeconds}s and blocking ${setup} on this market.`,
        cooldownUntil,
      });
    }
  }

  waitForContract(contractId, duration = 5, durationUnit = "t") {
    const estimatedMilliseconds =
      durationUnit === "s"
        ? Math.max(120000, (number(duration, 30) + 120) * 1000)
        : 120000;

    const timeoutMilliseconds = Math.min(
      estimatedMilliseconds,
      2 * 60 * 60 * 1000
    );

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.contractWaiters.delete(String(contractId));
        reject(
          new Error(
            `Timed out while waiting for ${durationText(
              duration,
              durationUnit
            )} contract settlement.`
          )
        );
      }, timeoutMilliseconds);

      this.contractWaiters.set(String(contractId), {
        resolve,
        reject,
        timeout,
      });
    });
  }

  handleContractUpdate(contract) {
    const contractId = String(
      contract.contract_id || contract.id || contract.contractId || ""
    );

    if (!contractId || !isFinished(contract)) return;

    const waiter = this.contractWaiters.get(contractId);

    if (!waiter) return;

    window.clearTimeout(waiter.timeout);
    this.contractWaiters.delete(contractId);
    waiter.resolve(contract);
  }
}




