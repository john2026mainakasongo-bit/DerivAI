const SOCKET_URLS = [
  "wss://api.derivws.com/trading/v1/options/ws/public",
  "wss://ws.binaryws.com/websockets/v3",
];

function normalizeSymbolRow(row = {}) {
  const symbol = String(
    row.symbol ||
      row.underlying_symbol ||
      row.id ||
      row.code ||
      ""
  ).trim();

  const label = String(
    row.display_name ||
      row.name ||
      row.label ||
      row.market_display_name ||
      symbol
  ).trim();

  if (!symbol) return null;

  const decimals = Number(
    row.pip_size ??
      row.decimal_places ??
      row.decimals ??
      3
  );

  return {
    id: symbol,
    symbol,
    label,
    short: label
      .replace(/Volatility/gi, "V")
      .replace(/Index/gi, "")
      .replace(/\s+/g, "")
      .slice(0, 12),
    decimals: Number.isFinite(decimals)
      ? Math.max(0, Math.min(8, decimals))
      : 3,
    raw: row,
  };
}

function extractRows(message = {}) {
  const candidates = [
    message.active_symbols,
    message.data,
    message.data?.active_symbols,
    message.result,
    message.symbols,
  ];

  return candidates.find(Array.isArray) || [];
}

function isVolatilityMarket(item) {
  const value = `${item.label} ${item.symbol}`.toLowerCase();

  return (
    value.includes("volatility") ||
    /^r_\d+$/i.test(item.symbol) ||
    /^\d+hz\d+v$/i.test(item.symbol) ||
    /vix/i.test(value)
  );
}

function tickSymbol(tick = {}, fallback = "") {
  return String(
    tick.symbol ||
      tick.underlying_symbol ||
      tick.instrument ||
      fallback
  );
}

class DerivPublicClient {
  constructor() {
    this.socket = null;
    this.socketUrl = "";
    this.urlIndex = 0;
    this.requestId = 0;
    this.pending = new Map();
    this.statusListeners = new Set();
    this.tickListeners = new Set();
    this.debugListeners = new Set();
    this.debugLog = [];
    this.subscriptionId = "";
    this.activeSymbol = "";
    this.pingTimer = null;
    this.manualClose = false;
    this.connectPromise = null;
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onTick(listener) {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  onDebug(listener) {
    this.debugListeners.add(listener);
    listener(null, [...this.debugLog]);
    return () => this.debugListeners.delete(listener);
  }

  emitStatus(status, detail = "") {
    this.statusListeners.forEach((listener) =>
      listener({ status, detail })
    );
  }

  pushDebug(direction, payload) {
    const entry = {
      time: new Date().toISOString(),
      direction,
      payload,
      socketUrl: this.socketUrl,
    };

    this.debugLog = [...this.debugLog, entry].slice(-100);

    this.debugListeners.forEach((listener) =>
      listener(entry, [...this.debugLog])
    );
  }

  nextRequestId() {
    this.requestId += 1;
    return this.requestId;
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Deriv WebSocket is not connected.");
    }

    this.pushDebug("out", payload);
    this.socket.send(JSON.stringify(payload));
  }

  request(payload, timeoutMs = 15000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("Deriv WebSocket is not connected.")
      );
    }

    const reqId = this.nextRequestId();

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("Deriv request timed out."));
      }, timeoutMs);

      this.pending.set(reqId, {
        resolve,
        reject,
        timeout,
      });

      this.send({ ...payload, req_id: reqId });
    });
  }

  handleMessage(event) {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    this.pushDebug("in", message);

    const reqId = Number(message.req_id);
    const pending = this.pending.get(reqId);

    if (message.error) {
      const errorMessage =
        message.error.message ||
        message.error.code ||
        "Deriv returned an error.";

      if (pending) {
        window.clearTimeout(pending.timeout);
        this.pending.delete(reqId);
        pending.reject(new Error(errorMessage));
      }

      this.emitStatus("ERROR", errorMessage);
      return;
    }

    if (pending) {
      window.clearTimeout(pending.timeout);
      this.pending.delete(reqId);
      pending.resolve(message);
    }

    const tick =
      message.tick ||
      message.data?.tick ||
      (message.msg_type === "tick" ? message.data : null);

    if (tick) {
      const quote = Number(
        tick.quote ??
          tick.price ??
          tick.value
      );

      if (!Number.isFinite(quote)) return;

      this.subscriptionId = String(
        message.subscription?.id ||
          message.data?.subscription?.id ||
          this.subscriptionId
      );

      const normalized = {
        symbol: tickSymbol(tick, this.activeSymbol),
        quote,
        epoch: Number(
          tick.epoch ||
            tick.timestamp ||
            Date.now() / 1000
        ),
      };

      this.tickListeners.forEach((listener) =>
        listener(normalized)
      );
    }
  }

  clearConnectionState() {
    if (this.pingTimer) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timeout);
      pending.reject(
        new Error("Deriv WebSocket disconnected.")
      );
    });

    this.pending.clear();
    this.socket = null;
    this.subscriptionId = "";
  }

  async openUrl(url) {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      this.socketUrl = url;

      let settled = false;

      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;

        try {
          socket.close();
        } catch {
          // Ignore.
        }

        reject(new Error("Deriv connection timed out."));
      }, 12000);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);

        socket.onmessage = (event) =>
          this.handleMessage(event);

        this.pingTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            try {
              this.send({ ping: 1 });
            } catch {
              // Ignore.
            }
          }
        }, 25000);

        resolve();
      };

      socket.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(
          new Error(`Unable to connect: ${url}`)
        );
      };

      socket.onclose = () => {
        window.clearTimeout(timeout);
        this.clearConnectionState();

        if (this.manualClose) {
          this.emitStatus("DISCONNECTED");
        } else if (settled) {
          this.emitStatus(
            "OFFLINE",
            "Deriv live feed closed."
          );
        }
      };
    });
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.manualClose = false;
    this.emitStatus("CONNECTING");

    this.connectPromise = (async () => {
      let lastError = null;

      for (let index = 0; index < SOCKET_URLS.length; index += 1) {
        const url = SOCKET_URLS[index];

        try {
          await this.openUrl(url);
          this.urlIndex = index;
          this.emitStatus("CONNECTED");
          return;
        } catch (error) {
          lastError = error;
          this.clearConnectionState();
        }
      }

      const message =
        lastError instanceof Error
          ? lastError.message
          : "Unable to connect to Deriv public feed.";

      this.emitStatus("ERROR", message);
      throw new Error(message);
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async inspectActiveSymbols() {
    const message = await this.request({
      active_symbols: "brief",
      product_type: "basic",
    });

    const rawSymbols = extractRows(message);

    const allMarkets = rawSymbols
      .map(normalizeSymbolRow)
      .filter(Boolean);

    const volatilityMarkets = allMarkets.filter(
      isVolatilityMarket
    );

    return {
      rawSymbols,
      allMarkets,
      volatilityMarkets,
      response: message,
      socketUrl: this.socketUrl,
      detectedFields:
        rawSymbols[0]
          ? Object.keys(rawSymbols[0])
          : [],
    };
  }

  async forgetCurrentSubscription() {
    if (!this.subscriptionId) return;

    try {
      await this.request({
        forget: this.subscriptionId,
      });
    } catch {
      // Ignore stale subscription errors.
    }

    this.subscriptionId = "";
  }

  async getHistory(symbol, count = 100) {
    const message = await this.request({
      ticks_history: symbol,
      count,
      end: "latest",
      style: "ticks",
    });

    const history =
      message.history ||
      message.data?.history ||
      message.result ||
      {};

    const prices =
      history.prices ||
      history.quotes ||
      history.values ||
      [];

    const times =
      history.times ||
      history.epochs ||
      history.timestamps ||
      [];

    if (!Array.isArray(prices)) {
      return [];
    }

    return prices
      .map((price, index) => ({
        quote: Number(price),
        epoch: Number(
          times[index] ||
            Date.now() / 1000 - prices.length + index
        ),
      }))
      .filter((item) =>
        Number.isFinite(item.quote)
      );
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
        response.data?.subscription?.id ||
        ""
    );

    const firstTick =
      response.tick ||
      response.data?.tick;

    if (firstTick) {
      const quote = Number(
        firstTick.quote ??
          firstTick.price ??
          firstTick.value
      );

      if (Number.isFinite(quote)) {
        this.tickListeners.forEach((listener) =>
          listener({
            symbol: tickSymbol(
              firstTick,
              symbol
            ),
            quote,
            epoch: Number(
              firstTick.epoch ||
                firstTick.timestamp ||
                Date.now() / 1000
            ),
          })
        );
      }
    }

    return response;
  }

  disconnect() {
    this.manualClose = true;

    if (this.pingTimer) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore.
      }
    }

    this.clearConnectionState();
    this.activeSymbol = "";
    this.emitStatus("DISCONNECTED");
  }
}

export const derivPublicClient =
  new DerivPublicClient();

export default derivPublicClient;
