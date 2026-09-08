import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";

let sharedConnectPromise = null;
let sharedTransactionPromise = null;
let sharedTransactionReady = false;
let sharedAccountKey = "";
let reconnectTimer = null;

function accountKey({ appId = "", accessToken = "", accountId = "" } = {}) {
  return `${appId}|${accessToken}|${accountId}`;
}

function accountIdOf(account) {
  return String(
    account?.id ||
      account?.account_id ||
      account?.loginid ||
      account?.login_id ||
      ""
  );
}

function extractLastDigit(value, decimals = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;

  const digits = number
    .toFixed(Math.max(0, decimals))
    .replace(/\D/g, "");

  return digits ? Number(digits.at(-1)) : null;
}

function chooseDefaultMarket(markets = []) {
  return (
    markets.find((item) => /^Volatility 75 Index$/i.test(item.label)) ||
    markets.find(
      (item) =>
        /Volatility 75/i.test(item.label) &&
        !/1s|1 sec|one second/i.test(item.label)
    ) ||
    markets[0] ||
    null
  );
}

function duplicateSubscription(error) {
  return /already subscribed|duplicate subscription/i.test(
    error instanceof Error ? error.message : String(error || "")
  );
}

function resetSharedSubscriptions() {
  sharedTransactionReady = false;
  sharedTransactionPromise = null;
}

async function ensureSharedSocket(options = {}) {
  if (sharedConnectPromise) return sharedConnectPromise;

  sharedConnectPromise = Promise.resolve(
    derivPublicClient.connect(options)
  ).finally(() => {
    sharedConnectPromise = null;
  });

  return sharedConnectPromise;
}

async function ensureTransactions() {
  if (sharedTransactionReady) return true;
  if (sharedTransactionPromise) return sharedTransactionPromise;

  sharedTransactionPromise = (async () => {
    try {
      await derivPublicClient.subscribeTransactions();
      sharedTransactionReady = true;
      return true;
    } catch (error) {
      if (duplicateSubscription(error)) {
        sharedTransactionReady = true;
        return true;
      }
      throw error;
    } finally {
      sharedTransactionPromise = null;
    }
  })();

  return sharedTransactionPromise;
}

export default function useDerivTicks() {
  const auth = useDerivAuth();

  const [markets, setMarkets] = useState([]);
  const [symbol, setSymbol] = useState("");
  const [status, setStatus] = useState("DISCONNECTED");
  const [statusDetail, setStatusDetail] = useState("");
  const [connected, setConnected] = useState(false);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [ticks, setTicks] = useState([]);
  const [candleHistory, setCandleHistory] = useState({
    60: [],
    300: [],
    900: [],
    3600: [],
  });
  const [openContracts, setOpenContracts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeError, setTradeError] = useState("");

  const symbolRef = useRef("");
  const mountedRef = useRef(true);
  const manuallyDisconnectedRef = useRef(false);

  // V5.1: dedupe market bootstrap requests and avoid repeated ticks_history bursts.
  const loadSymbolPromiseRef = useRef(null);
  const loadedSymbolRef = useRef("");
  const loadedAtRef = useRef(0);

  // V29: remember contracts bought during this account session.
  const activeContractIdsRef = useRef(new Set());

  const selectedAccountId = accountIdOf(auth.selectedAccount);

  const market = useMemo(
    () =>
      markets.find((item) => item.id === symbol) ||
      markets[0] || {
        id: "",
        label: "No market selected",
        short: "—",
        decimals: 3,
      },
    [markets, symbol]
  );

  const addTick = useCallback((tick) => {
    if (!tick || tick.symbol !== symbolRef.current) return;

    setTicks((current) =>
      [
        ...current,
        {
          quote: Number(tick.quote),
          epoch: Number(tick.epoch),
        },
      ].slice(-5000)
    );
  }, []);

  const loadSymbol = useCallback(async (nextSymbol) => {
    if (!nextSymbol) {
      throw new Error("No Deriv market was selected.");
    }

    // V5.2.1: never let historical data block the live market connection.
    // If another bootstrap is already subscribing/loading this symbol, reuse it.
    if (
      loadSymbolPromiseRef.current?.symbol === nextSymbol &&
      loadSymbolPromiseRef.current?.promise
    ) {
      return loadSymbolPromiseRef.current.promise;
    }

    const recentlyLoaded =
      loadedSymbolRef.current === nextSymbol &&
      Date.now() - loadedAtRef.current < 15_000;

    symbolRef.current = nextSymbol;
    setSymbol(nextSymbol);

    if (recentlyLoaded) {
      try {
        await derivPublicClient.subscribeTicks(nextSymbol);
      } catch (error) {
        if (!duplicateSubscription(error)) throw error;
      }
      if (mountedRef.current) setLoadingMarket(false);
      return;
    }

    setLoadingMarket(true);
    setTicks([]);
    setCandleHistory({
      60: [],
      300: [],
      900: [],
      3600: [],
    });

    // CRITICAL: the promise returned here resolves immediately after the
    // live tick subscription. Background history/candles are NOT awaited.
    const promise = (async () => {
      try {
        await derivPublicClient.subscribeTicks(nextSymbol);
      } catch (error) {
        if (!duplicateSubscription(error)) throw error;
      }

      loadedSymbolRef.current = nextSymbol;
      loadedAtRef.current = Date.now();

      // The live feed is ready now. Release the connection gate immediately.
      if (mountedRef.current) setLoadingMarket(false);

      // IMPORTANT: launch enrichment without awaiting it. This allows
      // connect() to finish and status to become CONNECTED immediately.
      void (async () => {
        try {
          const history = await derivPublicClient.getHistory(nextSymbol, 500);
          if (mountedRef.current && symbolRef.current === nextSymbol) {
            setTicks(history.slice(-500));
          }
        } catch (error) {
          console.warn("[ZENTORA] Background tick history unavailable:", error);
        }

        // Keep a deep, real OHLC history for the Touch / No Touch workspace.
        // 240 hourly candles gives the chart enough structure for EMA/S-R and
        // price-action context without fabricating candles from sparse ticks.
        const candleRequests = [
          [3600, 240],
          [60, 240],
          [300, 240],
          [900, 240],
        ];

        for (const [granularity, count] of candleRequests) {
          try {
            const candles = await derivPublicClient.getCandleHistory(
              nextSymbol,
              granularity,
              count
            );

            if (mountedRef.current && symbolRef.current === nextSymbol) {
              setCandleHistory((current) => ({
                ...current,
                [granularity]: candles,
              }));
            }
          } catch (error) {
            console.warn(
              `[ZENTORA] Background ${granularity}s candles unavailable:`,
              error
            );
          }

          // Small pacing gap between historical market-data calls.
          await new Promise((resolve) => window.setTimeout(resolve, 150));
        }
      })();
    })();

    loadSymbolPromiseRef.current = {
      symbol: nextSymbol,
      promise,
    };

    promise.finally(() => {
      if (loadSymbolPromiseRef.current?.symbol === nextSymbol) {
        loadSymbolPromiseRef.current = null;
      }
    }).catch(() => {});

    return promise;
  }, []);

  const connect = useCallback(async () => {
    manuallyDisconnectedRef.current = false;
    setTradeError("");
    setStatus("CONNECTING");
    setStatusDetail("");

    const config = {
      accessToken: auth.session?.accessToken || "",
      appId: auth.config?.clientId || "",
      accountId: selectedAccountId,
    };

    const nextKey = accountKey(config);
    derivPublicClient.configureAccount(config);

    if (nextKey !== sharedAccountKey) {
      sharedAccountKey = nextKey;
      resetSharedSubscriptions();
    }

    try {
      const connection = await ensureSharedSocket({
        allowPublicFallback: !auth.authenticated || !selectedAccountId,
      });

      const liveMarkets =
        await derivPublicClient.getVolatilityMarkets();

      if (!liveMarkets.length) {
        throw new Error("No Volatility markets were returned.");
      }

      if (!mountedRef.current) return connection;

      setMarkets(liveMarkets);

      const selected =
        liveMarkets.find((item) => item.id === symbolRef.current) ||
        chooseDefaultMarket(liveMarkets);

      await loadSymbol(selected.id);

      if (
        auth.authenticated &&
        selectedAccountId &&
        connection?.authenticated
      ) {
        try {
          await ensureTransactions();
        } catch (error) {
          if (!duplicateSubscription(error)) throw error;
        }
      }

      const tradingConnectionRequired =
        Boolean(auth.authenticated && selectedAccountId);

      if (tradingConnectionRequired && !connection?.authenticated) {
        throw new Error(
          "Authenticated Deriv trading connection is not ready."
        );
      }

      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      setConnected(true);
      setStatus("CONNECTED");
      setStatusDetail(
        connection?.authenticated
          ? "Authenticated trading connection ready."
          : "Public market feed connected."
      );

      return connection;
    } catch (error) {
      setConnected(false);
      setStatus("ERROR");
      setStatusDetail(
        error instanceof Error ? error.message : "Connection failed."
      );
      throw error;
    }
  }, [
    auth.authenticated,
    auth.config?.clientId,
    auth.session?.accessToken,
    loadSymbol,
    selectedAccountId,
  ]);

  useEffect(() => {
    mountedRef.current = true;

    const removeStatus = derivPublicClient.onStatus((next) => {
      if (!mountedRef.current) return;

      setStatus(next.status);
      setStatusDetail(next.detail || "");

      const requiresTradingAuth =
        Boolean(auth.authenticated && selectedAccountId);

      setConnected(
        next.status === "CONNECTED" &&
        (!requiresTradingAuth || Boolean(next.authenticated))
      );

      if (["OFFLINE", "ERROR", "DISCONNECTED"].includes(next.status)) {
        // Any socket close invalidates the previous subscription state.
        // The next authenticated connection must subscribe again.
        resetSharedSubscriptions();
      }

      if (
        ["OFFLINE", "ERROR", "DISCONNECTED"].includes(next.status) &&
        !manuallyDisconnectedRef.current
      ) {
        if (reconnectTimer) window.clearTimeout(reconnectTimer);

        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          if (!manuallyDisconnectedRef.current) {
            void connect().catch(() => {});
          }
        }, 1500);
      }
    });

    const removeTick = derivPublicClient.onTick(addTick);

    const removeContract = derivPublicClient.onContract((contract) => {
      const id = String(
        contract?.contract_id ||
          contract?.contractId ||
          contract?.id ||
          contract?.proposal_open_contract?.contract_id ||
          contract?.data?.contract_id ||
          ""
      );
      if (!id) return;

      activeContractIdsRef.current.add(id);

      setOpenContracts((current) => {
        const previous = current.find(
          (item) =>
            String(
              item?.contract_id ||
                item?.contractId ||
                item?.id ||
                ""
            ) === id
        );

        const merged = {
          ...(previous || {}),
          ...contract,
          contract_id: id,
          id,
        };

        const rest = current.filter(
          (item) =>
            String(
              item?.contract_id ||
                item?.contractId ||
                item?.id ||
                ""
            ) !== id
        );

        return [merged, ...rest].slice(0, 30);
      });
    });

    const removeTransaction = derivPublicClient.onTransaction(
      (transaction) => {
        setTransactions((current) =>
          [transaction, ...current].slice(0, 60)
        );
      }
    );

    return () => {
      mountedRef.current = false;
      removeStatus();
      removeTick();
      removeContract();
      removeTransaction();
    };
  }, [
    addTick,
    auth.authenticated,
    connect,
    selectedAccountId,
  ]);

  useEffect(() => {
    const config = {
      accessToken: auth.session?.accessToken || "",
      appId: auth.config?.clientId || "",
      accountId: selectedAccountId,
    };

    const nextKey = accountKey(config);
    const changed = derivPublicClient.configureAccount(config);

    if (nextKey !== sharedAccountKey) {
      sharedAccountKey = nextKey;
      resetSharedSubscriptions();
    }

    /*
     * Reconnect only when the selected Deriv account credentials change.
     * Do NOT use `connected` as a trigger here: reconnect() itself changes
     * connected state and can otherwise create a reconnect loop.
     */
    if (!changed) return;

    setOpenContracts([]);
    setTransactions([]);
    setTradeError("");

    void (async () => {
      try {
        await derivPublicClient.reconnect({
          allowPublicFallback: !auth.authenticated || !selectedAccountId,
        });

        const liveMarkets =
          await derivPublicClient.getVolatilityMarkets();

        setMarkets(liveMarkets);

        const selected =
          liveMarkets.find((item) => item.id === symbolRef.current) ||
          chooseDefaultMarket(liveMarkets);

        if (selected) await loadSymbol(selected.id);
      } catch (error) {
        setStatus("ERROR");
        setConnected(false);
        setStatusDetail(
          error instanceof Error
            ? error.message
            : "Unable to reconnect selected account."
        );
      }
    })();
  }, [
    auth.config?.clientId,
    auth.session?.accessToken,
    loadSymbol,
    selectedAccountId,
  ]);

  // One connection path only: when the selected account credentials are
  // present, connect() establishes the authenticated trading socket directly.
  // This avoids a public->auth->public race and repeated transaction
  // subscriptions that previously caused unstable status changes.
  useEffect(() => {
    if (
      !auth.authenticated ||
      !selectedAccountId ||
      manuallyDisconnectedRef.current
    ) {
      return;
    }

    if (!connected && status !== "CONNECTING" && !loadingMarket) {
      void connect().catch(() => {});
    }
  }, [
    auth.authenticated,
    selectedAccountId,
    connected,
    status,
    loadingMarket,
    connect,
  ]);

  // V5: persistent connection watchdog. It retries only while the user is
  // authenticated and has a selected account; manual Disconnect disables it.
  useEffect(() => {
    if (!auth.authenticated || !selectedAccountId || manuallyDisconnectedRef.current) {
      return undefined;
    }

    let disposed = false;
    let timer = null;

    const attempt = async () => {
      if (disposed || manuallyDisconnectedRef.current || connected || status === "CONNECTING") {
        return;
      }
      try {
        await connect();
      } catch (_) {
        // The next watchdog cycle retries. The UI already exposes statusDetail.
      }
    };

    const tick = () => {
      if (disposed) return;
      void attempt();
      timer = window.setTimeout(tick, 4000);
    };

    timer = window.setTimeout(tick, 250);

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [
    auth.authenticated,
    selectedAccountId,
    connected,
    status,
    connect,
  ]);

  const disconnect = useCallback(() => {
    manuallyDisconnectedRef.current = true;

    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    derivPublicClient.disconnect({ preserveAccount: true });
    sharedConnectPromise = null;
    resetSharedSubscriptions();

    setConnected(false);
    setStatus("DISCONNECTED");
    setStatusDetail("");
    setTicks([]);
    setMarkets([]);
    setSymbol("");
    setOpenContracts([]);
    setTransactions([]);
    setTradeError("");
    symbolRef.current = "";
  }, []);

  const changeSymbol = useCallback(
    async (nextSymbol) => {
      if (!nextSymbol) return;

      if (!connected) {
        await connect();
      }

      try {
        setStatusDetail("");
        await loadSymbol(nextSymbol);
      } catch (error) {
        setStatusDetail(
          error instanceof Error
            ? error.message
            : "Unable to change market."
        );
        throw error;
      }
    },
    [connect, connected, loadSymbol]
  );

  const quoteTrade = useCallback(
    async ({
      contractType,
      amount,
      basis = "stake",
      currency,
      duration = 5,
      durationUnit = "t",
      barrier,
      symbol: tradeSymbol,
    }) => {
      if (!auth.authenticated || !selectedAccountId) {
        throw new Error("Log in and choose a Demo or Real account first.");
      }

      const finalSymbol = tradeSymbol || symbolRef.current;
      if (!finalSymbol) throw new Error("Choose and connect a market first.");

      if (!derivPublicClient.socketAuthenticated) {
        await derivPublicClient.ensureTradingConnection();
      }

      return derivPublicClient.quoteContract({
        symbol: finalSymbol,
        contractType,
        amount,
        basis,
        currency: currency || auth.selectedAccount?.currency || "USD",
        duration,
        durationUnit,
        barrier,
      });
    },
    [auth.authenticated, auth.selectedAccount?.currency, selectedAccountId]
  );

  const placeQuotedTrade = useCallback(
    async ({ quote }) => {
      if (!auth.authenticated || !selectedAccountId) {
        throw new Error(
          "Log in and choose a Demo or Real account first."
        );
      }

      if (!quote?.proposalId) {
        throw new Error("A valid proposal is required before buying.");
      }

      setTradeBusy(true);
      setTradeError("");

      try {
        const selectedConfig = {
          accessToken: auth.session?.accessToken || "",
          appId: auth.config?.clientId || "",
          accountId: selectedAccountId,
        };

        derivPublicClient.configureAccount(selectedConfig);
        await derivPublicClient.ensureTradingConnection();
        sharedTransactionReady = false;
        await ensureTransactions();

        const bought = await derivPublicClient.buyQuotedContract(quote);
        const contractId = String(
          bought?.contractId ||
            bought?.contract_id ||
            bought?.buy?.contract_id ||
            bought?.raw?.buy?.contract_id ||
            bought?.raw?.data?.buy?.contract_id ||
            ""
        );

        if (!contractId) {
          throw new Error(
            "Deriv confirmed the purchase but no contract ID was returned."
          );
        }

        activeContractIdsRef.current.add(contractId);
        setOpenContracts((current) => {
          const optimistic = {
            contract_id: contractId,
            id: contractId,
            status: "OPEN",
            is_sold: false,
            is_expired: false,
            symbol: quote?.request?.symbol || symbolRef.current,
            underlying: quote?.request?.symbol || symbolRef.current,
            contract_type: quote?.request?.contractType || "",
            buy_price: Number(quote?.askPrice || 0),
            purchase_price: Number(quote?.askPrice || 0),
            date_start: Math.floor(Date.now() / 1000),
            duration: Number(quote?.request?.duration || 0),
            duration_unit: quote?.request?.durationUnit || "t",
            quantum_pending: true,
          };

          return [
            optimistic,
            ...current.filter(
              (item) =>
                String(item?.contract_id || item?.contractId || item?.id || "") !== contractId
            ),
          ].slice(0, 30);
        });

        return { ...bought, contractId };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Trade failed.";
        setTradeError(message);
        throw error;
      } finally {
        setTradeBusy(false);
      }
    },
    [auth.authenticated, auth.config?.clientId, auth.session?.accessToken, selectedAccountId]
  );

  const placeTrade = useCallback(
    async ({
      contractType,
      amount,
      basis = "stake",
      currency,
      duration = 5,
      durationUnit = "t",
      barrier,
      symbol: tradeSymbol,
    }) => {
      if (!auth.authenticated || !selectedAccountId) {
        throw new Error(
          "Log in and choose a Demo or Real account first."
        );
      }

      const finalSymbol = tradeSymbol || symbolRef.current;

      if (!finalSymbol) {
        throw new Error("Choose and connect a market first.");
      }

      setTradeBusy(true);
      setTradeError("");

      try {
        const selectedConfig = {
          accessToken: auth.session?.accessToken || "",
          appId: auth.config?.clientId || "",
          accountId: selectedAccountId,
        };

        derivPublicClient.configureAccount(selectedConfig);
        await derivPublicClient.ensureTradingConnection();

        // A forced account-auth reconnect creates a fresh socket. Re-arm the
        // transaction stream so OPEN/settled trades keep updating the UI.
        sharedTransactionReady = false;
        await ensureTransactions();

        const bought = await derivPublicClient.buyContract({
          symbol: finalSymbol,
          contractType,
          amount,
          basis,
          currency:
            currency ||
            auth.selectedAccount?.currency ||
            "USD",
          duration,
          durationUnit,
          barrier,
        });

        const contractId = String(
          bought?.contractId ||
            bought?.contract_id ||
            bought?.buy?.contract_id ||
            bought?.raw?.buy?.contract_id ||
            bought?.raw?.data?.buy?.contract_id ||
            ""
        );

        if (!contractId) {
          throw new Error(
            "Deriv confirmed the purchase but no contract ID was returned."
          );
        }

        activeContractIdsRef.current.add(contractId);

        setOpenContracts((current) => {
          const optimistic = {
            contract_id: contractId,
            id: contractId,
            status: "OPEN",
            is_sold: false,
            is_expired: false,
            symbol: finalSymbol,
            underlying: finalSymbol,
            contract_type: contractType,
            buy_price: Number(amount),
            purchase_price: Number(amount),
            date_start: Math.floor(Date.now() / 1000),
            duration: Number(duration),
            duration_unit: durationUnit,
            quantum_pending: true,
          };

          const rest = current.filter(
            (item) =>
              String(
                item?.contract_id ||
                  item?.contractId ||
                  item?.id ||
                  ""
              ) !== contractId
          );

          return [optimistic, ...rest].slice(0, 30);
        });

        /*
         * buyQuotedContract already subscribes, but requesting once more is
         * safe and helps recover if the first contract event was missed.
         */
        return {
          ...bought,
          contractId,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Trade failed.";

        setTradeError(message);
        throw error;
      } finally {
        setTradeBusy(false);
      }
    },
    [
      auth.authenticated,
      auth.selectedAccount?.currency,
      selectedAccountId,
    ]
  );

  const refreshContract = useCallback(async (contractId) => {
    const id = String(contractId || "").trim();

    if (!id) {
      throw new Error("A contract ID is required.");
    }

    await derivPublicClient.ensureTradingConnection();
    return derivPublicClient.subscribeOpenContract(id);
  }, []);

  const sellContract = useCallback(async (contractId, price = 0) => {
    setTradeBusy(true);
    setTradeError("");

    try {
      await derivPublicClient.ensureTradingConnection();
      return await derivPublicClient.sellContract(contractId, price);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to sell contract.";

      setTradeError(message);
      throw error;
    } finally {
      setTradeBusy(false);
    }
  }, []);

  const loadPortfolio = useCallback(async () => {
    await derivPublicClient.ensureTradingConnection();
    return derivPublicClient.getPortfolio();
  }, []);

  const loadStatement = useCallback(async (limit = 50) => {
    await derivPublicClient.ensureTradingConnection();
    return derivPublicClient.getStatement(limit);
  }, []);

  const prices = useMemo(
    () =>
      ticks
        .map((tick) => Number(tick.quote))
        .filter(Number.isFinite),
    [ticks]
  );

  const currentPrice = prices.length ? prices.at(-1) : null;

  const lastDigit = useMemo(
    () => extractLastDigit(currentPrice, market.decimals),
    [currentPrice, market.decimals]
  );

  const digitHistory = useMemo(
    () =>
      prices
        .map((price) => extractLastDigit(price, market.decimals))
        .filter(Number.isInteger),
    [prices, market.decimals]
  );

  return {
    markets,
    market,
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    ticks,
    candleHistory,
    prices,
    currentPrice,
    lastDigit,
    digitHistory,

    authenticatedFeed:
      connected &&
      auth.authenticated &&
      Boolean(selectedAccountId) &&
      Boolean(derivPublicClient.socketAuthenticated),

    selectedAccountId,
    selectedAccount: auth.selectedAccount,
    selectedAccountType: auth.selectedAccountType,

    openContracts,
    transactions,
    tradeBusy,
    tradeError,

    inspection: null,
    debugLog: derivPublicClient.debugLog || [],

    connect,
    disconnect,
    changeSymbol,
    quoteTrade,
    placeTrade,
    placeQuotedTrade,
    refreshContract,
    sellContract,
    loadPortfolio,
    loadStatement,
  };
}
