// src/pages/ZZNEW/TgRegisterPage.tsx
// Telegram -> Wallet registration page (secure two-step bind).
// HashRouter-safe: supports URLs like:
//   https://yourapp/#/tg/register?moduleId=tg&code=399012

import React, { useEffect, useMemo, useState } from "react";
import { BrowserProvider } from "ethers";
import { useApiBase } from "../../ApiBaseContext"; // correct path from src/pages/ZZNEW
import "./VaultAdminPage.css"; // reuse existing base styles

const LS_JWT = "haus_user_jwt";
const TELEGRAM_BOT_URL = "https://t.me/TheHausAvaxFujiMvpBot";

type LinkStatusResp = {
  ok?: boolean;
  moduleId?: string;
  code?: string;
  state?: string;
  status?: string;
  pendingWallet?: string;
  linkedWallet?: string;
  wallet?: string;
  address?: string;
  [k: string]: any;
};

type ApiError = Error & {
  status?: number;
  data?: any;
};

type FlowState =
  | "missing_params"
  | "need_wallet"
  | "need_login"
  | "ready_to_confirm"
  | "confirmed_step1"
  | "done"
  | "error";

function readResponseSafeTextToJson(txt: string) {
  try {
    return txt ? JSON.parse(txt) : null;
  } catch {
    return txt ? { raw: txt } : null;
  }
}

function buildApiError(message: string, status?: number, data?: any): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  e.data = data;
  return e;
}

function shortAddr(a?: string) {
  if (!a) return "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function readQueryParams(): URLSearchParams {
  const s = window.location.search || "";
  if (s && s.includes("=")) return new URLSearchParams(s);

  const h = window.location.hash || "";
  const idx = h.indexOf("?");
  if (idx !== -1) return new URLSearchParams(h.slice(idx + 1));

  return new URLSearchParams();
}

function getStepIndex(flowState: FlowState, hasWallet: boolean, hasJwt: boolean) {
  if (flowState === "missing_params") return 0;
  if (flowState === "done" || flowState === "confirmed_step1") return 4;
  if (!hasWallet) return 1;
  if (!hasJwt) return 2;
  return 3;
}

function stepLabel(step: number) {
  if (step <= 1) return "Connect Wallet";
  if (step === 2) return "Sign In";
  if (step === 3) return "Confirm Wallet";
  return "Finish in Telegram";
}

export default function TgRegisterPage() {
  // Handles both possible return shapes from your context:
  // - string api base
  // - object { apiBase }
  const apiBaseCtx = useApiBase() as any;
  const resolvedApiBase =
    typeof apiBaseCtx === "string"
      ? apiBaseCtx
      : (apiBaseCtx?.apiBase as string | undefined) || "";

  const apiBase = (resolvedApiBase || "").replace(/\/+$/, "");

  const [busy, setBusy] = useState(false);

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || "");
  const [walletProvider, setWalletProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState<string>("");

  const [moduleId, setModuleId] = useState<string>("tg");
  const [code, setCode] = useState<string>("");

  const [statusFriendly, setStatusFriendly] = useState<string>("");
  const [errorText, setErrorText] = useState<string>("");

  const [linkStatus, setLinkStatus] = useState<LinkStatusResp | null>(null);

  const [flowState, setFlowState] = useState<FlowState>("need_wallet");

  const authHeaders = useMemo(
    () => (jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    [jwt]
  );

  async function apiJson(path: string, init?: RequestInit) {
    if (!apiBase) {
      throw buildApiError("API base is missing (resolver not ready).");
    }

    const url = `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;

    const r = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });

    const txt = await r.text();
    const data = readResponseSafeTextToJson(txt);

    if (!r.ok) {
      const msg = data?.error || data?.message || data?.raw || `${r.status} ${r.statusText}`;
      throw buildApiError(String(msg), r.status, data);
    }

    return data;
  }

  async function refreshLinkStatus() {
    setErrorText("");
    if (!code) return;

    // Status endpoint requires JWT (based on your server behavior).
    if (!jwt) {
      setLinkStatus(null);
      return;
    }

    try {
      const qs = new URLSearchParams({ moduleId, code }).toString();
      const data = await apiJson(`/me/tg/link/status?${qs}`, {
        method: "GET",
        headers: authHeaders as any,
      });

      setLinkStatus(data);

      const state = String(data?.state || data?.status || "").toLowerCase();
      if (state.includes("done") || state.includes("approved") || state.includes("linked")) {
        setFlowState("done");
        setStatusFriendly("Link complete. Your Telegram account is linked to this wallet.");
      } else if (state.includes("confirmed")) {
        setFlowState("confirmed_step1");
        setStatusFriendly("Wallet confirmed on web. Final step: return to Telegram and run /approve.");
      }
    } catch (e: any) {
      if (e?.status === 401) {
        setLinkStatus(null);
        setErrorText("");
        setStatusFriendly("Wallet session expired. Please sign in again.");
        setFlowState(account ? "need_login" : "need_wallet");
        return;
      }
      setErrorText(e?.message || "Failed to fetch link status.");
    }
  }

  // Read params on mount + hash changes
  useEffect(() => {
    const apply = () => {
      const params = readQueryParams();
      const mid = (params.get("moduleId") || "tg").trim();
      const c = (params.get("code") || "").trim();

      setModuleId(mid || "tg");
      setCode(c);

      if (!c) {
        setFlowState("missing_params");
        setStatusFriendly("Missing one-time code. Open this page from the Telegram bot /register link.");
      } else {
        setStatusFriendly("");
        setFlowState((prev) => (prev === "done" ? "done" : "need_wallet"));
      }
    };

    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  // Try to restore connected wallet silently (better UX)
  useEffect(() => {
    let cancelled = false;

    async function tryReconnectWallet() {
      try {
        const eth = (window as any).ethereum;
        if (!eth) return;

        const bp = new BrowserProvider(eth);
        const accounts: string[] = await bp.send("eth_accounts", []);
        if (!accounts?.length) return;

        const signer = await bp.getSigner();
        const addr = await signer.getAddress();
        if (cancelled) return;

        setWalletProvider(bp);
        setAccount(addr);

        if (jwt) setFlowState("ready_to_confirm");
        else setFlowState("need_login");
      } catch {
        // silent
      }
    }

    tryReconnectWallet();
    return () => {
      cancelled = true;
    };
  }, [jwt]);

  // Refresh status when everything is ready
  useEffect(() => {
    if (apiBase && code && jwt) {
      refreshLinkStatus().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, code, jwt]);

  async function connectWallet() {
    setStatusFriendly("");
    setErrorText("");

    if (!(window as any).ethereum) {
      setErrorText("No wallet detected. Open in MetaMask/wallet browser.");
      return;
    }

    setBusy(true);
    try {
      const bp = new BrowserProvider((window as any).ethereum);
      await bp.send("eth_requestAccounts", []);
      const signer = await bp.getSigner();
      const addr = await signer.getAddress();

      setWalletProvider(bp);
      setAccount(addr);

      if (jwt) {
        setFlowState("ready_to_confirm");
        setStatusFriendly("Wallet connected. You can confirm now.");
      } else {
        setFlowState("need_login");
        setStatusFriendly("Wallet connected. Next step: sign in.");
      }
    } catch (e: any) {
      setErrorText(e?.message || "Failed to connect wallet.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithWallet() {
    setStatusFriendly("");
    setErrorText("");

    if (!walletProvider) {
      setErrorText("Connect wallet first.");
      return;
    }

    setBusy(true);
    try {
      const signer = await walletProvider.getSigner();
      const addr = await signer.getAddress();

      const nonceResp = await apiJson("/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address: addr }),
      });

      const message: string =
        nonceResp?.message ||
        nonceResp?.nonce ||
        nonceResp?.data?.message ||
        nonceResp?.data?.nonce;

      if (!message || typeof message !== "string") {
        throw buildApiError("Nonce response missing message/nonce.");
      }

      const signature = await signer.signMessage(message);

      const verifyResp = await apiJson("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address: addr, signature }),
      });

      const tokenJwt: string =
        verifyResp?.token ||
        verifyResp?.jwt ||
        verifyResp?.data?.token ||
        verifyResp?.data?.jwt;

      if (!tokenJwt || typeof tokenJwt !== "string") {
        throw buildApiError("Verify response missing jwt/token.");
      }

      localStorage.setItem(LS_JWT, tokenJwt);
      setJwt(tokenJwt);

      setFlowState("ready_to_confirm");
      setStatusFriendly("Signed in successfully. Next step: confirm wallet.");
    } catch (e: any) {
      setErrorText(e?.message || "Wallet sign-in failed.");
      setFlowState("error");
    } finally {
      setBusy(false);
    }
  }

  function clearSession() {
    localStorage.removeItem(LS_JWT);
    setJwt("");
    setLinkStatus(null);
    setErrorText("");
    setStatusFriendly("Local wallet session cleared.");
    setFlowState(account ? "need_login" : "need_wallet");
  }

  async function confirmTelegramLink() {
    setStatusFriendly("");
    setErrorText("");

    if (!jwt) {
      setErrorText("Sign in first.");
      setFlowState("need_login");
      return;
    }
    if (!code) {
      setErrorText("Missing code. Open this page from the Telegram /register link.");
      setFlowState("missing_params");
      return;
    }

    setBusy(true);
    try {
      const resp = await apiJson("/me/tg/link/confirm", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({ moduleId, code }),
      });

      setLinkStatus(resp || null);
      setFlowState("confirmed_step1");
      setStatusFriendly("Wallet confirmed. Final step: go back to Telegram and run /approve.");

      setTimeout(() => {
        refreshLinkStatus().catch(() => {});
      }, 100);
    } catch (e: any) {
      const msg = e?.message || "Failed to confirm link.";
      setErrorText(msg);

      if (String(msg).toUpperCase().includes("BAD_CODE")) {
        setStatusFriendly("This code is invalid / expired / already used. Open a fresh /register link from Telegram.");
      }

      setFlowState("error");
    } finally {
      setBusy(false);
    }
  }

  const currentWalletDisplay =
    account ||
    (linkStatus?.pendingWallet as string) ||
    (linkStatus?.linkedWallet as string) ||
    (linkStatus?.wallet as string) ||
    (linkStatus?.address as string) ||
    "—";

  const currentStep = getStepIndex(flowState, !!account, !!jwt);

  const canConnect = !busy && flowState !== "missing_params";
  const canSignIn = !busy && !!account;
  const canConfirm = !busy && !!account && !!jwt && !!code;

  // Single primary action (reduces button chaos)
  const primaryAction = (() => {
    if (flowState === "missing_params") {
      return {
        label: "Open from Telegram /register link",
        onClick: () => window.open(TELEGRAM_BOT_URL, "_blank", "noopener,noreferrer"),
        disabled: false,
      };
    }
    if (!account) {
      return { label: busy ? "Connecting..." : "Connect Wallet", onClick: connectWallet, disabled: !canConnect };
    }
    if (!jwt) {
      return { label: busy ? "Signing In..." : "Sign In with Wallet", onClick: signInWithWallet, disabled: !canSignIn };
    }
    if (flowState !== "confirmed_step1" && flowState !== "done") {
      return { label: busy ? "Confirming..." : "Confirm Wallet (Step 1)", onClick: confirmTelegramLink, disabled: !canConfirm };
    }
    return {
      label: "Open Telegram Bot (Finish /approve)",
      onClick: () => window.open(TELEGRAM_BOT_URL, "_blank", "noopener,noreferrer"),
      disabled: false,
    };
  })();

  const stateText =
    flowState === "missing_params"
      ? "Waiting for Telegram link code"
      : flowState === "need_wallet"
      ? "Connect wallet to begin"
      : flowState === "need_login"
      ? "Sign in with wallet"
      : flowState === "ready_to_confirm"
      ? "Ready to confirm wallet"
      : flowState === "confirmed_step1"
      ? "Web step complete — finish in Telegram"
      : flowState === "done"
      ? "Registration complete"
      : "Action needed";

  const alreadyLinkedToDifferentWallet = (() => {
    const statusWallet =
      (linkStatus?.linkedWallet ||
        linkStatus?.pendingWallet ||
        linkStatus?.wallet ||
        linkStatus?.address) as string | undefined;

    if (!statusWallet || !account) return false;
    return statusWallet.toLowerCase() !== account.toLowerCase();
  })();

  return (
    <div className="va-page">
      <style>{`
        .tgreg-wrap {
          max-width: 980px;
          margin: 0 auto;
        }
        .tgreg-stack {
          display: grid;
          gap: 14px;
        }
        .tgreg-card {
          background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 14px;
          padding: 14px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        }
        .tgreg-hero {
          padding: 16px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.10);
          background: radial-gradient(circle at top right, rgba(59,130,246,0.12), rgba(255,255,255,0.02));
        }
        .tgreg-title {
          font-size: 1.35rem;
          font-weight: 800;
          line-height: 1.2;
          margin-bottom: 6px;
          color: #f8fbff;
        }
        .tgreg-sub {
          color: #c8d9ff;
          line-height: 1.4;
          font-size: 0.95rem;
        }
        .tgreg-stepper {
          display: grid;
          grid-template-columns: repeat(4, minmax(0,1fr));
          gap: 8px;
          margin-top: 14px;
        }
        .tgreg-step {
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.09);
          padding: 10px 8px;
          text-align: center;
          background: rgba(255,255,255,0.015);
        }
        .tgreg-step.active {
          border-color: rgba(96,165,250,0.55);
          background: rgba(59,130,246,0.16);
          box-shadow: inset 0 0 0 1px rgba(96,165,250,0.25);
        }
        .tgreg-step.done {
          border-color: rgba(34,197,94,0.45);
          background: rgba(34,197,94,0.12);
        }
        .tgreg-step-num {
          font-size: 0.8rem;
          opacity: 0.9;
          margin-bottom: 4px;
        }
        .tgreg-step-name {
          font-size: 0.82rem;
          font-weight: 700;
          line-height: 1.15;
        }

        .tgreg-main {
          display: grid;
          grid-template-columns: 1.15fr 0.85fr;
          gap: 14px;
        }

        .tgreg-panelTitle {
          font-size: 1rem;
          font-weight: 800;
          margin-bottom: 10px;
          color: #fff;
        }

        .tgreg-detailGrid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-bottom: 12px;
        }

        .tgreg-field {
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 10px;
          background: rgba(255,255,255,0.015);
          padding: 10px;
        }
        .tgreg-fieldLabel {
          font-size: 0.78rem;
          color: #b7c8ee;
          margin-bottom: 6px;
          font-weight: 600;
        }
        .tgreg-fieldValue {
          color: #fff;
          font-weight: 700;
          word-break: break-all;
        }
        .tgreg-input {
          width: 100%;
          background: #0b1b52;
          color: #fff;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px;
          padding: 10px 12px;
          font-weight: 600;
          outline: none;
        }

        .tgreg-statePill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border-radius: 999px;
          padding: 8px 12px;
          font-weight: 700;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.02);
          margin-bottom: 12px;
          color: #eef4ff;
        }
        .tgreg-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #60a5fa;
          display: inline-block;
        }
        .tgreg-dot.ok { background: #22c55e; }
        .tgreg-dot.warn { background: #f59e0b; }
        .tgreg-dot.err { background: #ef4444; }

        .tgreg-primaryBtn {
          width: 100%;
          border: 0;
          border-radius: 12px;
          padding: 14px 16px;
          font-weight: 800;
          font-size: 1rem;
          cursor: pointer;
          color: #fff;
          background: linear-gradient(180deg, #2563eb, #1d4ed8);
          box-shadow: 0 8px 20px rgba(37,99,235,0.35);
        }
        .tgreg-primaryBtn:disabled {
          opacity: 0.55;
          cursor: not-allowed;
          box-shadow: none;
        }

        .tgreg-secondaryRow {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-top: 10px;
        }
        .tgreg-ghostBtn, .tgreg-dangerBtn {
          width: 100%;
          border-radius: 10px;
          padding: 11px 12px;
          font-weight: 700;
          cursor: pointer;
          background: rgba(255,255,255,0.02);
        }
        .tgreg-ghostBtn {
          color: #dbeafe;
          border: 1px solid rgba(255,255,255,0.12);
        }
        .tgreg-dangerBtn {
          color: #fbbf24;
          border: 1px solid rgba(245,158,11,0.45);
        }
        .tgreg-ghostBtn:disabled, .tgreg-dangerBtn:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }

        .tgreg-msg {
          margin-top: 12px;
          border-radius: 10px;
          padding: 12px 13px;
          border: 1px solid rgba(255,255,255,0.12);
          line-height: 1.35;
          font-weight: 600;
          word-break: break-word;
        }
        .tgreg-msg.info {
          background: rgba(37,99,235,0.12);
          border-color: rgba(96,165,250,0.28);
          color: #eaf2ff;
        }
        .tgreg-msg.error {
          background: rgba(127, 29, 29, 0.18);
          border-color: rgba(248,113,113,0.28);
          color: #ffd4d4;
        }
        .tgreg-msg.success {
          background: rgba(22,163,74,0.14);
          border-color: rgba(74,222,128,0.28);
          color: #dcfce7;
        }
        .tgreg-msg.warn {
          background: #f3eadb;
          border-color: #c08a25;
          color: #2b1d0e;
        }

        .tgreg-list {
          margin: 0;
          padding-left: 18px;
          line-height: 1.55;
        }
        .tgreg-list li + li { margin-top: 6px; }

        .tgreg-sideBlock + .tgreg-sideBlock {
          margin-top: 12px;
        }

        .tgreg-kv {
          display: grid;
          grid-template-columns: 120px 1fr;
          gap: 8px 10px;
          align-items: start;
        }
        .tgreg-kvLabel {
          color: #b7c8ee;
          font-size: 0.86rem;
          font-weight: 600;
        }
        .tgreg-kvValue {
          color: #fff;
          font-weight: 700;
          word-break: break-word;
        }
        .tgreg-mono {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 0.88rem;
        }

        @media (max-width: 900px) {
          .tgreg-main {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 640px) {
          .tgreg-stepper {
            grid-template-columns: 1fr 1fr;
          }
          .tgreg-detailGrid {
            grid-template-columns: 1fr;
          }
          .tgreg-secondaryRow {
            grid-template-columns: 1fr;
          }
          .tgreg-kv {
            grid-template-columns: 1fr;
            gap: 4px;
          }
        }
      `}</style>

      <div className="tgreg-wrap">
        <div className="tgreg-stack">
          {/* HERO / HEADER */}
          <section className="tgreg-hero">
            <div className="tgreg-title">Telegram Wallet Registration</div>
            <div className="tgreg-sub">
              Link your Telegram account to your wallet in a secure two-step flow.
              First confirm on this page, then finish inside the Telegram bot with <b>/approve</b>.
            </div>

            <div className="tgreg-stepper" aria-label="Registration steps">
              {[1, 2, 3, 4].map((n) => {
                const cls =
                  n < currentStep
                    ? "tgreg-step done"
                    : n === currentStep
                    ? "tgreg-step active"
                    : "tgreg-step";
                return (
                  <div key={n} className={cls}>
                    <div className="tgreg-step-num">Step {n}</div>
                    <div className="tgreg-step-name">{stepLabel(n)}</div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* MAIN TWO COLUMN LAYOUT */}
          <section className="tgreg-main">
            {/* LEFT: Action flow */}
            <div className="tgreg-card">


              <div
                className="tgreg-statePill"
                title={stateText}
              >
                <span
                  className={`tgreg-dot ${
                    errorText ? "err" : flowState === "done" || flowState === "confirmed_step1" ? "ok" : currentStep >= 3 ? "warn" : ""
                  }`}
                />
                <span>{stateText}</span>
              </div>

              <div className="tgreg-field" style={{ marginBottom: 12 }}>
                <div className="tgreg-fieldLabel">Wallet</div>
                <div className="tgreg-fieldValue tgremono">
                  {currentWalletDisplay === "—"
                    ? "Not connected yet"
                    : account
                    ? `(${shortAddr(account)})`
                    : currentWalletDisplay}
                </div>
                <div
                  style={{
                    marginTop: 8,
                    color: jwt ? "#4ade80" : "#93c5fd",
                    fontWeight: 700,
                    fontSize: "0.92rem",
                  }}
                >
                  {jwt
                    ? "Wallet session is active on this device."
                    : "Wallet session not active yet (sign in required)."}
                </div>
              </div>

              <button
                type="button"
                className="tgreg-primaryBtn"
                onClick={primaryAction.onClick}
                disabled={primaryAction.disabled}
              >
                {primaryAction.label}
              </button>

              <div className="tgreg-secondaryRow">
                <button
                  type="button"
                  className="tgreg-ghostBtn"
                  onClick={() => window.open(TELEGRAM_BOT_URL, "_blank", "noopener,noreferrer")}
                  disabled={busy}
                >
                  Open Telegram Bot
                </button>

                <button
                  type="button"
                  className="tgreg-ghostBtn"
                  onClick={() => refreshLinkStatus()}
                  disabled={busy || !code || !jwt}
                  title={!jwt ? "Sign in first to check status" : "Refresh link status"}
                >
                  Refresh Status
                </button>

                <button
                  type="button"
                  className="tgreg-dangerBtn"
                  onClick={clearSession}
                  disabled={busy}
                  style={{ gridColumn: "1 / -1" }}
                >
                  Clear Wallet Session
                </button>
              </div>

              {!!statusFriendly && (
                <div
                  className={`tgreg-msg ${
                    flowState === "done" || flowState === "confirmed_step1" ? "success" : "info"
                  }`}
                >
                  {statusFriendly}
                </div>
              )}

              {!!errorText && <div className="tgreg-msg error">{errorText}</div>}

              {alreadyLinkedToDifferentWallet && (
                <div className="tgreg-msg warn">
                  This code appears tied to a different wallet. For security, re-linking should be handled by admin reset/manual flow.
                </div>
              )}

              <div className="tgreg-msg warn">
                <b>Two-step security flow:</b>
                <div style={{ marginTop: 6 }}>
                  1) Confirm wallet on this page
                </div>
                <div>
                  2) Return to Telegram bot and run <b>/approve</b>
                </div>
              </div>
            </div>

            {/* RIGHT: Support / status */}
            <div>
              <div className="tgreg-card tgreg-sideBlock">
                <div className="tgreg-panelTitle">What to do now</div>
                <ol className="tgreg-list">
                  <li>
                    <b>Connect Wallet</b> (this page)
                  </li>
                  <li>
                    <b>Sign In with Wallet</b> (creates your local wallet session)
                  </li>
                  <li>
                    <b>Confirm Wallet (Step 1)</b> (binds wallet to the Telegram request)
                  </li>
                  <li>
                    Go back to Telegram and run <b>/approve</b> to finish
                  </li>
                </ol>
              </div>

              <div className="tgreg-card tgreg-sideBlock">
                <div className="tgreg-panelTitle">Link Status</div>
                <div className="tgreg-kv">
                  <div className="tgreg-kvLabel">API Base</div>
                  <div className="tgreg-kvValue tgreg-mono">
                    {apiBase || "— (resolver not ready / missing)"}
                  </div>

                  <div className="tgreg-kvLabel">Module</div>
                  <div className="tgreg-kvValue tgreg-mono">{moduleId || "—"}</div>

                  <div className="tgreg-kvLabel">Code</div>
                  <div className="tgreg-kvValue tgreg-mono">{code || "—"}</div>

                  <div className="tgreg-kvLabel">Server State</div>
                  <div className="tgreg-kvValue tgreg-mono">
                    {String(linkStatus?.state || linkStatus?.status || "—")}
                  </div>

                  <div className="tgreg-kvLabel">Linked / Pending Wallet</div>
                  <div className="tgreg-kvValue tgreg-mono">
                    {String(
                      linkStatus?.pendingWallet ||
                        linkStatus?.linkedWallet ||
                        linkStatus?.wallet ||
                        linkStatus?.address ||
                        "—"
                    )}
                  </div>
                </div>
              </div>

              <div className="tgreg-card tgreg-sideBlock">

              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}



//
// <div className="tgreg-panelTitle">Bind Wallet</div>
//
// <div className="tgreg-detailGrid">
//   <div className="tgreg-field">
//     <div className="tgreg-fieldLabel">Module ID</div>
//     <input
//       value={moduleId}
//       onChange={(e) => setModuleId(e.target.value)}
//       className="tgreg-input"
//     />
//   </div>
//   <div className="tgreg-field">
//     <div className="tgreg-fieldLabel">Link Code</div>
//     <input
//       value={code}
//       onChange={(e) => setCode(e.target.value)}
//       className="tgreg-input"
//     />
//   </div>
// </div>

//   <div className="tgreg-panelTitle">Why this is secure</div>
  // <ul className="tgreg-list">
  //   <li>Someone with only the code cannot finish without your wallet sign-in/signature.</li>
  //   <li>Someone with only wallet access still cannot finish without Telegram bot approval.</li>
  //   <li>The Telegram bot performs the final approval step.</li>
  // </ul>
