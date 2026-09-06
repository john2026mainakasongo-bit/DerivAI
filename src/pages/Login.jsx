import { useNavigate } from "react-router-dom";

export default function Login() {
  const navigate = useNavigate();

  return (
    <main className="loginPage">
      <section className="loginCard">
        <div className="brandMark large">E</div>
        <h1>EdgePilot Trader</h1>
        <p>Independent third-party trading assistant</p>

        <button onClick={() => navigate("/dashboard")}>
          Continue to Demo
        </button>
      </section>
    </main>
  );
}
