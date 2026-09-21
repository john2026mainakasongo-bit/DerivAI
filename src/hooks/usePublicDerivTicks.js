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

// Curated analysis watchlist: major Forex pairs plus selected USD-priced
// instruments. Synthetic Volatility indices are intentionally excluded.
const FOREX_TARGETS = [
  "frxEURUSD",
  "frxGBPUSD",
  "frxUSDJPY",
  "frxUSDCHF",
  "frxAUDUSD",
  "frxUSDCAD",
  "frxNZDUSD",
  "frxEURGBP",
];

const USD_TARGETS = [
  "XAUUSD",
  "frxXAUUSD",
  "XAGUSD",
  "frxXAGUSD",
  "BTCUSD",
  "cryBTCUSD",
  "ETHUSD",
  "cryETHUSD",
];

function keyOf(market) {
  return String(market?.id || market?.symbol || "");
}

function symbolId(market) {
  return String(market?.id || market?.symbol || "").toUpperCase();
}

function matchesTarget(market, targets = []) {
  const id = symbolId(market);
  const label = String(
    market?.label || market?.short || market?.name || ""
  ).toUpperCase().replace(/\s+/g, "");
  return targets.some((target) => {
    const t = String(target).toUpperCase();
    return id === t || id.endsWith(t) || label.includes(t);
  });
}

function matchesForex(market) {
  const id = symbolId(market);
  const label = String(
    market?.label || market?.short || market?.name || ""
  ).toUpperCase();
  return (
    String(market?.market || "").toLowerCase() === "forex" &&
    FOREX_TARGETS.some((target) => id === target.toUpperCase() || id.endsWith(target.toUpperCase())) ||
    /^(EUR|GBP|USD|JPY|CHF|AUD|CAD|NZD)\s*\/\s*(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD)$/.test(label)
  );
}

function matchesBTC(market) {
  return matchesTarget(market, ["BTCUSD", "CRYBTCUSD"]) ||
    /BTC\s*\/?\s*USD/i.test(String(market?.label || ""));
}

function matchesGold(market) {
  return matchesTarget(market, ["XAUUSD", "FRXXAUUSD"]) ||
    /GOLD\s*\/?\s*USD/i.test(String(market?.label || ""));
}

function matchesUSDAsset(market) {
  return matchesTarget(market, USD_TARGETS);
}

function chooseDefault(markets = []) {
  return (
    FOREX_TARGETS
      .map((target) => markets.find((m) => symbolId(m) === target.toUpperCase() || symbolId(m).endsWith(target.toUpperCase())))
      .find(Boolean) ||
    markets.find(matchesForex) ||
    markets.find(matchesGold) ||
    markets.find(matchesBTC) ||
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
  // Full OHLC history for every scanner market, keyed by symbol and timeframe seconds.
  const [marketCandleHistory, setMarketCandleHistory] = useState({});
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
              5000
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

        // Load the selected market's OHLC history in a controlled sequence.
        // Sending all 13 candle requests at once can trigger public-feed
        // throttling on refresh, leaving the chart with only a few live ticks.
        // The selected market must finish its historical candles before we
        // mark it as ready.
        for (const [, seconds] of Object.entries(TF_SECONDS)) {
          if (!mountedRef.current || symbolRef.current !== cleanSymbol) break;

          let normalizedCandles = [];
          let lastError = null;

          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              const candles = await derivPublicClient.getCandleHistory(
                cleanSymbol,
                Number(seconds),
                Number(seconds) >= 28800 ? 180 : 240
              );
              normalizedCandles = normalizeCandles(candles);
              if (normalizedCandles.length >= 35) break;
            } catch (error) {
              lastError = error;
            }

            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
            }
          }

          // If the candle endpoint is temporarily empty, derive a small live
          // fallback from the 5,000 tick history instead of mixing markets.
          if (normalizedCandles.length < 35) {
            const fallbackTicks = normalizeTicks(tickHistory);
            const fallback = candlesFromTicks(fallbackTicks, Number(seconds));
            if (fallback.length > normalizedCandles.length) {
              normalizedCandles = fallback;
            }
          }

          if (lastError && normalizedCandles.length === 0) {
            console.warn(
              `[MT5 PUBLIC] Candle history failed for ${cleanSymbol} ${seconds}s:`,
              lastError
            );
          }

          if (
            mountedRef.current &&
            symbolRef.current === cleanSymbol
          ) {
            setMarketCandleHistory((current) => ({
              ...current,
              [cleanSymbol]: {
                ...(current[cleanSymbol] || {}),
                [seconds]: normalizedCandles,
              },
            }));

            setCandleHistory((current) => ({
              ...current,
              [seconds]: normalizedCandles,
            }));
          }
        }

        if (mountedRef.current && symbolRef.current === cleanSymbol) {
          loadedSymbolRef.current = cleanSymbol;
          loadedAtRef.current = Date.now();
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

      const selectedMarkets = [
        ...FOREX_TARGETS
          .map((target) =>
            liveMarkets.find((market) =>
              symbolId(market) === target.toUpperCase() ||
              symbolId(market).endsWith(target.toUpperCase())
            )
          )
          .filter(Boolean),
        ...USD_TARGETS
          .map((target) =>
            liveMarkets.find((market) =>
              symbolId(market) === target.toUpperCase() ||
              symbolId(market).endsWith(target.toUpperCase())
            )
          )
          .filter(Boolean),
        liveMarkets.find(matchesForex),
        liveMarkets.find(matchesBTC),
        liveMarkets.find(matchesGold),
      ].filter(Boolean);

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

      // Do not fan out candle-history requests for every scanner market here.
      // The selected market is loaded fully by loadSymbol above. Scanner markets
      // use their tick history until selected, which avoids public-feed throttling
      // during page refresh. Selecting a market then loads all of its timeframes.

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

      // Selected-market candle history is intentionally loaded on demand.
      // Keeping this empty prevents refresh-time request bursts.

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

        const allMarkets =
          await derivPublicClient.getPublicMarkets();

        const liveMarkets = [
          ...FOREX_TARGETS
            .map((target) =>
              allMarkets.find((market) =>
                symbolId(market) === target.toUpperCase() ||
                symbolId(market).endsWith(target.toUpperCase())
              )
            )
            .filter(Boolean),
          ...USD_TARGETS
            .map((target) =>
              allMarkets.find((market) =>
                symbolId(market) === target.toUpperCase() ||
                symbolId(market).endsWith(target.toUpperCase())
              )
            )
            .filter(Boolean),
        ].filter(Boolean);

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
            "No supported Forex or USD market was returned."
          );
        }

        await loadSymbol(selected.id);

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
            marketCandleHistory?.[selectedKey]?.[seconds] ||
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
      marketCandleHistory,
      selectedKey,
      ticks,
    ]
  );

  return {
    markets,
    market: selectedMarket,

    marketTicks,
    marketCandleHistory,
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