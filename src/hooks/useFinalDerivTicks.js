import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_APP_ID = import.meta.env.VITE_DERIV_APP_ID || "1089";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DEFAULT_APP_ID}`;

export default function useFinalDerivTicks(symbol) {
  const socketRef = useRef(null);
  const reconnectRef = useRef(null);
  const aliveRef = useRef(true);

  const [ticks, setTicks] = useState([]);
  const [status, setStatus] = useState("CONNECTING");
  const [error, setError] = useState("");

  const disconnect = useCallback(() => {
    clearTimeout(reconnectRef.current);
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < 2) socket.close();
  }, []);

  const connect = useCallback(() => {
    disconnect();
    setStatus("CONNECTING");
    setError("");

    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      if (!aliveRef.current) return;
      setStatus("LIVE");
      socket.send(JSON.stringify({ ticks_history: symbol, count: 160, end: "latest", style: "ticks" }));
      socket.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    };

    socket.onmessage = (event) => {
      if (!aliveRef.current) return;
      const payload = JSON.parse(event.data);

      if (payload.error) {
        setError(payload.error.message || "Deriv feed error");
        setStatus("ERROR");
        return;
      }

      if (payload.msg_type === "history") {
        const prices = (payload.history?.prices || []).map(Number).filter(Number.isFinite);
        setTicks(prices.slice(-160));
      }

      if (payload.msg_type === "tick") {
        const quote = Number(payload.tick?.quote);
        if (Number.isFinite(quote)) {
          setTicks((current) => [...current.slice(-159), quote]);
        }
      }
    };

    socket.onerror = () => {
      if (!aliveRef.current) return;
      setError("Could not connect to Deriv live feed.");
      setStatus("ERROR");
    };

    socket.onclose = () => {
      if (!aliveRef.current) return;
      setStatus("RECONNECTING");
      reconnectRef.current = setTimeout(connect, 2500);
    };
  }, [disconnect, symbol]);

  useEffect(() => {
    aliveRef.current = true;
    setTicks([]);
    connect();

    return () => {
      aliveRef.current = false;
      disconnect();
    };
  }, [connect, disconnect]);

  return { ticks, status, error, reconnect: connect };
}
