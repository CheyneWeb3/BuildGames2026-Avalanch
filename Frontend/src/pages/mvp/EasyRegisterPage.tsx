import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider } from "ethers";
import { QRCodeSVG } from "qrcode.react";
import { useAppKit, useAppKitAccount, useAppKitProvider } from "../../config";
import { useApiBase } from "../../ApiBaseContext";

declare global {
  interface Window {
    google?: any;
  }
}

const LS_JWT = "haus_user_jwt";
const DEFAULT_CASHIER_URL = "https://thehaus-fuji-mvp.netlify.app/#/home";

type GoogleVerifyLinkedResp = {
  ok: true;
  linked: true;
  address: string;
  token: string;
  authProvider?: string;
};

type GoogleVerifyUnlinkedResp = {
  ok: true;
  linked: false;
  googleSub: string;
  email?: string | null;
  name?: string | null;
  googleLinkToken: string;
  expiresAt?: string;
  next?: string;
};

type GoogleLinkStatusResp = {
  ok: boolean;
  ownerWallet: string;
  linked: boolean;
  links: Array<{
    _id: string;
    googleSub: string;
    email?: string | null;
    emailVerified?: boolean;
    name?: string | null;
    picture?: string | null;
    linkedAt?: string | null;
    updatedAt?: string | null;
    lastLoginAt?: string | null;
  }>;
};

function shortAddr(a?: string) {
  const s = (a || "").trim();
  if (!s) return "";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function getCashierUrl() {
  try {
    const u = new URL(window.location.href);
    const qp = u.searchParams.get("cashier");
    if (qp && qp.startsWith("http")) return qp;
  } catch {}

  const envUrl = (import.meta as any).env?.VITE_CASHIER_URL;
  if (envUrl && String(envUrl).startsWith("http")) return String(envUrl);

  return DEFAULT_CASHIER_URL;
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

async function apiJson(base: string, path: string, init?: RequestInit) {
  const b = (base || "").replace(/\/+$/, "");
  const url = `${b}${path}`;

  const r = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const txt = await r.text();
  let data: any = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { raw: txt };
  }

  if (!r.ok) {
    const msg = data?.error || data?.message || data?.raw || `${r.status} ${r.statusText}`;
    throw new Error(String(msg));
  }

  return data;
}

async function ensureGoogleScript() {
  if (window.google?.accounts?.id) return;

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector('script[data-google-gsi="1"]') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed loading Google script")), { once: true });
      return;
    }

    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.dataset.googleGsi = "1";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed loading Google script"));
    document.head.appendChild(s);
  });
}

function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

function copyText(text: string) {
  return navigator.clipboard.writeText(text);
}

type StepKey = "wallet_connect" | "wallet_sign" | "google_verify" | "google_link" | "deposit";

function StepStatusIcon({
  done,
  active,
  locked,
}: {
  done?: boolean;
  active?: boolean;
  locked?: boolean;
}) {
  if (done) {
    return <div className="u-step-icon done">✓</div>;
  }
  if (active) {
    return <div className="u-step-icon active">•</div>;
  }
  if (locked) {
    return <div className="u-step-icon locked">🔒</div>;
  }
  return <div className="u-step-icon">•</div>;
}

export default function EasyRegisterPage() {
  const apiBase = useApiBase();
  const cashierUrl = useMemo(() => getCashierUrl(), []);

  const { open } = useAppKit();
  const { address: appkitAddress, isConnected } = useAppKitAccount();
  const { walletProvider: appkitWalletProvider } = useAppKitProvider("eip155");

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || "");
  const [walletProvider, setWalletProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState<string>("");

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [walletLinkedGoogle, setWalletLinkedGoogle] = useState(false);

  const [googleSub, setGoogleSub] = useState("");
  const [googleEmail, setGoogleEmail] = useState("");
  const [googleName, setGoogleName] = useState("");
  const [googleLinkToken, setGoogleLinkToken] = useState("");

  const [openStep, setOpenStep] = useState<StepKey>("wallet_connect");
  const [showQr, setShowQr] = useState(false);

  const googleBtnRef = useRef<HTMLDivElement | null>(null);
  const googleClientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();

  const jwtSub = useMemo(() => decodeJwtSub(jwt), [jwt]);
  const hasWalletJwt = useMemo(() => /^0x[a-fA-F0-9]{40}$/.test(jwtSub), [jwtSub]);

  const authHeaders = useMemo(
    () => (jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    [jwt]
  );

  const registerUrl = useMemo(() => {
    const base = window.location.origin;
    return `${base}/#/register-wallet-google`;
  }, []);

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
      }
    })();
  }, [isConnected, appkitWalletProvider, appkitAddress]);

  const setToastMsg = useCallback((s: string) => {
    setToast(s);
    window.setTimeout(() => setToast(""), 4500);
  }, []);

  const refreshGoogleLinkStatus = useCallback(
    async (tokenOverride?: string) => {
      const activeJwt = tokenOverride || jwt;
      if (!activeJwt) {
        setWalletLinkedGoogle(false);
        return;
      }

      try {
        const out = (await apiJson(apiBase, "/me/google/link/status", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${activeJwt}`,
          },
        })) as GoogleLinkStatusResp;

        setWalletLinkedGoogle(!!out?.linked || !!out?.links?.length);
      } catch {
        setWalletLinkedGoogle(false);
      }
    },
    [apiBase, jwt]
  );

  async function signWalletSession() {
    if (!walletProvider) return setToastMsg("Connect wallet first.");
    if (!account) return setToastMsg("No wallet account found.");

    setBusy(true);
    try {
      const addr = account.toLowerCase();

      const nonceResp = await apiJson(apiBase, "/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address: addr }),
      });

      const nonce = String(nonceResp?.nonce || "");
      if (!nonce) throw new Error("Nonce missing.");

      const signer = await walletProvider.getSigner();
      const sig = await signer.signMessage(`THE HAUS LOGIN\n\nAddress: ${addr}\nNonce: ${nonce}`);

      const verifyResp = await apiJson(apiBase, "/auth/verify", {
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
      setToastMsg("Wallet connected and signed.");
      setOpenStep("google_verify");
      await refreshGoogleLinkStatus(tokenJwt);
    } catch (e: any) {
      setToastMsg(e?.message ?? "Wallet sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  const handleGoogleCredential = useCallback(
    async (credential: string) => {
      setBusy(true);
      try {
        const out = (await apiJson(apiBase, "/auth/google/verify", {
          method: "POST",
          body: JSON.stringify({ idToken: credential }),
        })) as GoogleVerifyLinkedResp | GoogleVerifyUnlinkedResp;

        if (out.linked) {
          localStorage.setItem(LS_JWT, out.token);
          setJwt(out.token);
          setGoogleSub("");
          setGoogleEmail("");
          setGoogleName("");
          setGoogleLinkToken("");
          setWalletLinkedGoogle(true);
          setOpenStep("deposit");
          setToastMsg(`Google already linked to wallet ${shortAddr(out.address)}.`);
          return;
        }

        setGoogleSub(String(out.googleSub || ""));
        setGoogleEmail(String(out.email || ""));
        setGoogleName(String(out.name || ""));
        setGoogleLinkToken(String(out.googleLinkToken || ""));
        setOpenStep("google_link");
        setToastMsg("Google verified. Finish by linking it to your wallet.");
      } catch (e: any) {
        setToastMsg(e?.message ?? "Google verify failed.");
      } finally {
        setBusy(false);
      }
    },
    [apiBase, setToastMsg]
  );

  useEffect(() => {
    let dead = false;
    let timer: number | null = null;

    async function bootGoogle() {
      if (!googleClientId) {
        setToastMsg("Missing VITE_GOOGLE_CLIENT_ID.");
        return;
      }

      if (openStep !== "google_verify") return;

      try {
        await ensureGoogleScript();
        if (dead) return;
        if (!window.google?.accounts?.id) return;

        timer = window.setTimeout(() => {
          if (dead) return;
          if (!googleBtnRef.current) return;

          googleBtnRef.current.innerHTML = "";

          window.google.accounts.id.initialize({
            client_id: googleClientId,
            callback: (resp: any) => {
              const credential = String(resp?.credential || "").trim();
              if (!credential) {
                setToastMsg("Google returned no credential.");
                return;
              }
              void handleGoogleCredential(credential);
            },
          });

          window.google.accounts.id.renderButton(googleBtnRef.current, {
            type: "standard",
            theme: "outline",
            size: "large",
            shape: "pill",
            text: "continue_with",
            width: 280,
          });
        }, 30);
      } catch (e: any) {
        setToastMsg(e?.message ?? "Failed to boot Google sign-in.");
      }
    }

    void bootGoogle();

    return () => {
      dead = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [openStep, googleClientId, handleGoogleCredential, setToastMsg]);

  useEffect(() => {
    if (!jwt) return;
    void refreshGoogleLinkStatus();
  }, [jwt, refreshGoogleLinkStatus]);

  useEffect(() => {
    if (walletLinkedGoogle) {
      setOpenStep("deposit");
      return;
    }
    if (googleLinkToken) {
      setOpenStep("google_link");
      return;
    }
    if (hasWalletJwt) {
      setOpenStep("google_verify");
      return;
    }
    if (account) {
      setOpenStep("wallet_sign");
      return;
    }
    setOpenStep("wallet_connect");
  }, [account, hasWalletJwt, googleLinkToken, walletLinkedGoogle]);

  async function confirmGoogleLink() {
    if (!googleLinkToken) return setToastMsg("Verify Google first.");
    if (!jwt) return setToastMsg("Sign wallet session first.");
    if (!hasWalletJwt) return setToastMsg("Current session is not wallet-authenticated.");

    setBusy(true);
    try {
      await apiJson(apiBase, "/me/google/link/confirm", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({
          googleLinkToken,
        }),
      });

      setGoogleLinkToken("");
      setWalletLinkedGoogle(true);
      setOpenStep("deposit");
      setToastMsg("Google account linked to wallet.");
      await refreshGoogleLinkStatus();
    } catch (e: any) {
      setToastMsg(e?.message ?? "Google link failed.");
    } finally {
      setBusy(false);
    }
  }

  function openWalletConnect() {
    open?.();
  }

  function openCashierFlow() {
    if (isMobileDevice()) {
      window.location.href = cashierUrl;
      return;
    }
    window.open(cashierUrl, "_blank", "noopener,noreferrer");
  }

  const readyToUse = !!jwt && walletLinkedGoogle;
  const connectedWalletLabel = account || (hasWalletJwt ? jwtSub : "");

  const walletConnectedDone = !!connectedWalletLabel;
  const walletSignedDone = hasWalletJwt;
  const googleVerifiedDone = !!googleLinkToken || walletLinkedGoogle;
  const googleLinkedDone = walletLinkedGoogle;
  const depositDone = false;

  return (
    <div className="setup-page">
      <div className="setup-wrap">
        <div className="setup-shell">
          <div className="setup-head">
            <h1>Haus Link</h1>
            <p>Connect your wallet, link Google, then open cashier to deposit and continue.</p>
          </div>

          <div className="setup-main-grid">
            <div className="setup-primary">
              <div className="step-stack">
                <div className={`step-card ${openStep === "wallet_connect" ? "open" : ""}`}>
                  <button className="step-head-btn" onClick={() => setOpenStep("wallet_connect")}>
                    <div className="step-head-left">
                      <StepStatusIcon
                        done={walletConnectedDone}
                        active={openStep === "wallet_connect" && !walletConnectedDone}
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

                  {openStep === "wallet_connect" && (
                    <div className="step-body">
                      <div className="step-note">
                        No browser extension? Use the wallet modal anyway and connect with your phone wallet.
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

                      {walletConnectedDone && (
                        <button
                          className="btn btn-soft btn-full-mobile"
                          onClick={() => setOpenStep("wallet_sign")}
                        >
                          Next: Sign Wallet Session
                        </button>
                      )}
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

                      {walletSignedDone && (
                        <button
                          className="btn btn-soft btn-full-mobile"
                          onClick={() => setOpenStep("google_verify")}
                        >
                          Next: Verify Google
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div
                  className={`step-card ${openStep === "google_verify" ? "open" : ""} ${
                    !walletSignedDone ? "locked" : ""
                  }`}
                >
                  <button
                    className="step-head-btn"
                    onClick={() => walletSignedDone && setOpenStep("google_verify")}
                  >
                    <div className="step-head-left">
                      <StepStatusIcon
                        done={googleVerifiedDone}
                        active={openStep === "google_verify" && !googleVerifiedDone}
                        locked={!walletSignedDone}
                      />
                      <div>
                        <div className="step-title">Verify Google</div>
                        <div className="step-sub">Choose the Google account you want linked.</div>
                      </div>
                    </div>
                    <div className="step-chevron">{openStep === "google_verify" ? "−" : "+"}</div>
                  </button>

                  {openStep === "google_verify" && walletSignedDone && (
                    <div className="step-body">
                      <div className="google-box" ref={googleBtnRef} />
                      {(googleEmail || googleName || googleSub) ? (
                        <div className="value-box">{googleName || googleEmail || googleSub}</div>
                      ) : null}

                      {googleVerifiedDone && !googleLinkedDone && (
                        <button
                          className="btn btn-soft btn-full-mobile"
                          onClick={() => setOpenStep("google_link")}
                        >
                          Next: Link Google
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div
                  className={`step-card ${openStep === "google_link" ? "open" : ""} ${
                    !googleVerifiedDone ? "locked" : ""
                  }`}
                >
                  <button
                    className="step-head-btn"
                    onClick={() => googleVerifiedDone && setOpenStep("google_link")}
                  >
                    <div className="step-head-left">
                      <StepStatusIcon
                        done={googleLinkedDone}
                        active={openStep === "google_link" && !googleLinkedDone}
                        locked={!googleVerifiedDone}
                      />
                      <div>
                        <div className="step-title">Link Google to wallet</div>
                        <div className="step-sub">Finish linking your verified Google account.</div>
                      </div>
                    </div>
                    <div className="step-chevron">{openStep === "google_link" ? "−" : "+"}</div>
                  </button>

                  {openStep === "google_link" && googleVerifiedDone && (
                    <div className="step-body">
                      <button
                        className={`btn ${googleLinkedDone ? "btn-success" : "btn-primary"} btn-full-mobile`}
                        onClick={() => void confirmGoogleLink()}
                        disabled={busy || !googleLinkToken || !hasWalletJwt}
                      >
                        {googleLinkedDone ? "Google Linked" : "Link Google to Wallet"}
                      </button>

                      {googleLinkedDone && (
                        <button
                          className="btn btn-soft btn-full-mobile"
                          onClick={() => setOpenStep("deposit")}
                        >
                          Next: Open Cashier
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div
                  className={`step-card ${openStep === "deposit" ? "open" : ""} ${
                    !googleLinkedDone ? "locked" : ""
                  }`}
                >
                  <button
                    className="step-head-btn"
                    onClick={() => googleLinkedDone && setOpenStep("deposit")}
                  >
                    <div className="step-head-left">
                      <StepStatusIcon
                        done={depositDone}
                        active={openStep === "deposit" && !depositDone}
                        locked={!googleLinkedDone}
                      />
                      <div>
                        <div className="step-title">Open cashier and deposit</div>
                        <div className="step-sub">
                          Deposit funds, then return to the app and sign in with Google.
                        </div>
                      </div>
                    </div>
                    <div className="step-chevron">{openStep === "deposit" ? "−" : "+"}</div>
                  </button>

                  {openStep === "deposit" && googleLinkedDone && (
                    <div className="step-body">
                      <button className="btn btn-primary btn-full-mobile" onClick={openCashierFlow}>
                        Open Cashier / Deposit
                      </button>



                      {showQr && (
                        <div className="qr-wrap">
                          <div className="qr-box">
                            <QRCodeSVG value={registerUrl} size={220} />
                          </div>

                          <div className="url-box">{registerUrl}</div>

                          <button
                            className="btn btn-soft btn-full-mobile"
                            onClick={() => void copyText(registerUrl).then(() => setToastMsg("Link copied."))}
                          >
                            Copy Setup Link
                          </button>
                        </div>
                      )}

                      <div className="success-panel">
                        <div className="success-title">Setup complete</div>
                        <div className="success-sub">
                          Your wallet and Google are linked. Open cashier, deposit, then go back to
                          blackjack, dice, or balances and sign in with Google.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="setup-side">
              <div className={`status-card ${readyToUse ? "ready" : ""}`}>
                <div className="status-title">Progress</div>
                <div className="status-line">{walletConnectedDone ? "✓" : "•"} Wallet connected</div>
                <div className="status-line">{walletSignedDone ? "✓" : "•"} Wallet signed</div>
                <div className="status-line">{googleVerifiedDone ? "✓" : "•"} Google verified</div>
                <div className="status-line">{googleLinkedDone ? "✓" : "•"} Google linked</div>
                <div className="status-line">{readyToUse ? "✓" : "•"} Ready to use</div>
              </div>

              <div className="help-card">
                <div className="help-title">Need another device?</div>
                <div className="help-copy">
                  Use the QR option inside the deposit step to continue on mobile.
                </div>
              </div>
            </div>
          </div>

          {toast ? <div className="toast-bar">{toast}</div> : null}
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
          grid-template-columns: minmax(0, 1fr) 280px;
          gap: 16px;
          align-items: start;
        }

        .setup-primary,
        .setup-side {
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

        .google-box {
          min-height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
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

        .status-card,
        .help-card {
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 18px;
          padding: 14px;
          background: rgba(0,0,0,0.22);
        }

        .status-card.ready {
          background: rgba(37,165,95,0.14);
          border-color: rgba(37,165,95,0.32);
        }

        .status-title,
        .help-title {
          font-size: 1rem;
          font-weight: 900;
          margin-bottom: 10px;
        }

        .status-line,
        .help-copy {
          color: rgba(255,255,255,0.76);
          line-height: 1.55;
        }

        .setup-side {
          display: grid;
          gap: 12px;
          position: sticky;
          top: 14px;
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

        @media (max-width: 920px) {
          .setup-main-grid {
            grid-template-columns: 1fr;
          }

          .setup-side {
            position: static;
          }
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

          .google-box {
            justify-content: center;
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
