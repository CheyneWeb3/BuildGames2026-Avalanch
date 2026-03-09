// src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { ApiBaseProvider } from "./ApiBaseContext";
import "./config";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApiBaseProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </ApiBaseProvider>
  </React.StrictMode>
);
