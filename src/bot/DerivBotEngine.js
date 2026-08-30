import { evaluateAnalysisAssistedSignal } from "../analysis/analysisAssistedGate";
import { evaluateSyntheticSetup } from "../analysis/syntheticIntelligenceEngine";

const DEFAULTS = {
  maxRuns: 56,
  maxScanTicks: 60,
  minConfidence: 68,
  minVotes: 2,
  stake: 1,
  duration: 5,
  delaySeconds: 0,
  takeProfit: 20,
  stopLoss: 6,
  cooldownAfterLosses: 1,
  cooldownSeconds: 10,
  hardStopLossStreak: 3,
  martingaleEnabled: false,
  maxMartingaleSteps: 1,
  recoveryMultipliers: [1.35],
  analysisAssisted: true,
  contractMode: "AUTO",
  prediction: 2,
  durationUnit: "t",
  confirmationCount: 1,
  realConfirmationCount: 4,
  minimumDigitSamples: 18,
  minimumRiseFallSamples: 30,
  realStakeCap: 0.35,
  confirmationSeconds: 1,
  signalMaxAgeSeconds: 4,
  lossSetupBlockSeconds: 20,
  minimumTradeGapSeconds: 1,
  deepMinimumScore: 70,
  deepOverrideScore: 90,
};

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function durationText(duration, durationUnit) {
  const value = Math.max(1, number(duration, 1));
  return `${value} ${durationUnit === "s" ? "seconds" : "ticks"}`;
}

function normalizeContractMode(value = "AUTO") {
  const mode = String(value || "AUTO").trim().toUpperCase();
  const allowed = new Set([
    "AUTO",
    "RISE",
    "FALL",
    "EVEN",
    "ODD",
    "OVER",
    "UNDER",
    "MATCH",
    "DIFFERS",
  ]);

  return allowed.has(mode) ? mode : "AUTO";
}

function contractFromSetup(setup = "") {
  const value = String(setup).toUpperCase();

  if (value.includes("RISE")) {
    return { contractType: "CALL", barrier: undefined, label: "RISE" };
  }

  if (value.includes("FALL")) {
    return { contractType: "PUT", barrier: undefined, label: "FALL" };
  }

  if (value.includes("OVER")) {
    const match = value.match(/OVER\s*(\d)/);
    return {
      contractType: "DIGITOVER",
      barrier: match?.[1] || "2",
      label: `OVER ${match?.[1] || "2"}`,
    };
  }

  if (value.includes("UNDER")) {
    const match = value.match(/UNDER\s*(\d)/);
    return {
      contractType: "DIGITUNDER",
      barrier: match?.[1] || "2",
      label: `UNDER ${match?.[1] || "2"}`,
    };
  }

  if (value.includes("EVEN")) {
    return { contractType: "DIGITEVEN", barrier: undefined, label: "EVEN" };
  }

  if (value.includes("ODD")) {
    return { contractType: "DIGITODD", barrier: undefined, label: "ODD" };
  }

  if (value.includes("MATCH")) {
    const match = value.match(/MATCH\s*(\d)/);
    return {
      contractType: "DIGITMATCH",
      barrier: match?.[1] || "0",
      label: `MATCH ${match?.[1] || "0"}`,
    };
  }

  if (value.includes("DIFFERS")) {
    const match = value.match(/DIFFERS\s*(\d)/);
    return {
      contractType: "DIGITDIFF",
      barrier: match?.[1] || "0",
      label: `DIFFERS ${match?.[1] || "0"}`,
    };
  }

  return null;
}

function isFinished(contract = {}) {
  const status = String(contract.status || "").toLowerCase();

  return Boolean(
    contract.is_sold ||
      contract.is_expired ||
      contract.is_settleable === false ||
      ["sold", "won", "lost", "expired", "cancelled"].includes(status)
  );
}

function contractProfit(contract = {}) {
  const value = Number(
    contract.profit ??
      contract.profit_loss ??
      contract.pnl ??
      contract.sell_price - contract.buy_price
  );

  return Number.isFinite(value) ? value : 0;
}

function contractNumber(contract = {}, keys = [], fallback = 0) {
  for (const key of keys) {
    const value = Number(contract?.[key]);

    if (Number.isFinite(value)) {
      return value;
    }
  }

  return fallback;
}

function contractDetails(contract = {}, bought = {}) {
  const buy = bought?.buy || {};
  const proposal = bought?.proposal || {};

  const buyPrice = contractNumber(
    contract,
    ["buy_price", "purchase_price", "stake"],
    contractNumber(buy, ["buy_price", "price"], contractNumber(proposal, ["ask_price"], 0))
  );

  const sellPrice = contractNumber(
    contract,
    ["sell_price", "payout", "bid_price"],
    0
  );

  return {
    buyPrice,
    sellPrice,
    payout: contractNumber(contract, ["payout", "sell_price"], sellPrice),
    entrySpot: contractNumber(
      contract,
      ["entry_spot", "entry_tick", "entry_value"],
      contractNumber(buy, ["start_spot"], 0)
    ),
    exitSpot: contractNumber(
      contract,
      ["exit_spot", "exit_tick", "current_spot", "sell_spot"],
      0
    ),
  };
}

function smartRecoveryMultiplier(step, schedule = DEFAULTS.recoveryMultipliers) {
  const safeStep = Math.max(1, Math.floor(number(step, 1)));
  const values = (Array.isArray(schedule) ? schedule : DEFAULTS.recoveryMultipliers)
    .map((value) => Math.max(1, number(value, 1)))
    .filter(Number.isFinite);

  if (!values.length) {
    return 1;
  }

  return values[Math.min(safeStep - 1, values.length - 1)];
}

function normalizeSetup(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function validationAction(row = {}) {
  return normalizeSetup(row?.action || row?.candidate || row?.setup || "WAIT");
}

function isDigitContract(contract = {}) {
  return String(contract?.contractType || "").startsWith("DIGIT");
}

function safeUpper(value) {
  return String(value || "").trim().toUpperCase();
}

function analysisSampleSize(signal = {}, analysis = {}, candidate = {}) {
  // Rapid 30s/60s candidates must be scored on their actual timeframe
  // sample, not inflated by the long 500-tick calibration buffer.
  if (candidate?.rapidEntry && Number.isFinite(Number(candidate.samples))) {
    return Number(candidate.samples);
  }

  const candidates = [
    signal.sampleSize,
    signal.priceCount,
    analysis.sampleSize,
    analysis.samples,
    analysis.tickCount,
    analysis.dataQuality?.samples,
    analysis.distributionSampleSize,
  ]
    .map(Number)
    .filter(Number.isFinite);

  return candidates.length ? Math.max(...candidates) : 0;
}

function candidateFamily(candidate = {}) {
  return safeUpper(candidate.family || candidate.group || "");
}

function candidateAction(candidate = {}) {
  return safeUpper(candidate.action || candidate.setup || "");
}

function minimumRequirements(candidate = {}, isReal = false) {
  const setup = candidateAction(candidate);
  const family = candidateFamily(candidate);

  let confidence = isReal ? 91 : 88;
  let probability = 0;
  let samples = isReal ? 45 : 32;
  let confirmations = isReal ? 4 : 3;

  if (setup.startsWith("MATCH")) {
    confidence = isReal ? 96 : 93;
    probability = isReal ? 16.5 : 15.5;
    samples = isReal ? 58 : 48;
    confirmations = isReal ? 5 : 4;
  } else if (setup.startsWith("DIFFERS")) {
    confidence = isReal ? 93 : 90;
    samples = isReal ? 48 : 38;
    confirmations = isReal ? 4 : 3;
  } else if (
    setup.startsWith("OVER") ||
    setup.startsWith("UNDER") ||
    family === "OVER_UNDER"
  ) {
    confidence = isReal ? 92 : 89;
    probability = isReal ? 70 : 67;
    samples = isReal ? 45 : 34;
    confirmations = isReal ? 4 : 3;
  } else if (
    setup === "EVEN" ||
    setup === "ODD" ||
    family === "PARITY"
  ) {
    confidence = isReal ? 92 : 89;
    probability = isReal ? 57 : 55;
    samples = isReal ? 48 : 36;
    confirmations = isReal ? 4 : 3;
  } else if (
    setup === "RISE" ||
    setup === "FALL" ||
    family === "RISE_FALL"
  ) {
    confidence = isReal ? 93 : 89;
    probability = confidence;
    samples = isReal ? 38 : 28;
    confirmations = isReal ? 4 : 3;
  }

  return { confidence, probability, samples, confirmations };
}

function clampScore(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function analysisMetric(analysis = {}, paths = [], fallback = 0) {
  for (const path of paths) {
    const parts = String(path).split(".");
    let value = analysis;

    for (const part of parts) {
      value = value?.[part];
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return fallback;
}

function marketProfile(symbol = "") {
  const value = safeUpper(symbol);

  if (value.includes("1HZ10V")) {
    return {
      name: "1HZ10V",
      entropyTolerance: 99.2,
      scoreAdjustment: -1,
      requiredVotes: 4,
      minimumSamples: 24,
    };
  }

  if (value.includes("1HZ25V")) {
    return {
      name: "1HZ25V",
      entropyTolerance: 99.0,
      scoreAdjustment: 0,
      requiredVotes: 4,
      minimumSamples: 24,
    };
  }

  if (value.includes("1HZ50V")) {
    return {
      name: "1HZ50V",
      entropyTolerance: 98.9,
      scoreAdjustment: 1,
      requiredVotes: 4,
      minimumSamples: 26,
    };
  }

  if (value.includes("1HZ75V")) {
    return {
      name: "1HZ75V",
      entropyTolerance: 98.8,
      scoreAdjustment: 2,
      requiredVotes: 4,
      minimumSamples: 28,
    };
  }

  if (value.includes("1HZ100V")) {
    return {
      name: "1HZ100V",
      entropyTolerance: 98.7,
      scoreAdjustment: 2,
      requiredVotes: 5,
      minimumSamples: 30,
    };
  }

  return {
    name: value || "DEFAULT",
    entropyTolerance: 98.5,
    scoreAdjustment: 0,
    requiredVotes: 4,
    minimumSamples: 26,
  };
}

function scoreVote(value, passAt, strongAt) {
  const numeric = Number(value || 0);

  if (numeric >= strongAt) {
    return { pass: true, strong: true, value: numeric };
  }

  return {
    pass: numeric >= passAt,
    strong: false,
    value: numeric,
  };
}

function buildConsensusVotes(candidate = {}, signal = {}, symbol = "", isReal = false) {
  const analysis = signal.analysis || {};
  const profile = marketProfile(symbol);
  const setup = candidateAction(candidate);
  const family = candidateFamily(candidate);

  const rawCandidateConfidence = clampScore(candidate.confidence);
  const rawCandidateProbability = clampScore(candidate.probability);

  const globalProbability = clampScore(
    analysis.probability ??
    analysis.selectedProbability ??
    analysis.bayesianSetup?.probability ??
    analysis.bayesian?.probability ??
    signal.probability ??
    0
  );

  const globalConfidence = clampScore(
    analysis.confidence ??
    analysis.decisionConfidence ??
    analysis.bayesianSetup?.confidence ??
    analysis.bayesian?.confidence ??
    globalProbability
  );

  // Candidate-specific values remain primary. Global values are bounded
  // fallbacks so the same analysis cannot report 90%+ probability while the
  // execution candidate is scored as 15% merely because one field is missing.
  const probability = clampScore(
    rawCandidateProbability > 0
      ? rawCandidateProbability * 0.78 + globalProbability * 0.22
      : globalProbability
  );

  const confidence = clampScore(
    rawCandidateConfidence >= 35
      ? rawCandidateConfidence * 0.65 +
        probability * 0.25 +
        globalConfidence * 0.10
      : probability * 0.72 +
        globalConfidence * 0.28
  );

  const edge = Math.max(
    0,
    Number(
      candidate.edge ??
      analysis.selectedEdge ??
      analysis.edge ??
      0
    )
  );

  const samples = analysisSampleSize(signal, analysis, candidate);

  const entropy = analysisMetric(
    analysis,
    ["digitEntropy.percentage", "entropy.percentage", "entropy"],
    100
  );

  const transitionCount = analysisMetric(
    analysis,
    [
      "transitionEvidence.count",
      "transitions.count",
      "transitionCount",
      "matchingTransitions",
    ],
    0
  );

  const cycleStrength = analysisMetric(
    analysis,
    [
      "cycle.strength",
      "observedCycle.strength",
      "cycleStrength",
      "cycle.percentage",
    ],
    0
  );

  const momentumStrength = analysisMetric(
    analysis,
    [
      "momentum.strength",
      "momentum.percentage",
      "direction.strength",
      "signals.riseFall.confidence",
    ],
    0
  );

  const autocorrelation = analysisMetric(
    analysis,
    [
      "autocorrelation.strength",
      "autocorrelation.percentage",
      "autocorrelation",
    ],
    0
  );

  const regimeStrength = analysisMetric(
    analysis,
    [
      "regime.stability",
      "regime.strength",
      "regime.percentage",
      "regimeStability",
    ],
    0
  );

  const regime = safeUpper(
    analysis.regime?.label ||
      analysis.regime ||
      analysis.marketRegime ||
      ""
  );

  const momentum = safeUpper(
    analysis.momentum?.direction ||
      analysis.direction?.signal?.signal ||
      analysis.signals?.riseFall?.signal ||
      ""
  );

  const directionalAgreement =
    setup === "RISE"
      ? ["UP", "RISE"].includes(momentum)
      : setup === "FALL"
        ? ["DOWN", "FALL"].includes(momentum)
        : true;

  const randomRegime =
    regime.includes("RANDOM") || regime.includes("NO EDGE");

  const probabilityVote =
    setup.startsWith("MATCH")
      ? scoreVote(probability, isReal ? 15.5 : 14.5, isReal ? 18 : 17)
      : setup.startsWith("DIFFERS")
        ? {
            pass: probability <= (isReal ? 6.5 : 7.5),
            strong: probability <= (isReal ? 4.5 : 5.5),
            value: probability,
          }
        : scoreVote(
            probability,
            isReal ? 67 : 64,
            isReal ? 74 : 70
          );

  const votes = [
    {
      name: "Confidence",
      ...scoreVote(
        confidence,
        isReal ? 88 : 84,
        isReal ? 94 : 91
      ),
    },
    {
      name: "Probability",
      ...probabilityVote,
    },
    {
      name: "Edge",
      ...scoreVote(
        edge,
        isReal ? 3.5 : 2.5,
        isReal ? 6 : 5
      ),
    },
    {
      name: "Transitions",
      ...scoreVote(
        transitionCount,
        isReal ? 8 : 6,
        isReal ? 13 : 10
      ),
    },
    {
      name: "Momentum",
      pass:
        setup === "RISE" || setup === "FALL"
          ? directionalAgreement && momentumStrength >= (isReal ? 55 : 45)
          : momentumStrength >= 20 || setup.startsWith("OVER") || setup.startsWith("UNDER"),
      strong:
        setup === "RISE" || setup === "FALL"
          ? directionalAgreement && momentumStrength >= (isReal ? 72 : 65)
          : momentumStrength >= 55,
      value: momentumStrength,
    },
    {
      name: "Cycle",
      ...scoreVote(
        cycleStrength,
        isReal ? 20 : 15,
        isReal ? 45 : 35
      ),
    },
    {
      name: "Regime",
      pass:
        setup === "RISE" || setup === "FALL"
          ? !randomRegime && regimeStrength >= (isReal ? 45 : 35)
          : regimeStrength >= 20 || !randomRegime,
      strong:
        !randomRegime && regimeStrength >= (isReal ? 70 : 60),
      value: regimeStrength,
    },
    {
      name: "Entropy",
      pass:
        entropy <= profile.entropyTolerance ||
        (
          entropy <= profile.entropyTolerance + 0.7 &&
          confidence >= 91 &&
          transitionCount >= 10
        ),
      strong: entropy <= profile.entropyTolerance - 1,
      value: entropy,
    },
    {
      name: "Autocorrelation",
      ...scoreVote(
        autocorrelation,
        isReal ? 20 : 15,
        isReal ? 45 : 35
      ),
    },
    {
      name: "Samples",
      pass: samples >= profile.minimumSamples,
      strong: samples >= profile.minimumSamples * 1.5,
      value: samples,
    },
  ];

  const passedVotes = votes.filter((vote) => vote.pass).length;
  const strongVotes = votes.filter((vote) => vote.strong).length;

  let requiredVotes = Math.max(
    2,
    Number(profile.requiredVotes || 2)
  );

  if (setup.startsWith("MATCH")) {
    requiredVotes += 1;
  }

  if (isReal) {
    requiredVotes += 1;
  }

  return {
    profile,
    setup,
    family,
    votes,
    passedVotes,
    strongVotes,
    requiredVotes,
    directionalAgreement,
    randomRegime,
    confidence,
    probability,
    rawCandidateConfidence,
    rawCandidateProbability,
    globalConfidence,
    globalProbability,
    edge,
    samples,
    entropy,
    transitionCount,
    cycleStrength,
    momentumStrength,
    autocorrelation,
    regimeStrength,
    regime,
    momentum,
  };
}

function scoreCandidate(candidate = {}, signal = {}, symbol = "", isReal = false) {
  const consensus = buildConsensusVotes(
    candidate,
    signal,
    symbol,
    isReal
  );

  const {
    profile,
    setup,
    confidence,
    probability,
    rawCandidateConfidence,
    rawCandidateProbability,
    globalConfidence,
    globalProbability,
    edge,
    samples,
    entropy,
    transitionCount,
    cycleStrength,
    momentumStrength,
    autocorrelation,
    regimeStrength,
    passedVotes,
    strongVotes,
    requiredVotes,
    votes,
    randomRegime,
    directionalAgreement,
  } = consensus;

  const family = candidateFamily(candidate);

  // Each contract is scored independently. Votes are evidence, not a rigid
  // requirement that unrelated contract families must all agree.
  const confidenceScore = clampScore(confidence);
  const probabilityScore = setup.startsWith("MATCH")
    ? clampScore(probability * 5)
    : setup.startsWith("DIFFERS")
      ? clampScore((10 - probability) * 10)
      : clampScore(probability);

  const transitionScore = clampScore((transitionCount / 15) * 100);
  const cycleScore = clampScore(cycleStrength);
  const momentumScore = clampScore(momentumStrength);
  const autocorrelationScore = clampScore(autocorrelation);
  const regimeScore = clampScore(regimeStrength);
  const sampleScore = clampScore((samples / Math.max(60, profile.minimumSamples)) * 100);
  const edgeScore = clampScore(edge * 10);

  // Entropy is converted to a soft quality value. It no longer blocks a
  // strong digit candidate on its own.
  const entropyScore = clampScore(
    100 - Math.max(0, entropy - 94) * 12
  );

  const voteScore = clampScore(
    (passedVotes / Math.max(1, requiredVotes)) * 100
  );

  // One coherent standard-digit score. Every displayed component now feeds
  // the same final number instead of independent gates contradicting it.
  let weightedScore =
    probabilityScore * 0.34 +
    confidenceScore * 0.28 +
    transitionScore * 0.14 +
    voteScore * 0.10 +
    sampleScore * 0.06 +
    entropyScore * 0.04 +
    regimeScore * 0.02 +
    autocorrelationScore * 0.02;

  if (setup === "RISE" || setup === "FALL") {
    // Direction contracts rely more on momentum/regime and less on digit
    // probability. They remain isolated from parity/over-under scoring.
    weightedScore =
      confidenceScore * 0.24 +
      probabilityScore * 0.18 +
      momentumScore * 0.20 +
      regimeScore * 0.13 +
      transitionScore * 0.10 +
      cycleScore * 0.06 +
      sampleScore * 0.05 +
      entropyScore * 0.04;

    if (!directionalAgreement) weightedScore -= 18;
    if (randomRegime) weightedScore -= 12;
  }

  if (setup.startsWith("MATCH")) {
    weightedScore -= entropy >= 98.5 ? 10 : 0;
  }

  if (!candidate.approved && isReal) {
    weightedScore -= 5;
  }

  const score = clampScore(weightedScore);

  const isStandardDigit =
    setup !== "RISE" &&
    setup !== "FALL" &&
    !setup.startsWith("MATCH");

  const baseThreshold = isReal
    ? setup.startsWith("MATCH")
      ? 96
      : setup === "RISE" || setup === "FALL"
        ? 92
        : 72
    : setup.startsWith("MATCH")
      ? 92
      : setup === "RISE" || setup === "FALL"
        ? 86
        : 62;

  // Threshold may relax only for standard digit contracts, and never below 60.
  // This avoids waiting forever without enabling time-only forced entries.
  const adaptiveRelaxation =
    isStandardDigit
      ? samples >= 300
        ? 8
        : samples >= 200
          ? 5
          : samples >= 120
            ? 3
            : 0
      : 0;

  const thresholdFloor =
    isStandardDigit
      ? (isReal ? 68 : 58)
      : 60;

  const threshold = Math.max(
    thresholdFloor,
    baseThreshold - adaptiveRelaxation
  );

  const minimumSamples = isReal
    ? Math.max(profile.minimumSamples, setup.startsWith("MATCH") ? 70 : 55)
    : setup.startsWith("MATCH")
      ? 60
      : setup === "RISE" || setup === "FALL"
        ? 45
        : 36;

  const familySafetyPass =
    setup === "RISE" || setup === "FALL"
      ? directionalAgreement &&
        !randomRegime &&
        momentumStrength >= (isReal ? 70 : 60) &&
        regimeStrength >= (isReal ? 60 : 45)
      : true;

  const voteAdvisoryPass = isReal
    ? passedVotes >= Math.max(4, requiredVotes - 1)
    : passedVotes >= (
        setup === "RISE" || setup === "FALL" ? 3 : 3
      );

  const demoDigitQualityPass =
    !isReal &&
    isStandardDigit &&
    samples >= 80 &&
    confidence >= 72 &&
    probability >= 76 &&
    transitionCount >= 6 &&
    passedVotes >= 2 &&
    score >= 58 &&
    entropy <= 99.6;

  // V35 balanced Real digit path:
  // Standard digit contracts may qualify with practical evidence levels.
  const realDigitQualityPass =
    isReal &&
    isStandardDigit &&
    samples >= 120 &&
    confidence >= 78 &&
    probability >= 80 &&
    transitionCount >= 8 &&
    passedVotes >= 3 &&
    score >= 68 &&
    entropy <= 99.2;

  const ok =
    (
      score >= threshold &&
      samples >= minimumSamples &&
      familySafetyPass &&
      voteAdvisoryPass
    ) ||
    demoDigitQualityPass ||
    realDigitQualityPass;

  let confirmations;

  if (isReal) {
    confirmations = isStandardDigit
      ? 1
      : score >= 97
        ? 3
        : score >= 95
          ? 4
          : 5;
  } else {
    confirmations = score >= 92 ? 1 : score >= 88 ? 2 : 3;
  }

  return {
    ok,
    setup,
    family,
    score,
    threshold,
    confirmations,
    confidence,
    probability,
    edge,
    samples,
    entropy,
    transitionCount,
    cycleStrength,
    momentumStrength,
    autocorrelation,
    regimeStrength,
    passedVotes,
    strongVotes,
    requiredVotes,
    votes,
    marketProfile: profile.name,
    independentContractScore: true,
    demoDigitQualityPass,
    realDigitQualityPass,
    directEvidencePass:
      demoDigitQualityPass || realDigitQualityPass,
    rapidEntry: Boolean(candidate.rapidEntry),
    fastEntry: Boolean(candidate.fastEntry),
    timeframeSeconds: Number(candidate.timeframeSeconds || 0),
    qualificationMode:
      demoDigitQualityPass
        ? "DEMO_DIRECT_EVIDENCE"
        : realDigitQualityPass
          ? "REAL_DIRECT_EVIDENCE"
          : score >= threshold
            ? "WEIGHTED_SCORE"
            : "BLOCKED",
    baseThreshold,
    adaptiveRelaxation,
    blockedChecks: {
      score: `${score.toFixed(1)}/${threshold}`,
      baseThreshold,
      adaptiveRelaxation,
      samples: `${samples}/${minimumSamples}`,
      confidence: `${confidence.toFixed(1)}%`,
      probability: `${probability.toFixed(1)}%`,
      transitions: transitionCount,
      votes: `${passedVotes}/${requiredVotes}`,
      strongVotes,
      entropy: `${entropy.toFixed(1)}%`,
      demoNeeds: "SCORE58 P76 C72 S80 T6 V2 E<=99.6",
      realNeeds: "SCORE68 P80 C78 S120 T8 V3 E<=99.2",
      rawCandidateConfidence: `${rawCandidateConfidence.toFixed(1)}%`,
      rawCandidateProbability: `${rawCandidateProbability.toFixed(1)}%`,
      globalConfidence: `${globalConfidence.toFixed(1)}%`,
      globalProbability: `${globalProbability.toFixed(1)}%`,
    },
    scoreBreakdown: {
      unifiedConfidence: confidenceScore,
      unifiedProbability: probabilityScore,
      rawCandidateConfidence,
      rawCandidateProbability,
      globalConfidence,
      globalProbability,
      transitions: transitionScore,
      momentum: momentumScore,
      entropy: entropyScore,
      samples: sampleScore,
      regime: regimeScore,
      edge: edgeScore,
    },
  };
}
function candidatePassesStrictChecks(candidate = {}, signal = {}, isReal = false) {
  const analysis = signal.analysis || {};
  const requirements = minimumRequirements(candidate, isReal);
  const setup = candidateAction(candidate);
  const confidence = Number(candidate.confidence || 0);
  const probability = Number(candidate.probability || 0);
  const edge = Number(candidate.edge || 0);
  const samples = analysisSampleSize(signal, analysis, candidate);
  const entropy = Number(
    analysis.digitEntropy?.percentage ??
      analysis.entropy?.percentage ??
      analysis.entropy ??
      100
  );
  const regime = safeUpper(
    analysis.regime?.label ||
      analysis.regime ||
      analysis.marketRegime ||
      ""
  );
  const momentum = safeUpper(
    analysis.momentum?.direction ||
      analysis.direction?.signal?.signal ||
      analysis.signals?.riseFall?.signal ||
      ""
  );

  if (!candidate.approved) {
    return { ok: false, reason: "Candidate is not approved by the base analysis gate." };
  }

  if (samples < requirements.samples) {
    return {
      ok: false,
      reason: `Collecting data ${samples}/${requirements.samples} samples.`,
    };
  }

  if (confidence < requirements.confidence) {
    return {
      ok: false,
      reason: `Confidence ${confidence.toFixed(1)}%/${requirements.confidence}%.`,
    };
  }

  if (setup.startsWith("MATCH")) {
    if (probability < requirements.probability || entropy >= 97) {
      return {
        ok: false,
        reason: "MATCH blocked: probability or entropy is not strong enough.",
      };
    }
  }

  if (setup.startsWith("DIFFERS")) {
    if (probability > 6.5 || edge < 3.5) {
      return {
        ok: false,
        reason: "DIFFERS blocked: selected digit is not rare enough.",
      };
    }
  }

  if (setup.startsWith("OVER") || setup.startsWith("UNDER")) {
    if (probability < requirements.probability || edge < 5) {
      return {
        ok: false,
        reason: "OVER/UNDER blocked: probability edge is too small.",
      };
    }
  }

  if (setup === "EVEN" || setup === "ODD") {
    if (probability < requirements.probability || edge < 4) {
      return {
        ok: false,
        reason: "EVEN/ODD blocked: parity edge is too small.",
      };
    }
  }

  if (setup === "RISE" || setup === "FALL") {
    const expected = setup === "RISE" ? ["UP", "RISE"] : ["DOWN", "FALL"];
    if (!expected.includes(momentum)) {
      return {
        ok: false,
        reason: `RISE/FALL blocked: momentum is ${momentum || "NEUTRAL"}.`,
      };
    }

    if (regime.includes("RANDOM") || regime.includes("NO EDGE")) {
      return {
        ok: false,
        reason: "RISE/FALL blocked: market regime has no directional edge.",
      };
    }
  }

  return {
    ok: true,
    setup,
    confidence,
    probability,
    edge,
    samples,
    requirements,
  };
}

function v46SetupFromText(value = "") {
  const text = normalizeSetup(value);

  const over = text.match(/\bOVER\s*([0-9])\b/);
  if (over) return `OVER ${over[1]}`;

  const under = text.match(/\bUNDER\s*([0-9])\b/);
  if (under) return `UNDER ${under[1]}`;

  const match = text.match(/\bMATCH(?:ES)?\s*([0-9])\b/);
  if (match) return `MATCH ${match[1]}`;

  const differs = text.match(/\bDIFFERS?\s*([0-9])\b/);
  if (differs) return `DIFFERS ${differs[1]}`;

  if (/\bEVEN\b/.test(text)) return "EVEN";
  if (/\bODD\b/.test(text)) return "ODD";
  if (/\bRISE\b|\bCALL\b|\bUP\b/.test(text)) return "RISE";
  if (/\bFALL\b|\bPUT\b|\bDOWN\b/.test(text)) return "FALL";

  return "";
}

function v46FallbackCandidates(signal = {}, gate = {}) {
  const analysis = signal.analysis || {};
  const bayesian =
    analysis.bayesianSetup ||
    analysis.bayesian ||
    analysis.bestSetup ||
    {};

  const probability = clampScore(
    gate.selectedProbability ??
    gate.probability ??
    bayesian.probability ??
    analysis.selectedProbability ??
    analysis.probability ??
    signal.probability ??
    gate.confidence ??
    0
  );

  const confidence = clampScore(
    gate.confidence ??
    bayesian.confidence ??
    analysis.confidence ??
    analysis.decisionConfidence ??
    probability
  );

  const edge = Number(
    gate.selectedEdge ??
    gate.edge ??
    bayesian.edge ??
    analysis.selectedEdge ??
    analysis.edge ??
    0
  );

  const sources = [
    gate.setup,
    gate.action,
    bayesian.setup,
    bayesian.action,
    bayesian.label,
    analysis.bestContract,
    analysis.topContract,
    analysis.decision?.setup,
    analysis.decision?.action,
    analysis.primarySignal?.setup,
    analysis.secondarySignal?.setup,
    analysis.signals?.best?.setup,
    signal.setup,
    signal.action,
  ];

  const seen = new Set();
  const result = [];

  for (const source of sources) {
    const setup = v46SetupFromText(source);

    if (!setup || seen.has(setup)) continue;
    seen.add(setup);

    result.push({
      setup,
      action: setup,
      confidence,
      probability,
      edge,
      approved: probability >= 60 || confidence >= 60,
      family:
        setup === "EVEN" || setup === "ODD"
          ? "PARITY"
          : setup.startsWith("OVER") || setup.startsWith("UNDER")
            ? "OVER_UNDER"
            : setup.startsWith("MATCH") || setup.startsWith("DIFFERS")
              ? "MATCH_DIFFERS"
              : "RISE_FALL",
      source: "V46_FALLBACK",
    });
  }

  return result;
}

function v46IsStandardDigit(candidate = {}) {
  const setup = candidateAction(candidate);

  return (
    setup === "EVEN" ||
    setup === "ODD" ||
    setup.startsWith("OVER") ||
    setup.startsWith("UNDER") ||
    setup.startsWith("DIFFERS")
  );
}

function v49DigitArray(signal = {}) {
  const analysis = signal.analysis || {};
  const sources = [
    signal.digitHistory,
    signal.recentDigits,
    analysis.digitHistory,
    analysis.recentDigits,
    analysis.lastDigits,
    analysis.digits,
  ];

  for (const source of sources) {
    if (!Array.isArray(source)) continue;

    const digits = source
      .map((item) => {
        const raw =
          typeof item === "object"
            ? item?.digit ?? item?.lastDigit ?? item?.value
            : item;
        const value = Number(raw);
        return Number.isInteger(value) && value >= 0 && value <= 9
          ? value
          : null;
      })
      .filter((value) => value !== null);

    if (digits.length) return digits;
  }

  return [];
}

function v49Percent(count, total) {
  return total > 0 ? (count / total) * 100 : 0;
}

function v49Range(start, end) {
  const values = [];
  for (let value = start; value <= end; value += 1) values.push(value);
  return values;
}

function v49BuildFastDigitCandidates(signal = {}) {
  const allDigits = v49DigitArray(signal);
  if (allDigits.length < 12) return [];

  const historical = allDigits.slice(-Math.min(200, allDigits.length));
  const fast = allDigits.slice(-Math.min(25, allDigits.length));
  const trigger = allDigits.slice(-Math.min(6, allDigits.length));
  const currentDigit = fast[fast.length - 1];

  const lowerFast = fast.filter((digit) => digit <= 4).length;
  const upperFast = fast.filter((digit) => digit >= 5).length;
  const lowerTrigger = trigger.filter((digit) => digit <= 4).length;
  const upperTrigger = trigger.filter((digit) => digit >= 5).length;

  const rowPressure =
    upperFast + upperTrigger > lowerFast + lowerTrigger
      ? "LOWER_TO_UPPER"
      : lowerFast + lowerTrigger > upperFast + upperTrigger
        ? "UPPER_TO_LOWER"
        : "BALANCED";

  const candidates = [];

  for (let barrier = 1; barrier <= 7; barrier += 1) {
    const overHistorical = v49Percent(
      historical.filter((digit) => digit > barrier).length,
      historical.length
    );
    const overFast = v49Percent(
      fast.filter((digit) => digit > barrier).length,
      fast.length
    );
    const overTrigger = v49Percent(
      trigger.filter((digit) => digit > barrier).length,
      trigger.length
    );

    const underHistorical = v49Percent(
      historical.filter((digit) => digit < barrier).length,
      historical.length
    );
    const underFast = v49Percent(
      fast.filter((digit) => digit < barrier).length,
      fast.length
    );
    const underTrigger = v49Percent(
      trigger.filter((digit) => digit < barrier).length,
      trigger.length
    );

    const overBonus =
      rowPressure === "LOWER_TO_UPPER" ? 4 :
      rowPressure === "UPPER_TO_LOWER" ? -3 : 0;

    const underBonus =
      rowPressure === "UPPER_TO_LOWER" ? 4 :
      rowPressure === "LOWER_TO_UPPER" ? -3 : 0;

    const overProbability = clampScore(
      overHistorical * 0.45 +
      overFast * 0.35 +
      overTrigger * 0.20 +
      overBonus
    );

    const underProbability = clampScore(
      underHistorical * 0.45 +
      underFast * 0.35 +
      underTrigger * 0.20 +
      underBonus
    );

    const overBaseline = ((9 - barrier) / 10) * 100;
    const underBaseline = (barrier / 10) * 100;

    candidates.push({
      setup: `OVER ${barrier}`,
      action: `OVER ${barrier}`,
      family: "OVER_UNDER",
      approved: overProbability >= 62,
      probability: overProbability,
      confidence: clampScore(overProbability + Math.min(8, fast.length / 4)),
      edge: Math.max(0, overProbability - overBaseline),
      source: "V49_FAST_ROW",
      rowPressure,
      currentDigit,
      triggerDigits: v49Range(0, Math.min(9, barrier + 1)),
      winningDigits: v49Range(barrier + 1, 9),
      fastEntry: true,
    });

    candidates.push({
      setup: `UNDER ${barrier}`,
      action: `UNDER ${barrier}`,
      family: "OVER_UNDER",
      approved: underProbability >= 62,
      probability: underProbability,
      confidence: clampScore(underProbability + Math.min(8, fast.length / 4)),
      edge: Math.max(0, underProbability - underBaseline),
      source: "V49_FAST_ROW",
      rowPressure,
      currentDigit,
      triggerDigits: v49Range(Math.max(0, barrier - 1), 9),
      winningDigits: v49Range(0, barrier - 1),
      fastEntry: true,
    });
  }

  for (let target = 0; target <= 9; target += 1) {
    const historicalExact = v49Percent(
      historical.filter((digit) => digit === target).length,
      historical.length
    );
    const fastExact = v49Percent(
      fast.filter((digit) => digit === target).length,
      fast.length
    );

    let transitionTotal = 0;
    let transitionReturns = 0;

    for (let index = 0; index < historical.length - 1; index += 1) {
      if (historical[index] !== currentDigit) continue;
      transitionTotal += 1;
      if (historical[index + 1] === target) transitionReturns += 1;
    }

    const transitionReturn = v49Percent(transitionReturns, transitionTotal);
    const exactRisk = clampScore(
      historicalExact * 0.45 +
      fastExact * 0.35 +
      transitionReturn * 0.20
    );

    candidates.push({
      setup: `DIFFERS ${target}`,
      action: `DIFFERS ${target}`,
      family: "MATCH_DIFFERS",
      approved: exactRisk <= 13,
      probability: exactRisk,
      confidence: clampScore(100 - exactRisk),
      edge: Math.max(0, 10 - exactRisk),
      source: "V49_DYNAMIC_DIFFERS",
      rowPressure,
      currentDigit,
      avoidDigit: target,
      triggerDigits: v49Range(0, 9).filter((digit) => digit !== target),
      winningDigits: v49Range(0, 9).filter((digit) => digit !== target),
      fastEntry: true,
    });
  }

  return candidates;
}

function v48AllowedCandidate(candidate = {}, isDemo = false) {
  const setup = candidateAction(candidate);

  if (isDemo && (setup === "RISE" || setup === "FALL")) {
    return false;
  }

  return true;
}

function v47CanExecute(candidate = {}, isDemo = false, signal = null) {
  if (!candidate || !v48AllowedCandidate(candidate, isDemo)) return false;

  // V39: rapid candidates must come from a live rapid-engine gate that is
  // actually executable. This prevents a fallback scorer from bypassing the
  // rapid-entry safety gate. No probability/confidence/edge threshold changed.
  if (candidate.rapidEntry && signal?.analysis?.executable !== true) {
    return false;
  }

  if (isDemo && v46IsStandardDigit(candidate)) {
    if (candidate.rapidEntry) {
      return (
        Number(candidate.probability || 0) >= 58 &&
        Number(candidate.confidence || 0) >= 68 &&
        Number(candidate.samples || 0) >= (Number(candidate.timeframeSeconds || 30) === 60 ? 28 : 18) &&
        Number(candidate.transitionCount || 0) >= 2 &&
        Number(candidate.passedVotes || 0) >= 2 &&
        Number(candidate.score || 0) >= 64
      );
    }
    return (
      Number(candidate.probability || 0) >= 66 &&
      Number(candidate.samples || 0) >= 30 &&
      Number(candidate.transitionCount || 0) >= 3 &&
      Number(candidate.passedVotes || 0) >= 2
    );
  }

  // Real and high-risk families remain on the original strict gate.
  return Boolean(candidate.ok);
}

function v47Qualification(candidate = {}, isDemo = false) {
  if (isDemo && v47CanExecute(candidate, true, signal)) {
    return "DEMO_BLOCKER_REMOVED";
  }

  return candidate?.qualificationMode || "BLOCKED";
}

export default class DerivBotEngine {
  constructor({ client, onState }) {
    this.client = client;
    this.onState = typeof onState === "function" ? onState : () => {};

    this.settings = { ...DEFAULTS };
    this.signal = null;
    this.symbol = "";
    this.currency = "USD";
    this.isDemoAccount = false;

    this.running = false;
    this.paused = false;
    this.stopping = false;
    this.activeContractId = "";

    this.signalUpdatedAt = 0;
    this.signalVersion = 0;
    this.lastSignalVersionKey = "";
    this.lastSignalTickKey = "";
    this.scanTickCount = 0;
    this.scanWindow = 1;
    this.pendingSetupKey = "";
    this.pendingSignalCount = 0;
    this.pendingSignalSince = 0;
    this.pendingSignalVersion = 0;
    this.blockedSetups = new Map();
    this.lastTradeAt = 0;
    this.lastLossSetup = "";
    this.strictSetupKey = "";
    this.strictConfirmations = 0;
    this.strictLastTickKey = "";
    this.lockedCandidate = null;
    this.lockedCandidateTick = 0;
    this.lockedSignalVersion = 0;
    this.executionPhase = "SCAN";

    this.state = {
      status: "IDLE",
      message: "Bot is ready.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      totalStake: 0,
      totalPayout: 0,
      completedAt: 0,
      stopReason: "",
      consecutiveLosses: 0,
      lossesSinceWin: 0,
      cooldownUntil: 0,
      cooldownCount: 0,
      currentWinStreak: 0,
      largestWinStreak: 0,
      largestLossStreak: 0,
      martingaleStep: 0,
      currentStake: DEFAULTS.stake,
      activeSetup: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      activeContractId: "",
      scanStartedAt: 0,
      scanElapsedSeconds: 0,
      scanTicks: 0,
      maxScanTicks: DEFAULTS.maxScanTicks,
      scanWindow: 1,
      lastBlockReason: "",
      fallbackTrades: 0,
      signalConfirmations: 0,
      requiredConfirmations: DEFAULTS.confirmationCount,
      blockedSetupUntil: 0,
      lastLossSetup: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      lossProtectionCount: 0,
      deepScore: 0,
      deepConsensus: 0,
      deepRegime: "UNKNOWN",
      cyclePeriod: 0,
      fastLane: false,
      gate: null,
      executionPhase: "SCAN",
      lockedCandidate: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      signalVersion: 0,
      lockedSignalVersion: 0,
      history: [],
    };

    this.removeContractListener = this.client.onContract((contract) => {
      this.handleContractUpdate(contract);
    });

    this.contractWaiters = new Map();
  }

  destroy() {
    this.stop("Bot page closed.");

    if (this.removeContractListener) {
      this.removeContractListener();
      this.removeContractListener = null;
    }
  }

  configure(input = {}) {
    const durationUnit = input.durationUnit === "s" ? "s" : "t";
    const durationMin = durationUnit === "s" ? 15 : 1;
    const durationMax = durationUnit === "s" ? 3600 : 10;

    this.settings = {
      ...DEFAULTS,
      ...input,
      maxRuns: Math.max(1, Math.min(1000, number(input.maxRuns, 56))),
      maxScanTicks: Math.max(
        24,
        Math.min(120, Math.floor(number(input.maxScanTicks, DEFAULTS.maxScanTicks)))
      ),
      minConfidence: Math.max(
        60,
        Math.min(95, number(input.minConfidence, DEFAULTS.minConfidence))
      ),
      minVotes: 1,
      stake: Math.max(0.35, number(input.stake, 1)),
      contractMode: normalizeContractMode(input.contractMode),
      prediction: Math.max(
        0,
        Math.min(9, Math.floor(number(input.prediction, 2)))
      ),
      durationUnit,
      duration: Math.max(
        durationMin,
        Math.min(
          durationMax,
          number(input.duration, durationUnit === "s" ? 30 : 5)
        )
      ),
      delaySeconds: Math.max(
        0,
        Math.min(60, number(input.delaySeconds, DEFAULTS.delaySeconds))
      ),
      takeProfit: Math.max(0, number(input.takeProfit, DEFAULTS.takeProfit)),
      stopLoss: Math.max(0, number(input.stopLoss, DEFAULTS.stopLoss)),
      cooldownAfterLosses: Math.max(
        1,
        Math.min(10, number(input.cooldownAfterLosses, DEFAULTS.cooldownAfterLosses))
      ),
      cooldownSeconds: Math.max(
        10,
        Math.min(900, number(input.cooldownSeconds, DEFAULTS.cooldownSeconds))
      ),
      hardStopLossStreak: Math.max(
        2,
        Math.min(20, number(input.hardStopLossStreak, DEFAULTS.hardStopLossStreak))
      ),
      maxMartingaleSteps: Math.max(
        0,
        Math.min(3, number(input.maxMartingaleSteps, DEFAULTS.maxMartingaleSteps))
      ),
      recoveryMultipliers: DEFAULTS.recoveryMultipliers,
      confirmationCount: Math.max(
        1,
        Math.min(6, number(input.confirmationCount, DEFAULTS.confirmationCount))
      ),
      confirmationSeconds: Math.max(
        1,
        Math.min(10, number(input.confirmationSeconds, DEFAULTS.confirmationSeconds))
      ),
      signalMaxAgeSeconds: Math.max(
        3,
        Math.min(30, number(input.signalMaxAgeSeconds, DEFAULTS.signalMaxAgeSeconds))
      ),
      lossSetupBlockSeconds: Math.max(
        30,
        Math.min(900, number(input.lossSetupBlockSeconds, DEFAULTS.lossSetupBlockSeconds))
      ),
      minimumTradeGapSeconds: Math.max(
        3,
        Math.min(60, number(input.minimumTradeGapSeconds, DEFAULTS.minimumTradeGapSeconds))
      ),
      deepMinimumScore: Math.max(
        55,
        Math.min(95, number(input.deepMinimumScore, DEFAULTS.deepMinimumScore))
      ),
      deepOverrideScore: Math.max(
        70,
        Math.min(99, number(input.deepOverrideScore, DEFAULTS.deepOverrideScore))
      ),
      analysisAssisted:
        input.analysisAssisted === undefined
          ? true
          : Boolean(input.analysisAssisted),
    };

    if (!this.running) {
      this.patch({
        currentStake: this.settings.stake,
        maxScanTicks: this.settings.maxScanTicks,
      });
    }
  }

  setAccountMode({ isDemo = false } = {}) {
    this.isDemoAccount = Boolean(isDemo);
  }

  setMarket({ symbol, currency = "USD" }) {
    const nextSymbol = String(symbol || "");
    const changed = Boolean(this.symbol && nextSymbol && this.symbol !== nextSymbol);

    this.symbol = nextSymbol;
    this.currency = String(currency || "USD");

    if (changed) {
      // Never carry an approved signal from the previous market into the new one.
      this.signal = null;
      this.signalUpdatedAt = 0;
      this.pendingSetupKey = "";
      this.pendingSignalCount = 0;
      this.pendingSignalSince = 0;
      this.pendingSignalVersion = 0;
      this.lastSignalVersionKey = "";
      this.lastSignalTickKey = "";
      this.signalVersion = 0;
      this.scanTickCount = 0;
      this.scanWindow = 1;
      this.lockedCandidate = null;
      this.lockedCandidateTick = 0;
      this.lockedSignalVersion = 0;
      this.executionPhase = "SCAN";
      this.patch({
        scanTicks: 0,
        scanWindow: 1,
        scanStartedAt: Date.now(),
        scanElapsedSeconds: 0,
      });
    }
  }

  updateSignal(signal) {
    this.signal = signal;

    const updatedAt = Number(signal?.updatedAt || Date.now());
    this.signalUpdatedAt = updatedAt;

    // Some analysis payloads do not expose a changing tickKey. Confirmations
    // therefore use a signal version derived from tickKey OR updatedAt.
    const versionKey = String(
      signal?.tickKey ||
      signal?.quoteTime ||
      signal?.epoch ||
      updatedAt
    );

    if (
      versionKey &&
      versionKey !== this.lastSignalVersionKey
    ) {
      this.lastSignalVersionKey = versionKey;
      this.signalVersion += 1;

      if (
        this.running &&
        !this.stopping &&
        !this.activeContractId
      ) {
        this.lastSignalTickKey = versionKey;
        this.scanTickCount += 1;

        this.patch({
          scanTicks: this.scanTickCount,
          maxScanTicks: this.settings.maxScanTicks,
          scanWindow: this.scanWindow,
          signalVersion: this.signalVersion,
          lockedSignalVersion: this.lockedSignalVersion,
        });
      }
    }
  }

  resetScanWindow(reason = "Starting a new scan window.") {
    this.scanTickCount = 0;
    this.scanWindow += 1;
    this.lockedCandidate = null;
    this.lockedCandidateTick = 0;
    this.lockedSignalVersion = 0;
    this.executionPhase = "SCAN";
    this.lastSignalVersionKey = "";
    this.lastSignalTickKey = "";
    this.pendingSetupKey = "";
    this.pendingSignalCount = 0;
    this.pendingSignalSince = 0;
    this.pendingSignalVersion = 0;
    this.strictSetupKey = "";
    this.strictConfirmations = 0;
    this.strictLastTickKey = "";
    this.lastSignalTickKey = "";

    this.patch({
      scanTicks: 0,
      maxScanTicks: this.settings.maxScanTicks,
      scanWindow: this.scanWindow,
      scanStartedAt: Date.now(),
      scanElapsedSeconds: 0,
      message: reason,
      activeSetup: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      signalConfirmations: 0,
      executionPhase: "SCAN",
      lockedCandidate: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      signalVersion: this.signalVersion,
      lockedSignalVersion: 0,
    });
  }

  snapshot() {
    return { ...this.state };
  }

  patch(next) {
    this.state = {
      ...this.state,
      ...next,
    };

    this.onState(this.snapshot());
  }

  addHistory(item) {
    this.patch({
      history: [item, ...this.state.history].slice(0, 100),
    });
  }

  validSignal() {
    const signal = this.signal;

    if (!signal) {
      return {
        ok: false,
        reason: "Waiting for fresh market analysis.",
        elapsedSeconds: 0,
        confirmations: 0,
      };
    }

    if (
      signal.symbol &&
      this.symbol &&
      String(signal.symbol) !== String(this.symbol)
    ) {
      return {
        ok: false,
        reason: "Waiting for analysis from the selected market.",
        elapsedSeconds: 0,
        confirmations: 0,
      };
    }

    const analysisAssistedEnabled =
      this.settings.analysisAssisted !== false;

    const signalAgeMs = Date.now() - Number(signal.updatedAt || 0);

    if (!Number(signal.updatedAt) || signalAgeMs > 12000) {
      this.strictSetupKey = "";
      this.strictConfirmations = 0;

      return {
        ok: false,
        reason: "Live ticks are stale or disconnected. Reconnect the Deriv feed.",
        elapsedSeconds: 0,
        confirmations: 0,
      };
    }

    const analysis = signal.analysis || {};

    let gate = {
      approved: false,
      reason: analysisAssistedEnabled
        ? "No assisted candidate was returned."
        : "Analysis Assisted is disabled; V46 fallback candidates are active.",
      candidates: [],
    };

    if (analysisAssistedEnabled) {
      try {
        gate =
          evaluateAnalysisAssistedSignal(analysis, {
            minimumConfidence: this.settings.minConfidence,
            contractMode: this.settings.contractMode,
            prediction: this.settings.prediction,
            durationUnit: this.settings.durationUnit,
          }) || gate;
      } catch (error) {
        console.error("[V49] ANALYSIS GATE ERROR", error);
      }
    }

    const startedAt =
      Number(this.state.scanStartedAt) > 0
        ? Number(this.state.scanStartedAt)
        : Date.now();

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - startedAt) / 1000)
    );

    const candidates = Array.isArray(gate.candidates)
      ? gate.candidates.filter(Boolean)
      : [];

    for (const fallbackCandidate of v46FallbackCandidates(signal, gate)) {
      const fallbackKey = candidateAction(fallbackCandidate);
      const exists = candidates.some(
        (candidate) => candidateAction(candidate) === fallbackKey
      );

      if (!exists) {
        candidates.push(fallbackCandidate);
      }
    }

    for (const fastCandidate of v49BuildFastDigitCandidates(signal)) {
      const fastKey = candidateAction(fastCandidate);
      const existingIndex = candidates.findIndex(
        (candidate) => candidateAction(candidate) === fastKey
      );

      if (existingIndex < 0) {
        candidates.push(fastCandidate);
      } else {
        const existing = candidates[existingIndex];
        candidates[existingIndex] = {
          ...existing,
          ...fastCandidate,
          probability: Math.max(
            Number(existing.probability || 0),
            Number(fastCandidate.probability || 0)
          ),
          confidence: Math.max(
            Number(existing.confidence || 0),
            Number(fastCandidate.confidence || 0)
          ),
          edge: Math.max(
            Number(existing.edge || 0),
            Number(fastCandidate.edge || 0)
          ),
        };
      }
    }

    if (gate.setup) {
      const fallbackProbability = Number(
        gate.selectedProbability ??
        gate.probability ??
        analysis.probability ??
        analysis.bayesianSetup?.probability ??
        signal.probability ??
        gate.confidence ??
        0
      );

      const fallbackConfidence = Number(
        gate.confidence ??
        analysis.confidence ??
        analysis.decisionConfidence ??
        analysis.bayesianSetup?.confidence ??
        fallbackProbability
      );

      candidates.push({
        setup: gate.setup,
        action: gate.setup,
        confidence: fallbackConfidence,
        probability: fallbackProbability,
        edge: Number(gate.selectedEdge || gate.edge || 0),
        approved: Boolean(gate.approved),
        family: gate.family || "",
      });
    }

    const unique = new Map();

    const accountCandidates = candidates.filter((candidate) =>
      v48AllowedCandidate(candidate, this.isDemoAccount)
    );

    for (const candidate of accountCandidates) {
      const key = candidateAction(candidate);

      if (!key) continue;

      try {
        const scored = scoreCandidate(
          candidate,
          signal,
          this.symbol,
          !this.isDemoAccount
        );

        const previous = unique.get(key);

        if (!previous || scored.score > previous.score) {
          unique.set(key, scored);
        }
      } catch (error) {
        console.error("[V49] CANDIDATE SCORE ERROR", {
          key,
          candidate,
          message: error?.message || String(error),
          stack: error?.stack || "",
        });
      }
    }

    const ranked = [...unique.values()].sort(
      (a, b) =>
        Number(b.score) - Number(a.score) ||
        Number(b.confidence) - Number(a.confidence) ||
        Number(b.edge) - Number(a.edge)
    );

    if (!ranked.length) {
      console.warn("[V49] NO RANKED CANDIDATES", {
        gateSetup: gate.setup || "",
        gateCandidates: Array.isArray(gate.candidates)
          ? gate.candidates.length
          : 0,
        signalSetup: signal.setup || signal.action || "",
      });
    }

    // V33 HARD LOCK:
    // 1. Choose a qualifying candidate once.
    // 2. Freeze its setup/contract/score snapshot.
    // 3. Ignore all other candidates until execution or a material collapse.
    let selected = null;

    if (
      this.lockedCandidate &&
      !v48AllowedCandidate(
        this.lockedCandidate.snapshot || this.lockedCandidate,
        this.isDemoAccount
      )
    ) {
      this.releaseCandidateLock("V48 Demo Auto excludes RISE/FALL.");
    }

    if (this.lockedCandidate) {
      const liveLockedCandidate = ranked.find(
        (candidate) => candidate.setup === this.lockedCandidate.setup
      );

      // Release only when the same setup has materially collapsed.
      const collapsed =
        liveLockedCandidate &&
        (
          Number(liveLockedCandidate.score || 0) <
            Math.max(
              0,
              Number(this.lockedCandidate.threshold || 0) - 12
            ) ||
          Number(liveLockedCandidate.samples || 0) < 20
        );

      if (collapsed) {
        console.warn("[V49] LOCK RELEASED: candidate materially weakened", {
          setup: this.lockedCandidate.setup,
          lockedScore: this.lockedCandidate.score,
          liveScore: liveLockedCandidate.score,
        });

        this.lockedCandidate = null;
        this.lockedCandidateTick = 0;
        this.lockedSignalVersion = 0;
        this.strictConfirmations = 0;
        this.executionPhase = "SCAN";
      } else {
        // Use the frozen snapshot. Do not switch contracts while confirming.
        selected = {
          ...this.lockedCandidate.snapshot,
          ok: true,
          setup: this.lockedCandidate.setup,
          confirmations: this.lockedCandidate.confirmations,
        };
      }
    }

    if (!selected) {
      const executableDemoDigit =
        this.isDemoAccount
          ? ranked
              .filter((candidate) => v46IsStandardDigit(candidate))
              .filter((candidate) => v47CanExecute(candidate, true, signal))
              .sort((left, right) => {
                const normalizedProbability = (candidate) => {
                  const setup = candidateAction(candidate);
                  const probability = Number(candidate.probability || 0);
                  return setup.startsWith("DIFFERS")
                    ? 100 - probability
                    : probability;
                };

                const fastBonus = (candidate) =>
                  candidate.fastEntry ? 4 : 0;

                const probabilityDifference =
                  normalizedProbability(right) + fastBonus(right) -
                  (normalizedProbability(left) + fastBonus(left));

                if (probabilityDifference !== 0) {
                  return probabilityDifference;
                }

                return Number(right.score || 0) - Number(left.score || 0);
              })[0]
          : null;

      selected =
        executableDemoDigit ||
        ranked.find((candidate) =>
          v47CanExecute(candidate, this.isDemoAccount, signal)
        ) ||
        ranked.find((candidate) => candidate.ok) ||
        ranked[0];
    }

    const selectedCanExecute =
      selected &&
      v47CanExecute(selected, this.isDemoAccount, signal);

    if (!selected || !selectedCanExecute) {
      this.strictSetupKey = "";
      this.strictConfirmations = 0;
      this.executionPhase = "SCAN";

      const bestText = selected
        ? `${selected.setup || "Candidate"} score ${selected.score.toFixed(1)}/${selected.threshold}. ` +
          `Votes ${selected.passedVotes}/${selected.requiredVotes}; strong ${selected.strongVotes}. ` +
          `Samples ${selected.samples}, entropy ${selected.entropy.toFixed(1)}%, market ${selected.marketProfile}.`
        : gate.reason || "No candidate is ready.";

      return {
        ok: false,
        reason:
          `${bestText} ${
            this.isDemoAccount
              ? "V48 Demo Auto excludes RISE/FALL and uses digit contracts only. Standard digits need probability 70%+, 50 samples, 4 transitions and 2 votes."
              : "V48 Real remains unchanged and keeps the strict scored gate."
          } Probability, confidence and ranking now use one evidence model. No forced entry.`,
        elapsedSeconds,
        confirmations: 0,
        requiredConfirmations: this.isDemoAccount ? 1 : 2,
        gate: {
          ...gate,
          scoredCandidates: ranked.map((candidate) => ({
            ...candidate,
            accountExecutionPass: v47CanExecute(candidate, this.isDemoAccount, signal),
          })),
          executionScore: selected?.score || 0,
          executionThreshold: selected?.threshold || 0,
          engineVotes: selected?.passedVotes || 0,
          requiredEngineVotes: selected?.requiredVotes || 0,
          strongEngineVotes: selected?.strongVotes || 0,
          marketProfile: selected?.marketProfile || marketProfile(this.symbol).name,
          independentContractScore: Boolean(selected?.independentContractScore),
          scoreBreakdown: selected?.scoreBreakdown || null,
          blockedChecks: selected?.blockedChecks || null,
          realDigitQualityPass: Boolean(selected?.realDigitQualityPass),
          directEvidencePass: Boolean(selected?.directEvidencePass),
          qualificationMode: v47Qualification(
            selected,
            this.isDemoAccount
          ),
          accountExecutionPass: Boolean(selectedCanExecute),
          executionPhase: "SCAN",
          lockedCandidate: selected?.setup || "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
          signalVersion: this.signalVersion,
          lockedSignalVersion: 0,
        },
      };
    }

    if (!this.lockedCandidate) {
      const setup = selected.setup;

      if (
        this.isDemoAccount &&
        (setup === "RISE" || setup === "FALL")
      ) {
        return {
          ok: false,
          reason: "V48 Demo Auto excludes RISE/FALL. Waiting for a digit contract.",
          elapsedSeconds,
          confirmations: 0,
          requiredConfirmations: 1,
          gate: {
            ...gate,
            ok: false,
            qualificationMode: "DEMO_DIGITS_ONLY",
            accountExecutionPass: false,
            executionPhase: "SCAN",
            lockedCandidate: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
          },
        };
      }

      const setupKey = `${this.symbol}:${setup}`;
      const contract = contractFromSetup(setup);

      if (!contract) {
        return {
          ok: false,
          reason: `Unsupported scored setup: ${setup}.`,
          elapsedSeconds,
          confirmations: 0,
          gate,
        };
      }

      const requiredConfirmations = this.isDemoAccount
        ? (selected.rapidEntry ? 0 : 1)
        : 2;

      this.lockedCandidate = {
        setupKey,
        setup,
        contract,
        score: selected.score,
        threshold: selected.threshold,
        probability: selected.probability,
        confidence: selected.confidence,
        confirmations: requiredConfirmations,
        lockedAtTick: this.scanTickCount,
        lockedAtSignalVersion: this.signalVersion,
        snapshot: {
          ...selected,
          ok:
            this.isDemoAccount && v46IsStandardDigit(selected)
              ? true
              : Boolean(selected.ok),
          accountExecutionPass: true,
          qualificationMode: v47Qualification(
            selected,
            this.isDemoAccount
          ),
          contract,
        },
      };

      this.lockedCandidateTick = this.scanTickCount;
      this.lockedSignalVersion = this.signalVersion;
      this.strictSetupKey = setupKey;
      this.strictConfirmations = 0;
      this.executionPhase = "LOCKED";

      console.log("[V49] CANDIDATE LOCKED", {
        setup,
        score: selected.score,
        threshold: selected.threshold,
        signalVersion: this.signalVersion,
        requiredConfirmations,
      });

      this.patch({
        executionPhase: "LOCKED",
        lockedCandidate: setup,
        signalVersion: this.signalVersion,
        lockedSignalVersion: this.lockedSignalVersion,
      });

      selected = {
        ...this.lockedCandidate.snapshot,
        ok: true,
        accountExecutionPass: true,
        qualificationMode: v47Qualification(
          this.lockedCandidate.snapshot,
          this.isDemoAccount
        ),
        setup,
        confirmations: requiredConfirmations,
      };
    }

    const setup = this.lockedCandidate.setup;
    const requiredConfirmations = this.lockedCandidate.confirmations;

    // Rapid 30s/60s candidates are already confirmed by the live multi-window
    // scorer; do not add an artificial extra-tick delay before entry.
    if (this.lockedCandidate.snapshot?.rapidEntry && requiredConfirmations === 0) {
      this.strictConfirmations = 0;
      this.executionPhase = "READY";
    }

    // Confirm using fresh signal payloads after lock, not scanTickCount.
    const confirmationUpdates = Math.max(
      0,
      this.signalVersion - this.lockedSignalVersion
    );

    this.strictConfirmations = confirmationUpdates;
    this.executionPhase =
      confirmationUpdates >= requiredConfirmations
        ? "READY"
        : "CONFIRMING";

    if (confirmationUpdates < requiredConfirmations) {
      return {
        ok: false,
        reason:
          `${setup} HARD-LOCKED. Confirming ${confirmationUpdates}/${requiredConfirmations} fresh signal update(s). ` +
          `Locked score ${Number(this.lockedCandidate.score).toFixed(1)}/${Number(this.lockedCandidate.threshold).toFixed(1)}.`,
        elapsedSeconds,
        confirmations: confirmationUpdates,
        requiredConfirmations,
        gate: {
          ...gate,
          scoredCandidates: ranked,
          executionScore: this.lockedCandidate.score,
          executionThreshold: this.lockedCandidate.threshold,
          engineVotes: selected.passedVotes,
          requiredEngineVotes: selected.requiredVotes,
          strongEngineVotes: selected.strongVotes,
          marketProfile: selected.marketProfile,
          independentContractScore: true,
          scoreBreakdown: selected.scoreBreakdown || null,
          blockedChecks: selected.blockedChecks || null,
          realDigitQualityPass: Boolean(selected.realDigitQualityPass),
          directEvidencePass: Boolean(selected.directEvidencePass),
          qualificationMode: v47Qualification(
            selected,
            this.isDemoAccount
          ),
          accountExecutionPass: true,
          executionPhase: "CONFIRMING",
          lockedCandidate: setup,
          signalVersion: this.signalVersion,
          lockedSignalVersion: this.lockedSignalVersion,
        },
      };
    }

    console.log("[V49] CANDIDATE READY", {
      setup,
      confirmations: confirmationUpdates,
      requiredConfirmations,
      signalVersion: this.signalVersion,
      lockedSignalVersion: this.lockedSignalVersion,
    });

    if (
      this.isDemoAccount &&
      (setup === "RISE" || setup === "FALL")
    ) {
      this.releaseCandidateLock("V48 Demo Auto excludes RISE/FALL.");

      return {
        ok: false,
        reason: "V48 Demo Auto excludes RISE/FALL. Waiting for a digit contract.",
        elapsedSeconds,
        confirmations: 0,
        requiredConfirmations: 1,
        gate: {
          ...gate,
          ok: false,
          qualificationMode: "DEMO_DIGITS_ONLY",
          accountExecutionPass: false,
          executionPhase: "SCAN",
          lockedCandidate: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
        },
      };
    }

    const contract =
      this.lockedCandidate?.contract ||
      contractFromSetup(setup);

    if (!contract) {
      return {
        ok: false,
        reason: `Unsupported scored setup: ${setup}.`,
        elapsedSeconds,
        confirmations: this.strictConfirmations,
        gate,
      };
    }

    return {
      ok: true,
      mode: !this.isDemoAccount
        ? "REAL_MULTI_ENGINE_CONSENSUS"
        : "DEMO_MULTI_ENGINE_CONSENSUS",
      decision: {
        setup,
        bestContract: setup,
        confidence: selected.score,
        professionalScore: selected.score,
        marketQuality: selected.probability,
        riskLevel: !this.isDemoAccount
          ? "REAL CONSERVATIVE"
          : "DEMO CONSERVATIVE",
        passedCount: ranked.filter((item) =>
          v47CanExecute(item, this.isDemoAccount, signal)
        ).length,
        validated: true,
        gateReason:
          `Scored consensus ${selected.score.toFixed(1)}/${selected.threshold} passed ` +
          `with ${this.strictConfirmations} fresh confirmations and ${selected.samples} samples.`,
      },
      timing: {
        state: "ENTER",
        readyNow: true,
      },
      contract,
      elapsedSeconds,
      confirmations: this.strictConfirmations,
      requiredConfirmations,
      gate: {
        ...gate,
        scoredCandidates: ranked,
        executionScore: selected.score,
        executionThreshold: selected.threshold,
        engineVotes: selected.passedVotes,
        requiredEngineVotes: selected.requiredVotes,
        strongEngineVotes: selected.strongVotes,
        marketProfile: selected.marketProfile,
        independentContractScore: true,
        demoDigitQualityPass: Boolean(selected.demoDigitQualityPass),
        realDigitQualityPass: Boolean(selected.realDigitQualityPass),
        directEvidencePass: Boolean(selected.directEvidencePass),
        qualificationMode: v47Qualification(
          selected,
          this.isDemoAccount
        ),
        accountExecutionPass: true,
        currentDigit: selected.currentDigit,
        rowPressure: selected.rowPressure || "BALANCED",
        triggerDigits: selected.triggerDigits || [],
        winningDigits: selected.winningDigits || [],
        avoidDigit: selected.avoidDigit,
        fastEntry: Boolean(selected.fastEntry),
        blockedChecks:
          this.isDemoAccount && v46IsStandardDigit(selected)
            ? null
            : selected.blockedChecks || null,
        executionPhase: "READY",
        lockedCandidate: setup,
        signalVersion: this.signalVersion,
        lockedSignalVersion: this.lockedSignalVersion,
      },
    };
  }

  async start() {
    if (this.running) return;

    if (!this.symbol) {
      throw new Error("Connect the Deriv feed and select a market first.");
    }

    this.running = true;
    this.paused = false;
    this.stopping = false;
    this.pendingSetupKey = "";
    this.pendingSignalCount = 0;
    this.pendingSignalSince = 0;
    this.pendingSignalVersion = 0;
    this.lockedCandidate = null;
    this.lockedCandidateTick = 0;
    this.lockedSignalVersion = 0;
    this.strictSetupKey = "";
    this.strictConfirmations = 0;
    this.executionPhase = "SCAN";
    this.lastSignalVersionKey = "";
    this.lastSignalTickKey = "";
    this.scanTickCount = 0;
    this.scanWindow = 1;

    this.patch({
      status: "RUNNING",
      message:
        "V49 keeps Demo digits-only, adds lower/upper row pressure, ranks OVER/UNDER barriers 1ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ7, dynamically ranks DIFFERS digits, and enters after one fresh confirmation.",
      scanStartedAt: Date.now(),
      scanElapsedSeconds: 0,
      scanTicks: 0,
      maxScanTicks: this.settings.maxScanTicks,
      scanWindow: 1,
      lastBlockReason: "",
    });

    void this.loop();
  }

  pause() {
    if (!this.running) return;

    this.paused = true;
    this.patch({
      status: "PAUSED",
      message: "Bot paused. Active trade will still be monitored.",
    });
  }

  resume() {
    if (!this.running) return;

    this.paused = false;
    this.patch({
      status: "RUNNING",
      message: "Bot resumed.",
    });
  }

  stop(message = "Bot stopped.", status = "STOPPED") {
    this.stopping = true;
    this.running = false;
    this.paused = false;

    this.contractWaiters.forEach((waiter) => {
      window.clearTimeout(waiter.timeout);
      waiter.reject(new Error("Bot stopped."));
    });

    this.contractWaiters.clear();

    this.patch({
      status,
      message,
      stopReason: message,
      completedAt:
        status === "COMPLETED" ? Date.now() : this.state.completedAt,
      cooldownUntil: 0,
      activeContractId: "",
    });
  }

  reset() {
    if (this.running) return;

    this.state = {
      status: "IDLE",
      message: "Bot statistics reset.",
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      totalStake: 0,
      totalPayout: 0,
      completedAt: 0,
      stopReason: "",
      consecutiveLosses: 0,
      lossesSinceWin: 0,
      cooldownUntil: 0,
      cooldownCount: 0,
      currentWinStreak: 0,
      largestWinStreak: 0,
      largestLossStreak: 0,
      martingaleStep: 0,
      currentStake: this.settings.stake,
      activeSetup: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      activeContractId: "",
      scanStartedAt: 0,
      scanElapsedSeconds: 0,
      scanTicks: 0,
      maxScanTicks: this.settings.maxScanTicks,
      scanWindow: 1,
      lastBlockReason: "",
      fallbackTrades: 0,
      signalConfirmations: 0,
      requiredConfirmations: this.settings.confirmationCount,
      blockedSetupUntil: 0,
      lastLossSetup: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      lossProtectionCount: 0,
      deepScore: 0,
      deepConsensus: 0,
      deepRegime: "UNKNOWN",
      cyclePeriod: 0,
      fastLane: false,
      gate: null,
      executionPhase: "SCAN",
      lockedCandidate: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      signalVersion: 0,
      lockedSignalVersion: 0,
      history: [],
    };

    this.pendingSetupKey = "";
    this.pendingSignalCount = 0;
    this.pendingSignalSince = 0;
    this.pendingSignalVersion = 0;
    this.lastSignalTickKey = "";
    this.scanTickCount = 0;
    this.scanWindow = 1;
    this.blockedSetups.clear();
    this.lastTradeAt = 0;
    this.lastLossSetup = "";
    this.strictSetupKey = "";
    this.strictConfirmations = 0;
    this.strictLastTickKey = "";
    this.lockedCandidate = null;
    this.lockedCandidateTick = 0;
    this.lockedSignalVersion = 0;
    this.executionPhase = "SCAN";

    this.onState(this.snapshot());
  }

  riskStopReason() {
    if (
      !this.isDemoAccount &&
      this.state.lossesSinceWin >= 1
    ) {
      return {
        message:
          "REAL safety stop: one loss reached. Review the session before manually restarting.",
        status: "STOPPED",
      };
    }

    if (this.state.runs >= this.settings.maxRuns) {
      return {
        message: `Completed ${this.settings.maxRuns} runs.`,
        status: "COMPLETED",
      };
    }

    if (
      this.settings.takeProfit > 0 &&
      this.state.profit >= this.settings.takeProfit
    ) {
      return {
        message: `Take profit reached: ${this.state.profit.toFixed(2)} ${
          this.currency
        }.`,
        status: "COMPLETED",
      };
    }

    if (
      this.settings.stopLoss > 0 &&
      this.state.profit <= -this.settings.stopLoss
    ) {
      return {
        message: `Stop loss reached: ${this.state.profit.toFixed(2)} ${
          this.currency
        }.`,
        status: "STOPPED",
      };
    }

    if (
      this.state.lossesSinceWin >=
      this.settings.hardStopLossStreak
    ) {
      return {
        message: `Hard stop reached after ${this.state.lossesSinceWin} losses without a recovery win.`,
        status: "STOPPED",
      };
    }

    return null;
  }

  async runRiskCooldown() {
    const until = Number(this.state.cooldownUntil || 0);

    if (!until || until <= Date.now()) {
      return;
    }

    while (
      this.running &&
      !this.stopping &&
      Date.now() < until
    ) {
      if (this.paused) {
        await sleep(500);
        continue;
      }

      const remaining = Math.max(
        1,
        Math.ceil((until - Date.now()) / 1000)
      );

      this.patch({
        status: "RISK_COOLDOWN",
        message: `Risk cooldown active. Waiting ${remaining}s for better conditions.`,
      });

      await sleep(1000);
    }

    if (!this.running || this.stopping) {
      return;
    }

    this.patch({
      status: "RUNNING",
      message: "Risk cooldown completed. Waiting for a new validated setup.",
      cooldownUntil: 0,
      cooldownCount: this.state.cooldownCount + 1,
      consecutiveLosses: 0,
      martingaleStep: 0,
      currentStake: this.settings.stake,
      activeSetup: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      signalConfirmations: 0,
      lastBlockReason: "",
    });
  }

  async loop() {
    while (this.running && !this.stopping) {
      if (Number(this.state.cooldownUntil || 0) > Date.now()) {
        await this.runRiskCooldown();
        continue;
      }

      const stopReason = this.riskStopReason();

      if (stopReason) {
        this.stop(stopReason.message, stopReason.status);
        return;
      }

      if (this.paused) {
        await sleep(500);
        continue;
      }

      const check = this.validSignal();

      console.debug("[V49] GATE", {
        ok: check.ok,
        phase: this.executionPhase,
        lockedCandidate: this.lockedCandidate?.setup || "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
        confirmations: check.confirmations || 0,
        requiredConfirmations: check.requiredConfirmations || 0,
        signalVersion: this.signalVersion,
        lockedSignalVersion: this.lockedSignalVersion,
      });

      if (!check.ok) {
        this.patch({
          status: "WAITING",
          message: check.reason,
          activeSetup: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
          scanElapsedSeconds: number(check.elapsedSeconds),
          scanTicks: this.scanTickCount,
          maxScanTicks: this.settings.maxScanTicks,
          scanWindow: this.scanWindow,
          lastBlockReason: check.reason,
          signalConfirmations: number(check.confirmations),
          requiredConfirmations: number(
            check.requiredConfirmations,
            this.settings.confirmationCount
          ),
          blockedSetupUntil: number(check.blockedSetupUntil),
          deepScore: number(
            check.deepAssessment?.score ?? check.intelligence?.bestScore
          ),
          deepConsensus: number(check.intelligence?.consensus),
          deepRegime: check.intelligence?.regime || "UNKNOWN",
          cyclePeriod: number(check.intelligence?.cycle?.period),
          fastLane: Boolean(check.deepAssessment?.fastLane),
          gate: check.gate || null,
          executionPhase: check.gate?.executionPhase || this.executionPhase || "SCAN",
          lockedCandidate: check.gate?.lockedCandidate || this.lockedCandidate?.setup || "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
        });

        await sleep(1000);
        continue;
      }

      try {
        console.log("[V49] EXECUTE TRADE", {
          setup: check.contract?.label,
          phase: this.executionPhase,
          confirmations: check.confirmations,
        });
        await this.executeTrade(check);
      } catch (error) {
        console.error("===== EXECUTE TRADE ERROR =====");
        console.error(error);
        console.error(error?.stack);

        const message =
          error instanceof Error ? error.message : "Trade execution failed.";

        this.addHistory({
          id: `error-${Date.now()}`,
          time: Date.now(),
          setup: `${check.contract.label} ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${message}`,
          result: "ERROR",
          profit: 0,
          stake: this.state.currentStake,
          message,
        });

        this.patch({
          status: "ERROR",
          message,
          activeContractId: "",
        });

        await sleep(3000);
      }

      if (
        this.running &&
        Number(this.state.cooldownUntil || 0) <= Date.now() &&
        this.settings.delaySeconds > 0
      ) {
        this.patch({
          status: "COOLDOWN",
          message: `Waiting ${this.settings.delaySeconds}s before the next scan.`,
        });

        await sleep(this.settings.delaySeconds * 1000);
      }
    }
  }

  async testOneTrade(setup = "RISE") {
    if (this.running || this.activeContractId) {
      throw new Error(
        "Stop or pause the automatic bot before running a test trade."
      );
    }

    if (!this.symbol) {
      throw new Error(
        "Connect the Deriv feed and select a market first."
      );
    }

    const contract = contractFromSetup(setup);

    if (!contract) {
      throw new Error(`Unsupported test setup: ${setup}.`);
    }

    const check = {
      mode: "MANUAL_TEST",
      contract,
      decision: {
        setup: contract.label,
        confidence: 100,
        passedCount: 7,
        validated: true,
      },
      timing: {
        state: "TEST",
        readyNow: true,
      },
    };

    this.patch({
      status: "TESTING",
      message: `Opening one ${this.isDemoAccount ? "Demo" : "Real"} test trade: ${contract.label}.`,
      activeSetup: contract.label,
    });

    await this.executeTrade(check);

    this.patch({
      status: "IDLE",
      message:
        `${this.isDemoAccount ? "Demo" : "Real"} test trade completed. The automatic bot remains stopped.`,
      cooldownUntil: 0,
    });
  }

  async testOneDemoTrade(setup = "RISE") {
    return this.testOneTrade(setup);
  }

  async executeTrade(check) {
    const configuredStake = Number(this.state.currentStake.toFixed(2));
    const stake = this.isDemoAccount
      ? configuredStake
      : Math.min(configuredStake, Number(this.settings.realStakeCap || 1));
    const digitContract = isDigitContract(check.contract);

    // Scan ticks and contract duration are separate.
    // maxScanTicks controls how long AI searches; duration controls the bought contract.
    const tradeDuration = this.settings.duration;
    const tradeDurationUnit = digitContract
      ? "t"
      : this.settings.durationUnit;

    this.executionPhase = "PROPOSAL";

    this.patch({
      status: "PROPOSAL",
      executionPhase: "PROPOSAL",
      lockedCandidate: check.contract.label,
      message:
        `${this.isDemoAccount ? "Demo" : "REAL"} ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· V49 fast digit-row entry confirmed ${check.contract.label} at scan tick ${this.scanTickCount}/${this.settings.maxScanTicks} for ${durationText(
          tradeDuration,
          tradeDurationUnit
        )}. Requesting ${stake.toFixed(2)} ${this.currency}.`,
      activeSetup: `${check.contract.label} ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· V49 FAST DIGIT ROW`,
      signalConfirmations: number(
        check.requiredConfirmations,
        this.settings.confirmationCount
      ),
      lastBlockReason: "",
      requiredConfirmations: number(
        check.requiredConfirmations,
        this.settings.confirmationCount
      ),
      deepScore: number(check.decision?.deepScore),
      deepConsensus: number(check.decision?.deepConsensus),
      deepRegime: check.decision?.deepRegime || "UNKNOWN",
      cyclePeriod: number(check.decision?.cyclePeriod),
      fastLane: Boolean(check.decision?.fastLane),
      gate: check.gate || null,
    });

    console.log("===== DERIV BUY REQUEST =====", {
      symbol: this.symbol,
      contractType: check.contract.contractType,
      barrier: check.contract.barrier,
      amount: stake,
      basis: "stake",
      currency: this.currency,
      duration: tradeDuration,
      durationUnit: tradeDurationUnit,
      entryScanTick: this.scanTickCount,
      scanWindow: this.scanWindow,
    });

    console.log("V19.5 BUY REQUEST", {
      symbol: this.symbol,
      contractType: check.contract.contractType,
      barrier: check.contract.barrier,
      amount: stake,
      duration: tradeDuration,
      durationUnit: tradeDurationUnit,
      mode: check.gate?.executionLane || check.mode,
    });

    console.log("V19.6 BUY REQUEST", {
      symbol: this.symbol,
      contractType: check.contract.contractType,
      barrier: check.contract.barrier,
      amount: stake,
      currency: this.currency,
      duration: this.settings.duration,
      durationUnit: this.settings.durationUnit,
      executionMode: check.mode,
    });

    this.patch({
      status: "BUYING",
      executionPhase: "BUYING",
      message: `Proposal accepted for ${check.contract.label}. Sending buy request.`,
    });

    const bought = await this.client.buyContract({
      symbol: this.symbol,
      contractType: check.contract.contractType,
      barrier: check.contract.barrier,
      amount: stake,
      basis: "stake",
      currency: this.currency,
      duration: tradeDuration,
      durationUnit: tradeDurationUnit,
    });

    console.log("===== DERIV BUY RESPONSE =====", bought);

    if (!bought.contractId) {
      throw new Error("Deriv did not return a contract ID.");
    }

    this.activeContractId = String(bought.contractId);

    this.executionPhase = "MONITORING";

    this.patch({
      status: "MONITORING",
      executionPhase: "MONITORING",
      message: `Monitoring contract ${this.activeContractId}.`,
      activeContractId: this.activeContractId,
    });

    const settled = await this.waitForContract(
      this.activeContractId,
      tradeDuration,
      tradeDurationUnit
    );
    const profit = contractProfit(settled);
    const details = contractDetails(settled, bought);
    const won = profit > 0;

    const runs = this.state.runs + 1;
    const wins = this.state.wins + (won ? 1 : 0);
    const losses = this.state.losses + (won ? 0 : 1);
    const totalProfit = this.state.profit + profit;
    const totalStake = this.state.totalStake + stake;
    const totalPayout =
      this.state.totalPayout + Math.max(0, details.payout);
    const consecutiveLosses = won ? 0 : this.state.consecutiveLosses + 1;
    const lossesSinceWin = won ? 0 : this.state.lossesSinceWin + 1;
    const currentWinStreak = won ? this.state.currentWinStreak + 1 : 0;
    const largestWinStreak = Math.max(
      this.state.largestWinStreak,
      currentWinStreak
    );
    const largestLossStreak = Math.max(
      this.state.largestLossStreak,
      consecutiveLosses
    );

    let martingaleStep = 0;
    let nextStake = this.settings.stake;

    if (
      !won &&
      this.isDemoAccount &&
      this.settings.martingaleEnabled &&
      this.state.martingaleStep < this.settings.maxMartingaleSteps
    ) {
      martingaleStep = this.state.martingaleStep + 1;
      nextStake =
        this.settings.stake *
        smartRecoveryMultiplier(
          martingaleStep,
          this.settings.recoveryMultipliers
        );
    }

    const setup = normalizeSetup(check.contract.label);
    const setupKey = `${this.symbol}:${setup}`;
    const now = Date.now();
    let blockedSetupUntil = 0;
    let lossProtectionCount = this.state.lossProtectionCount;

    if (!won) {
      blockedSetupUntil =
        now + this.settings.lossSetupBlockSeconds * 1000;
      this.blockedSetups.set(setupKey, blockedSetupUntil);
      this.lastLossSetup = setup;
      lossProtectionCount += 1;
    }

    this.addHistory({
      id: this.activeContractId,
      time: now,
      setup: check.contract.label,
      result: won ? "WIN" : "LOSS",
      profit,
      stake,
      payout: details.payout,
      buyPrice: details.buyPrice,
      sellPrice: details.sellPrice,
      entrySpot: details.entrySpot,
      exitSpot: details.exitSpot,
      duration: tradeDuration,
      durationUnit: tradeDurationUnit,
      prediction: check.contract.barrier ?? null,
      symbol: this.symbol,
      contractId: this.activeContractId,
      confidence: number(
        check.decision.professionalScore ?? check.decision.confidence
      ),
      marketQuality: number(check.decision.marketQuality),
      riskLevel: String(check.decision.riskLevel || "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â"),
      entryStage: String(check.timing.state || "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â"),
      votes: number(check.decision.passedCount),
      martingaleStep: this.state.martingaleStep,
      executionMode: check.mode || "V12_DEEP_CYCLE_AI",
      historicalHitRate: number(check.decision.historicalHitRate),
      historicalLowerBound: number(check.decision.historicalLowerBound),
      deepScore: number(check.decision.deepScore),
      deepConsensus: number(check.decision.deepConsensus),
      deepRegime: String(check.decision.deepRegime || "UNKNOWN"),
      cyclePeriod: number(check.decision.cyclePeriod),
      fastLane: Boolean(check.decision.fastLane),
      deepOverride: Boolean(check.decision.deepOverride),
    });

    this.activeContractId = "";
    this.lastTradeAt = now;
    this.pendingSetupKey = "";
    this.pendingSignalCount = 0;
    this.pendingSignalSince = 0;
    this.pendingSignalVersion = 0;
    this.lastSignalVersionKey = "";
    this.lastSignalTickKey = "";
    this.scanTickCount = 0;
    this.scanWindow += 1;
    this.lockedCandidate = null;
    this.lockedCandidateTick = 0;
    this.lockedSignalVersion = 0;
    this.strictSetupKey = "";
    this.strictConfirmations = 0;
    this.executionPhase = "SCAN";

    this.patch({
      status: won ? "WON" : "LOST",
      message: `${won ? "Won" : "Lost"} ${profit.toFixed(2)} ${
        this.currency
      }. Run ${runs}/${this.settings.maxRuns}.${
        won
          ? " Waiting for a new confirmed setup."
          : ` ${setup} is now blocked on this market.`
      }`,
      runs,
      wins,
      losses,
      profit: totalProfit,
      totalStake,
      totalPayout,
      consecutiveLosses,
      lossesSinceWin,
      currentWinStreak,
      largestWinStreak,
      largestLossStreak,
      martingaleStep,
      currentStake: Math.max(0.35, Number(nextStake.toFixed(2))),
      activeContractId: "",
      scanStartedAt: Date.now(),
      scanElapsedSeconds: 0,
      scanTicks: 0,
      maxScanTicks: this.settings.maxScanTicks,
      scanWindow: this.scanWindow,
      fallbackTrades: this.state.fallbackTrades,
      signalConfirmations: 0,
      requiredConfirmations: number(
        check.requiredConfirmations,
        this.settings.confirmationCount
      ),
      blockedSetupUntil,
      lastLossSetup: this.lastLossSetup || "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      lossProtectionCount,
      lastBlockReason: won
        ? ""
        : `Loss protection: ${setup} blocked on ${this.symbol}.`,
      executionPhase: "SCAN",
      lockedCandidate: "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â",
      signalVersion: this.signalVersion,
      lockedSignalVersion: 0,
    });

    const finalStop = this.riskStopReason();

    if (finalStop) {
      this.stop(finalStop.message, finalStop.status);
      return;
    }

    if (
      !won &&
      consecutiveLosses >= this.settings.cooldownAfterLosses
    ) {
      const cooldownUntil =
        Date.now() + this.settings.cooldownSeconds * 1000;

      this.patch({
        status: "RISK_COOLDOWN",
        message:
          `Loss protection active. Cooling down for ${this.settings.cooldownSeconds}s and blocking ${setup} on this market.`,
        cooldownUntil,
      });
    }
  }

  waitForContract(contractId, duration = 5, durationUnit = "t") {
    const estimatedMilliseconds =
      durationUnit === "s"
        ? Math.max(120000, (number(duration, 30) + 120) * 1000)
        : 120000;

    const timeoutMilliseconds = Math.min(
      estimatedMilliseconds,
      2 * 60 * 60 * 1000
    );

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.contractWaiters.delete(String(contractId));
        reject(
          new Error(
            `Timed out while waiting for ${durationText(
              duration,
              durationUnit
            )} contract settlement.`
          )
        );
      }, timeoutMilliseconds);

      this.contractWaiters.set(String(contractId), {
        resolve,
        reject,
        timeout,
      });
    });
  }

  handleContractUpdate(contract) {
    const contractId = String(
      contract.contract_id || contract.id || contract.contractId || ""
    );

    if (!contractId || !isFinished(contract)) return;

    const waiter = this.contractWaiters.get(contractId);

    if (!waiter) return;

    window.clearTimeout(waiter.timeout);
    this.contractWaiters.delete(contractId);
    waiter.resolve(contract);
  }
}
