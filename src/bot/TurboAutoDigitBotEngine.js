
const DEFAULTS = {
  contractMode: "AUTO",
  predictionMode: "AUTO",
  prediction: 2,
  stake: 0.35,
  duration: 1,
  maxRuns: 5,
  unlimited: false,
  stopProfit: 0,
  stopLoss: 0,
  minimumConfidence: 82,
  confirmationUpdates: 2,
  lossCooldownMs: 750,
  sameSetupBlockMs: 15000,
  maximumSignalAgeMs: 2000,
  lossSkipSignals: 3,
  allowHighRiskContracts: false,
  highRiskMinimumQuality: 90,
  highRiskMinimumSamples: 220,
  highRiskMinimumEdge: 12,
  scanSwitchMs: 2500,
  postTradeDelayMs: 150,
};

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampDigit(value, fallback = 2) {
  return Math.max(
    0,
    Math.min(9, Math.floor(safeNumber(value, fallback)))
  );
}

function normalizeMode(value) {
  const mode = String(value || "AUTO").toUpperCase();

  return ["AUTO", "OVER", "UNDER", "MATCH", "DIFFERS", "EVEN", "ODD"].includes(mode)
    ? mode
    : "AUTO";
}

function parseSetup(value = "") {
  const setup = String(value || "").trim().toUpperCase();

  const over = setup.match(/^OVER\s+([0-9])$/);
  if (over) {
    return {
      label: `OVER ${over[1]}`,
      mode: "OVER",
      digit: Number(over[1]),
      contractType: "DIGITOVER",
      barrier: over[1],
    };
  }

  const under = setup.match(/^UNDER\s+([0-9])$/);
  if (under) {
    return {
      label: `UNDER ${under[1]}`,
      mode: "UNDER",
      digit: Number(under[1]),
      contractType: "DIGITUNDER",
      barrier: under[1],
    };
  }

  const match = setup.match(/^MATCH(?:ES)?\s+([0-9])$/);
  if (match) {
    return {
      label: `MATCH ${match[1]}`,
      mode: "MATCH",
      digit: Number(match[1]),
      contractType: "DIGITMATCH",
      barrier: match[1],
    };
  }

  const differs = setup.match(/^DIFFERS?\s+([0-9])$/);
  if (differs) {
    return {
      label: `DIFFERS ${differs[1]}`,
      mode: "DIFFERS",
      digit: Number(differs[1]),
      contractType: "DIGITDIFF",
      barrier: differs[1],
    };
  }

  if (setup === "EVEN") {
    return {
      label: "EVEN",
      mode: "EVEN",
      digit: null,
      contractType: "DIGITEVEN",
      barrier: undefined,
    };
  }

  if (setup === "ODD") {
    return {
      label: "ODD",
      mode: "ODD",
      digit: null,
      contractType: "DIGITODD",
      barrier: undefined,
    };
  }

  return null;
}

function manualContract(mode, prediction) {
  const normalized = normalizeMode(mode);

  if (normalized === "EVEN" || normalized === "ODD") {
    return parseSetup(normalized);
  }

  const digit = clampDigit(prediction);
  return parseSetup(`${normalized} ${digit}`);
}

function contractIdFromBuy(response = {}) {
  return String(
    response.contractId ||
      response.contract_id ||
      response.buy?.contract_id ||
      response.buy?.contractId ||
      ""
  );
}

function contractFinished(contract = {}) {
  return Boolean(
    contract.is_sold ||
      contract.is_expired ||
      contract.status === "won" ||
      contract.status === "lost" ||
      contract.status === "sold"
  );
}

function contractProfit(contract = {}) {
  const explicit = safeNumber(contract.profit, NaN);

  if (Number.isFinite(explicit)) {
    return explicit;
  }

  return safeNumber(contract.sell_price, 0) -
    safeNumber(contract.buy_price, 0);
}

export default class TurboAutoDigitBotEngine {
  constructor({ client, onState, onRequestMarketSwitch }) {
    this.client = client;
    this.onState =
      typeof onState === "function" ? onState : () => {};
    this.onRequestMarketSwitch =
      typeof onRequestMarketSwitch === "function"
        ? onRequestMarketSwitch
        : async () => null;

    this.settings = { ...DEFAULTS };
    this.symbol = "";
    this.currency = "USD";
    this.accountType = "demo";
    this.signal = null;
    this.signalKey = "";
    this.signalConfirmations = 0;
    this.lastSignalUpdatedAt = 0;
    this.lastLossSetup = "";
    this.lastLossAt = 0;
    this.skipSignalUpdatesRemaining = 0;
    this.noSignalSince = 0;
    this.running = false;
    this.stopRequested = false;
    this.contractWaiters = new Map();

    this.state = {
      status: "STOPPED",
      message: "V63 Fast Volatility Scanner is ready.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      totalStake: 0,
      activeSetup: "—",
      activeContractId: "",
      selectedConfidence: 0,
      selectedSource: "—",
      selectedQuality: 0,
      signalConfirmations: 0,
      skipSignalsRemaining: 0,
      executionPhase: "IDLE",
      debugSteps: [],
      marketSwitches: 0,
      history: [],
    };

    this.removeContractListener = this.client.onContract((contract) => {
      this.handleContractUpdate(contract);
    });
  }

  patch(next) {
    this.state = { ...this.state, ...next };
    this.onState(this.state);
  }

  configure(input = {}) {
    this.settings = {
      ...DEFAULTS,
      ...input,
      contractMode: normalizeMode(input.contractMode),
      predictionMode:
        String(input.predictionMode || "AUTO").toUpperCase() === "AUTO"
          ? "AUTO"
          : "MANUAL",
      prediction: clampDigit(input.prediction),
      stake: Math.max(0.35, safeNumber(input.stake, 0.35)),
      duration: Math.max(
        1,
        Math.min(10, Math.floor(safeNumber(input.duration, 1)))
      ),
      maxRuns: Math.max(
        1,
        Math.min(1000, Math.floor(safeNumber(input.maxRuns, 10)))
      ),
      unlimited: Boolean(input.unlimited),
      stopProfit: Math.max(0, safeNumber(input.stopProfit, 0)),
      stopLoss: Math.max(0, safeNumber(input.stopLoss, 0)),
      minimumConfidence: Math.max(
        50,
        Math.min(99, safeNumber(input.minimumConfidence, 75))
      ),
      confirmationUpdates: Math.max(
        1,
        Math.min(10, Math.floor(safeNumber(input.confirmationUpdates, 3)))
      ),
      lossCooldownMs: Math.max(
        0,
        Math.min(60000, Math.floor(safeNumber(input.lossCooldownMs, 6000)))
      ),
      sameSetupBlockMs: Math.max(
        0,
        Math.min(120000, Math.floor(safeNumber(input.sameSetupBlockMs, 15000)))
      ),
      maximumSignalAgeMs: Math.max(
        500,
        Math.min(10000, Math.floor(safeNumber(input.maximumSignalAgeMs, 2000)))
      ),
      lossSkipSignals: Math.max(
        0,
        Math.min(20, Math.floor(safeNumber(input.lossSkipSignals, 3)))
      ),
      allowHighRiskContracts: Boolean(input.allowHighRiskContracts),
      highRiskMinimumQuality: Math.max(
        80,
        Math.min(99, safeNumber(input.highRiskMinimumQuality, 90))
      ),
      highRiskMinimumSamples: Math.max(
        100,
        Math.min(1000, Math.floor(safeNumber(input.highRiskMinimumSamples, 220)))
      ),
      highRiskMinimumEdge: Math.max(
        5,
        Math.min(40, safeNumber(input.highRiskMinimumEdge, 12))
      ),
      scanSwitchMs: Math.max(
        1000,
        Math.min(15000, Math.floor(safeNumber(input.scanSwitchMs, 2500)))
      ),
      postTradeDelayMs: Math.max(
        50,
        Math.min(3000, Math.floor(safeNumber(input.postTradeDelayMs, 150)))
      ),
    };
  }

  setMarket({ symbol, currency }) {
    this.symbol = String(symbol || "");
    this.currency = String(currency || "USD");
  }

  setAccountType(accountType) {
    this.accountType =
      String(accountType || "demo").toLowerCase() === "real"
        ? "real"
        : "demo";
  }

  debug(step, detail = "") {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: Date.now(),
      step,
      detail,
    };

    this.patch({
      executionPhase: step,
      debugSteps: [entry, ...(this.state.debugSteps || [])].slice(0, 12),
    });
  }

  updateSignal(signal) {
    const next = signal || null;
    const nextKey = String(next?.setup || "").trim().toUpperCase();

    if (!nextKey) {
      this.signal = null;
      this.signalKey = "";
      this.signalConfirmations = 0;
      this.patch({
        signalConfirmations: 0,
      });
      return;
    }

    if (this.skipSignalUpdatesRemaining > 0) {
      this.skipSignalUpdatesRemaining -= 1;
      this.signal = null;
      this.signalKey = "";
      this.signalConfirmations = 0;

      this.patch({
        status: this.running ? "COOLDOWN" : this.state.status,
        message:
          `Loss protection: skipping signal update ` +
          `${this.settings.lossSkipSignals - this.skipSignalUpdatesRemaining}/` +
          `${this.settings.lossSkipSignals}.`,
        signalConfirmations: 0,
        skipSignalsRemaining: this.skipSignalUpdatesRemaining,
      });
      return;
    }

    if (this.state.activeContractId) {
      return;
    }

    if (nextKey === this.signalKey) {
      this.signalConfirmations = Math.min(
        this.settings.confirmationUpdates,
        this.signalConfirmations + 1
      );
    } else {
      this.signalKey = nextKey;
      this.signalConfirmations = 1;
    }

    this.lastSignalUpdatedAt = Date.now();
    this.noSignalSince = 0;
    this.signal = {
      ...next,
      confirmations: this.signalConfirmations,
      updatedAt: this.lastSignalUpdatedAt,
    };

    this.patch({
      signalConfirmations: this.signalConfirmations,
      selectedQuality: safeNumber(next?.qualityScore, 0),
      skipSignalsRemaining: this.skipSignalUpdatesRemaining,
    });
  }

  selectedContract() {
    const manual = manualContract(
      this.settings.contractMode,
      this.settings.prediction
    );

    if (this.settings.contractMode !== "AUTO") {
      return manual;
    }

    const auto = parseSetup(this.signal?.setup);
    const confidence = safeNumber(
      this.signal?.qualityScore,
      this.signal?.confidence
    );
    const confirmations = safeNumber(this.signal?.confirmations, 0);

    const highRisk =
      auto?.mode === "MATCH" ||
      auto?.mode === "DIFFERS";

    if (highRisk) {
      const sampleSize = safeNumber(this.signal?.sampleSize, 0);
      const edge = safeNumber(this.signal?.expectedValue, 0);

      if (
        !this.settings.allowHighRiskContracts ||
        confidence < this.settings.highRiskMinimumQuality ||
        sampleSize < this.settings.highRiskMinimumSamples ||
        edge < this.settings.highRiskMinimumEdge
      ) {
        return null;
      }
    }
    const fresh =
      Date.now() - safeNumber(this.signal?.updatedAt, 0) <=
      this.settings.maximumSignalAgeMs;

    if (
      !auto ||
      confidence < this.settings.minimumConfidence ||
      confirmations < this.settings.confirmationUpdates ||
      !fresh
    ) {
      return null;
    }

    if (
      auto.label === this.lastLossSetup &&
      Date.now() - this.lastLossAt < this.settings.sameSetupBlockMs
    ) {
      return null;
    }

    if (
      this.settings.predictionMode === "MANUAL" &&
      auto.mode !== "AUTO"
    ) {
      return manualContract(auto.mode, this.settings.prediction);
    }

    return auto;
  }

  stopReason() {
    if (
      this.settings.stopProfit > 0 &&
      this.state.profit >= this.settings.stopProfit
    ) {
      return `Profit target reached: ${this.state.profit.toFixed(2)} ${this.currency}.`;
    }

    if (
      this.settings.stopLoss > 0 &&
      this.state.profit <= -this.settings.stopLoss
    ) {
      return `Loss limit reached: ${this.state.profit.toFixed(2)} ${this.currency}.`;
    }

    const effectiveMaxRuns =
      this.accountType === "real"
        ? Math.min(10, this.settings.maxRuns)
        : this.settings.maxRuns;

    if (
      !this.settings.unlimited &&
      this.state.runs >= effectiveMaxRuns
    ) {
      return "Maximum runs completed.";
    }

    if (
      this.accountType === "real" &&
      this.state.losses >= 1
    ) {
      return "Real-account safety stop after one loss.";
    }

    return "";
  }

  async start() {
    if (this.running) return;

    if (!this.symbol) {
      throw new Error("Connect the Deriv feed and select a market first.");
    }

    this.running = true;
    this.stopRequested = false;

    this.debug("START", `${this.accountType.toUpperCase()} account`);
    this.patch({
      status: "SCANNING",
      message: "Scanning the latest digit setup.",
    });

    try {
      while (this.running && !this.stopRequested) {
        const reason = this.stopReason();

        if (reason) {
          this.stop(reason, "COMPLETED");
          break;
        }

        this.debug("SCAN", this.signal?.setup || "WAIT");
        const contract = this.selectedContract();

        if (!contract) {
          const confidence = safeNumber(this.signal?.confidence, 0);
          const confirmations = safeNumber(this.signal?.confirmations, 0);

          if (!this.noSignalSince) {
            this.noSignalSince = Date.now();
          }

          const waitingMs = Date.now() - this.noSignalSince;

          this.patch({
            status: "SCANNING",
            message:
              `Strict scan: confidence ${confidence.toFixed(1)}% / ` +
              `${this.settings.minimumConfidence}% · confirmations ` +
              `${confirmations}/${this.settings.confirmationUpdates} · ` +
              `switch in ${Math.max(
                0,
                Math.ceil((this.settings.scanSwitchMs - waitingMs) / 1000)
              )}s.`,
            activeSetup: this.signal?.setup || "—",
            selectedConfidence: confidence,
            selectedSource: this.signal?.source || "LIVE ANALYSIS",
          });

          if (waitingMs >= this.settings.scanSwitchMs) {
            this.noSignalSince = 0;
            await this.switchMarketAfterTrade("No strict setup on current market.");
          } else {
            await sleep(120);
          }

          continue;
        }

        this.noSignalSince = 0;

        this.debug(
          "CONFIRMED",
          `${contract.label} · ${this.signalConfirmations}/${this.settings.confirmationUpdates}`
        );
        await this.openTrade(contract);

        await this.switchMarketAfterTrade(
          "Trade settled. Rotating volatility for fresh evidence."
        );

        if (
          this.state.history[0]?.result === "LOSS" &&
          this.settings.lossCooldownMs > 0
        ) {
          this.patch({
            status: "COOLDOWN",
            message:
              `Loss cooldown ${Math.ceil(this.settings.lossCooldownMs / 1000)}s ` +
              "before scanning again.",
          });
          await sleep(this.settings.lossCooldownMs);
        }

        const afterTradeReason = this.stopReason();

        if (afterTradeReason) {
          this.stop(afterTradeReason, "COMPLETED");
          break;
        }

        this.patch({
          status: "SCANNING",
          message: "Trade settled. Scanning the next setup.",
          activeContractId: "",
        });

        await sleep(this.settings.postTradeDelayMs);
      }
    } catch (error) {
      this.running = false;
      this.patch({
        status: "ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Dynamic All-Digit Analysis Bot failed.",
        activeContractId: "",
      });
      throw error;
    }
  }

  async switchMarketAfterTrade(reason = "Selecting a fresh volatility market.") {
    this.debug("MARKET_SWITCH", reason);

    this.signal = null;
    this.signalKey = "";
    this.signalConfirmations = 0;
    this.lastSignalUpdatedAt = 0;

    this.patch({
      status: "SWITCHING",
      message: "Trade settled. Switching market and rebuilding fresh analysis.",
      activeSetup: "—",
      selectedConfidence: 0,
      selectedQuality: 0,
      signalConfirmations: 0,
    });

    const result = await this.onRequestMarketSwitch({
      previousSymbol: this.symbol,
      runs: this.state.runs,
      lastResult: this.state.history?.[0]?.result || "",
    });

    if (result?.symbol) {
      this.symbol = String(result.symbol);
    }

    this.patch({
      marketSwitches: this.state.marketSwitches + 1,
      message: result?.label
        ? `Switched to ${result.label}. Collecting fresh ticks.`
        : "Market switched. Collecting fresh ticks.",
    });

    // Fast reconnect while still allowing the new subscription to receive ticks.
    await sleep(500);
    this.debug("FRESH_SCAN", this.symbol || "new market");
  }

  stop(message = "Bot stopped.", status = "STOPPED") {
    this.stopRequested = true;
    this.running = false;

    this.patch({
      status,
      message,
      activeContractId: "",
    });
  }

  reset() {
    if (this.running) return;

    this.patch({
      status: "STOPPED",
      message: "Statistics reset. Bot is ready.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      totalStake: 0,
      activeSetup: "—",
      activeContractId: "",
      selectedConfidence: 0,
      selectedSource: "—",
      selectedQuality: 0,
      signalConfirmations: 0,
      skipSignalsRemaining: 0,
      executionPhase: "IDLE",
      debugSteps: [],
      marketSwitches: 0,
      history: [],
    });
  }

  async openTrade(contract) {
    const tradeSignal = this.signal
      ? { ...this.signal }
      : {
          setup: contract.label,
          confidence: 0,
          qualityScore: 0,
          expectedValue: 0,
          probabilityEdge: 0,
          consistency: 0,
          source: "MANUAL CONTRACT",
        };

    const configuredStake = Number(this.settings.stake.toFixed(2));
    const stake =
      this.accountType === "real"
        ? Math.min(0.35, configuredStake)
        : configuredStake;

    this.debug("BUY_REQUEST", `${contract.label} · ${stake.toFixed(2)} ${this.currency}`);

    this.patch({
      status: "BUYING",
      message: `Buying ${contract.label} for ${stake.toFixed(2)} ${this.currency}.`,
      activeSetup: contract.label,
      selectedConfidence: safeNumber(
        tradeSignal.confidence,
        0
      ),
      selectedQuality: safeNumber(
        tradeSignal.qualityScore,
        tradeSignal.confidence
      ),
      signalConfirmations: this.signalConfirmations,
      selectedSource:
        this.settings.contractMode === "AUTO"
          ? this.signal?.source || "LIVE ANALYSIS"
          : "MANUAL CONTRACT",
    });

    const request = {
      symbol: this.symbol,
      contractType: contract.contractType,
      amount: stake,
      basis: "stake",
      currency: this.currency,
      duration: this.settings.duration,
      durationUnit: "t",
    };

    if (contract.barrier !== undefined && contract.barrier !== null) {
      request.barrier = contract.barrier;
    }

    const bought = await this.client.buyContract(request);

    /* V55 request is deliberately built per contract family. */
    const ignoredLegacyBuyShape = {
      symbol: this.symbol,
      contractType: contract.contractType,
      amount: stake,
      basis: "stake",
      currency: this.currency,
      duration: this.settings.duration,
      durationUnit: "t",
    };
    void ignoredLegacyBuyShape;

    const contractId = contractIdFromBuy(bought);

    if (!contractId) {
      this.debug("BUY_REJECTED", "Deriv did not return a contract ID.");
      throw new Error("Deriv did not return a contract ID.");
    }

    this.debug("BUY_SENT", contractId);

    this.patch({
      status: "MONITORING",
      message: `Monitoring ${contract.label}.`,
      activeContractId: contractId,
    });

    const settled = await this.waitForSettlement(contractId);
    this.debug("SETTLED", contractId);
    const profit = contractProfit(settled);
    const won = profit > 0;
    const completedAt = Date.now();

    const historyItem = {
      id: `${contractId}-${completedAt}`,
      time: completedAt,
      contractId,
      setup: contract.label,
      stake,
      profit,
      result: won ? "WIN" : "LOSS",
      confidence: safeNumber(
        tradeSignal.qualityScore,
        tradeSignal.confidence
      ),
      expectedValue: safeNumber(
        tradeSignal.expectedValue,
        0
      ),
      probabilityEdge: safeNumber(
        tradeSignal.probabilityEdge,
        0
      ),
      consistency: safeNumber(
        tradeSignal.consistency,
        0
      ),
      source:
        this.settings.contractMode === "AUTO"
          ? tradeSignal.source || "LIVE ANALYSIS"
          : "MANUAL CONTRACT",
    };

    if (!won) {
      this.lastLossSetup = contract.label;
      this.lastLossAt = completedAt;
      this.skipSignalUpdatesRemaining = this.settings.lossSkipSignals;
    }

    this.signalConfirmations = 0;
    this.signalKey = "";
    this.signal = null;
    this.lastSignalUpdatedAt = 0;

    this.debug(
      "REANALYZE",
      "Previous result cleared. Ranking every contract again from fresh ticks."
    );

    this.patch({
      status: won ? "WON" : "LOST",
      message: `${historyItem.result}: ${profit >= 0 ? "+" : ""}${profit.toFixed(2)} ${this.currency}.`,
      runs: this.state.runs + 1,
      wins: this.state.wins + (won ? 1 : 0),
      losses: this.state.losses + (won ? 0 : 1),
      profit: this.state.profit + profit,
      totalStake: this.state.totalStake + stake,
      activeContractId: "",
      signalConfirmations: 0,
      skipSignalsRemaining: this.skipSignalUpdatesRemaining,
      history: [historyItem, ...this.state.history].slice(0, 100),
    });
  }

  waitForSettlement(contractId) {
    return new Promise((resolve, reject) => {
      const key = String(contractId);

      const timeout = window.setTimeout(() => {
        this.contractWaiters.delete(key);
        reject(new Error("Timed out waiting for contract settlement."));
      }, 120000);

      this.contractWaiters.set(key, {
        resolve,
        reject,
        timeout,
      });
    });
  }

  handleContractUpdate(contract = {}) {
    const id = String(
      contract.contract_id ||
        contract.contractId ||
        contract.id ||
        ""
    );

    if (!id || !contractFinished(contract)) {
      return;
    }

    const waiter = this.contractWaiters.get(id);

    if (!waiter) {
      return;
    }

    window.clearTimeout(waiter.timeout);
    this.contractWaiters.delete(id);
    waiter.resolve(contract);
  }

  destroy() {
    this.stop("Bot page closed.");

    for (const waiter of this.contractWaiters.values()) {
      window.clearTimeout(waiter.timeout);
      waiter.reject(new Error("Bot page closed."));
    }

    this.contractWaiters.clear();

    if (this.removeContractListener) {
      this.removeContractListener();
      this.removeContractListener = null;
    }
  }
}
