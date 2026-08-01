export default function ProfessionalDecisionPanel({
  decision,
}) {
  const rows = [
    ["Trend", decision?.checks?.trend],
    ["Momentum", decision?.checks?.momentum],
    ["Support / Resistance", decision?.checks?.supportResistance],
    ["Digit Pressure", decision?.checks?.digitPressure],
    ["Volatility", decision?.checks?.volatility],
    ["Pattern", decision?.checks?.pattern],
    ["Historical", decision?.checks?.historical],
  ];

  return (
    <section
      className={
        decision?.validated
          ? "professionalDecision valid"
          : "professionalDecision"
      }
    >
      <div className="professionalTop">
        <div>
          <small>PROFESSIONAL DECISION ENGINE</small>
          <h2>{decision?.status || "NO TRADE"}</h2>
          <p>{decision?.reason || "Waiting for data"}</p>
        </div>

        <div className="professionalSetup">
          <span>SETUP</span>
          <strong>{decision?.setup || "WAIT"}</strong>
          <b>{Number(decision?.confidence || 0).toFixed(1)}%</b>
        </div>
      </div>

      <div className="professionalChecks">
        {rows.map(([label, item]) => (
          <article
            key={label}
            className={item?.passed ? "professionalCheck passed" : "professionalCheck"}
          >
            <div>
              <span>{label}</span>
              <b>{item?.passed ? "PASS" : "FAIL"}</b>
            </div>

            <strong>{Number(item?.score || 0).toFixed(0)}%</strong>
            <p>{item?.detail || "Waiting for data"}</p>
          </article>
        ))}
      </div>

      <div className="professionalFooter">
        <span>
          Votes: {decision?.passedCount || 0}/{decision?.totalChecks || 7}
        </span>

        <b>
          {decision?.validated
            ? "WAIT FOR ENTRY TIMING"
            : "SKIP THIS SETUP"}
        </b>
      </div>
    </section>
  );
}
