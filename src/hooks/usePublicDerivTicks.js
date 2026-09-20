import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import derivPublicClient from "../services/derivApi";

const TF_SECONDS = {
  "1m": 60,
  "2m": 120,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "8h": 28800,
  "24h": 86400,
};

const WANTED = [100, 75, 25, 10];

function keyOf(market) {
  return String(market?.id || market?.symbol || "");
}

function matchesMarket(market, value) {
  const id = String(market?.id || "").toUpperCase();
  const symbol = String(market?.symbol || "").toUpperCase();
  const label = String(
    market?.label || market?.short || market?.name || ""
  );

  return (
    id === `R_${value}` ||
    id === `1HZ${value}V` ||
    symbol === `R_${value}` ||
    symbol === `1HZ${value}V` ||
    new RegExp(
      `Volatility\\s*${value}(?:\\s*\\([^)]*\\))?\\s*Index`,
      "i"
    ).test(label)
  );
}

function chooseDefault(markets = []) {
  return (
    markets.find((m) => /^Volatility 75 Index$/i.test(String(m?.label || ""))) ||
    markets.find((m) => matchesMarket(m, 75)) ||
    markets[0] ||
    null
  );
}

function normalizeTicks(rows = []) {
  return rows
    .map((row) => ({
      quote: Number(row?.quote),
      epoch: Number(row?.epoch),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.quote) &&
        Number.isFinite(row.epoch)
    );
}

function normalizeCandles(rows = []) {
  return rows
    .map((row) => ({
      time: Number(row?.time ?? row?.epoch),
      open: Number(row?.open),
      high: Number(row?.high),
      low: Number(row?.low),
      close: Number(row?.close),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.time) &&
        Number.isFinite(row.open) &&
        Number.isFinite(row.high) &&
        Number.isFinite(row.low) &&
        Number.isFinite(row.close)
    )
    .sort((a, b) => a.time - b.time);
}

function candlesFromTicks(rows = [], seconds = 60) {
  const map = new Map();

  for (const row of rows) {
    const epoch = Number(row?.epoch);
    const quote = Number(row?.quote);

    if (!Number.isFinite(epoch) || !Number.isFinite(quote)) {
      continue;
    }

    const bucket =
      Math.floor(epoch / seconds) * seconds;

    const current = map.get(bucket);

    if (!current) {
      map.set(bucket, {
        time: bucket,
        open: quote,
        high: quote,
        low: quote,
        close: quote,
      });
      continue;
    }

    current.high = Math.max(current.high, quote);
    current.low = Math.min(current.low, quote);
    current.close = quote;
  }

  return [...map.values()].sort(
    (a, b) => a.time - b.time
  );
}

export default function usePublicDerivTicks({
  multiMarket = false,
} = {}) {
  const [markets, setMarkets] = useState([]);
  const [marketTicks, setMarketTicks] = useState({});
  const [candleHistory, setCandleHistory] = useState(() => {
    const initial = {};

    for (const seconds of Object.values(TF_SECONDS)) {
      initial[seconds] = [];
    }

    return initial;
  });

  const [symbol, setSymbol] = useState("");
  const [status, setStatus] = useState("DISCONNECTED");
  const [connected, setConnected] = useState(false);
  const [loadingMarket, setLoadingMarket] = useState(false);

  const mountedRef = useRef(true);
  const symbolRef = useRef("");
  const loadPromiseRef = useRef(null);
  const loadedAtRef = useRef(0);
  const loadedSymbolRef = useRef("");

  const addTick = useCallback(
    (tick) => {
      if (!tick) return;

      const tickSymbol = String(
        tick.symbol || ""
      ).trim();

      const quote = Number(tick.quote);
      const epoch = Number(tick.epoch);

      if (
        !tickSymbol ||
        !Number.isFinite(quote) ||
        !Number.isFinite(epoch)
      ) {
        return;
      }

      const normalized = {
        quote,
        epoch,
      };

      // Store each incoming tick exactly once.  The previous implementation
      // appended the selected market twice when multiMarket=true, which could
      // make the forming candle jump instead of following the real tick flow.
      if (multiMarket || tickSymbol === symbolRef.current) {
        setMarketTicks((current) => ({
          ...current,
          [tickSymbol]: [
            ...(Array.isArray(current[tickSymbol])
              ? current[tickSymbol]
              : []),
            normalized,
          ].slice(-5000),
        }));
      }
    },
    [multiMarket]
  );

  const loadSymbol = useCallback(async (nextSymbol) => {
    const cleanSymbol = String(
      nextSymbol || ""
    ).trim();

    if (!cleanSymbol) {
      throw new Error(
        "No Deriv market was selected."
      );
    }

    if (
      loadPromiseRef.current?.symbol === cleanSymbol &&
      loadPromiseRef.current?.promise
    ) {
      return loadPromiseRef.current.promise;
    }

    const recentlyLoaded =
      loadedSymbolRef.current === cleanSymbol &&
      Date.now() - loadedAtRef.current < 15000;

    symbolRef.current = cleanSymbol;
    setSymbol(cleanSymbol);

    if (recentlyLoaded) {
      try {
        await derivPublicClient.subscribeTicks(
          cleanSymbol
        );
      } catch (error) {
        if (
          !/already subscribed|duplicate subscription/i.test(
            error instanceof Error
              ? error.message
              : String(error || "")
          )
        ) {
          throw error;
        }
      }

      if (mountedRef.current) {
        setLoadingMarket(false);
      }

      return;
    }

    setLoadingMarket(true);

    const promise = (async () => {
      try {
        try {
          await derivPublicClient.subscribeTicks(
            cleanSymbol
          );
        } catch (error) {
          if (
            !/already subscribed|duplicate subscription/i.test(
              error instanceof Error
                ? error.message
                : String(error || "")
            )
          ) {
            throw error;
          }
        }

        let tickHistory = [];

        try {
          tickHistory =
            await derivPublicClient.getHistory(
              cleanSymbol,
              500
            );
        } catch (error) {
          console.warn(
            "[MT5 PUBLIC] Tick history unavailable:",
            error
          );
        }

        if (mountedRef.current) {
          setMarketTicks((current) => ({
            ...current,
            [cleanSymbol]: normalizeTicks(
              tickHistory
            ).slice(-5000),
          }));
        }

        loadedSymbolRef.current =
          cleanSymbol;

        loadedAtRef.current = Date.now();

        const requests = Object.entries(
          TF_SECONDS
        );

        await Promise.all(
          requests.map(
            async ([, seconds]) => {
              try {
                const candles =
                  await derivPublicClient.getCandleHistory(
                    cleanSymbol,
                    Number(seconds),
                    Number(seconds) >= 28800
                      ? 180
                      : 240
                  );

                if (
                  mountedRef.current &&
                  symbolRef.current === cleanSymbol
                ) {
                  setCandleHistory(
                    (current) => ({
                      ...current,
                      [seconds]:
                        normalizeCandles(candles),
                    })
                  );
                }
              } catch (error) {
                console.warn(
                  `[MT5 PUBLIC] Candle history failed for ${cleanSymbol} ${seconds}s:`,
                  error
                );
              }
            }
          )
        );

        if (mountedRef.current) {
          setLoadingMarket(false);
        }
      } catch (error) {
        if (mountedRef.current) {
          setLoadingMarket(false);
        }

        throw error;
      }
    })();

    loadPromiseRef.current = {
      symbol: cleanSymbol,
      promise,
    };

    promise.finally(() => {
      if (
        loadPromiseRef.current?.symbol ===
        cleanSymbol
      ) {
        loadPromiseRef.current = null;
      }
    }).catch(() => {});

    return promise;
  }, []);

  const loadAllMarkets = useCallback(
    async (liveMarkets = []) => {
      if (!multiMarket) {
        return;
      }

      const selectedMarkets = WANTED
        .map((value) =>
          liveMarkets.find((market) =>
            matchesMarket(market, value)
          )
        )
        .filter(Boolean);

      const symbols = [
        ...new Set(
          selectedMarkets
            .map((market) =>
              String(
                market?.id ||
                market?.symbol ||
                ""
              ).trim()
            )
            .filter(Boolean)
        ),
      ];

      if (!symbols.length) {
        return;
      }

      try {
        await derivPublicClient.subscribeTicksMulti(
          symbols
        );
      } catch (error) {
        if (
          !/already subscribed|duplicate subscription/i.test(
            error instanceof Error
              ? error.message
              : String(error || "")
          )
        ) {
          throw error;
        }
      }

      const histories =
        await Promise.all(
          selectedMarkets.map(
            async (market) => {
              const marketId = String(
                market?.id ||
                  market?.symbol ||
                  ""
              );

              try {
                const rows =
                  await derivPublicClient.getHistory(
                    marketId,
                    500
                  );

                return [
                  marketId,
                  normalizeTicks(rows),
                ];
              } catch (error) {
                console.warn(
                  `[MT5 PUBLIC] History failed for ${marketId}:`,
                  error
                );

                return [
                  marketId,
                  [],
                ];
              }
            }
          )
        );

      if (!mountedRef.current) {
        return;
      }

      setMarketTicks((current) => {
        const next = {
          ...current,
        };

        for (const [marketId, history] of histories) {
          next[marketId] = history.slice(-5000);
        }

        return next;
      });
    },
    [multiMarket]
  );

  const connect = useCallback(
    async () => {
      setStatus("CONNECTING");

      try {
        /*
         * Force this client into read-only/public mode.
         * MT5 analysis must not depend on Demo/Real account
         * authentication.
         */
        derivPublicClient.configureAccount({
          accessToken: "",
          appId: "",
          accountId: "",
        });

        /*
         * Public market connection only.
         */
        const connection =
          await derivPublicClient.connect({
            allowPublicFallback: true,
          });

        const liveMarkets =
          await derivPublicClient.getVolatilityMarkets();

        if (!mountedRef.current) {
          return connection;
        }

        setMarkets(liveMarkets);

        const selected =
          liveMarkets.find(
            (market) =>
              market.id === symbolRef.current
          ) ||
          chooseDefault(liveMarkets);

        if (!selected) {
          throw new Error(
            "No Volatility market was returned."
          );
        }

        await loadSymbol(selected.id);

        if (multiMarket) {
          await loadAllMarkets(
            liveMarkets
          );
        }

        if (mountedRef.current) {
          setConnected(true);
          setStatus("CONNECTED");
        }

        return connection;
      } catch (error) {
        if (mountedRef.current) {
          setConnected(false);
          setStatus("ERROR");
        }

        throw error;
      }
    },
    [
      loadSymbol,
      loadAllMarkets,
      multiMarket,
    ]
  );

  useEffect(() => {
    mountedRef.current = true;

    const removeStatus =
      derivPublicClient.onStatus(
        (next) => {
          if (!mountedRef.current) {
            return;
          }

          setStatus(
            next?.status ||
              "DISCONNECTED"
          );

          setConnected(
            next?.status === "CONNECTED" &&
              next?.authenticated === false
          );
        }
      );

    const removeTick =
      derivPublicClient.onTick(addTick);

    const reconnect = () => {
      if (
        document.visibilityState !==
        "visible"
      ) {
        return;
      }

      void connect().catch(() => {});
    };

    window.addEventListener(
      "pageshow",
      reconnect
    );

    window.addEventListener(
      "online",
      reconnect
    );

    document.addEventListener(
      "visibilitychange",
      reconnect
    );

    void connect().catch(() => {});

    return () => {
      mountedRef.current = false;

      removeStatus?.();
      removeTick?.();

      window.removeEventListener(
        "pageshow",
        reconnect
      );

      window.removeEventListener(
        "online",
        reconnect
      );

      document.removeEventListener(
        "visibilitychange",
        reconnect
      );
    };
  }, [addTick, connect]);

  const changeSymbol = useCallback(
    async (nextSymbol) => {
      const cleanSymbol = String(
        nextSymbol || ""
      ).trim();

      if (!cleanSymbol) {
        return;
      }

      if (!connected) {
        await connect();
      }

      await loadSymbol(cleanSymbol);
    },
    [
      connected,
      connect,
      loadSymbol,
    ]
  );

  const selectedMarket = useMemo(
    () =>
      markets.find(
        (market) =>
          keyOf(market) === symbol
      ) ||
      chooseDefault(markets),
    [markets, symbol]
  );

  const selectedKey = keyOf(
    selectedMarket
  );

  const ticks = useMemo(
    () =>
      selectedKey
        ? normalizeTicks(
            marketTicks[selectedKey] || []
          )
        : [],
    [marketTicks, selectedKey]
  );

  const prices = useMemo(
    () =>
      ticks
        .map((tick) => Number(tick.quote))
        .filter(Number.isFinite),
    [ticks]
  );

  const currentPrice =
    prices.length
      ? prices.at(-1)
      : null;

  const candleDataByTf = useMemo(
    () => {
      const out = {};

      for (const [
        label,
        seconds,
      ] of Object.entries(
        TF_SECONDS
      )) {
        const stored =
          normalizeCandles(
            candleHistory[seconds]
          );

        out[label] =
          stored.length >= 24
            ? stored
            : candlesFromTicks(
                ticks,
                seconds
              );
      }

      return out;
    },
    [
      candleHistory,
      ticks,
    ]
  );

  return {
    markets,
    market: selectedMarket,

    marketTicks,
    candleHistory,

    candleDataByTf,

    symbol,
    status,
    connected,
    loadingMarket,

    ticks,
    prices,
    currentPrice,

    changeSymbol,
    connect,
  };
}