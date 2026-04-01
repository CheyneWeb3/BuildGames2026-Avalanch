import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatUnits } from 'ethers';
import { useApiBase } from '../../ApiBaseContext';
import UnregisteredGooglePrompt from '../../components/google/UnregisteredGooglePrompt';
import UnregisteredGoogleRegisterButton from '../../components/google/UnregisteredGoogleRegisterButton';

import {
  Trophy,
  Coins,
  History,
  RefreshCw,
  LogOut,
  ChevronLeft,
  AlertCircle,
  Gamepad2,
  Wallet,
  BarChart3,
  Activity
} from 'lucide-react';

const LS_JWT = 'haus_user_jwt';
const TARGET_CHAIN_ID = 43113;
const INFO_PATHS = ['/games/dice/info', '/me/dice/info'];
const ROLL_PATHS = ['/games/dice/roll', '/me/dice/play'];

declare global {
  interface Window {
    google?: any;
  }
}

type BalanceItem = {
  chainId: number;
  token: string;
  symbol?: string;
  decimals?: number;
  balanceRaw?: string;
  availableRaw?: string;
  heldRaw?: string;
  totalRaw?: string;
  balanceHuman?: string;
  updatedAt?: string;
};

type LedgerItem = {
  refId: string;
  ts: string;
  kind: string;
  chainId: number;
  token: string;
  amountRaw: string;
  meta?: any;
};

type DiceInfo = {
  ok?: boolean;
  chainId?: number;
  enabledTokens?: string[];
  defaultToken?: string;
  defaultTokenSymbol?: string;
  winMultiplier?: number;
  winMultipliers?: number[];
  winningRoll?: number;
  minBetHuman?: string;
  maxBetHuman?: string;
};

type DiceRoll = {
  ok?: boolean;
  chainId?: number;
  asset?: string;
  token?: string;
  symbol?: string;
  betHuman?: string;
  payoutHuman?: string;
  roll?: number;
  multiplier?: number;
  win?: boolean;
  clientRequestId?: string;
  balanceAfterHuman?: string;
};

type RollHistoryItem = DiceRoll & {
  id: string;
  ts: number;
};

type TokenOption = {
  key: string;
  token: string;
  symbol: string;
  decimals: number;
  availableRaw: string;
  heldRaw: string;
  availableHuman: string;
};

type TokenListToken = {
  chainId: number;
  address: string;
  symbol?: string;
  decimals?: number;
};

type MobileTab = 'arcade' | 'credits' | 'scores' | 'activity';

function safeBigInt(v?: string) {
  try {
    const s = String(v || '0').trim();
    return /^\d+$/.test(s) ? BigInt(s) : 0n;
  } catch {
    return 0n;
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

function normalizeRollResponse(
  raw: any,
  fallback: {
    token?: string;
    symbol?: string;
    betHuman?: string;
    reqId?: string;
    winningRoll?: number;
    winMultiplier?: number;
  }
): DiceRoll {
  const payoutHuman =
    raw?.payoutHuman ??
    raw?.payout ??
    raw?.winAmountHuman ??
    raw?.amountHuman ??
    '0';

  const betHuman =
    raw?.betHuman ??
    raw?.amountHuman ??
    fallback.betHuman ??
    '0';

  const roll = raw?.roll != null ? Number(raw.roll) : undefined;
  const multiplier =
    raw?.multiplier != null
      ? Number(raw.multiplier)
      : raw?.multiplierHuman != null
      ? Number(raw.multiplierHuman)
      : fallback.winMultiplier != null
      ? Number(fallback.winMultiplier)
      : undefined;

  const rawWin = raw?.win ?? raw?.didWin ?? raw?.isWin;
  const winningRoll = Number(fallback.winningRoll ?? 6);

  let win = false;
  if (typeof rawWin === 'boolean') {
    win = rawWin;
  } else if (roll != null && Number.isFinite(roll)) {
    win = roll === winningRoll;
  } else {
    win = numFromHuman(payoutHuman) > 0;
  }

  const finalPayoutHuman =
    win &&
    (!payoutHuman || numFromHuman(payoutHuman) <= 0) &&
    multiplier &&
    numFromHuman(betHuman) > 0
      ? String(numFromHuman(betHuman) * multiplier)
      : String(payoutHuman || '0');

  return {
    ok: raw?.ok ?? true,
    chainId: Number(raw?.chainId ?? TARGET_CHAIN_ID),
    asset: String(raw?.asset || raw?.assetSymbol || raw?.symbol || fallback.symbol || '').toUpperCase(),
    token: String(raw?.token || raw?.assetAddress || fallback.token || '').toLowerCase(),
    symbol: String(raw?.symbol || raw?.asset || raw?.assetSymbol || fallback.symbol || '').toUpperCase(),
    betHuman: String(betHuman),
    payoutHuman: finalPayoutHuman,
    roll,
    multiplier,
    win,
    clientRequestId: String(raw?.clientRequestId || raw?.requestId || fallback.reqId || ''),
    balanceAfterHuman:
      raw?.balanceAfterHuman != null ? String(raw.balanceAfterHuman) : undefined
  };
}

async function apiRequest<T>(
  base: string,
  path: string,
  jwt: string,
  init?: RequestInit
): Promise<T> {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  const res = await fetch(`${cleanBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      ...(init?.headers || {})
    }
  });

  const txt = await res.text().catch(() => '');
  let data: any = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { raw: txt };
  }

  if (!res.ok) {
    throw new Error(
      String(data?.error || data?.message || data?.raw || `${res.status} ${res.statusText}`)
    );
  }

  return data as T;
}

async function tryPaths<T>(
  base: string,
  paths: string[],
  jwt: string,
  initFactory: (path: string) => RequestInit
): Promise<T> {
  let lastErr: any = null;

  for (const path of paths) {
    try {
      return await apiRequest<T>(base, path, jwt, initFactory(path));
    } catch (e: any) {
      lastErr = e;
      if (!/404|Cannot (GET|POST)|not found/i.test(String(e?.message || e || ''))) {
        throw e;
      }
    }
  }

  throw lastErr || new Error('No working endpoint found');
}

function normalizeBalances(raw: any): BalanceItem[] {
  const items = Array.isArray(raw?.items)
    ? raw.items
    : Array.isArray(raw?.balances)
    ? raw.balances
    : Array.isArray(raw)
    ? raw
    : [];

  return items.map((x: any) => ({
    chainId: Number(x.chainId || 0),
    token: String(x.token || '').toLowerCase(),
    symbol: String(x.symbol || ''),
    decimals: Number(x.decimals ?? 18),
    balanceRaw: String(x.balanceRaw ?? x.balance ?? x.totalRaw ?? '0'),
    availableRaw: String(x.availableRaw ?? x.balanceRaw ?? x.balance ?? x.totalRaw ?? '0'),
    heldRaw: String(x.heldRaw ?? '0'),
    totalRaw: String(x.totalRaw ?? x.balanceRaw ?? x.balance ?? '0'),
    balanceHuman: typeof x.balanceHuman === 'string' ? x.balanceHuman : undefined,
    updatedAt: String(x.updatedAt || '')
  }));
}

function normalizeLedger(raw: any): LedgerItem[] {
  const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
  return items.map((x: any) => ({
    refId: String(x.refId || x.id || `${x.kind || 'row'}-${x.ts || Date.now()}`),
    ts: String(x.ts || x.createdAt || x.updatedAt || ''),
    kind: String(x.kind || ''),
    chainId: Number(x.chainId || 0),
    token: String(x.token || '').toLowerCase(),
    amountRaw: String(x.amountRaw ?? x.amount ?? '0'),
    meta: x.meta || {}
  }));
}

const MoneyRain = ({ active }: { active: boolean }) => {
  if (!active) return null;

  return (
    <div className="money-rain-container">
      {[...Array(35)].map((_, i) => (
        <div
          key={i}
          className="rain-item"
          style={{
            left: `${Math.random() * 100}%`,
            animationDelay: `${Math.random() * 1.5}s`
          }}
        >
          {['💰', '💵', '💎', '✨', '🔥'][Math.floor(Math.random() * 5)]}
        </div>
      ))}
    </div>
  );
};

const Dice3D = ({
  rolling,
  value,
  result,
  compact = false
}: {
  rolling: boolean;
  value: number;
  result: DiceRoll | null;
  compact?: boolean;
}) => {
  const faceRotations = {
    1: 'rotateX(0deg) rotateY(0deg)',
    2: 'rotateX(0deg) rotateY(-90deg)',
    3: 'rotateX(-90deg) rotateY(0deg)',
    4: 'rotateX(90deg) rotateY(0deg)',
    5: 'rotateX(0deg) rotateY(90deg)',
    6: 'rotateX(0deg) rotateY(180deg)'
  };

  return (
    <div className={`dice-scene ${compact ? 'compact' : ''} ${result && !result.win ? 'shake-loss' : ''}`}>
      <div
        className={`dice-cube ${rolling ? 'is-rolling' : ''}`}
        style={{
          transform: rolling
            ? undefined
            : faceRotations[value as keyof typeof faceRotations] || faceRotations[1]
        }}
      >
        <div className="dice-face face-1"><span /></div>
        <div className="dice-face face-6"><span /><span /><span /><span /><span /><span /></div>
        <div className="dice-face face-2"><span /><span /></div>
        <div className="dice-face face-5"><span /><span /><span /><span /><span /></div>
        <div className="dice-face face-3"><span /><span /><span /></div>
        <div className="dice-face face-4"><span /><span /><span /><span /></div>
      </div>
      <div className="dice-shadow" />
    </div>
  );
};

export default function DiceGooglePlayPage() {
  const nav = useNavigate();
  const apiBase = useApiBase();

  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || '');
  const [balances, setBalances] = useState<BalanceItem[]>([]);
  const [ledger, setLedger] = useState<LedgerItem[]>([]);
  const [diceInfo, setDiceInfo] = useState<DiceInfo | null>(null);
  const [tokenList, setTokenList] = useState<TokenListToken[]>([]);
  const [selectedToken, setSelectedToken] = useState('');
  const [betHuman, setBetHuman] = useState('0.05');

  const [loading, setLoading] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const [err, setErr] = useState('');
  const [needsRegistration, setNeedsRegistration] = useState(false);
  const [googleLinkEmail, setGoogleLinkEmail] = useState('');
  const [googleLinkName, setGoogleLinkName] = useState('');
  const [googleLinkSub, setGoogleLinkSub] = useState('');
  const [result, setResult] = useState<DiceRoll | null>(null);
  const [rolls, setRolls] = useState<RollHistoryItem[]>([]);
  const [showRain, setShowRain] = useState(false);
  const [activeTab, setActiveTab] = useState<MobileTab>('arcade');

  const googleDesktopBtnRef = useRef<HTMLDivElement | null>(null);
  const googleMobileBtnRef = useRef<HTMLDivElement | null>(null);
  const googleRenderedRef = useRef(false);

  const authed = !!jwt;
  const googleClientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();

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
        if (!dead) {
          setTokenList((Array.isArray(j?.tokens) ? j.tokens : []) as TokenListToken[]);
        }
      } catch {
        if (!dead) setTokenList([]);
      }
    })();

    return () => {
      dead = true;
    };
  }, []);

  const tokenMetaByChainAddr = useMemo(() => {
    const m = new Map<string, { symbol: string; decimals: number }>();

    for (const t of tokenList) {
      const cid = Number(t?.chainId || 0);
      const addr = String(t?.address || '').trim().toLowerCase();
      if (cid && addr) {
        m.set(`${cid}:${addr}`, {
          symbol: String(t?.symbol || '').toUpperCase(),
          decimals: Number(t?.decimals ?? 18)
        });
      }
    }

    return m;
  }, [tokenList]);

  const load = useCallback(async () => {
    if (!apiBase) {
      setLoading(false);
      setErr('Waiting for API base...');
      return;
    }

    if (!authed) {
      setBalances([]);
      setLedger([]);
      setDiceInfo(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setErr('');

      const [infoRes, balRes, ledRes] = await Promise.all([
        tryPaths<DiceInfo>(apiBase, INFO_PATHS, jwt, () => ({
          method: 'POST',
          body: JSON.stringify({ chainId: TARGET_CHAIN_ID })
        })),
        apiRequest<any>(apiBase, '/me/balances', jwt, { method: 'GET' }),
        apiRequest<any>(apiBase, '/me/ledger?limit=120', jwt, { method: 'GET' })
      ]);

      setDiceInfo(infoRes || null);
      setBalances(normalizeBalances(balRes));
      setLedger(normalizeLedger(ledRes));
    } catch (e: any) {
      setErr(String(e?.message || e || 'Failed to load data.'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, authed, jwt]);

  useEffect(() => {
    void load();
  }, [load]);

  const enabledTokenMatchers = useMemo(() => {
    const symbols = new Set<string>();
    const addrs = new Set<string>();

    for (const t of diceInfo?.enabledTokens || []) {
      const s = String(t || '').trim();
      if (!s) continue;
      if (s.startsWith('0x')) addrs.add(s.toLowerCase());
      else symbols.add(s.toUpperCase());
    }

    const dAddr = String(diceInfo?.defaultToken || '').trim();
    if (dAddr.startsWith('0x')) addrs.add(dAddr.toLowerCase());

    const dSym = String(diceInfo?.defaultTokenSymbol || '').trim();
    if (dSym) symbols.add(dSym.toUpperCase());

    return { symbols, addrs };
  }, [diceInfo]);

  const balanceRows = useMemo<TokenOption[]>(() => {
    return balances
      .filter((b) => Number(b.chainId) === TARGET_CHAIN_ID)
      .map((b) => {
        const token = String(b.token || '').toLowerCase();
        const meta = tokenMetaByChainAddr.get(`${Number(b.chainId)}:${token}`);
        const symbol =
          String(b.symbol || meta?.symbol || '').toUpperCase() || shortAddr(token);
        const dec = Number.isFinite(Number(meta?.decimals))
          ? Number(meta?.decimals)
          : Number.isFinite(Number(b.decimals))
          ? Number(b.decimals)
          : symbol === 'USDC'
          ? 6
          : 18;

        const avail = String(b.availableRaw ?? b.balanceRaw ?? '0');

        return {
          key: `${b.chainId}:${token}`,
          token,
          symbol,
          decimals: dec,
          availableRaw: avail,
          heldRaw: String(b.heldRaw ?? '0'),
          availableHuman: formatAmount(avail, dec, 6)
        };
      })
      .filter((b) => {
        const hasRules =
          enabledTokenMatchers.symbols.size || enabledTokenMatchers.addrs.size;
        return (
          !hasRules ||
          enabledTokenMatchers.symbols.has(b.symbol) ||
          enabledTokenMatchers.addrs.has(b.token)
        );
      })
      .sort((a, b) => {
        if (a.symbol === 'USDC' && b.symbol !== 'USDC') return -1;
        if (b.symbol === 'USDC' && a.symbol !== 'USDC') return 1;
        return safeBigInt(b.availableRaw) > safeBigInt(a.availableRaw) ? 1 : -1;
      });
  }, [balances, enabledTokenMatchers, tokenMetaByChainAddr]);

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

  const selectedBalance = useMemo(
    () => balanceRows.find((x) => x.symbol === selectedToken) || null,
    [balanceRows, selectedToken]
  );

  const recentLedger = useMemo(() => {
    return ledger
      .filter((x) => Number(x.chainId) === TARGET_CHAIN_ID)
      .filter((x) => {
        const k = String(x.kind || '').toLowerCase();
        return k.startsWith('dice_') || String(x.meta?.game || '').toLowerCase() === 'dice';
      })
      .slice()
      .sort((a, b) => Date.parse(String(b.ts || '')) - Date.parse(String(a.ts || '')))
      .slice(0, 15)
      .map((x) => {
        const tL = String(x.token || '').toLowerCase();
        const m = balanceRows.find((b) => b.token === tL);
        const meta = tokenMetaByChainAddr.get(`${Number(x.chainId)}:${tL}`);
        const sym = m?.symbol || meta?.symbol || shortAddr(x.token);
        const dec = m?.decimals ?? meta?.decimals ?? (sym === 'USDC' ? 6 : 18);

        return {
          ...x,
          symbol: sym,
          human: formatAmount(x.amountRaw || '0', dec, 6),
          kindLabel: ledgerKindLabel(x.kind)
        };
      });
  }, [ledger, balanceRows, tokenMetaByChainAddr]);

  const renderGoogleButton = useCallback(() => {
    if (!googleClientId || !window.google?.accounts?.id) return;

    const isMobile = window.innerWidth <= 768;
    const target = isMobile ? googleMobileBtnRef.current : googleDesktopBtnRef.current;

    if (!target) return;

    target.innerHTML = '';

    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: async (response: any) => {
        try {
          setGoogleBusy(true);
          setErr('');



          const out: any = await apiRequest(apiBase, '/auth/google/verify', '', {
            method: 'POST',
            body: JSON.stringify({ idToken: response?.credential || '' })
          });

          const tokenJwt = String(out?.token || out?.jwt || '').trim();

          if (!tokenJwt) {
            if (out?.linked === false) {
              setNeedsRegistration(true);
              setGoogleLinkEmail(String(out?.email || ''));
              setGoogleLinkName(String(out?.name || ''));
              setGoogleLinkSub(String(out?.googleSub || ''));
              setErr('No wallet is linked to this Google account yet.');
              return;
            }

            throw new Error('Missing JWT from Google verify');
          }

          setNeedsRegistration(false);
          setGoogleLinkEmail('');
          setGoogleLinkName('');
          setGoogleLinkSub('');

          localStorage.setItem(LS_JWT, tokenJwt);
          setJwt(tokenJwt);
          setActiveTab('arcade');



        } catch (e: any) {
          setErr(String(e?.message || 'Google sign-in failed.'));
        } finally {
          setGoogleBusy(false);
        }
      }
    });

    window.google.accounts.id.renderButton(target, {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      width: isMobile ? 280 : 320
    });

    googleRenderedRef.current = true;
  }, [apiBase, googleClientId]);

  useEffect(() => {
    if (!googleClientId || authed) return;

    const existing = document.querySelector(
      'script[src="https://accounts.google.com/gsi/client"]'
    ) as HTMLScriptElement | null;

    if (existing) {
      const onLoad = () => {
        googleRenderedRef.current = false;
        setTimeout(() => renderGoogleButton(), 30);
      };
      existing.addEventListener('load', onLoad);
      if (window.google?.accounts?.id) {
        onLoad();
      }
      return () => existing.removeEventListener('load', onLoad);
    }

    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => {
      googleRenderedRef.current = false;
      renderGoogleButton();
    };
    document.head.appendChild(s);

    return () => {
      s.onload = null;
    };
  }, [authed, googleClientId, renderGoogleButton]);

  useEffect(() => {
    if (authed || !googleClientId) return;

    const onResize = () => {
      googleRenderedRef.current = false;
      if (googleDesktopBtnRef.current) googleDesktopBtnRef.current.innerHTML = '';
      if (googleMobileBtnRef.current) googleMobileBtnRef.current.innerHTML = '';
      setTimeout(() => renderGoogleButton(), 50);
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [authed, googleClientId, renderGoogleButton]);

  useEffect(() => {
    if (authed || !googleClientId || !window.google?.accounts?.id) return;
    googleRenderedRef.current = false;
    setTimeout(() => renderGoogleButton(), 40);
  }, [activeTab, authed, googleClientId, renderGoogleButton]);

  async function onRoll() {
    if (!authed) {
      setErr('Sign in with Google first.');
      return;
    }

    if (!selectedBalance) {
      setErr('No linked credits found.');
      return;
    }

    const n = Number(betHuman);
    if (!Number.isFinite(n) || n <= 0) {
      setErr('Invalid bet.');
      return;
    }

    try {
      setRolling(true);
      setErr('');
      setResult(null);
      setShowRain(false);
      setActiveTab('arcade');

      const startTime = Date.now();
      const reqId = `dice-${startTime}-${Math.random().toString(36).slice(2, 8)}`;

      const rawOut = await tryPaths<any>(apiBase, ROLL_PATHS, jwt, (path) => ({
        method: 'POST',
        body: JSON.stringify(
          path.includes('/me/dice/play')
            ? {
                chainId: TARGET_CHAIN_ID,
                token: selectedBalance.token,
                betHuman,
                clientRequestId: reqId
              }
            : {
                chainId: TARGET_CHAIN_ID,
                asset: selectedBalance.symbol,
                betHuman,
                clientRequestId: reqId
              }
        )
      }));

      const out = normalizeRollResponse(rawOut, {
        token: selectedBalance.token,
        symbol: selectedBalance.symbol,
        betHuman,
        reqId,
        winningRoll: diceInfo?.winningRoll ?? 6,
        winMultiplier:
          Array.isArray(diceInfo?.winMultipliers) && diceInfo?.winMultipliers?.length
            ? Number(diceInfo.winMultipliers[0])
            : Number(diceInfo?.winMultiplier ?? 2)
      });

      const elapsed = Date.now() - startTime;
      const delay = Math.max(0, 1800 - elapsed);

      setTimeout(() => {
        setRolling(false);
        setResult(out);
        setRolls((prev) => [
          { ...out, id: out.clientRequestId || reqId, ts: Date.now() },
          ...prev
        ].slice(0, 10));

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
    return s === 'USDC'
      ? ['0.01', '0.05', '0.10', '0.25']
      : ['0.001', '0.005', '0.01', '0.05'];
  }, [selectedBalance]);

  const logout = () => {
    localStorage.removeItem(LS_JWT);
    setJwt('');
    setBalances([]);
    setLedger([]);
    setDiceInfo(null);
    setResult(null);
    setRolls([]);
    setErr('');
    setNeedsRegistration(false);
    setGoogleLinkEmail('');
    setGoogleLinkName('');
    setGoogleLinkSub('');
    googleRenderedRef.current = false;
    if (googleDesktopBtnRef.current) googleDesktopBtnRef.current.innerHTML = '';
    if (googleMobileBtnRef.current) googleMobileBtnRef.current.innerHTML = '';
    setTimeout(() => renderGoogleButton(), 50);
  };

  const sessionStats = useMemo(() => {
    const total = rolls.length;
    const wins = rolls.filter((r) => r.win).length;
    const losses = total - wins;
    const winRate = total ? Math.round((wins / total) * 100) : 0;
    return { total, wins, losses, winRate };
  }, [rolls]);

  const topBalance = selectedBalance?.availableHuman || balanceRows[0]?.availableHuman || '0';
  const topSymbol = selectedBalance?.symbol || balanceRows[0]?.symbol || 'USDC';

  const renderDesktopPlayPanel = () => (
    <div className="desktop-stage-shell">
      <div className="stage-visual">
        <div className="visual-effects">
          <div className="glow-orb red-primary" />
          <div className="glow-orb red-secondary" />
        </div>

        <Dice3D
          rolling={rolling}
          value={result?.roll || 1}
          result={result}
        />

        <div className="result-banner">
          {rolling ? (
            <div className="rolling-status">ROLLING...</div>
          ) : result ? (
            <div className={`status-pill ${result.win ? 'is-win' : 'is-loss'}`}>
              {result.win ? (
                <>
                  <span className="win-sparkle">✨</span> WINNER! +{result.payoutHuman}{' '}
                  {result.symbol} {result.multiplier ? `(x${result.multiplier})` : ''}{' '}
                  <span className="win-sparkle">✨</span>
                </>
              ) : (
                <>BET LOST • ROLLED {result.roll}</>
              )}
            </div>
          ) : (
            <div className="status-pill is-idle">
              {authed ? 'PLACE YOUR BET' : 'SIGN IN WITH GOOGLE TO PLAY'}
            </div>
          )}
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
      </div>

      <div className="sidebar-card bet-card desktop-play-card">
        <div className="card-header">
          <Coins size={18} />
          <h3>Play Panel</h3>
        </div>

        {!authed ? (
          <div className="signin-panel">
            <div className="signin-title">Continue with Google</div>
            <div className="signin-sub">
              Use the Google account already linked to your wallet-backed cashier account.
            </div>
            <div className="google-side-wrap">
              <div ref={googleDesktopBtnRef} />
            </div>
            {googleBusy ? <div className="mini-note">Signing in…</div> : null}

            {needsRegistration ? (
              <div style={{ width: '100%', maxWidth: 320, marginTop: 8 }}>
                <div className="mini-note" style={{ marginBottom: 10 }}>
                  No wallet is linked to this Google account yet.
                </div>
                <UnregisteredGoogleRegisterButton
                  label="Register Wallet"
                  fullWidth
                  googleEmail={googleLinkEmail}
                  googleName={googleLinkName}
                  googleSub={googleLinkSub}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="bet-input-group">
              <div className="input-header">
                <span>Asset</span>
                <span className="avail">
                  Balance: {selectedBalance?.availableHuman || '0'}
                </span>
              </div>

              <select
                className="bet-select"
                value={selectedToken}
                onChange={(e) => setSelectedToken(e.target.value)}
                disabled={rolling || !authed}
              >
                {balanceRows.length ? (
                  balanceRows.map((b) => (
                    <option key={b.key} value={b.symbol}>
                      {b.symbol}
                    </option>
                  ))
                ) : (
                  <option value="">No Credits</option>
                )}
              </select>

              <div className="input-header mt-4">
                <span>Bet Amount</span>
              </div>

              <div className="bet-amount-wrapper">
                <input
                  className="bet-input"
                  value={betHuman}
                  onChange={(e) => setBetHuman(e.target.value)}
                  placeholder="0.00"
                  disabled={rolling || !authed}
                  inputMode="decimal"
                />
                <span className="bet-asset">{selectedToken}</span>
              </div>

              <div className="quick-chips desktop-chips">
                {quickBets.map((q) => (
                  <button
                    key={q}
                    className="chip-btn"
                    onClick={() => setBetHuman(q)}
                    disabled={rolling || !authed}
                  >
                    {q}
                  </button>
                ))}
                <button
                  className="chip-btn max"
                  onClick={() => setBetHuman(selectedBalance?.availableHuman || '0')}
                  disabled={rolling || !authed}
                >
                  MAX
                </button>
              </div>
            </div>

            <button
              className={`roll-trigger ${rolling ? 'is-spinning' : ''}`}
              onClick={onRoll}
              disabled={!authed || rolling || !selectedBalance}
            >
              {rolling ? 'ROLLING...' : 'ROLL DICE'}
            </button>
          </>
        )}

        {err ? (
          <div className="error-toast">
            <AlertCircle size={14} /> {err}
          </div>
        ) : null}
      </div>
    </div>
  );

  const renderCreditsPanel = () => (
    <div className="sidebar-card balance-card">
      <div className="card-header">
        <Wallet size={18} />
        <h3>Linked Cashier Credits</h3>
      </div>

      <div className="balance-list">
        {balanceRows.length ? (
          balanceRows.map((b) => (
            <button
              key={b.key}
              className={`balance-row balance-row-btn ${selectedToken === b.symbol ? 'active' : ''}`}
              onClick={() => {
                setSelectedToken(b.symbol);
                setActiveTab('arcade');
              }}
            >
              <div className="b-info">
                <div className="b-sym">{b.symbol}</div>
                <div className="b-addr">{shortAddr(b.token)}</div>
              </div>
              <div className="b-amt">{b.availableHuman}</div>
            </button>
          ))
        ) : (
          <div className="empty-state">
            {authed ? 'No credits found' : 'Sign in with Google first'}
          </div>
        )}
      </div>
    </div>
  );

  const renderScoresPanel = () => (
    <div className="section-stack">
      <div className="sidebar-card">
        <div className="card-header">
          <BarChart3 size={18} />
          <h3>Session Scores</h3>
        </div>

        <div className="score-grid">
          <div className="score-box">
            <span>Total</span>
            <strong>{sessionStats.total}</strong>
          </div>
          <div className="score-box">
            <span>Wins</span>
            <strong>{sessionStats.wins}</strong>
          </div>
          <div className="score-box">
            <span>Losses</span>
            <strong>{sessionStats.losses}</strong>
          </div>
          <div className="score-box">
            <span>Win Rate</span>
            <strong>{sessionStats.winRate}%</strong>
          </div>
        </div>
      </div>

      <div className="sidebar-card history-card">
        <div className="card-header">
          <History size={18} />
          <h3>Recent Rolls</h3>
        </div>

        <div className="history-list">
          {rolls.length ? (
            rolls.map((r) => (
              <div key={r.id} className={`history-item ${r.win ? 'win' : 'loss'}`}>
                <div className="h-main">
                  <span className="h-kind">
                    {r.win ? 'WIN' : 'LOSS'} (Rolled {r.roll})
                    {r.win && r.multiplier ? ` x${r.multiplier}` : ''}
                  </span>
                  <span className="h-time">
                    {new Date(r.ts).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                </div>
                <div className="h-amt">
                  {r.win ? `+${r.payoutHuman}` : `-${r.betHuman}`} {r.symbol}
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">No rolls this session</div>
          )}
        </div>
      </div>
    </div>
  );

  const renderActivityPanel = () => (
    <div className="sidebar-card">
      <div className="card-header">
        <Activity size={18} />
        <h3>Live Ledger</h3>
      </div>

      <div className="ledger-grid mobile-ledger-grid">
        {recentLedger.length ? (
          recentLedger.map((l: any) => (
            <div key={l.refId} className="ledger-cell">
              <div className="l-head">
                <span className="l-kind">{l.kindLabel}</span>
                <span className="l-time">
                  {l.ts ? new Date(l.ts).toLocaleDateString() : '—'}
                </span>
              </div>
              <div className="l-body">
                <span className="l-sym">{l.symbol}</span>
                <span className="l-human">{l.human}</span>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-state col-span-full">Waiting for gameplay activity...</div>
        )}
      </div>
    </div>
  );

  const renderArcadeViewport = () => (
    <div className="arcade-viewport">
      <div className="arcade-scroll">



      {!authed ? (
        <div className="sidebar-card signin-panel game-card compact-signin">
          <div className="signin-title">Continue with Google</div>
          <div className="signin-sub">
            Sign in to use your linked cashier credits.
          </div>
          <div className="google-side-wrap">
            <div ref={googleMobileBtnRef} />
          </div>
          {googleBusy ? <div className="mini-note">Signing in…</div> : null}

          {needsRegistration ? (
            <div style={{ width: '100%', marginTop: 8 }}>
              <div className="mini-note" style={{ marginBottom: 10 }}>
                No wallet is linked to this Google account yet.
              </div>
              <UnregisteredGoogleRegisterButton
                label="Register Wallet"
                fullWidth
                googleEmail={googleLinkEmail}
                googleName={googleLinkName}
                googleSub={googleLinkSub}
              />
            </div>
          ) : null}
        </div>
      ) : (



          <>
            <div className="arcade-topbar">
              <div className="arcade-pill">
                <span>Balance</span>
                <strong>{topBalance} {topSymbol}</strong>
              </div>
              <div className="arcade-pill">
                <span>Target</span>
                <strong>{diceInfo?.winningRoll || 6}</strong>
              </div>
              <div className="arcade-pill">
                <span>Chain</span>
                <strong>Fuji</strong>
              </div>
            </div>

            <div className="arcade-dice-zone">
              <div className="visual-effects">
                <div className="glow-orb red-primary" />
                <div className="glow-orb red-secondary" />
              </div>

              <Dice3D
                rolling={rolling}
                value={result?.roll || 1}
                result={result}
                compact
              />
            </div>

            <div className="arcade-status">
              {rolling ? (
                <div className="rolling-status">ROLLING...</div>
              ) : result ? (
                <div className={`status-pill ${result.win ? 'is-win' : 'is-loss'}`}>
                  {result.win ? (
                    <>
                      ✨ WIN +{result.payoutHuman} {result.symbol}
                      {result.multiplier ? ` (x${result.multiplier})` : ''}
                    </>
                  ) : (
                    <>LOSS • ROLLED {result.roll}</>
                  )}
                </div>
              ) : (
                <div className="status-pill is-idle">READY TO ROLL</div>
              )}
            </div>

            <div className="arcade-controls">
              <div className="input-header">
                <span>Asset</span>
                <span className="avail">{selectedBalance?.availableHuman || '0'} available</span>
              </div>

              <select
                className="bet-select"
                value={selectedToken}
                onChange={(e) => setSelectedToken(e.target.value)}
                disabled={rolling || !authed}
              >
                {balanceRows.length ? (
                  balanceRows.map((b) => (
                    <option key={b.key} value={b.symbol}>
                      {b.symbol}
                    </option>
                  ))
                ) : (
                  <option value="">No Credits</option>
                )}
              </select>

              <div className="input-header mt-4">
                <span>Bet</span>
                <span className="avail">
                  Min {diceInfo?.minBetHuman || '—'} / Max {diceInfo?.maxBetHuman || '—'}
                </span>
              </div>

              <div className="bet-amount-wrapper arcade-bet-wrap">
                <input
                  className="bet-input"
                  value={betHuman}
                  onChange={(e) => setBetHuman(e.target.value)}
                  placeholder="0.00"
                  disabled={rolling || !authed}
                  inputMode="decimal"
                />
                <span className="bet-asset">{selectedToken}</span>
              </div>

              <div className="quick-chips arcade-chips">
                {quickBets.map((q) => (
                  <button
                    key={q}
                    className="chip-btn"
                    onClick={() => setBetHuman(q)}
                    disabled={rolling || !authed}
                  >
                    {q}
                  </button>
                ))}
                <button
                  className="chip-btn max"
                  onClick={() => setBetHuman(selectedBalance?.availableHuman || '0')}
                  disabled={rolling || !authed}
                >
                  MAX
                </button>
              </div>
            </div>
          </>
        )}

        {err ? (
          <div className="error-toast mobile-error-inline">
            <AlertCircle size={14} /> {err}
          </div>
        ) : null}
      </div>

      {authed ? (
        <div className="arcade-sticky-action">
          <button
            className={`roll-trigger mobile-roll-trigger ${rolling ? 'is-spinning' : ''}`}
            onClick={onRoll}
            disabled={!authed || rolling || !selectedBalance}
          >
            {rolling ? 'ROLLING...' : `ROLL ${selectedToken || 'DICE'}`}
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="dice-browser-theme">
      <MoneyRain active={showRain} />

      <div className="game-wrapper">
        <nav className="game-nav">
          <div className="nav-left">
            <button className="nav-back" onClick={() => nav('/')}>
              <ChevronLeft size={20} /> Dashboard
            </button>
            <div className="nav-divider" />
            <div className="nav-logo">HAUS<span>DICE</span></div>
          </div>

          <div className="nav-right">
            <button
              className="nav-icon-btn"
              onClick={() => void load()}
              disabled={loading || rolling}
            >
              <RefreshCw className={loading ? 'spinning' : ''} size={18} />
            </button>

            {authed ? (
              <div className="nav-user">
                <div className="user-info">
                  <span className="user-addr">Google session active</span>
                  <span className="user-status">Linked cashier account</span>
                </div>
                <button className="logout-btn" onClick={logout}>
                  <LogOut size={16} />
                </button>
              </div>
            ) : (
              <div className="nav-pill">Google sign-in required</div>
            )}
          </div>
        </nav>

        <div className="desktop-layout">
          <main className="game-stage desktop-stage">
            <div className="stage-header">
              <div className="stage-title">
                <Trophy className="stage-icon" size={24} />
                <h1>The Haus Dice</h1>
              </div>

              <p className="stage-subtitle">
                Sign in with your linked Google account and use your cashier credits to play.
              </p>

              <div className="demo-notice">
                <strong>Google-linked cashier gameplay.</strong><br />
                This page is for spending linked credits on dice only.
              </div>
            </div>

            {renderDesktopPlayPanel()}
          </main>

          <aside className="game-sidebar desktop-sidebar">
            {renderCreditsPanel()}
            {renderScoresPanel()}
            {renderActivityPanel()}
          </aside>
        </div>

        <div className="mobile-layout">
          <div className="mobile-top-shell">
            <div className="mobile-micro-header">
              <button className="mobile-back-mini" onClick={() => nav('/')}>
                <ChevronLeft size={16} />
              </button>

              <div className="mobile-brand compact">
                <Gamepad2 size={16} />
                <span>HAUS DICE</span>
              </div>

              <button
                className="mobile-refresh-mini"
                onClick={() => void load()}
                disabled={loading || rolling}
              >
                <RefreshCw className={loading ? 'spinning' : ''} size={15} />
              </button>
            </div>

            <div className="mobile-tab-panel">
              {activeTab === 'arcade' && renderArcadeViewport()}
              {activeTab === 'credits' && renderCreditsPanel()}
              {activeTab === 'scores' && renderScoresPanel()}
              {activeTab === 'activity' && renderActivityPanel()}
            </div>
          </div>

          <div className="mobile-tabbar">
            <button
              className={`mobile-tab ${activeTab === 'arcade' ? 'active' : ''}`}
              onClick={() => setActiveTab('arcade')}
            >
              <Gamepad2 size={16} />
              <span>Arcade</span>
            </button>
            <button
              className={`mobile-tab ${activeTab === 'credits' ? 'active' : ''}`}
              onClick={() => setActiveTab('credits')}
            >
              <Wallet size={16} />
              <span>Credits</span>
            </button>
            <button
              className={`mobile-tab ${activeTab === 'scores' ? 'active' : ''}`}
              onClick={() => setActiveTab('scores')}
            >
              <BarChart3 size={16} />
              <span>Scores</span>
            </button>
            <button
              className={`mobile-tab ${activeTab === 'activity' ? 'active' : ''}`}
              onClick={() => setActiveTab('activity')}
            >
              <Activity size={16} />
              <span>More</span>
            </button>
          </div>
        </div>
      </div>

      <UnregisteredGooglePrompt
        open={needsRegistration}
        onClose={() => setNeedsRegistration(false)}
        googleEmail={googleLinkEmail}
        googleName={googleLinkName}
        googleSub={googleLinkSub}
      />


      <style>{`
        .dice-browser-theme {
          --bg: #0b0a0f;
          --card: rgba(255,255,255,0.06);
          --card2: rgba(0,0,0,0.20);
          --border: rgba(255,255,255,0.12);
          --text: rgba(255,255,255,0.92);
          --muted: rgba(255,255,255,0.72);
          --accent: #e84142;
          --win: #22c55e;
          --win-bg: rgba(34,197,94,0.12);
          --loss: #ef4444;
          --loss-bg: rgba(239,68,68,0.12);

          background:
            radial-gradient(1200px 600px at 10% 10%, rgba(232,65,66,0.14), transparent 60%),
            radial-gradient(1200px 600px at 90% 0%, rgba(255,107,107,0.12), transparent 55%),
            var(--bg);
          color: var(--text);
          min-height: 100vh;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        }

        .game-wrapper {
          max-width: 1400px;
          margin: 0 auto;
          padding: 0 20px 110px;
        }

        .game-nav {
          display: flex;
          justify-content: space-between;
          align-items: center;
          min-height: 80px;
          border-bottom: 1px solid var(--border);
          margin-bottom: 24px;
          gap: 16px;
          flex-wrap: wrap;
        }

        .nav-left,
        .nav-right {
          display: flex;
          align-items: center;
          gap: 15px;
        }

        .nav-back {
          background: none;
          border: none;
          color: var(--text);
          display: flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
          font-weight: 750;
          font-size: 13px;
          opacity: 0.8;
          transition: opacity 0.2s;
        }

        .nav-back:hover {
          opacity: 1;
        }

        .nav-logo {
          font-weight: 900;
          font-size: 1.2rem;
          letter-spacing: -0.5px;
        }

        .nav-logo span {
          color: var(--accent);
        }

        .nav-divider {
          width: 1px;
          height: 20px;
          background: var(--border);
        }

        .nav-icon-btn {
          background: rgba(255,255,255,0.08);
          border: 1px solid var(--border);
          color: white;
          width: 38px;
          height: 38px;
          border-radius: 10px;
          cursor: pointer;
          display: grid;
          place-items: center;
        }

        .nav-user {
          display: flex;
          align-items: center;
          gap: 12px;
          background: var(--card2);
          padding: 8px 12px;
          border-radius: 12px;
          border: 1px solid var(--border);
        }

        .nav-pill {
          padding: 8px 12px;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: var(--card2);
          color: var(--muted);
          font-size: 12px;
          font-weight: 800;
        }

        .user-info {
          display: flex;
          flex-direction: column;
          line-height: 1.2;
        }

        .user-addr {
          font-size: 0.85rem;
          font-weight: 600;
        }

        .user-status {
          font-size: 0.65rem;
          color: var(--win);
          text-transform: uppercase;
          font-weight: 800;
        }

        .logout-btn {
          background: none;
          border: none;
          color: var(--muted);
          cursor: pointer;
          padding: 4px;
        }

        .logout-btn:hover {
          color: var(--text);
        }

        .desktop-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 380px;
          gap: 24px;
        }

        .desktop-stage {
          background: var(--card);
          border-radius: 20px;
          border: 1px solid var(--border);
          padding: 28px;
          overflow: hidden;
        }

        .desktop-sidebar {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .mobile-layout {
          display: none;
        }

        .stage-header {
          text-align: center;
          margin-bottom: 24px;
        }

        .stage-title {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          margin-bottom: 10px;
        }

        .stage-title h1 {
          font-size: 2.2rem;
          font-weight: 900;
          margin: 0;
        }

        .stage-icon {
          color: var(--accent);
        }

        .stage-subtitle {
          color: var(--muted);
          margin: 0;
          font-size: 1.05rem;
        }

        .demo-notice {
          margin-top: 15px;
          padding: 12px 20px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--border);
          border-radius: 12px;
          font-size: 0.85rem;
          color: var(--muted);
          display: inline-block;
          text-align: center;
        }

        .desktop-stage-shell {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 360px;
          gap: 24px;
          align-items: stretch;
        }

        .desktop-play-card {
          height: fit-content;
        }

        .section-stack {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .sidebar-card {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 18px;
          padding: 20px;
          backdrop-filter: blur(10px);
        }

        .game-card {
          background:
            linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)),
            var(--card);
        }

        .card-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 16px;
          color: var(--muted);
        }

        .card-header h3 {
          font-size: 13px;
          margin: 0;
          text-transform: uppercase;
          font-weight: 850;
          color: var(--text);
          letter-spacing: 0.4px;
        }

        .stage-visual {
          min-height: 540px;
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          border-radius: 18px;
          background:
            radial-gradient(500px 280px at center, rgba(232,65,66,0.12), transparent 60%),
            rgba(255,255,255,0.02);
          border: 1px solid var(--border);
          padding: 32px 24px 20px;
        }

        .visual-effects {
          position: absolute;
          inset: 0;
          pointer-events: none;
        }

        .glow-orb {
          position: absolute;
          width: 300px;
          height: 300px;
          border-radius: 50%;
          filter: blur(100px);
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        }

        .glow-orb.red-primary {
          background: rgba(232,65,66,0.5);
          margin-left: -100px;
          opacity: 0.28;
        }

        .glow-orb.red-secondary {
          background: rgba(255,107,107,0.4);
          margin-left: 100px;
          opacity: 0.24;
        }

        .result-banner {
          margin-top: 8px;
          min-height: 60px;
          text-align: center;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .status-pill {
          padding: 12px 22px;
          border-radius: 999px;
          font-weight: 900;
          font-size: 1rem;
          border: 1px solid transparent;
          letter-spacing: 0.8px;
          display: inline-block;
          max-width: 100%;
        }

        .status-pill.is-idle {
          background: var(--card2);
          border-color: var(--border);
          color: var(--muted);
        }

        .status-pill.is-win {
          background: var(--win-bg);
          border-color: rgba(34,197,94,0.45);
          color: var(--win);
          box-shadow: 0 0 30px rgba(34,197,94,0.15);
        }

        .status-pill.is-loss {
          background: var(--loss-bg);
          border-color: rgba(255,107,107,0.45);
          color: var(--loss);
        }

        .rolling-status {
          font-weight: 900;
          color: var(--accent);
          letter-spacing: 4px;
          animation: pulse 1s infinite;
        }

        .quick-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 15px;
          width: 100%;
          margin-top: 18px;
        }

        .q-stat {
          background: var(--card2);
          border: 1px solid var(--border);
          padding: 15px;
          border-radius: 14px;
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        .q-label {
          font-size: 0.7rem;
          text-transform: uppercase;
          font-weight: 800;
          color: var(--muted);
          margin-bottom: 5px;
        }

        .q-val {
          font-size: 1.2rem;
          font-weight: 900;
          color: var(--accent);
        }

        .signin-panel {
          display: flex;
          flex-direction: column;
          gap: 14px;
          align-items: center;
          text-align: center;
        }

        .signin-title {
          font-size: 1rem;
          font-weight: 850;
        }

        .signin-sub {
          font-size: 0.9rem;
          color: var(--muted);
          line-height: 1.5;
        }

        .mini-note {
          font-size: 12px;
          color: var(--muted);
        }

        .google-side-wrap {
          display: flex;
          justify-content: center;
          width: 100%;
          min-height: 44px;
        }

        .bet-select,
        .bet-amount-wrapper {
          background: rgba(0,0,0,0.22);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 14px;
          color: var(--text);
          outline: none;
          transition: border-color 0.12s ease;
        }

        .bet-select {
          width: 100%;
          padding: 14px 12px;
          font-weight: 700;
          cursor: pointer;
        }

        .bet-select:focus,
        .bet-input:focus {
          border-color: rgba(232,65,66,0.55);
          box-shadow: 0 0 0 3px rgba(232,65,66,0.15);
        }

        .input-header {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          font-size: 12px;
          font-weight: 750;
          color: var(--muted);
          margin-bottom: 8px;
        }

        .mt-4 {
          margin-top: 4px;
        }

        .bet-amount-wrapper {
          position: relative;
          overflow: hidden;
          display: flex;
          align-items: center;
        }

        .bet-input {
          flex: 1;
          background: none;
          border: none;
          padding: 16px;
          color: var(--text);
          font-size: 1.15rem;
          font-weight: 800;
          outline: none;
          min-width: 0;
        }

        .bet-asset {
          padding-right: 15px;
          font-weight: 900;
          color: var(--accent);
          font-size: 0.9rem;
        }

        .quick-chips {
          display: grid;
          gap: 8px;
          margin-top: 12px;
        }

        .desktop-chips {
          grid-template-columns: repeat(2, 1fr);
        }

        .desktop-chips .max {
          grid-column: span 2;
        }

        .chip-btn {
          background: var(--card2);
          border: 1px solid var(--border);
          color: var(--text);
          padding: 11px 8px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 750;
          cursor: pointer;
          transition: filter 0.12s ease;
        }

        .chip-btn:hover {
          filter: brightness(1.15);
        }

        .chip-btn.max {
          color: var(--accent);
          border-color: rgba(232,65,66,0.55);
          background: rgba(232,65,66,0.1);
        }

        .roll-trigger {
          width: 100%;
          background: linear-gradient(180deg, rgba(232,65,66,0.98), rgba(198,46,57,0.98));
          border: 1px solid rgba(255,255,255,0.12);
          color: white;
          padding: 16px;
          border-radius: 16px;
          font-size: 1.05rem;
          font-weight: 900;
          cursor: pointer;
          transition: filter 0.12s ease, transform 0.06s ease;
          min-height: 56px;
          margin-top: 16px;
        }

        .roll-trigger:hover:not(:disabled) {
          filter: brightness(1.05);
        }

        .roll-trigger:active:not(:disabled) {
          transform: translateY(1px);
        }

        .roll-trigger:disabled {
          opacity: 0.55;
          cursor: not-allowed;
          filter: none !important;
        }

        .roll-trigger.is-spinning {
          animation: shake-tiny 0.1s infinite;
        }

        .error-toast {
          margin-top: 14px;
          padding: 10px 12px;
          background: var(--loss-bg);
          border: 1px solid rgba(255,107,107,0.45);
          color: rgba(254,202,202,0.95);
          border-radius: 12px;
          font-size: 13px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          text-align: center;
        }

        .balance-list,
        .history-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .balance-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 14px;
          border-radius: 14px;
          background: var(--card2);
          border: 1px solid var(--border);
          gap: 10px;
        }

        .balance-row-btn {
          width: 100%;
          cursor: pointer;
          text-align: left;
        }

        .balance-row.active {
          border-color: var(--accent);
          background: rgba(232,65,66,0.1);
        }

        .b-info {
          min-width: 0;
        }

        .b-sym {
          font-weight: 800;
          font-size: 13px;
        }

        .b-addr {
          font-size: 11px;
          color: var(--muted);
        }

        .b-amt {
          font-weight: 800;
          font-size: 14px;
        }

        .history-item {
          padding: 12px 14px;
          border-radius: 14px;
          background: var(--card2);
          border-left: 4px solid var(--border);
        }

        .history-item.win {
          border-left-color: var(--win);
          background: rgba(34,197,94,0.05);
        }

        .history-item.loss {
          border-left-color: var(--loss);
          background: rgba(239,68,68,0.05);
        }

        .h-main {
          display: flex;
          justify-content: space-between;
          margin-bottom: 4px;
          gap: 8px;
        }

        .h-kind {
          font-size: 12px;
          font-weight: 800;
        }

        .h-time {
          font-size: 11px;
          color: var(--muted);
          white-space: nowrap;
        }

        .h-amt {
          font-weight: 850;
          font-size: 13px;
        }

        .score-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
        }

        .score-box {
          background: var(--card2);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 14px;
          text-align: center;
        }

        .score-box span {
          display: block;
          font-size: 11px;
          text-transform: uppercase;
          color: var(--muted);
          font-weight: 800;
          margin-bottom: 6px;
        }

        .score-box strong {
          font-size: 1.2rem;
          font-weight: 900;
          color: var(--accent);
        }

        .ledger-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 12px;
        }

        .mobile-ledger-grid {
          grid-template-columns: 1fr;
        }

        .ledger-cell {
          background: var(--card2);
          border: 1px solid var(--border);
          padding: 12px;
          border-radius: 12px;
        }

        .l-head {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
          gap: 8px;
        }

        .l-kind {
          font-size: 11px;
          font-weight: 800;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .l-time {
          font-size: 11px;
          color: var(--muted);
        }

        .l-body {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }

        .l-sym {
          font-weight: 800;
          font-size: 12px;
        }

        .l-human {
          font-weight: 850;
          font-size: 13px;
          color: var(--accent);
        }

        .dice-scene {
          width: 180px;
          height: 180px;
          position: relative;
          perspective: 1000px;
          margin-top: 6px;
          margin-bottom: 36px;
          flex: 0 0 auto;
        }

        .dice-scene.compact {
          width: 108px;
          height: 108px;
          margin-top: 0;
          margin-bottom: 14px;
          perspective: 800px;
        }

        .dice-cube {
          width: 100%;
          height: 100%;
          position: absolute;
          transform-style: preserve-3d;
          transition: transform 0.7s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        .dice-face {
          position: absolute;
          width: 180px;
          height: 180px;
          background: white;
          border: 5px solid #f0f0f0;
          border-radius: 28px;
          display: flex;
          padding: 24px;
          box-sizing: border-box;
          backface-visibility: hidden;
          box-shadow:
            inset 0 0 24px rgba(0,0,0,0.08),
            0 12px 24px rgba(0,0,0,0.18);
        }

        .dice-scene.compact .dice-face {
          width: 108px;
          height: 108px;
          border-width: 4px;
          border-radius: 18px;
          padding: 14px;
          box-shadow:
            inset 0 0 14px rgba(0,0,0,0.08),
            0 8px 18px rgba(0,0,0,0.18);
        }

        .dice-face span {
          width: 20px;
          height: 20px;
          background: #222;
          border-radius: 50%;
          display: block;
        }

        .dice-scene.compact .dice-face span {
          width: 12px;
          height: 12px;
        }

        .face-1 {
          transform: rotateY(0deg) translateZ(90px);
          justify-content: center;
          align-items: center;
        }

        .face-1 span {
          background: #e84142;
          width: 28px;
          height: 28px;
        }

        .dice-scene.compact .face-1 span {
          width: 18px;
          height: 18px;
        }

        .face-6 {
          transform: rotateY(180deg) translateZ(90px);
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
        }

        .face-2 {
          transform: rotateY(90deg) translateZ(90px);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .face-2 span:last-child {
          align-self: flex-end;
        }

        .face-5 {
          transform: rotateY(-90deg) translateZ(90px);
          display: grid;
          grid-template-columns: 1fr 1fr;
          grid-template-rows: 1fr 1fr 1fr;
          gap: 10px;
        }

        .face-5 span:nth-child(3) {
          grid-area: 2 / 1 / 3 / 3;
          justify-self: center;
        }

        .face-3 {
          transform: rotateX(90deg) translateZ(90px);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .face-3 span:nth-child(2) {
          align-self: center;
        }

        .face-3 span:last-child {
          align-self: flex-end;
        }

        .face-4 {
          transform: rotateX(-90deg) translateZ(90px);
          display: grid;
          grid-template-columns: 1fr 1fr;
          align-content: space-between;
          gap: 10px;
        }

        .dice-scene.compact .face-6 {
          gap: 8px;
        }

        .dice-scene.compact .face-5,
        .dice-scene.compact .face-4 {
          gap: 6px;
        }

        .dice-scene.compact .face-1 {
          transform: rotateY(0deg) translateZ(54px);
        }

        .dice-scene.compact .face-6 {
          transform: rotateY(180deg) translateZ(54px);
        }

        .dice-scene.compact .face-2 {
          transform: rotateY(90deg) translateZ(54px);
        }

        .dice-scene.compact .face-5 {
          transform: rotateY(-90deg) translateZ(54px);
        }

        .dice-scene.compact .face-3 {
          transform: rotateX(90deg) translateZ(54px);
        }

        .dice-scene.compact .face-4 {
          transform: rotateX(-90deg) translateZ(54px);
        }

        .is-rolling {
          animation: roll-animation 0.5s infinite linear;
        }

        .dice-shadow {
          position: absolute;
          width: 130px;
          height: 26px;
          background: rgba(0,0,0,0.35);
          left: 50%;
          bottom: -26px;
          transform: translateX(-50%);
          border-radius: 50%;
          filter: blur(14px);
        }

        .dice-scene.compact .dice-shadow {
          width: 78px;
          height: 18px;
          bottom: -18px;
          filter: blur(10px);
        }

        .money-rain-container {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 1000;
          overflow: hidden;
        }

        .rain-item {
          position: absolute;
          top: -50px;
          font-size: 2.5rem;
          animation: rain-fall 2.5s linear forwards;
        }

        .empty-state {
          color: var(--muted);
          font-size: 13px;
          text-align: center;
          padding: 16px;
        }

        .col-span-full {
          grid-column: 1 / -1;
        }

        .spinning {
          animation: spin 1s linear infinite;
        }

        .shake-loss {
          animation: shake-loss 0.4s ease-in-out;
        }

        .mobile-top-shell {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .mobile-tab-panel {
          min-height: calc(100vh - 128px);
        }

        .mobile-micro-header {
          display: none;
        }

        .mobile-back-mini,
        .mobile-refresh-mini {
          width: 36px;
          height: 36px;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: var(--card2);
          color: var(--text);
          display: grid;
          place-items: center;
          cursor: pointer;
        }

        .mobile-brand.compact {
          min-height: 36px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          font-size: 13px;
          font-weight: 900;
          letter-spacing: 0.4px;
        }

        .arcade-viewport {
          display: flex;
          flex-direction: column;
          min-height: calc(100vh - 138px);
          max-height: calc(100vh - 138px);
        }

        .arcade-scroll {
          flex: 1;
          overflow-y: auto;
          padding-bottom: 10px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .arcade-topbar {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
        }

        .arcade-pill {
          border: 1px solid var(--border);
          background: var(--card2);
          border-radius: 14px;
          padding: 10px 8px;
          text-align: center;
        }

        .arcade-pill span {
          display: block;
          font-size: 10px;
          text-transform: uppercase;
          color: var(--muted);
          font-weight: 800;
          margin-bottom: 3px;
        }

        .arcade-pill strong {
          font-size: 13px;
          font-weight: 900;
        }

        .arcade-dice-zone {
          position: relative;
          min-height: 180px;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          border-radius: 18px;
          background:
            radial-gradient(circle at center, rgba(232,65,66,0.12), transparent 60%),
            rgba(255,255,255,0.03);
          border: 1px solid var(--border);
          padding: 12px 8px 18px;
        }

        .arcade-status {
          min-height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .arcade-controls {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .arcade-bet-wrap .bet-input {
          font-size: 1.05rem;
          padding: 14px;
        }

        .arcade-chips {
          grid-template-columns: repeat(4, 1fr);
        }

        .arcade-chips .max {
          grid-column: span 4;
        }

        .arcade-sticky-action {
          position: sticky;
          bottom: 0;
          padding-top: 10px;
          background: linear-gradient(
            180deg,
            rgba(11,10,15,0),
            rgba(11,10,15,0.95) 24%,
            rgba(11,10,15,1) 100%
          );
        }

        .mobile-roll-trigger {
          min-height: 58px;
          border-radius: 16px;
          font-size: 1rem;
          font-weight: 900;
          box-shadow: 0 10px 30px rgba(232,65,66,0.2);
          margin-top: 0;
        }

        .mobile-error-inline {
          margin-top: 2px;
        }

        .compact-signin {
          min-height: 220px;
          justify-content: center;
        }

        .mobile-tabbar {
          position: fixed;
          left: 12px;
          right: 12px;
          bottom: 12px;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
          padding: 8px;
          border-radius: 20px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(10,10,14,0.9);
          backdrop-filter: blur(16px);
          z-index: 40;
          box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        }

        .mobile-tab {
          border: none;
          background: transparent;
          color: var(--muted);
          border-radius: 14px;
          min-height: 58px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 4px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 800;
        }

        .mobile-tab.active {
          color: white;
          background: rgba(232,65,66,0.16);
          border: 1px solid rgba(232,65,66,0.4);
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes roll-animation {
          0% { transform: rotateX(0deg) rotateY(0deg); }
          100% { transform: rotateX(360deg) rotateY(360deg); }
        }

        @keyframes pulse {
          0% { opacity: 0.4; }
          50% { opacity: 1; }
          100% { opacity: 0.4; }
        }

        @keyframes shake-tiny {
          0% { transform: translateX(0); }
          25% { transform: translateX(2px); }
          75% { transform: translateX(-2px); }
          100% { transform: translateX(0); }
        }

        @keyframes shake-loss {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-10px); }
          40% { transform: translateX(10px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }

        @keyframes rain-fall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(110vh) rotate(360deg); opacity: 0; }
        }

        @media (max-width: 1200px) {
          .desktop-stage-shell {
            grid-template-columns: 1fr;
          }

          .stage-visual {
            min-height: 460px;
            padding: 24px 18px 18px;
          }

          .dice-scene {
            width: 150px;
            height: 150px;
            margin-bottom: 28px;
          }

          .dice-face {
            width: 150px;
            height: 150px;
            border-radius: 24px;
            padding: 20px;
          }

          .dice-face span {
            width: 17px;
            height: 17px;
          }

          .face-1 { transform: rotateY(0deg) translateZ(75px); }
          .face-6 { transform: rotateY(180deg) translateZ(75px); }
          .face-2 { transform: rotateY(90deg) translateZ(75px); }
          .face-5 { transform: rotateY(-90deg) translateZ(75px); }
          .face-3 { transform: rotateX(90deg) translateZ(75px); }
          .face-4 { transform: rotateX(-90deg) translateZ(75px); }

          .face-1 span {
            width: 24px;
            height: 24px;
          }

          .dice-shadow {
            width: 112px;
            height: 22px;
            bottom: -22px;
          }
        }

        @media (max-width: 1024px) {
          .desktop-layout {
            grid-template-columns: 1fr;
          }

          .desktop-sidebar {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
          }

          .desktop-sidebar > *:last-child {
            grid-column: 1 / -1;
          }
        }

        @media (max-width: 768px) {
          .game-wrapper {
            padding: 0 10px 94px;
          }

          .game-nav {
            display: none;
          }

          .desktop-layout {
            display: none;
          }

          .mobile-layout {
            display: block;
          }

          .mobile-micro-header {
            display: grid;
            grid-template-columns: 36px 1fr 36px;
            align-items: center;
            gap: 8px;
            position: sticky;
            top: 0;
            z-index: 25;
            padding: 8px 0 2px;
            background: linear-gradient(
              180deg,
              rgba(11,10,15,0.95),
              rgba(11,10,15,0.7),
              rgba(11,10,15,0)
            );
            backdrop-filter: blur(10px);
          }

          .sidebar-card {
            padding: 14px;
            border-radius: 16px;
          }

          .status-pill {
            font-size: 0.84rem;
            padding: 10px 14px;
            line-height: 1.3;
          }

          .arcade-dice-zone {
            min-height: 160px;
          }

          .arcade-chips {
            grid-template-columns: repeat(2, 1fr);
          }

          .arcade-chips .max {
            grid-column: span 2;
          }

          .bet-select {
            padding: 13px 12px;
          }

          .bet-input {
            font-size: 1rem;
          }

          .mobile-tabbar {
            left: 8px;
            right: 8px;
            bottom: 8px;
            padding: 6px;
          }

          .mobile-tab {
            min-height: 54px;
            font-size: 10px;
          }
        }

        @media (max-width: 420px) {
          .arcade-viewport {
            min-height: calc(100vh - 130px);
            max-height: calc(100vh - 130px);
          }

          .arcade-dice-zone {
            min-height: 145px;
          }

          .arcade-pill strong {
            font-size: 12px;
          }

          .arcade-pill span {
            font-size: 9px;
          }

          .mobile-roll-trigger {
            min-height: 56px;
          }

          .score-grid {
            grid-template-columns: 1fr;
          }

          .dice-scene.compact {
            width: 100px;
            height: 100px;
          }

          .dice-scene.compact .dice-face {
            width: 100px;
            height: 100px;
            padding: 13px;
          }

          .dice-scene.compact .face-1 {
            transform: rotateY(0deg) translateZ(50px);
          }

          .dice-scene.compact .face-6 {
            transform: rotateY(180deg) translateZ(50px);
          }

          .dice-scene.compact .face-2 {
            transform: rotateY(90deg) translateZ(50px);
          }

          .dice-scene.compact .face-5 {
            transform: rotateY(-90deg) translateZ(50px);
          }

          .dice-scene.compact .face-3 {
            transform: rotateX(90deg) translateZ(50px);
          }

          .dice-scene.compact .face-4 {
            transform: rotateX(-90deg) translateZ(50px);
          }
        }
      `}</style>
    </div>
  );
}
