function numberOr(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function lastDigit(snapshot) {
  const history = Array.isArray(
    snapshot?.digitHistory
  )
    ? snapshot.digitHistory
    : [];

  if (history.length) {
    const digit = Number(history.at(-1));

    if (
      Number.isInteger(digit) &&
      digit >= 0 &&
      digit <= 9
    ) {
      return digit;
    }
  }

  const price = Number(
    snapshot?.currentPrice ??
      snapshot?.price
  );

  if (Number.isFinite(price)) {
    const digits = String(price).replace(
      /\D/g,
      ""
    );

    if (digits) {
      return Number(digits.at(-1));
    }
  }

  return null;
}

function actionOf(signal) {
  return String(
    signal?.action ||
      signal?.candidate ||
      "WAIT"
  )
    .trim()
    .toUpperCase();
}

function bestValidated(validated) {
  if (!validated) return null;

  if (validated.best?.approved) {
    return validated.best;
  }

  const signals = Array.isArray(
    validated.signals
  )
    ? validated.signals
    : [];

  return (
    signals
      .filter(
        (signal) =>
          signal?.approved &&
          actionOf(signal) !== "WAIT"
      )
      .sort(
        (a, b) =>
          numberOr(b.lowerBound) -
            numberOr(a.lowerBound) ||
          numberOr(b.edge) -
            numberOr(a.edge) ||
          numberOr(b.samples) -
            numberOr(a.samples)
      )[0] || null
  );
}

function preferredOverTrigger(
  snapshot,
  barrier = 2
) {
  const history = Array.isArray(
    snapshot?.digitHistory
  )
    ? snapshot.digitHistory
    : [];

  const recent = history
    .slice(-40)
    .map(Number)
    .filter(
      (digit) =>
        Number.isInteger(digit) &&
        digit >= 0 &&
        digit <= 9
    );

  const count = (digit) =>
    recent.filter(
      (value) => value === digit
    ).length;

  const triggers = [barrier];

  if (count(5) >= 3) {
    triggers.push(5);
  }

  return [...new Set(triggers)];
}

function preferredUnderTrigger(
  snapshot
) {
  const history = Array.isArray(
    snapshot?.digitHistory
  )
    ? snapshot.digitHistory
    : [];

  const recent = history
    .slice(-40)
    .map(Number)
    .filter(
      (digit) =>
        Number.isInteger(digit) &&
        digit >= 0 &&
        digit <= 9
    );

  const count = (digit) =>
    recent.filter(
      (value) => value === digit
    ).length;

  const triggers = [7];

  if (count(5) >= 3) {
    triggers.push(5);
  }

  return [...new Set(triggers)];
}

function triggerState(signal, snapshot) {
  const action = actionOf(signal);
  const currentDigit = lastDigit(snapshot);

  if (
    !signal ||
    !signal.approved ||
    action === "WAIT"
  ) {
    return {
      state: "SKIP",
      setup: "—",
      triggerDigits: [],
      triggerText:
        "No validated setup yet",
      currentDigit,
      readyNow: false,
      instruction:
        "WAIT. Do not enter until a validated setup appears.",
    };
  }

  if (action === "OVER 2") {
    const triggerDigits =
      preferredOverTrigger(snapshot, 2);

    const readyNow =
      triggerDigits.includes(currentDigit);

    return {
      state: readyNow
        ? "ENTER NOW"
        : "WAIT FOR TRIGGER",
      setup: "OVER 2",
      triggerDigits,
      triggerText:
        `Enter only after last digit touches ${triggerDigits.join(" or ")}`,
      currentDigit,
      readyNow,
      instruction: readyNow
        ? `Trigger digit ${currentDigit} touched. Enter OVER 2 on the next tick.`
        : `Wait for ${triggerDigits.join(" or ")}. When one prints, enter OVER 2 on the next tick.`,
    };
  }

  if (action === "UNDER 2") {
    const triggerDigits =
      preferredUnderTrigger(snapshot);

    const readyNow =
      triggerDigits.includes(currentDigit);

    return {
      state: readyNow
        ? "ENTER NOW"
        : "WAIT FOR TRIGGER",
      setup: "UNDER 2",
      triggerDigits,
      triggerText:
        `Enter only after last digit touches ${triggerDigits.join(" or ")}`,
      currentDigit,
      readyNow,
      instruction: readyNow
        ? `Trigger digit ${currentDigit} touched. Enter UNDER 2 on the next tick.`
        : `Wait for ${triggerDigits.join(" or ")}. When one prints, enter UNDER 2 on the next tick.`,
    };
  }

  if (action.startsWith("MATCH ")) {
    const target = Number(
      action.split(/\s+/)[1]
    );

    const triggerDigits =
      Number.isInteger(target)
        ? [target]
        : [];

    const readyNow =
      triggerDigits.includes(currentDigit);

    return {
      state: readyNow
        ? "ENTER NOW"
        : "WAIT FOR TRIGGER",
      setup: action,
      triggerDigits,
      triggerText:
        triggerDigits.length
          ? `Enter only after last digit touches ${target}`
          : "Wait for the selected match digit",
      currentDigit,
      readyNow,
      instruction: readyNow
        ? `Digit ${target} touched. Enter MATCH ${target} on the next tick.`
        : `Wait for digit ${target}, then enter MATCH ${target} on the next tick.`,
    };
  }

  if (action.startsWith("DIFFERS ")) {
    const target = Number(
      action.split(/\s+/)[1]
    );

    const triggerDigits =
      Number.isInteger(target)
        ? [target]
        : [];

    const readyNow =
      triggerDigits.includes(currentDigit);

    return {
      state: readyNow
        ? "ENTER NOW"
        : "WAIT FOR TRIGGER",
      setup: action,
      triggerDigits,
      triggerText:
        triggerDigits.length
          ? `Enter only after last digit touches ${target}`
          : "Wait for the selected differs digit",
      currentDigit,
      readyNow,
      instruction: readyNow
        ? `Digit ${target} touched. Enter DIFFERS ${target} on the next tick.`
        : `Wait for digit ${target}, then enter DIFFERS ${target} on the next tick.`,
    };
  }

  if (
    action === "EVEN" ||
    action === "ODD"
  ) {
    const wantsEven =
      action === "EVEN";

    const currentParity =
      currentDigit == null
        ? null
        : currentDigit % 2 === 0
        ? "EVEN"
        : "ODD";

    const resetParity =
      wantsEven ? "ODD" : "EVEN";

    const readyNow =
      currentParity === resetParity;

    return {
      state: readyNow
        ? "ENTER NOW"
        : "WAIT FOR RESET",
      setup: action,
      triggerDigits: [],
      triggerText:
        `Wait for one ${resetParity} digit first`,
      currentDigit,
      readyNow,
      instruction: readyNow
        ? `${resetParity} reset printed. Enter ${action} on the next tick.`
        : `Wait for one ${resetParity} digit, then enter ${action} on the next tick.`,
    };
  }

  if (
    action === "RISE" ||
    action === "FALL"
  ) {
    return {
      state: "ENTER NOW",
      setup: action,
      triggerDigits: [],
      triggerText:
        "Enter on the next confirmed feed tick",
      currentDigit,
      readyNow: true,
      instruction:
        `Validated ${action}. Enter on the next confirmed tick.`,
    };
  }

  return {
    state: "WAIT",
    setup: action,
    triggerDigits: [],
    triggerText:
      "Wait for confirmation",
    currentDigit,
    readyNow: false,
    instruction:
      "Wait for confirmation before entry.",
  };
}

export function buildEntryTiming(
  validatedSignals,
  snapshot,
  options = {}
) {
  const tradeTicks = Math.max(
    1,
    Math.min(
      10,
      Math.floor(
        numberOr(
          options.tradeTicks,
          5
        )
      )
    )
  );

  const best = bestValidated(
    validatedSignals
  );

  const base = triggerState(
    best,
    snapshot
  );

  const validitySeconds = Math.max(
    5,
    Math.min(
      60,
      Math.floor(
        numberOr(
          options.validitySeconds,
          15
        )
      )
    )
  );

  return {
    ...base,
    tradeTicks,
    tradeDuration:
      `${tradeTicks} tick${tradeTicks === 1 ? "" : "s"}`,
    validitySeconds,
    validityLabel:
      validitySeconds >= 60
        ? `${Math.round(validitySeconds / 60)} min`
        : `${validitySeconds} sec`,
  };
}
