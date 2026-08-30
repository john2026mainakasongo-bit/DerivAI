export default function SignalCard({ title, signal, confidence, detail }) {
  const ready = signal !== "WAIT";

  return (
    <article className={ready ? "signalCard ready" : "signalCard"}>
      <div className="signalTop">
        <span>{title}</span>
        <strong>{ready ? `${confidence}%` : "WAIT"}</strong>
      </div>

      <h3>{signal}</h3>
      <p>{detail}</p>
    </article>
  );
}
