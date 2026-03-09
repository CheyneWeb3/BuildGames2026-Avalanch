import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import { useApiBase } from '../../ApiBaseContext';
import { useAppKitAccount, useAppKitProvider, useAppKitNetwork } from '../../config';
import {
  Trophy,
  Coins,
  Wallet,
  History,
  RefreshCw,
  LogOut,
  ChevronLeft,
  AlertCircle,
  TrendingUp,
  Dice5,
  ArrowDownCircle,
  ArrowUpCircle
} from 'lucide-react';

const LS_JWT = 'haus_user_jwt';
const TARGET_CHAIN_ID = 43113;
const INFO_PATHS = ['/games/dice/info', '/me/dice/info'];
const ROLL_PATHS = ['/games/dice/roll', '/me/dice/play'];

// --- ABIs ---
const VAULT_WRITE_ABI = [
  "function depositFor(address token, uint256 amount, address creditTo)",
  "function depositNativeFor(address creditTo) payable",
] as const;

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

const ERC20_BAL_ABI = ["function balanceOf(address owner) view returns (uint256)"] as const;

// --- Types ---
type BalanceItem = { chainId: number; token: string; symbol?: string; decimals?: number; balanceRaw?: string; availableRaw?: string; heldRaw?: string; totalRaw?: string; balanceHuman?: string; updatedAt?: string; };
type LedgerItem = { refId: string; ts: string; kind: string; chainId: number; token: string; amountRaw: string; meta?: any; };
type DiceInfo = { ok?: boolean; chainId?: number; enabledTokens?: string[]; defaultToken?: string; defaultTokenSymbol?: string; winMultiplier?: number; winMultipliers?: number[]; winningRoll?: number; minBetHuman?: string; maxBetHuman?: string; };
type DiceRoll = { ok?: boolean; chainId?: number; asset?: string; token?: string; symbol?: string; betHuman?: string; payoutHuman?: string; roll?: number; multiplier?: number; win?: boolean; clientRequestId?: string; balanceAfterHuman?: string; };
type RollHistoryItem = DiceRoll & { id: string; ts: number };
type TokenOption = { key: string; token: string; symbol: string; decimals: number; availableRaw: string; heldRaw: string; availableHuman: string; };
type TokenListToken = { chainId: number; address: string; symbol?: string; decimals?: number; };
type PublicConfig = { ok?: boolean; chains?: { chainId: number; rpcHttp?: string; vaults?: { vaultId?: string; id?: string; address?: string; vaultAddress?: string; wNative?: string; }[] }[] };

// --- Utility Functions ---
function safeBigInt(v?: string) {
  try {
    const s = String(v || '0').trim();
    return /^-?\d+$/.test(s) ? BigInt(s) : BigInt(0);
  } catch {
    return BigInt(0);
  }
}

function formatAmount(raw: string | undefined, decimals: number, maxFrac = 6) {
  try {
    const full = formatUnits(safeBigInt(raw), decimals);
    if (!full.includes('.')) return full;
    const [a, b] = full.split('.');
    const trimmed = (b || '').slice(0, maxFrac).replace(/0+$/g, '');
    return trimmed ? `${a}.${trimmed}` : a;
  } catch {
    return '0';
  }
}

function numFromHuman(v: any): number {
  const n = Number(String(v ?? '0').trim());
  return Number.isFinite(n) ? n : 0;
}

function shortAddr(a?: string) {
  const s = String(a || '').trim();
  if (!s) return '—';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function ledgerKindLabel(kind: string) {
  const k = String(kind || '').toLowerCase();
  if (k === 'dice_payout') return 'Win payout';
  if (k === 'dice_bet') return 'Bet placed';
  if (k === 'dice_loss_fee') return 'Loss fee';
  if (k === 'fee') return 'Fee';
  return kind || 'Activity';
}

function nowRefId(prefix: string) {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}:${Date.now()}:${rnd}`;
}

function normalizeRollResponse(raw: any, fallback: { token?: string; symbol?: string; betHuman?: string; reqId?: string; winningRoll?: number; winMultiplier?: number; }): DiceRoll {
  const payoutHuman = raw?.payoutHuman ?? raw?.payout ?? raw?.winAmountHuman ?? raw?.amountHuman ?? '0';
  const betHuman = raw?.betHuman ?? raw?.amountHuman ?? fallback.betHuman ?? '0';

  const roll = raw?.roll != null ? Number(raw.roll) : undefined;
  const multiplier = raw?.multiplier != null ? Number(raw.multiplier) :
                     raw?.multiplierHuman != null ? Number(raw.multiplierHuman) :
                     fallback.winMultiplier != null ? Number(fallback.winMultiplier) : undefined;

  const rawWin = raw?.win ?? raw?.didWin ?? raw?.isWin;
  const winningRoll = Number(fallback.winningRoll ?? 6);

  let win = false;
  if (typeof rawWin === 'boolean') { win = rawWin; }
  else if (roll != null && Number.isFinite(roll)) { win = roll === winningRoll; }
  else { win = numFromHuman(payoutHuman) > 0; }

  const finalPayoutHuman = win && (!payoutHuman || numFromHuman(payoutHuman) <= 0) && multiplier && numFromHuman(betHuman) > 0
    ? String(numFromHuman(betHuman) * multiplier)
    : String(payoutHuman || '0');

  return { ok: raw?.ok ?? true, chainId: Number(raw?.chainId ?? TARGET_CHAIN_ID), asset: String(raw?.asset || raw?.assetSymbol || raw?.symbol || fallback.symbol || '').toUpperCase(), token: String(raw?.token || raw?.assetAddress || fallback.token || '').toLowerCase(), symbol: String(raw?.symbol || raw?.asset || raw?.assetSymbol || fallback.symbol || '').toUpperCase(), betHuman: String(betHuman), payoutHuman: finalPayoutHuman, roll, multiplier, win, clientRequestId: String(raw?.clientRequestId || raw?.requestId || fallback.reqId || ''), balanceAfterHuman: raw?.balanceAfterHuman != null ? String(raw.balanceAfterHuman) : undefined };
}

async function apiRequest<T>(base: string, path: string, jwt: string, init?: RequestInit): Promise<T> {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  const res = await fetch(`${cleanBase}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(init?.headers || {}), }, });
  const txt = await res.text().catch(() => '');
  let data: any = null; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(String(data?.error || data?.message || data?.raw || `${res.status} ${res.statusText}`));
  return data as T;
}

async function tryPaths<T>(base: string, paths: string[], jwt: string, initFactory: (path: string) => RequestInit): Promise<T> {
  let lastErr: any = null;
  for (const path of paths) { try { return await apiRequest<T>(base, path, jwt, initFactory(path)); } catch (e: any) { lastErr = e; if (!/404|Cannot (GET|POST)|not found/i.test(String(e?.message || e || ''))) throw e; } }
  throw lastErr || new Error('No working endpoint found');
}

function normalizeBalances(raw: any): BalanceItem[] {
  const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.balances) ? raw.balances : Array.isArray(raw) ? raw : [];
  return items.map((x: any) => ({ chainId: Number(x.chainId || 0), token: String(x.token || '').toLowerCase(), symbol: String(x.symbol || ''), decimals: Number(x.decimals ?? 18), balanceRaw: String(x.balanceRaw ?? x.balance ?? x.totalRaw ?? '0'), availableRaw: String(x.availableRaw ?? x.balanceRaw ?? x.balance ?? x.totalRaw ?? '0'), heldRaw: String(x.heldRaw ?? '0'), totalRaw: String(x.totalRaw ?? x.balanceRaw ?? x.balance ?? '0'), balanceHuman: typeof x.balanceHuman === 'string' ? x.balanceHuman : undefined, updatedAt: String(x.updatedAt || ''), }));
}

function normalizeLedger(raw: any): LedgerItem[] {
  const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
  return items.map((x: any) => ({ refId: String(x.refId || x.id || `${x.kind || 'row'}-${x.ts || Date.now()}`), ts: String(x.ts || x.createdAt || x.updatedAt || ''), kind: String(x.kind || ''), chainId: Number(x.chainId || 0), token: String(x.token || '').toLowerCase(), amountRaw: String(x.amountRaw ?? x.amount ?? '0'), meta: x.meta || {}, }));
}

// --- Specialized Game Components ---

const MoneyRain = ({ active }: { active: boolean }) => {
  if (!active) return null;
  return (
    <div className="money-rain-container">
      {[...Array(35)].map((_, i) => (
        <div key={i} className="rain-item" style={{ left: `${Math.random() * 100}%`, animationDelay: `${Math.random() * 1.5}s` }}>
          {['💰', '💵', '💎', '✨', '🔥'][Math.floor(Math.random() * 5)]}
        </div>
      ))}
    </div>
  );
};

const Dice3D = ({ rolling, value, result }: { rolling: boolean; value: number; result: DiceRoll | null }) => {
  const faceRotations = {
    1: 'rotateX(0deg) rotateY(0deg)',
    2: 'rotateX(0deg) rotateY(-90deg)',
    3: 'rotateX(-90deg) rotateY(0deg)',
    4: 'rotateX(90deg) rotateY(0deg)',
    5: 'rotateX(0deg) rotateY(90deg)',
    6: 'rotateX(0deg) rotateY(180deg)',
  };

  return (
    <div className={`dice-scene ${result && !result.win ? 'shake-loss' : ''}`}>
      <div className={`dice-cube ${rolling ? 'is-rolling' : ''}`} style={{ transform: rolling ? undefined : (faceRotations[value as keyof typeof faceRotations] || faceRotations[1]) }}>
        <div className="dice-face face-1"><span></span></div>
        <div className="dice-face face-6"><span></span><span></span><span></span><span></span><span></span><span></span></div>
        <div className="dice-face face-2"><span></span><span></span></div>
        <div className="dice-face face-5"><span></span><span></span><span></span><span></span><span></span></div>
        <div className="dice-face face-3"><span></span><span></span><span></span></div>
        <div className="dice-face face-4"><span></span><span></span><span></span><span></span></div>
      </div>
      <div className="dice-shadow"></div>
    </div>
  );
};

// --- Modals ---
const Modal = ({ open, title, onClose, children }: { open: boolean, title: string, onClose: () => void, children: React.ReactNode }) => {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button onClick={onClose} className="modal-close">✕</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  );
};

export default function DiceBrowserPage() {
  const nav = useNavigate();
  const apiBase = useApiBase();
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider('eip155');
  const { chainId: appkitChainId } = useAppKitNetwork();

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || '');
  const [balances, setBalances] = useState<BalanceItem[]>([]);
  const [ledger, setLedger] = useState<LedgerItem[]>([]);
  const [diceInfo, setDiceInfo] = useState<DiceInfo | null>(null);
  const [pubConfig, setPubConfig] = useState<PublicConfig | null>(null);
  const [tokenList, setTokenList] = useState<TokenListToken[]>([]);
  const [selectedToken, setSelectedToken] = useState('');

  const [betHuman, setBetHuman] = useState('0.05');
  const [cashierAmount, setCashierAmount] = useState('1.0');

  const [loading, setLoading] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [cashierBusy, setCashierBusy] = useState(false);

  const [err, setErr] = useState('');
  const [result, setResult] = useState<DiceRoll | null>(null);
  const [rolls, setRolls] = useState<RollHistoryItem[]>([]);

  // Animation & Modals
  const [diceValue, setDiceValue] = useState(1);
  const [showRain, setShowRain] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  // New Wallet Balances for the Cashier Interface
  const [walletTokenBalRaw, setWalletTokenBalRaw] = useState<string>("0");
  const [walletNativeBalRaw, setWalletNativeBalRaw] = useState<string>("0");

  const authed = !!jwt;

  useEffect(() => {
    const onStorage = () => setJwt(localStorage.getItem(LS_JWT) || '');
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch('/tokenlist.json', { cache: 'no-cache' });
        if (!r.ok) return;
        const j = await r.json();
        if (!dead) setTokenList((Array.isArray(j?.tokens) ? j.tokens : []) as TokenListToken[]);
      } catch { if (!dead) setTokenList([]); }
    })();
    return () => { dead = true; };
  }, []);

  const tokenMetaByChainAddr = useMemo(() => {
    const m = new Map<string, { symbol: string; decimals: number }>();
    for (const t of tokenList) {
      const cid = Number(t?.chainId || 0);
      const addr = String(t?.address || '').trim().toLowerCase();
      if (cid && addr) m.set(`${cid}:${addr}`, { symbol: String(t?.symbol || '').toUpperCase(), decimals: Number(t?.decimals ?? 18) });
    }
    return m;
  }, [tokenList]);

  const load = useCallback(async () => {
    if (!apiBase) { setLoading(false); setErr('Waiting for API base...'); return; }

    // Load config even if not authed so we know the vault address
    try {
      const conf = await apiRequest<PublicConfig>(apiBase, '/config/public', '');
      setPubConfig(conf);
    } catch(e) { console.warn("Failed to load public config", e); }

    if (!authed) { setBalances([]); setLedger([]); setDiceInfo(null); setLoading(false); return; }
    try {
      setLoading(true); setErr('');
      const [infoRes, balRes, ledRes] = await Promise.all([
        tryPaths<DiceInfo>(apiBase, INFO_PATHS, jwt, () => ({ method: 'POST', body: JSON.stringify({ chainId: TARGET_CHAIN_ID }), })),
        apiRequest<any>(apiBase, '/me/balances', jwt, { method: 'GET' }),
        apiRequest<any>(apiBase, '/me/ledger?limit=120', jwt, { method: 'GET' }),
      ]);
      setDiceInfo(infoRes || null);
      setBalances(normalizeBalances(balRes));
      setLedger(normalizeLedger(ledRes));
    } catch (e: any) { setErr(String(e?.message || e || 'Failed to load data.')); } finally { setLoading(false); }
  }, [apiBase, authed, jwt]);

  useEffect(() => { void load(); }, [load]);

  const enabledTokenMatchers = useMemo(() => {
    const symbols = new Set<string>();
    const addrs = new Set<string>();
    for (const t of diceInfo?.enabledTokens || []) {
      const s = String(t || '').trim();
      if (!s) continue;
      if (s.startsWith('0x')) addrs.add(s.toLowerCase()); else symbols.add(s.toUpperCase());
    }
    const dAddr = String(diceInfo?.defaultToken || '').trim();
    if (dAddr.startsWith('0x')) addrs.add(dAddr.toLowerCase());
    const dSym = String(diceInfo?.defaultTokenSymbol || '').trim();
    if (dSym) symbols.add(dSym.toUpperCase());
    return { symbols, addrs };
  }, [diceInfo]);

  const balanceRows = useMemo<TokenOption[]>(() => {
    return balances.filter((b) => Number(b.chainId) === TARGET_CHAIN_ID).map((b) => {
      const token = String(b.token || '').toLowerCase();
      const meta = tokenMetaByChainAddr.get(`${Number(b.chainId)}:${token}`);
      const symbol = String(b.symbol || meta?.symbol || '').toUpperCase() || shortAddr(token);
      const dec = Number.isFinite(Number(meta?.decimals)) ? Number(meta?.decimals) : (Number.isFinite(Number(b.decimals)) ? Number(b.decimals) : (symbol === 'USDC' ? 6 : 18));
      const avail = String(b.availableRaw ?? b.balanceRaw ?? '0');
      return { key: `${b.chainId}:${token}`, token, symbol, decimals: dec, availableRaw: avail, heldRaw: String(b.heldRaw ?? '0'), availableHuman: formatAmount(avail, dec, 6), };
    }).filter((b) => {
      const hasRules = enabledTokenMatchers.symbols.size || enabledTokenMatchers.addrs.size;
      return !hasRules || enabledTokenMatchers.symbols.has(b.symbol) || enabledTokenMatchers.addrs.has(b.token);
    }).sort((a, b) => {
      if (a.symbol === 'USDC' && b.symbol !== 'USDC') return -1;
      if (b.symbol === 'USDC' && a.symbol !== 'USDC') return 1;
      return (safeBigInt(b.availableRaw) > safeBigInt(a.availableRaw) ? 1 : -1);
    });
  }, [balances, enabledTokenMatchers, tokenMetaByChainAddr]);

  // USDC Priority Logic
  useEffect(() => {
    if (!balanceRows.length) return;
    if (balanceRows.some((x) => x.symbol === selectedToken)) return;

    const usdc = balanceRows.find((x) => x.symbol === 'USDC');
    const prefSym = String(diceInfo?.defaultTokenSymbol || '').toUpperCase();
    const prefAddr = String(diceInfo?.defaultToken || '').toLowerCase();

    const bySym = prefSym ? balanceRows.find((x) => x.symbol === prefSym) : null;
    const byAddr = prefAddr ? balanceRows.find((x) => x.token === prefAddr) : null;

    setSelectedToken((usdc || bySym || byAddr || balanceRows[0]).symbol);
  }, [balanceRows, selectedToken, diceInfo]);

  const selectedBalance = useMemo(() => balanceRows.find((x) => x.symbol === selectedToken) || null, [balanceRows, selectedToken]);

  const recentLedger = useMemo(() => {
    return ledger.filter((x) => Number(x.chainId) === TARGET_CHAIN_ID).filter((x) => {
      const k = String(x.kind || '').toLowerCase();
      return k.startsWith('dice_') || String(x.meta?.game || '').toLowerCase() === 'dice';
    }).slice().sort((a, b) => Date.parse(String(b.ts || '')) - Date.parse(String(a.ts || ''))).slice(0, 15).map((x) => {
      const tL = String(x.token || '').toLowerCase();
      const m = balanceRows.find((b) => b.token === tL);
      const meta = tokenMetaByChainAddr.get(`${Number(x.chainId)}:${tL}`);
      const sym = m?.symbol || meta?.symbol || shortAddr(x.token);
      const dec = m?.decimals ?? meta?.decimals ?? (sym === 'USDC' ? 6 : 18);
      return { ...x, symbol: sym, human: formatAmount(x.amountRaw || '0', dec, 6), kindLabel: ledgerKindLabel(x.kind), };
    });
  }, [ledger, balanceRows, tokenMetaByChainAddr]);

  // --- Vault Context for Cashier ---
  const vaultContext = useMemo(() => {
    const chainConf = pubConfig?.chains?.find(c => Number(c.chainId) === TARGET_CHAIN_ID);
    const vault = chainConf?.vaults?.[0];
    return {
      vaultId: vault?.vaultId ?? vault?.id ?? '',
      vaultAddress: vault?.vaultAddress ?? vault?.address ?? '',
      wNative: vault?.wNative ?? ''
    };
  }, [pubConfig]);

  // Calculate if selected token is native
  const isWn = useMemo(() => {
    return (vaultContext.wNative || "").toLowerCase() === (selectedBalance?.token || "").toLowerCase();
  }, [vaultContext.wNative, selectedBalance?.token]);

  // Fetch Wallet Balances when Modals Open
  useEffect(() => {
    (async () => {
      if (!depositOpen && !withdrawOpen) return;
      if (!walletProvider || !address) return;
      try {
        const bp = new BrowserProvider(walletProvider as any);
        const bal = await bp.getBalance(address);
        setWalletNativeBalRaw(bal.toString());

        if (selectedBalance?.token) {
          const erc = new Contract(selectedBalance.token, ERC20_BAL_ABI, bp);
          const tBal = await erc.balanceOf(address);
          setWalletTokenBalRaw(tBal.toString());
        }
      } catch (e) {
        console.error("Failed to fetch wallet balances", e);
      }
    })();
  }, [depositOpen, withdrawOpen, walletProvider, address, selectedBalance]);

  async function loginWithWallet() {
    if (!apiBase || !walletProvider) return setErr("Please connect your wallet with the top-right button first.");
    try {
      setSigningIn(true); setErr('');
      const provider = new BrowserProvider(walletProvider as any);
      const signer = await provider.getSigner();
      const addr = await signer.getAddress();
      const nonceResp: any = await apiRequest(apiBase, '/auth/nonce', '', { method: 'POST', body: JSON.stringify({ address: addr }), });
      const message = nonceResp?.message || nonceResp?.nonce;
      const signature = await signer.signMessage(message);
      const verifyResp: any = await apiRequest(apiBase, '/auth/verify', '', { method: 'POST', body: JSON.stringify({ address: addr, signature }), });
      const tokenJwt = verifyResp?.token || verifyResp?.jwt;
      if (!tokenJwt) throw new Error('Missing JWT');
      localStorage.setItem(LS_JWT, tokenJwt); setJwt(tokenJwt);
    } catch (e: any) { setErr('Wallet sign-in failed.'); } finally { setSigningIn(false); }
  }

  // --- Cashier Operations ---
  async function ensureWalletOnSelectedChain() {
    if (!walletProvider) throw new Error("Connect wallet first.");
    const bp = new BrowserProvider(walletProvider as any);
    const on = Number(appkitChainId ?? (await bp.getNetwork()).chainId);
    if (on === TARGET_CHAIN_ID) return;
    throw new Error(`Please switch wallet network to Chain ID ${TARGET_CHAIN_ID}.`);
  }

  async function handleDeposit() {
    if (!selectedBalance || !vaultContext.vaultAddress) return setErr("Configuration missing.");
    setCashierBusy(true); setErr('');
    try {
      await ensureWalletOnSelectedChain();
      const bp = new BrowserProvider(walletProvider as any);
      const signer = await bp.getSigner();
      const vault = new Contract(vaultContext.vaultAddress, VAULT_WRITE_ABI, signer);

      const amountWei = parseUnits(cashierAmount || "0", selectedBalance.decimals);
      if (amountWei <= 0n) throw new Error("Amount must be > 0");

      if (isWn) {
        // Native deposit
        const tx = await vault.depositNativeFor(address, { value: amountWei });
        await tx.wait();
      } else {
        // ERC20 deposit
        const erc20 = new Contract(selectedBalance.token, ERC20_ABI, signer);
        const allowance = await erc20.allowance(address, vaultContext.vaultAddress);
        if (allowance < amountWei) {
          const apprTx = await erc20.approve(vaultContext.vaultAddress, amountWei);
          await apprTx.wait();
        }
        const tx = await vault.depositFor(selectedBalance.token, amountWei, address);
        await tx.wait();
      }

      setDepositOpen(false);
      void load();
    } catch (e: any) {
      setErr(e.message || "Deposit failed.");
    } finally {
      setCashierBusy(false);
    }
  }

  async function handleWithdraw() {
    if (!selectedBalance || !vaultContext.vaultId) return setErr("Configuration missing.");
    setCashierBusy(true); setErr('');
    try {
      await ensureWalletOnSelectedChain();
      const bp = new BrowserProvider(walletProvider as any);
      const signer = await bp.getSigner();

      const amountWei = parseUnits(cashierAmount || "0", selectedBalance.decimals);
      if (amountWei <= 0n) throw new Error("Amount must be > 0");

      const td = await apiRequest<any>(apiBase, '/me/withdraw/typedData', jwt, {
        method: 'POST',
        body: JSON.stringify({
          chainId: TARGET_CHAIN_ID,
          vaultId: vaultContext.vaultId,
          token: selectedBalance.token,
          to: address,
          debitRaw: amountWei.toString(),
          isNative: isWn,
        }),
      });

      const rawTypedData = td?.typedData;
      if (!rawTypedData) throw new Error("Failed to get typed data");

      const domain = { ...rawTypedData.domain };
      if (domain.chainId) domain.chainId = Number(domain.chainId);
      const types = { ...rawTypedData.types };
      delete types.EIP712Domain;

      const signature = await signer.signTypedData(domain, types, rawTypedData.message);

      await apiRequest(apiBase, '/vault/intents/withdraw', jwt, {
        method: 'POST',
        body: JSON.stringify({
          refId: nowRefId("ui_withdraw"),
          chainId: TARGET_CHAIN_ID,
          vaultId: vaultContext.vaultId,
          token: selectedBalance.token,
          to: address,
          debitRaw: amountWei.toString(),
          deadline: Number(rawTypedData.message.deadline),
          isNative: isWn,
          signature,
          sig: signature,
        }),
      });

      setWithdrawOpen(false);
      void load();
    } catch (e: any) {
      setErr(e.message || "Withdraw failed.");
    } finally {
      setCashierBusy(false);
    }
  }

  // --- Gaming Animation Roll ---
  async function onRoll() {
    if (!authed) { setErr('Sign in first.'); return; }
    if (!selectedBalance) { setErr('No balance found.'); return; }
    const n = Number(betHuman);
    if (!Number.isFinite(n) || n <= 0) { setErr('Invalid bet.'); return; }

    try {
      setRolling(true);
      setErr('');
      setResult(null);
      setShowRain(false);

      const startTime = Date.now();
      const reqId = `dice-${startTime}-${Math.random().toString(36).slice(2, 8)}`;

      const rawOut = await tryPaths<any>(apiBase, ROLL_PATHS, jwt, (path) => ({
        method: 'POST',
        body: JSON.stringify(path.includes('/me/dice/play')
          ? { chainId: TARGET_CHAIN_ID, token: selectedBalance.token, betHuman, clientRequestId: reqId }
          : { chainId: TARGET_CHAIN_ID, asset: selectedBalance.symbol, betHuman, clientRequestId: reqId }
        ),
      }));

      const out = normalizeRollResponse(rawOut, {
        token: selectedBalance.token, symbol: selectedBalance.symbol, betHuman, reqId,
        winningRoll: diceInfo?.winningRoll ?? 6,
        winMultiplier: Array.isArray(diceInfo?.winMultipliers) && diceInfo?.winMultipliers?.length ? Number(diceInfo.winMultipliers[0]) : Number(diceInfo?.winMultiplier ?? 2),
      });

      const elapsed = Date.now() - startTime;
      const delay = Math.max(0, 2000 - elapsed);

      setTimeout(() => {
        setRolling(false);
        setDiceValue(out.roll != null ? out.roll : (out.win ? (diceInfo?.winningRoll || 6) : 1));
        setResult(out);
        setRolls((prev) => [{ ...out, id: out.clientRequestId || reqId, ts: Date.now() }, ...prev].slice(0, 10));

        if (out.win) {
          setShowRain(true);
          setTimeout(() => setShowRain(false), 6000);
        }
        void load();
      }, delay);

    } catch (e: any) {
      setRolling(false);
      setErr(String(e?.message || 'Roll failed.'));
    }
  }

  const quickBets = useMemo(() => {
    const s = selectedBalance?.symbol || 'USDC';
    return s === 'USDC' ? ['0.01', '0.05', '0.10', '0.25'] : ['0.001', '0.005', '0.01', '0.05'];
  }, [selectedBalance]);

  return (
    <div className="dice-browser-theme">
      <MoneyRain active={showRain} />

      <div className="game-wrapper">
        {/* Navigation */}
        <nav className="game-nav">
          <div className="nav-left">
            <button className="nav-back" onClick={() => nav('/')}><ChevronLeft size={20} /> Dashboard</button>
            <div className="nav-divider"></div>
            <div className="nav-logo">HAUS<span>DICE</span></div>
          </div>
          <div className="nav-right">
            <button className="nav-icon-btn" onClick={() => void load()} disabled={loading || rolling}>
              <RefreshCw className={loading ? 'spinning' : ''} size={18} />
            </button>

            <div className="appkit-container">
               <appkit-button />
            </div>

            {authed ? (
              <div className="nav-user">
                <div className="user-info">
                  <span className="user-addr">{shortAddr(address)}</span>
                  <span className="user-status">Cashier Connected</span>
                </div>
                <button className="logout-btn" onClick={() => { localStorage.removeItem(LS_JWT); setJwt(''); setBalances([]); setDiceInfo(null); }}><LogOut size={16} /></button>
              </div>
            ) : (
              <button className="login-pill" onClick={loginWithWallet} disabled={!isConnected || signingIn}>
                {signingIn ? 'Connecting...' : 'Sign In to Cashier'}
              </button>
            )}
          </div>
        </nav>

        <div className="game-container">
          {/* Main Stage */}
          <main className="game-stage">
            <div className="stage-header">
              <div className="stage-title">
                <Trophy className="stage-icon" size={24} />
                <h1>The Haus Dice</h1>
              </div>
              <p className="stage-subtitle">Roll a <strong>{diceInfo?.winningRoll || 6}</strong> to randomly multiply your credits.</p>

              <div className="demo-notice">
                <strong>Demonstrating the spend on gameplay with lose win reward.</strong><br/>
                This is only a demonstration for the MVP as a play-to-win cashier spend.
              </div>
            </div>

            <div className="stage-visual">
              <div className="visual-effects">
                <div className="glow-orb red-primary"></div>
                <div className="glow-orb red-secondary"></div>
              </div>

              <Dice3D rolling={rolling} value={diceValue} result={result} />

              <div className="result-banner">
                {rolling ? (
                  <div className="rolling-status">STAKES ARE HIGH...</div>
                ) : result ? (
                  <div className={`status-pill ${result.win ? 'is-win' : 'is-loss'}`}>
                    {result.win ? (
                      <><span className="win-sparkle">✨</span> WINNER! +{result.payoutHuman} {result.symbol} {result.multiplier ? `(x${result.multiplier})` : ''} <span className="win-sparkle">✨</span></>
                    ) : (
                      <>BET LOST • ROLLED {result.roll}</>
                    )}
                  </div>
                ) : (
                  <div className="status-pill is-idle">PLACE YOUR BET</div>
                )}
              </div>
            </div>

            <div className="quick-stats">
              <div className="q-stat">
                <span className="q-label">Win Target</span>
                <span className="q-val">{diceInfo?.winningRoll || 6}</span>
              </div>
              <div className="q-stat">
                <span className="q-label">Multiplier</span>
                <span className="q-val">Random</span>
              </div>
              <div className="q-stat">
                <span className="q-label">Chain</span>
                <span className="q-val">Fuji</span>
              </div>
            </div>
          </main>

          {/* Sidebar Controls */}
          <aside className="game-sidebar">
            {/* Bet Card */}
            <div className="sidebar-card bet-card">
              <div className="card-header">
                <Coins size={18} />
                <h3>Play Panel</h3>
              </div>

              <div className="bet-input-group">
                <div className="input-header">
                  <span>Asset</span>
                  <span className="avail">Balance: {selectedBalance?.availableHuman || '0'}</span>
                </div>
                <select className="bet-select" value={selectedToken} onChange={(e) => setSelectedToken(e.target.value)} disabled={rolling || !authed}>
                  {balanceRows.length ? balanceRows.map(b => (
                    <option key={b.key} value={b.symbol}>{b.symbol}</option>
                  )) : <option value="">No Credits</option>}
                </select>

                <div className="input-header mt-4">
                  <span>Bet Amount</span>
                </div>
                <div className="bet-amount-wrapper">
                  <input
                    className="bet-input"
                    value={betHuman}
                    onChange={e => setBetHuman(e.target.value)}
                    placeholder="0.00"
                    disabled={rolling || !authed}
                  />
                  <span className="bet-asset">{selectedToken}</span>
                </div>

                <div className="quick-chips">
                  {quickBets.map(q => (
                    <button key={q} className="chip-btn" onClick={() => setBetHuman(q)} disabled={rolling || !authed}>{q}</button>
                  ))}
                  <button className="chip-btn max" onClick={() => setBetHuman(selectedBalance?.availableHuman || '0')} disabled={rolling || !authed}>MAX</button>
                </div>
              </div>

              <button className={`roll-trigger ${rolling ? 'is-spinning' : ''}`} onClick={onRoll} disabled={!authed || rolling || !selectedBalance}>
                {rolling ? 'ROLLING...' : authed ? 'ROLL DICE' : 'CONNECT FIRST'}
              </button>

              {err && <div className="error-toast"><AlertCircle size={14} /> {err}</div>}
            </div>

            {/* Wallet Balances + Cashier */}
            <div className="sidebar-card balance-card">
              <div className="card-header" style={{ justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Wallet size={18} />
                  <h3>Cashier</h3>
                </div>
                {authed && vaultContext.vaultAddress && (
                  <div className="cashier-actions">
                    <button className="csh-btn" onClick={() => setDepositOpen(true)}><ArrowDownCircle size={14}/> Deposit</button>
                    <button className="csh-btn" onClick={() => setWithdrawOpen(true)}><ArrowUpCircle size={14}/> Withdraw</button>
                  </div>
                )}
              </div>
              <div className="balance-list">
                {balanceRows.length ? balanceRows.map(b => (
                  <div key={b.key} className={`balance-row ${selectedToken === b.symbol ? 'active' : ''}`}>
                    <div className="b-info">
                      <div className="b-sym">{b.symbol}</div>
                      <div className="b-addr">{shortAddr(b.token)}</div>
                    </div>
                    <div className="b-amt">{b.availableHuman}</div>
                  </div>
                )) : <div className="empty-state">No credits found</div>}
              </div>
            </div>

            {/* History Card */}
            <div className="sidebar-card history-card">
              <div className="card-header">
                <History size={18} />
                <h3>Recent Rolls</h3>
              </div>
              <div className="history-list">
                {rolls.length ? rolls.map(r => (
                  <div key={r.id} className={`history-item ${r.win ? 'win' : 'loss'}`}>
                    <div className="h-main">
                      <span className="h-kind">{r.win ? 'WIN' : 'LOSS'} (Rolled {r.roll}) {r.win && r.multiplier ? `x${r.multiplier}` : ''}</span>
                      <span className="h-time">{new Date(r.ts).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                    </div>
                    <div className="h-amt">{r.win ? `+${r.payoutHuman}` : `-${r.betHuman}`} {r.symbol}</div>
                  </div>
                )) : <div className="empty-state">No rolls this session</div>}
              </div>
            </div>
          </aside>
        </div>

        {/* Bottom Ledger Activity */}
        <section className="ledger-section">
          <div className="ledger-header">
            <TrendingUp size={16} />
            <h3>Live Ledger (Blockchain Activity)</h3>
          </div>
          <div className="ledger-grid">
            {recentLedger.length ? recentLedger.map(l => (
              <div key={l.refId} className="ledger-cell">
                <div className="l-head">
                  <span className="l-kind">{l.kindLabel}</span>
                  <span className="l-time">{l.ts ? new Date(l.ts).toLocaleDateString() : '—'}</span>
                </div>
                <div className="l-body">
                  <span className="l-sym">{l.symbol}</span>
                  <span className="l-human">{l.human}</span>
                </div>
              </div>
            )) : <div className="empty-state col-span-full">Waiting for transactions...</div>}
          </div>
        </section>
      </div>

      {/* Cashier Modals */}
      <Modal open={depositOpen} title={`Deposit ${selectedBalance?.symbol || 'Tokens'}`} onClose={() => setDepositOpen(false)}>
         <div className="balance-showcase">
           <div className="bal-box">
             <span className="bal-label">Wallet Balance</span>
             <span className="bal-value wallet-color">
               {formatAmount(isWn ? walletNativeBalRaw : walletTokenBalRaw, selectedBalance?.decimals || 18, 4)} {selectedBalance?.symbol}
             </span>
           </div>
           <div className="bal-box">
             <span className="bal-label">Cashier Balance</span>
             <span className="bal-value cashier-color">
               {selectedBalance?.availableHuman || '0.00'} {selectedBalance?.symbol}
             </span>
           </div>
         </div>
         <div className="bet-input-group">
            <div className="input-header"><span>Deposit Amount</span></div>
            <div className="bet-amount-wrapper">
              <input className="bet-input" value={cashierAmount} onChange={e => setCashierAmount(e.target.value)} placeholder="1.0" />
              <span className="bet-asset">{selectedBalance?.symbol}</span>
            </div>
            <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '12px' }}>Ensure your wallet is on Fuji Testnet. Deposit transfers tokens from your Wallet to the active Cashier Vault.</p>
            <button className="roll-trigger" onClick={handleDeposit} disabled={cashierBusy || !selectedBalance}>
               {cashierBusy ? 'Processing...' : 'Confirm Deposit'}
            </button>
         </div>
      </Modal>

      <Modal open={withdrawOpen} title={`Withdraw ${selectedBalance?.symbol || 'Tokens'}`} onClose={() => setWithdrawOpen(false)}>
         <div className="balance-showcase">
           <div className="bal-box">
             <span className="bal-label">Cashier Balance</span>
             <span className="bal-value cashier-color">
               {selectedBalance?.availableHuman || '0.00'} {selectedBalance?.symbol}
             </span>
           </div>
           <div className="bal-box">
             <span className="bal-label">Wallet Balance</span>
             <span className="bal-value wallet-color">
               {formatAmount(isWn ? walletNativeBalRaw : walletTokenBalRaw, selectedBalance?.decimals || 18, 4)} {selectedBalance?.symbol}
             </span>
           </div>
         </div>
         <div className="bet-input-group">
            <div className="input-header"><span>Withdraw Amount</span></div>
            <div className="bet-amount-wrapper">
              <input className="bet-input" value={cashierAmount} onChange={e => setCashierAmount(e.target.value)} placeholder="1.0" />
              <span className="bet-asset">{selectedBalance?.symbol}</span>
            </div>
            <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '12px' }}>Withdrawals require a signature to generate a gasless intent, moving funds from your Cashier to your Wallet.</p>
            <button className="roll-trigger" onClick={handleWithdraw} disabled={cashierBusy || !selectedBalance}>
               {cashierBusy ? 'Processing...' : 'Sign Withdraw Intent'}
            </button>
         </div>
      </Modal>

      <style>{`
        /* --- Avalanche VaultAdmin Theme Matches --- */
        .dice-browser-theme {
          --bg: #0b0a0f;
          --card: rgba(255,255,255,0.06);
          --card2: rgba(0,0,0,0.20);
          --border: rgba(255,255,255,0.12);
          --text: rgba(255,255,255,0.92);
          --muted: rgba(255,255,255,0.72);

          --accent: #e84142; /* Avalanche Red */
          --accent-glow: rgba(232,65,66,0.4);
          --win: #22c55e;
          --win-bg: rgba(34,197,94,0.12);
          --loss: #ef4444;
          --loss-bg: rgba(239,68,68,0.12);

          background: radial-gradient(1200px 600px at 10% 10%, rgba(232,65,66,0.14), transparent 60%),
                      radial-gradient(1200px 600px at 90% 0%, rgba(255,107,107,0.12), transparent 55%),
                      var(--bg);
          color: var(--text);
          min-height: 100vh;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        }

        .game-wrapper { max-width: 1400px; margin: 0 auto; padding: 0 20px 40px; }

        /* Navigation */
        .game-nav { display: flex; justify-content: space-between; align-items: center; height: 80px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
        .nav-left, .nav-right { display: flex; align-items: center; gap: 15px; }
        .nav-back { background: none; border: none; color: var(--text); display: flex; align-items: center; gap: 5px; cursor: pointer; font-weight: 750; font-size: 13px; opacity: 0.8; transition: opacity 0.2s; }
        .nav-back:hover { opacity: 1; }
        .nav-logo { font-weight: 900; font-size: 1.2rem; letter-spacing: -0.5px; }
        .nav-logo span { color: var(--accent); }

        .appkit-container { display: flex; align-items: center; margin-right: 5px; }

        .nav-user { display: flex; align-items: center; gap: 12px; background: var(--card2); padding: 5px 12px; border-radius: 12px; border: 1px solid var(--border); }
        .user-info { display: flex; flex-direction: column; line-height: 1.2; }
        .user-addr { font-size: 0.85rem; font-weight: 600; }
        .user-status { font-size: 0.65rem; color: var(--win); text-transform: uppercase; font-weight: 800; }
        .logout-btn { background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px; }
        .logout-btn:hover { color: var(--text); }

        .login-pill {
          background: linear-gradient(180deg, rgba(232,65,66,0.95), rgba(198,46,57,0.95));
          border: 1px solid rgba(255,255,255,0.12);
          color: white; padding: 10px 20px; border-radius: 12px; font-weight: 750; cursor: pointer; transition: filter 0.12s ease, transform 0.06s ease;
        }
        .login-pill:hover { filter: brightness(1.05); }
        .login-pill:active { transform: translateY(1px); }

        /* Game Layout */
        .game-container { display: grid; grid-template-columns: 1fr 380px; gap: 24px; }
        @media (max-width: 1024px) { .game-container { grid-template-columns: 1fr; } }

        /* Stage */
        .game-stage { background: var(--card); border-radius: 16px; border: 1px solid var(--border); padding: 40px; display: flex; flex-direction: column; position: relative; overflow: hidden; }
        .stage-header { text-align: center; margin-bottom: 30px; }
        .stage-title { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 10px; }
        .stage-title h1 { font-size: 2.2rem; font-weight: 900; margin: 0; }
        .stage-icon { color: var(--accent); }
        .stage-subtitle { color: var(--muted); margin: 0; font-size: 1.1rem; }
        .stage-subtitle strong { color: var(--text); }

        .demo-notice { margin-top: 15px; padding: 12px 20px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 12px; font-size: 0.85rem; color: var(--muted); display: inline-block; text-align: center; }
        .demo-notice strong { color: var(--text); }

        .stage-visual { flex: 1; min-height: 400px; position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .visual-effects { position: absolute; inset: 0; pointer-events: none; }
        .glow-orb { position: absolute; width: 300px; height: 300px; border-radius: 50%; filter: blur(100px); top: 50%; left: 50%; transform: translate(-50%, -50%); }
        .glow-orb.red-primary { background: rgba(232,65,66,0.5); margin-left: -100px; opacity: 0.3; }
        .glow-orb.red-secondary { background: rgba(255,107,107,0.4); margin-left: 100px; opacity: 0.3; }

        .result-banner { margin-top: 40px; min-height: 60px; text-align: center; }
        .status-pill { padding: 12px 30px; border-radius: 100px; font-weight: 900; font-size: 1.1rem; border: 1px solid transparent; letter-spacing: 1px; display: inline-block; }
        .status-pill.is-idle { background: var(--card2); border-color: var(--border); color: var(--muted); }
        .status-pill.is-win { background: var(--win-bg); border-color: rgba(34,197,94,0.45); color: var(--win); box-shadow: 0 0 30px rgba(34,197,94,0.15); }
        .status-pill.is-loss { background: var(--loss-bg); border-color: rgba(255,107,107,0.45); color: var(--loss); }
        .rolling-status { font-weight: 900; color: var(--accent); letter-spacing: 4px; animation: pulse 1s infinite; }

        .quick-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-top: auto; }
        .q-stat { background: var(--card2); border: 1px solid var(--border); padding: 15px; border-radius: 14px; display: flex; flex-direction: column; align-items: center; }
        .q-label { font-size: 0.7rem; text-transform: uppercase; font-weight: 800; color: var(--muted); margin-bottom: 5px; }
        .q-val { font-size: 1.2rem; font-weight: 900; color: var(--accent); }

        /* Sidebar Cards */
        .game-sidebar { display: flex; flex-direction: column; gap: 20px; }
        .sidebar-card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; }
        .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; color: var(--muted); }
        .card-header h3 { font-size: 13px; margin: 0; text-transform: uppercase; font-weight: 850; color: var(--text); }

        .cashier-actions { display: flex; gap: 8px; }
        .csh-btn { display: flex; align-items: center; gap: 4px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: white; padding: 4px 10px; border-radius: 8px; font-size: 0.7rem; font-weight: 700; cursor: pointer; text-transform: uppercase; transition: background 0.2s; }
        .csh-btn:hover { background: rgba(255,255,255,0.15); }

        .bet-select, .bet-amount-wrapper {
          background: rgba(0,0,0,0.22);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 12px;
          color: var(--text);
          outline: none;
          transition: border-color 0.12s ease;
        }
        .bet-select { width: 100%; padding: 12px; font-weight: 600; cursor: pointer; }
        .bet-select:focus, .bet-input:focus { border-color: rgba(232,65,66,0.55); box-shadow: 0 0 0 3px rgba(232,65,66,0.15); }

        .input-header { display: flex; justify-content: space-between; font-size: 12px; font-weight: 750; color: var(--muted); margin-bottom: 8px; }
        .bet-amount-wrapper { position: relative; overflow: hidden; display: flex; align-items: center; }
        .bet-input { flex: 1; background: none; border: none; padding: 15px; color: var(--text); font-size: 1.2rem; font-weight: 800; outline: none; }
        .bet-asset { padding-right: 15px; font-weight: 900; color: var(--accent); font-size: 0.9rem; }

        .quick-chips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; }
        .chip-btn { background: var(--card2); border: 1px solid var(--border); color: var(--text); padding: 8px; border-radius: 12px; font-size: 12px; font-weight: 750; cursor: pointer; transition: filter 0.12s ease; }
        .chip-btn:hover { filter: brightness(1.15); }
        .chip-btn.max { grid-column: span 3; color: var(--accent); border-color: rgba(232,65,66,0.55); background: rgba(232,65,66,0.1); }

        .roll-trigger {
          width: 100%; margin-top: 24px;
          background: linear-gradient(180deg, rgba(232,65,66,0.95), rgba(198,46,57,0.95));
          border: 1px solid rgba(255,255,255,0.12); color: white; padding: 16px; border-radius: 12px;
          font-size: 1.1rem; font-weight: 800; cursor: pointer; transition: filter 0.12s ease, transform 0.06s ease;
        }
        .roll-trigger:hover:not(:disabled) { filter: brightness(1.05); }
        .roll-trigger:active:not(:disabled) { transform: translateY(1px); }
        .roll-trigger:disabled { opacity: 0.55; cursor: not-allowed; filter: none !important; }
        .roll-trigger.is-spinning { animation: shake-tiny 0.1s infinite; }

        .error-toast { margin-top: 15px; padding: 10px; background: var(--loss-bg); border: 1px solid rgba(255,107,107,0.45); color: rgba(254,202,202,0.95); border-radius: 12px; font-size: 13px; text-align: center; display: flex; align-items: center; justify-content: center; gap: 6px;}

        .balance-list, .history-list { display: flex; flex-direction: column; gap: 8px; max-height: 250px; overflow-y: auto; padding-right: 5px; }
        .balance-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--card2); border: 1px solid var(--border); }
        .balance-row.active { border-color: var(--accent); background: rgba(232,65,66,0.1); }
        .b-sym { font-weight: 800; font-size: 13px; }
        .b-addr { font-size: 11px; color: var(--muted); }
        .b-amt { font-weight: 800; font-size: 14px; }

        .history-item { padding: 10px 12px; border-radius: 12px; background: var(--card2); border-left: 4px solid var(--border); }
        .history-item.win { border-left-color: var(--win); background: rgba(34,197,94,0.05); }
        .history-item.loss { border-left-color: var(--loss); background: rgba(239,68,68,0.05); }
        .h-main { display: flex; justify-content: space-between; margin-bottom: 4px; }
        .h-kind { font-size: 12px; font-weight: 800; }
        .h-time { font-size: 11px; color: var(--muted); }
        .h-amt { font-weight: 850; font-size: 13px; }

        /* Modal Overlays */
        .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 20px; }
        .modal-content { background: var(--bg); border: 1px solid var(--border); border-radius: 20px; width: 100%; max-width: 420px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden; }
        .modal-header { padding: 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--card); }
        .modal-header h3 { margin: 0; font-size: 1.1rem; font-weight: 800; }
        .modal-close { background: rgba(255,255,255,0.1); border: none; color: white; width: 30px; height: 30px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; transition: background 0.2s; }
        .modal-close:hover { background: rgba(255,255,255,0.2); }
        .modal-body { padding: 24px; background: var(--card2); }

        /* Balance Showcase inside Modals */
        .balance-showcase { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
        .bal-box { background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 12px; padding: 16px 12px; text-align: center; }
        .bal-label { display: block; font-size: 0.75rem; text-transform: uppercase; color: var(--muted); font-weight: 800; margin-bottom: 8px; letter-spacing: 0.5px; }
        .bal-value { display: block; font-size: 1.4rem; font-weight: 900; }
        .wallet-color { color: #60a5fa; text-shadow: 0 0 12px rgba(96,165,250,0.4); }
        .cashier-color { color: var(--win); text-shadow: 0 0 12px rgba(34,197,94,0.4); }

        /* Ledger Section */
        .ledger-section { margin-top: 24px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; }
        .ledger-header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; color: var(--text); }
        .ledger-header h3 { font-size: 14px; margin: 0; font-weight: 850; }
        .ledger-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
        .ledger-cell { background: var(--card2); border: 1px solid var(--border); padding: 12px; border-radius: 12px; }
        .l-head { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .l-kind { font-size: 11px; font-weight: 800; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .l-time { font-size: 11px; color: var(--muted); }
        .l-body { display: flex; justify-content: space-between; align-items: center; }
        .l-sym { font-weight: 800; font-size: 12px; }
        .l-human { font-weight: 850; font-size: 13px; color: var(--accent); }

        /* 3D Dice Styling */
        .dice-scene { width: 100px; height: 100px; position: relative; perspective: 600px; transform: scale(1.8); }
        .dice-cube { width: 100%; height: 100%; position: absolute; transform-style: preserve-3d; transition: transform 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .dice-face { position: absolute; width: 100px; height: 100px; background: white; border: 4px solid #f0f0f0; border-radius: 18px; display: flex; padding: 15px; box-sizing: border-box; backface-visibility: hidden; box-shadow: inset 0 0 20px rgba(0,0,0,0.1); }

        .dice-face span { width: 15px; height: 15px; background: #222; border-radius: 50%; display: block; }
        .face-1 { transform: rotateY(0deg) translateZ(50px); justify-content: center; align-items: center; }
        .face-1 span { background: #e84142; width: 22px; height: 22px; }
        .face-6 { transform: rotateY(180deg) translateZ(50px); display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .face-2 { transform: rotateY(90deg) translateZ(50px); display: flex; flex-direction: column; justify-content: space-between; }
        .face-2 span:last-child { align-self: flex-end; }
        .face-5 { transform: rotateY(-90deg) translateZ(50px); display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr 1fr; }
        .face-5 span:nth-child(3) { grid-area: 2 / 1 / 3 / 3; justify-self: center; }
        .face-3 { transform: rotateX(90deg) translateZ(50px); display: flex; flex-direction: column; justify-content: space-between; }
        .face-3 span:nth-child(2) { align-self: center; }
        .face-3 span:last-child { align-self: flex-end; }
        .face-4 { transform: rotateX(-90deg) translateZ(50px); display: grid; grid-template-columns: 1fr 1fr; align-content: space-between; }

        .is-rolling { animation: roll-animation 0.5s infinite linear; }

        .dice-shadow { position: absolute; width: 80px; height: 20px; background: rgba(0,0,0,0.4); bottom: -40px; left: 10px; border-radius: 50%; filter: blur(10px); }

        /* Animations */
        @keyframes roll-animation {
          0% { transform: rotateX(0deg) rotateY(0deg); }
          100% { transform: rotateX(360deg) rotateY(360deg); }
        }
        @keyframes pulse { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }
        @keyframes shake-tiny { 0% { transform: translateX(0); } 25% { transform: translateX(2px); } 75% { transform: translateX(-2px); } 100% { transform: translateX(0); } }
        .shake-loss { animation: shake-loss 0.4s ease-in-out; }
        @keyframes shake-loss {
          0%, 100% { transform: translateX(0) scale(1.8); }
          20% { transform: translateX(-10px) scale(1.8); }
          40% { transform: translateX(10px) scale(1.8); }
          60% { transform: translateX(-5px) scale(1.8); }
          80% { transform: translateX(5px) scale(1.8); }
        }

        /* Money Rain */
        .money-rain-container { position: fixed; inset: 0; pointer-events: none; z-index: 1000; overflow: hidden; }
        .rain-item { position: absolute; top: -50px; font-size: 2.5rem; animation: rain-fall 2.5s linear forwards; }
        @keyframes rain-fall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(110vh) rotate(360deg); opacity: 0; }
        }

        .spinning { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
