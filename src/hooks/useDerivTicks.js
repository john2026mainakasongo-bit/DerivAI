import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";

function extractLastDigit(value, decimals = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;

  const digits = number
    .toFixed(Math.max(0, decimals))
    .replace(/\D/g, "");

  return digits ? Number(digits.at(-1)) : null;
}

function chooseDefaultMarket(markets) {
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

function accountIdOf(account) {
  return String(
    account?.id ||
      account?.account_id ||
      account?.loginid ||
      account?.login_id ||
      ""
  );
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
  const wasConnectedRef = useRef(false);

  const selectedAccountId = accountIdOf(
    auth.selectedAccount
  );

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
      ].slice(-300)
    );
  }, []);

  useEffect(() => {
    const removeStatus = derivPublicClient.onStatus((next) => {
      setStatus(next.status);
      setStatusDetail(next.detail || "");
      const isConnected = next.status === "CONNECTED";
      setConnected(isConnected);
      wasConnectedRef.current = isConnected;
    });

    const removeTick = derivPublicClient.onTick(addTick);

    const removeContract = derivPublicClient.onContract(
      (contract) => {
        const id = String(
          contract?.contract_id ||
            contract?.id ||
            ""
        );

        if (!id) return;

        setOpenContracts((current) => {
          const next = current.filter(
            (item) =>
              String(
                item?.contract_id ||
                  item?.id ||
                  ""
              ) !== id
          );

          return [contract, ...next].slice(0, 25);
        });
      }
    );

    const removeTransaction = derivPublicClient.onTransaction(
      (transaction) => {
        setTransactions((current) =>
          [transaction, ...current].slice(0, 50)
        );
      }
    );

    return () => {
      removeStatus();
      removeTick();
      removeContract();
      removeTransaction();
    };
  }, [addTick]);

  useEffect(() => {
    const changed = derivPublicClient.configureAccount({
      accessToken: auth.session?.accessToken || "",
      appId: auth.config?.clientId || "",
      accountId: selectedAccountId,
    });

    if (!changed) return;

    setOpenContracts([]);
    setTransactions([]);
    setTradeError("");

    if (!wasConnectedRef.current) {
      derivPublicClient.disconnect({
        preserveAccount: true,
      });
      return;
    }

    let cancelled = false;

    async function reconnectSelectedAccount() {
      try {
        setStatusDetail("");
        setStatus("CONNECTING");
        setConnected(false);

        await derivPublicClient.reconnect();

        if (cancelled) return;

        const liveMarkets =
          await derivPublicClient.getVolatilityMarkets();

        if (cancelled) return;

        setMarkets(liveMarkets);

        const selected =
          liveMarkets.find(
            (item) => item.id === symbolRef.current
          ) ||
          chooseDefaultMarket(liveMarkets);

        if (selected) {
          symbolRef.current = selected.id;
          setSymbol(selected.id);
          setTicks([]);

          const history =
            await derivPublicClient.getHistory(
              selected.id,
              100
            );

          if (cancelled) return;

          setTicks(history.slice(-100));
          await derivPublicClient.subscribeTicks(
            selected.id
          );

          try {
            await derivPublicClient.subscribeTransactions();
          } catch {
            // Account may not support this subscription yet.
          }
        }
      } catch (error) {
        if (cancelled) return;

        derivPublicClient.disconnect({
          preserveAccount: true,
        });

        setConnected(false);
        setStatus("ERROR");
        setStatusDetail(
          error instanceof Error
            ? error.message
            : "Unable to reconnect the selected account."
        );
      }
    }

    void reconnectSelectedAccount();

    return () => {
      cancelled = true;
    };
  }, [
    auth.config?.clientId,
    auth.session?.accessToken,
    selectedAccountId,
  ]);

  const loadSymbol = useCallback(async (nextSymbol) => {
    if (!nextSymbol) {
      throw new Error("No Deriv market was selected.");
    }

    symbolRef.current = nextSymbol;
    setSymbol(nextSymbol);
    setLoadingMarket(true);
    setTicks([]);

    try {
      const history =
        await derivPublicClient.getHistory(
          nextSymbol,
          100
        );

      setTicks(history.slice(-100));

      await derivPublicClient.subscribeTicks(
        nextSymbol
      );
    } finally {
      setLoadingMarket(false);
    }
  }, []);

  const connect = useCallback(async () => {
    try {
      setStatusDetail("");
      setTradeError("");

      derivPublicClient.configureAccount({
        accessToken: auth.session?.accessToken || "",
        appId: auth.config?.clientId || "",
        accountId: selectedAccountId,
      });

      await derivPublicClient.connect();

      const liveMarkets =
        await derivPublicClient.getVolatilityMarkets();

      setMarkets(liveMarkets);

      const selected =
        liveMarkets.find(
          (item) => item.id === symbolRef.current
        ) ||
        chooseDefaultMarket(liveMarkets);

      if (!selected) {
        throw new Error(
          "No Volatility market was returned."
        );
      }

      await loadSymbol(selected.id);

      if (auth.authenticated && selectedAccountId) {
        try {
          await derivPublicClient.subscribeTransactions();
        } catch {
          // Keep market feed working even if transaction subscription fails.
        }
      }
    } catch (error) {
      derivPublicClient.disconnect({
        preserveAccount: true,
      });

      setConnected(false);
      setStatus("ERROR");
      setStatusDetail(
        error instanceof Error
          ? error.message
          : "Connection failed."
      );
    }
  }, [
    auth.authenticated,
    auth.config?.clientId,
    auth.session?.accessToken,
    loadSymbol,
    selectedAccountId,
  ]);

  const disconnect = useCallback(() => {
    derivPublicClient.disconnect({
      preserveAccount: true,
    });

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
    wasConnectedRef.current = false;
  }, []);

  const changeSymbol = useCallback(
    async (nextSymbol) => {
      if (!connected || !nextSymbol) return;

      try {
        setStatusDetail("");
        await loadSymbol(nextSymbol);
      } catch (error) {
        setStatusDetail(
          error instanceof Error
            ? error.message
            : "Unable to change market."
        );
      }
    },
    [connected, loadSymbol]
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

      const finalSymbol =
        tradeSymbol || symbolRef.current;

      if (!finalSymbol) {
        throw new Error(
          "Choose and connect a market first."
        );
      }

      setTradeBusy(true);
      setTradeError("");

      try {
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
          error instanceof Error
            ? error.message
            : "Trade failed.";

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

  const sellContract = useCallback(
    async (contractId, price = 0) => {
      setTradeBusy(true);
      setTradeError("");

      try {
        return await derivPublicClient.sellContract(
          contractId,
          price
        );
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
    },
    []
  );

  const loadPortfolio = useCallback(async () => {
    return derivPublicClient.getPortfolio();
  }, []);

  const loadStatement = useCallback(async (limit = 50) => {
    return derivPublicClient.getStatement(limit);
  }, []);

  const prices = useMemo(
    () =>
      ticks
        .map((tick) => Number(tick.quote))
        .filter(Number.isFinite),
    [ticks]
  );

  const currentPrice =
    prices.length ? prices.at(-1) : null;

  const lastDigit = useMemo(
    () =>
      extractLastDigit(
        currentPrice,
        market.decimals
      ),
    [currentPrice, market.decimals]
  );

  const digitHistory = useMemo(
    () =>
      prices
        .map((price) =>
          extractLastDigit(
            price,
            market.decimals
          )
        )
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
      Boolean(selectedAccountId),

    selectedAccountId,
    selectedAccountType:
      auth.selectedAccountType,

    openContracts,
    transactions,
    tradeBusy,
    tradeError,

    inspection: null,
    debugLog: [],

    connect,
    disconnect,
    changeSymbol,
    placeTrade,
    sellContract,
    loadPortfolio,
    loadStatement,
  };
}
