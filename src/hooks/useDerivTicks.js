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
  const [openContracts, setOpenContracts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeError, setTradeError] = useState("");

  const symbolRef = useRef("");
  const mountedRef = useRef(true);
  const manuallyDisconnectedRef = useRef(false);

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
      ].slice(-400)
    );
  }, []);

  const loadSymbol = useCallback(async (nextSymbol) => {
    if (!nextSymbol) {
      throw new Error("No Deriv market was selected.");
    }

    symbolRef.current = nextSymbol;
    setSymbol(nextSymbol);
    setLoadingMarket(true);

    try {
      const history = await derivPublicClient.getHistory(nextSymbol, 160);
      if (!mountedRef.current) return;

      setTicks(history.slice(-160));

      try {
        await derivPublicClient.subscribeTicks(nextSymbol);
      } catch (error) {
        if (!duplicateSubscription(error)) throw error;
      }
    } finally {
      if (mountedRef.current) setLoadingMarket(false);
    }
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
        allowPublicFallback: true,
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

      setConnected(true);
      setStatus("CONNECTED");

      if (connection?.fallback && auth.authenticated) {
        setStatusDetail(
          derivPublicClient.lastAuthConnectionError
            ? `Live analysis connected. Trading login failed: ${derivPublicClient.lastAuthConnectionError}`
            : "Live analysis connected. Reconnect the account before trading."
        );
      }

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
      setConnected(next.status === "CONNECTED");

      if (
        ["OFFLINE", "ERROR"].includes(next.status) &&
        !manuallyDisconnectedRef.current
      ) {
        if (reconnectTimer) window.clearTimeout(reconnectTimer);

        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          void connect().catch(() => {});
        }, 1500);
      }
    });

    const removeTick = derivPublicClient.onTick(addTick);

    const removeContract = derivPublicClient.onContract((contract) => {
      const id = String(contract?.contract_id || contract?.id || "");
      if (!id) return;

      setOpenContracts((current) => {
        const rest = current.filter(
          (item) =>
            String(item?.contract_id || item?.id || "") !== id
        );
        return [contract, ...rest].slice(0, 30);
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
  }, [addTick, connect]);

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

    if (!changed || !connected) return;

    setOpenContracts([]);
    setTransactions([]);
    setTradeError("");

    void (async () => {
      try {
        await derivPublicClient.reconnect({
          allowPublicFallback: true,
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
    connected,
    loadSymbol,
    selectedAccountId,
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
        await derivPublicClient.ensureTradingConnection();

        return await derivPublicClient.buyContract({
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
    placeTrade,
    refreshContract,
    sellContract,
    loadPortfolio,
    loadStatement,
  };
}
