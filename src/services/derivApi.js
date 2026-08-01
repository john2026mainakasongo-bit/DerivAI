const SOCKET_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const FALLBACK_MARKETS = [
  { id: "R_10", label: "Volatility 10 Index", decimals: 3 },
  { id: "1HZ10V", label: "Volatility 10 (1s) Index", decimals: 2 },
  { id: "R_25", label: "Volatility 25 Index", decimals: 3 },
  { id: "1HZ25V", label: "Volatility 25 (1s) Index", decimals: 2 },
  { id: "R_50", label: "Volatility 50 Index", decimals: 4 },
  { id: "1HZ50V", label: "Volatility 50 (1s) Index", decimals: 2 },
  { id: "R_75", label: "Volatility 75 Index", decimals: 4 },
  { id: "1HZ75V", label: "Volatility 75 (1s) Index", decimals: 2 },
  { id: "R_100", label: "Volatility 100 Index", decimals: 2 },
  { id: "1HZ100V", label: "Volatility 100 (1s) Index", decimals: 2 },
];

function decimalsFromPip(pip, fallback = 3) {
  const value = Number(pip);
  if (!Number.isFinite(value) || value <= 0) return fallback;

  const text = String(value);
  if (text.includes("e-")) return Number(text.split("e-")[1]) || fallback;

  const decimal = text.split(".")[1];
  return decimal ? decimal.length : 0;
}

function normalizeMarket(item = {}) {
  const id = String(
    item.symbol ||
      item.underlying_symbol ||
      item.symbol_code ||
      item.id ||
      ""
  ).trim();

  const label = String(
    item.display_name ||
      item.underlying_symbol_name ||
      item.name ||
      item.label ||
      id
  ).trim();

  const decimals = Number.isFinite(Number(item.decimals))
    ? Number(item.decimals)
    : decimalsFromPip(item.pip ?? item.pip_size, 3);

  return {
    id,
    symbol: id,
    label,
    short: label
      .replace(/^Volatility\s*/i, "V")
      .replace(/\s*Index$/i, "")
      .replace(/\s+/g, " "),
    decimals,
    raw: item,
  };
}

function isVolatilityMarket(item = {}) {
  const market = normalizeMarket(item);
  const text = [
    market.id,
    market.label,
    item.market,
    item.market_display_name,
    item.submarket,
    item.submarket_display_name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    (text.includes("volatility") ||
      /^R_\d+$/i.test(market.id) ||
      /^1HZ\d+V$/i.test(market.id)) &&
    !/(crash|boom|step|jump)/i.test(text)
  );
}

function marketOrder(market) {
  const text = `${market.label} ${market.id}`;
  const match =
    text.match(/volatility\s*(\d+)/i) ||
    market.id.match(/(?:1HZ)?(\d+)V$/i) ||
    market.id.match(/^R_(\d+)$/i);

  return match ? Number(match[1]) : 9999;
}

class DerivPublicClient {
  constructor() {
    this.socket = null;
    this.requestId = 0;
    this.pending = new Map();
    this.statusListeners = new Set();
    this.tickListeners = new Set();
    this.activeSymbol = "";
    this.subscriptionId = "";
    this.pingTimer = null;
    this.manualClose = false;
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onTick(listener) {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  emitStatus(status, detail = "") {
    this.statusListeners.forEach((listener) => listener({ status, detail }));
  }

  request(payload, timeoutMs = 15000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Deriv WebSocket is not connected."));
    }

    const reqId = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`${Object.keys(payload)[0]} request timed out.`));
      }, timeoutMs);

      this.pending.set(reqId, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    const pending = this.pending.get(message.req_id);

    if (message.error) {
      if (pending) {
        window.clearTimeout(pending.timeout);
        this.pending.delete(message.req_id);
        pending.reject(
          new Error(message.error.message || message.error.code || "Deriv API error.")
        );
      }
      return;
    }

    if (pending) {
      window.clearTimeout(pending.timeout);
      this.pending.delete(message.req_id);
      pending.resolve(message);
    }

    const tick = message.tick || message.data?.tick;
    if (!tick) return;

    const quote = Number(tick.quote ?? tick.price);
    if (!Number.isFinite(quote)) return;

    this.subscriptionId = String(
      message.subscription?.id ||
        message.subscription_id ||
        this.subscriptionId
    );

    this.tickListeners.forEach((listener) =>
      listener({
        symbol: String(tick.symbol || tick.underlying_symbol || this.activeSymbol),
        quote,
        epoch: Number(tick.epoch || tick.timestamp || Date.now() / 1000),
      })
    );
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;

    this.manualClose = false;
    this.emitStatus("CONNECTING");

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(SOCKET_URL);
      this.socket = socket;

      const timeout = window.setTimeout(() => {
        try {
          socket.close();
        } catch {}
        reject(new Error("Deriv connection timed out."));
      }, 15000);

      socket.onopen = () => {
        window.clearTimeout(timeout);
        this.emitStatus("CONNECTED");
        this.pingTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ ping: 1 }));
          }
        }, 30000);
        resolve();
      };

      socket.onmessage = (event) => this.handleMessage(event);

      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Unable to connect to Deriv public feed."));
      };

      socket.onclose = () => {
        window.clearTimeout(timeout);
        if (this.pingTimer) window.clearInterval(this.pingTimer);
        this.pingTimer = null;

        this.pending.forEach((item) => {
          window.clearTimeout(item.timeout);
          item.reject(new Error("Deriv WebSocket disconnected."));
        });

        this.pending.clear();
        this.socket = null;
        this.subscriptionId = "";
        this.activeSymbol = "";

        this.emitStatus(
          this.manualClose ? "DISCONNECTED" : "OFFLINE",
          this.manualClose ? "" : "Deriv connection closed."
        );
      };
    });
  }

  async getHistory(symbol, count = 100) {
    const response = await this.request({
      ticks_history: symbol,
      count,
      end: "latest",
      style: "ticks",
      adjust_start_time: 1,
    });

    const history = response.history || response.data?.history || {};
    const prices = Array.isArray(history.prices)
      ? history.prices.map(Number).filter(Number.isFinite)
      : [];
    const times = Array.isArray(history.times) ? history.times.map(Number) : [];

    return prices.map((quote, index) => ({
      quote,
      epoch: times[index] || 0,
    }));
  }

  async probeFallbackMarkets() {
    const valid = [];

    for (const candidate of FALLBACK_MARKETS) {
      try {
        const history = await this.getHistory(candidate.id, 2);
        if (history.length) valid.push(normalizeMarket(candidate));
      } catch {
        // This symbol is unavailable on the current endpoint.
      }
    }

    return valid;
  }

  async getVolatilityMarkets() {
    let symbols = [];

    try {
      const response = await this.request({
        active_symbols: "brief",
        product_type: "basic",
      });

      const raw =
        response.active_symbols ||
        response.data?.active_symbols ||
        response.data ||
        [];

      symbols = Array.isArray(raw) ? raw : [];
    } catch {
      // Fall through to symbol probing.
    }

    let markets = symbols
      .filter(isVolatilityMarket)
      .map(normalizeMarket)
      .filter((item) => item.id);

    if (!markets.length) {
      markets = await this.probeFallbackMarkets();
    }

    markets.sort((a, b) => {
      const diff = marketOrder(a) - marketOrder(b);
      if (diff !== 0) return diff;

      const a1s = /1s|1 sec|one second/i.test(a.label) ? 1 : 0;
      const b1s = /1s|1 sec|one second/i.test(b.label) ? 1 : 0;
      return a1s - b1s || a.label.localeCompare(b.label);
    });

    if (!markets.length) {
      throw new Error(
        "Connected to Deriv, but no supported Volatility symbol responded."
      );
    }

    return markets;
  }

  async forgetCurrentSubscription() {
    if (
      !this.subscriptionId ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      this.subscriptionId = "";
      return;
    }

    const id = this.subscriptionId;
    this.subscriptionId = "";

    try {
      await this.request({ forget: id });
    } catch {}
  }

  async subscribeTicks(symbol) {
    await this.forgetCurrentSubscription();
    this.activeSymbol = symbol;

    const response = await this.request({
      ticks: symbol,
      subscribe: 1,
    });

    this.subscriptionId = String(
      response.subscription?.id ||
        response.subscription_id ||
        this.subscriptionId
    );

    return response;
  }

  disconnect() {
    this.manualClose = true;
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.pingTimer = null;

    try {
      this.socket?.close();
    } catch {}

    this.socket = null;
    this.subscriptionId = "";
    this.activeSymbol = "";
  }
}

export const derivPublicClient = new DerivPublicClient();
export default derivPublicClient;
