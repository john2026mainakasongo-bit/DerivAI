import { useCallback, useEffect, useRef, useState } from "react";

const APP_ID = import.meta.env.VITE_DERIV_APP_ID || "1089";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const DISPLAY_HINTS = {
  R_10: ["volatility 10 index", "volatility 10"],
  R_25: ["volatility 25 index", "volatility 25"],
  R_50: ["volatility 50 index", "volatility 50"],
  R_75: ["volatility 75 index", "volatility 75"],
  R_100: ["volatility 100 index", "volatility 100"],
  "1HZ10V": ["volatility 10 (1s) index", "volatility 10 1s"],
  "1HZ25V": ["volatility 25 (1s) index", "volatility 25 1s"],
  "1HZ50V": ["volatility 50 (1s) index", "volatility 50 1s"],
  "1HZ75V": ["volatility 75 (1s) index", "volatility 75 1s"],
  "1HZ100V": ["volatility 100 (1s) index", "volatility 100 1s"],
};

function symbolCode(item) {
  return item?.underlying_symbol || item?.symbol || "";
}

function symbolName(item) {
  return String(
    item?.display_name ||
      item?.display_name_with_symbol ||
      item?.market_display_name ||
      ""
  ).toLowerCase();
}

function resolveSymbol(requested, activeSymbols) {
  const exact = activeSymbols.find((item) => symbolCode(item) === requested);
  if (exact) return symbolCode(exact);

  const hints = DISPLAY_HINTS[requested] || [];
  const byName = activeSymbols.find((item) => {
    const name = symbolName(item);
    return hints.some((hint) => name.includes(hint));
  });
  if (byName) return symbolCode(byName);

  const requestedNumber = String(requested).match(/\d+/)?.[0];
  const volatilityFallback = activeSymbols.find((item) => {
    const code = symbolCode(item);
    const name = symbolName(item);
    return (
      requestedNumber &&
      name.includes("volatility") &&
      name.includes(requestedNumber) &&
      code
    );
  });

  return volatilityFallback ? symbolCode(volatilityFallback) : "";
}

export default function useFinalDerivTicks(requestedSymbol) {
  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const generationRef = useRef(0);

  const [ticks, setTicks] = useState([]);
  const [status, setStatus] = useState("CONNECTING");
  const [error, setError] = useState("");
  const [resolvedSymbol, setResolvedSymbol] = useState("");

  const disconnect = useCallback(() => {
    clearTimeout(reconnectTimerRef.current);
    const socket = socketRef.current;
    socketRef.current = null;

    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
  }, []);

  const connect = useCallback(() => {
    disconnect();

    const generation = ++generationRef.current;
    setTicks([]);
    setError("");
    setResolvedSymbol("");
    setStatus("CONNECTING");

    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;

    const isCurrent = () =>
      generationRef.current === generation && socketRef.current === socket;

    const subscribeToSymbol = (symbol) => {
      if (!symbol || !isCurrent() || socket.readyState !== WebSocket.OPEN) return;

      setResolvedSymbol(symbol);

      socket.send(
        JSON.stringify({
          ticks_history: symbol,
          count: 160,
          end: "latest",
          style: "ticks",
          req_id: 2001,
        })
      );

      socket.send(
        JSON.stringify({
          ticks: symbol,
          subscribe: 1,
          req_id: 2002,
        })
      );
    };

    socket.onopen = () => {
      if (!isCurrent()) return;

      setStatus("RESOLVING");

      // Always ask Deriv which symbols are currently active instead of
      // assuming a hard-coded code is still accepted.
      socket.send(
        JSON.stringify({
          active_symbols: "brief",
          product_type: "basic",
          req_id: 1001,
        })
      );
    };

    socket.onmessage = (event) => {
      if (!isCurrent()) return;

      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.error) {
        const message = payload.error.message || "Deriv feed error";

        // Some API deployments reject product_type. Retry active_symbols
        // without it before showing an error.
        if (
          payload.req_id === 1001 &&
          String(message).toLowerCase().includes("product")
        ) {
          socket.send(
            JSON.stringify({
              active_symbols: "brief",
              req_id: 1002,
            })
          );
          return;
        }

        setError(message);
        setStatus("ERROR");
        return;
      }

      if (payload.msg_type === "active_symbols") {
        const active = Array.isArray(payload.active_symbols)
          ? payload.active_symbols
          : [];

        const symbol = resolveSymbol(requestedSymbol, active);

        if (!symbol) {
          setError(
            `Volatility market ${requestedSymbol} is not available in Deriv active symbols.`
          );
          setStatus("ERROR");
          return;
        }

        subscribeToSymbol(symbol);
        return;
      }

      if (payload.msg_type === "history") {
        const prices = (payload.history?.prices || [])
          .map(Number)
          .filter(Number.isFinite);

        setTicks(prices.slice(-160));
        setStatus("LIVE");
        return;
      }

      if (payload.msg_type === "tick") {
        const quote = Number(payload.tick?.quote);

        if (Number.isFinite(quote)) {
          setTicks((current) => [...current.slice(-159), quote]);
          setStatus("LIVE");
          setError("");
        }
      }
    };

    socket.onerror = () => {
      if (!isCurrent()) return;
      setError("Could not connect to the Deriv WebSocket feed.");
      setStatus("ERROR");
    };

    socket.onclose = () => {
      if (!isCurrent()) return;

      setStatus("RECONNECTING");
      reconnectTimerRef.current = setTimeout(() => {
        if (generationRef.current === generation) {
          connect();
        }
      }, 2500);
    };
  }, [disconnect, requestedSymbol]);

  useEffect(() => {
    connect();
    return () => {
      generationRef.current += 1;
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    ticks,
    status,
    error,
    reconnect: connect,
    resolvedSymbol,
  };
}
