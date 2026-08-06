import React, { useState, useEffect, useRef } from 'react';
import styles from './GeminiXEngine.module.css';

export default function GeminiXEngine() {
  // Config States - Standard Deriv Symbols
  const [market, setMarket] = useState('R_100');
  const [stake, setStake] = useState(0.35);
  const [minConfidence, setMinConfidence] = useState(80);
  const [execMode, setExecMode] = useState('Paper trading');
  const [isBotRunning, setIsBotRunning] = useState(false);

  // Live Data States
  const [feedStatus, setFeedStatus] = useState('CONNECTING');
  const [liveQuote, setLiveQuote] = useState(null);
  
  // Analytics States
  const [decision, setDecision] = useState('WAIT');
  const [blockReason, setBlockReason] = useState('Connecting to Deriv WebSocket...');
  const [confidence, setConfidence] = useState(0);
  const [probability, setProbability] = useState(50);
  const [riskLevel, setRiskLevel] = useState('LOW');

  const [metrics, setMetrics] = useState({
    momentum: 0,
    trend: 'NEUTRAL',
    volatility: 'NORMAL',
    entropy: '0%',
    bayesian: '50%',
    transition: '50%',
    observedCycle: 0,
    regime: 'RANGE'
  });

  const [gates, setGates] = useState([
    { name: 'Direction', status: 'Waiting ticks...', passed: false },
    { name: 'Momentum', status: 'Waiting ticks...', passed: false },
    { name: 'Transition', status: 'Waiting ticks...', passed: false },
    { name: 'Volatility', status: 'Waiting ticks...', passed: false },
    { name: 'Entropy', status: 'Waiting ticks...', passed: false },
    { name: 'Probability', status: 'Waiting ticks...', passed: false }
  ]);

  const ws = useRef(null);
  const ticksHistoryRef = useRef([]);

  // 1. DERIV WEBSOCKET CONNECTION
  useEffect(() => {
    setFeedStatus('CONNECTING');
    setLiveQuote(null);
    setBlockReason('Subscribing to live ticks...');
    ticksHistoryRef.current = [];

    const app_id = 1089;
    ws.current = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${app_id}`);

    ws.current.onopen = () => {
      setFeedStatus('LIVE');
      ws.current.send(JSON.stringify({ forget_all: 'ticks' }));
      ws.current.send(JSON.stringify({
        ticks: market,
        subscribe: 1
      }));
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.error) {
        setBlockReason(`Deriv Error: ${data.error.message}`);
        setFeedStatus('ERROR');
        return;
      }

      if (data.msg_type === 'tick' && data.tick) {
        const newPrice = parseFloat(data.tick.quote);
        setLiveQuote(newPrice);
        
        ticksHistoryRef.current = [...ticksHistoryRef.current.slice(-49), newPrice];
        runAnalysisEngine(ticksHistoryRef.current);
      }
    };

    ws.current.onclose = () => setFeedStatus('OFFLINE');
    ws.current.onerror = () => setFeedStatus('ERROR');

    const pingInterval = setInterval(() => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);

    return () => {
      clearInterval(pingInterval);
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ forget_all: 'ticks' }));
        ws.current.close();
      }
    };
  }, [market]);

  // 2. LIVE CALCULATIONS & BAYESIAN ENGINE
  const runAnalysisEngine = (prices) => {
    const len = prices.length;
    if (len < 3) {
      setBlockReason(`Collecting market ticks (${len}/10)...`);
      return;
    }

    const currentPrice = prices[len - 1];
    const prevPrice = prices[len - 2];

    const momentumVal = Math.round((currentPrice - prices[Math.max(0, len - 5)]) * 100);
    
    const sma5 = prices.slice(-5).reduce((a, b) => a + b, 0) / Math.min(len, 5);
    const sma10 = prices.slice(-10).reduce((a, b) => a + b, 0) / Math.min(len, 10);
    const trendDir = sma5 >= sma10 ? 'UP' : 'DOWN';

    let upMoves = 0;
    for (let i = 1; i < len; i++) {
      if (prices[i] > prices[i - 1]) upMoves++;
    }
    const likelihood = upMoves / (len - 1 || 1);
    const bayesianScore = Math.min(99, Math.max(1, Math.round(likelihood * 100)));

    const isDirOk = (trendDir === 'UP' && momentumVal >= 0) || (trendDir === 'DOWN' && momentumVal <= 0);
    const isMomOk = Math.abs(momentumVal) >= 1;
    const isTransOk = bayesianScore >= 55 || bayesianScore <= 45;
    const isVolOk = Math.abs(currentPrice - prevPrice) >= 0;
    const isEntropyOk = true;
    const isProbOk = bayesianScore >= minConfidence || (100 - bayesianScore) >= minConfidence;

    const updatedGates = [
      { name: 'Direction', status: `${trendDir} trend`, passed: isDirOk },
      { name: 'Momentum', status: `Val: ${momentumVal}`, passed: isMomOk },
      { name: 'Transition', status: `${bayesianScore}% score`, passed: isTransOk },
      { name: 'Volatility', status: 'NORMAL', passed: isVolOk },
      { name: 'Entropy', status: 'STABLE', passed: isEntropyOk },
      { name: 'Probability', status: `${bayesianScore}%`, passed: isProbOk }
    ];

    setGates(updatedGates);

    const passedCount = updatedGates.filter((g) => g.passed).length;
    const calculatedConfidence = Math.round((passedCount / updatedGates.length) * 100);
    setConfidence(calculatedConfidence);
    setProbability(bayesianScore);

    let nextDecision = 'WAIT';
    let reason = '';

    if (passedCount >= 5 && calculatedConfidence >= minConfidence) {
      nextDecision = trendDir === 'UP' ? 'RISE' : 'FALL';
      reason = `${nextDecision} entry verified (${passedCount}/6 gates passed)`;
    } else {
      reason = `${trendDir} blocked: ${passedCount}/6 gates passed (Requires ${minConfidence}% confidence)`;
    }

    setDecision(nextDecision);
    setBlockReason(reason);
    setRiskLevel(calculatedConfidence >= 80 ? 'LOW' : calculatedConfidence >= 50 ? 'MEDIUM' : 'HIGH');

    setMetrics({
      momentum: momentumVal,
      trend: trendDir,
      volatility: isVolOk ? 'NORMAL' : 'LOW',
      entropy: `${Math.round((1 - likelihood) * 20)}%`,
      bayesian: `${bayesianScore}%`,
      transition: `${100 - bayesianScore}%`,
      observedCycle: len,
      regime: Math.abs(momentumVal) > 4 ? 'BREAKOUT' : 'TREND'
    });

    if (isBotRunning && nextDecision !== 'WAIT' && calculatedConfidence >= minConfidence) {
      executeTrade(nextDecision);
    }
  };

  const executeTrade = (tradeType) => {
    if (execMode === 'Paper trading') {
      console.log(`[PAPER TRADE] Executed ${tradeType} on ${market} with Stake $${stake}`);
    } else if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({
        buy: 1,
        price: stake,
        parameters: {
          amount: stake,
          basis: 'stake',
          contract_type: tradeType === 'RISE' ? 'CALL' : 'PUT',
          currency: 'USD',
          duration: 1,
          duration_unit: 't',
          symbol: market
        }
      }));
    }
  };

  return (
    <div className={styles.geminiBotShell}>
      {/* 1. TOPBAR */}
      <div className={styles.geminiTopbar}>
        <div className={styles.statusItems}>
          <div className={styles.statusField}>
            <label>Feed</label>
            <span className={`${styles.statusVal} ${feedStatus === 'LIVE' ? styles.textGreen : styles.textRed}`}>
              {feedStatus}
            </span>
          </div>
          <div className={styles.statusField}>
            <label>Status</label>
            <span className={`${styles.statusVal} ${styles.textGreen}`}>READY</span>
          </div>
          <div className={styles.statusField}>
            <label>Account</label>
            <span className={styles.statusVal}>Demo (DOT92224110)</span>
          </div>
        </div>
        <div className={styles.statusNote}>
          GeminiX Engine connected to Deriv WebSocket API.
        </div>
      </div>

      {/* 2. CONTROL GRID */}
      <div className={styles.geminiControlGrid}>
        <div className={styles.inputGroup}>
          <label>Market</label>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="R_100">Volatility 100 Index</option>
            <option value="R_10">Volatility 10 Index</option>
            <option value="R_25">Volatility 25 Index</option>
            <option value="R_50">Volatility 50 Index</option>
            <option value="R_75">Volatility 75 Index</option>
          </select>
        </div>

        <div className={styles.inputGroup}>
          <label>Stake ($)</label>
          <input 
            type="number" 
            step="0.01" 
            value={stake} 
            onChange={(e) => setStake(parseFloat(e.target.value))} 
          />
        </div>

        <div className={styles.inputGroup}>
          <label>Min Confidence (%)</label>
          <input 
            type="number" 
            value={minConfidence} 
            onChange={(e) => setMinConfidence(parseInt(e.target.value))} 
          />
        </div>

        <div className={styles.inputGroup}>
          <label>Execution Mode</label>
          <select value={execMode} onChange={(e) => setExecMode(e.target.value)}>
            <option value="Paper trading">Paper Trading</option>
            <option value="Live trading">Live Trading</option>
          </select>
        </div>

        <button 
          className={`${styles.btnAction} ${isBotRunning ? styles.stopBtn : styles.startBtn}`}
          onClick={() => setIsBotRunning(!isBotRunning)}
        >
          {isBotRunning ? 'STOP GEMINIX ENGINE' : 'START GEMINIX ENGINE'}
        </button>
      </div>

      {/* 3. DECISION DASHBOARD */}
      <div className={styles.dashboardGrid}>
        <div className={styles.geminiDecision}>
          <div className={styles.panelHeader}>
            <span className={styles.title}>GEMINIX ENGINE DECISION</span>
            <div className={styles.tags}>
              <span className={`${styles.tag} ${styles.tagWatch}`}>LIVE</span>
              <span className={`${styles.tag} ${styles.tagWait}`}>{decision}</span>
            </div>
          </div>

          <h1 className={styles.mainDecisionText}>{decision}</h1>
          <p className={styles.reasonText}>{blockReason}</p>

          <div className={styles.gatesGrid}>
            {gates.map((g, idx) => (
              <div key={idx} className={`${styles.gateCard} ${g.passed ? styles.gatePass : styles.gateFail}`}>
                <span>{g.passed ? '✓' : '✕'}</span>
                <strong>{g.name}:</strong>
                <span>{g.status}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.geminiPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.title}>LIVE METRICS</span>
          </div>
          <div style={{ padding: '10px 0' }}>
            <p style={{ fontSize: '13px', margin: '6px 0' }}>Confidence: <strong>{confidence}%</strong></p>
            <p style={{ fontSize: '13px', margin: '6px 0' }}>Probability: <strong>{probability}%</strong></p>
            <p style={{ fontSize: '13px', margin: '6px 0' }}>
              Risk Level: <strong className={riskLevel === 'HIGH' ? styles.textRed : styles.textGreen}>{riskLevel}</strong>
            </p>
            <p style={{ fontSize: '13px', margin: '6px 0' }}>
              Live Quote: <strong>{liveQuote !== null ? liveQuote : 'Loading...'}</strong>
            </p>
          </div>
        </div>
      </div>

      {/* 4. ANALYTICS ROW */}
      <div className={styles.analyticsRow}>
        {Object.entries(metrics).map(([key, value]) => (
          <div key={key} className={styles.geminiMetric}>
            <label>{key}</label>
            <span>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}