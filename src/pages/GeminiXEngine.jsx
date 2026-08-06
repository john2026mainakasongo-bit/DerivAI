// src/pages/GeminiXEngine.jsx
import React, { useState } from 'react';
import styles from './GeminiXEngine.module.css';

export default function GeminiXEngine() {
  const [feed] = useState('LIVE');
  const [tradingStatus] = useState('READY');
  const [accountType] = useState('demo');
  const [accountId] = useState('DOT92224110');
  
  const [market, setMarket] = useState('1HZ100V');
  const [stake, setStake] = useState(0.35);
  const [minConfidence, setMinConfidence] = useState(82);
  const [execMode, setExecMode] = useState('Paper trading');
  const [isBotRunning, setIsBotRunning] = useState(true);

  const [decision] = useState('RISE');
  const [blockReason] = useState('RISE blocked because Bayesian score is below 70%');
  const [confidence] = useState(64);
  const [probability] = useState(45);
  const [riskLevel] = useState('HIGH');
  const [liveQuote] = useState(801.29);

  const [metrics] = useState({
    momentum: -4, trend: 'UP', volatility: 'NORMAL', entropy: '0%',
    bayesian: '39%', transition: '50%', observedCycle: 2, regime: 'TREND'
  });

  const [gates] = useState([
    { name: 'Direction', status: 'UP trend', passed: true },
    { name: 'Momentum', status: 'Momentum -4', passed: false },
    { name: 'Transition', status: '50% NONE', passed: false },
    { name: 'Volatility', status: 'NORMAL', passed: true },
    { name: 'Entropy', status: '0%', passed: true },
    { name: 'Probability', status: '45%', passed: false }
  ]);

  return (
    <div className={styles.geminiBotShell}>
      {/* 1. TOPBAR */}
      <div className={styles.geminiTopbar}>
        <div className={styles.statusItems}>
          <div className={styles.statusField}>
            <label>Feed</label>
            <span className={`${styles.statusVal} ${styles.textGreen}`}>{feed}</span>
          </div>
          <div className={styles.statusField}>
            <label>Status</label>
            <span className={`${styles.statusVal} ${styles.textGreen}`}>{tradingStatus}</span>
          </div>
          <div className={styles.statusField}>
            <label>Account</label>
            <span className={styles.statusVal}>{accountType} ({accountId})</span>
          </div>
        </div>
        <div className={styles.statusNote}>
          GeminiX Engine is connected to Deriv WebSocket API.
        </div>
      </div>

      {/* 2. CONTROL GRID */}
      <div className={styles.geminiControlGrid}>
        <div className={styles.inputGroup}>
          <label>Market</label>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="1HZ100V">1HZ100V</option>
            <option value="R_10">Volatility 10</option>
            <option value="R_100">Volatility 100</option>
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
              <span className={`${styles.tag} ${styles.tagWatch}`}>WATCH</span>
              <span className={`${styles.tag} ${styles.tagWait}`}>WAIT</span>
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
            <p style={{ fontSize: '13px', margin: '6px 0' }}>Risk Level: <strong className={styles.textRed}>{riskLevel}</strong></p>
            <p style={{ fontSize: '13px', margin: '6px 0' }}>Live Quote: <strong>{liveQuote}</strong></p>
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