import { evaluateAnalysisAssistedSignal } from "../analysis/analysisAssistedGate";

const DEFAULTS = {
  maxRuns: 56,
  minConfidence: 80,
  minVotes: 1,
  stake: 1,
  duration: 5,
  delaySeconds: 3,
  takeProfit: 20,
  stopLoss: 10,
  cooldownAfterLosses: 3,
  cooldownSeconds: 60,
  hardStopLossStreak: 6,
  martingaleEnabled: false,
  maxMartingaleSteps: 3,
  recoveryMultipliers: [1.7, 2.2, 2.8],
  analysisAssisted: true,
  contractMode: "AUTO",
  prediction: 2,
  durationUnit: "t",
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
        Math.min(95, number(input.minConfidence, 75))
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
        Math.min(60, number(input.delaySeconds, 3))
      ),
      takeProfit: Math.max(0, number(input.takeProfit, 20)),
      stopLoss: Math.max(0, number(input.stopLoss, 10)),
      cooldownAfterLosses: Math.max(
        1,
        Math.min(10, number(input.cooldownAfterLosses, 3))
      ),
      cooldownSeconds: Math.max(
        10,
        Math.min(900, number(input.cooldownSeconds, 60))
      ),
      hardStopLossStreak: Math.max(
        2,
        Math.min(20, number(input.hardStopLossStreak, 6))
      ),
      maxMartingaleSteps: Math.max(
        0,
        Math.min(3, number(input.maxMartingaleSteps, 3))
      ),
      recoveryMultipliers: DEFAULTS.recoveryMultipliers,
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
      return {
        ok: false,
        reason: "Waiting for market analysis.",
        elapsedSeconds: 0,
      };
    }

    const analysis = signal.analysis || {};

    if (this.settings.analysisAssisted === false) {
      return {
        ok: false,
        reason: "Analysis Assisted is disabled.",
        elapsedSeconds: 0,
      };
    }

    const gate = evaluateAnalysisAssistedSignal(analysis, {
      minimumConfidence: this.settings.minConfidence,
      contractMode: this.settings.contractMode,
      prediction: this.settings.prediction,
      durationUnit: this.settings.durationUnit,
    });

    const startedAt =
      Number(this.state.scanStartedAt) > 0
        ? Number(this.state.scanStartedAt)
        : Date.now();

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - startedAt) / 1000)
    );

    if (!gate.approved) {
      return {
        ok: false,
        reason: gate.reason,
        elapsedSeconds,
        gate,
      };
    }

    const contract = contractFromSetup(gate.setup);

    if (!contract) {
      return {
        ok: false,
        reason: `Unsupported analysis setup: ${gate.setup}.`,
        elapsedSeconds,
        gate,
      };
    }

    return {
      ok: true,
      mode: "V10_FLEX",
      decision: {
        setup: gate.setup,
        bestContract: gate.setup,
        confidence: gate.confidence,
        professionalScore: gate.confidence,
        marketQuality: 0,
        riskLevel: "ANALYSIS",
        passedCount: gate.candidates.filter(
          (item) => item.approved
        ).length,
        validated: true,
        gateReason: gate.reason,
      },
      timing: {
        state: "ENTER",
        readyNow: true,
      },
      contract,
      elapsedSeconds,
      gate,
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
      message:
        "Analysis Assisted scanning. It will enter immediately when a contract-aware setup is approved.",
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
      history: [],
    };

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

    this.patch({
      status: "BUYING",
      message:
        `Analysis Assisted approved ${check.contract.label} for ${durationText(
          this.settings.duration,
          this.settings.durationUnit
        )}. Requesting ${stake.toFixed(2)} ${this.currency}.`,
      activeSetup: `${check.contract.label} · ANALYSIS ASSISTED`,
    });

    const bought = await this.client.buyContract({
      symbol: this.symbol,
      contractType: check.contract.contractType,
      barrier: check.contract.barrier,
      amount: stake,
      basis: "stake",
      currency: this.currency,
      duration: this.settings.duration,
      durationUnit: this.settings.durationUnit,
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

    const settled = await this.waitForContract(
      this.activeContractId,
      this.settings.duration,
      this.settings.durationUnit
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

    this.addHistory({
      id: this.activeContractId,
      time: Date.now(),
      setup: check.contract.label,
      result: won ? "WIN" : "LOSS",
      profit,
      stake,
      payout: details.payout,
      buyPrice: details.buyPrice,
      sellPrice: details.sellPrice,
      entrySpot: details.entrySpot,
      exitSpot: details.exitSpot,
      duration: this.settings.duration,
      durationUnit: this.settings.durationUnit,
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
      executionMode: check.mode || "BALANCED",
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
          `Risk cooldown triggered after ${consecutiveLosses} consecutive losses.`,
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
