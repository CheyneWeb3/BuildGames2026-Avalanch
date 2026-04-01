import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider } from "ethers";
import { useApiBase } from "../../ApiBaseContext";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
} from "../../config";
import "./UserWalletPage.css";

declare global {
  interface Window {
    google?: any;
  }
}

const LS_JWT = "haus_user_jwt";

type BalanceItem = {
  chainId: number;
  token: string;
  balanceRaw?: string;
  availableRaw?: string;
  heldRaw?: string;
  totalRaw?: string;
  updatedAt?: string;
};

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
  return s.slice(0, 6) + "…" + s.slice(-4);
}

function decodeJwtSub(token: string) {
  try {
    const payload = JSON.parse(atob(String(token).split(".")[1]));
    return String(payload?.sub || "");
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
    const msg =
      data?.error ||
      data?.message ||
      data?.raw ||
      `${r.status} ${r.statusText}`;
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

function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="cw-modalBg" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div className="cw-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cw-modalHead">
          <div className="cw-modalTitle">{title}</div>
          <button className="cw-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="cw-modalBody">{children}</div>
        {footer ? <div className="cw-modalFoot">{footer}</div> : null}
      </div>
    </div>
  );
}

function MiniBtn({
  children,
  onClick,
  disabled,
  kind = "ghost",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  kind?: "ghost" | "danger" | "primary";
}) {
  return (
    <button
      type="button"
      className={
        "cw-btn " +
        (kind === "primary" ? "cw-btnPrimary" : kind === "danger" ? "cw-btnDanger" : "cw-btnGhost")
      }
      onClick={onClick}
      disabled={!!disabled}
    >
      {children}
    </button>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="cw-pill">{children}</span>;
}

export default function GoogleWalletLinkPage() {
  const apiBase = useApiBase();

  const { open } = useAppKit();
  const { address: appkitAddress, isConnected } = useAppKitAccount();
  const { walletProvider: appkitWalletProvider } = useAppKitProvider("eip155");

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || "");
  const authed = !!jwt;

  const [walletProvider, setWalletProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState<string>("");

  const [balances, setBalances] = useState<BalanceItem[]>([]);
  const [linkStatus, setLinkStatus] = useState<GoogleLinkStatusResp | null>(null);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const toastRef = useRef<number | null>(null);

  const [googleSub, setGoogleSub] = useState("");
  const [googleEmail, setGoogleEmail] = useState("");
  const [googleName, setGoogleName] = useState("");
  const [googleLinkToken, setGoogleLinkToken] = useState("");

  const googleBtnRef = useRef<HTMLDivElement | null>(null);
  const googleClientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();

  const jwtSub = useMemo(() => decodeJwtSub(jwt), [jwt]);
  const hasWalletJwt = useMemo(() => /^0x[a-fA-F0-9]{40}$/.test(jwtSub), [jwtSub]);

  function setToastMsg(s: string) {
    setToast(s);
    if (toastRef.current) window.clearTimeout(toastRef.current);
    toastRef.current = window.setTimeout(() => setToast(""), 7000);
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
      } catch {}
    })();
  }, [isConnected, appkitWalletProvider, appkitAddress]);

  const authHeaders = useMemo(
    () => (jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    [jwt]
  );

  async function refreshBalances(opts?: { silent?: boolean; tokenOverride?: string }) {
    const token = opts?.tokenOverride || jwt;
    if (!token) return;
    try {
      const out = await apiJson(apiBase, "/me/balances", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      setBalances(out?.items || []);
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load balances.");
    }
  }

  async function refreshGoogleLinkStatus(opts?: { silent?: boolean; tokenOverride?: string }) {
    const token = opts?.tokenOverride || jwt;
    if (!token) return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(decodeJwtSub(token))) return;

    try {
      const out = await apiJson(apiBase, "/me/google/link/status", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      setLinkStatus(out);
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load Google link status.");
    }
  }

  useEffect(() => {
    if (!authed) return;
    refreshBalances({ silent: true }).catch(() => {});
    refreshGoogleLinkStatus({ silent: true }).catch(() => {});
    const iv = window.setInterval(() => {
      refreshBalances({ silent: true }).catch(() => {});
      refreshGoogleLinkStatus({ silent: true }).catch(() => {});
    }, 20000);
    return () => window.clearInterval(iv);
  }, [authed]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loginWithWallet() {
    if (!walletProvider) return setToastMsg("Connect wallet first.");
    setBusy(true);
    try {
      const signer = await walletProvider.getSigner();
      const addr = await signer.getAddress();

      const nonceResp = await apiJson(apiBase, "/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address: addr }),
      });

      const message: string =
        nonceResp?.message || nonceResp?.nonce || nonceResp?.data?.message || nonceResp?.data?.nonce;
      if (!message || typeof message !== "string") throw new Error("Nonce response missing message.");

      const sig = await signer.signMessage(message);

      const verifyResp = await apiJson(apiBase, "/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address: addr, signature: sig }),
      });

      const tokenJwt: string =
        verifyResp?.token || verifyResp?.jwt || verifyResp?.data?.token || verifyResp?.data?.jwt;
      if (!tokenJwt || typeof tokenJwt !== "string") throw new Error("Verify response missing jwt.");

      localStorage.setItem(LS_JWT, tokenJwt);
      setJwt(tokenJwt);

      setToastMsg("Wallet session signed.");
      await refreshBalances({ silent: true, tokenOverride: tokenJwt });
      await refreshGoogleLinkStatus({ silent: true, tokenOverride: tokenJwt });
    } catch (e: any) {
      setToastMsg(e?.message ?? "Sign in failed.");
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
          setToastMsg(`Google login resolved to linked wallet ${shortAddr(out.address)}.`);
          await refreshBalances({ silent: true, tokenOverride: out.token });
          await refreshGoogleLinkStatus({ silent: true, tokenOverride: out.token });
          return;
        }

        setGoogleSub(String(out.googleSub || ""));
        setGoogleEmail(String(out.email || ""));
        setGoogleName(String(out.name || ""));
        setGoogleLinkToken(String(out.googleLinkToken || ""));
        setToastMsg("Google verified. Now sign wallet session, then click Link Google.");
      } catch (e: any) {
        setToastMsg(e?.message ?? "Google verify failed.");
      } finally {
        setBusy(false);
      }
    },
    [apiBase] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    let dead = false;

    async function bootGoogle() {
      if (!googleClientId) {
        setToastMsg("Missing VITE_GOOGLE_CLIENT_ID.");
        return;
      }

      try {
        await ensureGoogleScript();
        if (dead) return;
        if (!window.google?.accounts?.id || !googleBtnRef.current) return;

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
      } catch (e: any) {
        setToastMsg(e?.message ?? "Failed to boot Google sign-in.");
      }
    }

    void bootGoogle();
    return () => {
      dead = true;
    };
  }, [googleClientId, handleGoogleCredential]);

  async function confirmGoogleLink() {
    if (!googleLinkToken) return setToastMsg("No pending Google link token.");
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
      setToastMsg("Google account linked to wallet.");
      await refreshGoogleLinkStatus({ silent: true });
      await refreshBalances({ silent: true });
    } catch (e: any) {
      setToastMsg(e?.message ?? "Google link failed.");
    } finally {
      setBusy(false);
    }
  }

  async function unlinkGoogle(sub: string) {
    if (!sub) return;
    if (!jwt) return setToastMsg("Sign in first.");

    setBusy(true);
    try {
      await apiJson(apiBase, "/me/google/link/unlink", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({
          googleSub: sub,
        }),
      });

      setToastMsg("Google account unlinked.");
      await refreshGoogleLinkStatus({ silent: true });
    } catch (e: any) {
      setToastMsg(e?.message ?? "Failed to unlink Google account.");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem(LS_JWT);
    setJwt("");
    setBalances([]);
    setLinkStatus(null);
    setGoogleSub("");
    setGoogleEmail("");
    setGoogleName("");
    setGoogleLinkToken("");
    setToastMsg("Signed out.");
  }

  const sessionGateOpen = !isConnected || !authed;

  return (
    <div className="cw-page">
      <div className="cw-top">
        <div className="cw-title">Google Wallet Link Test</div>

        <div className="cw-topRight">
          <div className="cw-appkitBtn">
            <appkit-button />
          </div>
        </div>
      </div>

      {toast ? <div className="cw-toast">{toast}</div> : null}

      <div className="cw-card">
        <div className="cw-cardHead">
          <div className="cw-cardTitle">Google + Wallet link flow</div>
          <div className="cw-cardSub">
            Uses the same API base resolver as the main wallet page.
          </div>
        </div>

        <div className="cw-settings">
          <div className="cw-settingRow">
            <div className="cw-settingKey">API Base</div>
            <div className="cw-settingVal cw-mono">{apiBase}</div>
          </div>

          <div className="cw-settingRow">
            <div className="cw-settingKey">Wallet connected</div>
            <div className="cw-settingVal">{isConnected ? <Pill>Yes</Pill> : "No"}</div>
          </div>

          <div className="cw-settingRow">
            <div className="cw-settingKey">Wallet address</div>
            <div className="cw-settingVal cw-mono">{account || appkitAddress || "—"}</div>
          </div>

          <div className="cw-settingRow">
            <div className="cw-settingKey">JWT subject</div>
            <div className="cw-settingVal cw-mono">{jwtSub || "—"}</div>
          </div>

          <div className="cw-settingRow">
            <div className="cw-settingKey">Wallet JWT</div>
            <div className="cw-settingVal">{hasWalletJwt ? <Pill>Yes</Pill> : "No"}</div>
          </div>

          <div className="cw-divider" />

          <div className="cw-settingRow">
            <div className="cw-settingKey">Pending Google sub</div>
            <div className="cw-settingVal cw-mono">{googleSub || "—"}</div>
          </div>

          <div className="cw-settingRow">
            <div className="cw-settingKey">Pending email</div>
            <div className="cw-settingVal">{googleEmail || "—"}</div>
          </div>

          <div className="cw-settingRow">
            <div className="cw-settingKey">Pending name</div>
            <div className="cw-settingVal">{googleName || "—"}</div>
          </div>

          <div className="cw-settingRow">
            <div className="cw-settingKey">Pending link token</div>
            <div className="cw-settingVal">{googleLinkToken ? <Pill>Ready</Pill> : "—"}</div>
          </div>

          <div className="cw-settingBtns">
            <MiniBtn kind="primary" onClick={() => open()} disabled={busy}>
              Connect wallet
            </MiniBtn>

            <MiniBtn kind="primary" onClick={loginWithWallet} disabled={busy || !walletProvider}>
              Sign wallet session
            </MiniBtn>

            <MiniBtn kind="primary" onClick={confirmGoogleLink} disabled={busy || !googleLinkToken || !hasWalletJwt}>
              Link Google
            </MiniBtn>

            <MiniBtn
              kind="ghost"
              onClick={() => {
                if (!authed) return setToastMsg("Sign in first.");
                refreshBalances({ silent: true });
                refreshGoogleLinkStatus({ silent: true });
                setToastMsg("Refreshed.");
              }}
              disabled={!authed}
            >
              Refresh
            </MiniBtn>

            <MiniBtn kind="danger" onClick={logout} disabled={busy}>
              Sign out
            </MiniBtn>
          </div>

          <div style={{ marginTop: 16 }}>
            <div ref={googleBtnRef} />
          </div>
        </div>
      </div>

      <div className="cw-card">
        <div className="cw-cardHead">
          <div className="cw-cardTitle">Linked Google accounts</div>
          <div className="cw-cardSub">Current wallet-linked Google identities.</div>
        </div>

        {!linkStatus?.links?.length ? (
          <div className="cw-empty">No linked Google accounts found.</div>
        ) : (
          <div className="cw-list">
            {linkStatus.links.map((x) => (
              <div key={x._id} className="cw-row" style={{ cursor: "default" }}>
                <div className="cw-left">
                  <div className="cw-meta">
                    <div className="cw-sym">{x.name || "Unnamed Google user"}</div>
                    <div className="cw-sub">{x.email || "No email"}</div>
                    <div className="cw-sub cw-mono">{x.googleSub}</div>
                  </div>
                </div>

                <div className="cw-right">
                  <MiniBtn kind="danger" onClick={() => unlinkGoogle(x.googleSub)} disabled={busy}>
                    Unlink
                  </MiniBtn>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="cw-card">
        <div className="cw-cardHead">
          <div className="cw-cardTitle">Wallet credited balances</div>
          <div className="cw-cardSub">Loaded from /me/balances using the same dynamic API base.</div>
        </div>

        {!authed ? (
          <div className="cw-empty">Sign in to load balances.</div>
        ) : balances.length ? (
          <div className="cw-list">
            {balances.map((b, i) => (
              <div key={`${b.chainId}:${b.token}:${i}`} className="cw-row" style={{ cursor: "default" }}>
                <div className="cw-left">
                  <div className="cw-meta">
                    <div className="cw-sym">Chain {b.chainId}</div>
                    <div className="cw-sub cw-mono">{b.token}</div>
                  </div>
                </div>

                <div className="cw-right">
                  <div className="cw-balLine">
                    <span className="cw-balKey">Available</span>
                    <span className="cw-balVal cw-mono">{String(b.availableRaw ?? b.balanceRaw ?? "0")}</span>
                  </div>
                  <div className="cw-balLine" style={{ marginTop: 8 }}>
                    <span className="cw-balKey">Held</span>
                    <span className="cw-balVal cw-mono">{String(b.heldRaw ?? "0")}</span>
                  </div>
                  <div className="cw-balLine" style={{ marginTop: 8 }}>
                    <span className="cw-balKey">Total</span>
                    <span className="cw-balVal cw-mono">{String(b.totalRaw ?? b.balanceRaw ?? "0")}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="cw-empty">No balances returned.</div>
        )}
      </div>

      <Modal
        open={sessionGateOpen}
        title="Session required"
        onClose={() => {}}
        footer={
          <div className="cw-modalBtns">
            <MiniBtn kind="primary" onClick={() => open()} disabled={busy || isConnected}>
              {isConnected ? "Wallet connected" : "Connect wallet"}
            </MiniBtn>
            <MiniBtn
              kind="primary"
              onClick={loginWithWallet}
              disabled={busy || !walletProvider || !isConnected || authed}
            >
              {authed ? "Session signed" : "Sign session"}
            </MiniBtn>
          </div>
        }
      >
        <div className="cw-form">
          <div className="cw-help" style={{ fontSize: 16, fontWeight: 800 }}>
            connect and sign session to continue
          </div>
          <div className="cw-help">
            {!isConnected
              ? "Connect your wallet first, then sign the session."
              : authed
              ? "Session is ready."
              : "Wallet connected. Sign the session to continue."}
          </div>
          {(account || appkitAddress) ? (
            <div className="cw-help">
              Wallet: <span className="cw-mono">{account || appkitAddress}</span>
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
