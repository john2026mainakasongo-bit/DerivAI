
const DEFAULTS = {
  contractMode: "AUTO",
  predictionMode: "AUTO",
  prediction: 2,
  stake: 0.35,
  duration: 1,
  maxRuns: 10,
  unlimited: false,
  stopProfit: 0,
  stopLoss: 0,
  minimumConfidence: 78,
  confirmationUpdates: 3,
  lossCooldownMs: 6000,
  sameSetupBlockMs: 15000,
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

  return ["AUTO", "OVER", "UNDER", "MATCH", "DIFFERS"].includes(mode)
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

  return null;
}

function manualContract(mode, prediction) {
  const digit = clampDigit(prediction);
  return parseSetup(`${normalizeMode(mode)} ${digit}`);
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
  constructor({ client, onState }) {
    this.client = client;
    this.onState =
      typeof onState === "function" ? onState : () => {};

    this.settings = { ...DEFAULTS };
    this.symbol = "";
    this.currency = "USD";
    this.signal = null;
    this.signalKey = "";
    this.signalConfirmations = 0;
    this.lastSignalUpdatedAt = 0;
    this.lastLossSetup = "";
    this.lastLossAt = 0;
    this.running = false;
    this.stopRequested = false;
    this.contractWaiters = new Map();

    this.state = {
      status: "STOPPED",
      message: "Quality Entry Digit Bot is ready.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      totalStake: 0,
      activeSetup: "—",
      activeContractId: "",
      selectedConfidence: 0,
      selectedSource: "—",
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
        Math.min(99, safeNumber(input.minimumConfidence, 78))
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
    };
  }

  setMarket({ symbol, currency }) {
    this.symbol = String(symbol || "");
    this.currency = String(currency || "USD");
  }

  updateSignal(signal) {
    const next = signal || null;
    const nextKey = String(next?.setup || "").trim().toUpperCase();

    if (!nextKey) {
      this.signal = null;
      this.signalKey = "";
      this.signalConfirmations = 0;
      return;
    }

    if (nextKey === this.signalKey) {
      this.signalConfirmations += 1;
    } else {
      this.signalKey = nextKey;
      this.signalConfirmations = 1;
    }

    this.lastSignalUpdatedAt = Date.now();
    this.signal = {
      ...next,
      confirmations: this.signalConfirmations,
      updatedAt: this.lastSignalUpdatedAt,
    };
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
    const confidence = safeNumber(this.signal?.confidence, 0);
    const confirmations = safeNumber(this.signal?.confirmations, 0);
    const fresh =
      Date.now() - safeNumber(this.signal?.updatedAt, 0) <= 5000;

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

    if (
      !this.settings.unlimited &&
      this.state.runs >= this.settings.maxRuns
    ) {
      return "Maximum runs completed.";
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

        const contract = this.selectedContract();

        if (!contract) {
          const confidence = safeNumber(this.signal?.confidence, 0);
          const confirmations = safeNumber(this.signal?.confirmations, 0);

          this.patch({
            status: "SCANNING",
            message:
              `Quality scan: confidence ${confidence.toFixed(1)}% / ` +
              `${this.settings.minimumConfidence}% · confirmations ` +
              `${confirmations}/${this.settings.confirmationUpdates}.`,
            activeSetup: this.signal?.setup || "—",
            selectedConfidence: confidence,
            selectedSource: this.signal?.source || "LIVE ANALYSIS",
          });

          await sleep(180);
          continue;
        }

        await this.openTrade(contract);

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

        await sleep(100);
      }
    } catch (error) {
      this.running = false;
      this.patch({
        status: "ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Quality Entry bot failed.",
        activeContractId: "",
      });
      throw error;
    }
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
      history: [],
    });
  }

  async openTrade(contract) {
    const stake = Number(this.settings.stake.toFixed(2));

    this.patch({
      status: "BUYING",
      message: `Buying ${contract.label} for ${stake.toFixed(2)} ${this.currency}.`,
      activeSetup: contract.label,
      selectedConfidence: safeNumber(
        this.signal?.confidence,
        0
      ),
      selectedSource:
        this.settings.contractMode === "AUTO"
          ? this.signal?.source || "LIVE ANALYSIS"
          : "MANUAL CONTRACT",
    });

    const bought = await this.client.buyContract({
      symbol: this.symbol,
      contractType: contract.contractType,
      barrier: contract.barrier,
      amount: stake,
      basis: "stake",
      currency: this.currency,
      duration: this.settings.duration,
      durationUnit: "t",
    });

    const contractId = contractIdFromBuy(bought);

    if (!contractId) {
      throw new Error("Deriv did not return a contract ID.");
    }

    this.patch({
      status: "MONITORING",
      message: `Monitoring ${contract.label}.`,
      activeContractId: contractId,
    });

    const settled = await this.waitForSettlement(contractId);
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
      confidence: safeNumber(this.signal?.confidence, 0),
      source:
        this.settings.contractMode === "AUTO"
          ? this.signal?.source || "LIVE ANALYSIS"
          : "MANUAL CONTRACT",
    };

    if (!won) {
      this.lastLossSetup = contract.label;
      this.lastLossAt = completedAt;
    }

    this.signalConfirmations = 0;

    this.patch({
      status: won ? "WON" : "LOST",
      message: `${historyItem.result}: ${profit >= 0 ? "+" : ""}${profit.toFixed(2)} ${this.currency}.`,
      runs: this.state.runs + 1,
      wins: this.state.wins + (won ? 1 : 0),
      losses: this.state.losses + (won ? 0 : 1),
      profit: this.state.profit + profit,
      totalStake: this.state.totalStake + stake,
      activeContractId: "",
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
