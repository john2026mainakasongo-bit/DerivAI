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

// MT5 Analysis Desk uses Deriv Volatility/Synthetic markets only.
// Forex, crypto and metals are intentionally excluded from this desk.
function isVolatilityMarket(market = {}) {
  const id = symbolId(market);
  const label = String(
    market?.label || market?.short || market?.name || ""
  ).toUpperCase();

  return (
    /VOLATILITY/.test(label) ||
    /HIGH\s*FREQUENCY\s*VOL/.test(label) ||
    /VOL\s*SWITCH|VSI/.test(label) ||
    /^R_\d+$/i.test(id) ||
    /^\d+HZ\d+V$/i.test(id)
  );
}

function volatilityRank(market = {}) {
  const text = `${market?.label || ""} ${market?.id || market?.symbol || ""}`;
  const m = text.match(/(?:VOLATILITY|VOL|VSI)[^0-9]*(\d+(?:\.\d+)?)/i);
  const value = m ? Number(m[1]) : 9999;
  const hf = /HIGH\s*FREQUENCY/i.test(text) ? 1 : 0;
  return [hf, value, text];
}

function chooseDefault(markets = []) {
  const ranked = [...markets].sort((a,b) => {
    const ra = volatilityRank(a), rb = volatilityRank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || String(ra[2]).localeCompare(String(rb[2]));
  });
  return ranked[0] || null;
}

function keyOf(market) {
  return String(market?.id || market?.symbol || "");
}

function symbolId(market) {
  return String(market?.id || market?.symbol || "").toUpperCase();
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
                Number(seconds) === 86400
                  ? 400
                  : Number(seconds) >= 28800
                    ? 180
                    : 240
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

      // Subscribe every Deriv Volatility market returned by active_symbols.
      const selectedMarkets = liveMarkets.filter(isVolatilityMarket);

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

        // Deriv is the source of truth for the current Volatility universe.
        // This keeps newly introduced volatility variants available without
        // hard-coding Forex/crypto/metals symbols.
        const liveMarkets = allMarkets
          .filter(isVolatilityMarket)
          .sort((a, b) => {
            const ra = volatilityRank(a);
            const rb = volatilityRank(b);
            return ra[0] - rb[0] || ra[1] - rb[1] ||
              String(ra[2]).localeCompare(String(rb[2]));
          });

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
            "No Deriv Volatility markets were returned."
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