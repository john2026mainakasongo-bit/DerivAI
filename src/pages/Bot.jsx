import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";

export default function Bot() {
  return (
    <div className="appShell">
      <Sidebar />
      <main className="mainContent">
        <Topbar
          title="Auto Bot"
          subtitle="Configure trade execution and risk controls"
        />

        <section className="botPanel">
          <h2>Bot Configuration</h2>

          <div className="formGrid">
            <label>
              Contract
              <select>
                <option>Rise / Fall</option>
                <option>Even / Odd</option>
                <option>Over / Under</option>
                <option>Matches / Differs</option>
              </select>
            </label>

            <label>
              Base stake
              <input type="number" defaultValue="1" min="0.35" />
            </label>

            <label>
              Duration
              <input type="number" defaultValue="5" min="1" max="10" />
            </label>

            <label>
              Minimum confidence
              <input type="number" defaultValue="85" min="50" max="99" />
            </label>

            <label>
              Take profit
              <input type="number" defaultValue="20" min="0" />
            </label>

            <label>
              Stop loss
              <input type="number" defaultValue="10" min="0" />
            </label>
          </div>

          <button className="primaryButton">Start Demo Bot</button>
        </section>
      </main>
    </div>
  );
}
