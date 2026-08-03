
import { rankV66FastProfessional } from "./v66FastProfessionalEngine";
import {
  analyzeRiseFall,
} from "./v67UnifiedAnalysisEngine";

function riskFromCandidate(candidate = {}) {
  const confidence = Number(candidate.qualityScore || candidate.confidence || 0);
  if (candidate.executable && confidence >= 82) return "GOOD ENTRY";
  if (confidence >= 70) return "RISKY";
  return "DO NOT TRADE";
}

function triggerDigits(mode, digit) {
  if (mode === "OVER") {
    return Array.from({ length: Number(digit) + 1 }, (_, value) => value);
  }

  if (mode === "UNDER") {
    return Array.from(
      { length: Math.max(0, 9 - Number(digit)) },
      (_, index) => Number(digit) + 1 + index
    );
  }

  return [];
}

function normalizeDigitCandidate(candidate = {}) {
  const risk = riskFromCandidate(candidate);
  const triggers = triggerDigits(candidate.mode, candidate.digit);

  return {
    ...candidate,
    confidence: Number(candidate.qualityScore || candidate.confidence || 0),
    stability: Number(candidate.consistency || candidate.stability || 0),
    risk,
    triggerDigits: triggers,
    triggerText:
      triggers.length > 0
        ? `Wait for a trigger digit (${triggers.join(", ")}), then re-confirm ${candidate.setup}.`
        : "Enter only while the same live signal remains confirmed.",
  };
}

export function analyzeUnifiedSignals({
  digitHistory = [],
  prices = [],
  currentPrice = null,
  allowHighRisk = false,
  minimumConfidence = 78,
} = {}) {
  const rawDigit = rankV66FastProfessional({
    digitHistory,
    allowHighRisk,
    minimumConfidence,
  });

  const candidates = (rawDigit.candidates || []).map(normalizeDigitCandidate);
  const best =
    candidates.find((candidate) => candidate.executable) ||
    null;

  const riseFallRaw = analyzeRiseFall({
    prices,
    currentPrice,
  });

  const alignedTrend =
    (riseFallRaw.signal === "RISE" && riseFallRaw.trend === "UPTREND") ||
    (riseFallRaw.signal === "FALL" && riseFallRaw.trend === "DOWNTREND");

  const riseConfidence = Math.min(
    95,
    Number(riseFallRaw.confidence || 0)
  );

  const riseRisk =
    riseFallRaw.signal !== "WAIT" &&
    alignedTrend &&
    riseConfidence >= 84
      ? "GOOD ENTRY"
      : riseConfidence >= 70
        ? "RISKY"
        : "DO NOT TRADE";

  return {
    generatedAt: Date.now(),
    digit: {
      ...rawDigit,
      candidates,
      best,
      standard: candidates.filter((candidate) => !candidate.highRisk),
      highRisk: candidates.filter((candidate) => candidate.highRisk),
    },
    riseFall: {
      ...riseFallRaw,
      confidence: riseConfidence,
      risk: riseRisk,
      executable:
        riseRisk === "GOOD ENTRY" &&
        riseFallRaw.signal !== "WAIT",
      reason:
        riseRisk === "GOOD ENTRY"
          ? `${riseFallRaw.signal} trend, momentum and price position are aligned.`
          : riseFallRaw.instruction ||
            "Waiting for trend and momentum alignment.",
    },
  };
}
