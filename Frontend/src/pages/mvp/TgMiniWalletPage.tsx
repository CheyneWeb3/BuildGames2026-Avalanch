import React, { useEffect, useMemo, useRef, useState } from "react";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { useApiBase } from "../../ApiBaseContext";
import "./UserWalletPage.css";

const LS_TG_JWT = "yeti_tg_jwt";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

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

type ApiError = { message: string; status?: number; raw?: string };

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
  decimals?: number;
  symbol?: string;
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
  decimals?: number;
  symbol?: string;
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

type EnabledTokenPriceRow = {
  chainId: number;
  token: string;
  priceUsd?: number | string | null;
  symbol?: string;
  source?: string;
  updatedAt?: string;
};

type RuntimeToken = {
  address: string;
  symbol: string;
  decimals: number;
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

type ActivityRow = LedgerItem & {
  sym: string;
  human: string;
  usd?: number;
};

type View = { kind: "list" } | { kind: "token"; tokenAddr: string };

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

function shortAddr(a?: string) {
  const s = (a || "").trim();
  if (!s) return "";
  if (s.length <= 14) return s;
  return s.slice(0, 6) + "…" + s.slice(-4);
}

function fmtUsd(n: number) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return "<$0.01";
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

function isHexAddress(a?: string) {
  const s = (a || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isWithdrawLike(kind: string) {
  const k = String(kind || "").toLowerCase();
  return (
    k.includes("withdraw") ||
    k.includes("send") ||
    k.includes("debit") ||
    k.includes("payout") ||
    k.includes("transfer")
  );
}
function isFeeLike(kind: string) {
  return String(kind || "").toLowerCase().includes("fee");
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
  const bucket = ts ? Math.floor(ts / 30000) : 0;
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

    let display = withdrawLikes.find((x) => isHoldLike(x.kind));
    if (!display) display = withdrawLikes.find((x) => !isFeeLike(x.kind));
    if (!display) display = withdrawLikes[0];

    const rawKind = String(display.kind || "");
    const lowered = rawKind.toLowerCase();
    let label = rawKind;
    if (lowered.includes("transfer")) label = "send";
    else if (lowered.includes("send")) label = "send";
    else if (lowered.includes("withdraw")) label = "withdraw";
    display = { ...display, kind: label };

    out.push(display);

    const nonWithdraw = arr.filter((x) => !isWithdrawLike(x.kind));
    out.push(...nonWithdraw);
  }

  out.sort((a, b) => parseTsMs(b.ts) - parseTsMs(a.ts));
  return out;
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

function vaultKey(v?: PublicVault) {
  return String(v?.vaultId ?? v?.id ?? "");
}
function resolveVaultAddress(v?: PublicVault) {
  return (v?.vaultAddress || v?.address || "").trim();
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
    const err: ApiError = { message: String(msg), status: r.status, raw: txt };
    throw err;
  }

  return data;
}

async function apiJsonTry(base: string, paths: string[], init?: RequestInit) {
  let lastErr: any = null;
  for (const p of paths) {
    try {
      const data = await apiJson(base, p, init);
      return { pathUsed: p, data };
    } catch (e: any) {
      lastErr = e;
      if (e?.status && Number(e.status) !== 404) throw e;
    }
  }
  throw lastErr || new Error("Request failed.");
}

function Icon({
  name,
}: {
  name:
    | "send"
    | "deposit"
    | "withdraw"
    | "back"
    | "refresh"
    | "activity"
    | "tokens"
    | "account"
    | "open"
    | "copy"
    | "link"
    | "chev"
    | "user"
    | "wallet"
    | "debug";
}) {
  const cls = "cw-ic";
  switch (name) {
    case "back":
      return <span className={cls}>←</span>;
    case "refresh":
      return <span className={cls}>↻</span>;
    case "send":
      return <span className={cls}>➤</span>;
    case "deposit":
      return <span className={cls}>↓</span>;
    case "withdraw":
      return <span className={cls}>↑</span>;
    case "activity":
      return <span className={cls}>≋</span>;
    case "account":
      return <span className={cls}>☺</span>;
    case "open":
      return <span className={cls}>↗</span>;
    case "copy":
      return <span className={cls}>⧉</span>;
    case "link":
      return <span className={cls}>⌁</span>;
    case "chev":
      return <span className={cls}>▾</span>;
    case "user":
      return <span className={cls}>👤</span>;
    case "wallet":
      return <span className={cls}>👛</span>;
    case "debug":
      return <span className={cls}>⚙</span>;
    case "tokens":
    default:
      return <span className={cls}>◈</span>;
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
          <button className="cw-x" onClick={onClose} aria-label="Close" type="button">
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

function sectionCardStyle(isMobile: boolean): React.CSSProperties {
  return isMobile
    ? {
        marginLeft: 0,
        marginRight: 0,
        borderRadius: 14,
      }
    : {};
}

function kindVisual(kind: string) {
  const k = String(kind || "").toLowerCase();
  if (k.includes("deposit")) return { icon: "↓", label: "Deposit" };
  if (k.includes("withdraw")) return { icon: "↑", label: "Withdraw" };
  if (k.includes("send") || k.includes("transfer")) return { icon: "➤", label: "Send" };
  if (k.includes("tip")) return { icon: "🎁", label: "Tip" };
  if (k.includes("receive") || k.includes("credit")) return { icon: "＋", label: "Received" };
  if (k.includes("fee")) return { icon: "•", label: "Fee" };
  if (k.includes("hold") || k.includes("lock")) return { icon: "⏳", label: "Pending" };
  return { icon: "•", label: String(kind || "Activity") };
}

function accountIdFriendly(v?: string) {
  const s = String(v || "").trim();
  if (!s) return "—";
  if (s.startsWith("user:")) return `Wallet user (${shortAddr(s.slice(5))})`;
  if (s.startsWith("tg:")) return `Telegram ${s}`;
  return s;
}

function extractExplorerUrl(meta: any): string {
  const m = meta || {};
  const candidates = [
    m.explorerUrl,
    m.txUrl,
    m.transactionUrl,
    m.receiptUrl,
    m.hashUrl,
    m.url,
  ];
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

export default function TgMiniWalletPage() {
  const apiBase = useApiBase();
  const WALLET_APP_URL = (import.meta as any).env?.VITE_WALLET_APP_URL || "https://thehaus-fuji-mvp.netlify.app/";

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_TG_JWT) || "");
  const authed = !!jwt;
  const authHeaders = useMemo(() => (jwt ? { Authorization: `Bearer ${jwt}` } : {}), [jwt]);

  const [pub, setPub] = useState<PublicConfig | null>(null);
  const [tokenList, setTokenList] = useState<TokenList | null>(null);
  const [contractsJson, setContractsJson] = useState<ContractsJson | null>(null);

  const [balances, setBalances] = useState<BalanceItem[]>([]);
  const [ledger, setLedger] = useState<LedgerItem[]>([]);

  const [chainId, setChainId] = useState<number>(56);
  const [vaultId, setVaultId] = useState<string>("");

  const [runtimeTokens, setRuntimeTokens] = useState<RuntimeToken[]>([]);
  const [vaultUsdc, setVaultUsdc] = useState<string>("");
  const [vaultWNative, setVaultWNative] = useState<string>("");

  const [usdByToken, setUsdByToken] = useState<Record<string, number>>({});
  const [pricesUpdatedAt, setPricesUpdatedAt] = useState<string>("");

  const [toast, setToast] = useState<string>("");
  const toastRef = useRef<number | null>(null);

  const [authError, setAuthError] = useState<string>("");

  type MainTab = "tokens" | "activity" | "account" | "open";
  const [tab, setTab] = useState<MainTab>("tokens");
  const [view, setView] = useState<View>({ kind: "list" });

  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState<string>("@");
  const [sendAmount, setSendAmount] = useState<string>("0.01");

  const [walletUrlOpen, setWalletUrlOpen] = useState(false);

  const [expandedActivity, setExpandedActivity] = useState<Record<string, boolean>>({});
  const [debugOpen, setDebugOpen] = useState(false);

  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia?.("(max-width: 720px)")?.matches ?? true;
  });

  useEffect(() => {
    if (!window?.matchMedia) return;
    const mq = window.matchMedia("(max-width: 720px)");
    const on = () => setIsMobile(!!mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  function setToastMsg(s: string) {
    setToast(s);
    if (toastRef.current) window.clearTimeout(toastRef.current);
    toastRef.current = window.setTimeout(() => setToast(""), 7000);
  }

  function getTelegramInitData(): string {
    const tg = (window as any)?.Telegram?.WebApp;
    if (!tg) throw new Error("Not inside Telegram MiniApp.");
    try {
      tg.ready?.();
      tg.expand?.();
    } catch {}
    const initData = String(tg.initData || "").trim();
    if (!initData) throw new Error("Missing Telegram initData.");
    return initData;
  }

  async function tgLogin() {
    setAuthError("");
    try {
      const initData = getTelegramInitData();
      const { data } = await apiJsonTry(apiBase, ["/tg/auth/verify", "/auth/tg/verify"], {
        method: "POST",
        body: JSON.stringify({ moduleId: "tg", initData }),
      });

      const token = String(data?.token || data?.jwt || "").trim();
      if (!token) throw new Error("Server did not return token.");
      localStorage.setItem(LS_TG_JWT, token);
      setJwt(token);
      setAuthError("");
      setToastMsg("Signed in (Telegram).");
    } catch (e: any) {
      const msg = String(e?.message || "Telegram sign-in failed.");
      setAuthError(msg);
      setToastMsg(msg);
      localStorage.removeItem(LS_TG_JWT);
      setJwt("");
    }
  }

  async function logout() {
    localStorage.removeItem(LS_TG_JWT);
    setJwt("");
    setBalances([]);
    setLedger([]);
    setAuthError("");
    setView({ kind: "list" });
    setUsdByToken({});
    setPricesUpdatedAt("");
    setExpandedActivity({});
    setToastMsg("Signed out.");
  }

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
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load config.");
    }
  }

  async function refreshBalances(opts?: { silent?: boolean }) {
    if (!jwt) return;
    try {
      const { data } = await apiJsonTry(apiBase, ["/tg/me/balances", "/tg/balances", "/me/balances"], {
        method: "GET",
        headers: authHeaders as any,
      });
      setBalances(Array.isArray(data?.items) ? data.items : []);
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load balances.");
    }
  }

  async function refreshLedgerAll(opts?: { silent?: boolean }) {
    if (!jwt) return;
    try {
      const { data } = await apiJsonTry(
        apiBase,
        ["/tg/me/ledger?limit=120", "/tg/ledger?limit=120", "/me/ledger?limit=120"],
        { method: "GET", headers: authHeaders as any }
      );
      setLedger(Array.isArray(data?.items) ? data.items : []);
    } catch (e: any) {
      if (!opts?.silent) setToastMsg(e?.message ?? "Failed to load activity.");
    }
  }

  function mergeUsdMap(rawMap: Record<string, unknown>) {
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawMap || {})) {
      const n = Number(v);
      if (Number.isFinite(n)) next[String(k).toLowerCase()] = n;
    }
    if (Object.keys(next).length) setUsdByToken((prev) => ({ ...prev, ...next }));
  }

  async function tryRefreshStatsUsd() {
    if (!jwt) return;
    try {
      const { data } = await apiJsonTry(apiBase, ["/tg/me/stats", "/me/stats"], {
        method: "GET",
        headers: authHeaders as any,
      });
      if (!data || typeof data !== "object") return;
      const prices = (data as any).usdByToken || (data as any).prices || {};
      if (prices && typeof prices === "object") mergeUsdMap(prices as Record<string, unknown>);
    } catch {
      // optional endpoint
    }
  }

  async function refreshEnabledTokenPrices(opts?: { silent?: boolean; force?: boolean }) {
    if (!jwt) return;
    try {
      const q = `chainId=${encodeURIComponent(String(chainId))}${opts?.force ? "&refresh=1" : ""}`;
      const { data } = await apiJsonTry(
        apiBase,
        [
          `/tg/me/token-prices?${q}`,
          `/tg/token-prices?${q}`,
          `/me/token-prices?${q}`,
          `/prices/enabled?${q}`,
          `/tg/prices/enabled?${q}`,
        ],
        { method: "GET", headers: authHeaders as any }
      );

      const map: Record<string, number> = {};
      if (Array.isArray(data?.items)) {
        for (const row of data.items as EnabledTokenPriceRow[]) {
          const token = String(row?.token || "").toLowerCase();
          const price = Number((row as any)?.priceUsd);
          if (token && Number.isFinite(price)) map[token] = price;
        }
      }
      const objMap = data?.usdByToken || data?.prices;
      if (objMap && typeof objMap === "object") {
        for (const [k, v] of Object.entries(objMap)) {
          const n = Number(v);
          if (k && Number.isFinite(n)) map[String(k).toLowerCase()] = n;
        }
      }
      if (Array.isArray(data)) {
        for (const row of data as EnabledTokenPriceRow[]) {
          const token = String((row as any)?.token || "").toLowerCase();
          const price = Number((row as any)?.priceUsd);
          if (token && Number.isFinite(price)) map[token] = price;
        }
      }
      if (Object.keys(map).length) setUsdByToken((prev) => ({ ...prev, ...map }));
      setPricesUpdatedAt(new Date().toISOString());
    } catch (e: any) {
      if (!opts?.silent && Number(e?.status) !== 404) {
        setToastMsg(String(e?.message || "Price refresh failed."));
      }
    }
  }

  async function doSend() {
    try {
      if (!jwt) throw new Error("Not signed in.");

      const to = String(sendTo || "").trim();
      if (!to || (!to.startsWith("@") && !to.startsWith("0x") && !to.startsWith("tg:"))) {
        throw new Error("Send to must be @username, tg:<id>, or 0x address.");
      }

      if (view.kind !== "token") throw new Error("Select a token first.");
      const asset = String(view.tokenAddr || "").trim();
      if (!asset) throw new Error("No token selected.");

      const amt = String(sendAmount || "0").trim();
      if (!amt || Number(amt) <= 0) throw new Error("Enter a valid amount.");

      const refId = nowRefId("mini_send");

      await apiJsonTry(apiBase, ["/tg/me/transfer", "/tg/transfer"], {
        method: "POST",
        headers: authHeaders as any,
        body: JSON.stringify({
          refId,
          chainId,
          asset,
          to,
          amount: amt,
        }),
      });

      setToastMsg("Sent.");
      setSendOpen(false);
      refreshBalances({ silent: true }).catch(() => {});
      refreshLedgerAll({ silent: true }).catch(() => {});
      refreshEnabledTokenPrices({ silent: true }).catch(() => {});
      refreshFrontendPrices({ silent: true }).catch(() => {});
    } catch (e: any) {
      setToastMsg(String(e?.message || "Send failed."));
    }
  }

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
    loadPublicConfig({ silent: true }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chains = pub?.chains || [];
  const selectedChain = chains.find((c) => Number(c.chainId) === Number(chainId)) || chains[0];
  const vaults = selectedChain?.vaults || [];
  const selectedVault = vaults.find((v) => vaultKey(v) === String(vaultId)) || vaults[0];
  const resolvedVaultId = vaultKey(selectedVault);
  const vaultAddress = resolveVaultAddress(selectedVault);

  useEffect(() => {
    const v = selectedVault;
    setVaultUsdc((v?.usdc || "").trim());
    setVaultWNative((v?.wNative || "").trim());

    const candidates = new Map<string, RuntimeToken>();
    const push = (addr?: string, symbol?: string, decimals?: number) => {
      const a = String(addr || "").trim();
      if (!a || a.toLowerCase() === ZERO_ADDR) return;
      const low = a.toLowerCase();
      if (!candidates.has(low)) {
        candidates.set(low, {
          address: a,
          symbol: String(symbol || "").trim() || "TOKEN",
          decimals: Number.isFinite(Number(decimals)) ? Number(decimals) : 18,
        });
      } else {
        const cur = candidates.get(low)!;
        if (!cur.symbol || cur.symbol === "TOKEN") cur.symbol = String(symbol || cur.symbol || "TOKEN");
        if (!Number.isFinite(cur.decimals) && Number.isFinite(Number(decimals))) cur.decimals = Number(decimals);
      }
    };

    (selectedChain?.tokens || []).forEach((t) => push(t.address, t.symbol, t.decimals));
    (selectedVault?.tokens || []).forEach((t) => push(t.address, t.symbol, t.decimals));
    push(selectedVault?.wNative, "AVAX", 18);
    push(selectedVault?.usdc, "USDC", 6);

    for (const b of balances || []) {
      if (Number(b.chainId) !== Number(chainId)) continue;
      push(b.token, b.symbol, b.decimals);
    }

    const out = Array.from(candidates.values());
    const wn = (selectedVault?.wNative || "").toLowerCase();
    const uc = (selectedVault?.usdc || "").toLowerCase();
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
  }, [selectedChain, selectedVault, balances, chainId]);

  useEffect(() => {
    if (!jwt) tgLogin().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tokenListMap = useMemo(() => {
    const m = new Map<string, TokenListToken>();
    const items = tokenList?.tokens || [];
    for (const t of items) {
      const addr = (t.address || "").toLowerCase();
      if (!addr) continue;
      const key = `${Number(t.chainId)}:${addr}`;
      m.set(key, t);
    }
    return m;
  }, [tokenList]);

  function tokenListEntryFor(addr: string) {
    const low = (addr || "").toLowerCase();
    return (
      tokenListMap.get(`${Number(chainId)}:${low}`) ||
      Array.from(tokenListMap.entries()).find(([k]) => k.endsWith(`:${low}`))?.[1]
    );
  }

  function logoFor(addr: string) {
    const t = tokenListEntryFor(addr);
    return normalizeLogoUri(t?.logoURI);
  }
  function symFor(addr: string) {
    const low = (addr || "").toLowerCase();
    const rt = runtimeTokens.find((x) => x.address.toLowerCase() === low);
    if (rt?.symbol && rt.symbol !== "TOKEN") return String(rt.symbol).toUpperCase();
    const tl = tokenListEntryFor(addr);
    if (tl?.symbol) return String(tl.symbol).toUpperCase();
    if (low === (vaultWNative || "").toLowerCase()) return "AVAX";
    if (low === (vaultUsdc || "").toLowerCase()) return "USDC";
    return "TOKEN";
  }
  function nameFor(addr: string) {
    const tl = tokenListEntryFor(addr);
    return String(tl?.name || symFor(addr));
  }
  function decFor(addr: string) {
    const low = (addr || "").toLowerCase();
    const rt = runtimeTokens.find((x) => x.address.toLowerCase() === low);
    if (rt?.decimals != null) return Number(rt.decimals);
    const tl = tokenListEntryFor(addr);
    if (tl?.decimals != null) return Number(tl.decimals);
    if (low === (vaultUsdc || "").toLowerCase()) return 6;
    return 18;
  }

  function chainContractsForPricing(cid: number, chain?: PublicChain, vault?: PublicVault) {
    const key = String(cid);
    const fromContracts = contractsJson?.[key];

    const factory = String(fromContracts?.dexV2?.factory || "").trim();
    const usdc = String(fromContracts?.usdc || vault?.usdc || "").trim();
    const wNative = String(fromContracts?.wNative || vault?.wNative || "").trim();
    const rpcHttp = String(fromContracts?.rpcHttp || chain?.rpcHttp || "").trim();
    const chainlinkNativeUsdFeed = String(fromContracts?.chainlinkNativeUsdFeed || "").trim();

    return { factory, usdc, wNative, rpcHttp, chainlinkNativeUsdFeed };
  }

  async function getPairAddress(factoryAddr: string, tokenA: string, tokenB: string, p: JsonRpcProvider) {
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

  async function getReservesNormalized(pairAddr: string, tokenA: string, tokenB: string, p: JsonRpcProvider) {
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

  async function refreshFrontendPrices(opts?: { silent?: boolean }) {
    try {
      const chain = selectedChain;
      const vault = selectedVault;
      if (!chain || !vault) return;

      const { factory, usdc, wNative, rpcHttp, chainlinkNativeUsdFeed } =
        chainContractsForPricing(chainId, chain, vault);

      const usdcAddr = String(usdc || "").trim();
      const wnAddr = String(wNative || "").trim();
      if (!rpcHttp || !isHexAddress(usdcAddr) || !isHexAddress(wnAddr)) return;

      const provider = new JsonRpcProvider(rpcHttp);
      const next: Record<string, number> = {};

      next[usdcAddr.toLowerCase()] = 1;

      if (chainlinkNativeUsdFeed && isHexAddress(chainlinkNativeUsdFeed)) {
        try {
          const nativeUsd = await fetchChainlinkUsd(chainlinkNativeUsdFeed, rpcHttp);
          next[wnAddr.toLowerCase()] = nativeUsd;
        } catch (e) {
          console.warn("Miniapp Chainlink native price failed, falling back to DEX", e);
        }
      }

      const hasFactory = !!factory && isHexAddress(factory);

      if (hasFactory && !Number.isFinite(next[wnAddr.toLowerCase()])) {
        const wnUsdcPair = await getPairAddress(factory, wnAddr, usdcAddr, provider);
        if (wnUsdcPair) {
          const { reserveA: rWn, reserveB: rUsdc } = await getReservesNormalized(
            wnUsdcPair,
            wnAddr,
            usdcAddr,
            provider
          );
          const wnDec = decFor(wnAddr);
          const usdcDec = decFor(usdcAddr);
          const wnAmt = toNumAmount(rWn, wnDec);
          const usdcAmt = toNumAmount(rUsdc, usdcDec);
          if (wnAmt > 0 && usdcAmt > 0) {
            next[wnAddr.toLowerCase()] = usdcAmt / wnAmt;
          }
        }
      }

      const wnUsd = next[wnAddr.toLowerCase()];

      if (hasFactory) {
        const tokensToPrice = Array.from(
          new Set(
            [
              ...runtimeTokens.map((t) => t.address),
              ...balances
                .filter((b) => Number(b.chainId) === Number(chainId))
                .map((b) => String(b.token || "")),
            ].map((a) => String(a || "").toLowerCase())
          )
        ).filter((x) => isHexAddress(x));

        for (const tokenLow of tokensToPrice.slice(0, 20)) {
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
            const tokDec = decFor(tokenLow);
            const usdcDec = decFor(usdcAddr);
            const tokAmt = toNumAmount(rTok, tokDec);
            const usdcAmt = toNumAmount(rUsdc, usdcDec);
            if (tokAmt > 0 && usdcAmt > 0) {
              next[tokenLow] = usdcAmt / tokAmt;
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
              const tokDec = decFor(tokenLow);
              const wnDec = decFor(wnAddr);
              const tokAmt = toNumAmount(rTok, tokDec);
              const wnAmt = toNumAmount(rWn, wnDec);
              if (tokAmt > 0 && wnAmt > 0) {
                next[tokenLow] = (wnAmt / tokAmt) * wnUsd;
              }
            }
          }
        }
      }

      if (Object.keys(next).length) {
        setUsdByToken((prev) => ({ ...prev, ...next }));
        setPricesUpdatedAt(new Date().toISOString());
      }

      console.log("MINI_PRICE_DEBUG", {
        chainId,
        factory,
        chainlinkNativeUsdFeed,
        usdcAddr,
        wnAddr,
        next,
      });
    } catch (e: any) {
      if (!opts?.silent) {
        setToastMsg(String(e?.message || "Miniapp frontend price refresh failed."));
      }
    }
  }

  useEffect(() => {
    if (!authed) return;

    refreshBalances({ silent: true }).catch(() => {});
    refreshLedgerAll({ silent: true }).catch(() => {});
    tryRefreshStatsUsd().catch(() => {});
    refreshEnabledTokenPrices({ silent: true }).catch(() => {});
    refreshFrontendPrices({ silent: true }).catch(() => {});

    const fastIv = window.setInterval(() => {
      refreshBalances({ silent: true }).catch(() => {});
      refreshLedgerAll({ silent: true }).catch(() => {});
    }, 20000);

    const priceIv = window.setInterval(() => {
      tryRefreshStatsUsd().catch(() => {});
      refreshEnabledTokenPrices({ silent: true }).catch(() => {});
      refreshFrontendPrices({ silent: true }).catch(() => {});
    }, 30000);

    return () => {
      window.clearInterval(fastIv);
      window.clearInterval(priceIv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, chainId, resolvedVaultId, contractsJson, runtimeTokens.length, balances.length]);

  const balanceByToken = useMemo(() => {
    const m = new Map<string, BalanceItem>();
    for (const b of balances || []) {
      if (Number(b.chainId) !== Number(chainId)) continue;
      const addr = (b.token || "").toLowerCase();
      if (!addr) continue;
      m.set(addr, b);
    }
    return m;
  }, [balances, chainId]);

  function getAvailableRaw(addr: string) {
    const b = balanceByToken.get(addr.toLowerCase());
    return b?.availableRaw ?? b?.balanceRaw ?? b?.totalRaw ?? "0";
  }

  function tokenUsdValueFromRaw(addr: string, raw: string | undefined) {
    const p = Number(usdByToken[(addr || "").toLowerCase()]);
    if (!Number.isFinite(p)) return NaN;
    const dec = decFor(addr);
    const amt = Number(formatUnits(safeBigInt(raw), dec));
    if (!Number.isFinite(amt)) return NaN;
    return amt * p;
  }

  const tokenRows = useMemo(() => {
    const addrs = new Set<string>();
    for (const t of runtimeTokens) addrs.add(t.address.toLowerCase());
    for (const b of balances || []) {
      if (Number(b.chainId) !== Number(chainId)) continue;
      if (b.token) addrs.add(String(b.token).toLowerCase());
    }

    const out = Array.from(addrs).map((addrLow) => {
      const rt = runtimeTokens.find((x) => x.address.toLowerCase() === addrLow);
      const addr = rt?.address || addrLow;
      const availableRaw = getAvailableRaw(addr);
      return {
        addr,
        sym: symFor(addr),
        name: nameFor(addr),
        availableRaw,
        available: formatAmount(availableRaw, decFor(addr), 8),
        usd: tokenUsdValueFromRaw(addr, availableRaw),
      };
    });

    const wn = (vaultWNative || "").toLowerCase();
    const uc = (vaultUsdc || "").toLowerCase();
    out.sort((a, b) => {
      const al = a.addr.toLowerCase();
      const bl = b.addr.toLowerCase();
      if (wn && al === wn && bl !== wn) return -1;
      if (wn && bl === wn && al !== wn) return 1;
      if (uc && al === uc && bl !== uc) return -1;
      if (uc && bl === uc && al !== uc) return 1;

      const au = Number.isFinite(a.usd) ? Number(a.usd) : -1;
      const bu = Number.isFinite(b.usd) ? Number(b.usd) : -1;
      if (bu !== au) return bu - au;

      return a.sym.localeCompare(b.sym);
    });

    return out;
  }, [runtimeTokens, balances, chainId, vaultWNative, vaultUsdc, usdByToken, tokenListMap]);

  const totalUsd = useMemo(() => {
    let sum = 0;
    for (const t of tokenRows) if (Number.isFinite(t.usd)) sum += Number(t.usd);
    return sum;
  }, [tokenRows]);

  const activityRows: ActivityRow[] = useMemo(() => {
    const collapsed = collapseWithdrawLedger(ledger || []);
    return collapsed.map((x) => {
      const addr = (x.token || "").toLowerCase();
      const d = typeof x.decimals === "number" && Number.isFinite(x.decimals) ? Number(x.decimals) : decFor(addr);
      const sym = x.symbol ? String(x.symbol).toUpperCase() : symFor(addr);
      const usd = tokenUsdValueFromRaw(addr, x.amountRaw);
      return { ...x, sym, human: formatAmount(x.amountRaw, d, 8), usd };
    });
  }, [ledger, runtimeTokens, tokenListMap, usdByToken]);

  const selectedTokenAddr = view.kind === "token" ? view.tokenAddr : "";
  const selectedDecimals = selectedTokenAddr ? decFor(selectedTokenAddr) : 18;
  const selectedSymbol = selectedTokenAddr ? symFor(selectedTokenAddr) : "TOKEN";
  const selectedName = selectedTokenAddr ? nameFor(selectedTokenAddr) : "TOKEN";
  const selectedLogo = selectedTokenAddr ? logoFor(selectedTokenAddr) : "";

  const tokenHistoryRows = useMemo(() => {
    if (view.kind !== "token") return [];
    const low = view.tokenAddr.toLowerCase();
    return activityRows.filter((x) => String(x.token || "").toLowerCase() === low);
  }, [activityRows, view]);

  useEffect(() => {
    if (view.kind !== "list") {
      const exists = tokenRows.some((t) => t.addr.toLowerCase() === view.tokenAddr.toLowerCase());
      if (!exists) setView({ kind: "list" });
    }
  }, [tokenRows, view]);

  function friendlyKindTitle(kind: string, sym: string) {
    const visual = kindVisual(kind);
    return `${visual.label} ${sym}`;
  }

  function usdLineForToken(addr: string, raw: string) {
    const usd = tokenUsdValueFromRaw(addr, raw);
    return Number.isFinite(usd) ? fmtUsd(usd) : "—";
  }

  async function copyWalletUrl() {
    try {
      await navigator.clipboard.writeText(WALLET_APP_URL);
      setToastMsg("Wallet URL copied.");
    } catch {
      setToastMsg("Copy failed.");
    }
  }

  function openWalletApp() {
    try {
      const tg = (window as any)?.Telegram?.WebApp;
      if (tg?.openLink) tg.openLink(WALLET_APP_URL, { try_instant_view: false });
      else window.open(WALLET_APP_URL, "_blank");
    } catch {
      window.open(WALLET_APP_URL, "_blank");
    }
  }

  function TokenAvatar({ addr, sym }: { addr: string; sym: string }) {
    const uri = logoFor(addr);
    if (uri) return <img className="cw-avaImg" src={uri} alt={`${sym} logo`} />;
    return <div className="cw-avaFallback">{sym.slice(0, 1)}</div>;
  }

  function renderFromTo(row: ActivityRow) {
    const from = row.fromAccountId || row.meta?.from || row.meta?.fromAccountId || row.meta?.sender || "";
    const to = row.toAccountId || row.meta?.to || row.meta?.toAccountId || row.meta?.recipient || "";
    return { from: String(from || ""), to: String(to || "") };
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
            gridTemplateColumns: "auto 1fr auto",
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
                </>
              ) : null}
            </div>
            {fromTo.from || fromTo.to ? (
              <div style={{ opacity: 0.8, fontSize: 12, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {fromTo.from ? `From: ${accountIdFriendly(fromTo.from)}` : ""}
                {fromTo.from && fromTo.to ? " · " : ""}
                {fromTo.to ? `To: ${accountIdFriendly(fromTo.to)}` : ""}
              </div>
            ) : null}
          </div>

          <div style={{ textAlign: "right", minWidth: 88 }}>
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
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr",
                gap: 8,
                fontSize: 13,
              }}
            >
              <DetailRow label="Type" value={String(row.kind || "—")} mono={false} />
              <DetailRow label="Token" value={`${row.sym} · ${String(row.token || "")}`} mono />
              <DetailRow label="Amount" value={`${row.human} ${row.sym}`} mono={false} />
              <DetailRow
                label="USD"
                value={Number.isFinite(row.usd as number) ? fmtUsd(Number(row.usd)) : "—"}
                mono={false}
              />
              <DetailRow label="Time" value={formatWhen(row.ts)} mono={false} />
              <DetailRow label="From" value={fromTo.from ? accountIdFriendly(fromTo.from) : "—"} mono />
              <DetailRow label="To" value={fromTo.to ? accountIdFriendly(fromTo.to) : "—"} mono />
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
                    }}
                  >
                    <Icon name="link" /> Open transaction link
                  </a>
                </div>
              ) : null}

              {row.meta ? (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ cursor: "pointer", opacity: 0.9, fontWeight: 700 }}>
                    Technical details (debug)
                  </summary>
                  <pre
                    style={{
                      marginTop: 8,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontSize: 12,
                      padding: 10,
                      borderRadius: 10,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    {JSON.stringify(row.meta, null, 2)}
                  </pre>
                </details>
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
          gridTemplateColumns: "88px 1fr",
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
    return (
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "8px 8px calc(8px + env(safe-area-inset-bottom, 0px))",
          backdropFilter: "blur(10px)",
          background: "rgba(10,14,28,0.80)",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0,1fr))",
          gap: 8,
          zIndex: 60,
        }}
      >
        {(["tokens", "activity", "account", "open"] as const).map((k) => (
          <button
            key={k}
            className={"cw-tab " + (tab === k ? "cw-tabOn" : "")}
            onClick={() => {
              setTab(k);
              if (k === "open") setWalletUrlOpen(true);
            }}
            type="button"
            style={{ justifyContent: "center", minWidth: 0 }}
          >
            <Icon
              name={
                k === "tokens" ? "tokens" : k === "activity" ? "activity" : k === "account" ? "account" : "open"
              }
            />{" "}
            <span style={{ whiteSpace: "nowrap" }}>
              {k === "tokens" ? "Wallet" : k === "activity" ? "Activity" : k === "account" ? "Account" : "Open"}
            </span>
          </button>
        ))}
      </div>
    );
  }

  const pageStyle = isMobile
    ? ({
        padding: "6px 6px 86px",
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
      } as React.CSSProperties)
    : ({
        paddingBottom: 78,
      } as React.CSSProperties);

  const cardTightStyle = sectionCardStyle(isMobile);

  return (
    <div className="cw-page" style={pageStyle}>
      {!isMobile ? (
        <div className="cw-tabs">
          <button className={"cw-tab " + (tab === "tokens" ? "cw-tabOn" : "")} onClick={() => setTab("tokens")} type="button">
            <Icon name="tokens" /> Wallet
          </button>
          <button className={"cw-tab " + (tab === "activity" ? "cw-tabOn" : "")} onClick={() => setTab("activity")} type="button">
            <Icon name="activity" /> Activity
          </button>
          <button className={"cw-tab " + (tab === "account" ? "cw-tabOn" : "")} onClick={() => setTab("account")} type="button">
            <Icon name="account" /> Account
          </button>
          <button
            className={"cw-tab " + (tab === "open" ? "cw-tabOn" : "")}
            onClick={() => {
              setTab("open");
              setWalletUrlOpen(true);
            }}
            type="button"
          >
            <Icon name="open" /> Open
          </button>
          <div className="cw-spacer" />
          <MiniBtn
            kind="ghost"
            onClick={() => {
              if (!authed) return setToastMsg("Sign in first.");
              refreshBalances({ silent: true });
              refreshLedgerAll({ silent: true });
              tryRefreshStatsUsd();
              refreshEnabledTokenPrices({ silent: true, force: true });
              refreshFrontendPrices({ silent: true });
              setToastMsg("Refreshed.");
            }}
            disabled={!authed}
          >
            <Icon name="refresh" /> Refresh
          </MiniBtn>
        </div>
      ) : null}

      {toast ? <div className="cw-toast">{toast}</div> : null}

      {!authed && authError ? (
        <div className="cw-card" style={{ marginBottom: 10, ...cardTightStyle }}>
          <div className="cw-cardHead">
            <div className="cw-cardTitle">Sign-in problem</div>
            <div className="cw-cardSub" style={{ wordBreak: "break-word" as any }}>
              {authError}
            </div>
          </div>
          <div className="cw-actionsRow" style={{ marginTop: 10 }}>
            <ActionBtn icon={<Icon name="refresh" />} label="Retry Sign-in" kind="primary" onClick={() => tgLogin()} />
          </div>
        </div>
      ) : null}

      {tab === "tokens" ? (
        <>
          {view.kind === "list" ? (
            <>
              <div className="cw-card" style={cardTightStyle}>
                <div className="cw-cardHead">
                  <div className="cw-cardTitle">Your Wallet</div>
                  <div className="cw-cardSub">Balances and token values in your cashier account.</div>
                </div>

                <div
                  style={{
                    marginTop: 2,
                    padding: isMobile ? "12px" : "14px",
                    borderRadius: 14,
                    border: "1px solid rgba(255,255,255,0.07)",
                    background: "rgba(255,255,255,0.03)",
                  }}
                >
                  <div style={{ opacity: 0.75, fontSize: 12 }}>Total estimated value</div>
                  <div style={{ fontSize: isMobile ? 28 : 34, fontWeight: 900, marginTop: 4 }}>
                    {authed ? fmtUsd(totalUsd) : "—"}
                  </div>
                  <div style={{ opacity: 0.68, fontSize: 12, marginTop: 6 }}>
                    {pricesUpdatedAt ? `Prices updated ${formatWhen(pricesUpdatedAt)}` : "Waiting for token prices..."}
                  </div>
                </div>

                {!authed ? (
                  <div className="cw-empty">{authError ? "Waiting for sign-in…" : "Preparing sign-in…"}</div>
                ) : (
                  <div className="cw-list" style={{ marginTop: 8 }}>
                    {tokenRows.length ? (
                      tokenRows.map((t) => (
                        <button
                          key={t.addr.toLowerCase()}
                          className="cw-row"
                          onClick={() => setView({ kind: "token", tokenAddr: t.addr })}
                          type="button"
                          style={{
                            padding: isMobile ? "12px" : undefined,
                            alignItems: "center",
                          }}
                        >
                          <div className="cw-left" style={{ gap: 10 }}>
                            <div className="cw-ava">
                              <TokenAvatar addr={t.addr} sym={t.sym} />
                            </div>
                            <div className="cw-meta" style={{ minWidth: 0 }}>
                              <div className="cw-sym" style={{ fontSize: 15 }}>{t.sym}</div>
                              <div className="cw-sub" style={{ fontSize: 12 }}>{t.name}</div>
                            </div>
                          </div>

                          <div className="cw-right" style={{ textAlign: "right" }}>
                            <div style={{ fontWeight: 800, lineHeight: 1.2 }}>{t.available}</div>
                            <div className="cw-sub" style={{ marginTop: 4, fontSize: 12 }}>
                              {Number.isFinite(t.usd as number) ? fmtUsd(Number(t.usd)) : "—"}
                            </div>
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="cw-empty">No balances yet.</div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="cw-card" style={cardTightStyle}>
              <div className="cw-tokenHead">
                <MiniBtn kind="ghost" onClick={() => setView({ kind: "list" })}>
                  <Icon name="back" /> Back
                </MiniBtn>

                <div className="cw-tokenHeadMid" style={{ minWidth: 0 }}>
                  <div className="cw-ava cw-avaLg">
                    {selectedLogo ? (
                      <img className="cw-avaImg" src={selectedLogo} alt={`${selectedSymbol} logo`} />
                    ) : (
                      <div className="cw-avaFallback">{selectedSymbol.slice(0, 1)}</div>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="cw-tokenSym">{selectedSymbol}</div>
                    <div className="cw-sub" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {selectedName}
                    </div>
                  </div>
                </div>

                <MiniBtn
                  kind="ghost"
                  onClick={() => {
                    if (!authed) return setToastMsg("Sign in first.");
                    refreshBalances({ silent: true });
                    refreshLedgerAll({ silent: true });
                    tryRefreshStatsUsd();
                    refreshEnabledTokenPrices({ silent: true, force: true });
                    refreshFrontendPrices({ silent: true });
                  }}
                  disabled={!authed}
                >
                  <Icon name="refresh" /> Refresh
                </MiniBtn>
              </div>

              <div
                style={{
                  marginTop: 8,
                  marginBottom: 8,
                  padding: isMobile ? "14px 12px" : "18px 14px 12px",
                  borderRadius: 16,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.07)",
                  textAlign: "center",
                }}
              >
                <div style={{ opacity: 0.85, fontWeight: 800 }}>{selectedSymbol}</div>
                <div style={{ marginTop: 8, fontSize: isMobile ? 32 : 44, fontWeight: 900, lineHeight: 1.05 }}>
                  {formatAmount(getAvailableRaw(selectedTokenAddr), selectedDecimals, 8)}
                </div>
                <div style={{ marginTop: 6, fontSize: isMobile ? 15 : 18, fontWeight: 800, opacity: 0.95 }}>
                  {usdLineForToken(selectedTokenAddr, getAvailableRaw(selectedTokenAddr))}
                </div>
                <div style={{ marginTop: 8, opacity: 0.7, fontSize: 12 }}>{shortAddr(selectedTokenAddr)}</div>
              </div>

              <div className="cw-actionsRow" style={{ gap: isMobile ? 8 : undefined }}>
                <ActionBtn icon={<Icon name="deposit" />} label="Deposit" kind="primary" onClick={() => setWalletUrlOpen(true)} disabled={!authed} />
                <ActionBtn icon={<Icon name="withdraw" />} label="Withdraw" onClick={() => setWalletUrlOpen(true)} disabled={!authed} />
                <ActionBtn
                  icon={<Icon name="send" />}
                  label="Send"
                  onClick={() => {
                    setSendAmount("0.01");
                    setSendTo("@");
                    setSendOpen(true);
                  }}
                  disabled={!authed}
                />
              </div>

              <div className="cw-cardHead" style={{ paddingTop: 8 }}>
                <div className="cw-cardTitle">Recent {selectedSymbol} activity</div>
                <div className="cw-cardSub">Tap a row to show details, from/to and transaction link.</div>
              </div>

              <div className="cw-activity">
                {authed ? (
                  tokenHistoryRows.length ? (
                    tokenHistoryRows.map((x) => <ActivityCard key={x.refId} row={x} compact />)
                  ) : (
                    <div className="cw-empty">No history yet for this token.</div>
                  )
                ) : (
                  <div className="cw-empty">Waiting for sign-in…</div>
                )}
              </div>
            </div>
          )}
        </>
      ) : null}

      {tab === "activity" ? (
        <div className="cw-card" style={cardTightStyle}>
          <div className="cw-cardHead">
            <div className="cw-cardTitle">Activity</div>
            <div className="cw-cardSub">Latest activity across all tokens. Tap any row for details.</div>
          </div>

          {!authed ? (
            <div className="cw-empty">Waiting for sign-in…</div>
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

      {tab === "account" ? (
        <div className="cw-card" style={cardTightStyle}>
          <div className="cw-cardHead">
            <div className="cw-cardTitle">Account</div>
            <div className="cw-cardSub">Friendly wallet info first. Technical details are in Debug.</div>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            <div
              style={{
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 14,
                background: "rgba(255,255,255,0.02)",
                padding: 12,
              }}
            >
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ opacity: 0.75 }}>Sign-in</div>
                  <div>{authed ? <Pill>Signed in</Pill> : <span style={{ opacity: 0.8 }}>Not signed in</span>}</div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ opacity: 0.75 }}>Network</div>
                  <div style={{ fontWeight: 700 }}>{selectedChain?.name || `Chain ${chainId}`}</div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ opacity: 0.75 }}>Vault</div>
                  <div style={{ fontWeight: 700, textAlign: "right" }}>{selectedVault?.label || resolvedVaultId || "—"}</div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ opacity: 0.75 }}>Price cache</div>
                  <div style={{ fontWeight: 700 }}>{Object.keys(usdByToken).length} tokens</div>
                </div>
              </div>
            </div>

            <div className="cw-settingBtns">
              {!authed ? (
                <MiniBtn kind="primary" onClick={() => tgLogin()}>
                  Retry Telegram Sign-in
                </MiniBtn>
              ) : null}

              <MiniBtn kind="ghost" onClick={() => loadPublicConfig({ silent: false })}>
                Reload config
              </MiniBtn>

              <MiniBtn
                kind="ghost"
                onClick={() => {
                  if (!authed) return setToastMsg("Sign in first.");
                  refreshBalances({ silent: true });
                  refreshLedgerAll({ silent: true });
                  tryRefreshStatsUsd();
                  refreshEnabledTokenPrices({ silent: true, force: true });
                  refreshFrontendPrices({ silent: true });
                  setToastMsg("Refreshed.");
                }}
                disabled={!authed}
              >
                <Icon name="refresh" /> Refresh
              </MiniBtn>

              <MiniBtn kind="ghost" onClick={() => setWalletUrlOpen(true)}>
                <Icon name="open" /> Wallet URL
              </MiniBtn>

              {authed ? (
                <MiniBtn kind="danger" onClick={logout}>
                  Sign out
                </MiniBtn>
              ) : null}
            </div>

            <div
              style={{
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 12,
                overflow: "hidden",
                background: "rgba(255,255,255,0.015)",
              }}
            >
              <button
                type="button"
                onClick={() => setDebugOpen((v) => !v)}
                style={{
                  width: "100%",
                  border: 0,
                  background: "transparent",
                  color: "inherit",
                  padding: "12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Icon name="debug" /> Debug / Technical details
                </span>
                <span style={{ transform: debugOpen ? "rotate(180deg)" : "none", transition: "0.15s" }}>
                  <Icon name="chev" />
                </span>
              </button>

              {debugOpen ? (
                <div style={{ padding: "0 12px 12px" }}>
                  {authError ? (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ opacity: 0.7, fontSize: 12 }}>Last auth error</div>
                      <div style={{ wordBreak: "break-word" }}>{authError}</div>
                    </div>
                  ) : null}

                  <div style={{ display: "grid", gap: 8 }}>
                    <DebugKV label="API Base" value={apiBase || "—"} />
                    <DebugKV label="Chain ID" value={String(chainId)} />
                    <DebugKV label="Vault ID" value={resolvedVaultId || "—"} />
                    <DebugKV label="Vault Address" value={vaultAddress || "—"} />
                    <DebugKV label="wNative" value={vaultWNative || "—"} />
                    <DebugKV label="USDC" value={vaultUsdc || "—"} />
                    <DebugKV label="Prices Updated" value={pricesUpdatedAt ? formatWhen(pricesUpdatedAt) : "—"} />
                    <DebugKV label="Contracts JSON" value={contractsJson ? "loaded" : "not loaded"} />
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div style={{ opacity: 0.7, fontSize: 12, marginBottom: 4 }}>Select chain</div>
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

                  <div style={{ marginTop: 10 }}>
                    <div style={{ opacity: 0.7, fontSize: 12, marginBottom: 4 }}>Select vault</div>
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
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "open" ? (
        <div className="cw-card" style={cardTightStyle}>
          <div className="cw-cardHead">
            <div className="cw-cardTitle">Open Wallet / Dapp</div>
            <div className="cw-cardSub">Use the full wallet page for deposit / withdraw flows.</div>
          </div>

          <div
            style={{
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 14,
              background: "rgba(255,255,255,0.02)",
              padding: 12,
            }}
          >
            <div style={{ opacity: 0.7, fontSize: 12 }}>Wallet URL</div>
            <div className="cw-mono" style={{ wordBreak: "break-all", marginTop: 6, fontSize: 13 }}>
              {WALLET_APP_URL}
            </div>

            <div className="cw-settingBtns" style={{ marginTop: 12 }}>
              <MiniBtn kind="ghost" onClick={copyWalletUrl}>
                <Icon name="copy" /> Copy URL
              </MiniBtn>
              <MiniBtn kind="primary" onClick={openWalletApp}>
                <Icon name="open" /> Open in browser
              </MiniBtn>
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        open={sendOpen}
        title={`Send ${selectedSymbol}`}
        onClose={() => setSendOpen(false)}
        footer={
          <div className="cw-modalBtns">
            <MiniBtn kind="ghost" onClick={() => setSendOpen(false)}>
              Cancel
            </MiniBtn>
            <MiniBtn
              kind="primary"
              onClick={async () => {
                await doSend();
              }}
              disabled={!authed || !selectedTokenAddr}
            >
              Send
            </MiniBtn>
          </div>
        }
      >
        <div className="cw-form">
          <label className="cw-label">Send to</label>
          <input
            className="cw-input cw-mono"
            value={sendTo}
            onChange={(e) => setSendTo(e.target.value)}
            placeholder="@username, tg:1234, or 0x..."
          />

          <label className="cw-label">Amount</label>
          <input className="cw-input" value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />

          <div className="cw-help">
            Available:{" "}
            <b>
              {formatAmount(getAvailableRaw(selectedTokenAddr), selectedDecimals, 8)} {selectedSymbol}
            </b>
          </div>
          <div className="cw-help">
            Approx value: <b>{usdLineForToken(selectedTokenAddr, getAvailableRaw(selectedTokenAddr))}</b>
          </div>
        </div>
      </Modal>

      <Modal
        open={walletUrlOpen}
        title="Open Wallet / Dapp"
        onClose={() => setWalletUrlOpen(false)}
        footer={
          <div className="cw-modalBtns">
            <MiniBtn kind="ghost" onClick={() => setWalletUrlOpen(false)}>
              Close
            </MiniBtn>
            <MiniBtn kind="ghost" onClick={copyWalletUrl}>
              <Icon name="copy" /> Copy URL
            </MiniBtn>
            <MiniBtn kind="primary" onClick={openWalletApp}>
              <Icon name="open" /> Open in browser
            </MiniBtn>
          </div>
        }
      >
        <div className="cw-form">
          <div className="cw-help">Use the wallet page for deposit / withdraw flows in the browser wallet.</div>
          <label className="cw-label">URL</label>
          <input className="cw-input cw-mono" readOnly value={WALLET_APP_URL} onFocus={(e) => e.currentTarget.select()} />
          <div className="cw-help">Deposit / Withdraw buttons in this miniapp open this same destination.</div>
        </div>
      </Modal>

      {isMobile ? <BottomNav /> : null}
    </div>
  );
}

function DebugKV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 8 }}>
      <div style={{ opacity: 0.7 }}>{label}</div>
      <div className="cw-mono" style={{ wordBreak: "break-word" }}>
        {value}
      </div>
    </div>
  );
}
