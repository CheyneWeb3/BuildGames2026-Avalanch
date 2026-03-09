// src/pages/UserWalletPage.tsx
// Vault UX (multi-token) with wNative native wrap/unwrap handled by vault when requested.
//
// Key behaviors (based on your HausCashierVaultV3 + current core-api zip):
// - Vault stores ONLY ERC20 tokens (including wNative). It can accept native deposits via depositNativeFor (wraps inside).
// - Withdraw intents are created via core-api.
// - IMPORTANT backend detail (FROM YOUR CURRENT ZIP):
//   ✅ POST /vault/intents/withdraw reads body.signature (string) and body.deadline (Number coercion must succeed).
//
// Ethers v6 only (no wagmi).

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  formatUnits,
  parseUnits,
} from "ethers";
import "./VaultAdminPage.css";
import { useApiBase, useApiBaseState } from "../../ApiBaseContext";

function shortAddr(a?: string) {
  if (!a) return "";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function isHexAddressMaybe(a?: string) {
  const s = (a || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    kind?: "primary" | "ghost" | "danger";
    leftIcon?: React.ReactNode;
  }
) {
  const kind = props.kind ?? "primary";
  const cls =
    "va-btn " +
    (kind === "primary"
      ? "va-btnPrimary"
      : kind === "danger"
        ? "va-btnDanger"
        : "va-btnGhost") +
    (props.disabled ? " va-btnDisabled" : "");
  return (
    <button {...props} className={cls}>
      {props.leftIcon ? <span className="va-btnIcon">{props.leftIcon}</span> : null}
      <span>{props.children}</span>
    </button>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="va-row">
      <div className="va-rowLabel">{label}</div>
      <div className={"va-rowValue" + (mono ? " va-mono" : "")}>{value ?? "—"}</div>
    </div>
  );
}

/** ===== Modal ===== */
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="va-modalBackdrop" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="va-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="va-modalHeader">
          <div className="va-modalTitle">{title}</div>
          <button className="va-modalClose" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="va-modalBody">{children}</div>
        {footer ? <div className="va-modalFooter">{footer}</div> : null}
      </div>
    </div>
  );
}

const LS_JWT = "haus_user_jwt";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

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
    const serverMsg = data?.error || data?.message || data?.raw || "";
    const msg = serverMsg ? `${serverMsg}` : `${r.status} ${r.statusText}`;
    throw new Error(msg);
  }

  return data;
}

function isZeroAddr(a?: string) {
  if (!a) return true;
  return a.toLowerCase() === ZERO_ADDR;
}

function nowRefId(prefix: string) {
  const rnd = Math.random().toString(16).slice(2);
  return `${prefix}:${Date.now()}:${rnd}`;
}

function looksLikeRpcTimeout(err: any) {
  const m = String(err?.message || err || "");
  return (
    m.includes("524") ||
    m.includes("timeout") ||
    m.includes("SERVER_ERROR") ||
    m.includes("failed") ||
    m.includes("NetworkError")
  );
}

/** ====== Types that match /config/public (tolerant) ====== */
type PublicToken = {
  symbol?: string;
  address: string;
  decimals?: number;
  enabled?: boolean;
};

type PublicVault = {
  id?: string; // /config/public uses `id` for vaultId
  vaultId?: string; // tolerate older schemas
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

type PublicConfig = {
  ok?: boolean;
  chains?: PublicChain[];
};

type BalanceItem = {
  chainId: number;
  token: string;

  balanceRaw?: string;

  availableRaw?: string;
  heldRaw?: string;
  totalRaw?: string;

  updatedAt?: string;
};

type LedgerItem = {
  refId: string;
  ts: string;
  kind: string;
  chainId: number;
  token: string;
  moduleId?: string;
  fromAccountId?: string;
  toAccountId?: string;
  amountRaw: string;
  meta?: any;
};

type VaultIntentItem = {
  refId: string;
  kind: string;
  status: string;
  chainId: number;
  vaultId: string;
  token: string;
  to?: string;

  amountRaw?: string;
  debitRaw?: string;

  txHash?: string;
  tries?: number;
  nextAttemptAt?: string;

  createdAt?: string;
  updatedAt?: string;
  error?: string;
};

type TabKey = "balances" | "deposit" | "withdraw" | "ledger" | "intents";

type RuntimeToken = {
  address: string;
  symbol: string;
  decimals: number;
  enabled: boolean;
  source: "config" | "vault";
};

type TokenListToken = {
  chainId: number;
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  logoURI?: string;
};
type TokenList = {
  name?: string;
  timestamp?: string;
  version?: { major: number; minor: number; patch: number };
  tokens?: TokenListToken[];
};

/** ====== Helpers ====== */
function vaultKey(v?: PublicVault) {
  return String(v?.vaultId ?? v?.id ?? "");
}

function resolveVaultAddress(v?: PublicVault) {
  return (v?.vaultAddress || v?.address || "").trim();
}

function dedupeAdd(list: string[], addr?: string) {
  const a = (addr || "").trim();
  if (!a) return list;
  const low = a.toLowerCase();
  if (low === ZERO_ADDR) return list;
  if (list.some((x) => x.toLowerCase() === low)) return list;
  list.push(a);
  return list;
}

function pickReadProvider(chain?: PublicChain, walletProvider?: BrowserProvider | null) {
  const rpc = (chain?.rpcHttp || "").trim();
  if (rpc) return new JsonRpcProvider(rpc);
  return walletProvider ?? null;
}

function toHexChainId(chainId: number) {
  return "0x" + Number(chainId).toString(16);
}

/**
 * Ethers v6 signTypedData expects:
 * - domain: { name, version, chainId, verifyingContract, ... }
 * - types: WITHOUT EIP712Domain
 */
function sanitizeTypedData(td: any) {
  const domain = { ...(td?.domain || {}) };

  if (domain?.chainId != null) {
    const n = Number(domain.chainId);
    if (!Number.isNaN(n)) domain.chainId = n;
  }

  const typesIn = { ...(td?.types || {}) };
  if ((typesIn as any)?.EIP712Domain) {
    delete (typesIn as any).EIP712Domain;
  }

  const message = { ...(td?.message || {}) };

  return { domain, types: typesIn, message };
}

function safeBigInt(raw?: string) {
  try {
    if (!raw) return 0n;
    const s = String(raw).trim();
    if (!s) return 0n;
    if (!/^\d+$/.test(s)) return 0n;
    return BigInt(s);
  } catch {
    return 0n;
  }
}

function formatAmount(raw: string | undefined, decimals: number, maxFrac = 6) {
  const bi = safeBigInt(raw);
  const full = formatUnits(bi, decimals);
  // Trim for friendly UI
  if (!full.includes(".")) return full;
  const [a, b] = full.split(".");
  const trimmed = (b || "").slice(0, maxFrac).replace(/0+$/g, "");
  return trimmed ? `${a}.${trimmed}` : a;
}

function chainExplorerTx(chainId: number, txHash?: string) {
  const h = (txHash || "").trim();
  if (!h) return "";
  // Only mapping what you’re actively using now; extend later per your config.
  if (chainId === 56) return `https://bscscan.com/tx/${h}`;
  return "";
}

/** ====== Minimal ABIs we actually use ====== */
const VAULT_READ_ABI = [
  "function usdc() view returns (address)",
  "function wNative() view returns (address)",
  "function tokenConfig(address token) view returns (bool enabled, uint8 decimals)",
] as const;

const VAULT_WRITE_ABI = [
  "function depositFor(address token, uint256 amount, address creditTo)",
  "function depositNativeFor(address creditTo) payable",
] as const;

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
] as const;

async function tryCallSymbol(readProvider: any, tokenAddr: string): Promise<string | null> {
  try {
    const c = new Contract(tokenAddr, ERC20_ABI, readProvider);
    const s: string = await c.symbol();
    if (!s) return null;
    return String(s);
  } catch {
    return null;
  }
}

export default function UserWalletPage() {
  const apiBase = useApiBase();
  const apiState = useApiBaseState();

  const [walletProvider, setWalletProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState<string>("");
  const [walletChainId, setWalletChainId] = useState<number | null>(null);

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || "");
  const authed = !!jwt;

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  // Friendly alert state (don’t spam in-page notice; modal for “actions”)
  const statusTimeoutRef = useRef<number | null>(null);
  function setStatusFriendly(msg: string) {
    setStatusMsg(msg);
    if (statusTimeoutRef.current) window.clearTimeout(statusTimeoutRef.current);
    statusTimeoutRef.current = window.setTimeout(() => setStatusMsg(""), 9000);
  }

  const authHeaders = useMemo(() => (jwt ? { Authorization: `Bearer ${jwt}` } : {}), [jwt]);

  // Data
  const [pub, setPub] = useState<PublicConfig | null>(null);
  const [balances, setBalances] = useState<BalanceItem[]>([]);
  const [ledger, setLedger] = useState<LedgerItem[]>([]);
  const [intents, setIntents] = useState<VaultIntentItem[]>([]);

  // Token list (public/tokenlist.json)
  const [tokenList, setTokenList] = useState<TokenList | null>(null);

  // Selections
  const [chainId, setChainId] = useState<number>(56);
  const [vaultId, setVaultId] = useState<string>("");
  const [tokenAddr, setTokenAddr] = useState<string>("");

  // Runtime resolved
  const [runtimeTokens, setRuntimeTokens] = useState<RuntimeToken[]>([]);
  const [vaultUsdc, setVaultUsdc] = useState<string>("");
  const [vaultWNative, setVaultWNative] = useState<string>("");

  // Tabs
  const [tab, setTab] = useState<TabKey>("balances");

  // Deposit form
  const [depositAmount, setDepositAmount] = useState<string>("0.001");
  const [depositUseNative, setDepositUseNative] = useState<boolean>(true);

  // Withdraw form
  const [withdrawTo, setWithdrawTo] = useState<string>("");
  const [withdrawAmount, setWithdrawAmount] = useState<string>("0.0005");
  const [withdrawAsNative, setWithdrawAsNative] = useState<boolean>(true);

  // Action modals
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [txModalTitle, setTxModalTitle] = useState<string>("Transaction");
  const [txModalBody, setTxModalBody] = useState<React.ReactNode>(null);

  function openTxModal(title: string, body: React.ReactNode) {
    setTxModalTitle(title);
    setTxModalBody(body);
    setTxModalOpen(true);
  }

  const chains: PublicChain[] = pub?.chains || [];
  const selectedChain = chains.find((c) => Number(c.chainId) === Number(chainId)) || chains[0];

  const vaults: PublicVault[] = selectedChain?.vaults || [];
  const selectedVault = vaults.find((v) => vaultKey(v) === String(vaultId)) || vaults[0];

  const resolvedVaultId = vaultKey(selectedVault);
  const vaultAddress = resolveVaultAddress(selectedVault);

  const readProvider = useMemo(
    () => pickReadProvider(selectedChain, walletProvider),
    [selectedChain?.rpcHttp, walletProvider]
  );

  const selectedToken = useMemo(
    () =>
      runtimeTokens.find(
        (t) => t.address.toLowerCase() === (tokenAddr || "").toLowerCase()
      ) || null,
    [runtimeTokens, tokenAddr]
  );

  const decimals = Number(selectedToken?.decimals ?? 18);
  const symbol = (selectedToken?.symbol || "TOKEN").toUpperCase();

  // Tokenlist lookup map
  const tokenListMap = useMemo(() => {
    const m = new Map<string, TokenListToken>();
    const items = tokenList?.tokens || [];
    for (const t of items) {
      const addr = (t.address || "").toLowerCase();
      if (!addr) continue;
      // prefer exact chain match; if duplicates exist, keep the one matching current chainId
      const existing = m.get(addr);
      if (!existing) {
        m.set(addr, t);
      } else if (Number(t.chainId) === Number(chainId) && Number(existing.chainId) !== Number(chainId)) {
        m.set(addr, t);
      }
    }
    return m;
  }, [tokenList, chainId]);

  function logoForToken(addr: string) {
    const t = tokenListMap.get((addr || "").toLowerCase());
    const uri = (t?.logoURI || "").trim();
    return uri;
  }

  const isSelectedWNative = useMemo(() => {
    const wn = (vaultWNative || "").toLowerCase();
    const ta = (tokenAddr || "").toLowerCase();
    return !!wn && !!ta && wn === ta;
  }, [vaultWNative, tokenAddr]);

  /** ===== Balances: find available for selected token ===== */
  const selectedBalance = useMemo(() => {
    const ta = (tokenAddr || "").toLowerCase();
    const item = (balances || []).find(
      (b) => String(b.chainId) === String(chainId) && (b.token || "").toLowerCase() === ta
    );
    if (!item) return null;

    const availableRaw = item.availableRaw ?? (item.balanceRaw ?? "");
    const heldRaw = item.heldRaw ?? "";
    const totalRaw = item.totalRaw ?? (item.balanceRaw ?? "");

    return {
      ...item,
      availableRaw,
      heldRaw,
      totalRaw,
      availableBI: safeBigInt(availableRaw),
      heldBI: safeBigInt(heldRaw),
      totalBI: safeBigInt(totalRaw),
    };
  }, [balances, tokenAddr, chainId]);

  const selectedAvailableHuman = useMemo(() => {
    if (!selectedBalance) return "0";
    return formatAmount(String(selectedBalance.availableRaw || "0"), decimals, 8);
  }, [selectedBalance, decimals]);

  /** ===== Withdraw button disable if exceeds available ===== */
  const withdrawDraftWei = useMemo(() => {
    try {
      const amt = parseUnits(withdrawAmount || "0", decimals);
      return amt > 0n ? amt : 0n;
    } catch {
      return 0n;
    }
  }, [withdrawAmount, decimals]);

  const withdrawExceedsBalance = useMemo(() => {
    if (!selectedBalance) return false;
    return withdrawDraftWei > (selectedBalance.availableBI ?? 0n);
  }, [withdrawDraftWei, selectedBalance]);

  const withdrawDisabledReason = useMemo(() => {
    if (!authed) return "Sign in first";
    if (!walletProvider) return "Connect wallet first";
    if (!tokenAddr || isZeroAddr(tokenAddr)) return "Select a token";
    if (!withdrawTo || !isHexAddressMaybe(withdrawTo)) return "Enter a valid to address";
    if (withdrawDraftWei <= 0n) return "Enter an amount > 0";
    if (!selectedBalance) return "No balance loaded (refresh balances)";
    if (withdrawExceedsBalance) return "Insufficient cashier balance";
    return "";
  }, [
    authed,
    walletProvider,
    tokenAddr,
    withdrawTo,
    withdrawDraftWei,
    selectedBalance,
    withdrawExceedsBalance,
  ]);

  /** ===== Wallet listeners ===== */
  useEffect(() => {
    const eth = (window as any).ethereum;
    if (!eth) return;

    const onChainChanged = () => {
      (async () => {
        try {
          if (!walletProvider) return;
          const net = await walletProvider.getNetwork();
          setWalletChainId(Number(net.chainId));
        } catch { }
      })();
    };

    eth.on?.("chainChanged", onChainChanged);
    return () => eth.removeListener?.("chainChanged", onChainChanged);
  }, [walletProvider]);

  /** ===== Auto-load config + tokenlist on first mount ===== */
  useEffect(() => {
    loadPublicConfig().catch(() => { });
    loadTokenList().catch(() => { });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ===== When vault changes or provider becomes available, refresh enabled token list ===== */
  useEffect(() => {
    if (!vaultAddress) return;
    refreshEnabledTokens().catch(() => { });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultAddress, selectedChain?.rpcHttp, !!walletProvider]);

  useEffect(() => {
    if (!isSelectedWNative) {
      setDepositUseNative(false);
      setWithdrawAsNative(false);
    } else {
      setDepositUseNative(true);
      setWithdrawAsNative(true);
    }
  }, [isSelectedWNative]);

  async function loadTokenList() {
    try {
      const r = await fetch("/tokenlist.json", { cache: "no-cache" });
      if (!r.ok) return;
      const j = (await r.json()) as TokenList;
      setTokenList(j);
    } catch {
      // no-op
    }
  }

  async function connectWallet() {
    setStatusMsg("");
    if (!(window as any).ethereum) {
      setStatusFriendly("No injected wallet detected (MetaMask).");
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
      setStatusFriendly("Wallet connected.");
    } catch (e: any) {
      setStatusFriendly(e?.message ?? "Failed to connect wallet.");
    } finally {
      setBusy(false);
    }
  }

  async function ensureWalletOnSelectedChain() {
    if (!walletProvider) throw new Error("Connect wallet first.");
    const net = await walletProvider.getNetwork();
    const on = Number(net.chainId);
    if (on === Number(chainId)) return;

    const eth = (window as any).ethereum;
    if (!eth?.request) throw new Error(`Wallet is on chain ${on}. Switch to ${chainId}.`);

    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: toHexChainId(chainId) }],
      });
      const net2 = await walletProvider.getNetwork();
      setWalletChainId(Number(net2.chainId));
    } catch {
      throw new Error(`Please switch network to chainId ${chainId} in your wallet.`);
    }
  }

  function logout() {
    localStorage.removeItem(LS_JWT);
    setJwt("");
    setStatusFriendly("Signed out.");
  }

  async function loginWithWallet() {
    setStatusMsg("");
    if (!walletProvider) return setStatusFriendly("Connect wallet first.");
    setBusy(true);
    try {
      const signer = await walletProvider.getSigner();
      const addr = await signer.getAddress();

      const nonceResp = await apiJson(apiBase, "/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address: addr }),
      });

      const message: string =
        nonceResp?.message ||
        nonceResp?.nonce ||
        nonceResp?.data?.message ||
        nonceResp?.data?.nonce;

      if (!message || typeof message !== "string") {
        throw new Error("Nonce response missing 'nonce/message'.");
      }

      const sig = await signer.signMessage(message);

      const verifyResp = await apiJson(apiBase, "/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address: addr, signature: sig }),
      });

      const tokenJwt: string =
        verifyResp?.token ||
        verifyResp?.jwt ||
        verifyResp?.data?.token ||
        verifyResp?.data?.jwt;

      if (!tokenJwt || typeof tokenJwt !== "string") {
        throw new Error("Verify response missing jwt/token.");
      }

      localStorage.setItem(LS_JWT, tokenJwt);
      setJwt(tokenJwt);
      setStatusFriendly("Signed in. Balances will load on the Balances tab.");
      // load balances immediately for “friendly” UX
      try {
        await refreshBalances();
      } catch { }
    } catch (e: any) {
      setStatusFriendly(e?.message ?? "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadPublicConfig() {
    setStatusMsg("");
    try {
      const out = (await apiJson(apiBase, "/config/public", { method: "GET" })) as PublicConfig;
      setPub(out);

      const cs: PublicChain[] = out?.chains || [];
      const c = cs.find((x) => Number(x.chainId) === Number(chainId)) || cs[0];
      if (c?.chainId != null) setChainId(Number(c.chainId));

      const vs: PublicVault[] = c?.vaults || [];
      const v = vs.find((x) => vaultKey(x) === String(vaultId)) || vs[0];

      const vid = vaultKey(v);
      if (vid) setVaultId(vid);

      setStatusFriendly("Config loaded.");
    } catch (e: any) {
      setStatusFriendly(e?.message ?? "Failed to load public config.");
    }
  }

  async function refreshBalances() {
    setStatusMsg("");
    if (!jwt) return setStatusFriendly("Sign in first.");
    setBusy(true);
    try {
      const out = await apiJson(apiBase, "/me/balances", {
        method: "GET",
        headers: authHeaders as any,
      });
      setBalances(out?.items || []);
      setStatusFriendly("Balances updated.");
    } catch (e: any) {
      setStatusFriendly(e?.message ?? "Failed to load balances.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshLedger() {
    setStatusMsg("");
    if (!jwt) return setStatusFriendly("Sign in first.");
    setBusy(true);
    try {
      const out = await apiJson(apiBase, "/me/ledger?limit=50", {
        method: "GET",
        headers: authHeaders as any,
      });
      setLedger(out?.items || []);
      setStatusFriendly("Transactions updated.");
    } catch (e: any) {
      setStatusFriendly(e?.message ?? "Failed to load ledger.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshIntents() {
    setStatusMsg("");
    if (!jwt) return setStatusFriendly("Sign in first.");
    setBusy(true);
    try {
      const out = await apiJson(apiBase, "/me/vault/intents?limit=25", {
        method: "GET",
        headers: authHeaders as any,
      });
      setIntents(out?.items || []);
      setStatusFriendly("Withdraw intents updated.");
    } catch (e: any) {
      setStatusFriendly(e?.message ?? "Failed to load intents.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!authed) return;
    if (tab === "balances") refreshBalances();
    if (tab === "ledger") refreshLedger();
    if (tab === "intents") refreshIntents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, authed]);

  async function refreshEnabledTokens() {
    if (!vaultAddress) return;

    const providersToTry: any[] = [];
    if (readProvider) providersToTry.push(readProvider);
    if (walletProvider && !providersToTry.includes(walletProvider))
      providersToTry.push(walletProvider);

    for (let i = 0; i < providersToTry.length; i++) {
      const p = providersToTry[i];
      try {
        const vaultRead = new Contract(vaultAddress, VAULT_READ_ABI, p);

        let onchainUsdc = "";
        let onchainWNative = "";
        try {
          onchainUsdc = String(await vaultRead.usdc());
        } catch { }
        try {
          onchainWNative = String(await vaultRead.wNative());
        } catch { }

        setVaultUsdc(onchainUsdc || (selectedVault?.usdc || ""));
        setVaultWNative(onchainWNative || (selectedVault?.wNative || ""));

        const candidates: string[] = [];
        const cfgVaultTokens = (selectedVault?.tokens || [])
          .map((t) => t.address)
          .filter(Boolean);
        const cfgChainTokens = (selectedChain?.tokens || [])
          .map((t) => t.address)
          .filter(Boolean);

        cfgVaultTokens.forEach((a) => dedupeAdd(candidates, a));
        cfgChainTokens.forEach((a) => dedupeAdd(candidates, a));

        dedupeAdd(candidates, selectedVault?.usdc);
        dedupeAdd(candidates, selectedVault?.wNative);
        dedupeAdd(candidates, onchainUsdc);
        dedupeAdd(candidates, onchainWNative);

        if (!candidates.length) {
          setRuntimeTokens([]);
          return;
        }

        const out: RuntimeToken[] = [];
        for (const addr of candidates) {
          try {
            const cfg = await vaultRead.tokenConfig(addr);
            const enabled = !!cfg?.enabled;
            const dec = Number(cfg?.decimals ?? 18);
            if (!enabled) continue;

            let sym =
              (selectedChain?.tokens || []).find(
                (t) =>
                  (t.address || "").toLowerCase() === addr.toLowerCase()
              )?.symbol ||
              (selectedVault?.tokens || []).find(
                (t) =>
                  (t.address || "").toLowerCase() === addr.toLowerCase()
              )?.symbol ||
              "";

            if (!sym) {
              const s = await tryCallSymbol(p, addr);
              if (s) sym = s;
            }

            const low = addr.toLowerCase();
            if (!sym && onchainWNative && low === onchainWNative.toLowerCase())
              sym = "WBNB";
            if (!sym && onchainUsdc && low === onchainUsdc.toLowerCase())
              sym = "USDC";
            if (!sym) sym = "TOKEN";

            out.push({
              address: addr,
              symbol: String(sym),
              decimals: Number.isFinite(dec) ? dec : 18,
              enabled: true,
              source:
                cfgVaultTokens.some((x) => x.toLowerCase() === low) ||
                  cfgChainTokens.some((x) => x.toLowerCase() === low)
                  ? "config"
                  : "vault",
            });
          } catch { }
        }

        const wn = (onchainWNative || selectedVault?.wNative || "").toLowerCase();
        const uc = (onchainUsdc || selectedVault?.usdc || "").toLowerCase();
        out.sort((a, b) => {
          const al = a.address.toLowerCase();
          const bl = b.address.toLowerCase();
          if (wn && al === wn && bl !== wn) return -1;
          if (wn && bl === wn && al !== wn) return 1;
          if (uc && al === uc && bl !== uc) return -1;
          if (uc && bl === uc && al !== uc) return 1;
          return a.symbol.localeCompare(b.symbol);
        });

        setRuntimeTokens(out);

        if (!out.length) {
          setTokenAddr("");
          return;
        }
        const cur = (tokenAddr || "").toLowerCase();
        const stillValid = out.some((t) => t.address.toLowerCase() === cur);
        if (!cur || !stillValid) setTokenAddr(out[0].address);

        return; // success
      } catch (e: any) {
        if (i === providersToTry.length - 1) {
          setRuntimeTokens([]);
          setStatusFriendly(
            looksLikeRpcTimeout(e)
              ? "RPC read failed (timeout). Try again or use wallet RPC."
              : e?.message ?? "Failed to load enabled tokens."
          );
          return;
        }
      }
    }
  }

  async function approveErc20IfNeeded(amountWei: bigint) {
    if (!vaultAddress) throw new Error("Missing vault address (from /config/public).");
    if (!walletProvider) throw new Error("Connect wallet first.");
    if (!tokenAddr || isZeroAddr(tokenAddr)) throw new Error("Select a valid ERC20 token.");
    await ensureWalletOnSelectedChain();

    const signer = await walletProvider.getSigner();
    const erc20 = new Contract(tokenAddr, ERC20_ABI, signer);

    const owner = await signer.getAddress();
    const allowance: bigint = await erc20.allowance(owner, vaultAddress);
    if (allowance >= amountWei) return;

    const tx = await erc20.approve(vaultAddress, amountWei);
    openTxModal(
      `Approve ${symbol}`,
      <div className="va-modalStack">
        <div className="va-modalText">
          Approval transaction sent. This only grants the vault permission to transfer your token for deposits.
        </div>
        <div className="va-modalKV">
          <div className="va-modalKey">Tx Hash</div>
          <div className="va-modalVal va-mono">{tx?.hash || "—"}</div>
        </div>
      </div>
    );
    await tx.wait();
    setStatusFriendly(`Approve confirmed. You can deposit ${symbol} now.`);
  }

  async function depositNow() {
    setStatusMsg("");

    if (!walletProvider) return setStatusFriendly("Connect wallet first.");
    if (!authed) return setStatusFriendly("Sign in first.");
    if (!account) return setStatusFriendly("Connect wallet first (missing account).");
    if (!vaultAddress) return setStatusFriendly("Missing vault address in /config/public for this vault.");
    if (!resolvedVaultId) return setStatusFriendly("Missing vaultId (load /config/public).");
    if (!tokenAddr || isZeroAddr(tokenAddr)) return setStatusFriendly("Select an enabled token.");

    const enabled = runtimeTokens.some(
      (t) => t.address.toLowerCase() === tokenAddr.toLowerCase()
    );
    if (!enabled) return setStatusFriendly("Selected token is not enabled in this vault.");

    let amountWei: bigint;
    try {
      amountWei = parseUnits(depositAmount || "0", decimals);
      if (amountWei <= 0n) throw new Error("Amount must be > 0");
    } catch (e: any) {
      return setStatusFriendly(`Bad deposit amount: ${e?.message ?? "invalid"}`);
    }

    setBusy(true);
    try {
      await ensureWalletOnSelectedChain();
      const signer = await walletProvider.getSigner();
      const vault = new Contract(vaultAddress, VAULT_WRITE_ABI, signer);

      if (isSelectedWNative && depositUseNative) {
        const tx = await vault.depositNativeFor(account, { value: amountWei });
        openTxModal(
          "Deposit Submitted",
          <div className="va-modalStack">
            <div className="va-modalText">
              Native deposit submitted. The vault will wrap BNB into WBNB internally.
            </div>
            <div className="va-modalKV">
              <div className="va-modalKey">Amount</div>
              <div className="va-modalVal">
                {depositAmount} BNB → WBNB
              </div>
            </div>
            <div className="va-modalKV">
              <div className="va-modalKey">Tx Hash</div>
              <div className="va-modalVal va-mono">{tx?.hash || "—"}</div>
            </div>
            {chainExplorerTx(chainId, tx?.hash) ? (
              <a className="va-link" href={chainExplorerTx(chainId, tx?.hash)} target="_blank" rel="noreferrer">
                Open in Explorer
              </a>
            ) : null}
          </div>
        );

        const receipt = await tx.wait();

        try {
          await apiJson(apiBase, "/me/tx/track", {
            method: "POST",
            headers: authHeaders as any,
            body: JSON.stringify({
              refId: nowRefId("ui_deposit_native"),
              chainId,
              txHash: tx?.hash,
              kind: "deposit",
              meta: {
                vaultId: resolvedVaultId,
                token: tokenAddr,
                symbol: "BNB->WBNB (vault)",
                amount: depositAmount,
                isNative: true,
              },
            }),
          });
        } catch { }

        setStatusFriendly(`Deposit confirmed (block ${receipt?.blockNumber ?? "?"}). Refresh balances after indexer.`);
        return;
      }

      await approveErc20IfNeeded(amountWei);

      const tx = await vault.depositFor(tokenAddr, amountWei, account);
      openTxModal(
        "Deposit Submitted",
        <div className="va-modalStack">
          <div className="va-modalText">
            Deposit submitted. Your cashier balance updates after the indexer processes the vault events.
          </div>
          <div className="va-modalKV">
            <div className="va-modalKey">Token</div>
            <div className="va-modalVal">{symbol}</div>
          </div>
          <div className="va-modalKV">
            <div className="va-modalKey">Amount</div>
            <div className="va-modalVal">{depositAmount}</div>
          </div>
          <div className="va-modalKV">
            <div className="va-modalKey">Tx Hash</div>
            <div className="va-modalVal va-mono">{tx?.hash || "—"}</div>
          </div>
          {chainExplorerTx(chainId, tx?.hash) ? (
            <a className="va-link" href={chainExplorerTx(chainId, tx?.hash)} target="_blank" rel="noreferrer">
              Open in Explorer
            </a>
          ) : null}
        </div>
      );

      const receipt = await tx.wait();

      try {
        await apiJson(apiBase, "/me/tx/track", {
          method: "POST",
          headers: authHeaders as any,
          body: JSON.stringify({
            refId: nowRefId("ui_deposit"),
            chainId,
            txHash: tx?.hash,
            kind: "deposit",
            meta: {
              vaultId: resolvedVaultId,
              token: tokenAddr,
              symbol,
              amount: depositAmount,
              isNative: false,
            },
          }),
        });
      } catch { }

      setStatusFriendly(`Deposit confirmed (block ${receipt?.blockNumber ?? "?"}). Refresh balances after indexer.`);
    } catch (e: any) {
      setStatusFriendly(e?.message ?? "Deposit failed.");
    } finally {
      setBusy(false);
    }
  }

  async function withdrawCreateIntent() {
    setStatusMsg("");

    if (!walletProvider) return setStatusFriendly("Connect wallet first.");
    if (!authed) return setStatusFriendly("Sign in first.");
    if (!resolvedVaultId) return setStatusFriendly("Missing vaultId (load /config/public).");
    if (!tokenAddr || isZeroAddr(tokenAddr)) return setStatusFriendly("Select an enabled token first.");
    if (!withdrawTo || !isHexAddressMaybe(withdrawTo)) return setStatusFriendly("Enter a valid withdraw 'to' address.");

    // Do NOT allow insufficient withdrawals (frontend guard)
    if (!selectedBalance) return setStatusFriendly("No balance loaded. Go to Balances → Refresh.");
    if (withdrawDraftWei <= 0n) return setStatusFriendly("Withdraw amount must be > 0.");
    if (withdrawDraftWei > selectedBalance.availableBI) {
      // Friendly modal for the user
      openTxModal(
        "Insufficient Cashier Balance",
        <div className="va-modalStack">
          <div className="va-modalText">
            Your cashier balance is lower than the amount you entered. Reduce the withdraw amount or deposit more first.
          </div>
          <div className="va-modalKV">
            <div className="va-modalKey">Available</div>
            <div className="va-modalVal">
              {selectedAvailableHuman} {symbol}
            </div>
          </div>
          <div className="va-modalKV">
            <div className="va-modalKey">Requested</div>
            <div className="va-modalVal">
              {withdrawAmount} {symbol}
            </div>
          </div>
        </div>
      );
      return;
    }

    const enabled = runtimeTokens.some(
      (t) => t.address.toLowerCase() === tokenAddr.toLowerCase()
    );
    if (!enabled) return setStatusFriendly("Selected token is not enabled in this vault.");

    const isNative = isSelectedWNative && withdrawAsNative;

    let debitRaw: string;
    try {
      if (withdrawDraftWei <= 0n) throw new Error("Amount must be > 0");
      debitRaw = withdrawDraftWei.toString();
    } catch (e: any) {
      return setStatusFriendly(`Bad withdraw amount: ${e?.message ?? "invalid"}`);
    }

    setBusy(true);
    try {
      await ensureWalletOnSelectedChain();
      const signer = await walletProvider.getSigner();

      // 1) ask server for typedData (+ server deadline)
      const td = await apiJson(apiBase, "/me/withdraw/typedData", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({
          chainId,
          vaultId: resolvedVaultId,
          token: tokenAddr,
          to: withdrawTo,
          debitRaw,
          isNative,
        }),
      });

      const rawTypedData = td?.typedData;
      if (!rawTypedData?.domain || !rawTypedData?.types || !rawTypedData?.message) {
        throw new Error("Server did not return typedData.domain/types/message.");
      }

      // IMPORTANT: deadline must be numeric for /vault/intents/withdraw
      const deadlineStr = String(td?.deadline ?? rawTypedData?.message?.deadline ?? "").trim();
      const deadlineNum = Number(deadlineStr);

      if (!deadlineStr || !Number.isFinite(deadlineNum) || deadlineNum <= 0) {
        throw new Error(`Bad typedData deadline from server: "${deadlineStr}" (parsed=${String(deadlineNum)})`);
      }

      if (rawTypedData?.domain?.chainId != null) {
        const n = Number(rawTypedData.domain.chainId);
        if (!Number.isNaN(n) && n !== Number(chainId)) {
          throw new Error(`TypedData chainId (${n}) != selected chainId (${chainId}). Refresh config and retry.`);
        }
      }

      // 2) sign EIP-712 typed data (ethers v6)
      const typedData = sanitizeTypedData(rawTypedData);
      const signature = await (signer as any).signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message
      );

      if (!signature || typeof signature !== "string" || !signature.startsWith("0x")) {
        throw new Error("Wallet did not produce a valid signature.");
      }

      // 3) create vault intent
      const refId = nowRefId(isNative ? "ui_withdraw_native" : "ui_withdraw");

      const payload = {
        refId,
        chainId,
        vaultId: resolvedVaultId,
        token: tokenAddr,
        to: withdrawTo,
        debitRaw,
        deadline: deadlineNum,
        isNative,
        signature, // REQUIRED by current zip
        sig: signature, // optional compatibility
      };

      await apiJson(apiBase, "/vault/intents/withdraw", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify(payload),
      });

      openTxModal(
        "Withdraw Intent Created",
        <div className="va-modalStack">
          <div className="va-modalText">
            Your withdraw request has been created. The relayer will execute it shortly. You can track it in the Intents tab.
          </div>
          <div className="va-modalKV">
            <div className="va-modalKey">Token</div>
            <div className="va-modalVal">
              {isNative ? "BNB (unwraps WBNB)" : symbol}
            </div>
          </div>
          <div className="va-modalKV">
            <div className="va-modalKey">Amount</div>
            <div className="va-modalVal">{withdrawAmount}</div>
          </div>
          <div className="va-modalKV">
            <div className="va-modalKey">To</div>
            <div className="va-modalVal va-mono">{withdrawTo}</div>
          </div>
          <div className="va-modalKV">
            <div className="va-modalKey">Ref</div>
            <div className="va-modalVal va-mono">{refId}</div>
          </div>
        </div>
      );

      setStatusFriendly("Withdraw intent created.");
      setTab("intents");
      await refreshIntents();
    } catch (e: any) {
      setStatusFriendly(e?.message ?? "Withdraw failed.");
    } finally {
      setBusy(false);
    }
  }

  function TabButton({ k, label }: { k: TabKey; label: string }) {
    const active = tab === k;
    return (
      <Button kind={active ? "primary" : "ghost"} onClick={() => setTab(k)} disabled={busy}>
        {label}
      </Button>
    );
  }

  const debugTokenLines = useMemo(() => {
    return runtimeTokens.map((t) => {
      const tag =
        vaultWNative && t.address.toLowerCase() === vaultWNative.toLowerCase()
          ? " (wNative)"
          : vaultUsdc && t.address.toLowerCase() === vaultUsdc.toLowerCase()
            ? " (usdc)"
            : "";
      return `${t.symbol} / ${t.decimals} / ${t.source}${tag} — ${t.address}`;
    });
  }, [runtimeTokens, vaultWNative, vaultUsdc]);

  // Friendly balances rows: also provide human display
  const balancesRows = useMemo(() => {
    const decByAddr = new Map<string, number>();
    for (const t of runtimeTokens) decByAddr.set(t.address.toLowerCase(), Number(t.decimals ?? 18));

    return balances.map((b) => {
      const available = b.availableRaw ?? "";
      const escrow = b.heldRaw ?? "";
      const total = b.totalRaw ?? "";
      const legacy = b.balanceRaw ?? "";
      const display = {
        availableRaw: available || (legacy && !total ? legacy : ""),
        heldRaw: escrow || "",
        totalRaw: total || (legacy && !available ? legacy : ""),
      };

      const d = decByAddr.get((b.token || "").toLowerCase()) ?? 18;

      return {
        ...b,
        display,
        displayHuman: {
          available: formatAmount(display.availableRaw, d, 8),
          held: formatAmount(display.heldRaw, d, 8),
          total: formatAmount(display.totalRaw || display.availableRaw, d, 8),
          decimals: d,
        },
      };
    });
  }, [balances, runtimeTokens]);

  // Ledger friendly formatting
  const ledgerRows = useMemo(() => {
    const decByAddr = new Map<string, number>();
    for (const t of runtimeTokens) decByAddr.set(t.address.toLowerCase(), Number(t.decimals ?? 18));

    return (ledger || []).map((x) => {
      const d = decByAddr.get((x.token || "").toLowerCase()) ?? 18;
      return {
        ...x,
        human: formatAmount(x.amountRaw, d, 8),
        decimals: d,
      };
    });
  }, [ledger, runtimeTokens]);

  const intentsRows = useMemo(() => {
    const decByAddr = new Map<string, number>();
    for (const t of runtimeTokens) decByAddr.set(t.address.toLowerCase(), Number(t.decimals ?? 18));

    return (intents || []).map((it) => {
      const d = decByAddr.get((it.token || "").toLowerCase()) ?? 18;
      const amtRaw = it.amountRaw || it.debitRaw || "0";
      return {
        ...it,
        human: formatAmount(amtRaw, d, 8),
        decimals: d,
        amtRaw,
        explorer: it.txHash ? chainExplorerTx(it.chainId, it.txHash) : "",
      };
    });
  }, [intents, runtimeTokens]);

  const selectedTokenLogo = useMemo(() => {
    if (!tokenAddr) return "";
    return logoForToken(tokenAddr);
  }, [tokenAddr, tokenListMap]);

  return (
    <div className="va-page">
      <Modal
        open={txModalOpen}
        title={txModalTitle}
        onClose={() => setTxModalOpen(false)}
        footer={
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button kind="ghost" onClick={() => setTxModalOpen(false)}>
              Close
            </Button>
            {tab !== "balances" ? (
              <Button
                kind="ghost"
                onClick={() => {
                  setTxModalOpen(false);
                  setTab("balances");
                }}
              >
                Go to Balances
              </Button>
            ) : null}
          </div>
        }
      >
        {txModalBody}
      </Modal>

      <div className="va-header">
        <div>
          <div className="va-title">User Wallet</div>
          <div className="va-subtitle">
            Connect → Sign in → Deposit / Withdraw.
          </div>

          {/* Tunnel resolver status (on-chain) */}
          <div className="va-subtitle" style={{ marginTop: 6 }}>
            API:&nbsp;
            {apiBase ? (
              <>
                <a href={apiBase} target="_blank" rel="noreferrer">
                  {apiBase}
                </a>
                &nbsp;
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(apiBase)}
                  style={{
                    background: "transparent",
                    border: "1px solid rgba(255,255,255,0.20)",
                    borderRadius: 10,
                    padding: "2px 8px",
                    color: "inherit",
                    cursor: "pointer",
                    fontSize: 12,
                    opacity: 0.9,
                  }}
                >
                  Copy
                </button>
              </>
            ) : (
              <span style={{ opacity: 0.8 }}>resolving…</span>
            )}
          </div>
        </div>

        <div className="va-actions">
          <Button kind="ghost" onClick={loadPublicConfig} disabled={busy}>
            Reload Config
          </Button>

          <Button kind="ghost" onClick={loadTokenList} disabled={busy}>
            Reload Tokenlist
          </Button>

          {jwt ? (
            <Button kind="danger" onClick={logout} disabled={busy}>
              Sign out
            </Button>
          ) : null}

          <Button onClick={connectWallet} disabled={busy}>
            {account ? `Wallet: ${shortAddr(account)}` : "Connect Wallet"}
          </Button>
        </div>
      </div>

      {/* Connection / Sign-in */}
      <div className="va-card" style={{ marginTop: 12 }}>
        <div className="va-cardTitle">Connection</div>
        <div className="va-cardSub">
          Step 1: connect wallet. Step 2: sign a nonce to create your cashier session.
        </div>

        <div style={{ marginTop: 12 }}>
          <Row label="Core API URL" value={<span className="va-mono">{apiBase}</span>} mono />
          <Row label="Wallet" value={account ? <span className="va-mono">{account}</span> : "—"} mono />
          <Row label="Wallet chainId" value={walletChainId ?? "—"} mono />
          <Row label="Selected chainId" value={chainId ?? "—"} mono />
          <Row label="Session" value={jwt ? "Signed in ✅" : "Signed out"} />
        </div>

        {statusMsg ? (
          <div className="va-notice" style={{ marginTop: 12 }}>
            {statusMsg}
          </div>
        ) : null}

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button onClick={loginWithWallet} disabled={busy || !walletProvider}>
            {authed ? "Signed in" : "Sign in (sign nonce)"}
          </Button>

          <Button
            kind="ghost"
            onClick={async () => {
              try {
                setStatusMsg("");
                setBusy(true);
                await ensureWalletOnSelectedChain();
                setStatusFriendly("Wallet network matches selected chain.");
              } catch (e: any) {
                setStatusFriendly(e?.message ?? "Network switch failed.");
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy || !walletProvider}
          >
            Switch Network
          </Button>
        </div>
      </div>

      {/* Selectors */}
      <div className="va-card" style={{ marginTop: 12 }}>
        <div className="va-cardTitle">Vault / Token</div>
        <div className="va-cardSub">
          Vault custody is ERC20-only. If token is <b>wNative</b> (WBNB), you can deposit/withdraw as native using the toggles.
        </div>

        <div style={{ marginTop: 10 }}>
          <Row label="VaultId" value={resolvedVaultId ? <span className="va-mono">{resolvedVaultId}</span> : "—"} mono />
          <Row label="Vault address" value={vaultAddress ? <span className="va-mono">{vaultAddress}</span> : "—"} mono />
          <Row label="Vault wNative" value={vaultWNative ? <span className="va-mono">{vaultWNative}</span> : "—"} mono />
          <Row label="Vault USDC" value={vaultUsdc ? <span className="va-mono">{vaultUsdc}</span> : "—"} mono />
        </div>

        <div className="va-formStack" style={{ marginTop: 12 }}>
          <select
            className="va-input"
            value={String(chainId)}
            onChange={(e) => {
              const next = Number(e.target.value);
              setChainId(next);

              const c = chains.find((x) => Number(x.chainId) === Number(next));
              const v = (c?.vaults || [])[0];
              const vid = vaultKey(v);
              setVaultId(vid || "");
              setTokenAddr("");
            }}
            disabled={busy}
          >
            {chains.map((c) => (
              <option key={String(c.chainId)} value={String(c.chainId)}>
                {c.name ? `${c.name} (${c.chainId})` : `chainId ${c.chainId}`}
              </option>
            ))}
          </select>

          <select
            className="va-input"
            value={resolvedVaultId || ""}
            onChange={(e) => {
              setVaultId(e.target.value);
              setTokenAddr("");
            }}
            disabled={busy}
          >
            {(vaults || []).map((v) => (
              <option key={vaultKey(v) || Math.random().toString(16)} value={vaultKey(v)}>
                {v.label ? `${v.label} (${vaultKey(v)})` : vaultKey(v)}
              </option>
            ))}
          </select>

          <div className="va-tokenSelectRow">
            <div className="va-tokenAvatar">
              {selectedTokenLogo ? (
                <img src={selectedTokenLogo} alt={`${symbol} logo`} />
              ) : (
                <div className="va-tokenAvatarFallback">{symbol.slice(0, 1)}</div>
              )}
            </div>

            <select
              className="va-input"
              value={tokenAddr || ""}
              onChange={(e) => setTokenAddr(e.target.value)}
              disabled={busy || !runtimeTokens.length}
            >
              {runtimeTokens.length ? (
                runtimeTokens.map((t) => (
                  <option key={`${resolvedVaultId}:${t.address.toLowerCase()}`} value={t.address}>
                    {`${t.symbol} — ${t.address}`}
                  </option>
                ))
              ) : (
                <option key="no-tokens" value="">
                  No enabled tokens found (check RPC/config/vault)
                </option>
              )}
            </select>
          </div>

          <div className="va-toolbar">
            <Button kind="ghost" onClick={refreshEnabledTokens} disabled={busy || !vaultAddress}>
              Refresh Enabled Tokens
            </Button>

            <div className="va-toolbarMeta">
              {selectedToken ? (
                <>
                  <span className="va-pill" style={{ borderColor: "rgba(59,130,246,0.4)", color: "rgb(147,197,253)" }}>
                    {symbol} • {decimals} dec
                  </span>
                </>
              ) : (
                <span style={{ opacity: 0.8 }}>Select a token</span>
              )}
            </div>
          </div>
        </div>


      </div>

      {/* Tabs */}
      <div className="va-card" style={{ marginTop: 12 }}>
        <div className="va-cardTitle">Wallet</div>
        <div className="va-cardSub">Friendly view. Tables collapse into cards on mobile.</div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <TabButton k="balances" label="Balances" />
          <TabButton k="deposit" label="Deposit" />
          <TabButton k="withdraw" label="Withdraw" />
          <TabButton k="ledger" label="Transactions" />
          <TabButton k="intents" label="Intents" />
        </div>

        <div style={{ marginTop: 14 }}>
          {/* Balances */}
          {tab === "balances" ? (
            <>
              <div className="va-toolbar">
                <Button kind="ghost" onClick={refreshBalances} disabled={busy || !authed}>
                  Refresh Balances
                </Button>
                <div className="va-toolbarMeta">
                  {authed ? (
                    <span style={{ opacity: 0.85 }}>
                      Showing human units • {runtimeTokens.length} enabled tokens
                    </span>
                  ) : (
                    <span style={{ opacity: 0.85 }}>Sign in to view balances</span>
                  )}
                </div>
              </div>

              <div className="va-cardSub" style={{ marginTop: 10 }}>
                Available is what you can withdraw. Held/escrow may appear when the backend uses holds.
              </div>

              {/* Table (desktop) */}
              <div className="va-tableWrap">
                <table className="va-table">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Available</th>
                      <th>Held</th>
                      <th>Total</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balancesRows.length ? (
                      balancesRows.map((b) => {
                        const addr = (b.token || "").toLowerCase();
                        const rt = runtimeTokens.find((t) => t.address.toLowerCase() === addr);
                        const sym = (rt?.symbol || "TOKEN").toUpperCase();
                        const logo = logoForToken(b.token);
                        return (
                          <tr key={`${b.chainId}:${(b.token || "").toLowerCase()}`}>
                            <td>
                              <div className="va-tokenCell">
                                <div className="va-tokenAvatarSm">
                                  {logo ? <img src={logo} alt={`${sym} logo`} /> : <div className="va-tokenAvatarFallbackSm">{sym.slice(0, 1)}</div>}
                                </div>
                                <div>
                                  <div className="va-tokenCellTop">{sym}</div>
                                  <div className="va-tokenCellSub va-mono">{shortAddr(b.token)}</div>
                                </div>
                              </div>
                            </td>
                            <td>{(b as any).displayHuman?.available || "0"}</td>
                            <td>{(b as any).displayHuman?.held || "0"}</td>
                            <td>{(b as any).displayHuman?.total || "0"}</td>
                            <td className="va-mono">{b.updatedAt ? String(b.updatedAt) : "—"}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={5} style={{ opacity: 0.8 }}>
                          No balances yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Cards (mobile) */}
              <div className="va-cards">
                {balancesRows.length ? (
                  balancesRows.map((b) => {
                    const addr = (b.token || "").toLowerCase();
                    const rt = runtimeTokens.find((t) => t.address.toLowerCase() === addr);
                    const sym = (rt?.symbol || "TOKEN").toUpperCase();
                    const logo = logoForToken(b.token);
                    return (
                      <div className="va-tokenCard" key={`${b.chainId}:${(b.token || "").toLowerCase()}`}>
                        <div className="va-tokenCardTop">
                          <div className="va-tokenCell">
                            <div className="va-tokenAvatarSm">
                              {logo ? <img src={logo} alt={`${sym} logo`} /> : <div className="va-tokenAvatarFallbackSm">{sym.slice(0, 1)}</div>}
                            </div>
                            <div>
                              <div className="va-tokenSym">{sym}</div>
                              <div className="va-mono" style={{ opacity: 0.8 }}>
                                {shortAddr(b.token)}
                              </div>
                            </div>
                          </div>

                          <div className="va-tokenBal">
                            {(b as any).displayHuman?.available || "0"}
                          </div>
                        </div>

                        <div className="va-tokenGrid">
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">Available</div>
                            <div>{(b as any).displayHuman?.available || "0"}</div>
                          </div>
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">Held</div>
                            <div>{(b as any).displayHuman?.held || "0"}</div>
                          </div>
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">Total</div>
                            <div>{(b as any).displayHuman?.total || "0"}</div>
                          </div>
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">Updated</div>
                            <div className="va-mono">{b.updatedAt ? String(b.updatedAt) : "—"}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ opacity: 0.8 }}>No balances yet.</div>
                )}
              </div>
            </>
          ) : null}

          {/* Deposit */}
          {tab === "deposit" ? (
            <>
              <div className="va-cardSub" style={{ marginBottom: 10 }}>
                Deposit into the vault, then the indexer credits your cashier balance.
              </div>

              {isSelectedWNative ? (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                  <Button
                    kind={depositUseNative ? "primary" : "ghost"}
                    onClick={() => setDepositUseNative(true)}
                    disabled={busy}
                  >
                    Use Native (BNB)
                  </Button>
                  <Button
                    kind={!depositUseNative ? "primary" : "ghost"}
                    onClick={() => setDepositUseNative(false)}
                    disabled={busy}
                  >
                    Use Wrapped (WBNB)
                  </Button>
                </div>
              ) : null}

              <div className="va-actionCard">
                <div className="va-actionTitle">Deposit</div>

                <div className="va-formStack">
                  <div className="va-inlineHelp">
                    <div className="va-inlineHelpLeft">
                      <div className="va-inlineHelpLabel">Selected Token</div>
                      <div className="va-inlineHelpValue">
                        <span className="va-pill" style={{ borderColor: "rgba(59,130,246,0.4)", color: "rgb(147,197,253)" }}>
                          {symbol}
                        </span>
                        <span className="va-mono" style={{ opacity: 0.85 }}>
                          {shortAddr(tokenAddr)}
                        </span>
                      </div>
                    </div>
                    <div className="va-inlineHelpRight">
                      <div className="va-inlineHelpLabel">Cashier Available</div>
                      <div className="va-inlineHelpValue">
                        {selectedAvailableHuman} {symbol}
                      </div>
                    </div>
                  </div>

                  <input
                    className="va-input"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    placeholder="Amount (e.g. 0.01)"
                  />

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <Button onClick={depositNow} disabled={busy || !walletProvider || !authed || !vaultAddress || !tokenAddr}>
                      Deposit Now
                    </Button>

                    {!depositUseNative ? (
                      <Button
                        kind="ghost"
                        onClick={async () => {
                          try {
                            setStatusMsg("");
                            if (!vaultAddress) return setStatusFriendly("Missing vault address in /config/public.");
                            if (!walletProvider) return setStatusFriendly("Connect wallet first.");
                            if (!tokenAddr) return setStatusFriendly("Select a token.");
                            const amountWei = parseUnits(depositAmount || "0", decimals);
                            if (amountWei <= 0n) return setStatusFriendly("Amount must be > 0.");
                            setBusy(true);
                            await approveErc20IfNeeded(amountWei);
                            setStatusFriendly(`Approve OK for ${symbol}.`);
                          } catch (e: any) {
                            setStatusFriendly(e?.message ?? "Approve failed.");
                          } finally {
                            setBusy(false);
                          }
                        }}
                        disabled={busy || !walletProvider || !authed || !tokenAddr || !vaultAddress}
                      >
                        Approve (ERC20)
                      </Button>
                    ) : null}

                    <Button kind="ghost" onClick={refreshBalances} disabled={busy || !authed}>
                      Refresh Balances
                    </Button>
                  </div>

                  <div className="va-cardSub" style={{ marginTop: 6 }}>
                    If balances don’t change instantly, wait for the indexer (events → balances).
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/* Withdraw */}
          {tab === "withdraw" ? (
            <>
              <div className="va-cardSub" style={{ marginBottom: 10 }}>
                Withdraw is an intent flow: core-api builds typed data → you sign → relayer executes on-chain.
              </div>

              <div className="va-actionCard">
                <div className="va-actionTitle">Withdraw</div>

                {isSelectedWNative ? (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                    <Button
                      kind={withdrawAsNative ? "primary" : "ghost"}
                      onClick={() => setWithdrawAsNative(true)}
                      disabled={busy}
                    >
                      Withdraw as BNB (vault unwraps)
                    </Button>
                    <Button
                      kind={!withdrawAsNative ? "primary" : "ghost"}
                      onClick={() => setWithdrawAsNative(false)}
                      disabled={busy}
                    >
                      Withdraw as WBNB (ERC20)
                    </Button>
                  </div>
                ) : null}

                <div className="va-inlineHelp">
                  <div className="va-inlineHelpLeft">
                    <div className="va-inlineHelpLabel">Selected Token</div>
                    <div className="va-inlineHelpValue">
                      <span className="va-pill" style={{ borderColor: "rgba(59,130,246,0.4)", color: "rgb(147,197,253)" }}>
                        {symbol}
                      </span>
                      <span className="va-mono" style={{ opacity: 0.85 }}>
                        {shortAddr(tokenAddr)}
                      </span>
                    </div>
                  </div>
                  <div className="va-inlineHelpRight">
                    <div className="va-inlineHelpLabel">Available to withdraw</div>
                    <div className="va-inlineHelpValue">
                      {selectedAvailableHuman} {symbol}
                    </div>
                  </div>
                </div>

                <div className="va-formStack">
                  <input
                    className="va-input va-mono"
                    value={withdrawTo}
                    onChange={(e) => setWithdrawTo(e.target.value)}
                    placeholder={account}
                  />

                  <div className="va-amountRow">
                    <input
                      className="va-input"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      placeholder="Amount (e.g. 0.01)"
                    />
                    <Button
                      kind="ghost"
                      onClick={() => {
                        // MAX from available
                        setWithdrawAmount(selectedAvailableHuman || "0");
                      }}
                      disabled={busy || !selectedBalance}
                    >
                      Max
                    </Button>
                  </div>

                  {withdrawExceedsBalance ? (
                    <div className="va-tokenWarn">
                      Amount exceeds your cashier available balance. The withdraw button is disabled.
                    </div>
                  ) : null}

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <Button
                      onClick={withdrawCreateIntent}
                      disabled={busy || !!withdrawDisabledReason}
                      title={withdrawDisabledReason || ""}
                    >
                      Create Withdraw Intent
                    </Button>

                    <Button kind="ghost" onClick={refreshIntents} disabled={busy || !authed}>
                      Refresh Intents
                    </Button>

                    <Button kind="ghost" onClick={refreshBalances} disabled={busy || !authed}>
                      Refresh Balances
                    </Button>
                  </div>

                  {!!withdrawDisabledReason ? (
                    <div className="va-cardSub" style={{ marginTop: 6 }}>
                      <b>Why disabled:</b> {withdrawDisabledReason}
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}

          {/* Ledger / Transactions */}
          {tab === "ledger" ? (
            <>
              <div className="va-toolbar">
                <Button kind="ghost" onClick={refreshLedger} disabled={busy || !authed}>
                  Refresh Transactions
                </Button>
                <div className="va-toolbarMeta">{authed ? "Showing last 50" : "Sign in to view"}</div>
              </div>

              <div className="va-tableWrap">
                <table className="va-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Type</th>
                      <th>Token</th>
                      <th>Amount</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Ref</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRows.length ? (
                      ledgerRows.map((x) => {
                        const addr = (x.token || "").toLowerCase();
                        const rt = runtimeTokens.find((t) => t.address.toLowerCase() === addr);
                        const sym = (rt?.symbol || "TOKEN").toUpperCase();
                        const logo = logoForToken(x.token);
                        return (
                          <tr key={x.refId || `${x.ts}:${x.kind}:${x.chainId}:${addr}:${x.amountRaw}`}>
                            <td className="va-mono">{String(x.ts)}</td>
                            <td>{x.kind}</td>
                            <td>
                              <div className="va-tokenCell">
                                <div className="va-tokenAvatarSm">
                                  {logo ? <img src={logo} alt={`${sym} logo`} /> : <div className="va-tokenAvatarFallbackSm">{sym.slice(0, 1)}</div>}
                                </div>
                                <div>
                                  <div className="va-tokenCellTop">{sym}</div>
                                  <div className="va-tokenCellSub va-mono">{shortAddr(x.token)}</div>
                                </div>
                              </div>
                            </td>
                            <td>{(x as any).human}</td>
                            <td className="va-mono">{x.fromAccountId || "—"}</td>
                            <td className="va-mono">{x.toAccountId || "—"}</td>
                            <td className="va-mono">{x.refId}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={7} style={{ opacity: 0.8 }}>
                          No transactions yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="va-cards">
                {ledgerRows.length ? (
                  ledgerRows.map((x) => {
                    const addr = (x.token || "").toLowerCase();
                    const rt = runtimeTokens.find((t) => t.address.toLowerCase() === addr);
                    const sym = (rt?.symbol || "TOKEN").toUpperCase();
                    const logo = logoForToken(x.token);
                    return (
                      <div className="va-tokenCard" key={x.refId || `${x.ts}:${x.kind}:${x.chainId}:${addr}:${x.amountRaw}`}>
                        <div className="va-tokenCardTop">
                          <div className="va-tokenCell">
                            <div className="va-tokenAvatarSm">
                              {logo ? <img src={logo} alt={`${sym} logo`} /> : <div className="va-tokenAvatarFallbackSm">{sym.slice(0, 1)}</div>}
                            </div>
                            <div>
                              <div className="va-tokenSym">{x.kind}</div>
                              <div className="va-mono" style={{ opacity: 0.8 }}>
                                {String(x.ts)}
                              </div>
                            </div>
                          </div>
                          <div className="va-tokenBal">{(x as any).human}</div>
                        </div>
                        <div className="va-tokenGrid">
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">Token</div>
                            <div>{sym}</div>
                          </div>
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">From</div>
                            <div className="va-mono">{x.fromAccountId || "—"}</div>
                          </div>
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">To</div>
                            <div className="va-mono">{x.toAccountId || "—"}</div>
                          </div>
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">Ref</div>
                            <div className="va-mono">{x.refId}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ opacity: 0.8 }}>No transactions yet.</div>
                )}
              </div>
            </>
          ) : null}

          {/* Intents */}
          {tab === "intents" ? (
            <>
              <div className="va-toolbar">
                <Button kind="ghost" onClick={refreshIntents} disabled={busy || !authed}>
                  Refresh Intents
                </Button>
                <div className="va-toolbarMeta">{authed ? "Showing last 25" : "Sign in to view"}</div>
              </div>

              <div className="va-tableWrap">
                <table className="va-table">
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>Status</th>
                      <th>Token</th>
                      <th>Amount</th>
                      <th>To</th>
                      <th>Tx</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intentsRows.length ? (
                      intentsRows.map((it) => {
                        const addr = (it.token || "").toLowerCase();
                        const rt = runtimeTokens.find((t) => t.address.toLowerCase() === addr);
                        const sym = (rt?.symbol || "TOKEN").toUpperCase();
                        const logo = logoForToken(it.token);
                        return (
                          <tr key={it.refId || `${it.kind}:${it.chainId}:${it.vaultId}:${addr}:${it.createdAt || ""}`}>
                            <td className="va-mono">{it.createdAt ? String(it.createdAt) : "—"}</td>
                            <td>
                              <span
                                className={
                                  "va-pill " +
                                  (it.status === "done"
                                    ? "va-pillOk"
                                    : it.status === "failed"
                                      ? "va-pillBad"
                                      : "va-pillWait")
                                }
                              >
                                {it.status}
                              </span>
                              <div className="va-mono" style={{ opacity: 0.75, marginTop: 6 }}>
                                {it.refId}
                              </div>
                            </td>
                            <td>
                              <div className="va-tokenCell">
                                <div className="va-tokenAvatarSm">
                                  {logo ? <img src={logo} alt={`${sym} logo`} /> : <div className="va-tokenAvatarFallbackSm">{sym.slice(0, 1)}</div>}
                                </div>
                                <div>
                                  <div className="va-tokenCellTop">{sym}</div>
                                  <div className="va-tokenCellSub va-mono">{shortAddr(it.token)}</div>
                                </div>
                              </div>
                            </td>
                            <td>{(it as any).human}</td>
                            <td className="va-mono">{it.to || "—"}</td>
                            <td>
                              {it.txHash ? (
                                <div className="va-mono">
                                  {shortAddr(it.txHash)}
                                  {it.explorer ? (
                                    <>
                                      {" "}
                                      <a className="va-link" href={it.explorer} target="_blank" rel="noreferrer">
                                        view
                                      </a>
                                    </>
                                  ) : null}
                                </div>
                              ) : (
                                <span style={{ opacity: 0.75 }}>—</span>
                              )}
                            </td>
                            <td className="va-mono" style={{ color: it.error ? "salmon" : undefined }}>
                              {it.error || "—"}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={7} style={{ opacity: 0.8 }}>
                          No intents yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="va-cards">
                {intentsRows.length ? (
                  intentsRows.map((it) => {
                    const addr = (it.token || "").toLowerCase();
                    const rt = runtimeTokens.find((t) => t.address.toLowerCase() === addr);
                    const sym = (rt?.symbol || "TOKEN").toUpperCase();
                    const logo = logoForToken(it.token);

                    return (
                      <div className="va-tokenCard" key={it.refId || `${it.kind}:${it.chainId}:${it.vaultId}:${addr}:${it.createdAt || ""}`}>
                        <div className="va-tokenCardTop">
                          <div className="va-tokenCell">
                            <div className="va-tokenAvatarSm">
                              {logo ? <img src={logo} alt={`${sym} logo`} /> : <div className="va-tokenAvatarFallbackSm">{sym.slice(0, 1)}</div>}
                            </div>
                            <div>
                              <div className="va-tokenSym">Withdraw Intent</div>
                              <div className="va-mono" style={{ opacity: 0.8 }}>
                                {it.createdAt ? String(it.createdAt) : "—"}
                              </div>
                            </div>
                          </div>

                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                            <span
                              className={
                                "va-pill " +
                                (it.status === "done"
                                  ? "va-pillOk"
                                  : it.status === "failed"
                                    ? "va-pillBad"
                                    : "va-pillWait")
                              }
                            >
                              {it.status}
                            </span>
                            <div className="va-tokenBal">{(it as any).human}</div>
                          </div>
                        </div>

                        <div className="va-tokenGrid">
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">Token</div>
                            <div>{sym}</div>
                          </div>
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">To</div>
                            <div className="va-mono">{it.to || "—"}</div>
                          </div>
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">Ref</div>
                            <div className="va-mono">{it.refId}</div>
                          </div>
                          <div className="va-tokenKv">
                            <div className="va-tokenKey">Tx</div>
                            <div className="va-mono">
                              {it.txHash ? shortAddr(it.txHash) : "—"}{" "}
                              {it.explorer ? (
                                <a className="va-link" href={it.explorer} target="_blank" rel="noreferrer">
                                  view
                                </a>
                              ) : null}
                            </div>
                          </div>
                          {it.error ? (
                            <div className="va-tokenWarn">
                              <b>Error:</b> <span className="va-mono">{it.error}</span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ opacity: 0.8 }}>No intents yet.</div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
