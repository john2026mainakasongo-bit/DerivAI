import React from "react";
import ReactDOM from "react-dom/client";

import { DerivAuthProvider } from "./auth/DerivAuthContext";
import App from "./App";

import "./index.css";
import "./clean.css";

ReactDOM.createRoot(
  document.getElementById("root")
).render(
  <React.StrictMode>
    <DerivAuthProvider>
      <App />
    </DerivAuthProvider>
  </React.StrictMode>
);
