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
    markets.find((item) => {
      const id = String(item?.id || "").toUpperCase();
      const symbol = String(item?.symbol || "").toUpperCase();

      return (
        id === "R_75" ||
        symbol === "R_75" ||
        id === "1HZ75V" ||
        symbol === "1HZ75V"
      );
    }) ||
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

export default function useDerivTicks({ multiMarket = false } = {}) {
  const auth = useDerivAuth();

  const [markets, setMarkets] = useState([]);
  const [symbol, setSymbol] = useState("");
  const [status, setStatus] = useState("DISCONNECTED");
  const [statusDetail, setStatusDetail] = useState("");
  const [connected, setConnected] = useState(false);
  const [loadingMarket, setLoadingMarket] = useState(false);

  const [ticks, setTicks] = useState([]);
  const [marketTicks, setMarketTicks] = useState({});

  const [candleHistory, setCandleHistory] = useState({
    60: [],
    120: [],
    180: [],
    300: [],
    600: [],
    900: [],
    1800: [],
    3600: [],
    7200: [],
    14400: [],
    28800: [],
    86400: [],
  });

  const [openContracts, setOpenContracts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeError, setTradeError] = useState("");

  const symbolRef = useRef("");
  const mountedRef = useRef(true);
  const manuallyDisconnectedRef = useRef(false);

  const loadSymbolPromiseRef = useRef(null);
  const loadedSymbolRef = useRef("");
  const loadedAtRef = useRef(0);

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

  const addTick = useCallback(
    (tick) => {
      if (!tick) return;

      const tickSymbol = String(tick.symbol || "");
      if (!tickSymbol) return;

      const normalized = {
        quote: Number(tick.quote),
        epoch: Number(tick.epoch),
      };

      if (!Number.isFinite(normalized.quote)) return;

      if (multiMarket) {
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

      if (tickSymbol !== symbolRef.current) return;

      setTicks((current) =>
        [...current, normalized].slice(-5000)
      );
    },
    [multiMarket]
  );

  const loadSymbol = useCallback(async (nextSymbol) => {
    if (!nextSymbol) {
      throw new Error("No Deriv market was selected.");
    }

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

      if (mountedRef.current) {
        setLoadingMarket(false);
      }

      return;
    }

    setLoadingMarket(true);
    setTicks([]);

  const [candleHistory, setCandleHistory] = useState({
    60: [],
    120: [],
    180: [],
    300: [],
    600: [],
    900: [],
    1800: [],
    3600: [],
    7200: [],
    14400: [],
    28800: [],
    86400: [],
  });

    const promise = (async () => {
      try {
        await derivPublicClient.subscribeTicks(nextSymbol);
      } catch (error) {
        if (!duplicateSubscription(error)) throw error;
      }

      loadedSymbolRef.current = nextSymbol;
      loadedAtRef.current = Date.now();

      if (mountedRef.current) {
        setLoadingMarket(false);
      }

      void (async () => {
        try {
          const history = await derivPublicClient.getHistory(
            nextSymbol,
            500
          );

          if (
            mountedRef.current &&
            symbolRef.current === nextSymbol
          ) {
            setTicks(history.slice(-500));
          }
        } catch (error) {
          console.warn(
            "[ZENTORA] Background tick history unavailable:",
            error
          );
        }

        const candleRequests = [
          [60, 240],
          [120, 240],
          [180, 240],
          [300, 240],
          [600, 240],
          [900, 240],
          [1800, 240],
          [3600, 240],
          [7200, 240],
          [14400, 240],
          [28800, 180],
          [86400, 180],
        ];

        await Promise.all(
          candleRequests.map(async ([granularity, count]) => {
            try {
              const candles =
                await derivPublicClient.getCandleHistory(
                  nextSymbol,
                  granularity,
                  count
                );

              if (
                mountedRef.current &&
                symbolRef.current === nextSymbol
              ) {
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
          })
        );
      })();
    })();

    loadSymbolPromiseRef.current = {
      symbol: nextSymbol,
      promise,
    };

    promise
      .finally(() => {
        if (
          loadSymbolPromiseRef.current?.symbol === nextSymbol
        ) {
          loadSymbolPromiseRef.current = null;
        }
      })
      .catch(() => {});

    return promise;
  }, []);

  /*
   * Multi-market bootstrap.
   *
   * Supported identifiers:
   *   V100 -> R_100 / 1HZ100V
   *   V75  -> R_75  / 1HZ75V
   *   V25  -> R_25  / 1HZ25V
   *   V10  -> R_10  / 1HZ10V
   *
   * We prefer the actual symbol/id instead of relying only on the
   * human-readable label because Deriv can return different labels
   * for the same underlying market.
   */
  const loadMultiMarkets = useCallback(
    async (liveMarkets = []) => {
      if (!multiMarket) return;

      const wanted = [100, 75, 25, 10];

      const selectedMarkets = wanted
        .map((value) => {
          const expectedSymbols = [
            `R_${value}`,
            `1HZ${value}V`,
          ];

          return (
            liveMarkets.find((item) => {
              const id = String(item?.id || "").toUpperCase();
              const itemSymbol = String(
                item?.symbol || ""
              ).toUpperCase();

              return (
                expectedSymbols.includes(id) ||
                expectedSymbols.includes(itemSymbol)
              );
            }) ||
            liveMarkets.find((item) => {
              const label = String(item?.label || "");

              return new RegExp(
                `Volatility\\s*${value}(?:\\s*\\([^)]*\\))?\\s*Index`,
                "i"
              ).test(label);
            })
          );
        })
        .filter(Boolean);

      const symbols = [
        ...new Set(
          selectedMarkets
            .map((item) => item?.id || item?.symbol)
            .map((value) => String(value || "").trim())
            .filter(Boolean)
        ),
      ];

      console.log(
        "[DigitOver V12] Selected markets:",
        selectedMarkets.map((item) => ({
          id: item?.id,
          symbol: item?.symbol,
          label: item?.label,
          short: item?.short,
        }))
      );

      console.log(
        "[DigitOver V12] Subscribing:",
        symbols
      );

      if (!symbols.length) {
        console.warn(
          "[DigitOver V12] No supported multi-market symbols found."
        );
        return;
      }

      /*
       * Subscribe to all selected markets concurrently.
       */
      await derivPublicClient.subscribeTicksMulti(symbols);

      /*
       * Load 100 historical ticks per market concurrently.
       * Keep the latest 60 because Digit Over/Under analysis
       * operates on the recent digit sequence.
       */
      const historyResults = await Promise.all(
        selectedMarkets.map(async (item) => {
          const marketId = String(
            item?.id || item?.symbol || ""
          );

          try {
            const history =
              await derivPublicClient.getHistory(
                marketId,
                100
              );

            return [
              marketId,
              history.slice(-60),
            ];
          } catch (error) {
            console.warn(
              `[DigitOver V12] History failed for ${marketId}:`,
              error
            );

            return [marketId, []];
          }
        })
      );

      if (!mountedRef.current) return;

      setMarketTicks((current) => {
        const next = { ...current };

        for (const [marketId, history] of historyResults) {
          next[marketId] = history;
        }

        return next;
      });

      console.log(
        "[DigitOver V12] Multi-market books loaded:",
        historyResults.map(([marketId, history]) => ({
          marketId,
          ticks: Array.isArray(history)
            ? history.length
            : 0,
        }))
      );
    },
    [multiMarket]
  );

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

    if (
      auth.authenticated &&
      selectedAccountId &&
      derivPublicClient.socket?.readyState ===
        WebSocket.OPEN &&
      !derivPublicClient.socketAuthenticated
    ) {
      derivPublicClient.disconnect({
        preserveAccount: true,
        preserveSymbol: true,
      });
    }

    if (nextKey !== sharedAccountKey) {
      sharedAccountKey = nextKey;
      resetSharedSubscriptions();
    }

    try {
      const connection = await ensureSharedSocket({
        allowPublicFallback:
          !auth.authenticated || !selectedAccountId,
      });

      const liveMarkets =
        await derivPublicClient.getVolatilityMarkets();

      if (!liveMarkets.length) {
        throw new Error(
          "No Volatility markets were returned."
        );
      }

      if (!mountedRef.current) return connection;

      setMarkets(liveMarkets);

      const selected =
        liveMarkets.find(
          (item) => item.id === symbolRef.current
        ) || chooseDefaultMarket(liveMarkets);

      if (!selected) {
        throw new Error(
          "No Volatility market could be selected."
        );
      }

      await loadSymbol(selected.id);

      if (multiMarket) {
        await loadMultiMarkets(liveMarkets);
      }

      if (
        auth.authenticated &&
        selectedAccountId &&
        connection?.authenticated
      ) {
        try {
          await ensureTransactions();
        } catch (error) {
          if (!duplicateSubscription(error)) {
            throw error;
          }
        }
      }

      const tradingConnectionRequired =
        Boolean(
          auth.authenticated &&
            selectedAccountId
        );

      if (
        tradingConnectionRequired &&
        !connection?.authenticated
      ) {
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
        error instanceof Error
          ? error.message
          : "Connection failed."
      );

      throw error;
    }
  }, [
    auth.authenticated,
    auth.config?.clientId,
    auth.session?.accessToken,
    loadSymbol,
    selectedAccountId,
    multiMarket,
    loadMultiMarkets,
  ]);

  useEffect(() => {
    mountedRef.current = true;

    const removeStatus =
      derivPublicClient.onStatus((next) => {
        if (!mountedRef.current) return;

        setStatus(next.status);
        setStatusDetail(next.detail || "");

        const requiresTradingAuth =
          Boolean(
            auth.authenticated &&
              selectedAccountId
          );

        setConnected(
          next.status === "CONNECTED" &&
            (!requiresTradingAuth ||
              Boolean(next.authenticated))
        );

        if (
          [
            "OFFLINE",
            "ERROR",
            "DISCONNECTED",
          ].includes(next.status)
        ) {
          resetSharedSubscriptions();
        }

        if (
          [
            "OFFLINE",
            "ERROR",
            "DISCONNECTED",
          ].includes(next.status) &&
          !manuallyDisconnectedRef.current
        ) {
          if (reconnectTimer) {
            window.clearTimeout(reconnectTimer);
          }

          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;

            if (
              !manuallyDisconnectedRef.current
            ) {
              void connect().catch(() => {});
            }
          }, 1500);
        }
      });

    const removeTick =
      derivPublicClient.onTick(addTick);

    const removeContract =
      derivPublicClient.onContract(
        (contract) => {
          const id = String(
            contract?.contract_id ||
              contract?.contractId ||
              contract?.id ||
              contract?.proposal_open_contract
                ?.contract_id ||
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

            return [merged, ...rest].slice(
              0,
              30
            );
          });
        }
      );

    const removeTransaction =
      derivPublicClient.onTransaction(
        (transaction) => {
          setTransactions((current) =>
            [transaction, ...current].slice(
              0,
              60
            )
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
      accessToken:
        auth.session?.accessToken || "",
      appId:
        auth.config?.clientId || "",
      accountId: selectedAccountId,
    };

    const nextKey = accountKey(config);
    const changed =
      derivPublicClient.configureAccount(
        config
      );

    if (nextKey !== sharedAccountKey) {
      sharedAccountKey = nextKey;
      resetSharedSubscriptions();
    }

    if (!changed) return;

    setOpenContracts([]);
    setTransactions([]);
    setTradeError("");

    void (async () => {
      try {
        await derivPublicClient.reconnect({
          allowPublicFallback:
            !auth.authenticated ||
            !selectedAccountId,
        });

        const liveMarkets =
          await derivPublicClient.getVolatilityMarkets();

        setMarkets(liveMarkets);

        const selected =
          liveMarkets.find(
            (item) =>
              item.id === symbolRef.current
          ) ||
          chooseDefaultMarket(liveMarkets);

        if (selected) {
          await loadSymbol(selected.id);

          if (multiMarket) {
            await loadMultiMarkets(
              liveMarkets
            );
          }
        }
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
    multiMarket,
    loadMultiMarkets,
  ]);

  useEffect(() => {
    if (
      !auth.authenticated ||
      !selectedAccountId ||
      manuallyDisconnectedRef.current
    ) {
      return;
    }

    if (
      !connected &&
      status !== "CONNECTING" &&
      !loadingMarket
    ) {
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

  useEffect(() => {
    if (
      !auth.authenticated ||
      !selectedAccountId ||
      manuallyDisconnectedRef.current
    ) {
      return undefined;
    }

    let disposed = false;
    let timer = null;

    const attempt = async () => {
      if (
        disposed ||
        manuallyDisconnectedRef.current ||
        connected ||
        status === "CONNECTING"
      ) {
        return;
      }

      try {
        await connect();
      } catch (_) {
        // Next watchdog cycle retries.
      }
    };

    const tick = () => {
      if (disposed) return;

      void attempt();

      timer = window.setTimeout(
        tick,
        4000
      );
    };

    timer = window.setTimeout(
      tick,
      250
    );

    return () => {
      disposed = true;

      if (timer) {
        window.clearTimeout(timer);
      }
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
      window.clearTimeout(
        reconnectTimer
      );

      reconnectTimer = null;
    }

    derivPublicClient.disconnect({
      preserveAccount: true,
    });

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
      if (
        !auth.authenticated ||
        !selectedAccountId
      ) {
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

      if (
        !derivPublicClient.socketAuthenticated
      ) {
        await derivPublicClient.ensureTradingConnection();
      }

      return derivPublicClient.quoteContract({
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
    },
    [
      auth.authenticated,
      auth.selectedAccount?.currency,
      selectedAccountId,
    ]
  );

  const placeQuotedTrade = useCallback(
    async ({ quote }) => {
      if (
        !auth.authenticated ||
        !selectedAccountId
      ) {
        throw new Error(
          "Log in and choose a Demo or Real account first."
        );
      }

      if (!quote?.proposalId) {
        throw new Error(
          "A valid proposal is required before buying."
        );
      }

      setTradeBusy(true);
      setTradeError("");

      try {
        const selectedConfig = {
          accessToken:
            auth.session?.accessToken || "",
          appId:
            auth.config?.clientId || "",
          accountId: selectedAccountId,
        };

        derivPublicClient.configureAccount(
          selectedConfig
        );

        await derivPublicClient.ensureTradingConnection();

        sharedTransactionReady = false;
        await ensureTransactions();

        const bought =
          await derivPublicClient.buyQuotedContract(
            quote
          );

        const contractId = String(
          bought?.contractId ||
            bought?.contract_id ||
            bought?.buy?.contract_id ||
            bought?.raw?.buy?.contract_id ||
            bought?.raw?.data?.buy
              ?.contract_id ||
            ""
        );

        if (!contractId) {
          throw new Error(
            "Deriv confirmed the purchase but no contract ID was returned."
          );
        }

        activeContractIdsRef.current.add(
          contractId
        );

        setOpenContracts((current) => {
          const optimistic = {
            contract_id: contractId,
            id: contractId,
            status: "OPEN",
            is_sold: false,
            is_expired: false,
            symbol:
              quote?.request?.symbol ||
              symbolRef.current,
            underlying:
              quote?.request?.symbol ||
              symbolRef.current,
            contract_type:
              quote?.request?.contractType ||
              "",
            buy_price: Number(
              quote?.askPrice || 0
            ),
            purchase_price: Number(
              quote?.askPrice || 0
            ),
            date_start:
              Math.floor(Date.now() / 1000),
            duration: Number(
              quote?.request?.duration || 0
            ),
            duration_unit:
              quote?.request?.durationUnit ||
              "t",
            quantum_pending: true,
          };

          return [
            optimistic,
            ...current.filter(
              (item) =>
                String(
                  item?.contract_id ||
                    item?.contractId ||
                    item?.id ||
                    ""
                ) !== contractId
            ),
          ].slice(0, 30);
        });

        return {
          ...bought,
          contractId,
        };
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
      auth.config?.clientId,
      auth.session?.accessToken,
      selectedAccountId,
    ]
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
      if (
        !auth.authenticated ||
        !selectedAccountId
      ) {
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
        const selectedConfig = {
          accessToken:
            auth.session?.accessToken || "",
          appId:
            auth.config?.clientId || "",
          accountId: selectedAccountId,
        };

        derivPublicClient.configureAccount(
          selectedConfig
        );

        await derivPublicClient.ensureTradingConnection();

        sharedTransactionReady = false;
        await ensureTransactions();

        const bought =
          await derivPublicClient.buyContract({
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
            bought?.raw?.data?.buy
              ?.contract_id ||
            ""
        );

        if (!contractId) {
          throw new Error(
            "Deriv confirmed the purchase but no contract ID was returned."
          );
        }

        activeContractIdsRef.current.add(
          contractId
        );

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
            date_start:
              Math.floor(Date.now() / 1000),
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

          return [
            optimistic,
            ...rest,
          ].slice(0, 30);
        });

        return {
          ...bought,
          contractId,
        };
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
      auth.config?.clientId,
      auth.session?.accessToken,
      selectedAccountId,
    ]
  );

  const refreshContract = useCallback(
    async (contractId) => {
      const id = String(
        contractId || ""
      ).trim();

      if (!id) {
        throw new Error(
          "A contract ID is required."
        );
      }

      await derivPublicClient.ensureTradingConnection();

      return derivPublicClient.subscribeOpenContract(
        id
      );
    },
    []
  );

  const sellContract = useCallback(
    async (contractId, price = 0) => {
      setTradeBusy(true);
      setTradeError("");

      try {
        await derivPublicClient.ensureTradingConnection();

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

  const loadPortfolio = useCallback(
    async () => {
      await derivPublicClient.ensureTradingConnection();

      return derivPublicClient.getPortfolio();
    },
    []
  );

  const loadStatement = useCallback(
    async (limit = 50) => {
      await derivPublicClient.ensureTradingConnection();

      return derivPublicClient.getStatement(
        limit
      );
    },
    []
  );

  const prices = useMemo(
    () =>
      ticks
        .map((tick) => Number(tick.quote))
        .filter(Number.isFinite),
    [ticks]
  );

  const digitHistoryBySymbol = useMemo(() => {
    if (!multiMarket) return {};

    const output = {};

    for (const item of markets) {
      const marketId = item.id;

      const rows = Array.isArray(
        marketTicks[marketId]
      )
        ? marketTicks[marketId]
        : [];

      output[marketId] = rows
        .map((row) =>
          extractLastDigit(
            row.quote,
            item.decimals
          )
        )
        .filter(Number.isInteger)
        .slice(-60);
    }

    return output;
  }, [
    markets,
    marketTicks,
    multiMarket,
  ]);

  const currentPrice = prices.length
    ? prices.at(-1)
    : null;

  const lastDigit = useMemo(
    () =>
      extractLastDigit(
        currentPrice,
        market.decimals
      ),
    [
      currentPrice,
      market.decimals,
    ]
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
    [
      prices,
      market.decimals,
    ]
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

    marketTicks,
    digitHistoryBySymbol,
    multiMarket,

    authenticatedFeed:
      connected &&
      auth.authenticated &&
      Boolean(selectedAccountId) &&
      Boolean(
        derivPublicClient.socketAuthenticated
      ),

    selectedAccountId,
    selectedAccount:
      auth.selectedAccount,
    selectedAccountType:
      auth.selectedAccountType,

    openContracts,
    transactions,
    tradeBusy,
    tradeError,

    inspection: null,
    debugLog:
      derivPublicClient.debugLog || [],

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