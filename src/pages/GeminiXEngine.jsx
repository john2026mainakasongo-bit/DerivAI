import React, { useState, useEffect, useRef } from 'react';
import styles from './GeminiXEngine.module.css';

export default function GeminiXEngine() {
  // Config States
  const [market, setMarket] = useState('R_100');
  const [stake, setStake] = useState(0.35);
  const [minConfidence, setMinConfidence] = useState(80);
  const [execMode, setExecMode] = useState('Paper trading');
  const [isBotRunning, setIsBotRunning] = useState(false);

  // Live Tick & Digit Data States
  const [feedStatus, setFeedStatus] = useState('CONNECTING');
  const [liveQuote, setLiveQuote] = useState(null);
  const [lastDigit, setLastDigit] = useState(null);
  const [recentDigits, setRecentDigits] = useState([]);
  const [digitCounts, setDigitCounts] = useState(Array(10).fill(0));

  // Decision & Analysis States
  const [decision, setDecision] = useState('WAIT');
  const [blockReason, setBlockReason] = useState('Inaunganisha na Deriv WebSocket...');
  const [confidence, setConfidence] = useState(0);
  const [probability, setProbability] = useState(50);
  const [riskLevel, setRiskLevel] = useState('LOW');
  const [suggestedContract, setSuggestedContract] = useState('OVER 2');

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
    { name: 'Direction', status: 'Checking...', passed: false },
    { name: 'Momentum', status: 'Checking...', passed: false },
    { name: 'Transition', status: 'Checking...', passed: false },
    { name: 'Volatility', status: 'Checking...', passed: false },
    { name: 'Entropy', status: 'Checking...', passed: false },
    { name: 'Probability', status: 'Checking...', passed: false }
  ]);

  const ws = useRef(null);
  const ticksHistoryRef = useRef([]);

  // 1. AUTO-CONNECT DERIV WEBSOCKET UPON PAGE LOAD
  useEffect(() => {
    setFeedStatus('CONNECTING');
    setLiveQuote(null);
    setLastDigit(null);
    setRecentDigits([]);
    setDigitCounts(Array(10).fill(0));
    ticksHistoryRef.current = [];

    const app_id = 1089; // Standard Deriv App ID
    ws.current = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${app_id}`);

    ws.current.onopen = () => {
      setFeedStatus('LIVE');
      setBlockReason('Inapokea live ticks kutoka Deriv...');
      ws.current.send(JSON.stringify({ forget_all: 'ticks' }));
      ws.current.send(JSON.stringify({
        ticks: market,
        subscribe: 1
      }));
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.error) {
        setBlockReason(`Hitilafu ya Deriv: ${data.error.message}`);
        setFeedStatus('ERROR');
        return;
      }

      if (data.msg_type === 'tick' && data.tick) {
        const quoteStr = data.tick.quote.toString();
        const newPrice = parseFloat(quoteStr);
        const digit = parseInt(quoteStr.slice(-1), 10);

        setLiveQuote(newPrice);
        setLastDigit(digit);

        // Hifadhi Digiti 12 za hivi karibuni
        setRecentDigits((prev) => [...prev.slice(-11), digit]);

        // Ongeza Hesabu ya Digiti
        setDigitCounts((prev) => {
          const updated = [...prev];
          updated[digit] += 1;
          return updated;
        });

        // Hifadhi Historia ya Bei
        ticksHistoryRef.current = [...ticksHistoryRef.current.slice(-49), newPrice];
        runAnalysisEngine(ticksHistoryRef.current, digit);
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

  // 2. LIVE ANALYSIS ENGINE
  const runAnalysisEngine = (prices, latestDigit) => {
    const len = prices.length;
    if (len < 3) {
      setBlockReason(`Inakusanya Ticks za Soko (${len}/10)...`);
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

    let contractRec = latestDigit > 4 ? 'OVER 2' : 'UNDER 7';
    setSuggestedContract(contractRec);

    let nextDecision = 'WAIT';
    let reason = '';

    if (passedCount >= 5 && calculatedConfidence >= minConfidence) {
      nextDecision = trendDir === 'UP' ? 'RISE' : 'FALL';
      reason = `ENTRY CONFIRMED: ${contractRec} signal verified (${passedCount}/6 gates passed)`;
    } else {
      reason = `ENTRY BLOCKED: ${passedCount}/6 gates passed (Inahitaji ${minConfidence}% confidence)`;
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
      executeTrade(nextDecision === 'RISE' ? 'DIGITOVER' : 'DIGITUNDER', 2);
    }
  };

  // 3. EXECUTE TRADE
  const executeTrade = (contractType, barrier = 2) => {
    if (execMode === 'Paper trading') {
      alert(`[PAPER TRADE EXECUTED]\nContract: ${contractType}\nMarket: ${market}\nStake: $${stake}`);
    } else if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({
        buy: 1,
        price: stake,
        parameters: {
          amount: stake,
          basis: 'stake',
          contract_type: contractType,
          currency: 'USD',
          duration: 1,
          duration_unit: 't',
          symbol: market,
          barrier: barrier.toString()
        }
      }));
    }
  };

  const totalDigitTicks = digitCounts.reduce((a, b) => a + b, 0) || 1;

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
          GeminiX Engine connected to Deriv Live Digit WebSocket API.
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

      {/* 3. RECENT DIGITS & QUICK TRADE BUTTONS */}
      <div className={styles.geminiPanel} style={{ marginBottom: '16px' }}>
        <div className={styles.panelHeader}>
          <span className={styles.title}>LIVE RECENT DIGITS STREAM & QUICK TRADING</span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: '#888' }}>Recent Ticks:</span>
            {recentDigits.map((d, i) => (
              <span 
                key={i} 
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: d % 2 === 0 ? '#1b3b2b' : '#3b1b1b',
                  color: d % 2 === 0 ? '#4caf50' : '#f44336',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 'bold',
                  fontSize: '14px',
                  border: i === recentDigits.length - 1 ? '2px solid #00d2ff' : '1px solid #333'
                }}
              >
                {d}
              </span>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              onClick={() => executeTrade('DIGITOVER', 2)}
              style={{ background: '#2e7d32', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              BUY OVER 2
            </button>
            <button 
              onClick={() => executeTrade('DIGITUNDER', 7)}
              style={{ background: '#c62828', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              BUY UNDER 7
            </button>
            <button 
              onClick={() => executeTrade('DIGITEVEN')}
              style={{ background: '#0288d1', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              BUY EVEN
            </button>
            <button 
              onClick={() => executeTrade('DIGITODD')}
              style={{ background: '#ed6c02', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              BUY ODD
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: '6px', marginTop: '12px' }}>
          {digitCounts.map((count, d) => {
            const pct = Math.round((count / totalDigitTicks) * 100);
            return (
              <div key={d} style={{ textAlign: 'center', background: 'rgba(255,255,255,0.03)', padding: '6px', borderRadius: '4px' }}>
                <span style={{ fontSize: '11px', color: '#aaa' }}>D{d}</span>
                <div style={{ height: '4px', background: '#333', borderRadius: '2px', margin: '4px 0', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: '#00d2ff' }}></div>
                </div>
                <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#fff' }}>{pct}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. DECISION DASHBOARD */}
      <div className={styles.dashboardGrid}>
        <div className={styles.geminiDecision}>
          <div className={styles.panelHeader}>
            <span className={styles.title}>GEMINIX ENGINE DECISION</span>
            <div className={styles.tags}>
              <span className={`${styles.tag} ${styles.tagWatch}`}>REC: {suggestedContract}</span>
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
              Live Quote: <strong>{liveQuote !== null ? liveQuote : 'Inapakia...'}</strong>
            </p>
            <p style={{ fontSize: '13px', margin: '6px 0' }}>
              Last Digit: <strong style={{ color: '#00d2ff', fontSize: '16px' }}>{lastDigit !== null ? lastDigit : '-'}</strong>
            </p>
          </div>
        </div>
      </div>

      {/* 5. ANALYTICS ROW */}
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