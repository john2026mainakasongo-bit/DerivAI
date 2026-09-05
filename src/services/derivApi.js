const PUBLIC_SOCKET_URLS = [
  "wss://api.derivws.com/trading/v1/options/ws/public",
];

const API_BASE_URL = "https://api.derivws.com";

function normalizeSymbolRow(row = {}) {
  const symbol = String(
    row.underlying_symbol ||
      row.symbol ||
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

  const rawPipSize = Number(row.pip_size);

  const decimalsFromPip =
    Number.isFinite(rawPipSize) &&
    rawPipSize > 0 &&
    rawPipSize < 1
      ? Math.min(
          8,
          Math.max(
            0,
            String(rawPipSize)
              .replace(/0+$/, "")
              .split(".")[1]?.length || 0
          )
        )
      : null;

  const explicitDecimals = Number(
    row.decimal_places ??
      row.decimals
  );

  const decimals = Number.isInteger(explicitDecimals)
    ? Math.max(0, Math.min(8, explicitDecimals))
    : decimalsFromPip ?? 3;

  return {
    id: symbol,
    symbol,
    label,
    short: label
      .replace(/Volatility/gi, "V")
      .replace(/Index/gi, "")
      .replace(/\s+/g, "")
      .slice(0, 12),
    decimals,
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

function duplicateSubscriptionError(error) {
  return /already subscribed|duplicate subscription/i.test(
    error instanceof Error ? error.message : String(error || "")
  );
}

function errorMessage(payload, fallback) {
  return (
    payload?.errors?.[0]?.message ||
    payload?.error?.message ||
    payload?.error_description ||
    payload?.message ||
    payload?.error ||
    fallback
  );
}

function normalizeContract(message = {}) {
  return (
    message.proposal_open_contract ||
    message.data?.proposal_open_contract ||
    message.contract ||
    message.data?.contract ||
    null
  );
}

class DerivTradingClient {
  constructor() {
    this.socket = null;
    this.socketUrl = "";
    this.requestId = 0;
    this.pending = new Map();
    this.statusListeners = new Set();
    this.tickListeners = new Set();
    this.contractListeners = new Set();
    this.transactionListeners = new Set();
    this.debugListeners = new Set();
    this.debugLog = [];
    this.subscriptionId = "";
    this.contractSubscriptionIds = new Set();
    this.activeContractIds = new Set();
    this.activeSymbol = "";
    this.pingTimer = null;
    this.manualClose = false;
    this.connectPromise = null;
    this.socketAuthenticated = false;
    this.socketAuthKey = "";
    this.lastAuthConnectionError = "";

    this.auth = {
      accessToken: "",
      appId: "",
      accountId: "",
    };
  }

  configureAccount({ accessToken = "", appId = "", accountId = "" } = {}) {
    const next = {
      accessToken: String(accessToken || "").trim(),
      appId: String(appId || "").trim(),
      accountId: String(accountId || "").trim(),
    };

    const changed =
      next.accessToken !== this.auth.accessToken ||
      next.appId !== this.auth.appId ||
      next.accountId !== this.auth.accountId;

    this.auth = next;
    return changed;
  }

  clearAccount() {
    this.auth = {
      accessToken: "",
      appId: "",
      accountId: "",
    };
  }

  get authenticated() {
    return Boolean(
      this.auth.accessToken &&
      this.auth.appId &&
      this.auth.accountId
    );
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onTick(listener) {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  onContract(listener) {
    this.contractListeners.add(listener);
    return () => this.contractListeners.delete(listener);
  }

  onTransaction(listener) {
    this.transactionListeners.add(listener);
    return () => this.transactionListeners.delete(listener);
  }

  onDebug(listener) {
    this.debugListeners.add(listener);
    listener(null, [...this.debugLog]);
    return () => this.debugListeners.delete(listener);
  }

  emitStatus(status, detail = "") {
    this.statusListeners.forEach((listener) =>
      listener({
        status,
        detail,
        authenticated: this.authenticated,
        accountId: this.auth.accountId,
      })
    );
  }

  pushDebug(direction, payload) {
    const entry = {
      time: new Date().toISOString(),
      direction,
      payload,
      socketUrl: this.socketUrl,
      accountId: this.auth.accountId,
    };

    this.debugLog = [...this.debugLog, entry].slice(-150);

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

    /* V19_4_ERROR_ARRAY_SUPPORT */
    const responseError =
      message.error ||
      (Array.isArray(message.errors) ? message.errors[0] : null) ||
      message.data?.error ||
      (Array.isArray(message.data?.errors) ? message.data.errors[0] : null);

    if (responseError) {
      const messageText =
        responseError.message ||
        responseError.code ||
        errorMessage(message, "Deriv returned an error.");

      if (pending) {
        window.clearTimeout(pending.timeout);
        this.pending.delete(reqId);
        pending.reject(new Error(messageText));
      }

      this.emitStatus("ERROR", messageText);
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

      if (Number.isFinite(quote)) {
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

    const contract = normalizeContract(message);

    if (contract) {
      const contractId = String(
        contract?.contract_id ||
        contract?.contractId ||
        contract?.id ||
        ""
      ).trim();

      if (contractId) {
        const status = String(
          contract?.status ||
          contract?.contract_status ||
          ""
        ).toLowerCase();

        const settled =
          Boolean(
            contract?.is_sold ||
            contract?.is_expired ||
            contract?.is_settled
          ) ||
          ["won", "lost", "sold", "expired", "settled"].includes(status);

        if (settled) {
          this.activeContractIds.delete(contractId);
        } else {
          this.activeContractIds.add(contractId);
        }
      }
      const subscriptionId = String(
        message.subscription?.id ||
          message.data?.subscription?.id ||
          ""
      );

      if (subscriptionId) {
        this.contractSubscriptionIds.add(subscriptionId);
      }

      this.contractListeners.forEach((listener) =>
        listener(contract, message)
      );
    }

    const transaction =
      message.transaction ||
      message.data?.transaction ||
      null;

    if (transaction) {
      this.transactionListeners.forEach((listener) =>
        listener(transaction, message)
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
    this.socketAuthenticated = false;
    this.socketAuthKey = "";
    this.subscriptionId = "";
    this.contractSubscriptionIds.clear();
  }

  async getAuthenticatedSocketUrl() {
    if (!this.authenticated) return "";

    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(
          `${API_BASE_URL}/trading/v1/options/accounts/${encodeURIComponent(
            this.auth.accountId
          )}/otp`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.auth.accessToken}`,
              "Deriv-App-ID": this.auth.appId,
              Accept: "application/json",
            },
            signal: controller.signal,
          }
        );

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            errorMessage(
              payload,
              `Unable to obtain authenticated Deriv WebSocket (${response.status}).`
            )
          );
        }

        const url = String(payload?.data?.url || payload?.url || "");

        if (!url) {
          throw new Error(
            "Deriv did not return an authenticated WebSocket URL."
          );
        }

        this.lastAuthConnectionError = "";
        return url;
      } catch (error) {
        lastError = error;
        this.lastAuthConnectionError =
          error instanceof Error ? error.message : "Authenticated connection failed.";

        if (attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 700));
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Unable to obtain an authenticated Deriv connection.");
  }

  async openUrl(url, authenticatedSocket = false) {
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

        this.socketAuthenticated = Boolean(authenticatedSocket);
        this.socketAuthKey = authenticatedSocket
          ? `${this.auth.appId}|${this.auth.accessToken}|${this.auth.accountId}`
          : "";

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

  async connect({ allowPublicFallback = true } = {}) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return {
        authenticated: this.socketAuthenticated,
        fallback: !this.socketAuthenticated,
      };
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.manualClose = false;
    this.emitStatus("CONNECTING");

    this.connectPromise = (async () => {
      let lastError = null;
      const candidates = [];

      // Prefer the public market socket when fallback is allowed so the UI
      // can become live immediately. Authenticated trading is verified in the
      // background by ensureTradingConnection().
      if (allowPublicFallback) {
        PUBLIC_SOCKET_URLS.forEach((url) =>
          candidates.push({
            url,
            authenticated: false,
          })
        );
      }

      if (this.authenticated) {
        try {
          const authenticatedUrl = await this.getAuthenticatedSocketUrl();
          candidates.push({
            url: authenticatedUrl,
            authenticated: true,
          });
        } catch (error) {
          lastError = error;

          if (!allowPublicFallback) {
            throw error;
          }
        }
      }

      if (!this.authenticated && !allowPublicFallback) {
        throw new Error("A logged-in Deriv account is required.");
      }

      for (const candidate of candidates) {
        try {
          await this.openUrl(candidate.url, candidate.authenticated);

          const detail =
            candidate.authenticated
              ? ""
              : this.authenticated
                ? `Public analysis feed connected. Trading connection unavailable: ${
                    this.lastAuthConnectionError || "authenticated feed failed"
                  }`
                : "";

          this.emitStatus("CONNECTED", detail);

          return {
            authenticated: candidate.authenticated,
            fallback: !candidate.authenticated,
          };
        } catch (error) {
          lastError = error;
          this.clearConnectionState();
        }
      }

      const message =
        lastError instanceof Error
          ? lastError.message
          : "Unable to connect to Deriv feed.";

      this.emitStatus("ERROR", message);
      throw new Error(message);
    })();

    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async reconnect(options = {}) {
    const previousSymbol = this.activeSymbol;

    // Reconnects can happen during trading authentication. Preserve the
    // currently selected market so the live chart does not silently stop
    // receiving ticks when the public socket is replaced by the account
    // authenticated socket.
    this.disconnect({
      preserveAccount: true,
      preserveSymbol: true,
    });

    const connection = await this.connect(options);

    
    if (this.socketAuthenticated && this.activeContractIds.size) {
      const contractIds = [...this.activeContractIds];

      for (const contractId of contractIds) {
        try {
          await this.subscribeOpenContract(contractId);
        } catch {
          // Contract may have settled while the socket was offline.
        }
      }
    }
if (previousSymbol && this.socket?.readyState === WebSocket.OPEN) {
      try {
        await this.subscribeTicks(previousSymbol);
      } catch (error) {
        if (!duplicateSubscriptionError(error)) throw error;
      }
    }

    return connection;
  }

  async ensureTradingConnection() {
    if (!this.authenticated) {
      throw new Error(
        "Choose a logged-in Demo or Real account before trading."
      );
    }

    const expectedAuthKey = `${this.auth.appId}|${this.auth.accessToken}|${this.auth.accountId}`;
    const socketMatchesSelectedAccount =
      this.socket?.readyState === WebSocket.OPEN &&
      this.socketAuthenticated &&
      this.socketAuthKey === expectedAuthKey;

    // Never reuse an authenticated socket belonging to another Demo/Real
    // account. When the user switches accounts, force a fresh OTP/socket.
    if (socketMatchesSelectedAccount) {
      return true;
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.disconnect({ preserveAccount: true });
    }

    await this.reconnect({ allowPublicFallback: false });

    if (!this.socketAuthenticated) {
      throw new Error(
        this.lastAuthConnectionError ||
          "Authenticated Deriv trading connection is unavailable."
      );
    }

    return true;
  }

  async getVolatilityMarkets() {
    const message = await this.request({
      active_symbols: "brief",
    });

    const rawSymbols = extractRows(message);

    const allMarkets = rawSymbols
      .map(normalizeSymbolRow)
      .filter(Boolean);

    const volatilityMarkets =
      allMarkets.filter(isVolatilityMarket);

    if (volatilityMarkets.length === 0) {
      throw new Error(
        "Deriv connected, but no Volatility markets were returned."
      );
    }

    return volatilityMarkets;
  }

  async inspectActiveSymbols() {
    const message = await this.request({
      active_symbols: "brief",
    });

    const rawSymbols = extractRows(message);

    const allMarkets = rawSymbols
      .map(normalizeSymbolRow)
      .filter(Boolean);

    return {
      rawSymbols,
      allMarkets,
      volatilityMarkets: allMarkets.filter(isVolatilityMarket),
      response: message,
      socketUrl: this.socketUrl,
      accountId: this.auth.accountId,
      authenticated: this.authenticated,
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

  ensureAuthenticated() {
    if (!this.authenticated) {
      throw new Error(
        "Choose a logged-in Demo or Real account before trading."
      );
    }

    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      !this.socketAuthenticated
    ) {
      throw new Error(
        this.lastAuthConnectionError ||
          "Connect the authenticated Deriv feed before trading."
      );
    }
  }

  async getProposal({
    symbol,
    contractType,
    amount,
    basis = "stake",
    currency = "USD",
    duration = 5,
    durationUnit = "t",
    barrier,
  }) {
    this.ensureAuthenticated();

    const proposal = {
      proposal: 1,
      amount: Number(amount),
      basis: String(basis || "stake"),
      contract_type: String(contractType || "").toUpperCase(),
      currency: String(currency || "USD"),
      duration: Number(duration),
      duration_unit: String(durationUnit || "t"),
      underlying_symbol: String(symbol || ""),
};

    if (!proposal.underlying_symbol) {
      throw new Error("Underlying symbol is missing.");
    }

    if (!Number.isFinite(proposal.amount) || proposal.amount <= 0) {
      throw new Error("Proposal amount must be greater than zero.");
    }

    if (!Number.isFinite(proposal.duration) || proposal.duration <= 0) {
      throw new Error("Proposal duration must be greater than zero.");
    }

    if (barrier !== undefined && barrier !== null && barrier !== "") {
      proposal.barrier = String(barrier);
    }

    return this.request(proposal);
  }

  async buyProposal(proposalId, price) {
    this.ensureAuthenticated();

    if (!proposalId) {
      throw new Error("Proposal ID is missing.");
    }

    const maximumPrice = Number(price);

    if (!Number.isFinite(maximumPrice) || maximumPrice <= 0) {
      throw new Error("Buy price must be a positive number.");
    }

    return this.request({
      buy: String(proposalId),
      price: maximumPrice,
    });
  }

  normalizeTradeOptions(options = {}) {
    const normalized = {
      ...options,
      symbol: String(options?.symbol || "").trim(),
      contractType: String(options?.contractType || "").trim().toUpperCase(),
      amount: Number(options?.amount),
      duration: Number(options?.duration),
      durationUnit: String(options?.durationUnit || "t").trim().toLowerCase(),
    };

    const digitContract = normalized.contractType.startsWith("DIGIT");

    if (digitContract) {
      normalized.duration = 1;
      normalized.durationUnit = "t";
    }

    if (
      ["DIGITEVEN", "DIGITODD", "CALL", "PUT"].includes(
        normalized.contractType
      )
    ) {
      delete normalized.barrier;
    }

    return normalized;
  }

  extractProposal(proposalResponse, normalized = {}) {
    const proposal =
      proposalResponse?.proposal ||
      proposalResponse?.data?.proposal ||
      proposalResponse?.result?.proposal ||
      (proposalResponse?.data?.id ? proposalResponse.data : null) ||
      null;

    const proposalId = String(
      proposal?.id ||
        proposal?.proposal_id ||
        proposalResponse?.proposal_id ||
        ""
    );

    const askPrice = Number(
      proposal?.ask_price ??
        proposal?.price ??
        proposalResponse?.ask_price ??
        normalized.amount
    );

    const payout = Number(
      proposal?.payout ??
        proposal?.maximum_payout ??
        proposal?.return ??
        proposalResponse?.payout ??
        0
    );

    const spot = Number(
      proposal?.spot ??
        proposal?.current_spot ??
        proposal?.entry_spot ??
        0
    );

    if (!proposalId) {
      const detail = errorMessage(
        proposalResponse,
        "Deriv did not return a proposal ID."
      );

      throw new Error(
        `Proposal failed for ${normalized.contractType} on ${normalized.symbol}: ${detail}`
      );
    }

    if (!Number.isFinite(askPrice) || askPrice <= 0) {
      throw new Error(
        `Proposal returned an invalid ask price for ${normalized.contractType}.`
      );
    }

    if (!Number.isFinite(payout) || payout <= askPrice) {
      throw new Error(
        `Proposal returned an invalid payout for ${normalized.contractType}.`
      );
    }

    return {
      proposal,
      proposalId,
      askPrice,
      payout,
      spot,
      raw: proposalResponse,
      request: normalized,
    };
  }

  async quoteContract(options) {
    const normalized = this.normalizeTradeOptions(options);
    const proposalResponse = await this.getProposal(normalized);
    return this.extractProposal(proposalResponse, normalized);
  }

  async buyQuotedContract(quote) {
    this.ensureAuthenticated();

    const proposalId = String(quote?.proposalId || "");
    const askPrice = Number(quote?.askPrice);

    if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0) {
      throw new Error("A valid quoted proposal is required before buying.");
    }

    const buyResponse = await this.buyProposal(proposalId, askPrice);

    const buy =
      buyResponse?.buy ||
      buyResponse?.data?.buy ||
      buyResponse?.result?.buy ||
      (buyResponse?.data?.contract_id ? buyResponse.data : null) ||
      null;

    const contractId = String(
      buy?.contract_id ||
        buy?.id ||
        buyResponse?.contract_id ||
        ""
    );

    if (!contractId) {
      const detail = errorMessage(
        buyResponse,
        "Deriv did not return a contract ID."
      );

      throw new Error(`Buy failed: ${detail}`);
    }

    this.activeContractIds.add(contractId);

    await this.subscribeOpenContract(contractId);

    return {
      proposal: quote.proposal,
      quote,
      buy,
      contractId,
      raw: buyResponse,
      request: quote.request,
    };
  }

  async buyContract(options) {
    const quote = await this.quoteContract(options);
    return this.buyQuotedContract(quote);
  }

  async subscribeOpenContract(contractId) {
    this.ensureAuthenticated();

    const id = String(contractId || "").trim();

    if (!id) {
      throw new Error("A valid contract ID is required.");
    }

    this.activeContractIds.add(id);

    return this.request({
      proposal_open_contract: 1,
      contract_id: Number(id),
      subscribe: 1,
    });
  }

  async subscribeTransactions() {
    this.ensureAuthenticated();

    return this.request({
      transaction: 1,
      subscribe: 1,
    });
  }

  async getPortfolio() {
    this.ensureAuthenticated();

    return this.request({
      portfolio: 1,
    });
  }

  async getStatement(limit = 50) {
    this.ensureAuthenticated();

    return this.request({
      statement: 1,
      description: 1,
      limit: Math.max(1, Math.min(100, Number(limit) || 50)),
    });
  }

  async sellContract(contractId, price = 0) {
    this.ensureAuthenticated();

    return this.request({
      sell: Number(contractId),
      price: Number(price),
    });
  }

  disconnect({ preserveAccount = true, preserveSymbol = false } = {}) {
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

    if (!preserveSymbol) {
      this.activeSymbol = "";
    }

    if (!preserveAccount) {
      this.activeContractIds.clear();
      this.clearAccount();
    }

    this.emitStatus("DISCONNECTED");
  }
}

export const derivPublicClient =
  new DerivTradingClient();

export default derivPublicClient;


