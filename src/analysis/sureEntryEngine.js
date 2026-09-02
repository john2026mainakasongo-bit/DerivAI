function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function setupOf(candidate) {
  return String(candidate?.setup || candidate?.action || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function familyOf(setup = "") {
  if (setup === "EVEN" || setup === "ODD") return "PARITY";
  if (setup.startsWith("OVER") || setup.startsWith("UNDER")) return "OVER_UNDER";
  if (setup.startsWith("DIFFERS") || setup.startsWith("MATCH")) return "MATCH_DIFFERS";
  return "OTHER";
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sameSetup(left, right) {
  return setupOf(left) && setupOf(left) === setupOf(right);
}

function signalStrength(candidate) {
  return clamp(
    finite(candidate?.confidence ?? candidate?.qualityScore) * 0.55 +
    finite(candidate?.probability) * 0.25 +
    finite(candidate?.edge ?? candidate?.probabilityEdge) * 2 * 0.20
  );
}

/**
 * High-confluence entry gate.
 *
 * It intentionally does not claim a guaranteed win. It only allows execution
 * when the short rapid window, the independent deep window, and the calibrated
 * unified model all agree on the exact contract setup.
 */
export function buildSureEntry({ rapid30, rapid60, unified, snapshot } = {}) {
  const primary = rapid30?.best || rapid30?.candidate || null;
  const secondary = rapid60?.best || rapid60?.candidate || null;
  const deep = unified?.digit?.best || null;

  const primarySetup = setupOf(primary);
  const secondarySetup = setupOf(secondary);
  const deepSetup = setupOf(deep);
  const sampleSize = Array.isArray(snapshot?.digitHistory)
    ? snapshot.digitHistory.length
    : 0;

  const checks = {
    primaryReady: Boolean(rapid30?.executable && rapid30?.best),
    secondaryReady: Boolean(rapid60?.executable && rapid60?.best),
    deepReady: Boolean(unified?.digit?.executable && deep),
    exactAgreement: Boolean(
      primarySetup &&
      sameSetup(primary, secondary) &&
      sameSetup(primary, deep)
    ),
    enoughHistory: sampleSize >= 100,
    freshMarket: Boolean(snapshot?.currentPrice != null),
  };

  const votes = Object.values(checks).filter(Boolean).length;
  const executable = Object.values(checks).every(Boolean);

  if (!executable) {
    const blocked = [];
    if (!checks.primaryReady) blocked.push("RAPID_30S");
    if (!checks.secondaryReady) blocked.push("RAPID_60S");
    if (!checks.deepReady) blocked.push("DEEP_MODEL");
    if (!checks.exactAgreement) {
      blocked.push(
        `AGREEMENT_${primarySetup || "WAIT"}/${secondarySetup || "WAIT"}/${deepSetup || "WAIT"}`
      );
    }
    if (!checks.enoughHistory) blocked.push(`HISTORY_${sampleSize}/100`);
    if (!checks.freshMarket) blocked.push("NO_LIVE_PRICE");

    return {
      executable: false,
      status: "WAIT",
      reason: `SURE ENTRY WAIT: ${blocked.join(" | ")}`,
      checks,
      votes,
      requiredVotes: 6,
      setup: primarySetup || "WAIT",
      candidate: primary || null,
      confidence: finite(primary?.confidence ?? primary?.qualityScore),
      probability: finite(primary?.probability),
      edge: finite(primary?.edge ?? primary?.probabilityEdge),
      sampleSize,
    };
  }

  const confidence = Math.min(
    finite(primary.confidence ?? primary.qualityScore),
    finite(secondary.confidence ?? secondary.qualityScore),
    finite(deep.confidence ?? deep.qualityScore)
  );
  const probability = Math.min(
    finite(primary.probability),
    finite(secondary.probability),
    finite(deep.probability)
  );
  const edge = Math.min(
    finite(primary.edge ?? primary.probabilityEdge),
    finite(secondary.edge ?? secondary.probabilityEdge),
    finite(deep.edge ?? deep.probabilityEdge)
  );

  const confluenceScore = clamp(
    Math.min(
      signalStrength(primary),
      signalStrength(secondary),
      signalStrength(deep)
    ) + 8
  );

  const candidate = {
    ...primary,
    setup: primarySetup,
    action: primary.action || primarySetup,
    confidence,
    qualityScore: confidence,
    probability,
    edge,
    score: Math.max(finite(primary.score), finite(deep.qualityScore), confluenceScore),
    samples: Math.min(finite(primary.samples, rapid30.sampleSize), finite(secondary.samples, rapid60.sampleSize)),
    transitionCount: Math.min(
      finite(primary.transitionCount),
      finite(secondary.transitionCount),
      finite(deep.transitionSamples)
    ),
    passedVotes: Math.min(
      finite(primary.passedVotes),
      finite(secondary.passedVotes),
      finite(deep.voteCount)
    ),
    requiredVotes: 2,
    rapidEntry: true,
    sureEntry: true,
    sureEntryScore: confluenceScore,
    sureEntryChecks: checks,
    sureEntrySources: [
      `RAPID_${rapid30.timeframeSeconds || 30}S`,
      `RAPID_${rapid60.timeframeSeconds || 60}S`,
      deep.source || "UNIFIED",
    ],
  };

  return {
    executable: true,
    status: "READY",
    reason: `SURE ENTRY READY: ${primarySetup} | 30s + 60s + deep model agree | confluence ${confluenceScore.toFixed(1)}%`,
    checks,
    votes,
    requiredVotes: 6,
    setup: primarySetup,
    candidate,
    confidence,
    probability,
    edge,
    sampleSize,
    confluenceScore,
    family: familyOf(primarySetup),
  };
}

export default buildSureEntry;
