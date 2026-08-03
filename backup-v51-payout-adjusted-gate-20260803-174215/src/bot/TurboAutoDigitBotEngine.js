
function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function contractForCandidate(candidate = {}) {
  const mode = String(candidate.mode || "").toUpperCase();

  if (mode === "OVER") {
    return { contractType: "DIGITOVER", barrier: String(candidate.prediction) };
  }
  if (mode === "UNDER") {
    return { contractType: "DIGITUNDER", barrier: String(candidate.prediction) };
  }
  if (mode === "EVEN") return { contractType: "DIGITEVEN" };
  if (mode === "ODD") return { contractType: "DIGITODD" };
  if (mode === "DIFFERS") {
    return { contractType: "DIGITDIFF", barrier: String(candidate.prediction) };
  }

  return null;
}

function finished(contract = {}) {
  const status = String(contract.status || "").toLowerCase();
  return Boolean(
    contract.is_sold ||
      contract.is_expired ||
      ["sold", "won", "lost", "expired", "cancelled"].includes(status)
  );
}

function profitOf(contract = {}) {
  const value = Number(
    contract.profit ??
      contract.profit_loss ??
      contract.pnl ??
      Number(contract.sell_price || 0) - Number(contract.buy_price || 0)
  );
  return Number.isFinite(value) ? value : 0;
}

export default class TurboAutoDigitBotEngine {
  constructor({ client, onState, onRequestMarketSwitch }) {
    this.client = client;
    this.onState = typeof onState === "function" ? onState : () => {};
    this.onRequestMarketSwitch =
      typeof onRequestMarketSwitch === "function"
        ? onRequestMarketSwitch
        : async () => null;

    this.settings = {};
    this.signal = null;
    this.symbol = "";
    this.currency = "USD";
    this.accountType = "demo";
    this.running = false;
    this.stopping = false;
    this.busy = false;
    this.signalVersion = 0;
    this.lastSignalKey = "";
    this.lockedSetup = "";
    this.confirmations = 0;
    this.noSignalSince = 0;
    this.lastTradeAt = 0;
    this.blockedSetups = new Map();
    this.contractWaiters = new Map();

    this.state = {
      status: "STOPPED",
      message: "Dynamic Digit AI is ready.",
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
      entryCountdown: 0,
      debugSteps: [],
      marketSwitches: 0,
      history: [],
      lastCompletedConfidence: 0,
      lastCompletedRisk: "—",
      lastCompletedSetup: "—",
    };

    this.removeContractListener = this.client.onContract((contract) => {
      const id = String(contract?.contract_id || contract?.id || "");
      const waiter = this.contractWaiters.get(id);
      if (!waiter || !finished(contract)) return;

      window.clearTimeout(waiter.timeout);
      this.contractWaiters.delete(id);
      waiter.resolve(contract);
    });
  }

  patch(next = {}) {
    this.state = { ...this.state, ...next };
    this.onState({ ...this.state });
  }

  configure(settings = {}) {
    this.settings = {
      stake: Math.max(0.35, Number(settings.stake || 0.35)),
      duration: 1,
      maxRuns: Math.max(1, Number(settings.maxRuns || 5)),
      unlimited: Boolean(settings.unlimited),
      stopProfit: Math.max(0, Number(settings.stopProfit || 0)),
      stopLoss: Math.max(0, Number(settings.stopLoss || 0.35)),
      confirmationUpdates: Math.max(
        1,
        Number(settings.confirmationUpdates || 1)
      ),
      maximumSignalAgeMs: Math.max(
        1500,
        Number(settings.maximumSignalAgeMs || 3500)
      ),
      scanSwitchMs: Math.max(
        4000,
        Number(settings.scanSwitchMs || 12000)
      ),
      postTradeDelayMs: Math.max(
        0,
        Number(settings.postTradeDelayMs || 250)
      ),
      sameSetupBlockMs: Math.max(
        3000,
        Number(settings.sameSetupBlockMs || 15000)
      ),
      lossCooldownMs: Math.max(
        3000,
        Number(settings.lossCooldownMs || 6000)
      ),
    };
  }

  setMarket({ symbol, currency = "USD" }) {
    const changed = this.symbol && symbol && this.symbol !== symbol;
    this.symbol = String(symbol || "");
    this.currency = String(currency || "USD");

    if (changed) {
      this.signal = null;
      this.lockedSetup = "";
      this.confirmations = 0;
      this.noSignalSince = Date.now();
    }
  }

  setAccountType(type = "demo") {
    this.accountType = String(type || "demo").toLowerCase();
  }

  updateSignal(signal) {
    this.signal = signal
      ? { ...signal, updatedAt: Date.now() }
      : null;

    const key = signal
      ? `${signal.setup}:${Number(signal.qualityScore || 0).toFixed(2)}:${signal.sampleSize}:${signal.transitionSamples}`
      : "WAIT";

    if (key !== this.lastSignalKey) {
      this.lastSignalKey = key;
      this.signalVersion += 1;
    }
  }

  async start() {
    if (this.running) return;
    if (!this.symbol) {
      throw new Error("Connect Deriv and select a market first.");
    }

    this.running = true;
    this.stopping = false;
    this.noSignalSince = Date.now();
    this.lockedSetup = "";
    this.confirmations = 0;

    this.patch({
      status: "RUNNING",
      executionPhase: "SCANNING",
      message:
        "Dynamic Digit AI is scanning OVER/UNDER, EVEN/ODD and DIFFERS. RISE/FALL is disabled.",
    });

    void this.loop();
  }

  stop(message = "Bot stopped.") {
    this.running = false;
    this.stopping = true;
    this.patch({
      status: "STOPPED",
      executionPhase: "IDLE",
      message,
      activeSetup: "—",
      activeContractId: "",
    });
  }

  reset() {
    if (this.running) return;
    this.state = {
      ...this.state,
      status: "STOPPED",
      message: "Statistics reset.",
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
      executionPhase: "IDLE",
      debugSteps: [],
      marketSwitches: 0,
      history: [],
      lastCompletedConfidence: 0,
      lastCompletedRisk: "—",
      lastCompletedSetup: "—",
    };
    this.onState({ ...this.state });
  }

  destroy() {
    this.stop("Bot page closed.");
    if (this.removeContractListener) {
      this.removeContractListener();
      this.removeContractListener = null;
    }
  }

  riskStop() {
    if (!this.settings.unlimited && this.state.runs >= this.settings.maxRuns) {
      return `Completed ${this.settings.maxRuns} runs.`;
    }
    if (
      this.settings.stopProfit > 0 &&
      this.state.profit >= this.settings.stopProfit
    ) {
      return `Take profit reached: ${this.state.profit.toFixed(2)} ${this.currency}.`;
    }
    if (
      this.settings.stopLoss > 0 &&
      this.state.profit <= -this.settings.stopLoss
    ) {
      return `Stop loss reached: ${this.state.profit.toFixed(2)} ${this.currency}.`;
    }
    return "";
  }

  candidateReady(signal) {
    if (!signal?.executable) return false;
    if (!contractForCandidate(signal)) return false;

    const blockedUntil = Number(
      this.blockedSetups.get(signal.setup) || 0
    );
    if (blockedUntil > Date.now()) return false;

    const real = this.accountType !== "demo";
    if (real) {
      return (
        Number(signal.qualityScore || 0) >= 82 &&
        Number(signal.sampleSize || 0) >= 100 &&
        Number(signal.consistency || 0) >= 70 &&
        Number(signal.voteCount || 0) >= 4
      );
    }

    return (
      Number(signal.qualityScore || 0) >= 70 &&
      Number(signal.sampleSize || 0) >= 50 &&
      Number(signal.voteCount || 0) >= 3
    );
  }

  async loop() {
    while (this.running && !this.stopping) {
      const stop = this.riskStop();
      if (stop) {
        this.stop(stop);
        return;
      }

      if (this.busy) {
        await sleep(120);
        continue;
      }

      const signal = this.signal;

      if (!this.candidateReady(signal)) {
        this.lockedSetup = "";
        this.confirmations = 0;

        const waited = Date.now() - this.noSignalSince;
        this.patch({
          status: "SCANNING",
          executionPhase: "SCANNING",
          message:
            signal?.reason ||
            `No qualified digit entry. Market switch in ${Math.max(
              0,
              Math.ceil((this.settings.scanSwitchMs - waited) / 1000)
            )}s.`,
          activeSetup: signal?.setup || "—",
          selectedConfidence: Number(signal?.qualityScore || 0),
          selectedQuality: Number(signal?.qualityScore || 0),
          selectedSource: signal?.source || "—",
          signalConfirmations: 0,
        });

        if (waited >= this.settings.scanSwitchMs) {
          this.patch({
            status: "SWITCHING",
            executionPhase: "SWITCHING",
            message: "No qualified digit entry. Switching volatility market.",
          });

          try {
            const switched = await this.onRequestMarketSwitch();
            this.noSignalSince = Date.now();
            this.lockedSetup = "";
            this.confirmations = 0;
            this.patch({
              status: "SCANNING",
              executionPhase: "SCANNING",
              marketSwitches: this.state.marketSwitches + 1,
              message: `Scanning ${switched?.label || "new market"} for digit entries.`,
            });
            await sleep(900);
          } catch (error) {
            this.noSignalSince = Date.now();
            this.patch({
              status: "ERROR",
              message:
                error instanceof Error
                  ? error.message
                  : "Market switch failed.",
            });
            await sleep(1500);
          }
        } else {
          await sleep(120);
        }

        continue;
      }

      if (this.lockedSetup !== signal.setup) {
        this.lockedSetup = signal.setup;
        this.confirmations = 0;
        this.lockedVersion = this.signalVersion;

        this.patch({
          status: "CONFIRMING",
          executionPhase: "LOCKED",
          activeSetup: signal.setup,
          signalConfirmations: 0,
          selectedConfidence: Number(signal.qualityScore || 0),
          selectedQuality: Number(signal.qualityScore || 0),
          selectedSource: signal.source || "—",
          message: `${signal.setup} found. Waiting for one fresh confirmation.`,
        });

        await sleep(100);
        continue;
      }

      this.confirmations = Math.max(
        0,
        this.signalVersion - Number(this.lockedVersion || 0)
      );

      if (this.confirmations < this.settings.confirmationUpdates) {
        this.patch({
          status: "CONFIRMING",
          executionPhase: "CONFIRMING",
          signalConfirmations: this.confirmations,
          message: `${signal.setup} confirming ${this.confirmations}/${this.settings.confirmationUpdates}.`,
        });
        await sleep(100);
        continue;
      }

      await this.execute(signal);
    }
  }

  async execute(signal) {
    const contract = contractForCandidate(signal);
    if (!contract) return;

    this.busy = true;
    const stake =
      this.accountType === "demo"
        ? this.settings.stake
        : Math.min(this.settings.stake, 0.35);

    try {
      this.patch({
        status: "BUYING",
        executionPhase: "PROPOSAL",
        activeSetup: signal.setup,
        message: `${signal.setup} confirmed. Requesting proposal and buy.`,
      });

      const bought = await this.client.buyContract({
        symbol: this.symbol,
        contractType: contract.contractType,
        barrier: contract.barrier,
        amount: stake,
        basis: "stake",
        currency: this.currency,
        duration: 1,
        durationUnit: "t",
      });

      const contractId = String(bought?.contractId || "");
      if (!contractId) {
        throw new Error("Deriv did not return a contract ID.");
      }

      this.patch({
        status: "MONITORING",
        executionPhase: "MONITORING",
        activeContractId: contractId,
        message: `${signal.setup} contract ${contractId} is open.`,
      });

      const settled = await this.waitForContract(contractId);
      const profit = profitOf(settled);
      const won = profit > 0;
      const runs = this.state.runs + 1;
      const wins = this.state.wins + (won ? 1 : 0);
      const losses = this.state.losses + (won ? 0 : 1);
      const totalProfit = this.state.profit + profit;

      if (!won) {
        this.blockedSetups.set(
          signal.setup,
          Date.now() + this.settings.sameSetupBlockMs
        );
      }

      this.patch({
        status: won ? "WON" : "LOST",
        executionPhase: "SETTLED",
        message: `${won ? "Won" : "Lost"} ${profit.toFixed(2)} ${this.currency}. Scanning next entry.`,
        runs,
        wins,
        losses,
        profit: totalProfit,
        totalStake: this.state.totalStake + stake,
        activeContractId: "",
        activeSetup: "—",
        lastCompletedSetup: signal.setup,
        lastCompletedConfidence: Number(signal.qualityScore || 0),
        lastCompletedRisk:
          Number(signal.qualityScore || 0) >= 88 ? "LOW" : "MEDIUM",
        history: [
          {
            id: contractId,
            time: Date.now(),
            setup: signal.setup,
            result: won ? "WIN" : "LOSS",
            profit,
            stake,
            confidence: Number(signal.qualityScore || 0),
            symbol: this.symbol,
          },
          ...this.state.history,
        ].slice(0, 100),
      });

      this.noSignalSince = Date.now();
      this.lockedSetup = "";
      this.confirmations = 0;
      this.lastTradeAt = Date.now();

      await sleep(
        won
          ? this.settings.postTradeDelayMs
          : this.settings.lossCooldownMs
      );
    } catch (error) {
      this.patch({
        status: "ERROR",
        executionPhase: "ERROR",
        activeContractId: "",
        message:
          error instanceof Error
            ? error.message
            : "Trade execution failed.",
        debugSteps: [
          {
            time: Date.now(),
            message:
              error instanceof Error
                ? error.message
                : "Trade execution failed.",
          },
          ...this.state.debugSteps,
        ].slice(0, 30),
      });
      this.lockedSetup = "";
      this.confirmations = 0;
      await sleep(1500);
    } finally {
      this.busy = false;
    }
  }

  waitForContract(contractId, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.contractWaiters.delete(String(contractId));
        reject(new Error("Contract settlement timed out."));
      }, timeoutMs);

      this.contractWaiters.set(String(contractId), {
        resolve,
        reject,
        timeout,
      });
    });
  }
}
