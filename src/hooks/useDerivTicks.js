import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

export default function useDerivTicks() {
  const [markets, setMarkets] = useState([]);
  const [symbol, setSymbol] = useState("");
  const [status, setStatus] = useState("DISCONNECTED");
  const [statusDetail, setStatusDetail] = useState("");
  const [connected, setConnected] = useState(false);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [ticks, setTicks] = useState([]);

  const symbolRef = useRef("");

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
      setConnected(next.status === "CONNECTED");
    });

    const removeTick = derivPublicClient.onTick(addTick);

    return () => {
      removeStatus();
      removeTick();
    };
  }, [addTick]);

  const loadSymbol = useCallback(async (nextSymbol) => {
    if (!nextSymbol) throw new Error("No Deriv market was selected.");

    symbolRef.current = nextSymbol;
    setSymbol(nextSymbol);
    setLoadingMarket(true);
    setTicks([]);

    try {
      const history = await derivPublicClient.getHistory(nextSymbol, 100);
      setTicks(history.slice(-100));
      await derivPublicClient.subscribeTicks(nextSymbol);
    } finally {
      setLoadingMarket(false);
    }
  }, []);

  const connect = useCallback(async () => {
    try {
      setStatusDetail("");
      await derivPublicClient.connect();

      const liveMarkets = await derivPublicClient.getVolatilityMarkets();
      setMarkets(liveMarkets);

      const selected =
        liveMarkets.find((item) => item.id === symbolRef.current) ||
        chooseDefaultMarket(liveMarkets);

      if (!selected) throw new Error("No Volatility market was returned.");

      await loadSymbol(selected.id);
    } catch (error) {
      derivPublicClient.disconnect();
      setConnected(false);
      setStatus("ERROR");
      setStatusDetail(
        error instanceof Error ? error.message : "Connection failed."
      );
    }
  }, [loadSymbol]);

  const disconnect = useCallback(() => {
    derivPublicClient.disconnect();
    setConnected(false);
    setStatus("DISCONNECTED");
    setStatusDetail("");
    setTicks([]);
    setMarkets([]);
    setSymbol("");
    symbolRef.current = "";
  }, []);

  const changeSymbol = useCallback(
    async (nextSymbol) => {
      if (!connected || !nextSymbol) return;

      try {
        setStatusDetail("");
        await loadSymbol(nextSymbol);
      } catch (error) {
        setStatusDetail(
          error instanceof Error ? error.message : "Unable to change market."
        );
      }
    },
    [connected, loadSymbol]
  );

  const prices = useMemo(
    () => ticks.map((tick) => Number(tick.quote)).filter(Number.isFinite),
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
    inspection: null,
    debugLog: [],
    connect,
    disconnect,
    changeSymbol,
  };
}
