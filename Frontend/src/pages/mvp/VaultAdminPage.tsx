// src/pages/ZZNEW/VaultAdminPage.tsx
// Multichain Vault Admin Console
// - Reads chain+vault list from core-api: GET /config/public
// - Uses Reown AppKit for wallet connect + network switching
// - Reads vault state/tokens from selected chain RPC
// - Token table is built from config candidates (no log scanning; avoids pruned-history RPC issues)

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserProvider,
  Contract,
  Interface,
  JsonRpcProvider,
  formatUnits,
  getAddress,
  isAddress,
} from "ethers";
import { useApiBase } from "../../ApiBaseContext";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitProvider,
  getChainById,
} from "../../config";
import { HAUS_VAULT_ABI } from "./TheVaultAbi";
import "./VaultAdminPage.css";

function shortAddr(a?: string) {
  const s = String(a || "").trim();
  if (!s) return "";
  return s.slice(0, 6) + "…" + s.slice(-4);
}
function bytes4Ok(s: string) {
  return /^0x[0-9a-fA-F]{8}$/.test((s || "").trim());
}
function toBigIntOrNull(s: string) {
  try {
    const t = (s ?? "").trim();
    if (!t) return null;
    // allow decimal integers only
    if (!/^\d+$/.test(t)) return null;
    return BigInt(t);
  } catch {
    return null;
  }
}
function checksumOrLower(a: string) {
  try {
    return getAddress(a);
  } catch {
    return (a || "").toLowerCase();
  }
}
function uniqAddrs(addrs: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of addrs) {
    const s = String(a || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function Pill({ ok, text }: { ok?: boolean; text: string }) {
  const bg = ok ? "rgba(34,197,94,0.14)" : "rgba(239,68,68,0.14)";
  const bd = ok ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)";
  const fg = ok ? "rgb(34,197,94)" : "rgb(239,68,68)";
  return (
    <span className="va-pill" style={{ background: bg, borderColor: bd, color: fg }}>
      {text}
    </span>
  );
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

function ResultBox({ children }: { children: React.ReactNode }) {
  return <div className="va-resultBox">{children}</div>;
}

function MonoAddr({ v }: { v: string }) {
  return (
    <span className="va-mono" style={{ wordBreak: "break-all" }}>
      {v}
    </span>
  );
}

/** ====== ERC20 helpers ====== */
const ERC20_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** ===== Public config types (tolerant) ===== */
type PublicToken = { address: string; symbol?: string; decimals?: number; enabled?: boolean };
type PublicVault = {
  id?: string;
  vaultId?: string;
  label?: string;
  address?: string;
  vaultAddress?: string;
  enabled?: boolean;
  usdc?: string;
  wNative?: string;
  tokens?: PublicToken[];
};
type PublicChain = {
  chainId: number;
  name?: string;
  enabled?: boolean;
  rpcHttp?: string;
  vaults?: PublicVault[];
  tokens?: PublicToken[];
};
type PublicConfig = { ok?: boolean; chains?: PublicChain[] };

function vaultKey(v?: PublicVault) {
  return String(v?.vaultId ?? v?.id ?? "");
}
function resolveVaultAddress(v?: PublicVault) {
  return (v?.vaultAddress || v?.address || "").trim();
}

/** ===== UI + query types ===== */
type TabKey = "overview" | "tokens" | "inspector" | "sessions" | "advanced";

type TokenRow = {
  address: string;
  source: "config" | "manual";
  symbol?: string;
  decimals?: number;
  cfgEnabled?: boolean;
  vaultBalHuman?: string;
  vaultBalRaw?: string;
  globalMaxPerTx?: string;
  globalMaxTotal?: string;
  error?: string;
};

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

function toHexChainId(chainId: number) {
  return "0x" + Number(chainId).toString(16);
}

export default function VaultAdminPage() {
  const apiBase = useApiBase();

  /** ===== Reown AppKit wallet ===== */
  const { open } = useAppKit();
  const { address: appkitAddress, isConnected } = useAppKitAccount();
  const { chainId: appkitChainId, switchNetwork } = useAppKitNetwork();
  const { walletProvider: appkitWalletProvider } = useAppKitProvider("eip155");

  const [walletProvider, setWalletProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<any>(null);
  const [account, setAccount] = useState<string>("");
  const [walletChainId, setWalletChainId] = useState<number | null>(null);

  useEffect(() => {
    if (!isConnected || !appkitWalletProvider) {
      setWalletProvider(null);
      setSigner(null);
      setAccount("");
      setWalletChainId(null);
      return;
    }
    (async () => {
      try {
        const bp = new BrowserProvider(appkitWalletProvider as any);
        const s = await bp.getSigner();
        const net = await bp.getNetwork();
        setWalletProvider(bp);
        setSigner(s);
        setAccount(appkitAddress || (await s.getAddress()));
        setWalletChainId(Number(appkitChainId ?? net.chainId));
      } catch {
        // keep UI stable
      }
    })();
  }, [isConnected, appkitWalletProvider, appkitAddress, appkitChainId]);

  function connectWallet() {
    open();
  }

  /** ===== Config + selection ===== */
  const [pub, setPub] = useState<PublicConfig | null>(null);
  const [selChainId, setSelChainId] = useState<number>(56);
  const [selVaultId, setSelVaultId] = useState<string>("");

  const chains: PublicChain[] = useMemo(() => (pub?.chains || []).filter((c) => c?.enabled !== false), [pub]);
  const selectedChain: PublicChain | undefined = useMemo(
    () => chains.find((c) => Number(c.chainId) === Number(selChainId)) || chains[0],
    [chains, selChainId]
  );
  const vaults: PublicVault[] = useMemo(
    () => (selectedChain?.vaults || []).filter((v) => v?.enabled !== false),
    [selectedChain]
  );
  const selectedVault: PublicVault | undefined = useMemo(
    () => vaults.find((v) => vaultKey(v) === String(selVaultId)) || vaults[0],
    [vaults, selVaultId]
  );

  const vaultAddress = resolveVaultAddress(selectedVault);
  const readRpc = (selectedChain?.rpcHttp || "").trim();

  /** ===== Providers + contracts ===== */
  const [rpcProvider, setRpcProvider] = useState<JsonRpcProvider | null>(null);
  useEffect(() => {
    if (!readRpc) {
      setRpcProvider(null);
      return;
    }
    try {
      setRpcProvider(new JsonRpcProvider(readRpc));
    } catch {
      setRpcProvider(null);
    }
  }, [readRpc]);

  const contractRead = useMemo(() => {
    if (!rpcProvider) return null;
    if (!isAddress(vaultAddress)) return null;
    return new Contract(vaultAddress, HAUS_VAULT_ABI, rpcProvider);
  }, [rpcProvider, vaultAddress]);

  const contractWrite = useMemo(() => {
    if (!signer) return null;
    if (!isAddress(vaultAddress)) return null;
    return new Contract(vaultAddress, HAUS_VAULT_ABI, signer);
  }, [signer, vaultAddress]);

  const canWrite = !!contractWrite && !!signer && !!walletProvider && walletChainId === Number(selChainId);

  /** ===== UI state ===== */
  const [tab, setTab] = useState<TabKey>("overview");
  const [busy, setBusy] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [res, setRes] = useState<any>({});

  /** ===== Snapshot ===== */
  const [snap, setSnap] = useState<{
    owner?: string;
    pendingOwner?: string;
    paused?: boolean;
    enforcePairs?: boolean;
    enforceSelectors?: boolean;
    usdc?: string;
    wNative?: string;
    ccipRouter?: string;
    scopeWithdraw?: bigint;
    scopeBridge?: bigint;
    eip712?: {
      fields: string;
      name: string;
      version: string;
      chainId: string;
      verifyingContract: string;
      salt: string;
      extensionsLen: number;
    };
  }>({});

  /** ===== Token rows ===== */
  const [manualTokenAddrs, setManualTokenAddrs] = useState<string[]>([]);
  const [tokenRows, setTokenRows] = useState<TokenRow[]>([]);

  /** ===== Advanced form state (writes) ===== */
  const [fAllowed, setFAllowed] = useState(true);
  const [fTarget, setFTarget] = useState("");
  const [fSelector, setFSelector] = useState("0x");
  const [fPairIn, setFPairIn] = useState("");
  const [fPairOut, setFPairOut] = useState("");
  const [fOperator, setFOperator] = useState("");
  const [fOperatorEnabled, setFOperatorEnabled] = useState(true);
  const [fDestAddr, setFDestAddr] = useState("");
  const [fDestAllowed, setFDestAllowed] = useState(true);
  const [fSwapEnforcePairs, setFSwapEnforcePairs] = useState(false);
  const [fSwapEnforceSelectors, setFSwapEnforceSelectors] = useState(true);
  const [fCapsToken, setFCapsToken] = useState("");
  const [fMaxPerTx, setFMaxPerTx] = useState("");
  const [fMaxTotal, setFMaxTotal] = useState("");
  const [fRemoteChainSel, setFRemoteChainSel] = useState("");
  const [fRemoteVaultAddr, setFRemoteVaultAddr] = useState("");
  const [fRemoteEnabled, setFRemoteEnabled] = useState(true);
  const [fTokenEnableAddr, setFTokenEnableAddr] = useState("");
  const [fTokenDisableAddr, setFTokenDisableAddr] = useState("");
  const [fNewOwner, setFNewOwner] = useState("");

  /** ===== Inspector state ===== */
  const [qToken, setQToken] = useState("");
  const [qSelector, setQSelector] = useState("0x");
  const [qTargetAddr, setQTargetAddr] = useState("");
  const [qPairIn, setQPairIn] = useState("");
  const [qPairOut, setQPairOut] = useState("");
  const [qOwnerWallet, setQOwnerWallet] = useState("");
  const [qToAddr, setQToAddr] = useState("");
  const [qChainSelector, setQChainSelector] = useState("");

  /** ===== Sessions inspector queries ===== */
  const [qSessOwner, setQSessOwner] = useState("");
  const [qSessKey, setQSessKey] = useState("");
  const [qSessEpoch, setQSessEpoch] = useState("");
  const [qSessToken, setQSessToken] = useState("");
  const [qNonceOwner, setQNonceOwner] = useState("");

  /** ===== Helpers ===== */
  function chainLabel(c: PublicChain) {
    return `${c.name || "Chain"} (${c.chainId})`;
  }

  async function ensureWalletOnSelectedChain() {
    if (!walletProvider) throw new Error("Connect wallet first.");
    const current = Number(appkitChainId ?? (await walletProvider.getNetwork()).chainId);
    if (current === Number(selChainId)) {
      setWalletChainId(current);
      return;
    }

    const target = getChainById(Number(selChainId));
    if (switchNetwork && target) {
      await switchNetwork(target as any);
      const net2 = await walletProvider.getNetwork();
      setWalletChainId(Number(net2.chainId));
      return;
    }

    const p: any = appkitWalletProvider;
    if (p?.request) {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHexChainId(selChainId) }] });
      const net2 = await walletProvider.getNetwork();
      setWalletChainId(Number(net2.chainId));
      return;
    }

    throw new Error(`Please switch network to chainId ${selChainId} in your wallet.`);
  }

  /** ===== Load config/public ===== */
  async function loadPublicConfig(opts?: { silent?: boolean }) {
    try {
      const out = (await apiJson(apiBase, "/config/public", { method: "GET" })) as PublicConfig;
      setPub(out);

      const cs = (out?.chains || []).filter((c) => c?.enabled !== false);
      if (!cs.length) return;

      const desired = cs.find((c) => Number(c.chainId) === Number(selChainId)) || cs[0];
      const nextChainId = Number(desired.chainId);

      // if current selection isn't valid, normalize it
      const vs = (desired.vaults || []).filter((v) => v?.enabled !== false);
      const desiredVault = vs.find((v) => vaultKey(v) === String(selVaultId)) || vs[0];

      setSelChainId(nextChainId);
      setSelVaultId(vaultKey(desiredVault) || "");
    } catch (e: any) {
      if (!opts?.silent) setStatusMsg(e?.message ?? "Failed to load /config/public");
    }
  }

  /** ===== Snapshot refresh ===== */
  async function refreshSnapshot() {
    if (!contractRead) return;
    setBusy(true);
    setStatusMsg("");
    try {
      const [
        owner,
        pendingOwner,
        paused,
        enforcePairs,
        enforceSelectors,
        usdc,
        wNative,
        ccipRouter,
        scopeWithdraw,
        scopeBridge,
        eip,
      ] = await Promise.all([
        contractRead.owner(),
        contractRead.pendingOwner(),
        contractRead.paused(),
        contractRead.enforcePairs(),
        contractRead.enforceSelectors(),
        contractRead.usdc(),
        contractRead.wNative(),
        contractRead.ccipRouter(),
        contractRead.SCOPE_WITHDRAW(),
        contractRead.SCOPE_BRIDGE(),
        contractRead.eip712Domain(),
      ]);

      const eip712 = {
        fields: eip[0] as string,
        name: eip[1] as string,
        version: eip[2] as string,
        chainId: (eip[3] as bigint).toString(),
        verifyingContract: eip[4] as string,
        salt: eip[5] as string,
        extensionsLen: (eip[6] as any[])?.length ?? 0,
      };

      setSnap({
        owner,
        pendingOwner,
        paused,
        enforcePairs,
        enforceSelectors,
        usdc,
        wNative,
        ccipRouter,
        scopeWithdraw,
        scopeBridge,
        eip712,
      });

      // convenient defaults for inspector forms
      if (!qToken && isAddress(usdc)) setQToken(usdc);
      if (!fCapsToken && isAddress(usdc)) setFCapsToken(usdc);
    } catch (e: any) {
      setStatusMsg(e?.shortMessage ?? e?.message ?? "Failed to read snapshot.");
      setSnap({});
    } finally {
      setBusy(false);
    }
  }

  /** ===== Token candidates (config-based, per chain) ===== */
  const tokenCandidates = useMemo(() => {
    const out: string[] = [];
    const push = (a?: string, source?: string) => {
      const s = String(a || "").trim();
      if (!s || !isAddress(s)) return;
      out.push(checksumOrLower(s));
    };

    // prefer on-chain usdc/wNative when snapshot is loaded
    push(snap.usdc);
    push(snap.wNative);

    // fallback from config vault fields
    push(selectedVault?.usdc);
    push(selectedVault?.wNative);

    // chain tokens list from system.json
    for (const t of selectedChain?.tokens || []) push(t.address);
    for (const t of selectedVault?.tokens || []) push(t.address);

    // manual tokens added by user
    for (const t of manualTokenAddrs || []) push(t);

    return uniqAddrs(out);
  }, [selectedChain, selectedVault, snap.usdc, snap.wNative, manualTokenAddrs]);

  async function loadTokenRows(addrs: string[]) {
    if (!contractRead || !rpcProvider) return;
    if (!isAddress(vaultAddress)) {
      setTokenRows([]);
      return;
    }

    setTokenBusy(true);
    try {
      const rows: TokenRow[] = await Promise.all(
        (addrs || []).map(async (addrIn) => {
          const addr = checksumOrLower(addrIn);
          const isManual = (manualTokenAddrs || []).some((x) => String(x || "").toLowerCase() === addr.toLowerCase());
          const row: TokenRow = { address: addr, source: isManual ? "manual" : "config" };

          try {
            const erc20 = new Contract(addr, ERC20_ABI as any, rpcProvider);

            const [cfg, gmpt, gmt, bal, sym, decMaybe] = await Promise.all([
              contractRead.tokenConfig(addr),
              contractRead.globalMaxPerTx(addr),
              contractRead.globalMaxTotal(addr),
              erc20.balanceOf(vaultAddress),
              erc20.symbol().catch(() => "TOKEN"),
              erc20.decimals().catch(() => null),
            ]);

            const cfgEnabled = cfg[0] as boolean;
            const cfgDecimals = Number(cfg[1]);
            const dec = decMaybe === null ? cfgDecimals : Number(decMaybe);

            row.cfgEnabled = cfgEnabled;
            row.symbol = String(sym || "TOKEN");
            row.decimals = Number.isFinite(dec) ? dec : cfgDecimals;
            row.vaultBalRaw = (bal as bigint).toString();
            row.vaultBalHuman = formatUnits(bal as bigint, row.decimals || 18);
            row.globalMaxPerTx = (gmpt as bigint).toString();
            row.globalMaxTotal = (gmt as bigint).toString();
          } catch (e: any) {
            row.error = e?.shortMessage ?? e?.message ?? "read failed";
          }

          return row;
        })
      );

      // sort: enabled first, then symbol
      rows.sort((a, b) => {
        const aa = a.cfgEnabled ? 0 : 1;
        const bb = b.cfgEnabled ? 0 : 1;
        if (aa !== bb) return aa - bb;
        const as = String(a.symbol || "");
        const bs = String(b.symbol || "");
        return as.localeCompare(bs);
      });

      setTokenRows(rows);
    } finally {
      setTokenBusy(false);
    }
  }

  async function refreshAll() {
    await refreshSnapshot();
    await loadTokenRows(tokenCandidates);
  }

  /** ===== Initial load config ===== */
  useEffect(() => {
    loadPublicConfig({ silent: true }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ===== When chain/vault changes: clear + refresh ===== */
  useEffect(() => {
    setStatusMsg("");
    setRes({});
    setSnap({});
    setTokenRows([]);

    if (!contractRead) return;
    (async () => {
      await refreshSnapshot();
      await loadTokenRows(tokenCandidates);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selChainId, vaultAddress, readRpc]);

  /** ===== When token candidates change (after snapshot / manual adds), refresh token rows ===== */
  const candidatesKey = useMemo(() => tokenCandidates.map((x) => x.toLowerCase()).join("|"), [tokenCandidates]);
  useEffect(() => {
    if (!contractRead) return;
    loadTokenRows(tokenCandidates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatesKey, vaultAddress]);

  /** ===== Write helpers ===== */
  async function runTx(label: string, fn: () => Promise<any>) {
    if (!contractWrite) {
      setStatusMsg("Connect wallet to send admin transactions.");
      return;
    }
    setBusy(true);
    setStatusMsg(`${label}: preparing…`);
    try {
      await ensureWalletOnSelectedChain();
      const tx = await fn();
      setStatusMsg(`${label}: pending (${tx.hash})`);
      const r = await tx.wait();
      setStatusMsg(`${label}: confirmed (block ${r.blockNumber}).`);
      await refreshAll();
    } catch (e: any) {
      setStatusMsg(`${label}: ${e?.shortMessage ?? e?.message ?? "failed"}`);
    } finally {
      setBusy(false);
    }
  }

  async function actPause() {
    await runTx("pause()", () => contractWrite!.pause());
  }
  async function actUnpause() {
    await runTx("unpause()", () => contractWrite!.unpause());
  }
  async function actAllowTarget() {
    if (!isAddress(fTarget)) return setStatusMsg("Target address invalid.");
    await runTx("allowTarget", () => contractWrite!.allowTarget(fTarget, fAllowed));
  }
  async function actAllowSelector() {
    if (!bytes4Ok(fSelector)) return setStatusMsg("Selector must be bytes4 like 0x12345678.");
    await runTx("allowSelector", () => contractWrite!.allowSelector(fSelector.trim(), fAllowed));
  }
  async function actAllowPair() {
    if (!isAddress(fPairIn) || !isAddress(fPairOut)) return setStatusMsg("tokenIn/tokenOut invalid.");
    await runTx("allowPair", () => contractWrite!.allowPair(fPairIn, fPairOut, fAllowed));
  }
  async function actSetOperator() {
    if (!isAddress(fOperator)) return setStatusMsg("Operator address invalid.");
    await runTx("setOperator", () => contractWrite!.setOperator(fOperator, fOperatorEnabled));
  }
  async function actSetDestAllowed() {
    if (!isAddress(fDestAddr)) return setStatusMsg("Destination address invalid.");
    await runTx("setDestAllowed", () => contractWrite!.setDestAllowed(fDestAddr, fDestAllowed));
  }
  async function actSetSwapGuards() {
    await runTx("setSwapGuards", () => contractWrite!.setSwapGuards(fSwapEnforcePairs, fSwapEnforceSelectors));
  }
  async function actSetGlobalCaps() {
    if (!isAddress(fCapsToken)) return setStatusMsg("Token address invalid.");
    const mpt = toBigIntOrNull(fMaxPerTx);
    const mt = toBigIntOrNull(fMaxTotal);
    if (mpt === null || mt === null) return setStatusMsg("Caps must be uint256 decimal integers.");
    await runTx("setGlobalCaps", () => contractWrite!.setGlobalCaps(fCapsToken, mpt, mt));
  }
  async function actSetRemoteVault() {
    const cs = toBigIntOrNull(fRemoteChainSel);
    if (cs === null) return setStatusMsg("chainSelector must be uint64 decimal integer.");
    if (!isAddress(fRemoteVaultAddr)) return setStatusMsg("vaultAddr invalid.");
    await runTx("setRemoteVault", () => contractWrite!.setRemoteVault(cs, fRemoteVaultAddr, fRemoteEnabled));
  }
  async function actEnableToken() {
    if (!isAddress(fTokenEnableAddr)) return setStatusMsg("Token address invalid.");
    await runTx("enableToken", () => contractWrite!.enableToken(fTokenEnableAddr));
  }
  async function actDisableToken() {
    if (!isAddress(fTokenDisableAddr)) return setStatusMsg("Token address invalid.");
    await runTx("disableToken", () => contractWrite!.disableToken(fTokenDisableAddr));
  }
  async function actTransferOwnership() {
    if (!isAddress(fNewOwner)) return setStatusMsg("newOwner invalid.");
    await runTx("transferOwnership", () => contractWrite!.transferOwnership(fNewOwner));
  }
  async function actAcceptOwnership() {
    await runTx("acceptOwnership()", () => contractWrite!.acceptOwnership());
  }

  /** ===== Read helpers ===== */
  async function runRead(label: string, fn: () => Promise<any>) {
    if (!contractRead) return;
    setBusy(true);
    setStatusMsg("");
    try {
      const out = await fn();
      setRes((x: any) => ({ ...x, [label]: out }));
    } catch (e: any) {
      setStatusMsg(e?.message ?? "Read failed.");
    } finally {
      setBusy(false);
    }
  }

  async function qTokenConfig() {
    if (!isAddress(qToken)) return setStatusMsg("Token address invalid.");
    await runRead("tokenConfig", async () => {
      const r = await contractRead!.tokenConfig(qToken);
      const gmpt = await contractRead!.globalMaxPerTx(qToken);
      const gmt = await contractRead!.globalMaxTotal(qToken);
      return {
        token: qToken,
        enabled: r[0] as boolean,
        decimals: Number(r[1]),
        globalMaxPerTx: (gmpt as bigint).toString(),
        globalMaxTotal: (gmt as bigint).toString(),
      };
    });
  }

  async function qSelectorAllowed() {
    if (!bytes4Ok(qSelector)) return setStatusMsg("Selector must be bytes4 like 0x12345678.");
    await runRead("selectorAllowed", async () => {
      const ok = await contractRead!.selectorAllowed(qSelector.trim());
      return { selector: qSelector.trim(), allowed: ok as boolean };
    });
  }

  async function qTargetAllowed() {
    if (!isAddress(qTargetAddr)) return setStatusMsg("Target address invalid.");
    await runRead("targetAllowed", async () => {
      const ok = await contractRead!.targetAllowed(qTargetAddr);
      return { target: qTargetAddr, allowed: ok as boolean };
    });
  }

  async function qPairAllowed() {
    if (!isAddress(qPairIn) || !isAddress(qPairOut)) return setStatusMsg("tokenIn/tokenOut invalid.");
    await runRead("pairAllowed", async () => {
      const ok = await contractRead!.pairAllowed(qPairIn, qPairOut);
      return { tokenIn: qPairIn, tokenOut: qPairOut, allowed: ok as boolean };
    });
  }

  async function qDestAllowed() {
    if (!isAddress(qOwnerWallet) || !isAddress(qToAddr)) return setStatusMsg("ownerWallet/to invalid.");
    await runRead("destAllowed", async () => {
      const ok = await contractRead!.destAllowed(qOwnerWallet, qToAddr);
      return { ownerWallet: qOwnerWallet, to: qToAddr, allowed: ok as boolean };
    });
  }

  async function qIsOperator() {
    if (!isAddress(qToAddr)) return setStatusMsg("Operator address invalid.");
    await runRead("isOperator", async () => {
      const ok = await contractRead!.isOperator(qToAddr);
      return { operator: qToAddr, enabled: ok as boolean };
    });
  }

  async function qRemoteVault() {
    const cs = toBigIntOrNull(qChainSelector);
    if (cs === null) return setStatusMsg("chainSelector must be uint64 decimal integer.");
    await runRead("remote", async () => {
      const [enabled, vault] = await Promise.all([contractRead!.remoteEnabled(cs), contractRead!.remoteVault(cs)]);
      return { chainSelector: cs.toString(), enabled: enabled as boolean, vault: vault as string };
    });
  }

  async function qNonce() {
    if (!isAddress(qNonceOwner)) return setStatusMsg("Owner address invalid.");
    await runRead("nonces", async () => {
      const n = await contractRead!.nonces(qNonceOwner);
      return { ownerWallet: qNonceOwner, nonce: (n as bigint).toString() };
    });
  }

  async function qActiveSessionKey() {
    if (!isAddress(qSessOwner)) return setStatusMsg("Owner address invalid.");
    await runRead("activeSessionKey", async () => {
      const k = await contractRead!.activeSessionKey(qSessOwner);
      return { ownerWallet: qSessOwner, sessionKey: k as string };
    });
  }

  async function qSessionStruct() {
    if (!isAddress(qSessOwner)) return setStatusMsg("Owner address invalid.");
    if (!isAddress(qSessKey)) return setStatusMsg("Session key invalid.");
    await runRead("sessions", async () => {
      const s = await contractRead!.sessions(qSessOwner, qSessKey);
      return {
        ownerWallet: qSessOwner,
        sessionKey: qSessKey,
        enabled: s[0] as boolean,
        expiry: (s[1] as bigint).toString(),
        scopes: (s[2] as bigint).toString(),
        epoch: (s[3] as bigint).toString(),
        nonce: (s[4] as bigint).toString(),
      };
    });
  }

  async function qSessionTokenGuards() {
    if (!isAddress(qSessOwner)) return setStatusMsg("Owner address invalid.");
    if (!isAddress(qSessKey)) return setStatusMsg("Session key invalid.");
    const epoch = toBigIntOrNull(qSessEpoch);
    if (epoch === null) return setStatusMsg("epoch must be uint64 decimal integer.");
    if (!isAddress(qSessToken)) return setStatusMsg("token address invalid.");

    await runRead("sessionTokenGuards", async () => {
      const [allowed, maxPerTx, remaining] = await Promise.all([
        contractRead!.sessionTokenAllowed(qSessOwner, qSessKey, epoch, qSessToken),
        contractRead!.sessionMaxPerTx(qSessOwner, qSessKey, epoch, qSessToken),
        contractRead!.sessionRemaining(qSessOwner, qSessKey, epoch, qSessToken),
      ]);

      return {
        ownerWallet: qSessOwner,
        sessionKey: qSessKey,
        epoch: epoch.toString(),
        token: qSessToken,
        allowed: allowed as boolean,
        maxPerTx: (maxPerTx as bigint).toString(),
        remaining: (remaining as bigint).toString(),
      };
    });
  }

  function TokenStatusPills(r: TokenRow) {
    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Pill ok={r.source === "config"} text={r.source === "config" ? "From config" : "Manual"} />
        {r.cfgEnabled === undefined ? (
          <Pill ok={false} text="cfg: —" />
        ) : (
          <Pill ok={!!r.cfgEnabled} text={r.cfgEnabled ? "cfg: enabled" : "cfg: disabled"} />
        )}
      </div>
    );
  }

  /** ===== Render ===== */
  return (
    <div className="va-page">
      <div className="va-header">
        <div>
          <div className="va-title">The Haus Vault Admin Console</div>
          <div className="va-subtitle">Select chain + vault (reads via /config/public)</div>
        </div>

        <div className="va-actions">
          <Button kind="ghost" onClick={() => loadPublicConfig({ silent: false })} disabled={busy || tokenBusy}>
            Reload config
          </Button>
          <Button kind="ghost" onClick={refreshAll} disabled={busy || tokenBusy || !contractRead}>
            Refresh vault
          </Button>



          <Button onClick={connectWallet} disabled={busy}>
            {account ? `Wallet: ${shortAddr(account)}` : "Connect Wallet"}
          </Button>
        </div>
      </div>

      {/* Selection bar */}
      <div className="va-topbar" style={{ alignItems: "stretch" }}>
        <div className="va-kvline" style={{ minWidth: 280 }}>
          <div className="va-kvlabel">Chain</div>
          <select
            className="va-select"
            value={String(selectedChain?.chainId ?? selChainId)}
            onChange={(e) => {
              const next = Number(e.target.value);
              setSelChainId(next);
              const c = chains.find((x) => Number(x.chainId) === Number(next));
              const v = (c?.vaults || []).filter((vv) => vv?.enabled !== false)[0];
              setSelVaultId(vaultKey(v) || "");
              setTab("overview");
            }}
          >
            {chains.map((c) => (
              <option key={String(c.chainId)} value={String(c.chainId)}>
                {chainLabel(c)}
              </option>
            ))}
          </select>
        </div>

        <div className="va-kvline" style={{ flex: 1, minWidth: 360 }}>
          <div className="va-kvlabel">Vault</div>
          <select
            className="va-select"
            value={vaultKey(selectedVault) || ""}
            onChange={(e) => {
              setSelVaultId(e.target.value);
              setTab("overview");
            }}
          >
            {vaults.length ? (
              vaults.map((v) => (
                <option key={vaultKey(v) || Math.random().toString(16)} value={vaultKey(v)}>
                  {v.label ? `${v.label} (${vaultKey(v)})` : vaultKey(v)}
                </option>
              ))
            ) : (
              <option value="">No vaults</option>
            )}
          </select>
          <div className="va-mono" style={{ marginTop: 8, opacity: 0.9, wordBreak: "break-all" }}>
            {vaultAddress || "—"}
          </div>
        </div>

        <div className="va-kvline" style={{ minWidth: 220, justifyContent: "space-between" }}>
          <div>
            <div className="va-kvlabel">Wallet chain</div>
            <div className="va-mono">{walletChainId ?? "—"}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center" }}>
            {account && walletChainId === Number(selChainId) ? (
              <Pill ok={true} text="Write enabled" />
            ) : account ? (
              <Pill ok={false} text="Wrong chain" />
            ) : (
              <Pill ok={false} text="Read-only" />
            )}
          </div>
        </div>
      </div>

      {statusMsg ? <div className="va-notice">{statusMsg}</div> : null}

      {/* Tabs */}
      <div className="va-tabs">
        <button className={"va-tab" + (tab === "overview" ? " va-tabActive" : "")} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button className={"va-tab" + (tab === "tokens" ? " va-tabActive" : "")} onClick={() => setTab("tokens")}>
          Tokens
        </button>
        <button className={"va-tab" + (tab === "inspector" ? " va-tabActive" : "")} onClick={() => setTab("inspector")}>
          Inspector
        </button>
        <button className={"va-tab" + (tab === "sessions" ? " va-tabActive" : "")} onClick={() => setTab("sessions")}>
          Sessions
        </button>
        <button className={"va-tab" + (tab === "advanced" ? " va-tabActive" : "")} onClick={() => setTab("advanced")}>
          Advanced
        </button>
      </div>

      {/* ===== Overview Tab ===== */}
      {tab === "overview" ? (
        <div className="va-grid2" style={{ marginTop: 12 }}>
          <div className="va-card">
            <div className="va-cardTitle">Overview</div>
            <div className="va-cardSub">Core state + important addresses</div>

            <div style={{ marginTop: 12 }}>
              <Row label="Chain" value={selectedChain ? chainLabel(selectedChain) : String(selChainId)} />
              <Row label="RPC" value={readRpc || "—"} mono />
              <Row label="Vault" value={vaultAddress ? <MonoAddr v={vaultAddress} /> : "—"} />
              <Row label="Owner" value={snap.owner ? <MonoAddr v={snap.owner} /> : "—"} />
              <Row label="Pending owner" value={snap.pendingOwner ? <MonoAddr v={snap.pendingOwner} /> : "—"} />
              <Row
                label="Paused"
                value={snap.paused === undefined ? "—" : <Pill ok={!snap.paused} text={snap.paused ? "Paused" : "Live"} />}
              />
              <Row
                label="Swap guards"
                value={
                  snap.enforceSelectors === undefined ? (
                    "—"
                  ) : (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Pill ok={!!snap.enforceSelectors} text={`Selectors: ${snap.enforceSelectors ? "ENFORCED" : "off"}`} />
                      <Pill ok={!!snap.enforcePairs} text={`Pairs: ${snap.enforcePairs ? "ENFORCED" : "off"}`} />
                    </div>
                  )
                }
              />
              <Row label="USDC" value={snap.usdc ? <MonoAddr v={snap.usdc} /> : "—"} />
              <Row label="wNative" value={snap.wNative ? <MonoAddr v={snap.wNative} /> : "—"} />
              <Row label="CCIP Router" value={snap.ccipRouter ? <MonoAddr v={snap.ccipRouter} /> : "—"} />
              <Row
                label="Session scopes"
                value={
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span className="va-kv">
                      <span className="va-kvKey">withdraw</span>
                      <span className="va-mono">{snap.scopeWithdraw?.toString() ?? "—"}</span>
                    </span>
                    <span className="va-kv">
                      <span className="va-kvKey">bridge</span>
                      <span className="va-mono">{snap.scopeBridge?.toString() ?? "—"}</span>
                    </span>
                  </div>
                }
              />
            </div>
          </div>

          <div className="va-card">
            <div className="va-cardTitle">EIP-712 Domain</div>
            <div className="va-cardSub">Useful for debugging signatures</div>

            <div style={{ marginTop: 12 }}>
              <Row label="Name" value={snap.eip712?.name} />
              <Row label="Version" value={snap.eip712?.version} />
              <Row label="ChainId" value={snap.eip712?.chainId} mono />
              <Row
                label="Verifying"
                value={snap.eip712?.verifyingContract ? <MonoAddr v={snap.eip712.verifyingContract} /> : "—"}
              />
              <Row label="Salt" value={snap.eip712?.salt ?? "—"} mono />
              <Row label="Fields" value={snap.eip712?.fields ?? "—"} mono />
              <Row label="Extensions" value={snap.eip712?.extensionsLen?.toString() ?? "—"} />
            </div>
          </div>
        </div>
      ) : null}

      {/* ===== Tokens Tab ===== */}
      {tab === "tokens" ? (
        <div className="va-card" style={{ marginTop: 12 }}>
          <div className="va-cardTitle">Tokens</div>
          <div className="va-cardSub">
            Tokens are sourced from your system config (chain.tokens + vault.usdc/wNative). No log scanning.
          </div>

          <div className="va-toolbar">
            <Button kind="ghost" onClick={() => loadTokenRows(tokenCandidates)} disabled={tokenBusy || !contractRead}>
              Refresh tokens
            </Button>
            <div className="va-toolbarMeta">
              Showing <span className="va-mono">{tokenRows.length}</span> tokens {tokenBusy ? <span>(loading…)</span> : null}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <input
              className="va-input va-mono"
              style={{ flex: 1, minWidth: 260 }}
              placeholder="Add token address (0x...)"
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const v = String((e.target as any).value || "").trim();
                if (!isAddress(v)) return setStatusMsg("Token address invalid.");
                (e.target as any).value = "";
                setManualTokenAddrs((p) => uniqAddrs([...p, checksumOrLower(v)]));
                setStatusMsg("");
              }}
            />
            <Button
              kind="ghost"
              onClick={() => {
                setManualTokenAddrs([]);
                setStatusMsg("");
              }}
              disabled={!manualTokenAddrs.length}
            >
              Clear manual
            </Button>
          </div>

          <div className="va-tableWrap">
            <table className="va-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Token</th>
                  <th>Status</th>
                  <th>Vault Balance</th>
                  <th>Raw</th>
                  <th>Global Max/Tx</th>
                  <th>Global Max Total</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tokenRows.map((r) => (
                  <tr key={r.address}>
                    <td className="va-mono">{r.symbol ?? "—"}</td>
                    <td className="va-mono" style={{ wordBreak: "break-all" }}>
                      {r.address}
                    </td>
                    <td>{TokenStatusPills(r)}</td>
                    <td className="va-mono">{r.vaultBalHuman ?? "—"}</td>
                    <td className="va-mono">{r.vaultBalRaw ?? "—"}</td>
                    <td className="va-mono">{r.globalMaxPerTx ?? "—"}</td>
                    <td className="va-mono">{r.globalMaxTotal ?? "—"}</td>
                    <td>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Button
                          kind="ghost"
                          onClick={() => {
                            setFTokenEnableAddr(r.address);
                            setTab("advanced");
                          }}
                          disabled={!isAddress(r.address)}
                        >
                          Enable…
                        </Button>
                        <Button
                          kind="ghost"
                          onClick={() => {
                            setFTokenDisableAddr(r.address);
                            setTab("advanced");
                          }}
                          disabled={!isAddress(r.address)}
                        >
                          Disable…
                        </Button>
                      </div>
                      {r.error ? <div className="va-mono" style={{ opacity: 0.85 }}>⚠ {r.error}</div> : null}
                    </td>
                  </tr>
                ))}
                {!tokenRows.length ? (
                  <tr>
                    <td colSpan={8} style={{ padding: 14, color: "rgba(255,255,255,0.75)" }}>
                      No tokens yet. Check your system.json chain.tokens, and that the vault is reachable on the selected RPC.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* ===== Inspector Tab ===== */}
      {tab === "inspector" ? (
        <div className="va-card" style={{ marginTop: 12 }}>
          <div className="va-cardTitle">Inspector</div>
          <div className="va-cardSub">Paste any values to query on the selected chain + vault.</div>

          <div className="va-actionGrid" style={{ marginTop: 12 }}>
            <div className="va-actionCard">
              <div className="va-actionTitle">tokenConfig + global caps</div>

              <div className="va-formStack">
                <input
                  className="va-input va-mono"
                  placeholder="token 0x…"
                  value={qToken}
                  onChange={(e) => setQToken(e.target.value)}
                />

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Button kind="ghost" onClick={qTokenConfig} disabled={busy}>
                    Query
                  </Button>
                  {snap.usdc ? (
                    <Button kind="ghost" onClick={() => setQToken(snap.usdc!)} disabled={busy}>
                      Use USDC
                    </Button>
                  ) : null}
                  {snap.wNative ? (
                    <Button kind="ghost" onClick={() => setQToken(snap.wNative!)} disabled={busy}>
                      Use wNative
                    </Button>
                  ) : null}
                </div>
              </div>

              {res.tokenConfig ? (
                <ResultBox>
                  <div>
                    <MonoAddr v={res.tokenConfig.token} />
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                    <Pill ok={res.tokenConfig.enabled} text={res.tokenConfig.enabled ? "Enabled" : "Disabled"} />
                    <span className="va-kv">
                      <span className="va-kvKey">decimals</span>
                      <span className="va-mono">{res.tokenConfig.decimals}</span>
                    </span>
                    <span className="va-kv">
                      <span className="va-kvKey">globalMaxPerTx</span>
                      <span className="va-mono">{res.tokenConfig.globalMaxPerTx}</span>
                    </span>
                    <span className="va-kv">
                      <span className="va-kvKey">globalMaxTotal</span>
                      <span className="va-mono">{res.tokenConfig.globalMaxTotal}</span>
                    </span>
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">selectorAllowed(bytes4)</div>
              <input
                className="va-input va-mono"
                placeholder="0x12345678"
                value={qSelector}
                onChange={(e) => setQSelector(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qSelectorAllowed} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.selectorAllowed ? (
                <ResultBox>
                  <div className="va-mono">{res.selectorAllowed.selector}</div>
                  <div style={{ marginTop: 8 }}>
                    <Pill ok={res.selectorAllowed.allowed} text={res.selectorAllowed.allowed ? "Allowed" : "Blocked"} />
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">targetAllowed(target)</div>
              <input
                className="va-input va-mono"
                placeholder="target 0x…"
                value={qTargetAddr}
                onChange={(e) => setQTargetAddr(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qTargetAllowed} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.targetAllowed ? (
                <ResultBox>
                  <div>
                    <MonoAddr v={res.targetAllowed.target} />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Pill ok={res.targetAllowed.allowed} text={res.targetAllowed.allowed ? "Allowed" : "Blocked"} />
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">pairAllowed(tokenIn, tokenOut)</div>
              <input
                className="va-input va-mono"
                placeholder="tokenIn 0x…"
                value={qPairIn}
                onChange={(e) => setQPairIn(e.target.value)}
              />
              <input
                className="va-input va-mono"
                style={{ marginTop: 8 }}
                placeholder="tokenOut 0x…"
                value={qPairOut}
                onChange={(e) => setQPairOut(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qPairAllowed} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.pairAllowed ? (
                <ResultBox>
                  <div>
                    <MonoAddr v={res.pairAllowed.tokenIn} />
                  </div>
                  <div>
                    <MonoAddr v={res.pairAllowed.tokenOut} />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Pill ok={res.pairAllowed.allowed} text={res.pairAllowed.allowed ? "Allowed" : "Blocked"} />
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">destAllowed(ownerWallet, to)</div>
              <input
                className="va-input va-mono"
                placeholder="ownerWallet 0x…"
                value={qOwnerWallet}
                onChange={(e) => setQOwnerWallet(e.target.value)}
              />
              <input
                className="va-input va-mono"
                style={{ marginTop: 8 }}
                placeholder="to 0x…"
                value={qToAddr}
                onChange={(e) => setQToAddr(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qDestAllowed} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.destAllowed ? (
                <ResultBox>
                  <div>
                    <MonoAddr v={res.destAllowed.ownerWallet} />
                  </div>
                  <div>
                    <MonoAddr v={res.destAllowed.to} />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Pill ok={res.destAllowed.allowed} text={res.destAllowed.allowed ? "Allowed" : "Blocked"} />
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">isOperator(op)</div>
              <input
                className="va-input va-mono"
                placeholder="op 0x…"
                value={qToAddr}
                onChange={(e) => setQToAddr(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qIsOperator} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.isOperator ? (
                <ResultBox>
                  <div>
                    <MonoAddr v={res.isOperator.operator} />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Pill ok={res.isOperator.enabled} text={res.isOperator.enabled ? "Enabled" : "Disabled"} />
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Remote (CCIP) mapping</div>
              <input
                className="va-input"
                placeholder="chainSelector (uint64)"
                value={qChainSelector}
                onChange={(e) => setQChainSelector(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qRemoteVault} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.remote ? (
                <ResultBox>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span className="va-kv">
                      <span className="va-kvKey">chainSelector</span>
                      <span className="va-mono">{res.remote.chainSelector}</span>
                    </span>
                    <Pill ok={res.remote.enabled} text={res.remote.enabled ? "Enabled" : "Disabled"} />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <MonoAddr v={res.remote.vault} />
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">nonces(ownerWallet)</div>
              <input
                className="va-input va-mono"
                placeholder="ownerWallet 0x…"
                value={qNonceOwner}
                onChange={(e) => setQNonceOwner(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qNonce} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.nonces ? (
                <ResultBox>
                  <div>
                    <MonoAddr v={res.nonces.ownerWallet} />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <span className="va-kv">
                      <span className="va-kvKey">nonce</span>
                      <span className="va-mono">{res.nonces.nonce}</span>
                    </span>
                  </div>
                </ResultBox>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* ===== Sessions Tab ===== */}
      {tab === "sessions" ? (
        <div className="va-card" style={{ marginTop: 12 }}>
          <div className="va-cardTitle">Session Inspector</div>
          <div className="va-cardSub">Active session + session struct + per-token limits</div>

          <div className="va-actionGrid" style={{ marginTop: 12 }}>
            <div className="va-actionCard">
              <div className="va-actionTitle">activeSessionKey(ownerWallet)</div>
              <input
                className="va-input va-mono"
                placeholder="ownerWallet 0x…"
                value={qSessOwner}
                onChange={(e) => setQSessOwner(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qActiveSessionKey} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.activeSessionKey ? (
                <ResultBox>
                  <div>
                    <MonoAddr v={res.activeSessionKey.ownerWallet} />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <span className="va-kv">
                      <span className="va-kvKey">sessionKey</span>
                      <span className="va-mono">{res.activeSessionKey.sessionKey}</span>
                    </span>
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">sessions(ownerWallet, sessionKey)</div>
              <input
                className="va-input va-mono"
                placeholder="ownerWallet 0x…"
                value={qSessOwner}
                onChange={(e) => setQSessOwner(e.target.value)}
              />
              <input
                className="va-input va-mono"
                style={{ marginTop: 8 }}
                placeholder="sessionKey 0x…"
                value={qSessKey}
                onChange={(e) => setQSessKey(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qSessionStruct} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.sessions ? (
                <ResultBox>
                  <div>
                    <MonoAddr v={res.sessions.ownerWallet} />
                  </div>
                  <div>
                    <MonoAddr v={res.sessions.sessionKey} />
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                    <Pill ok={res.sessions.enabled} text={res.sessions.enabled ? "Enabled" : "Disabled"} />
                    <span className="va-kv">
                      <span className="va-kvKey">expiry</span>
                      <span className="va-mono">{res.sessions.expiry}</span>
                    </span>
                    <span className="va-kv">
                      <span className="va-kvKey">scopes</span>
                      <span className="va-mono">{res.sessions.scopes}</span>
                    </span>
                    <span className="va-kv">
                      <span className="va-kvKey">epoch</span>
                      <span className="va-mono">{res.sessions.epoch}</span>
                    </span>
                    <span className="va-kv">
                      <span className="va-kvKey">nonce</span>
                      <span className="va-mono">{res.sessions.nonce}</span>
                    </span>
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Session token guards</div>
              <input
                className="va-input va-mono"
                placeholder="ownerWallet 0x…"
                value={qSessOwner}
                onChange={(e) => setQSessOwner(e.target.value)}
              />
              <input
                className="va-input va-mono"
                style={{ marginTop: 8 }}
                placeholder="sessionKey 0x…"
                value={qSessKey}
                onChange={(e) => setQSessKey(e.target.value)}
              />
              <input
                className="va-input"
                style={{ marginTop: 8 }}
                placeholder="epoch (uint64)"
                value={qSessEpoch}
                onChange={(e) => setQSessEpoch(e.target.value)}
              />
              <input
                className="va-input va-mono"
                style={{ marginTop: 8 }}
                placeholder="token 0x…"
                value={qSessToken}
                onChange={(e) => setQSessToken(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={qSessionTokenGuards} disabled={busy}>
                  Query
                </Button>
              </div>
              {res.sessionTokenGuards ? (
                <ResultBox>
                  <div>
                    <MonoAddr v={res.sessionTokenGuards.ownerWallet} />
                  </div>
                  <div>
                    <MonoAddr v={res.sessionTokenGuards.sessionKey} />
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span className="va-kv">
                      <span className="va-kvKey">epoch</span>
                      <span className="va-mono">{res.sessionTokenGuards.epoch}</span>
                    </span>
                    <span className="va-kv">
                      <span className="va-kvKey">token</span>
                      <span className="va-mono">{res.sessionTokenGuards.token}</span>
                    </span>
                    <Pill ok={res.sessionTokenGuards.allowed} text={res.sessionTokenGuards.allowed ? "Allowed" : "Blocked"} />
                    <span className="va-kv">
                      <span className="va-kvKey">maxPerTx</span>
                      <span className="va-mono">{res.sessionTokenGuards.maxPerTx}</span>
                    </span>
                    <span className="va-kv">
                      <span className="va-kvKey">remaining</span>
                      <span className="va-mono">{res.sessionTokenGuards.remaining}</span>
                    </span>
                  </div>
                </ResultBox>
              ) : null}
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Safety notes</div>
              <ul className="va-ul">
                <li>
                  <b>Selectors enforced</b> = swaps must match allowlisted selector.
                </li>
                <li>
                  <b>Pairs enforced</b> = swaps must match allowlisted pair.
                </li>
                <li>
                  Session token limits are keyed by <span className="va-mono">(ownerWallet, sessionKey, epoch, token)</span>.
                </li>
                <li>Always confirm remote vault mapping before enabling CCIP receives.</li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {/* ===== Advanced Tab (writes) ===== */}
      {tab === "advanced" ? (
        <div className="va-card" style={{ marginTop: 12 }}>
          <div className="va-cardTitle">Admin Actions</div>
          <div className="va-cardSub">Wallet must be on the selected chain to send admin txs.</div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <Button
              kind="ghost"
              onClick={async () => {
                try {
                  setBusy(true);
                  await ensureWalletOnSelectedChain();
                  setStatusMsg("Wallet network matches selected chain.");
                } catch (e: any) {
                  setStatusMsg(e?.message ?? "Network switch failed.");
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy || !walletProvider}
            >
              Switch network
            </Button>
          </div>

          <div className="va-actionGrid" style={{ marginTop: 12 }}>
            <div className="va-actionCard">
              <div className="va-actionTitle">Pause Control</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button kind="danger" onClick={actPause} disabled={busy || !canWrite}>
                  pause()
                </Button>
                <Button onClick={actUnpause} disabled={busy || !canWrite}>
                  unpause()
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Swap Guards</div>
              <div style={{ display: "grid", gap: 10 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={fSwapEnforcePairs} onChange={(e) => setFSwapEnforcePairs(e.target.checked)} />
                  Enforce Pairs
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={fSwapEnforceSelectors}
                    onChange={(e) => setFSwapEnforceSelectors(e.target.checked)}
                  />
                  Enforce Selectors
                </label>
                <Button onClick={actSetSwapGuards} disabled={busy || !canWrite}>
                  setSwapGuards(enforcePairs, enforceSelectors)
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Allow Target</div>
              <input className="va-input va-mono" placeholder="target 0x…" value={fTarget} onChange={(e) => setFTarget(e.target.value)} />
              <div className="va-formRow" style={{ marginTop: 10 }}>
                <select className="va-select" value={String(fAllowed)} onChange={(e) => setFAllowed(e.target.value === "true")}>
                  <option value="true">Allowed</option>
                  <option value="false">Blocked</option>
                </select>
                <Button onClick={actAllowTarget} disabled={busy || !canWrite}>
                  allowTarget
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Allow Selector</div>
              <input className="va-input va-mono" placeholder="bytes4 0x12345678" value={fSelector} onChange={(e) => setFSelector(e.target.value)} />
              <div className="va-formRow" style={{ marginTop: 10 }}>
                <select className="va-select" value={String(fAllowed)} onChange={(e) => setFAllowed(e.target.value === "true")}>
                  <option value="true">Allowed</option>
                  <option value="false">Blocked</option>
                </select>
                <Button onClick={actAllowSelector} disabled={busy || !canWrite}>
                  allowSelector
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Allow Pair</div>
              <input className="va-input va-mono" placeholder="tokenIn 0x…" value={fPairIn} onChange={(e) => setFPairIn(e.target.value)} />
              <input className="va-input va-mono" style={{ marginTop: 8 }} placeholder="tokenOut 0x…" value={fPairOut} onChange={(e) => setFPairOut(e.target.value)} />
              <div className="va-formRow" style={{ marginTop: 10 }}>
                <select className="va-select" value={String(fAllowed)} onChange={(e) => setFAllowed(e.target.value === "true")}>
                  <option value="true">Allowed</option>
                  <option value="false">Blocked</option>
                </select>
                <Button onClick={actAllowPair} disabled={busy || !canWrite}>
                  allowPair
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Operator</div>
              <input className="va-input va-mono" placeholder="operator 0x…" value={fOperator} onChange={(e) => setFOperator(e.target.value)} />
              <div className="va-formRow" style={{ marginTop: 10 }}>
                <select
                  className="va-select"
                  value={String(fOperatorEnabled)}
                  onChange={(e) => setFOperatorEnabled(e.target.value === "true")}
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
                <Button onClick={actSetOperator} disabled={busy || !canWrite}>
                  setOperator
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Destination Allowlist</div>
              <input className="va-input va-mono" placeholder="to 0x…" value={fDestAddr} onChange={(e) => setFDestAddr(e.target.value)} />
              <div className="va-formRow" style={{ marginTop: 10 }}>
                <select className="va-select" value={String(fDestAllowed)} onChange={(e) => setFDestAllowed(e.target.value === "true")}>
                  <option value="true">Allowed</option>
                  <option value="false">Blocked</option>
                </select>
                <Button onClick={actSetDestAllowed} disabled={busy || !canWrite}>
                  setDestAllowed
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Global Caps</div>
              <input className="va-input va-mono" placeholder="token 0x…" value={fCapsToken} onChange={(e) => setFCapsToken(e.target.value)} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
                <input className="va-input" placeholder="maxPerTx (uint256)" value={fMaxPerTx} onChange={(e) => setFMaxPerTx(e.target.value)} />
                <input className="va-input" placeholder="maxTotal (uint256)" value={fMaxTotal} onChange={(e) => setFMaxTotal(e.target.value)} />
              </div>
              <div style={{ marginTop: 10 }}>
                <Button onClick={actSetGlobalCaps} disabled={busy || !canWrite}>
                  setGlobalCaps
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Remote Vault (CCIP)</div>
              <input className="va-input" placeholder="chainSelector (uint64)" value={fRemoteChainSel} onChange={(e) => setFRemoteChainSel(e.target.value)} />
              <input className="va-input va-mono" style={{ marginTop: 8 }} placeholder="vaultAddr 0x…" value={fRemoteVaultAddr} onChange={(e) => setFRemoteVaultAddr(e.target.value)} />
              <div className="va-formRow" style={{ marginTop: 10 }}>
                <select className="va-select" value={String(fRemoteEnabled)} onChange={(e) => setFRemoteEnabled(e.target.value === "true")}>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
                <Button onClick={actSetRemoteVault} disabled={busy || !canWrite}>
                  setRemoteVault
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Token Enable / Disable</div>
              <input
                className="va-input va-mono"
                placeholder="enableToken(token) — 0x…"
                value={fTokenEnableAddr}
                onChange={(e) => setFTokenEnableAddr(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button onClick={actEnableToken} disabled={busy || !canWrite}>
                  enableToken
                </Button>
              </div>

              <div style={{ height: 10 }} />

              <input
                className="va-input va-mono"
                placeholder="disableToken(token) — 0x…"
                value={fTokenDisableAddr}
                onChange={(e) => setFTokenDisableAddr(e.target.value)}
              />
              <div style={{ marginTop: 10 }}>
                <Button kind="danger" onClick={actDisableToken} disabled={busy || !canWrite}>
                  disableToken
                </Button>
              </div>
            </div>

            <div className="va-actionCard">
              <div className="va-actionTitle">Ownership</div>
              <input className="va-input va-mono" placeholder="newOwner 0x…" value={fNewOwner} onChange={(e) => setFNewOwner(e.target.value)} />
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                <Button onClick={actTransferOwnership} disabled={busy || !canWrite}>
                  transferOwnership
                </Button>
                <Button kind="ghost" onClick={actAcceptOwnership} disabled={busy || !canWrite}>
                  acceptOwnership
                </Button>
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.78)" }}>
                acceptOwnership must be sent by the pending owner.
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
