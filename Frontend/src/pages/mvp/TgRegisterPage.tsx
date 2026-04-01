// src/pages/ZZNEW/TgRegisterPage.tsx
// Telegram -> Wallet registration page
// Clean single-column collapsible flow, no sidebar clutter.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider } from "ethers";
import { QRCodeSVG } from "qrcode.react";
import { useAppKit, useAppKitAccount, useAppKitProvider } from "../../config";
import { useApiBase } from "../../ApiBaseContext";

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

type StepKey =
  | "telegram_start"
  | "wallet_connect"
  | "wallet_sign"
  | "web_confirm"
  | "telegram_finish";

function shortAddr(a?: string) {
  const s = (a || "").trim();
  if (!s) return "";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function decodeJwtSub(token: string) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return "";
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return String(json?.sub || "");
  } catch {
    return "";
  }
}

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

function readQueryParams(): URLSearchParams {
  const s = window.location.search || "";
  if (s && s.includes("=")) return new URLSearchParams(s);

  const h = window.location.hash || "";
  const idx = h.indexOf("?");
  if (idx !== -1) return new URLSearchParams(h.slice(idx + 1));

  return new URLSearchParams();
}

function copyText(text: string) {
  return navigator.clipboard.writeText(text);
}

function buildTelegramStartUrl(baseUrl: string, payload: string) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const p = encodeURIComponent(String(payload || "").trim());
  if (!base || !p) return base;
  return `${base}?start=${p}`;
}

function StepStatusIcon({
  done,
  active,
  locked,
}: {
  done?: boolean;
  active?: boolean;
  locked?: boolean;
}) {
  if (done) return <div className="u-step-icon done">✓</div>;
  if (active) return <div className="u-step-icon active">•</div>;
  if (locked) return <div className="u-step-icon locked">🔒</div>;
  return <div className="u-step-icon">•</div>;
}

export default function TgRegisterPage() {
  const apiBaseRaw = useApiBase() as any;
  const apiBase =
    (typeof apiBaseRaw === "string"
      ? apiBaseRaw
      : (apiBaseRaw?.apiBase as string | undefined) || ""
    ).replace(/\/+$/, "");

  const { open } = useAppKit();
  const { address: appkitAddress, isConnected } = useAppKitAccount();
  const { walletProvider: appkitWalletProvider } = useAppKitProvider("eip155");

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || "");
  const [walletProvider, setWalletProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState<string>("");

  const [moduleId, setModuleId] = useState<string>("tg");
  const [code, setCode] = useState<string>("");

  const [statusFriendly, setStatusFriendly] = useState("");
  const [errorText, setErrorText] = useState("");

  const [linkStatus, setLinkStatus] = useState<LinkStatusResp | null>(null);
  const [webConfirmSubmitted, setWebConfirmSubmitted] = useState(false);

  const [openStep, setOpenStep] = useState<StepKey>("telegram_start");
  const [showQr, setShowQr] = useState(false);

  const jwtSub = useMemo(() => decodeJwtSub(jwt), [jwt]);
  const hasWalletJwt = useMemo(() => /^0x[a-fA-F0-9]{40}$/.test(jwtSub), [jwtSub]);

  const connectedWalletLabel = account || (hasWalletJwt ? jwtSub : "");
  const currentWalletDisplay =
    account ||
    (linkStatus?.pendingWallet as string) ||
    (linkStatus?.linkedWallet as string) ||
    (linkStatus?.wallet as string) ||
    (linkStatus?.address as string) ||
    "";

  const authHeaders = useMemo(
    () => (jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    [jwt]
  );

  const pageUrl = useMemo(() => window.location.href, []);
  const botRegisterUrl = useMemo(
    () => buildTelegramStartUrl(TELEGRAM_BOT_URL, "register"),
    []
  );
  const botApproveUrl = useMemo(
    () => buildTelegramStartUrl(TELEGRAM_BOT_URL, "approve"),
    []
  );

  const telegramStartedDone = !!code;
  const walletConnectedDone = !!connectedWalletLabel;
  const walletSignedDone = hasWalletJwt;

  const statusState = String(linkStatus?.state || linkStatus?.status || "").toLowerCase();

  const webConfirmedDone =
    webConfirmSubmitted ||
    statusState.includes("confirmed") ||
    statusState.includes("approved") ||
    statusState.includes("linked") ||
    statusState.includes("done");

  const telegramFinishedDone =
    statusState.includes("approved") ||
    statusState.includes("linked") ||
    statusState.includes("done");

  const readyToUse =
    telegramStartedDone &&
    walletConnectedDone &&
    walletSignedDone &&
    webConfirmedDone;

  const setToastMsg = useCallback((s: string) => {
    setToast(s);
    window.setTimeout(() => setToast(""), 4500);
  }, []);

  async function apiJson(path: string, init?: RequestInit) {
    if (!apiBase) throw buildApiError("API base missing.");

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

  useEffect(() => {
    if (!isConnected || !appkitWalletProvider) {
      setWalletProvider(null);
      setAccount("");
      return;
    }

    (async () => {
      try {
        const bp = new BrowserProvider(appkitWalletProvider as any);
        setWalletProvider(bp);
        setAccount(appkitAddress || "");
      } catch {
        setWalletProvider(null);
        setAccount("");
      }
    })();
  }, [isConnected, appkitWalletProvider, appkitAddress]);

  useEffect(() => {
    const apply = () => {
      const params = readQueryParams();
      const mid = (params.get("moduleId") || "tg").trim();
      const c = (params.get("code") || "").trim();

      setModuleId(mid || "tg");
      setCode(c);

      if (!c) {
        setOpenStep("telegram_start");
        return;
      }

      if (telegramFinishedDone) {
        setOpenStep("telegram_finish");
        return;
      }

      if (webConfirmedDone) {
        setOpenStep("telegram_finish");
        return;
      }

      if (walletSignedDone) {
        setOpenStep("web_confirm");
        return;
      }

      if (walletConnectedDone) {
        setOpenStep("wallet_sign");
        return;
      }

      setOpenStep("wallet_connect");
    };

    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [walletConnectedDone, walletSignedDone, webConfirmedDone, telegramFinishedDone]);

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
      } catch {
        // ignore
      }
    }

    void tryReconnectWallet();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshTelegramLinkStatus = useCallback(async () => {
    setErrorText("");
    if (!code) return;
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
        setStatusFriendly("Telegram link complete.");
        setOpenStep("telegram_finish");
        return;
      }

      if (state.includes("confirmed")) {
        setWebConfirmSubmitted(true);
        setStatusFriendly("Wallet confirmed on web. Open Telegram approve to finish.");
        setOpenStep("telegram_finish");
      }
    } catch (e: any) {
      if (e?.status === 401) {
        setLinkStatus(null);
        setStatusFriendly("Wallet session expired. Sign in again.");
        return;
      }
      setErrorText(e?.message || "Failed to refresh Telegram link status.");
    }
  }, [authHeaders, code, jwt, moduleId]);

  useEffect(() => {
    if (apiBase && code && jwt) {
      void refreshTelegramLinkStatus();
    }
  }, [apiBase, code, jwt, refreshTelegramLinkStatus]);

  useEffect(() => {
    if (telegramFinishedDone) {
      setOpenStep("telegram_finish");
      return;
    }
    if (webConfirmedDone) {
      setOpenStep("telegram_finish");
      return;
    }
    if (walletSignedDone && code) {
      setOpenStep("web_confirm");
      return;
    }
    if (walletConnectedDone && code) {
      setOpenStep("wallet_sign");
      return;
    }
    if (code) {
      setOpenStep("wallet_connect");
      return;
    }
    setOpenStep("telegram_start");
  }, [code, telegramFinishedDone, walletConnectedDone, walletSignedDone, webConfirmedDone]);

  function openTelegramRegister() {
    window.open(botRegisterUrl, "_blank", "noopener,noreferrer");
  }

  function openTelegramApprove() {
    window.open(botApproveUrl, "_blank", "noopener,noreferrer");
  }

  function openWalletConnect() {
    open?.();
  }

  async function signWalletSession() {
    if (!walletProvider) return setToastMsg("Connect wallet first.");
    if (!account) return setToastMsg("No wallet account found.");

    setBusy(true);
    setErrorText("");
    setStatusFriendly("");

    try {
      const addr = account.toLowerCase();

      const nonceResp = await apiJson("/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address: addr }),
      });

      const nonce = String(nonceResp?.nonce || "");
      if (!nonce) throw new Error("Nonce missing.");

      const signer = await walletProvider.getSigner();
      const sig = await signer.signMessage(`THE HAUS LOGIN\n\nAddress: ${addr}\nNonce: ${nonce}`);

      const verifyResp = await apiJson("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address: addr, signature: sig }),
      });

      const tokenJwt: string =
        verifyResp?.token || verifyResp?.jwt || verifyResp?.data?.token || verifyResp?.data?.jwt;

      if (!tokenJwt || typeof tokenJwt !== "string") {
        throw new Error("Verify response missing jwt.");
      }

      localStorage.setItem(LS_JWT, tokenJwt);
      setJwt(tokenJwt);
      setStatusFriendly("Wallet session signed.");
      setOpenStep("web_confirm");
    } catch (e: any) {
      setErrorText(e?.message || "Wallet sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmTelegramLink() {
    if (!jwt) return setToastMsg("Sign wallet session first.");
    if (!code) return setToastMsg("Missing Telegram code.");
    if (!hasWalletJwt) return setToastMsg("Wallet session not active.");

    setBusy(true);
    setErrorText("");
    setStatusFriendly("");

    try {
      const resp = await apiJson("/me/tg/link/confirm", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({ moduleId, code }),
      });

      setLinkStatus(resp || null);
      setWebConfirmSubmitted(true);
      setStatusFriendly("Wallet confirmed. Final step: open Telegram approve to finish.");
      setOpenStep("telegram_finish");

      window.setTimeout(() => {
        void refreshTelegramLinkStatus();
      }, 150);
    } catch (e: any) {
      const msg = e?.message || "Failed to confirm Telegram link.";
      setErrorText(msg);
    } finally {
      setBusy(false);
    }
  }

  function clearSession() {
    localStorage.removeItem(LS_JWT);
    setJwt("");
    setLinkStatus(null);
    setWebConfirmSubmitted(false);
    setErrorText("");
    setStatusFriendly("Wallet session cleared.");
    setOpenStep(code ? "wallet_connect" : "telegram_start");
  }

  return (
    <div className="setup-page">
      <div className="setup-wrap">
        <div className="setup-shell">
          <div className="setup-head">
            <h1>Telegram Link</h1>
            <p>Start in Telegram register, connect your wallet, confirm on web, then open Telegram approve to finish.</p>
          </div>

          <div className="setup-main-grid single-column">
            <div className="setup-primary">
              <div className="step-stack">
                <div className={`step-card ${openStep === "telegram_start" ? "open" : ""}`}>
                  <button className="step-head-btn" onClick={() => setOpenStep("telegram_start")}>
                    <div className="step-head-left">
                      <StepStatusIcon
                        done={telegramStartedDone}
                        active={openStep === "telegram_start" && !telegramStartedDone}
                      />
                      <div>
                        <div className="step-title">Start in Telegram register</div>
                        <div className="step-sub">
                          Open the bot using the register deep link so Telegram starts your one-time registration flow.
                        </div>
                      </div>
                    </div>
                    <div className="step-chevron">{openStep === "telegram_start" ? "−" : "+"}</div>
                  </button>

                  {openStep === "telegram_start" && (
                    <div className="step-body">
                      <div className="step-note">
                        This flow starts in Telegram, not on the website. Open the bot with the register link below. That should run the bot start payload for <b>register</b>, which then creates your one-time link.
                      </div>

                      <button
                        className="btn btn-primary btn-full-mobile"
                        onClick={openTelegramRegister}
                        disabled={busy}
                      >
                        Open Telegram Register
                      </button>

                      <button
                        className="btn btn-secondary btn-full-mobile"
                        onClick={() => setShowQr((s) => !s)}
                        disabled={busy}
                      >
                        {showQr ? "Hide Register QR" : "Show Register QR"}
                      </button>

                      {showQr ? (
                        <div className="qr-wrap">
                          <div className="qr-box">
                            <QRCodeSVG value={botRegisterUrl} size={220} />
                          </div>

                          <div className="url-box">{botRegisterUrl}</div>

                          <button
                            className="btn btn-soft btn-full-mobile"
                            onClick={() => void copyText(botRegisterUrl).then(() => setToastMsg("Register link copied."))}
                          >
                            Copy Register Link
                          </button>
                        </div>
                      ) : null}

                      <div className="value-box">
                        {code ? `Telegram code detected: ${code}` : "No Telegram register code detected yet"}
                      </div>

                      {telegramStartedDone ? (
                        <button
                          className="btn btn-soft btn-full-mobile"
                          onClick={() => setOpenStep("wallet_connect")}
                        >
                          Next: Connect Wallet
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div
                  className={`step-card ${openStep === "wallet_connect" ? "open" : ""} ${
                    !telegramStartedDone ? "locked" : ""
                  }`}
                >
                  <button
                    className="step-head-btn"
                    onClick={() => telegramStartedDone && setOpenStep("wallet_connect")}
                  >
                    <div className="step-head-left">
                      <StepStatusIcon
                        done={walletConnectedDone}
                        active={openStep === "wallet_connect" && !walletConnectedDone}
                        locked={!telegramStartedDone}
                      />
                      <div>
                        <div className="step-title">Connect wallet</div>
                        <div className="step-sub">
                          Connect with extension, wallet app, or WalletConnect QR.
                        </div>
                      </div>
                    </div>
                    <div className="step-chevron">{openStep === "wallet_connect" ? "−" : "+"}</div>
                  </button>

                  {openStep === "wallet_connect" && telegramStartedDone && (
                    <div className="step-body">
                      <div className="step-note">
                        No browser extension? Open the wallet modal anyway and use your phone wallet.
                      </div>

                      <button
                        className="btn btn-primary btn-full-mobile"
                        onClick={openWalletConnect}
                        disabled={busy}
                      >
                        Connect Wallet
                      </button>

                      <div className="value-box">
                        {connectedWalletLabel ? shortAddr(connectedWalletLabel) : "Not connected yet"}
                      </div>

                      {walletConnectedDone ? (
                        <button
                          className="btn btn-soft btn-full-mobile"
                          onClick={() => setOpenStep("wallet_sign")}
                        >
                          Next: Sign Wallet Session
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div
                  className={`step-card ${openStep === "wallet_sign" ? "open" : ""} ${
                    !walletConnectedDone ? "locked" : ""
                  }`}
                >
                  <button
                    className="step-head-btn"
                    onClick={() => walletConnectedDone && setOpenStep("wallet_sign")}
                  >
                    <div className="step-head-left">
                      <StepStatusIcon
                        done={walletSignedDone}
                        active={openStep === "wallet_sign" && !walletSignedDone}
                        locked={!walletConnectedDone}
                      />
                      <div>
                        <div className="step-title">Sign wallet session</div>
                        <div className="step-sub">Prove ownership of the connected wallet.</div>
                      </div>
                    </div>
                    <div className="step-chevron">{openStep === "wallet_sign" ? "−" : "+"}</div>
                  </button>

                  {openStep === "wallet_sign" && walletConnectedDone && (
                    <div className="step-body">
                      <button
                        className={`btn ${walletSignedDone ? "btn-success" : "btn-primary"} btn-full-mobile`}
                        onClick={() => void signWalletSession()}
                        disabled={busy}
                      >
                        {walletSignedDone ? "Wallet Signed" : "Sign Wallet Session"}
                      </button>

                      {walletSignedDone ? (
                        <button
                          className="btn btn-soft btn-full-mobile"
                          onClick={() => setOpenStep("web_confirm")}
                        >
                          Next: Confirm on Web
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div
                  className={`step-card ${openStep === "web_confirm" ? "open" : ""} ${
                    !walletSignedDone ? "locked" : ""
                  }`}
                >
                  <button
                    className="step-head-btn"
                    onClick={() => walletSignedDone && setOpenStep("web_confirm")}
                  >
                    <div className="step-head-left">
                      <StepStatusIcon
                        done={webConfirmedDone}
                        active={openStep === "web_confirm" && !webConfirmedDone}
                        locked={!walletSignedDone}
                      />
                      <div>
                        <div className="step-title">Confirm wallet on web</div>
                        <div className="step-sub">
                          Match this wallet to the Telegram request code.
                        </div>
                      </div>
                    </div>
                    <div className="step-chevron">{openStep === "web_confirm" ? "−" : "+"}</div>
                  </button>

                  {openStep === "web_confirm" && walletSignedDone && (
                    <div className="step-body">
                      <div className="value-box">
                        Module: {moduleId || "tg"}
                        <br />
                        Code: {code || "Missing"}
                        <br />
                        Wallet: {currentWalletDisplay ? shortAddr(currentWalletDisplay) : shortAddr(connectedWalletLabel) || "—"}
                      </div>

                      <button
                        className={`btn ${webConfirmedDone ? "btn-success" : "btn-primary"} btn-full-mobile`}
                        onClick={() => void confirmTelegramLink()}
                        disabled={busy || !code || !hasWalletJwt}
                      >
                        {webConfirmedDone ? "Wallet Confirmed" : "Confirm Wallet"}
                      </button>

                      {webConfirmedDone ? (
                        <button
                          className="btn btn-soft btn-full-mobile"
                          onClick={() => setOpenStep("telegram_finish")}
                        >
                          Next: Open Telegram Approve
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div
                  className={`step-card ${openStep === "telegram_finish" ? "open" : ""} ${
                    !webConfirmedDone ? "locked" : ""
                  }`}
                >
                  <button
                    className="step-head-btn"
                    onClick={() => webConfirmedDone && setOpenStep("telegram_finish")}
                  >
                    <div className="step-head-left">
                      <StepStatusIcon
                        done={telegramFinishedDone}
                        active={openStep === "telegram_finish" && !telegramFinishedDone}
                        locked={!webConfirmedDone}
                      />
                      <div>
                        <div className="step-title">Return to Telegram approve</div>
                        <div className="step-sub">
                          Open the bot approve deep link so Telegram runs the approve flow and finishes the link.
                        </div>
                      </div>
                    </div>
                    <div className="step-chevron">{openStep === "telegram_finish" ? "−" : "+"}</div>
                  </button>

                  {openStep === "telegram_finish" && (
                    <div className="step-body">
                      <button
                        className="btn btn-primary btn-full-mobile"
                        onClick={openTelegramApprove}
                      >
                        Open Telegram Approve
                      </button>

                      <div className="url-box">{botApproveUrl}</div>

                      <button
                        className="btn btn-soft btn-full-mobile"
                        onClick={() => void copyText(botApproveUrl).then(() => setToastMsg("Approve link copied."))}
                      >
                        Copy Approve Link
                      </button>

                      <button
                        className="btn btn-secondary btn-full-mobile"
                        onClick={() => void refreshTelegramLinkStatus()}
                        disabled={busy || !jwt || !code}
                      >
                        Refresh Link Status
                      </button>

                      <div className="success-panel">
                        <div className="success-title">
                          {telegramFinishedDone ? "Telegram link complete" : "Final Telegram step"}
                        </div>
                        <div className="success-sub">
                          {telegramFinishedDone
                            ? "Your Telegram account is now linked to this wallet."
                            : "Your wallet is confirmed on the website. Open Telegram approve to finish."}
                        </div>
                      </div>

                      <button
                        className="btn btn-soft btn-full-mobile"
                        onClick={() => void copyText(pageUrl).then(() => setToastMsg("Page link copied."))}
                        disabled={!code}
                      >
                        Copy This Page Link
                      </button>

                      <button
                        className="btn btn-soft btn-full-mobile"
                        onClick={clearSession}
                        disabled={busy}
                      >
                        Clear Wallet Session
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {!!statusFriendly ? <div className="toast-bar success">{statusFriendly}</div> : null}
              {!!errorText ? <div className="toast-bar error">{errorText}</div> : null}
              {!!toast ? <div className="toast-bar">{toast}</div> : null}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .setup-page {
          min-height: 100vh;
          background:
            radial-gradient(1200px 600px at 10% 10%, rgba(232,65,66,0.14), transparent 60%),
            radial-gradient(1200px 600px at 90% 0%, rgba(255,107,107,0.12), transparent 55%),
            #0b0a0f;
          color: rgba(255,255,255,0.92);
          padding: 18px 12px 28px;
          box-sizing: border-box;
        }

        .setup-wrap {
          max-width: 1120px;
          margin: 0 auto;
        }

        .setup-shell {
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 24px;
          padding: 18px;
          background: rgba(255,255,255,0.05);
          backdrop-filter: blur(12px);
        }

        .setup-head {
          text-align: center;
          margin-bottom: 18px;
        }

        .setup-head h1 {
          margin: 0 0 8px;
          font-size: clamp(2rem, 4vw, 3.6rem);
          line-height: 1.02;
          font-weight: 900;
          letter-spacing: -0.03em;
        }

        .setup-head p {
          margin: 0;
          color: rgba(255,255,255,0.72);
          font-size: clamp(1rem, 1.8vw, 1.15rem);
          line-height: 1.45;
        }

        .setup-main-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 16px;
          align-items: start;
        }

        .setup-main-grid.single-column {
          max-width: 760px;
          margin: 0 auto;
        }

        .setup-primary {
          min-width: 0;
        }

        .step-stack {
          display: grid;
          gap: 12px;
        }

        .step-card {
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 20px;
          background: rgba(0,0,0,0.22);
          overflow: hidden;
        }

        .step-card.locked {
          opacity: 0.8;
        }

        .step-card.open {
          border-color: rgba(45,125,210,0.45);
          box-shadow: 0 0 0 1px rgba(45,125,210,0.18) inset;
        }

        .step-head-btn {
          width: 100%;
          border: 0;
          background: transparent;
          color: inherit;
          padding: 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          cursor: pointer;
          text-align: left;
        }

        .step-head-left {
          display: flex;
          gap: 12px;
          align-items: flex-start;
          min-width: 0;
        }

        .step-title {
          font-size: 1.08rem;
          font-weight: 900;
          line-height: 1.15;
          margin-bottom: 4px;
        }

        .step-sub {
          color: rgba(255,255,255,0.68);
          line-height: 1.45;
          font-size: 0.95rem;
        }

        .step-chevron {
          font-size: 1.4rem;
          font-weight: 900;
          color: rgba(255,255,255,0.78);
          flex: 0 0 auto;
        }

        .u-step-icon {
          width: 34px;
          height: 34px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.05);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 900;
          flex: 0 0 auto;
        }

        .u-step-icon.done {
          background: rgba(37,165,95,0.2);
          border-color: rgba(37,165,95,0.35);
          color: rgba(185,255,210,0.96);
        }

        .u-step-icon.active {
          background: rgba(45,125,210,0.18);
          border-color: rgba(45,125,210,0.35);
          color: #8dc2ff;
        }

        .u-step-icon.locked {
          color: rgba(255,255,255,0.55);
        }

        .step-body {
          padding: 0 14px 14px;
          display: grid;
          gap: 12px;
        }

        .step-note {
          padding: 12px;
          border-radius: 14px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.1);
          color: rgba(255,255,255,0.76);
          line-height: 1.45;
          font-size: 0.95rem;
        }

        .btn {
          border: 0;
          border-radius: 14px;
          padding: 13px 16px;
          font-size: 1rem;
          font-weight: 900;
          cursor: pointer;
          transition: opacity 0.18s ease, transform 0.06s ease, filter 0.18s ease;
        }

        .btn:hover:not(:disabled) {
          filter: brightness(1.04);
        }

        .btn:active:not(:disabled) {
          transform: translateY(1px);
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn-primary {
          background: #2d7dd2;
          color: #fff;
        }

        .btn-success {
          background: #25a55f;
          color: #fff;
        }

        .btn-secondary {
          background: rgba(255,255,255,0.04);
          color: #fff;
          border: 1px solid rgba(255,255,255,0.12);
        }

        .btn-soft {
          background: rgba(255,255,255,0.08);
          color: #fff;
          border: 1px solid rgba(255,255,255,0.12);
        }

        .value-box,
        .url-box {
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.04);
          border-radius: 14px;
          padding: 12px 14px;
          line-height: 1.45;
          color: rgba(255,255,255,0.88);
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .qr-wrap {
          display: grid;
          gap: 12px;
          padding-top: 4px;
        }

        .qr-box {
          background: #fff;
          padding: 12px;
          border-radius: 18px;
          width: fit-content;
          margin: 0 auto;
          max-width: 100%;
        }

        .success-panel {
          border: 1px solid rgba(37,165,95,0.35);
          background: rgba(37,165,95,0.14);
          border-radius: 16px;
          padding: 14px;
        }

        .success-title {
          font-size: 1rem;
          font-weight: 900;
          margin-bottom: 6px;
        }

        .success-sub {
          color: rgba(255,255,255,0.82);
          line-height: 1.5;
        }

        .toast-bar {
          margin-top: 14px;
          padding: 12px 14px;
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.05);
          font-weight: 800;
          line-height: 1.45;
        }

        .toast-bar.success {
          border-color: rgba(37,165,95,0.35);
          background: rgba(37,165,95,0.14);
        }

        .toast-bar.error {
          border-color: rgba(239,68,68,0.35);
          background: rgba(239,68,68,0.14);
        }

        @media (max-width: 640px) {
          .setup-page {
            padding: 10px 8px 22px;
          }

          .setup-shell {
            padding: 12px;
            border-radius: 18px;
          }

          .step-head-btn {
            padding: 12px;
          }

          .step-body {
            padding: 0 12px 12px;
          }

          .step-title {
            font-size: 1rem;
          }

          .step-sub {
            font-size: 0.9rem;
          }

          .btn-full-mobile {
            width: 100%;
          }

          .qr-box svg {
            width: min(72vw, 220px);
            height: min(72vw, 220px);
          }
        }
      `}</style>
    </div>
  );
}
