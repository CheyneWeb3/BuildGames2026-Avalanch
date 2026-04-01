import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider } from "ethers";
import { useApiBase } from "../ApiBaseContext";
import { useAppKit, useAppKitAccount, useAppKitProvider } from "../config";
import "../pages/mvp/UserWalletPage.css";

declare global {
  interface Window {
    google?: any;
  }
}

const LS_JWT = "haus_user_jwt";

type GoogleVerifyLinkedResp = {
  ok: true;
  linked: true;
  address: string;
  token: string;
  authProvider?: string;
  googleSub?: string;
  email?: string | null;
};

type GoogleVerifyUnlinkedResp = {
  ok: true;
  linked: false;
  googleSub: string;
  email?: string | null;
  name?: string | null;
  picture?: string | null;
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
  const s = String(a || "").trim();
  if (!s) return "—";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
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
  const b = String(base || "").replace(/\/+$/, "");
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
      if (window.google?.accounts?.id) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed loading Google script")), {
        once: true,
      });
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
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
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
      <div
        className="cw-modal"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: "min(680px, calc(100vw - 24px))" }}
      >
        <div className="cw-modalHead">
          <div className="cw-modalTitle">Google Connection</div>
          <button className="cw-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="cw-modalBody">{children}</div>
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

function StepCard({
  step,
  title,
  description,
  done,
  active,
  locked,
  children,
}: {
  step: number;
  title: string;
  description: string;
  done?: boolean;
  active?: boolean;
  locked?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: 16,
        padding: 14,
        background: done
          ? "rgba(34,197,94,0.10)"
          : active
          ? "rgba(255,255,255,0.05)"
          : "rgba(255,255,255,0.02)",
        opacity: locked ? 0.55 : 1,
        transition: "all 0.15s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", minWidth: 0, flex: 1 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 999,
              display: "grid",
              placeItems: "center",
              fontWeight: 900,
              background: done ? "rgba(34,197,94,0.20)" : "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.10)",
              flexShrink: 0,
            }}
          >
            {done ? "✓" : step}
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800 }}>{title}</div>
            <div style={{ opacity: 0.78, fontSize: 13, marginTop: 4 }}>{description}</div>
          </div>
        </div>

        <div style={{ flexShrink: 0 }}>
          {done ? <Pill>Done</Pill> : active ? <Pill>Next</Pill> : locked ? <Pill>Locked</Pill> : null}
        </div>
      </div>

      {children ? <div style={{ marginTop: 12 }}>{children}</div> : null}
    </div>
  );
}

export default function GoogleWalletLinkModal({
  open,
  onClose,
  onLinked,
  onStatusChange,
}: {
  open: boolean;
  onClose: () => void;
  onLinked?: (info: { wallet: string; googleSub?: string; email?: string }) => void;
  onStatusChange?: (linked: boolean, info?: { wallet?: string; googleSub?: string; email?: string }) => void;
}) {
  const apiBase = useApiBase();

  const { open: openWalletModal } = useAppKit();
  const { address: appkitAddress, isConnected } = useAppKitAccount();
  const { walletProvider: appkitWalletProvider } = useAppKitProvider("eip155");

  const googleClientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();

  const [walletProvider, setWalletProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState<string>("");

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(
    "Complete the steps below to use Google sign-in with your linked wallet-backed credits."
  );

  const [googleSub, setGoogleSub] = useState("");
  const [googleEmail, setGoogleEmail] = useState("");
  const [googleName, setGoogleName] = useState("");
  const [googlePicture, setGooglePicture] = useState("");
  const [googleLinkToken, setGoogleLinkToken] = useState("");

  const [linkStatus, setLinkStatus] = useState<GoogleLinkStatusResp | null>(null);

  const googleBtnRef = useRef<HTMLDivElement | null>(null);

  const jwtSub = useMemo(() => decodeJwtSub(jwt), [jwt]);
  const hasWalletJwt = useMemo(() => /^0x[a-fA-F0-9]{40}$/.test(jwtSub), [jwtSub]);

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
    const onStorage = () => setJwt(localStorage.getItem(LS_JWT) || "");
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!open) return;
    setJwt(localStorage.getItem(LS_JWT) || "");
  }, [open]);

  const authHeaders = useMemo(() => (jwt ? { Authorization: `Bearer ${jwt}` } : {}), [jwt]);

  const clearPendingGoogle = useCallback(() => {
    setGoogleSub("");
    setGoogleEmail("");
    setGoogleName("");
    setGooglePicture("");
    setGoogleLinkToken("");
  }, []);

  const refreshLinkStatus = useCallback(
    async (tokenOverride?: string) => {
      const useToken = tokenOverride || jwt;

      if (!useToken) {
        setLinkStatus(null);
        onStatusChange?.(false);
        return;
      }

      const sub = decodeJwtSub(useToken);
      if (!/^0x[a-fA-F0-9]{40}$/.test(sub)) {
        setLinkStatus(null);
        onStatusChange?.(false);
        return;
      }

      try {
        const out = (await apiJson(apiBase, "/me/google/link/status", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${useToken}`,
          },
        })) as GoogleLinkStatusResp;

        setLinkStatus(out);

        const first = Array.isArray(out?.links) ? out.links[0] : undefined;
        if (out?.linked && first) {
          onStatusChange?.(true, {
            wallet: out.ownerWallet,
            googleSub: first.googleSub,
            email: first.email || undefined,
          });
        } else {
          onStatusChange?.(false);
        }
      } catch {
        setLinkStatus(null);
        onStatusChange?.(false);
      }
    },
    [apiBase, jwt, onStatusChange]
  );

  useEffect(() => {
    if (!open) return;
    void refreshLinkStatus();
  }, [open, refreshLinkStatus]);

  useEffect(() => {
    if (!open) return;
    const iv = window.setInterval(() => {
      void refreshLinkStatus();
    }, 12000);
    return () => window.clearInterval(iv);
  }, [open, refreshLinkStatus]);

  const loginWithWallet = useCallback(async () => {
    if (!walletProvider) {
      setStatus("Connect your wallet first.");
      return;
    }

    setBusy(true);
    setStatus("Requesting wallet session...");

    try {
      const signer = await walletProvider.getSigner();
      const addr = await signer.getAddress();

      const nonceResp = await apiJson(apiBase, "/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address: addr }),
      });

      const message: string =
        nonceResp?.message || nonceResp?.nonce || nonceResp?.data?.message || nonceResp?.data?.nonce;

      if (!message || typeof message !== "string") {
        throw new Error("Nonce response missing message.");
      }

      setStatus("Sign the wallet session message.");
      const sig = await signer.signMessage(message);

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
      setStatus(`Session ready for ${shortAddr(addr)}.`);
      await refreshLinkStatus(tokenJwt);
    } catch (e: any) {
      setStatus(String(e?.message || "Wallet sign-in failed."));
    } finally {
      setBusy(false);
    }
  }, [walletProvider, apiBase, refreshLinkStatus]);

  const handleGoogleCredential = useCallback(
    async (credential: string) => {
      setBusy(true);
      setStatus("Verifying Google account...");

      try {
        const out = (await apiJson(apiBase, "/auth/google/verify", {
          method: "POST",
          body: JSON.stringify({ idToken: credential }),
        })) as GoogleVerifyLinkedResp | GoogleVerifyUnlinkedResp;

        if (out.linked) {
          localStorage.setItem(LS_JWT, out.token);
          setJwt(out.token);
          clearPendingGoogle();
          setStatus(`Google already linked to ${shortAddr(out.address)}.`);
          await refreshLinkStatus(out.token);

          onLinked?.({
            wallet: out.address,
            googleSub: out.googleSub || undefined,
            email: out.email || undefined,
          });

          onStatusChange?.(true, {
            wallet: out.address,
            googleSub: out.googleSub || undefined,
            email: out.email || undefined,
          });
          return;
        }

        setGoogleSub(String(out.googleSub || ""));
        setGoogleEmail(String(out.email || ""));
        setGoogleName(String(out.name || ""));
        setGooglePicture(String(out.picture || ""));
        setGoogleLinkToken(String(out.googleLinkToken || ""));
        setStatus("Google account verified. Complete the final link step.");
      } catch (e: any) {
        setStatus(String(e?.message || "Google verify failed."));
      } finally {
        setBusy(false);
      }
    },
    [apiBase, clearPendingGoogle, onLinked, onStatusChange, refreshLinkStatus]
  );

  useEffect(() => {
    if (!open) return;

    if (!googleClientId) {
      setStatus("Missing VITE_GOOGLE_CLIENT_ID.");
      return;
    }

    const canRender = hasWalletJwt && !linkStatus?.linked && !busy;
    if (!canRender) {
      if (googleBtnRef.current) googleBtnRef.current.innerHTML = "";
      return;
    }

    let dead = false;

    async function bootGoogle() {
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
              setStatus("Google returned no credential.");
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
          width: 260,
        });
      } catch (e: any) {
        setStatus(String(e?.message || "Failed to load Google button."));
      }
    }

    void bootGoogle();

    return () => {
      dead = true;
    };
  }, [open, googleClientId, handleGoogleCredential, hasWalletJwt, linkStatus?.linked, busy]);

  const confirmGoogleLink = useCallback(async () => {
    if (!googleLinkToken) {
      setStatus("Complete Google sign-in first.");
      return;
    }

    if (!jwt || !hasWalletJwt) {
      setStatus("Wallet session is required before linking Google.");
      return;
    }

    setBusy(true);
    setStatus("Linking Google account...");

    try {
      await apiJson(apiBase, "/me/google/link/confirm", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({
          googleLinkToken,
        }),
      });

      setStatus("Google account linked successfully.");
      await refreshLinkStatus();

      const info = {
        wallet: jwtSub,
        googleSub,
        email: googleEmail || undefined,
      };

      onLinked?.(info);
      onStatusChange?.(true, info);

      clearPendingGoogle();
    } catch (e: any) {
      setStatus(String(e?.message || "Google link failed."));
    } finally {
      setBusy(false);
    }
  }, [
    googleLinkToken,
    jwt,
    hasWalletJwt,
    apiBase,
    authHeaders,
    refreshLinkStatus,
    onLinked,
    onStatusChange,
    jwtSub,
    googleSub,
    googleEmail,
    clearPendingGoogle,
  ]);

  const unlinkGoogle = useCallback(
    async (sub: string) => {
      if (!sub || !jwt) return;

      setBusy(true);
      setStatus("Unlinking Google account...");

      try {
        await apiJson(apiBase, "/me/google/link/unlink", {
          method: "POST",
          headers: authHeaders as any,
          body: JSON.stringify({
            googleSub: sub,
          }),
        });

        clearPendingGoogle();
        await refreshLinkStatus();
        onStatusChange?.(false);
        setStatus("Google account unlinked.");
      } catch (e: any) {
        setStatus(String(e?.message || "Failed to unlink Google."));
      } finally {
        setBusy(false);
      }
    },
    [apiBase, authHeaders, jwt, refreshLinkStatus, clearPendingGoogle, onStatusChange]
  );

  const linkedGoogle = linkStatus?.links?.[0] || null;

  const step1Done = !!isConnected && !!(account || appkitAddress);
  const step2Done = !!hasWalletJwt;
  const step3Done = !!linkedGoogle;

  const step1Active = !step1Done;
  const step2Active = step1Done && !step2Done;
  const step3Active = step1Done && step2Done && !step3Done;

  return (
    <Modal open={open} onClose={onClose} title="Google Connection">
      <div className="cw-form" style={{ display: "grid", gap: 14 }}>
        <div className="cw-help" style={{ fontSize: 15 }}>
          Link Google to your wallet-backed Haus credits. Complete each step in order.
        </div>

        <StepCard
          step={1}
          title="Connect wallet"
          description={
            step1Done
              ? `Connected: ${shortAddr(account || appkitAddress)}`
              : "Connect the wallet you already use with Haus."
          }
          done={step1Done}
          active={step1Active}
        >
          {!step1Done ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <MiniBtn kind="primary" onClick={() => openWalletModal()} disabled={busy}>
                Connect Wallet
              </MiniBtn>
            </div>
          ) : null}
        </StepCard>

        <StepCard
          step={2}
          title="Sign session"
          description={
            step2Done
              ? "Wallet session active."
              : "Sign a wallet session so the server knows which wallet account to use."
          }
          done={step2Done}
          active={step2Active}
          locked={!step1Done}
        >
          {!step2Done ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <MiniBtn kind="primary" onClick={loginWithWallet} disabled={busy || !walletProvider || !step1Done}>
                Sign Session
              </MiniBtn>
            </div>
          ) : null}
        </StepCard>

        <StepCard
          step={3}
          title="Connect Google"
          description={
            step3Done
              ? `Linked to ${linkedGoogle?.email || linkedGoogle?.name || "Google account"}`
              : googleLinkToken
              ? "Google verified. Finalize the link below."
              : "Connect your Google account to use the linked wallet credits in supported apps."
          }
          done={step3Done}
          active={step3Active}
          locked={!step2Done}
        >
          {!step3Done && step2Done ? (
            <div style={{ display: "grid", gap: 12 }}>
              {!googleLinkToken ? (
                <div
                  ref={googleBtnRef}
                  style={{
                    minHeight: 44,
                    display: "flex",
                    alignItems: "center",
                  }}
                />
              ) : (
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 14,
                    padding: 12,
                    background: "rgba(255,255,255,0.03)",
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  {googlePicture ? (
                    <img
                      src={googlePicture}
                      alt={googleName || googleEmail || "Google profile"}
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 999,
                        objectFit: "cover",
                        border: "1px solid rgba(255,255,255,0.12)",
                      }}
                    />
                  ) : null}

                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 800 }}>{googleName || "Google account"}</div>
                    <div style={{ opacity: 0.82, fontSize: 13 }}>{googleEmail || "No email returned"}</div>
                  </div>

                  <MiniBtn kind="primary" onClick={confirmGoogleLink} disabled={busy || !googleLinkToken}>
                    Link Google
                  </MiniBtn>
                </div>
              )}
            </div>
          ) : null}
        </StepCard>

        <div
          style={{
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 16,
            padding: 14,
            background: step3Done ? "rgba(34,197,94,0.08)" : "rgba(255,255,255,0.02)",
          }}
        >
          <div style={{ fontWeight: 800, marginBottom: 8 }}>{step3Done ? "Connected account" : "Status"}</div>

          {!step3Done ? (
            <div className="cw-help" style={{ margin: 0 }}>
              {status}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div className="cw-help" style={{ margin: 0 }}>
                Wallet: <span className="cw-mono">{shortAddr(linkStatus?.ownerWallet || account || appkitAddress)}</span>
              </div>

              <div className="cw-help" style={{ margin: 0 }}>
                Google: <b>{linkedGoogle?.email || linkedGoogle?.name || "Linked account"}</b>
              </div>

              {linkedGoogle?.googleSub ? (
                <div className="cw-help" style={{ margin: 0 }}>
                  Google ID: <span className="cw-mono">{linkedGoogle.googleSub}</span>
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                <MiniBtn kind="danger" onClick={() => unlinkGoogle(linkedGoogle?.googleSub || "")} disabled={busy}>
                  Unlink Google
                </MiniBtn>

                <MiniBtn kind="ghost" onClick={onClose} disabled={busy}>
                  Close
                </MiniBtn>
              </div>
            </div>
          )}
        </div>

        {!step3Done ? (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <MiniBtn kind="ghost" onClick={() => void refreshLinkStatus()} disabled={busy}>
              Refresh
            </MiniBtn>
            <MiniBtn kind="ghost" onClick={onClose} disabled={busy}>
              Close
            </MiniBtn>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
