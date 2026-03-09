// src/pages/CoreApiAdminPage.tsx
import React, { useEffect, useMemo, useState } from "react";
import { BrowserProvider } from "ethers";
import "./VaultAdminPage.css"; // reuse your styling + Button/Pill look if you want

function shortAddr(a?: string) {
  if (!a) return "";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "ghost" | "danger" }
) {
  const kind = props.kind ?? "primary";
  const cls =
    "va-btn " +
    (kind === "primary" ? "va-btnPrimary" : kind === "danger" ? "va-btnDanger" : "va-btnGhost") +
    (props.disabled ? " va-btnDisabled" : "");
  return <button {...props} className={cls} />;
}

function Row({ label, value, mono }: { label: string; value?: React.ReactNode; mono?: boolean }) {
  return (
    <div className="va-row">
      <div className="va-rowLabel">{label}</div>
      <div className={"va-rowValue" + (mono ? " va-mono" : "")}>{value ?? "—"}</div>
    </div>
  );
}

const CORE_API_URL = (import.meta as any).env?.VITE_CORE_API_URL || "http://127.0.0.1:8088";
const LS_JWT = "haus_admin_jwt";

async function apiJson(path: string, init?: RequestInit) {
  const url = CORE_API_URL.replace(/\/$/, "") + path;
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
    const msg = data?.error || data?.message || `${r.status} ${r.statusText}`;
    throw new Error(msg);
  }
  return data;
}

export default function CoreApiAdminPage() {
  const [walletProvider, setWalletProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState<string>("");
  const [walletChainId, setWalletChainId] = useState<number | null>(null);

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || "");
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  // Treasury create form (since you’re doing this in CLI now)
  const [treasuryId, setTreasuryId] = useState("tg-main");
  const [moduleId, setModuleId] = useState("tg");
  const [label, setLabel] = useState("Telegram Main Treasury");
  const [chainId, setChainId] = useState(56);
  const [token, setToken] = useState("0x0000000000000000000000000000000000000000");
  const [enabled, setEnabled] = useState(true);

  const authed = !!jwt;

  const authHeaders = useMemo(() => {
    return jwt ? { Authorization: `Bearer ${jwt}` } : {};
  }, [jwt]);

  async function connectWallet() {
    setStatusMsg("");
    if (!(window as any).ethereum) {
      setStatusMsg("No injected wallet detected (MetaMask).");
      return;
    }
    setBusy(true);
    try {
      const bp = new BrowserProvider((window as any).ethereum);
      await bp.send("eth_requestAccounts", []);
      const s = await bp.getSigner();
      const addr = await s.getAddress();
      const net = await bp.getNetwork();
      setWalletProvider(bp);
      setAccount(addr);
      setWalletChainId(Number(net.chainId));
      setStatusMsg("Wallet connected.");
    } catch (e: any) {
      setStatusMsg(e?.message ?? "Failed to connect wallet.");
    } finally {
      setBusy(false);
    }
  }

  // keep chain updated
  useEffect(() => {
    const eth = (window as any).ethereum;
    if (!eth) return;
    const onChainChanged = () => {
      (async () => {
        try {
          if (!walletProvider) return;
          const net = await walletProvider.getNetwork();
          setWalletChainId(Number(net.chainId));
        } catch {}
      })();
    };
    eth.on?.("chainChanged", onChainChanged);
    return () => eth.removeListener?.("chainChanged", onChainChanged);
  }, [walletProvider]);

  function logout() {
    localStorage.removeItem(LS_JWT);
    setJwt("");
    setStatusMsg("Logged out (JWT cleared).");
  }

  /**
   * This is the key bit:
   * - GET/POST /auth/nonce with your wallet address
   * - sign returned nonce payload in-browser
   * - POST /auth/verify with address + signature
   * - store JWT
   */
  async function loginWithWallet() {
    setStatusMsg("");
    if (!walletProvider) return setStatusMsg("Connect wallet first.");
    setBusy(true);

    try {
      const signer = await walletProvider.getSigner();
      const addr = await signer.getAddress();

      // 1) ask server for nonce
      // NOTE: if your API expects POST, this matches your previous system design.
      // If it expects GET, change to /auth/nonce?address=...
      const nonceResp = await apiJson("/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address: addr }),
      });

      // Support both shapes:
      // - { nonce: "..." }
      // - { message: "..." }
      // - { ok:true, nonce:"..." }
      const message: string =
        nonceResp?.message ||
        nonceResp?.nonce ||
        nonceResp?.data?.message ||
        nonceResp?.data?.nonce;

      if (!message || typeof message !== "string") {
        throw new Error("Nonce response missing 'nonce/message'. Check /auth/nonce response shape.");
      }

      // 2) sign it
      const sig = await signer.signMessage(message);

      // 3) verify
      const verifyResp = await apiJson("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address: addr, signature: sig }),
      });

      // Support common shapes:
      // - { token: "jwt..." }
      // - { jwt: "..." }
      // - { ok:true, token:"..." }
      const tokenJwt: string =
        verifyResp?.token ||
        verifyResp?.jwt ||
        verifyResp?.data?.token ||
        verifyResp?.data?.jwt;

      if (!tokenJwt || typeof tokenJwt !== "string") {
        throw new Error("Verify response missing jwt/token. Check /auth/verify response shape.");
      }

      localStorage.setItem(LS_JWT, tokenJwt);
      setJwt(tokenJwt);
      setStatusMsg("Login OK. JWT stored in localStorage.");
    } catch (e: any) {
      setStatusMsg(e?.message ?? "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  // “am I admin?” check (simple: try an admin endpoint)
  async function checkAdmin() {
    setStatusMsg("");
    if (!jwt) return setStatusMsg("Login first (need JWT).");
    setBusy(true);
    try {
      // If you have a dedicated endpoint like /admin/me use it.
      // Otherwise this “create same treasury” is safe (created:false).
      const out = await apiJson("/admin/treasuries/create", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({
          treasuryId: "__admin_check__",
          moduleId: "tg",
          label: "Admin Check",
          chainId: 56,
          token: "0x0000000000000000000000000000000000000000",
          enabled: false,
        }),
      });
      setStatusMsg(`Admin OK (server accepted JWT). Response: ${out?.ok ? "ok:true" : "ok:?"}`);
    } catch (e: any) {
      setStatusMsg(`Admin check failed: ${e?.message ?? "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  async function createOrUpdateTreasury() {
    setStatusMsg("");
    if (!jwt) return setStatusMsg("Login first (need JWT).");
    if (!treasuryId.trim()) return setStatusMsg("treasuryId required.");
    if (!moduleId.trim()) return setStatusMsg("moduleId required.");
    setBusy(true);
    try {
      const out = await apiJson("/admin/treasuries/create", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({
          treasuryId: treasuryId.trim(),
          moduleId: moduleId.trim(),
          label: label.trim(),
          chainId: Number(chainId),
          token: token.trim(),
          enabled: !!enabled,
        }),
      });
      setStatusMsg(`Treasury saved. created=${String(out?.created)} ok=${String(out?.ok)}`);
    } catch (e: any) {
      setStatusMsg(e?.message ?? "Treasury create failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="va-page">
      <div className="va-header">
        <div>
          <div className="va-title">Core API Admin (Local UI)</div>
          <div className="va-subtitle">Wallet-signed login → JWT → admin endpoints</div>
        </div>

        <div className="va-actions">
          <Button kind="ghost" onClick={checkAdmin} disabled={busy || !authed}>
            Check Admin
          </Button>
          {jwt ? (
            <Button kind="danger" onClick={logout} disabled={busy}>
              Logout
            </Button>
          ) : null}
          <Button onClick={connectWallet} disabled={busy}>
            {account ? `Wallet: ${shortAddr(account)}` : "Connect Wallet"}
          </Button>
        </div>
      </div>

      <div className="va-card" style={{ marginTop: 12 }}>
        <div className="va-cardTitle">Connection</div>
        <div className="va-cardSub">This UI runs on your PC, talks to core-api at VITE_CORE_API_URL</div>

        <div style={{ marginTop: 12 }}>
          <Row label="Core API URL" value={<span className="va-mono">{CORE_API_URL}</span>} mono />
          <Row label="Wallet" value={account ? <span className="va-mono">{account}</span> : "—"} mono />
          <Row label="Wallet chainId" value={walletChainId ?? "—"} mono />
          <Row label="JWT" value={jwt ? <span className="va-mono">{jwt.slice(0, 18)}…</span> : "—"} mono />
        </div>

        {statusMsg ? <div className="va-notice" style={{ marginTop: 12 }}>{statusMsg}</div> : null}

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button onClick={loginWithWallet} disabled={busy || !walletProvider}>
            Login with Wallet (sign nonce)
          </Button>
        </div>
      </div>

      <div className="va-card" style={{ marginTop: 12 }}>
        <div className="va-cardTitle">Treasury Admin</div>
        <div className="va-cardSub">This replaces your CLI curl for /admin/treasuries/create</div>

        <div style={{ marginTop: 12 }} className="va-formStack">
          <input className="va-input" value={treasuryId} onChange={(e) => setTreasuryId(e.target.value)} placeholder="treasuryId (e.g. tg-main)" />
          <input className="va-input" value={moduleId} onChange={(e) => setModuleId(e.target.value)} placeholder="moduleId (e.g. tg)" />
          <input className="va-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" />
          <input className="va-input" value={String(chainId)} onChange={(e) => setChainId(Number(e.target.value || 0))} placeholder="chainId (e.g. 56)" />
          <input className="va-input va-mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="token address (0x0 for native, or ERC20)" />

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>

          <div style={{ marginTop: 10 }}>
            <Button onClick={createOrUpdateTreasury} disabled={busy || !authed}>
              Save Treasury
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
