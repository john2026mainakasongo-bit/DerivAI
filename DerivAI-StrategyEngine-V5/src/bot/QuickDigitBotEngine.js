
const DEFAULTS = {
  contractMode: "OVER",
  prediction: 2,
  stake: 0.35,
  duration: 5,
  maxRuns: 10,
  delayMs: 100,
};

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeMode(value) {
  const mode = String(value || "").toUpperCase();
  return ["OVER", "UNDER", "MATCH", "DIFFERS"].includes(mode)
    ? mode
    : "OVER";
}

function contractFromMode(mode, prediction) {
  const digit = Math.max(0, Math.min(9, Math.floor(number(prediction, 2))));

  switch (normalizeMode(mode)) {
    case "UNDER":
      return {
        label: `UNDER ${digit}`,
        contractType: "DIGITUNDER",
        barrier: String(digit),
      };
    case "MATCH":
      return {
        label: `MATCH ${digit}`,
        contractType: "DIGITMATCH",
        barrier: String(digit),
      };
    case "DIFFERS":
      return {
        label: `DIFFERS ${digit}`,
        contractType: "DIGITDIFF",
        barrier: String(digit),
      };
    default:
      return {
        label: `OVER ${digit}`,
        contractType: "DIGITOVER",
        barrier: String(digit),
      };
  }
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

function isFinished(contract = {}) {
  return Boolean(
    contract.is_sold ||
      contract.is_expired ||
      contract.status === "won" ||
      contract.status === "lost" ||
      contract.status === "sold"
  );
}

function profitFromContract(contract = {}) {
  return number(
    contract.profit ??
      contract.sell_price - contract.buy_price ??
      contract.payout - contract.buy_price,
    0
  );
}

export default class QuickDigitBotEngine {
  constructor({ client, onState }) {
    this.client = client;
    this.onState = typeof onState === "function" ? onState : () => {};

    this.settings = { ...DEFAULTS };
    this.symbol = "";
    this.currency = "USD";
    this.running = false;
    this.stopRequested = false;
    this.contractWaiters = new Map();

    this.state = {
      status: "IDLE",
      message: "Quick Digit Bot is ready.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      activeContractId: "",
      activeSetup: "—",
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
      prediction: Math.max(
        0,
        Math.min(9, Math.floor(number(input.prediction, 2)))
      ),
      stake: Math.max(0.35, number(input.stake, 0.35)),
      duration: Math.max(1, Math.min(10, Math.floor(number(input.duration, 5)))),
      maxRuns: Math.max(1, Math.min(1000, Math.floor(number(input.maxRuns, 10)))),
      delayMs: Math.max(0, Math.min(10000, Math.floor(number(input.delayMs, 100)))),
    };
  }

  setMarket({ symbol, currency }) {
    this.symbol = String(symbol || "");
    this.currency = String(currency || "USD");
  }

  async start() {
    if (this.running) return;
    if (!this.symbol) {
      throw new Error("Select a Deriv market first.");
    }

    this.running = true;
    this.stopRequested = false;

    this.patch({
      status: "RUNNING",
      message: "Run pressed. Opening the selected contract immediately.",
    });

    try {
      while (
        this.running &&
        !this.stopRequested &&
        this.state.runs < this.settings.maxRuns
      ) {
        await this.openOneTrade();

        if (
          this.running &&
          !this.stopRequested &&
          this.state.runs < this.settings.maxRuns &&
          this.settings.delayMs > 0
        ) {
          await wait(this.settings.delayMs);
        }
      }

      if (this.state.runs >= this.settings.maxRuns) {
        this.stop("Maximum runs completed.", "COMPLETED");
      }
    } catch (error) {
      this.running = false;
      this.patch({
        status: "ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Quick Digit Bot failed.",
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
      status: "IDLE",
      message: "Quick Digit Bot statistics reset.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      activeContractId: "",
      activeSetup: "—",
      history: [],
    });
  }

  async openOneTrade() {
    const contract = contractFromMode(
      this.settings.contractMode,
      this.settings.prediction
    );

    const stake = Number(this.settings.stake.toFixed(2));

    this.patch({
      status: "BUYING",
      message: `Buying ${contract.label} now for ${stake.toFixed(2)} ${this.currency}.`,
      activeSetup: contract.label,
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
      message: `Monitoring ${contract.label} contract ${contractId}.`,
      activeContractId: contractId,
    });

    const settled = await this.waitForContract(contractId);
    const profit = profitFromContract(settled);
    const won = profit > 0;

    const run = this.state.runs + 1;
    const item = {
      id: `${contractId}-${Date.now()}`,
      contractId,
      setup: contract.label,
      stake,
      profit,
      result: won ? "WIN" : "LOSS",
      completedAt: new Date().toISOString(),
    };

    this.patch({
      status: won ? "WON" : "LOST",
      message: `${won ? "Won" : "Lost"} ${profit.toFixed(2)} ${this.currency}. Starting the next run immediately.`,
      runs: run,
      wins: this.state.wins + (won ? 1 : 0),
      losses: this.state.losses + (won ? 0 : 1),
      profit: this.state.profit + profit,
      activeContractId: "",
      history: [item, ...this.state.history].slice(0, 50),
    });
  }

  waitForContract(contractId) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.contractWaiters.delete(String(contractId));
        reject(new Error("Timed out waiting for contract settlement."));
      }, 120000);

      this.contractWaiters.set(String(contractId), {
        resolve,
        reject,
        timeout,
      });
    });
  }

  handleContractUpdate(contract) {
    const id = String(
      contract.contract_id ||
        contract.id ||
        contract.contractId ||
        ""
    );

    if (!id || !isFinished(contract)) return;

    const waiter = this.contractWaiters.get(id);
    if (!waiter) return;

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
