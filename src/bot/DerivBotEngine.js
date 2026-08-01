const DEFAULTS = {
  maxRuns: 56,
  minConfidence: 75,
  minVotes: 3,
  stake: 1,
  duration: 5,
  delaySeconds: 3,
  takeProfit: 20,
  stopLoss: 10,
  maxConsecutiveLosses: 3,
  martingaleEnabled: false,
  martingaleMultiplier: 2,
  maxMartingaleSteps: 3,
};

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

    this.state = {
      status: "IDLE",
      message: "Bot is ready.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      consecutiveLosses: 0,
      martingaleStep: 0,
      currentStake: DEFAULTS.stake,
      activeSetup: "—",
      activeContractId: "",
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
    this.settings = {
      ...DEFAULTS,
      ...input,
      maxRuns: Math.max(1, Math.min(1000, number(input.maxRuns, 56))),
      minConfidence: Math.max(50, Math.min(99, number(input.minConfidence, 75))),
      minVotes: Math.max(1, Math.min(10, number(input.minVotes, 3))),
      stake: Math.max(0.35, number(input.stake, 1)),
      duration: Math.max(1, Math.min(10, number(input.duration, 5))),
      delaySeconds: Math.max(0, Math.min(60, number(input.delaySeconds, 3))),
      takeProfit: Math.max(0, number(input.takeProfit, 20)),
      stopLoss: Math.max(0, number(input.stopLoss, 10)),
      maxConsecutiveLosses: Math.max(
        1,
        Math.min(20, number(input.maxConsecutiveLosses, 3))
      ),
      martingaleMultiplier: Math.max(
        1,
        Math.min(5, number(input.martingaleMultiplier, 2))
      ),
      maxMartingaleSteps: Math.max(
        0,
        Math.min(10, number(input.maxMartingaleSteps, 3))
      ),
    };

    if (!this.running) {
      this.patch({
        currentStake: this.settings.stake,
      });
    }
  }

  setMarket({ symbol, currency = "USD" }) {
    this.symbol = String(symbol || "");
    this.currency = String(currency || "USD");
  }

  updateSignal(signal) {
    this.signal = signal;
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
      return { ok: false, reason: "Waiting for market analysis." };
    }

    const decision = signal.professionalDecision || {};
    const timing = signal.entryTiming || {};

    if (!decision.validated) {
      return { ok: false, reason: "Professional decision is not validated." };
    }

    if (number(decision.confidence) < this.settings.minConfidence) {
      return {
        ok: false,
        reason: `Confidence ${number(decision.confidence).toFixed(
          1
        )}% is below ${this.settings.minConfidence}%.`,
      };
    }

    if (number(decision.passedCount) < this.settings.minVotes) {
      return {
        ok: false,
        reason: `Votes ${number(decision.passedCount)} are below ${
          this.settings.minVotes
        }.`,
      };
    }

    const timingState = String(timing.state || "").toUpperCase();
    const readyNow = timing.readyNow === true || timingState === "ENTER NOW";

    if (!readyNow) {
      return {
        ok: false,
        reason: timing.instruction || `Entry timing is ${timingState || "WAIT"}.`,
      };
    }

    const contract = contractFromSetup(decision.setup);

    if (!contract) {
      return {
        ok: false,
        reason: `Unsupported setup: ${decision.setup || "WAIT"}.`,
      };
    }

    return {
      ok: true,
      decision,
      timing,
      contract,
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

    this.patch({
      status: "RUNNING",
      message: "Bot started. Waiting for a validated setup.",
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

  stop(message = "Bot stopped.") {
    this.stopping = true;
    this.running = false;
    this.paused = false;

    this.contractWaiters.forEach((waiter) => {
      window.clearTimeout(waiter.timeout);
      waiter.reject(new Error("Bot stopped."));
    });

    this.contractWaiters.clear();

    this.patch({
      status: "STOPPED",
      message,
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
      consecutiveLosses: 0,
      martingaleStep: 0,
      currentStake: this.settings.stake,
      activeSetup: "—",
      activeContractId: "",
      history: [],
    };

    this.onState(this.snapshot());
  }

  riskStopReason() {
    if (this.state.runs >= this.settings.maxRuns) {
      return `Maximum runs reached: ${this.settings.maxRuns}.`;
    }

    if (
      this.settings.takeProfit > 0 &&
      this.state.profit >= this.settings.takeProfit
    ) {
      return `Take profit reached: ${this.state.profit.toFixed(2)} ${
        this.currency
      }.`;
    }

    if (
      this.settings.stopLoss > 0 &&
      this.state.profit <= -this.settings.stopLoss
    ) {
      return `Stop loss reached: ${this.state.profit.toFixed(2)} ${
        this.currency
      }.`;
    }

    if (
      this.state.consecutiveLosses >=
      this.settings.maxConsecutiveLosses
    ) {
      return `Stopped after ${this.state.consecutiveLosses} consecutive losses.`;
    }

    return "";
  }

  async loop() {
    while (this.running && !this.stopping) {
      const stopReason = this.riskStopReason();

      if (stopReason) {
        this.stop(stopReason);
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
        });

        await sleep(1000);
        continue;
      }

      try {
        await this.executeTrade(check);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Trade execution failed.";

        this.addHistory({
          id: `error-${Date.now()}`,
          time: Date.now(),
          setup: check.contract.label,
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

      if (this.running && this.settings.delaySeconds > 0) {
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
    });
  }

  async executeTrade(check) {
    const stake = Number(this.state.currentStake.toFixed(2));

    this.patch({
      status: "BUYING",
      message: `Requesting ${check.contract.label} proposal for ${stake.toFixed(
        2
      )} ${this.currency}.`,
      activeSetup: check.contract.label,
    });

    const bought = await this.client.buyContract({
      symbol: this.symbol,
      contractType: check.contract.contractType,
      barrier: check.contract.barrier,
      amount: stake,
      basis: "stake",
      currency: this.currency,
      duration: this.settings.duration,
      durationUnit: "t",
    });

    if (!bought.contractId) {
      throw new Error("Deriv did not return a contract ID.");
    }

    this.activeContractId = String(bought.contractId);

    this.patch({
      status: "MONITORING",
      message: `Monitoring contract ${this.activeContractId}.`,
      activeContractId: this.activeContractId,
    });

    const settled = await this.waitForContract(this.activeContractId);
    const profit = contractProfit(settled);
    const won = profit > 0;

    const runs = this.state.runs + 1;
    const wins = this.state.wins + (won ? 1 : 0);
    const losses = this.state.losses + (won ? 0 : 1);
    const totalProfit = this.state.profit + profit;
    const consecutiveLosses = won ? 0 : this.state.consecutiveLosses + 1;

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
        Math.pow(this.settings.martingaleMultiplier, martingaleStep);
    }

    this.addHistory({
      id: this.activeContractId,
      time: Date.now(),
      setup: check.contract.label,
      result: won ? "WIN" : "LOSS",
      profit,
      stake,
      contractId: this.activeContractId,
      confidence: number(check.decision.confidence),
    });

    this.activeContractId = "";

    this.patch({
      status: won ? "WON" : "LOST",
      message: `${won ? "Won" : "Lost"} ${profit.toFixed(2)} ${
        this.currency
      }. Run ${runs}/${this.settings.maxRuns}.`,
      runs,
      wins,
      losses,
      profit: totalProfit,
      consecutiveLosses,
      martingaleStep,
      currentStake: Math.max(0.35, Number(nextStake.toFixed(2))),
      activeContractId: "",
    });
  }

  waitForContract(contractId) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.contractWaiters.delete(String(contractId));
        reject(new Error("Timed out while waiting for contract settlement."));
      }, 120000);

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
