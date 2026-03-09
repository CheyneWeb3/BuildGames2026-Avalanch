// src/pages/ZZNEW/UserWalletPage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  formatUnits,
  parseUnits,
} from "ethers";
import { useApiBase } from "../../ApiBaseContext";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitProvider,
  getChainById,
} from "../../config";
import "./UserWalletPage.css";

const LS_JWT = "haus_user_jwt";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** ===== ABIs (minimal) ===== */
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

const ERC20_BAL_ABI = ["function balanceOf(address owner) view returns (uint256)"] as const;

const DEX_V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
] as const;

const DEX_V2_PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
] as const;

const CHAINLINK_AGG_ABI = [
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
] as const;

/** ===== Types (tolerant to your schemas) ===== */
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
  amountRaw: string;
  fromAccountId?: string;
  toAccountId?: string;
  meta?: any;
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

type RuntimeToken = {
  address: string;
  symbol: string;
  decimals: number;
  enabled: boolean;
};

type ContractsJson = Record<
  string,
  {
    name?: string;
    rpcHttp?: string;
    wNative?: string;
    usdc?: string;
    chainlinkNativeUsdFeed?: string;
    dexV2?: { factory?: string; router?: string };
  }
>;

type TokenMeta = { symbol?: string; decimals?: number };

type ActivityRow = LedgerItem & {
  sym: string;
  human: string;
  usd: number;
};

type TokenRowAll = {
  chainId: number;
  chainName: string;
  token: string;
  sym: string;
  dec: number;
  availableRaw: string;
  heldRaw: string;
  totalRaw: string;
  availableHuman: string;
  heldHuman: string;
  totalHuman: string;
  tokenLogo: string;
  chainLogo: string;
  usd: number;
};

function shortAddr(a?: string) {
  const s = (a || "").trim();
  if (!s) return "";
  return s.slice(0, 6) + "…" + s.slice(-4);
}
function isHexAddress(a?: string) {
  const s = (a || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}
function safeBigInt(raw?: string) {
  try {
    const s = String(raw || "").trim();
    if (!s || !/^\d+$/.test(s)) return 0n;
    return BigInt(s);
  } catch {
    return 0n;
  }
}
function formatAmount(raw: string | undefined, decimals: number, maxFrac = 6) {
  const bi = safeBigInt(raw);
  const full = formatUnits(bi, decimals);
  if (!full.includes(".")) return full;
  const [a, b] = full.split(".");
  const trimmed = (b || "").slice(0, maxFrac).replace(/0+$/g, "");
  return trimmed ? `${a}.${trimmed}` : a;
}
function nowRefId(prefix: string) {
  const rnd = Math.random().toString(16).slice(2);
  return `${prefix}:${Date.now()}:${rnd}`;
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
function fmtUsd(n: number) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}
function parseTsMs(ts: any) {
  const ms = Date.parse(String(ts || ""));
  return Number.isFinite(ms) ? ms : 0;
}
function formatWhen(ts?: string) {
  const ms = parseTsMs(ts);
  if (!ms) return String(ts || "—");
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ts || "—");
  }
}
function isWithdrawLike(kind: string) {
  const k = String(kind || "").toLowerCase();
  return k.includes("withdraw") || k.includes("send") || k.includes("debit") || k.includes("payout");
}
function isFeeLike(kind: string) {
  const k = String(kind || "").toLowerCase();
  return k.includes("fee");
}
function isHoldLike(kind: string) {
  const k = String(kind || "").toLowerCase();
  return k.includes("hold") || k.includes("lock") || k.includes("reserved");
}
function ledgerGroupKey(x: any) {
  const m = x?.meta || {};
  const link =
    m?.parentRefId ||
    m?.intentRefId ||
    m?.withdrawRefId ||
    m?.refId ||
    m?.txHash ||
    m?.hash ||
    "";
  if (link) return `${x.chainId}:${(x.token || "").toLowerCase()}:${String(link)}`;

  const ts = parseTsMs(x.ts);
  const bucket = ts ? Math.floor(ts / 30000) : 0; // 30s bucket
  return `${x.chainId}:${(x.token || "").toLowerCase()}:${bucket}`;
}
function collapseWithdrawLedger(items: any[]) {
  const groups = new Map<string, any[]>();
  for (const it of items || []) {
    const k = ledgerGroupKey(it);
    const arr = groups.get(k) || [];
    arr.push(it);
    groups.set(k, arr);
  }

  const out: any[] = [];
  for (const [, arr] of groups) {
    arr.sort((a, b) => parseTsMs(b.ts) - parseTsMs(a.ts));

    const withdrawLikes = arr.filter((x) => isWithdrawLike(x.kind));
    if (!withdrawLikes.length) {
      out.push(...arr);
      continue;
    }

    // Display the HOLD (before fee) if present, else prefer non-fee, else first
    let display = withdrawLikes.find((x) => isHoldLike(x.kind));
    if (!display) display = withdrawLikes.find((x) => !isFeeLike(x.kind));
    if (!display) display = withdrawLikes[0];

    const rawKind = String(display.kind || "");
    const label = rawKind.toLowerCase().includes("send") ? "send" : "withdraw";
    display = { ...display, kind: label };

    out.push(display);

    // keep any non-withdraw items in the group
    const nonWithdraw = arr.filter((x) => !isWithdrawLike(x.kind));
    out.push(...nonWithdraw);
  }

  out.sort((a, b) => parseTsMs(b.ts) - parseTsMs(a.ts));
  return out;
}

function vaultKey(v?: PublicVault) {
  return String(v?.vaultId ?? v?.id ?? "");
}
function resolveVaultAddress(v?: PublicVault) {
  return (v?.vaultAddress || v?.address || "").trim();
}
function pickReadProvider(chain?: PublicChain, walletProvider?: BrowserProvider | null) {
  const rpc = (chain?.rpcHttp || "").trim();
  if (rpc) return new JsonRpcProvider(rpc);
  return walletProvider ?? null;
}
function toHexChainId(chainId: number) {
  return "0x" + Number(chainId).toString(16);
}
function normalizeLogoUri(uri?: string) {
  const u = (uri || "").trim();
  if (!u) return "";
  if (u.startsWith("ipfs://")) {
    const path = u.replace("ipfs://", "");
    return `https://cloudflare-ipfs.com/ipfs/${path}`;
  }
  return u;
}

/** ===== Small UI bits ===== */
function Icon({
  name,
}: {
  name:
    | "send"
    | "deposit"
    | "withdraw"
    | "back"
    | "refresh"
    | "settings"
    | "activity"
    | "tokens"
    | "account"
    | "link";
}) {
  switch (name) {
    case "back":
      return <span className="cw-ic">←</span>;
    case "refresh":
      return <span className="cw-ic">↻</span>;
    case "send":
      return <span className="cw-ic">➤</span>;
    case "deposit":
      return <span className="cw-ic">↓</span>;
    case "withdraw":
      return <span className="cw-ic">↑</span>;
    case "settings":
      return <span className="cw-ic">⚙</span>;
    case "activity":
      return <span className="cw-ic">≋</span>;
    case "account":
      return <span className="cw-ic">☺</span>;
    case "link":
      return <span className="cw-ic">🔗</span>;
    case "tokens":
    default:
      return <span className="cw-ic">◈</span>;
  }
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
function Pill({ children }: { children: React.ReactNode }) {
  return <span className="cw-pill">{children}</span>;
}
function ActionBtn({
  icon,
  label,
  onClick,
  kind = "soft",
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  kind?: "soft" | "primary";
  disabled?: boolean;
}) {
  return (
    <button
      className={"cw-act " + (kind === "primary" ? "cw-actPrimary" : "cw-actSoft")}
      onClick={onClick}
      disabled={!!disabled}
      type="button"
    >
      <span className="cw-actIc">{icon}</span>
      <span className="cw-actTxt">{label}</span>
    </button>
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

function kindVisual(kind: string) {
  const k = String(kind || "").toLowerCase();
  if (k.includes("deposit")) return { icon: "↓", label: "Deposit" };
  if (k.includes("withdraw")) return { icon: "↑", label: "Withdraw" };
  if (k.includes("send") || k.includes("transfer")) return { icon: "➤", label: "Send" };
  if (k.includes("tip")) return { icon: "🎁", label: "Tip" };
  if (k.includes("receive") || k.includes("credit")) return { icon: "＋", label: "Received" };
  if (k.includes("fee")) return { icon: "•", label: "Fee" };
  if (k.includes("hold") || k.includes("lock") || k.includes("intent")) return { icon: "⏳", label: "Pending" };
  return { icon: "•", label: String(kind || "Activity") };
}
function friendlyKindTitle(kind: string, sym: string) {
  const visual = kindVisual(kind);
  return `${visual.label} ${sym}`;
}
function readMetaString(meta: any, ...keys: string[]) {
  const m = meta && typeof meta === "object" ? meta : {};
  for (const k of keys) {
    const v = (m as any)?.[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}
function looksHexAddress(v?: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(v || "").trim());
}
function accountIdFriendly(v?: string) {
  const s = String(v || "").trim();
  if (!s) return "—";
  if (s.startsWith("user:")) return `Wallet user (${shortAddr(s.slice(5))})`;
  if (s.startsWith("tg:")) return `Telegram ${s.slice(3)}`;
  if (looksHexAddress(s)) return shortAddr(s);
  return s;
}
function partyDisplay(row: any, side: "from" | "to") {
  const m = row?.meta || {};
  const accRaw =
    side === "from"
      ? (row?.fromAccountId || m?.from || m?.fromAccountId || m?.sender || m?.sourceAccountId || "")
      : (row?.toAccountId || m?.to || m?.toAccountId || m?.recipient || m?.destAccountId || "");
  const acc = String(accRaw || "").trim();

  const unameKeys =
    side === "from"
      ? ["fromUsername", "senderUsername", "sourceUsername", "usernameFrom", "from_user", "fromUser"]
      : ["toUsername", "recipientUsername", "destUsername", "usernameTo", "to_user", "toUser"];
  const walletKeys =
    side === "from"
      ? ["fromWallet", "fromAddress", "senderAddress", "sourceAddress", "walletFrom"]
      : ["toWallet", "toAddress", "recipientAddress", "destAddress", "walletTo"];

  let username = readMetaString(m, ...unameKeys);
  if (username && !username.startsWith("@")) username = `@${username}`;
  let wallet = readMetaString(m, ...walletKeys);

  if (!wallet && looksHexAddress(acc)) wallet = acc;
  if (!username && acc.startsWith("tg:")) username = `@${acc.slice(3)}`;
  if (!username && acc.startsWith("@")) username = acc;

  let label = "";
  if (username && wallet) label = `${username} • ${shortAddr(wallet)}`;
  else if (username) label = username;
  else if (wallet) label = shortAddr(wallet);
  else if (acc) label = accountIdFriendly(acc);
  else label = "—";

  return { accountId: acc, username, wallet, label };
}
function renderFromTo(row: any) {
  return {
    from: partyDisplay(row, "from"),
    to: partyDisplay(row, "to"),
  };
}
function extractExplorerUrl(meta: any): string {
  const m = meta || {};
  const candidates = [m.explorerUrl, m.txUrl, m.transactionUrl, m.receiptUrl, m.hashUrl, m.url];
  for (const c of candidates) {
    const s = String(c || "").trim();
    if (/^https?:\/\//i.test(s)) return s;
  }
  const txHash = String(m.txHash || m.hash || "").trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(txHash) && /^https?:\/\//.test(String(m.explorerBase || ""))) {
    return `${String(m.explorerBase).replace(/\/+$/, "")}/tx/${txHash}`;
  }
  return "";
}

export default function UserWalletPage() {
  const apiBase = useApiBase();

  const { open } = useAppKit();
  const { address: appkitAddress, isConnected } = useAppKitAccount();
  const { chainId: appkitChainId, switchNetwork } = useAppKitNetwork();
  const { walletProvider: appkitWalletProvider } = useAppKitProvider("eip155");

  /** ===== Auth + Wallet ===== */
  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || "");
  const authed = !!jwt;

  const [walletProvider, setWalletProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState<string>("");
  const [walletChainId, setWalletChainId] = useState<number | null>(null);

  // Reown AppKit -> Ethers BrowserProvider + account sync
  useEffect(() => {
    if (!isConnected || !appkitWalletProvider) {
      setWalletProvider(null);
      setAccount("");
      return;
    }
    (async () => {
      try {
        const bp = new BrowserProvider(appkitWalletProvider as any);
        const net = await bp.getNetwork();
        setWalletProvider(bp);
        setAccount(appkitAddress || "");
        setWalletChainId(Number(appkitChainId ?? net.chainId));
      } catch {
        // keep UI usable even if provider init fails
      }
    })();
  }, [isConnected, appkitWalletProvider, appkitAddress, appkitChainId]);

  const authHeaders = useMemo(() => (jwt ? { Authorization: `Bearer ${jwt}` } : {}), [jwt]);

  /** ===== Data ===== */
  const [pub, setPub] = useState<PublicConfig | null>(null);
  const [tokenList, setTokenList] = useState<TokenList | null>(null);
  const [contractsJson, setContractsJson] = useState<ContractsJson | null>(null);

  const [balances, setBalances] = useState<BalanceItem[]>([]);
  const [ledger, setLedger] = useState<LedgerItem[]>([]);

  // selections (kept in settings)
  const [chainId, setChainId] = useState<number>(43113);
  const [vaultId, setVaultId] = useState<string>("");

  // vault runtime (selected chain/vault)
  const [vaultUsdc, setVaultUsdc] = useState<string>("");
  const [vaultWNative, setVaultWNative] = useState<string>("");
  const [runtimeTokens, setRuntimeTokens] = useState<RuntimeToken[]>([]);

  // pricing map: key = `${chainId}:${addrLower}`
  const [usdByChainToken, setUsdByChainToken] = useState<Record<string, number>>({});

  // chain images from /public/chain-images.json
  const [chainImages, setChainImages] = useState<Record<string, string>>({});

  // registration status (REAL endpoint from your server zip)
  const [regStatus, setRegStatus] = useState<{
    walletRegistered?: boolean;
    tgBound?: boolean;
    moduleId?: string;
    tgId?: string;
    linkCount?: number;
  } | null>(null);

  // Wallet balances for deposit modal
  const [walletTokenBalRaw, setWalletTokenBalRaw] = useState<string>("0");
  const [walletNativeBalRaw, setWalletNativeBalRaw] = useState<string>("0");

  // UI
  const [busy, setBusy] = useState(false); // only for explicit actions (connect/login/tx)
  const [toast, setToast] = useState<string>("");
  const toastRef = useRef<number | null>(null);

  function setToastMsg(s: string) {
    setToast(s);
    if (toastRef.current) window.clearTimeout(toastRef.current);
    toastRef.current = window.setTimeout(() => setToast(""), 7000);
  }

  type MainTab = "tokens" | "activity" | "settings";
  const [tab, setTab] = useState<MainTab>("tokens");

  type View =
    | { kind: "list" }
    | { kind: "token"; chainId: number; tokenAddr: string };
  const [view, setView] = useState<View>({ kind: "list" });

  // modals
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositTokenKey, setDepositTokenKey] = useState<string>(""); // "__NATIVE__" or ERC20 address
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const sessionGateOpen = !isConnected || !authed;

  // deposit/withdraw state
  const [amountStr, setAmountStr] = useState<string>("0.01");
  const [useNative, setUseNative] = useState<boolean>(true);
  const [sendTo, setSendTo] = useState<string>("");
  const [expandedActivity, setExpandedActivity] = useState<Record<string, boolean>>({});

  // responsive
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(max-width: 720px)")?.matches ?? false;
  });

  useEffect(() => {
    if (!window?.matchMedia) return;
    const mq = window.matchMedia("(max-width: 720px)");
    const on = () => setIsMobile(!!mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  /** ===== Load static files ===== */
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/tokenlist.json", { cache: "no-cache" });
        if (r.ok) setTokenList((await r.json()) as TokenList);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/contracts.json", { cache: "no-cache" });
        if (r.ok) setContractsJson((await r.json()) as ContractsJson);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/chain-images.json", { cache: "no-cache" });
        if (r.ok) setChainImages((await r.json()) || {});
      } catch {}
    })();
  }, []);

  function chainLogoFor(cid: number) {
    return (chainImages[String(cid)] || "").trim();
  }

  /** ===== Derived config ===== */
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

  const chainNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of chains) m.set(Number(c.chainId), c.name || `chain ${c.chainId}`);
    return m;
  }, [chains]);

  const tokenMetaByChainAddr = useMemo(() => {
    const m = new Map<string, TokenMeta>(); // key = `${chainId}:${addrLower}`
    for (const c of chains) {
      const cid = Number(c.chainId);
      for (const t of c.tokens || []) {
        const a = (t.address || "").toLowerCase();
        if (!a) continue;
        m.set(`${cid}:${a}`, { symbol: t.symbol, decimals: t.decimals });
      }
      for (const v of c.vaults || []) {
        const usdc = (v.usdc || "").toLowerCase();
        const wn = (v.wNative || "").toLowerCase();
        if (usdc && !m.has(`${cid}:${usdc}`)) m.set(`${cid}:${usdc}`, { symbol: "USDC" });
        if (wn && !m.has(`${cid}:${wn}`)) m.set(`${cid}:${wn}`, { symbol: "WNATIVE" });
      }
    }
    return m;
  }, [chains]);

  const tokenListMapByChainAddr = useMemo(() => {
    const m = new Map<string, TokenListToken>(); // key = `${chainId}:${addrLower}`
    const items = tokenList?.tokens || [];
    for (const t of items) {
      const addr = (t.address || "").toLowerCase();
      if (!addr) continue;
      m.set(`${Number(t.chainId)}:${addr}`, t);
    }
    return m;
  }, [tokenList]);

  function logoForToken(chainId: number, addr: string) {
    const t = tokenListMapByChainAddr.get(`${Number(chainId)}:${(addr || "").toLowerCase()}`);
    return normalizeLogoUri(t?.logoURI);
  }
  function symForToken(chainId: number, addr: string) {
    const key = `${Number(chainId)}:${(addr || "").toLowerCase()}`;
    const meta = tokenMetaByChainAddr.get(key);
    const tl = tokenListMapByChainAddr.get(key);
    return String((meta?.symbol || tl?.symbol || "TOKEN") as any).toUpperCase();
  }
  function nameForToken(chainId: number, addr: string) {
    const key = `${Number(chainId)}:${(addr || "").toLowerCase()}`;
    const tl = tokenListMapByChainAddr.get(key);
    return String(tl?.name || symForToken(chainId, addr));
  }
  function decForToken(chainId: number, addr: string) {
    const key = `${Number(chainId)}:${(addr || "").toLowerCase()}`;
    const meta = tokenMetaByChainAddr.get(key);
    const tl = tokenListMapByChainAddr.get(key);
    const d = meta?.decimals ?? tl?.decimals ?? 18;
    const n = Number(d);
    return Number.isFinite(n) ? n : 18;
  }

  function usdKey(cid: number, addr: string) {
    return `${Number(cid)}:${(addr || "").toLowerCase()}`;
  }
  function usdFor(chainId: number, addr: string) {
    const k = usdKey(chainId, addr);
    const v = usdByChainToken[k];
    return Number.isFinite(v) ? v : NaN;
  }
  function tokenUsdValueFromRaw(chainId: number, addr: string, raw: string | undefined) {
    const p = usdFor(chainId, addr);
    if (!Number.isFinite(p)) return NaN;
    const dec = decForToken(chainId, addr);
    const amt = Number(formatUnits(safeBigInt(raw), dec));
    if (!Number.isFinite(amt)) return NaN;
    return amt * p;
  }

  /** ===== Selected token view derived ===== */
  const selectedTokenAddr = view.kind === "token" ? view.tokenAddr : "";
  const selectedTokenChainId = view.kind === "token" ? Number(view.chainId) : Number(chainId);
  const selectedTokenDecimals = selectedTokenAddr ? decForToken(selectedTokenChainId, selectedTokenAddr) : 18;
  const selectedTokenSymbol = selectedTokenAddr ? symForToken(selectedTokenChainId, selectedTokenAddr) : "TOKEN";
  const selectedTokenName = selectedTokenAddr ? nameForToken(selectedTokenChainId, selectedTokenAddr) : "TOKEN";
  const selectedTokenLogo = selectedTokenAddr ? logoForToken(selectedTokenChainId, selectedTokenAddr) : "";
  const selectedTokenChainLogo = chainLogoFor(selectedTokenChainId);
  const selectedTokenChainName = chainNameById.get(selectedTokenChainId) || String(selectedTokenChainId);

  const isSelectedWNative = useMemo(() => {
    if (!selectedTokenAddr) return false;
    const wn = (vaultWNative || "").toLowerCase();
    return !!wn && wn === selectedTokenAddr.toLowerCase();
  }, [vaultWNative, selectedTokenAddr]);

  /** ===== Deposit selection (can be opened from balances list) ===== */
  const depositTokenAddr = useMemo(() => {
    if (!depositTokenKey) return "";
    if (depositTokenKey === "__NATIVE__") return (vaultWNative || "").trim();
    return depositTokenKey;
  }, [depositTokenKey, vaultWNative]);

  const depositTokenDecimals = depositTokenAddr ? decForToken(chainId, depositTokenAddr) : 18;
  const depositTokenSymbol = depositTokenAddr ? symForToken(chainId, depositTokenAddr) : "TOKEN";
  const depositIsWNative = useMemo(() => {
    if (!depositTokenAddr) return false;
    const wn = (vaultWNative || "").toLowerCase();
    return !!wn && wn === depositTokenAddr.toLowerCase();
  }, [vaultWNative, depositTokenAddr]);

  const depositModeLabel =
    depositTokenKey === "__NATIVE__"
      ? "Native"
      : depositIsWNative && useNative
      ? "Native"
      : "Token";

  const depositOptions = useMemo(() => {
    const opts: { key: string; label: string }[] = [];
    const wn = (vaultWNative || "").trim();
    const hasWn =
      !!wn && runtimeTokens.some((t) => (t.address || "").toLowerCase() === wn.toLowerCase());
    if (hasWn) {
      const wnSym = symForToken(chainId, wn) || "wNative";
      opts.push({ key: "__NATIVE__", label: `Native (wraps to ${wnSym})` });
    }
    for (const t of runtimeTokens) {
      const addr = (t.address || "").trim();
      if (!addr) continue;
      const sym = symForToken(chainId, addr) || t.symbol || "TOKEN";
      opts.push({ key: addr, label: `${sym} · ${shortAddr(addr)}` });
    }
    return opts;
  }, [runtimeTokens, vaultWNative, chainId]);


  useEffect(() => {
    if (!isSelectedWNative) setUseNative(false);
    else setUseNative(true);
  }, [isSelectedWNative]);

  // When opening the deposit modal from the balances list, pick a sensible default token.
  useEffect(() => {
    if (!depositOpen) return;

    // If already set (e.g. opened from a token page), keep it.
    if (depositTokenKey) return;

    const wn = (vaultWNative || "").trim();
    const hasWn = !!wn && runtimeTokens.some((t) => (t.address || "").toLowerCase() === wn.toLowerCase());

    if (hasWn) {
      setDepositTokenKey("__NATIVE__"); // default to native deposit (wraps into wNative)
      setUseNative(true);
      return;
    }

    const first = runtimeTokens[0]?.address || "";
    if (first) setDepositTokenKey(first);
  }, [depositOpen, depositTokenKey, runtimeTokens, vaultWNative]);


  /** ===== Wallet chain listener ===== */
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

  /** ===== API calls ===== */
  async function loadPublicConfig(opts?: { silent?: boolean }) {
    try {
      const out = (await apiJson(apiBase, "/config/public", { method: "GET" })) as PublicConfig;
      setPub(out);

      const cs = out?.chains || [];
      const c = cs.find((x) => Number(x.chainId) === Number(chainId)) || cs[0];
      if (c?.chainId != null) setChainId(Number(c.chainId));

      const vs = c?.vaults || [];
      const v = vs.find((x) => vaultKey(x) === String(vaultId)) || vs[0];
      const vid = vaultKey(v);
      if (vid) setVaultId(vid);
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load public config.");
    }
  }

  async function refreshBalances(opts?: { silent?: boolean }) {
    if (!jwt) return;
    try {
      const out = await apiJson(apiBase, "/me/balances", { method: "GET", headers: authHeaders as any });
      setBalances(out?.items || []);
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load balances.");
    }
  }

  async function refreshLedgerAll(opts?: { silent?: boolean }) {
    if (!jwt) return;
    try {
      const out = await apiJson(apiBase, "/me/ledger?limit=120", { method: "GET", headers: authHeaders as any });
      setLedger(out?.items || []);
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load activity.");
    }
  }

  async function refreshRegistrationStatus(opts?: { silent?: boolean }) {
    if (!jwt) return;
    try {
      const out = await apiJson(apiBase, "/me/tg/link/status?moduleId=tg", {
        method: "GET",
        headers: authHeaders as any,
      });

      const linked = !!out?.linked;
      const links = Array.isArray(out?.links) ? out.links : [];
      const first = links?.[0];

      setRegStatus({
        walletRegistered: true,
        tgBound: linked,
        moduleId: String(out?.moduleId || "tg"),
        tgId: first?.tgId != null ? String(first.tgId) : "",
        linkCount: Number.isFinite(Number(links.length)) ? Number(links.length) : 0,
      });
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load Telegram link status.");
      setRegStatus((prev) =>
        prev ?? { walletRegistered: authed, tgBound: false, moduleId: "tg", tgId: "", linkCount: 0 }
      );
    }
  }

  /** ===== Vault token discovery (selected chain/vault only; used for deposit actions etc) ===== */
  async function refreshEnabledTokens(opts?: { silent?: boolean }) {
    if (!vaultAddress) return;

    const providersToTry: any[] = [];
    if (readProvider) providersToTry.push(readProvider);
    if (walletProvider && !providersToTry.includes(walletProvider)) providersToTry.push(walletProvider);

    for (let i = 0; i < providersToTry.length; i++) {
      const p = providersToTry[i];
      try {
        const vaultRead = new Contract(vaultAddress, VAULT_READ_ABI, p);

        let onchainUsdc = "";
        let onchainWNative = "";
        try { onchainUsdc = String(await vaultRead.usdc()); } catch {}
        try { onchainWNative = String(await vaultRead.wNative()); } catch {}

        const finalUsdc = (onchainUsdc || (selectedVault?.usdc || "")).trim();
        const finalWn = (onchainWNative || (selectedVault?.wNative || "")).trim();

        setVaultUsdc(finalUsdc);
        setVaultWNative(finalWn);

        // candidates from config only
        const candidates: string[] = [];
        const push = (a?: string) => {
          const s = (a || "").trim();
          if (!s || s.toLowerCase() === ZERO_ADDR) return;
          if (candidates.some((x) => x.toLowerCase() === s.toLowerCase())) return;
          candidates.push(s);
        };

        (selectedVault?.tokens || []).forEach((t) => push(t.address));
        (selectedChain?.tokens || []).forEach((t) => push(t.address));
        push(selectedVault?.usdc);
        push(selectedVault?.wNative);
        push(finalUsdc);
        push(finalWn);

        const out: RuntimeToken[] = [];
        for (const addr of candidates) {
          try {
            const cfg = await vaultRead.tokenConfig(addr);
            const enabled = !!cfg?.enabled;
            const dec = Number(cfg?.decimals ?? 18);
            if (!enabled) continue;

            // best symbol source: config → tokenlist → onchain symbol
            let sym =
              (selectedChain?.tokens || []).find((t) => (t.address || "").toLowerCase() === addr.toLowerCase())?.symbol ||
              (selectedVault?.tokens || []).find((t) => (t.address || "").toLowerCase() === addr.toLowerCase())?.symbol ||
              tokenListMapByChainAddr.get(`${Number(chainId)}:${addr.toLowerCase()}`)?.symbol ||
              "";

            if (!sym) {
              try {
                const erc = new Contract(addr, ERC20_ABI, p);
                sym = String(await erc.symbol());
              } catch {}
            }

            if (!sym && finalWn && addr.toLowerCase() === finalWn.toLowerCase()) sym = "AVAX";
            if (!sym && finalUsdc && addr.toLowerCase() === finalUsdc.toLowerCase()) sym = "USDC";
            if (!sym) sym = "TOKEN";

            out.push({ address: addr, symbol: String(sym), decimals: Number.isFinite(dec) ? dec : 18, enabled: true });
          } catch {}
        }

        const wn = (finalWn || "").toLowerCase();
        const uc = (finalUsdc || "").toLowerCase();
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

        // after tokens update, refresh prices silently (all chains)
        refreshUsdPricesAll({ silent: true }).catch(() => {});
        return;
      } catch (e: any) {
        if (i === providersToTry.length - 1) {
          setRuntimeTokens([]);
          if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load enabled tokens.");
        }
      }
    }
  }

  /** ===== USD pricing (multi-chain) via DEX V2 pairs ===== */
  function chainContractsForPricing(cid: number, chain?: PublicChain, vault?: PublicVault) {
    const key = String(cid);
    const fromContracts = contractsJson?.[key];
    const factory = (fromContracts?.dexV2?.factory || "").trim();

    const usdc = (fromContracts?.usdc || (vault?.usdc || "")).trim();
    const wNative = (fromContracts?.wNative || (vault?.wNative || "")).trim();
    const rpcHttp = (fromContracts?.rpcHttp || chain?.rpcHttp || "").trim();

    return { factory, usdc, wNative, rpcHttp };
  }

  async function getPairAddress(factoryAddr: string, tokenA: string, tokenB: string, p: any) {
    if (!factoryAddr || factoryAddr.toLowerCase() === ZERO_ADDR) return "";
    const f = new Contract(factoryAddr, DEX_V2_FACTORY_ABI, p);
    try {
      const pair = await f.getPair(tokenA, tokenB);
      const s = String(pair || "").trim();
      if (!s || s.toLowerCase() === ZERO_ADDR) return "";
      return s;
    } catch {
      return "";
    }
  }

  async function getReservesNormalized(pairAddr: string, tokenA: string, tokenB: string, p: any) {
    const pair = new Contract(pairAddr, DEX_V2_PAIR_ABI, p);
    const [r0, r1] = await pair.getReserves();
    const t0 = String(await pair.token0()).toLowerCase();
    const t1 = String(await pair.token1()).toLowerCase();
    const a = tokenA.toLowerCase();
    const b = tokenB.toLowerCase();

    if (t0 === a && t1 === b) return { reserveA: BigInt(r0), reserveB: BigInt(r1) };
    if (t0 === b && t1 === a) return { reserveA: BigInt(r1), reserveB: BigInt(r0) };
    return { reserveA: 0n, reserveB: 0n };
  }

  function toNumAmount(raw: bigint, decimals: number) {
    try {
      const s = formatUnits(raw, decimals);
      const n = Number(s);
      return Number.isFinite(n) ? n : NaN;
    } catch {
      return NaN;
    }
  }

  async function fetchChainlinkUsd(feedAddr: string, rpcHttp: string): Promise<number> {
    const provider = new JsonRpcProvider(rpcHttp);
    const agg = new Contract(feedAddr, CHAINLINK_AGG_ABI, provider);

    const [, answer] = await agg.latestRoundData();
    const decimals = Number(await agg.decimals());

    const n = Number(formatUnits(answer, decimals));
    if (!Number.isFinite(n) || n <= 0) throw new Error("Bad Chainlink price");
    return n;
  }


  async function refreshUsdPricesForChain(
    cid: number,
    chain: PublicChain,
    vault: PublicVault | undefined,
    tokensToPrice: string[],
    opts?: { silent?: boolean }
  ) {
    try {
      const { factory, usdc, wNative, rpcHttp } = chainContractsForPricing(cid, chain, vault);
      const chainCfg = contractsJson?.[String(cid)];
      const chainlinkFeed = String(chainCfg?.chainlinkNativeUsdFeed || "").trim();

      const usdcAddr = (usdc || "").trim();
      const wnAddr = (wNative || "").trim();
      if (!isHexAddress(usdcAddr) || !isHexAddress(wnAddr)) return;

      const provider = rpcHttp ? new JsonRpcProvider(rpcHttp) : null;
      if (!provider) return;

      const next: Record<string, number> = {};

      // Always set USDC first
      next[usdKey(cid, usdcAddr)] = 1;

      // Chainlink native price first
      if (chainlinkFeed && isHexAddress(chainlinkFeed)) {
        try {
          const nativeUsd = await fetchChainlinkUsd(chainlinkFeed, rpcHttp);
          next[usdKey(cid, wnAddr)] = nativeUsd;
        } catch (e) {
          console.warn("Chainlink native price failed, falling back to DEX", e);
        }
      }

      const hasFactory = !!factory && isHexAddress(factory);

      // DEX fallback for native only if Chainlink did not populate it
      if (hasFactory && !Number.isFinite(next[usdKey(cid, wnAddr)])) {
        const wnUsdcPair = await getPairAddress(factory, wnAddr, usdcAddr, provider);
        if (wnUsdcPair) {
          const { reserveA: rWn, reserveB: rUsdc } = await getReservesNormalized(
            wnUsdcPair,
            wnAddr,
            usdcAddr,
            provider
          );
          const wnDec = decForToken(cid, wnAddr);
          const usdcDec = decForToken(cid, usdcAddr);
          const wnAmt = toNumAmount(rWn, wnDec);
          const usdcAmt = toNumAmount(rUsdc, usdcDec);
          if (wnAmt > 0 && usdcAmt > 0) {
            next[usdKey(cid, wnAddr)] = usdcAmt / wnAmt;
          }
        }
      }

      const wnUsd = next[usdKey(cid, wnAddr)];

      if (hasFactory) {
        const unique = Array.from(
          new Set(tokensToPrice.map((a) => (a || "").toLowerCase()))
        ).filter((x) => isHexAddress(x));

        const slice = unique.slice(0, 14);

        for (const tokenLow of slice) {
          if (tokenLow === usdcAddr.toLowerCase()) continue;
          if (tokenLow === wnAddr.toLowerCase()) continue;

          const pairTU = await getPairAddress(factory, tokenLow, usdcAddr, provider);
          if (pairTU) {
            const { reserveA: rTok, reserveB: rUsdc } = await getReservesNormalized(
              pairTU,
              tokenLow,
              usdcAddr,
              provider
            );
            const tokDec = decForToken(cid, tokenLow);
            const usdcDec = decForToken(cid, usdcAddr);
            const tokAmt = toNumAmount(rTok, tokDec);
            const usdcAmt = toNumAmount(rUsdc, usdcDec);
            if (tokAmt > 0 && usdcAmt > 0) {
              next[usdKey(cid, tokenLow)] = usdcAmt / tokAmt;
              continue;
            }
          }

          if (Number.isFinite(wnUsd) && wnUsd > 0) {
            const pairTW = await getPairAddress(factory, tokenLow, wnAddr, provider);
            if (pairTW) {
              const { reserveA: rTok, reserveB: rWn } = await getReservesNormalized(
                pairTW,
                tokenLow,
                wnAddr,
                provider
              );
              const tokDec = decForToken(cid, tokenLow);
              const wnDec = decForToken(cid, wnAddr);
              const tokAmt = toNumAmount(rTok, tokDec);
              const wnAmt = toNumAmount(rWn, wnDec);
              if (tokAmt > 0 && wnAmt > 0) {
                const tokInWn = wnAmt / tokAmt;
                next[usdKey(cid, tokenLow)] = tokInWn * wnUsd;
                continue;
              }
            }
          }
        }
      }
      console.log("PRICE_DEBUG", {
        cid,
        chainlinkFeed,
        factory,
        usdcAddr,
        wnAddr,
        next
      });
      setUsdByChainToken((prev) => ({ ...prev, ...next }));
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to refresh USD prices.");
    }
  }

  async function refreshUsdPricesAll(opts?: { silent?: boolean }) {
    try {
      const cs = (pub?.chains || []).filter((c) => !!c?.enabled);
      if (!cs.length) return;

      // tokens to price per chain based on balances currently visible
      const byChain = new Map<number, string[]>();
      for (const b of balances || []) {
        const cid = Number(b.chainId);
        if (!byChain.has(cid)) byChain.set(cid, []);
        byChain.get(cid)!.push(String(b.token || ""));
      }

      for (const c of cs) {
        const cid = Number(c.chainId);
        const vault = (c.vaults || []).find((v) => !!v?.enabled) || (c.vaults || [])[0];
        const toks = byChain.get(cid) || [];
        if (!toks.length) continue;
        await refreshUsdPricesForChain(cid, c, vault, toks, { silent: true });
      }
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to refresh USD prices.");
    }
  }

  /** ===== Load config on mount ===== */
  useEffect(() => {
    loadPublicConfig({ silent: false }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ===== When vault changes, refresh enabled tokens + prices ===== */
  useEffect(() => {
    if (!vaultAddress) return;
    refreshEnabledTokens({ silent: true }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultAddress, selectedChain?.rpcHttp, !!walletProvider]);

  /** ===== Auto refresh when signed in (every 20s, silent, no spinners) ===== */
  useEffect(() => {
    if (!authed) return;

    refreshBalances({ silent: true }).catch(() => {});
    refreshLedgerAll({ silent: true }).catch(() => {});
    refreshRegistrationStatus({ silent: true }).catch(() => {});
    refreshUsdPricesAll({ silent: true }).catch(() => {});

    const iv = window.setInterval(() => {
      refreshBalances({ silent: true }).catch(() => {});
      refreshLedgerAll({ silent: true }).catch(() => {});
      refreshRegistrationStatus({ silent: true }).catch(() => {});
      refreshUsdPricesAll({ silent: true }).catch(() => {});
    }, 20000);

    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, contractsJson, pub]);

  /** ===== Multichain token rows (THIS replaces the bad “extra list above yours”) ===== */
  const tokenRowsAll = useMemo<TokenRowAll[]>(() => {
    const out: TokenRowAll[] = [];
    const items = balances || [];

    for (const b of items) {
      const cid = Number(b.chainId);
      const addr = String(b.token || "").trim();
      if (!isHexAddress(addr)) continue;

      const metaKey = `${cid}:${addr.toLowerCase()}`;
      const meta = tokenMetaByChainAddr.get(metaKey);
      const dec = Number(meta?.decimals ?? decForToken(cid, addr));

      const availableRaw = String(b.availableRaw ?? b.balanceRaw ?? "0");
      const heldRaw = String(b.heldRaw ?? "0");
      const totalRaw = String(b.totalRaw ?? (b.availableRaw ?? b.balanceRaw ?? "0"));

      const sym = String((meta?.symbol || symForToken(cid, addr)) as any).toUpperCase();
      const chainName = chainNameById.get(cid) || String(cid);
      const tokenLogo = logoForToken(cid, addr);
      const chainLogo = chainLogoFor(cid);
      const usd = tokenUsdValueFromRaw(cid, addr, availableRaw);

      out.push({
        chainId: cid,
        chainName,
        token: addr,
        sym,
        dec,
        availableRaw,
        heldRaw,
        totalRaw,
        availableHuman: formatAmount(availableRaw, dec, 8),
        heldHuman: formatAmount(heldRaw, dec, 8),
        totalHuman: formatAmount(totalRaw, dec, 8),
        tokenLogo,
        chainLogo,
        usd,
      });
    }

    // stable sort: by USD desc, then chain name, then symbol
    out.sort((a, b) => {
      const au = Number.isFinite(a.usd) ? Number(a.usd) : -1;
      const bu = Number.isFinite(b.usd) ? Number(b.usd) : -1;
      if (bu !== au) return bu - au;
      const cn = a.chainName.localeCompare(b.chainName);
      if (cn !== 0) return cn;
      return a.sym.localeCompare(b.sym);
    });

    return out;
  }, [balances, tokenMetaByChainAddr, chainNameById, tokenListMapByChainAddr, chainImages, usdByChainToken]);

  const totalUsdAllChains = useMemo(() => {
    let sum = 0;
    for (const t of tokenRowsAll) {
      if (Number.isFinite(t.usd)) sum += Number(t.usd);
    }
    return sum;
  }, [tokenRowsAll]);

  /** ===== Activity derived (multi-chain) ===== */
  const activityRows = useMemo<ActivityRow[]>(() => {
    const collapsed = collapseWithdrawLedger(ledger || []);
    return collapsed.map((x) => {
      const cid = Number(x.chainId);
      const addr = String(x.token || "").trim();
      const sym = symForToken(cid, addr);
      const dec = decForToken(cid, addr);
      const usd = tokenUsdValueFromRaw(cid, addr, x.amountRaw);
      return {
        ...(x as any),
        sym,
        human: formatAmount(x.amountRaw, dec, 8),
        usd,
      };
    });
  }, [ledger, tokenMetaByChainAddr, tokenListMapByChainAddr, usdByChainToken]);

  const tokenHistoryRows = useMemo<ActivityRow[]>(() => {
    if (view.kind !== "token") return [];
    const cid = Number(view.chainId);
    const addrLow = String(view.tokenAddr || "").toLowerCase();
    return activityRows.filter((x) => Number(x.chainId) === cid && String(x.token || "").toLowerCase() === addrLow);
  }, [activityRows, view]);

  /** ===== Per-chain available getter (for selected chain actions) ===== */
  const balanceByChainToken = useMemo(() => {
    const m = new Map<string, BalanceItem>();
    for (const b of balances || []) {
      const k = `${Number(b.chainId)}:${String(b.token || "").toLowerCase()}`;
      m.set(k, b);
    }
    return m;
  }, [balances]);

  function getAvailableRaw(chainId: number, addr: string) {
    const b = balanceByChainToken.get(`${Number(chainId)}:${(addr || "").toLowerCase()}`);
    return b?.availableRaw ?? b?.balanceRaw ?? "0";
  }

  /** ===== Load connected wallet balances (deposit modal) ===== */
  useEffect(() => {
    (async () => {
      try {
        if (!depositOpen) return;
        if (!walletProvider) return;
        if (!account) return;

        const signer = await walletProvider.getSigner();
        const provider = (signer as any).provider;

        // native balance (used for native deposits, and as context)
        try {
          const bal = await provider.getBalance(account);
          setWalletNativeBalRaw(bal?.toString?.() ?? "0");
        } catch {
          setWalletNativeBalRaw("0");
        }

        // ERC20 balance (selected deposit token)
        if (!depositTokenAddr) {
          setWalletTokenBalRaw("0");
          return;
        }
        try {
          const erc = new Contract(depositTokenAddr, ERC20_BAL_ABI, provider);
          const bal = await erc.balanceOf(account);
          setWalletTokenBalRaw(bal?.toString?.() ?? "0");
        } catch {
          setWalletTokenBalRaw("0");
        }
      } catch {}
    })();
  }, [depositOpen, walletProvider, account, depositTokenAddr]);

  /** ===== Wallet connect + auth ===== */
  function connectWallet() {
    open();
  }

  async function ensureWalletOnSelectedChain() {
    if (!walletProvider) throw new Error("Connect wallet first.");
    const on = Number(appkitChainId ?? (await walletProvider.getNetwork()).chainId);
    if (on === Number(chainId)) return;

    const target = getChainById(Number(chainId));
    if (switchNetwork && target) {
      await switchNetwork(target as any);
      const net2 = await walletProvider.getNetwork();
      setWalletChainId(Number(net2.chainId));
      return;
    }

    const p: any = appkitWalletProvider;
    if (p?.request) {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHexChainId(chainId) }] });
      const net2 = await walletProvider.getNetwork();
      setWalletChainId(Number(net2.chainId));
      return;
    }

    throw new Error(`Please switch network to chainId ${chainId} in your wallet.`);
  }

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

      const tokenJwt: string = verifyResp?.token || verifyResp?.jwt || verifyResp?.data?.token || verifyResp?.data?.jwt;
      if (!tokenJwt || typeof tokenJwt !== "string") throw new Error("Verify response missing jwt.");

      localStorage.setItem(LS_JWT, tokenJwt);
      setJwt(tokenJwt);
      setToastMsg("Signed in.");

      refreshBalances({ silent: true }).catch(() => {});
      refreshLedgerAll({ silent: true }).catch(() => {});
      refreshRegistrationStatus({ silent: true }).catch(() => {});
      refreshUsdPricesAll({ silent: true }).catch(() => {});
    } catch (e: any) {
      setToastMsg(e?.message ?? "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem(LS_JWT);
    setJwt("");
    setRegStatus(null);
    setExpandedActivity({});
    setToastMsg("Signed out.");
  }

  /** ===== Deposit / Withdraw / Send ===== */
  async function approveIfNeeded(amountWei: bigint, tokenAddr: string) {
    if (!vaultAddress) throw new Error("Missing vault address.");
    if (!walletProvider) throw new Error("Connect wallet first.");
    await ensureWalletOnSelectedChain();

    const signer = await walletProvider.getSigner();
    const erc20 = new Contract(tokenAddr, ERC20_ABI, signer);

    const owner = await signer.getAddress();
    const allowance: bigint = await erc20.allowance(owner, vaultAddress);
    if (allowance >= amountWei) return;

    const tx = await erc20.approve(vaultAddress, amountWei);
    setToastMsg("Approval sent…");
    await tx.wait();
    setToastMsg("Approval confirmed.");
  }

  async function doDeposit(tokenAddr: string, opts?: { isNative?: boolean; label?: string }) {
    if (!walletProvider) return setToastMsg("Connect wallet first.");
    if (!authed) return setToastMsg("Sign in first.");
    if (!account) return setToastMsg("Missing wallet account.");
    if (!vaultAddress) return setToastMsg("Missing vault address.");
    if (!resolvedVaultId) return setToastMsg("Missing vaultId.");
    if (!tokenAddr) return setToastMsg("No token selected.");

    const decimals = decForToken(chainId, tokenAddr);

    const tokenLabel = (opts?.label || symForToken(chainId, tokenAddr) || "TOKEN").toString();

    let amountWei: bigint;
    try {
      amountWei = parseUnits(amountStr || "0", decimals);
      if (amountWei <= 0n) throw new Error("Amount must be > 0");
    } catch (e: any) {
      return setToastMsg(`Bad amount: ${e?.message ?? "invalid"}`);
    }

    setBusy(true);
    try {
      await ensureWalletOnSelectedChain();
      const signer = await walletProvider.getSigner();
      const vault = new Contract(vaultAddress, VAULT_WRITE_ABI, signer);

      const isWn = (vaultWNative || "").toLowerCase() === tokenAddr.toLowerCase();
      const isNativeRequested = opts?.isNative ?? (isWn && useNative);
      if (isWn && isNativeRequested) {
        const net = await signer.provider?.getNetwork();
        const walletChainId = net ? Number(net.chainId) : null;

        console.log("NATIVE_DEPOSIT_DEBUG", {
          vaultAddress,
          account,
          walletChainId,
          uiChainId: chainId,
          amountStr,
          amountWei: amountWei.toString(),
          tokenAddr,
          vaultWNative,
          isWn,
          isNativeRequested,
        });

        if (walletChainId !== Number(chainId)) {
          throw new Error(`Wallet is on chain ${walletChainId ?? "unknown"}, expected ${chainId}.`);
        }
        if (!isWn) {
          throw new Error("Selected token is not the vault wNative token.");
        }
        if (!isNativeRequested) {
          throw new Error("Native deposit path not enabled for this token.");
        }
        if (amountWei <= 0n) {
          throw new Error("Native deposit amount must be greater than zero.");
        }

        const tx = await vault.depositNativeFor(account, { value: amountWei });
        setToastMsg(`Deposit ${tokenLabel} submitted…`);
        await tx.wait();
        try {
          await apiJson(apiBase, "/me/tx/track", {
            method: "POST",
            headers: authHeaders as any,
            body: JSON.stringify({
              refId: nowRefId("ui_deposit_native"),
              chainId,
              txHash: tx?.hash,
              kind: "deposit",
              meta: { vaultId: resolvedVaultId, token: tokenAddr, amount: amountStr, isNative: true },
            }),
          });
        } catch {}
        setToastMsg(`Deposit ${tokenLabel} confirmed. Refresh balances after indexer.`);
      } else {
        await approveIfNeeded(amountWei, tokenAddr);
        const tx = await vault.depositFor(tokenAddr, amountWei, account);
        setToastMsg(`Deposit ${tokenLabel} submitted…`);
        await tx.wait();
        try {
          await apiJson(apiBase, "/me/tx/track", {
            method: "POST",
            headers: authHeaders as any,
            body: JSON.stringify({
              refId: nowRefId("ui_deposit"),
              chainId,
              txHash: tx?.hash,
              kind: "deposit",
              meta: { vaultId: resolvedVaultId, token: tokenAddr, amount: amountStr, isNative: false },
            }),
          });
        } catch {}
        setToastMsg(`Deposit ${tokenLabel} confirmed. Refresh balances after indexer.`);
      }
    } catch (e: any) {
      setToastMsg(e?.message ?? "Deposit failed.");
    } finally {
      setBusy(false);
    }
  }

  function sanitizeTypedData(td: any) {
    const domain = { ...(td?.domain || {}) };
    if (domain?.chainId != null) {
      const n = Number(domain.chainId);
      if (!Number.isNaN(n)) domain.chainId = n;
    }
    const typesIn = { ...(td?.types || {}) };
    if ((typesIn as any)?.EIP712Domain) delete (typesIn as any).EIP712Domain;
    const message = { ...(td?.message || {}) };
    return { domain, types: typesIn, message };
  }

  async function doWithdrawIntent(tokenAddr: string, toAddr: string, isSend: boolean) {
    if (!walletProvider) return setToastMsg("Connect wallet first.");
    if (!authed) return setToastMsg("Sign in first.");
    if (!resolvedVaultId) return setToastMsg("Missing vaultId.");
    if (!tokenAddr) return setToastMsg("No token selected.");
    if (!isHexAddress(toAddr)) return setToastMsg("Bad destination address.");

    const decimals = decForToken(chainId, tokenAddr);

    let debitWei: bigint;
    try {
      debitWei = parseUnits(amountStr || "0", decimals);
      if (debitWei <= 0n) throw new Error("Amount must be > 0");
    } catch (e: any) {
      return setToastMsg(`Bad amount: ${e?.message ?? "invalid"}`);
    }

    const avail = safeBigInt(getAvailableRaw(chainId, tokenAddr));
    if (debitWei > avail) return setToastMsg("Insufficient available balance.");

    const isWn = (vaultWNative || "").toLowerCase() === tokenAddr.toLowerCase();
    const isNative = isWn && !isSend;

    setBusy(true);
    try {
      await ensureWalletOnSelectedChain();
      const signer = await walletProvider.getSigner();

      const td = await apiJson(apiBase, "/me/withdraw/typedData", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({
          chainId,
          vaultId: resolvedVaultId,
          token: tokenAddr,
          to: toAddr,
          debitRaw: debitWei.toString(),
          isNative,
        }),
      });

      const rawTypedData = td?.typedData;
      if (!rawTypedData?.domain || !rawTypedData?.types || !rawTypedData?.message) {
        throw new Error("Server did not return typedData.");
      }

      const deadlineStr = String(td?.deadline ?? rawTypedData?.message?.deadline ?? "").trim();
      const deadlineNum = Number(deadlineStr);
      if (!deadlineStr || !Number.isFinite(deadlineNum) || deadlineNum <= 0) {
        throw new Error(`Bad deadline from server: "${deadlineStr}"`);
      }

      const typedData = sanitizeTypedData(rawTypedData);
      const signature = await (signer as any).signTypedData(typedData.domain, typedData.types, typedData.message);

      const refId = nowRefId(isSend ? "ui_send" : "ui_withdraw");
      await apiJson(apiBase, "/vault/intents/withdraw", {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({
          refId,
          chainId,
          vaultId: resolvedVaultId,
          token: tokenAddr,
          to: toAddr,
          debitRaw: debitWei.toString(),
          deadline: deadlineNum,
          isNative,
          signature,
          sig: signature,
        }),
      });

      setToastMsg(isSend ? `Send ${selectedTokenSymbol} intent created.` : `Withdraw ${selectedTokenSymbol} intent created.`);
    } catch (e: any) {
      setToastMsg(e?.message ?? "Withdraw failed.");
    } finally {
      setBusy(false);
    }
  }

  /** ===== Render helpers ===== */
  function TokenAvatarWithChain({
    chainId,
    addr,
    sym,
    tokenLogo,
    chainLogo,
    size = 40,
  }: {
    chainId: number;
    addr: string;
    sym: string;
    tokenLogo?: string;
    chainLogo?: string;
    size?: number;
  }) {
    const uri = (tokenLogo || logoForToken(chainId, addr) || "").trim();
    const net = (chainLogo || chainLogoFor(chainId) || "").trim();

    return (
      <div
        className="cw-ava"
        style={{
          width: size,
          height: size,
          position: "relative",
          overflow: "visible",
        }}
      >
        {uri ? (
          <img className="cw-avaImg" src={uri} alt={`${sym} logo`} />
        ) : (
          <div className="cw-avaFallback">{sym.slice(0, 1)}</div>
        )}

        {net ? (
          <img
            src={net}
            alt={`${chainId}`}
            style={{
              position: "absolute",
              right: -2,
              bottom: -2,
              width: Math.max(14, Math.floor(size * 0.38)),
              height: Math.max(14, Math.floor(size * 0.38)),
              borderRadius: 999,
              background: "rgba(10,14,28,0.9)",
              border: "1px solid rgba(255,255,255,0.20)",
              objectFit: "cover",
            }}
          />
        ) : null}
      </div>
    );
  }

  function usdLineForToken(chainId: number, addr: string, raw: string) {
    const usd = tokenUsdValueFromRaw(chainId, addr, raw);
    return Number.isFinite(usd) ? fmtUsd(usd) : "—";
  }

  function ActivityCard({
    row,
    compact = false,
  }: {
    row: ActivityRow;
    compact?: boolean;
  }) {
    const open = !!expandedActivity[row.refId];
    const visual = kindVisual(row.kind);
    const fromTo = renderFromTo(row);
    const explorerUrl = extractExplorerUrl(row.meta);
    const txHash = String(row.meta?.txHash || row.meta?.hash || "").trim();

    const toggle = () => setExpandedActivity((p) => ({ ...p, [row.refId]: !p[row.refId] }));

    return (
      <div
        className="cw-actCard"
        style={{
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 14,
          background: "rgba(255,255,255,0.02)",
          marginBottom: 10,
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={toggle}
          style={{
            width: "100%",
            border: 0,
            background: "transparent",
            color: "inherit",
            padding: isMobile ? "12px 12px" : "12px 14px",
            display: "grid",
            gridTemplateColumns: isMobile ? "auto 1fr" : "auto 1fr auto",
            gap: 10,
            alignItems: "center",
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <div
            aria-hidden
            style={{
              width: 32,
              height: 32,
              borderRadius: 999,
              display: "grid",
              placeItems: "center",
              background: "rgba(255,255,255,0.07)",
              fontWeight: 800,
              flexShrink: 0,
            }}
          >
            {visual.icon}
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, lineHeight: 1.15 }}>{friendlyKindTitle(row.kind, row.sym)}</div>
            <div style={{ opacity: 0.78, fontSize: 12, marginTop: 4 }}>
              {formatWhen(row.ts)}
              {!compact ? (
                <>
                  {" · "}
                  <span className="cw-mono">{shortAddr(row.token)}</span>
                  {" · "}
                  <span style={{ opacity: 0.85 }}>
                    {chainNameById.get(Number(row.chainId)) || row.chainId}
                  </span>
                </>
              ) : null}
            </div>
            {(fromTo.from.label !== "—" || fromTo.to.label !== "—") ? (
              <div style={{ opacity: 0.82, fontSize: 12, marginTop: 5, display: "grid", gap: 2 }}>
                <div style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  <span style={{ opacity: 0.68 }}>From:</span> {fromTo.from.label}
                </div>
                <div style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  <span style={{ opacity: 0.68 }}>To:</span> {fromTo.to.label}
                </div>
              </div>
            ) : null}
          </div>

          <div
            style={{
              textAlign: "right",
              minWidth: 88,
              gridColumn: isMobile ? "1 / -1" : undefined,
              marginLeft: isMobile ? 42 : 0,
            }}
          >
            <div style={{ fontWeight: 900 }}>{row.human}</div>
            <div style={{ opacity: 0.8, fontSize: 12, marginTop: 3 }}>
              {Number.isFinite(row.usd as number) ? fmtUsd(Number(row.usd)) : "—"}
            </div>
            <div style={{ opacity: 0.65, fontSize: 11, marginTop: 4 }}>{open ? "Hide" : "Details"}</div>
          </div>
        </button>

        {open ? (
          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.06)",
              padding: isMobile ? "10px 12px 12px" : "12px 14px",
              background: "rgba(255,255,255,0.015)",
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8, fontSize: 13 }}>
              <DetailRow label="Type" value={String(row.kind || "—")} mono={false} />
              <DetailRow label="Chain" value={`${chainNameById.get(Number(row.chainId)) || row.chainId}`} mono={false} />
              <DetailRow label="Token" value={`${row.sym} · ${String(row.token || "")}`} mono />
              <DetailRow label="Amount" value={`${row.human} ${row.sym}`} mono={false} />
              <DetailRow label="USD" value={Number.isFinite(row.usd as number) ? fmtUsd(Number(row.usd)) : "—"} mono={false} />
              <DetailRow label="Time" value={formatWhen(row.ts)} mono={false} />
              <DetailRow label="From" value={fromTo.from.label || "—"} mono />
              <DetailRow label="To" value={fromTo.to.label || "—"} mono />
              <DetailRow label="Ref ID" value={String(row.refId || "—")} mono />
              {txHash ? <DetailRow label="Tx Hash" value={txHash} mono /> : null}
              {explorerUrl ? (
                <div style={{ marginTop: 4 }}>
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      textDecoration: "none",
                      fontWeight: 700,
                      color: "inherit",
                    }}
                  >
                    <Icon name="link" /> Open transaction link
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function DetailRow({
    label,
    value,
    mono = false,
  }: {
    label: string;
    value: string;
    mono?: boolean;
  }) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "72px 1fr" : "88px 1fr",
          gap: 8,
          alignItems: "start",
        }}
      >
        <div style={{ opacity: 0.72 }}>{label}</div>
        <div className={mono ? "cw-mono" : ""} style={{ wordBreak: "break-word" }}>
          {value || "—"}
        </div>
      </div>
    );
  }

  function BottomNav() {
    if (!isMobile) return null;

    return (
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "10px 12px",
          backdropFilter: "blur(10px)",
          background: "rgba(10,14,28,0.72)",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          gap: 10,
          zIndex: 50,
        }}
      >
        <button
          className={"cw-tab " + (tab === "tokens" ? "cw-tabOn" : "")}
          onClick={() => setTab("tokens")}
          style={{ flex: 1, justifyContent: "center" } as any}
        >
          <Icon name="tokens" /> Tokens
        </button>
        <button
          className={"cw-tab " + (tab === "activity" ? "cw-tabOn" : "")}
          onClick={() => setTab("activity")}
          style={{ flex: 1, justifyContent: "center" } as any}
        >
          <Icon name="activity" /> Activity
        </button>
        <button
          className={"cw-tab " + (tab === "settings" ? "cw-tabOn" : "")}
          onClick={() => setTab("settings")}
          style={{ flex: 1, justifyContent: "center" } as any}
        >
          <Icon name="settings" /> Settings
        </button>
        <button
          className={"cw-tab "}
          onClick={() => setAccountOpen(true)}
          style={{ flex: 1, justifyContent: "center" } as any}
        >
          <Icon name="account" /> Account
        </button>
      </div>
    );
  }


  /** ===== UI ===== */
  return (
    <div className="cw-page" style={isMobile ? { paddingBottom: 74 } : undefined}>
      <div className="cw-top">
        <div className="cw-title">The Haus Wallet</div>



        {!isMobile ? (
          <div className="cw-topRight">
            <MiniBtn kind="ghost" onClick={() => setAccountOpen(true)} disabled={busy}>
              <Icon name="account" /> Account
            </MiniBtn>

            <div className="cw-appkitBtn">
              <appkit-button />
            </div>
          </div>
        ) : null}
      </div>

      {!isMobile ? (
        <div className="cw-tabs">
          <button className={"cw-tab " + (tab === "tokens" ? "cw-tabOn" : "")} onClick={() => setTab("tokens")}>
            <Icon name="tokens" /> Tokens
          </button>
          <button className={"cw-tab " + (tab === "activity" ? "cw-tabOn" : "")} onClick={() => setTab("activity")}>
            <Icon name="activity" /> Activity
          </button>
          <button className={"cw-tab " + (tab === "settings" ? "cw-tabOn" : "")} onClick={() => setTab("settings")}>
            <Icon name="settings" /> Settings
          </button>

          <div className="cw-spacer" />

          <MiniBtn
            kind="ghost"
            onClick={() => {
              if (!authed) return setToastMsg("Sign in first.");
              refreshBalances({ silent: true });
              refreshLedgerAll({ silent: true });
              refreshRegistrationStatus({ silent: true });
              refreshUsdPricesAll({ silent: true });
            }}
            disabled={!authed}
          >
            <Icon name="refresh" /> Refresh
          </MiniBtn>
        </div>
      ) : null}

      {toast ? <div className="cw-toast">{toast}</div> : null}

      {/* ===== TOKENS TAB ===== */}
      {tab === "tokens" ? (
        <>
          {view.kind === "list" ? (
            <div className="cw-card">
              <div className="cw-cardHead">
                <div className="cw-cardTitle">
                  Balances{" "}
                  <span style={{ marginLeft: 10, opacity: 0.9, fontWeight: 700 }}>
                    {authed ? fmtUsd(totalUsdAllChains) : ""}
                  </span>
                </div>
                <div className="cw-cardSub">Tap a token to view details, history, and actions.</div>
              </div>

              {!authed ? (
                <div className="cw-empty">Sign in to load balances.</div>
              ) : (
                <>
                  <div className="cw-sub" style={{ marginBottom: 10, opacity: 0.9 }}>
                    Showing your balances across <b>Fuji Testnet Vault</b>.
                  </div>

                  {/* ✅ This is your list (fixed). No extra “new section” above it. */}
                  <div className="cw-list">
                    {tokenRowsAll.length ? (
                      tokenRowsAll.map((t) => (
                        <button
                          key={`${t.chainId}:${t.token.toLowerCase()}`}
                          className="cw-row"
                          onClick={() => {
                            // when opening a token from another chain, make settings match that chain
                            if (Number(chainId) !== Number(t.chainId)) {
                              setChainId(Number(t.chainId));
                              const c = chains.find((x) => Number(x.chainId) === Number(t.chainId));
                              const v = (c?.vaults || [])[0];
                              setVaultId(vaultKey(v) || "");
                            }
                            setView({ kind: "token", chainId: Number(t.chainId), tokenAddr: t.token });
                          }}
                          type="button"
                        >
                          <div className="cw-left">
                            <TokenAvatarWithChain
                              chainId={t.chainId}
                              addr={t.token}
                              sym={t.sym}
                              tokenLogo={t.tokenLogo}
                              chainLogo={t.chainLogo}
                              size={40}
                            />
                            <div className="cw-meta">
                              <div className="cw-sym">
                                {t.sym}{" "}
                                <span style={{ opacity: 0.75, fontWeight: 700 }}>
                                  · {t.chainName}
                                </span>
                              </div>
                              <div className="cw-sub">
                                {shortAddr(t.token)}
                              </div>
                            </div>
                          </div>

                          <div className="cw-right">
                            <div className="cw-balLine">
                              <span className="cw-balKey">Bal</span>
                              <span className="cw-balVal">{t.availableHuman}</span>
                            </div>
                            <div className="cw-balLine" style={{ marginTop: 8 }}>
                              <span className="cw-balKey">USD</span>
                              <span className="cw-balVal">{usdLineForToken(t.chainId, t.token, t.availableRaw)}</span>
                            </div>
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="cw-empty">No tokens found. (Check enabled tokens + balances.)</div>
                    )}
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <ActionBtn
                      icon={<Icon name="deposit" />}
                      label={`Deposit to Cashier${selectedChain?.name ? ` · ${selectedChain.name}` : ""}`}
                      kind="primary"
                      onClick={() => {
                        if (!authed) return setToastMsg("Sign in first.");
                        setAmountStr("0.01");
                        setDepositTokenKey("");
                        setUseNative(true);
                        setDepositOpen(true);
                      }}
                      disabled={!authed || !walletProvider || !vaultAddress}
                    />
                    <div className="cw-help" style={{ marginTop: 8 }}>
                      Deposits go into the <b>selected</b> vault ({selectedChain?.name || String(chainId)}) based on your settings.
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="cw-card">
              <div className="cw-tokenHead">
                <MiniBtn kind="ghost" onClick={() => setView({ kind: "list" })} disabled={busy}>
                  <Icon name="back" /> Back
                </MiniBtn>

                <div className="cw-tokenHeadMid">
                  <div className="cw-ava cw-avaLg" style={{ position: "relative" }}>
                    {selectedTokenLogo ? (
                      <img className="cw-avaImg" src={selectedTokenLogo} alt={`${selectedTokenSymbol} logo`} />
                    ) : (
                      <div className="cw-avaFallback">{selectedTokenSymbol.slice(0, 1)}</div>
                    )}

                    {selectedTokenChainLogo ? (
                      <img
                        src={selectedTokenChainLogo}
                        alt={`${selectedTokenChainId}`}
                        style={{
                          position: "absolute",
                          right: -2,
                          bottom: -2,
                          width: 18,
                          height: 18,
                          borderRadius: 999,
                          background: "rgba(10,14,28,0.9)",
                          border: "1px solid rgba(255,255,255,0.20)",
                          objectFit: "cover",
                        }}
                      />
                    ) : null}
                  </div>
                  <div>
                    <div className="cw-tokenSym">{selectedTokenSymbol}</div>
                    <div className="cw-sub">
                      {selectedTokenChainName} · {selectedTokenName}
                    </div>
                  </div>
                </div>

                <MiniBtn
                  kind="ghost"
                  onClick={() => {
                    if (!authed) return setToastMsg("Sign in first.");
                    refreshBalances({ silent: true });
                    refreshLedgerAll({ silent: true });
                    refreshUsdPricesAll({ silent: true });
                  }}
                  disabled={!authed}
                >
                  <Icon name="refresh" /> Refresh
                </MiniBtn>
              </div>

              {/* === Token hero === */}
              <div
                style={{
                  marginTop: 8,
                  marginBottom: 6,
                  padding: "18px 16px 12px",
                  borderRadius: 18,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.07)",
                  textAlign: "center",
                }}
              >
                <div style={{ opacity: 0.9, fontWeight: 800, letterSpacing: 0.2 }}>
                  {selectedTokenSymbol}{" "}
                  <span style={{ opacity: 0.75, fontWeight: 700 }}>({shortAddr(selectedTokenAddr)})</span>
                </div>

                <div
                  style={{
                    marginTop: 10,
                    fontSize: isMobile ? 36 : 44,
                    fontWeight: 900,
                    lineHeight: 1.05,
                  }}
                >
                  {formatAmount(getAvailableRaw(selectedTokenChainId, selectedTokenAddr), selectedTokenDecimals, 8)}
                </div>

                <div style={{ marginTop: 8, fontSize: isMobile ? 16 : 18, fontWeight: 800, opacity: 0.95 }}>
                  {usdLineForToken(selectedTokenChainId, selectedTokenAddr, getAvailableRaw(selectedTokenChainId, selectedTokenAddr))}
                </div>

                <div style={{ marginTop: 10, opacity: 0.78, fontSize: 13 }}>
                  Available balance (what you can withdraw/send) on <b>{selectedTokenChainName}</b>.
                </div>
              </div>

              <div className="cw-actionsRow">
                <ActionBtn
                  icon={<Icon name="deposit" />}
                  label="Deposit"
                  kind="primary"
                  onClick={() => {
                    setAmountStr("0.01");
                    setDepositTokenKey(selectedTokenAddr);
                    setUseNative(isSelectedWNative);
                    setDepositOpen(true);
                  }}
                  disabled={!authed || !walletProvider}
                />
                <ActionBtn
                  icon={<Icon name="withdraw" />}
                  label="Withdraw"
                  onClick={() => {
                    setAmountStr("0.01");
                    setWithdrawOpen(true);
                  }}
                  disabled={!authed || !walletProvider}
                />
                <ActionBtn
                  icon={<Icon name="send" />}
                  label="Send"
                  onClick={() => {
                    setAmountStr("0.01");
                    setSendTo("");
                    setSendOpen(true);
                  }}
                  disabled={!authed || !walletProvider}
                />
              </div>

              <div className="cw-cardHead" style={{ paddingTop: 6 }}>
                <div className="cw-cardTitle">History</div>
                <div className="cw-cardSub">Last activity for this token only (this chain only).</div>
              </div>

              <div className="cw-activity">
                {tokenHistoryRows.length ? (
                  tokenHistoryRows.map((x) => <ActivityCard key={x.refId} row={x} compact />)
                ) : (
                  <div className="cw-empty">No history yet for this token.</div>
                )}
              </div>
            </div>
          )}
        </>
      ) : null}

      {/* ===== ACTIVITY TAB ===== */}
      {tab === "activity" ? (
        <div className="cw-card">
          <div className="cw-cardHead">
            <div className="cw-cardTitle">Activity</div>
            <div className="cw-cardSub">All chains. Latest first. Withdraws are collapsed (hold-before-fee).</div>
          </div>

          {!authed ? (
            <div className="cw-empty">Sign in to view activity.</div>
          ) : (
            <div className="cw-activity">
              {activityRows.length ? (
                activityRows.map((x) => <ActivityCard key={x.refId} row={x} />)
              ) : (
                <div className="cw-empty">No activity yet.</div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* ===== SETTINGS TAB ===== */}
      {tab === "settings" ? (
        <div className="cw-card">
          <div className="cw-cardHead">
            <div className="cw-cardTitle">Settings</div>
            <div className="cw-cardSub">Wallet/account actions live in Account.</div>
          </div>

          <div className="cw-settings">
            <div className="cw-settingRow">
              <div className="cw-settingKey">API Base</div>
              <div className="cw-settingVal cw-mono">{apiBase}</div>
            </div>

            <div className="cw-settingRow">
              <div className="cw-settingKey">Registration</div>
              <div className="cw-settingVal">
                {authed ? <Pill>Signed in</Pill> : <span style={{ opacity: 0.8 }}>Sign in to view</span>}
              </div>
            </div>

            <div className="cw-settingRow">
              <div className="cw-settingKey">Telegram</div>
              <div className="cw-settingVal">
                {authed ? (
                  regStatus?.tgBound ? (
                    <Pill>
                      Linked{regStatus?.tgId ? ` · tgId ${regStatus.tgId}` : ""}
                    </Pill>
                  ) : (
                    <span style={{ opacity: 0.8 }}>Not linked</span>
                  )
                ) : (
                  <span style={{ opacity: 0.8 }}>Sign in to view</span>
                )}
              </div>
            </div>

            <div className="cw-divider" />

            <div className="cw-settingRow">
              <div className="cw-settingKey">Selected chain</div>
              <div className="cw-settingVal">
                <select
                  className="cw-select"
                  value={String(chainId)}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setChainId(next);
                    const c = chains.find((x) => Number(x.chainId) === Number(next));
                    const v = (c?.vaults || [])[0];
                    setVaultId(vaultKey(v) || "");
                    setView({ kind: "list" });
                  }}
                >
                  {chains.map((c) => (
                    <option key={String(c.chainId)} value={String(c.chainId)}>
                      {c.name ? `${c.name} (${c.chainId})` : `chainId ${c.chainId}`}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="cw-settingRow">
              <div className="cw-settingKey">Selected vault</div>
              <div className="cw-settingVal">
                <select
                  className="cw-select"
                  value={resolvedVaultId || ""}
                  onChange={(e) => {
                    setVaultId(e.target.value);
                    setView({ kind: "list" });
                  }}
                >
                  {vaults.map((v) => (
                    <option key={vaultKey(v) || Math.random().toString(16)} value={vaultKey(v)}>
                      {v.label ? `${v.label} (${vaultKey(v)})` : vaultKey(v)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="cw-settingRow">
              <div className="cw-settingKey">Vault address</div>
              <div className="cw-settingVal cw-mono">{vaultAddress || "—"}</div>
            </div>

            <div className="cw-settingRow">
              <div className="cw-settingKey">wNative</div>
              <div className="cw-settingVal cw-mono">{vaultWNative || "—"}</div>
            </div>

            <div className="cw-settingRow">
              <div className="cw-settingKey">USDC</div>
              <div className="cw-settingVal cw-mono">{vaultUsdc || "—"}</div>
            </div>

            <div className="cw-settingRow">
              <div className="cw-settingKey">Pricing</div>
              <div className="cw-settingVal" style={{ opacity: 0.9 }}>
                {contractsJson?.[String(chainId)]?.dexV2?.factory ? (
                  <Pill>DEX V2</Pill>
                ) : (
                  <span style={{ opacity: 0.8 }}>contracts.json missing for this chain</span>
                )}
              </div>
            </div>

            <div className="cw-settingBtns">
              <MiniBtn kind="ghost" onClick={() => loadPublicConfig({ silent: false })} disabled={busy}>
                Reload config
              </MiniBtn>
              <MiniBtn kind="ghost" onClick={() => refreshEnabledTokens({ silent: false })} disabled={busy || !vaultAddress}>
                Reload enabled tokens (selected vault)
              </MiniBtn>
              <MiniBtn kind="ghost" onClick={() => refreshUsdPricesAll({ silent: false })} disabled={!pub}>
                Reload USD prices (all chains)
              </MiniBtn>
              <MiniBtn
                kind="ghost"
                onClick={async () => {
                  try {
                    setBusy(true);
                    await ensureWalletOnSelectedChain();
                    setToastMsg("Wallet network matches selected chain.");
                  } catch (e: any) {
                    setToastMsg(e?.message ?? "Network switch failed.");
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy || !walletProvider}
              >
                Switch network
              </MiniBtn>
            </div>
          </div>
        </div>
      ) : null}

      {/* ===== Session gate modal ===== */}
      <Modal
        open={sessionGateOpen}
        title="Session required"
        onClose={() => {}}
        footer={
          <div className="cw-modalBtns">
            <MiniBtn kind="primary" onClick={connectWallet} disabled={busy || isConnected}>
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

      {/* ===== Account modal ===== */}
      <Modal
        open={accountOpen}
        title="Account"
        onClose={() => setAccountOpen(false)}
        footer={
          <div className="cw-modalBtns">
            <MiniBtn kind="ghost" onClick={() => setAccountOpen(false)} disabled={busy}>
              Close
            </MiniBtn>
          </div>
        }
      >
        <div className="cw-form">
          <div className="cw-help">
            Wallet: <span className="cw-mono">{account || "—"}</span>
          </div>
          <div className="cw-help">
            Wallet chainId: <b>{walletChainId ?? "—"}</b> · Selected: <b>{chainId}</b>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <MiniBtn kind="primary" onClick={connectWallet} disabled={busy}>
              {account ? "Reconnect" : "Connect wallet"}
            </MiniBtn>

            {authed ? (
              <MiniBtn kind="danger" onClick={logout} disabled={busy}>
                Sign out
              </MiniBtn>
            ) : (
              <MiniBtn kind="ghost" onClick={loginWithWallet} disabled={busy || !walletProvider}>
                Sign in
              </MiniBtn>
            )}

            <MiniBtn
              kind="ghost"
              onClick={() => {
                if (!authed) return setToastMsg("Sign in first.");
                refreshBalances({ silent: true });
                refreshLedgerAll({ silent: true });
                refreshRegistrationStatus({ silent: true });
                refreshUsdPricesAll({ silent: true });
                setToastMsg("Refreshed.");
              }}
              disabled={!authed}
            >
              <Icon name="refresh" /> Refresh
            </MiniBtn>

            <MiniBtn
              kind="ghost"
              onClick={async () => {
                try {
                  setBusy(true);
                  await ensureWalletOnSelectedChain();
                  setToastMsg("Switched network.");
                } catch (e: any) {
                  setToastMsg(e?.message ?? "Network switch failed.");
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy || !walletProvider}
            >
              Switch network
            </MiniBtn>
          </div>

          <div className="cw-divider" />

          <div className="cw-help">
            Registration: {authed ? <Pill>Signed in</Pill> : <span style={{ opacity: 0.8 }}>Sign in to view</span>}
          </div>

          <div className="cw-help">
            Telegram:{" "}
            {authed ? (
              regStatus?.tgBound ? (
                <Pill>
                  Linked{regStatus?.tgId ? ` · tgId ${regStatus.tgId}` : ""}
                </Pill>
              ) : (
                <span style={{ opacity: 0.8 }}>Not linked</span>
              )
            ) : (
              <span style={{ opacity: 0.8 }}>Sign in to view</span>
            )}
          </div>
        </div>
      </Modal>

      {/* ===== Modals ===== */}
      <Modal
        open={depositOpen}
        title={`Deposit ${depositTokenKey === "__NATIVE__" ? "Native" : depositTokenSymbol}`}
        onClose={() => {
          setDepositOpen(false);
          setDepositTokenKey("");
        }}
        footer={
          <div className="cw-modalBtns">
            <MiniBtn
              kind="ghost"
              onClick={() => {
                setDepositOpen(false);
                setDepositTokenKey("");
              }}
              disabled={busy}
            >
              Cancel
            </MiniBtn>
            <MiniBtn
              kind="primary"
              onClick={async () => {
                const isNative = depositTokenKey === "__NATIVE__" || (depositIsWNative && useNative);
                const label = depositTokenKey === "__NATIVE__" ? "Native" : depositTokenSymbol;
                await doDeposit(depositTokenAddr, { isNative, label });
                setDepositOpen(false);
                setDepositTokenKey("");
              }}
              disabled={busy || !depositTokenAddr}
            >
              Deposit
            </MiniBtn>
          </div>
        }
      >
        <div className="cw-form">
          <label className="cw-label">Token</label>
          <select
            className="cw-input"
            value={depositTokenKey || ""}
            onChange={(e) => {
              const k = e.target.value;
              setDepositTokenKey(k);
              if (k === "__NATIVE__") setUseNative(true);
            }}
            disabled={busy}
          >
            {depositOptions.length ? (
              depositOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))
            ) : (
              <option value="">No enabled tokens</option>
            )}
          </select>

          {depositIsWNative && depositTokenKey !== "__NATIVE__" ? (
            <div className="cw-toggleRow" style={{ marginTop: 10 }}>
              <button
                type="button"
                className={"cw-toggle " + (useNative ? "cw-toggleOn" : "")}
                onClick={() => setUseNative(true)}
                disabled={busy}
              >
                Native
              </button>
              <button
                type="button"
                className={"cw-toggle " + (!useNative ? "cw-toggleOn" : "")}
                onClick={() => setUseNative(false)}
                disabled={busy}
              >
                Wrapped
              </button>
            </div>
          ) : null}

          <label className="cw-label" style={{ marginTop: 10 }}>
            Amount
          </label>
          <input
            className="cw-input"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0.01"
          />

          <div className="cw-help">
            Wallet balance:{" "}
            <b>
              {depositTokenKey === "__NATIVE__" || (depositIsWNative && useNative)
                ? `${formatAmount(walletNativeBalRaw, 18, 6)} Native`
                : `${formatAmount(walletTokenBalRaw, depositTokenDecimals, 6)} ${depositTokenSymbol}`}
            </b>
          </div>

          <div className="cw-help">
            Cashier available:{" "}
            <b>
              {depositTokenAddr
                ? `${formatAmount(getAvailableRaw(chainId, depositTokenAddr), depositTokenDecimals, 8)} ${depositTokenSymbol}`
                : "—"}
            </b>
          </div>
        </div>
      </Modal>

      <Modal
        open={withdrawOpen}
        title={`Withdraw ${selectedTokenSymbol}`}
        onClose={() => setWithdrawOpen(false)}
        footer={
          <div className="cw-modalBtns">
            <MiniBtn kind="ghost" onClick={() => setWithdrawOpen(false)} disabled={busy}>
              Cancel
            </MiniBtn>
            <MiniBtn
              kind="primary"
              onClick={async () => {
                await doWithdrawIntent(selectedTokenAddr, account, false);
                setWithdrawOpen(false);
              }}
              disabled={busy || !selectedTokenAddr || !account}
            >
              Withdraw
            </MiniBtn>
          </div>
        }
      >
        <div className="cw-form">
          <div className="cw-help">
            Destination: <span className="cw-mono">{account || "—"}</span>
          </div>

          <label className="cw-label">Amount</label>
          <input className="cw-input" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} placeholder="0.01" />

          <div className="cw-help">
            Available:{" "}
            <b>
              {formatAmount(getAvailableRaw(selectedTokenChainId, selectedTokenAddr), selectedTokenDecimals, 8)} {selectedTokenSymbol}
            </b>
          </div>
        </div>
      </Modal>

      <Modal
        open={sendOpen}
        title={`Send ${selectedTokenSymbol}`}
        onClose={() => setSendOpen(false)}
        footer={
          <div className="cw-modalBtns">
            <MiniBtn kind="ghost" onClick={() => setSendOpen(false)} disabled={busy}>
              Cancel
            </MiniBtn>
            <MiniBtn
              kind="primary"
              onClick={async () => {
                await doWithdrawIntent(selectedTokenAddr, sendTo, true);
                setSendOpen(false);
              }}
              disabled={busy || !selectedTokenAddr || !isHexAddress(sendTo)}
            >
              Send
            </MiniBtn>
          </div>
        }
      >
        <div className="cw-form">
          <label className="cw-label">To address</label>
          <input
            className="cw-input cw-mono"
            value={sendTo}
            onChange={(e) => setSendTo(e.target.value)}
            placeholder="0x..."
          />

          <label className="cw-label">Amount</label>
          <input className="cw-input" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} placeholder="0.01" />

          <div className="cw-help">
            Available:{" "}
            <b>
              {formatAmount(getAvailableRaw(selectedTokenChainId, selectedTokenAddr), selectedTokenDecimals, 8)} {selectedTokenSymbol}
            </b>
          </div>
        </div>
      </Modal>

      {/* mobile bottom nav */}
      <BottomNav />
    </div>
  );
}
