// services/core-api/src/http/routes.ts
import { ObjectId, type Db } from 'mongodb';
import { Router } from 'express';
import { ethers } from 'ethers';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import type { MongoCollections } from '../db/mongo';
import type { SystemConfig } from '@yeticashier/common';
import { normalizeAddress, userAccountId, treasuryAccountId } from '@yeticashier/common';

import { makeNonce, signJwt, buildLoginMessage, recoverLoginSigner } from './auth';
import { applyLedgerEntryTx, applyLedgerEntry } from '../db/ledgerEngine';
import {
  requireAdmin,
  requireIndexer,
  requireJwt,
  requireModule,
  requireRelayer,
  requireTgJwt,
  sha256Hex,
  type AuthedRequest
} from './middlewares';

import { sweepFeeTreasuryOnce } from '../fees/feeSweep';
import { decryptBox, encryptBox } from '../security/cryptoBox';
import { registerDiceCoreRoutes } from '@yeticashier/module-dice';
import { registerLotteryCoreRoutes } from '@yeticashier/module-lottery';
import { registerWhackCoreRoutes } from '@yeticashier/module-whack';
import { registerBlackjackCoreRoutes } from '@yeticashier/module-blackjack';

const ERC20_BALANCE_ABI = [
  'function balanceOf(address) view returns (uint256)'
];

import {
  getEip712Domain,
  getOwnerNonce,
  getSessionState,
  getSessionTokenCaps,
  getNextSessionEpoch,
  typedDataWithdraw,
  typedDataWithdrawNative,
  typedDataRegisterSession,
  typedDataConfigSessionToken,
  typedDataSessionWithdraw,
  typedDataSessionWithdrawNative
  // NOTE: bridge typed-data helpers can be added back here when you wire bridge routes.
} from '../vault/eip712';

function isEvmAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function tgAccountId(moduleId: string, tgId: string): string {
  return `tg:${String(moduleId || '').trim()}:${String(tgId || '').trim()}`;
}

function normalizeUsername(u?: string | null): string {
  const s = String(u || '').trim();
  if (!s) return '';
  return s.startsWith('@') ? s.slice(1).trim().toLowerCase() : s.toLowerCase();
}


type GoogleTokenInfo = {
  sub: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  aud?: string;
  iss?: string;
  exp?: string;
};

function normalizeEmail(v?: string | null): string {
  const s = String(v || '').trim().toLowerCase();
  return s || '';
}

function truthyGoogleBool(v: any): boolean {
  return v === true || v === 'true' || v === '1';
}

async function verifyGoogleIdTokenWithGoogle(idToken: string, expectedClientId?: string): Promise<GoogleTokenInfo> {
  const token = String(idToken || '').trim();
  if (!token) throw new Error('MISSING_GOOGLE_ID_TOKEN');

  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`GOOGLE_VERIFY_FAILED${txt ? `:${txt.slice(0, 200)}` : ''}`);
  }

  const j = (await r.json().catch(() => ({}))) as GoogleTokenInfo;

  const sub = String(j?.sub || '').trim();
  if (!sub) throw new Error('GOOGLE_SUB_MISSING');

  const iss = String(j?.iss || '').trim();
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    throw new Error('GOOGLE_BAD_ISSUER');
  }

  const aud = String(j?.aud || '').trim();
  if (expectedClientId && aud !== expectedClientId) {
    throw new Error('GOOGLE_BAD_AUDIENCE');
  }

  const exp = Number(j?.exp || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(exp) || exp <= now) {
    throw new Error('GOOGLE_TOKEN_EXPIRED');
  }

  return j;
}

function signGoogleLinkToken(
  payload: {
    jti: string;
    googleSub: string;
    email?: string | null;
    name?: string | null;
    picture?: string | null;
  },
  secret: string
) {
  return jwt.sign(
    {
      sub: `google-link:${payload.googleSub}`,
      jti: payload.jti,
      googleSub: payload.googleSub,
      email: payload.email || null,
      name: payload.name || null,
      picture: payload.picture || null,
      roles: ['google_link']
    },
    secret,
    { algorithm: 'HS256', expiresIn: '15m' }
  );
}

function verifyGoogleLinkToken(token: string, secret: string): { jti: string; googleSub: string } {
  const decoded = jwt.verify(token, secret) as any;
  const sub = String(decoded?.sub || '').trim();
  const jti = String(decoded?.jti || '').trim();
  const googleSub = String(decoded?.googleSub || '').trim();

  if (!sub.startsWith('google-link:')) throw new Error('BAD_GOOGLE_LINK_TOKEN');
  if (!jti || !googleSub) throw new Error('BAD_GOOGLE_LINK_TOKEN');

  return { jti, googleSub };
}

function verifyTelegramInitData(initData: string, botToken: string, maxAgeSec = 86400) {
  const raw = String(initData || '').trim();
  if (!raw) throw new Error('MISSING_INITDATA');

  const params = new URLSearchParams(raw);

  const hash = String(params.get('hash') || '').trim().toLowerCase();
  if (!hash) throw new Error('MISSING_HASH');

  const authDateRaw = String(params.get('auth_date') || '').trim();
  const authDate = Number(authDateRaw || 0);
  if (!Number.isFinite(authDate) || authDate <= 0) throw new Error('BAD_AUTH_DATE');

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60) throw new Error('AUTH_DATE_IN_FUTURE');
  if (maxAgeSec > 0 && now - authDate > maxAgeSec) throw new Error('INITDATA_EXPIRED');

  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join("\n");

  // Telegram Mini App validation:
  // secret = HMAC_SHA256("WebAppData", botToken)
  // expected = HMAC_SHA256_HEX(secret, data_check_string)
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex').toLowerCase();

  let hashBuf: Buffer;
  let computedBuf: Buffer;
  try {
    hashBuf = Buffer.from(hash, 'hex');
    computedBuf = Buffer.from(computed, 'hex');
  } catch {
    throw new Error('BAD_INITDATA_SIGNATURE');
  }
  if (hashBuf.length !== computedBuf.length || !crypto.timingSafeEqual(hashBuf, computedBuf)) {
    throw new Error('BAD_INITDATA_SIGNATURE');
  }

  const userRaw = String(params.get('user') || '').trim();
  if (!userRaw) throw new Error('MISSING_USER');

  let user: any;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new Error('BAD_USER_JSON');
  }
  const tgId = String(user?.id || '').trim();
  if (!tgId) throw new Error('MISSING_TGID');

  const username = normalizeUsername(user?.username || '');
  return { tgId, username, user, authDate };
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(bytes = 16) {
  return ethers.hexlify(ethers.randomBytes(bytes));
}

/** escrow account for withdraw HOLDs */
function escrowAccountId(accountId: string) {
  return `${accountId}:escrow`;
}

// transient error detection for retry/backoff
function isTransientRelayerError(errMsg: string) {
  const m = (errMsg || '').toLowerCase();
  return (
    m.includes('524') ||
    m.includes('502') ||
    m.includes('503') ||
    m.includes('504') ||
    m.includes('bad gateway') ||
    m.includes('gateway') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('server_error') ||
    m.includes('could not coalesce error') ||
    m.includes('network error')
  );
}

function nextBackoffMs(attempts: number) {
  // 5s, 15s, 45s, 2m, 5m, 10m ... capped
  const base = [5000, 15000, 45000, 120000, 300000, 600000];
  return base[Math.min(attempts, base.length - 1)];
}

/**
 * Fee helper.
 * - default bps comes from WITHDRAW_FEE_BPS env
 * - you can override per vault by passing bpsOverride
 */
function calcFeeNet(amountRaw: string, bpsOverride?: number): { feeRaw: string; netRaw: string; bps: number } {
  const bpsEnv = Number(process.env.WITHDRAW_FEE_BPS || 0);
  const bps = Number.isFinite(bpsOverride as any) ? Math.max(0, Math.trunc(bpsOverride!)) : bpsEnv;

  const amount = BigInt(amountRaw);
  if (amount <= 0n) throw new Error('AMOUNT_TOO_SMALL');

  const fee = bps > 0 ? (amount * BigInt(bps)) / 10_000n : 0n;
  const net = amount - fee;
  if (net <= 0n) throw new Error('AMOUNT_TOO_SMALL');

  return { feeRaw: fee.toString(), netRaw: net.toString(), bps };
}

/**
 * Applies fee + burn as TWO atomic ledger entries (in ONE mongo transaction).
 * This is used by the TG session-withdraw endpoints that burn immediately.
 */
async function applyWithdrawLedgerTx(
  db: Db,
  col: MongoCollections,
  input: {
    refId: string;
    chainId: number;
    token: string;
    fromAccountId: string;
    amountRaw: string;
    moduleId?: string;
    meta?: Record<string, any>;
    feeBpsOverride?: number;
    feeTreasuryIdOverride?: string;
  }
): Promise<{ feeRaw: string; netRaw: string; bps: number }> {
  const feeTreasuryId = String(input.feeTreasuryIdOverride || process.env.FEE_TREASURY_ID || 'fees');
  const { feeRaw, netRaw, bps } = calcFeeNet(input.amountRaw, input.feeBpsOverride);

  const fee = BigInt(feeRaw);
  const net = BigInt(netRaw);

  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      if (fee > 0n) {
        await applyLedgerEntry(db, col, session, {
          refId: `${input.refId}:fee`,
          kind: 'withdraw_fee',
          chainId: input.chainId,
          token: input.token,
          moduleId: input.moduleId,
          fromAccountId: input.fromAccountId,
          toAccountId: treasuryAccountId(feeTreasuryId),
          amountRaw: fee.toString(),
          meta: input.meta
        });
      }

      // burn net
      await applyLedgerEntry(db, col, session, {
        refId: `${input.refId}:burn`,
        kind: 'withdraw',
        chainId: input.chainId,
        token: input.token,
        moduleId: input.moduleId,
        fromAccountId: input.fromAccountId,
        toAccountId: undefined,
        amountRaw: net.toString(),
        meta: input.meta
      });
    });
  } finally {
    await session.endSession();
  }

  return { feeRaw, netRaw, bps };
}


// ---------------------
// Enabled token USD prices (GeckoTerminal) - cached
// ---------------------

const TOKEN_PRICE_TTL_MS = 30_000;

type EnabledTokenPriceRow = {
  token: string;
  symbol: string;
  decimals: number;
  enabled: boolean;
  priceUsd: number | null;
  source?: string;
};

type EnabledTokenPricesCacheEntry = {
  updatedAt: number;
  source: string;
  rows: EnabledTokenPriceRow[];
};

const enabledTokenPricesCache = new Map<string, EnabledTokenPricesCacheEntry>();

function geckoNetworkForChainId(chainId: number): string | null {
  const m: Record<number, string> = {
    1: 'eth',
    10: 'optimism',
    56: 'bsc',
    137: 'polygon_pos',
    8453: 'base',
    42161: 'arbitrum',
    43114: 'avax',
    42220: 'celo',
  };
  return m[Number(chainId)] || null;
}

function toNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchGeckoTokenPricesUsd(chainId: number, tokenAddrs: string[]) {
  const network = geckoNetworkForChainId(chainId);
  if (!network) throw new Error(`UNSUPPORTED_CHAIN_FOR_PRICES:${chainId}`);

  const addrs = Array.from(
    new Set(
      (tokenAddrs || [])
        .map((a) => String(a || '').trim().toLowerCase())
        .filter((a) => isEvmAddress(a))
    )
  );

  const out: Record<string, number | null> = {};
  if (!addrs.length) return { source: 'geckoterminal', prices: out };

  // GeckoTerminal supports multiple addresses in one call (comma-separated)
  // Example:
  // /api/v2/simple/networks/bsc/token_price/0x...,0x...
  const url =
    `https://api.geckoterminal.com/api/v2/simple/networks/${encodeURIComponent(network)}` +
    `/token_price/${addrs.map(encodeURIComponent).join(',')}`;

  const r = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`GECKO_HTTP_${r.status}${txt ? `:${txt.slice(0, 200)}` : ''}`);
  }

  const j: any = await r.json().catch(() => ({}));

  // GeckoTerminal simple endpoint typically returns:
  // { data: { attributes: { token_prices: { "<addr>": "0.1234", ... } } } }
  const tokenPrices =
    j?.data?.attributes?.token_prices && typeof j.data.attributes.token_prices === 'object'
      ? j.data.attributes.token_prices
      : {};

  for (const a of addrs) {
    const raw = (tokenPrices as any)?.[a] ?? (tokenPrices as any)?.[a.toLowerCase()] ?? (tokenPrices as any)?.[a.toUpperCase()];
    out[a] = raw == null ? null : toNum(raw);
  }

  return { source: 'geckoterminal', prices: out };
}

async function getEnabledTokenPricesCached(cfg: SystemConfig, chainId: number, forceRefresh = false): Promise<EnabledTokenPricesCacheEntry> {
  const key = String(chainId);
  const now = Date.now();
  const cached = enabledTokenPricesCache.get(key);

  if (!forceRefresh && cached && (now - cached.updatedAt) < TOKEN_PRICE_TTL_MS) {
    return cached;
  }

  const chain = (cfg.chains || []).find((c: any) => Number(c.chainId) === Number(chainId) && !!c.enabled);
  if (!chain) throw new Error('BAD_CHAIN');

  const enabledTokens = (Array.isArray((chain as any).tokens) ? (chain as any).tokens : [])
    .filter((t: any) => t && t.enabled && isEvmAddress(String(t.address || '')))
    .map((t: any) => ({
      token: normalizeAddress(String(t.address)),
      symbol: String(t.symbol || '').trim() || String(t.address || '').slice(0, 6),
      decimals: Number.isFinite(Number(t.decimals)) ? Number(t.decimals) : 18,
      enabled: !!t.enabled,
    }));

  const tokenAddrs = enabledTokens.map((t: { token: string }) => t.token);
  const { source, prices } = await fetchGeckoTokenPricesUsd(chainId, tokenAddrs);

const rows: EnabledTokenPriceRow[] = enabledTokens.map((t: { token: string; symbol: string; decimals: number; enabled: boolean }) => ({
    token: t.token,
    symbol: t.symbol,
    decimals: t.decimals,
    enabled: t.enabled,
    priceUsd: prices[t.token.toLowerCase()] ?? null,
    source,
  }));

  const entry: EnabledTokenPricesCacheEntry = {
    updatedAt: now,
    source,
    rows,
  };

  enabledTokenPricesCache.set(key, entry);
  return entry;
}

export function buildRoutes(db: Db, col: MongoCollections, cfg: SystemConfig) {
  const r = Router();

  const adminMw = requireAdmin(cfg);
  const enableTgSessWithdraw = String(process.env.ENABLE_TG_SESSION_WITHDRAW || '0') === '1';
  const enableTgLinking = String(process.env.ENABLE_TG_LINKING || '1') === '1';
  const sessionEncSecret = String(process.env.SESSION_KEY_ENC_SECRET || '');
  const feeTreasuryId = String(process.env.FEE_TREASURY_ID || 'fees');
  const googleClientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();

  function getChainAndVault(chainId: number, vaultId: string) {
    const chain = cfg.chains.find((c) => c.chainId === chainId && c.enabled);
    if (!chain) throw new Error('UNKNOWN_CHAIN');

    const vault = chain.vaults.find(
      (v: any) => (String(v.id || v.vaultId) === vaultId) && v.enabled
    );
    if (!vault) throw new Error('UNKNOWN_VAULT');

    return { chain, vault };
  }

  function resolveEnabledToken(cfg: any, chainId: number, asset: string) {
    const chain = (cfg.chains || []).find((c: any) => Number(c.chainId) === Number(chainId));
    if (!chain) return null;
    const tokens = Array.isArray(chain.tokens) ? chain.tokens : [];
    const enabled = tokens.filter((t: any) => t && t.enabled);

    // --- wrapped-native aliasing
    // UX: treat native + wrapped-native symbols as interchangeable.
    // Ledger: always uses wrapped-native ERC20 (vault.wNative).
    // Display: prefer native symbol (BNB/ETH/AVAX/...) for wrapped-native.
    const wNativeAddr = String(chain.vaults?.[0]?.wNative || '').toLowerCase();
    const wNativeToken = wNativeAddr
      ? enabled.find((x: any) => String(x.address || '').toLowerCase() === wNativeAddr)
      : null;

    function guessNativeSymbol(): string {
      const m: Record<number, string> = {
        1: 'ETH',
        5: 'ETH',
        11155111: 'ETH',
        56: 'BNB',
        97: 'BNB',
        137: 'MATIC',
        80001: 'MATIC',
        10: 'ETH',
        42161: 'ETH',
        43114: 'AVAX',
        43113: 'AVAX'
      };
      const byId = m[Number(chainId)];
      if (byId) return byId;

      const ws = String(wNativeToken?.symbol || '').trim();
      if (ws.length >= 2 && (ws[0] === 'W' || ws[0] === 'w')) return ws.slice(1).toUpperCase();
      return ws.toUpperCase() || 'NATIVE';
    }

    const nativeSym = guessNativeSymbol();
    const nativeAliases = new Set<string>(['native', nativeSym.toLowerCase()]);
    if (wNativeToken?.symbol) nativeAliases.add(String(wNativeToken.symbol).toLowerCase());

    const a = String(asset || '').trim();
    const al = a.toLowerCase();

    // Map native aliases (native/bnb/wbnb/eth/weth/...) -> wrapped-native token,
    // but return the *native* symbol.
    if (nativeAliases.has(al)) {
      if (wNativeToken) {
        return {
          enabled: true,
          token: String(wNativeToken.address).toLowerCase(),
          symbol: nativeSym,
          decimals: wNativeToken.decimals
        };
      }
    }

    // Direct address match
    if (isEvmAddress(a)) {
      const t = enabled.find((x: any) => String(x.address || '').toLowerCase() === al);
      if (!t) return { enabled: false };
      const isWrappedNative = wNativeToken && String(t.address || '').toLowerCase() === String(wNativeToken.address).toLowerCase();
      return {
        enabled: true,
        token: String(t.address).toLowerCase(),
        symbol: isWrappedNative ? nativeSym : t.symbol,
        decimals: t.decimals
      };
    }

    // Symbol match
    const t = enabled.find((x: any) => String(x.symbol || '').toLowerCase() === al);
    if (!t) return { enabled: false };
    const isWrappedNative = wNativeToken && String(t.address || '').toLowerCase() === String(wNativeToken.address).toLowerCase();
    return {
      enabled: true,
      token: String(t.address).toLowerCase(),
      symbol: isWrappedNative ? nativeSym : t.symbol,
      decimals: t.decimals
    };
  }


  function parseSessionLimits(): Record<string, { maxPerTxRaw: string; maxTotalRaw: string }> {
    const raw = String(process.env.TG_SESSION_TOKEN_LIMITS_JSON || '').trim();
    if (!raw || raw === '{}' || raw === 'null') return {};
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!obj || typeof obj !== 'object') return {};
    const out: Record<string, any> = {};

    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object') continue;
      const maxPerTxRaw = String((v as any).maxPerTxRaw || '').trim();
      const maxTotalRaw = String((v as any).maxTotalRaw || '').trim();
      if (!/^[0-9]+$/.test(maxPerTxRaw) || !/^[0-9]+$/.test(maxTotalRaw)) continue;
      out[String(k).toLowerCase()] = { maxPerTxRaw, maxTotalRaw };
    }
    return out;
  }

  // ---------------------
  // Public config
  // ---------------------
  r.get('/config/public', (_req, res) => {
    res.json({
      ok: true,
      system: cfg.system,
      security: { cors: cfg.security.cors, rateLimit: cfg.security.rateLimit },
      chains: cfg.chains.map((c) => ({
        chainId: c.chainId,
        name: c.name,
        enabled: c.enabled,
        rpcHttp: c.rpcHttp,
        explorer: c.explorer,
        ccip: c.ccip,
        vaults: c.vaults.map((v) => ({
          id: (v as any).id ?? (v as any).vaultId,
          address: (v as any).address,
          usdc: (v as any).usdc,
          wNative: (v as any).wNative,
          enabled: (v as any).enabled
        })),
        // If a token is the wrapped-native address for this chain, surface it as the
        // native symbol (BNB/ETH/...) to avoid forcing users to think in wrapped terms.
        tokens: (() => {
          const wNative = String(c.vaults?.[0]?.wNative || '').toLowerCase();
          const guessNative = () => {
            const m: Record<number, string> = { 1: 'ETH', 5: 'ETH', 11155111: 'ETH', 56: 'BNB', 97: 'BNB', 43114: 'AVAX', 43113: 'AVAX' };
            const byId = m[Number(c.chainId)];
            if (byId) return byId;
            const wt = (c.tokens || []).find((x: any) => String(x.address || '').toLowerCase() === wNative);
            const ws = String((wt as any)?.symbol || '').trim();
            if (ws.length >= 2 && (ws[0] === 'W' || ws[0] === 'w')) return ws.slice(1).toUpperCase();
            return ws.toUpperCase() || 'NATIVE';
          };
          const nativeSym = guessNative();

          return c.tokens.map((t) => {
            const isWrappedNative = wNative && String(t.address || '').toLowerCase() === wNative;
            return {
              symbol: isWrappedNative ? nativeSym : t.symbol,
              address: t.address,
              decimals: t.decimals,
              enabled: t.enabled
            };
          });
        })()
      })),
      modules: cfg.modules
    });
  });

  // Public enabled-token USD prices (cached; GeckoTerminal simple API)
  r.get(['/prices/enabled', '/token-prices/enabled'], async (req, res) => {
    const chainId = Number(req.query.chainId);
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    const forceRefresh = String(req.query.refresh || '').trim() === '1';
    try {
      const entry = await getEnabledTokenPricesCached(cfg, chainId, forceRefresh);
      return res.json({
        ok: true,
        chainId,
        updatedAt: new Date(entry.updatedAt).toISOString(),
        ttlMs: TOKEN_PRICE_TTL_MS,
        source: entry.source,
        items: entry.rows
      });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'PRICE_LOOKUP_FAILED' });
    }
  });

  // Enabled tokens indexed from TokenEnabled/TokenDisabled events
  r.get('/vault/config', async (req, res) => {
    const chainId = Number(req.query.chainId);
    const vaultId = String(req.query.vaultId || '').trim();
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    const tokens = await col.vaultTokens
      .find({ chainId, vaultId, enabled: true })
      .sort({ token: 1 })
      .toArray();

    res.json({
      ok: true,
      chainId,
      vaultId,
      vaultAddress: vault.address,
      usdc: vault.usdc,
      wNative: vault.wNative,
      tokens: tokens.map((t) => ({ token: t.token, decimals: t.decimals, enabled: t.enabled }))
    });
  });

  // ---------------------
  // Auth (wallet login → JWT)
  // ---------------------
  r.post('/auth/nonce', async (req, res) => {
    const address = normalizeAddress(String(req.body?.address || ''));
    if (!isEvmAddress(address)) return res.status(400).json({ error: 'BAD_ADDRESS' });

    const nonce = makeNonce();
    const ttl = Number(process.env.NONCE_TTL_SECONDS || 300);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await col.nonces.updateOne(
      { _id: address },
      { $set: { nonce, expiresAt, createdAt: new Date() } },
      { upsert: true }
    );

    res.json({
      ok: true,
      address,
      nonce,
      message: buildLoginMessage(address, nonce),
      expiresAt: expiresAt.toISOString()
    });
  });

  r.post('/auth/verify', async (req, res) => {
    const address = normalizeAddress(String(req.body?.address || ''));
    const signature = String(req.body?.signature || '').trim();
    if (!isEvmAddress(address)) return res.status(400).json({ error: 'BAD_ADDRESS' });
    if (!signature) return res.status(400).json({ error: 'BAD_SIGNATURE' });

    const nonceDoc = await col.nonces.findOne({ _id: address });
    if (!nonceDoc) return res.status(400).json({ error: 'NO_NONCE' });
    if (nonceDoc.expiresAt.getTime() < Date.now()) return res.status(400).json({ error: 'NONCE_EXPIRED' });

    const msg = buildLoginMessage(address, nonceDoc.nonce);
    const recovered = recoverLoginSigner(msg, signature);
    if (recovered !== address) return res.status(401).json({ error: 'BAD_SIG' });

    await col.nonces.deleteOne({ _id: address });

    const secret = process.env.JWT_SECRET || '';
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET_NOT_SET' });

    const isAdmin = (cfg.security.adminAddresses || []).map((a) => a.toLowerCase()).includes(address);
    const token = signJwt(address, secret, isAdmin ? ['admin'] : []);
    res.json({ ok: true, address, token });
  });

  r.post('/auth/google/verify', async (req, res) => {
    try {
      const secret = String(process.env.JWT_SECRET || '').trim();
      if (!secret) return res.status(500).json({ error: 'JWT_SECRET_NOT_SET' });
      if (!googleClientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID_NOT_SET' });

      const idToken = String(req.body?.idToken || req.body?.credential || '').trim();
      if (!idToken) return res.status(400).json({ error: 'MISSING_GOOGLE_ID_TOKEN' });

      const info = await verifyGoogleIdTokenWithGoogle(idToken, googleClientId);

      const googleSub = String(info.sub).trim();
      const email = String(info.email || '').trim() || null;
      const emailLower = normalizeEmail(email || '');
      const emailVerified = truthyGoogleBool(info.email_verified);
      const name = String(info.name || '').trim() || null;
      const picture = String(info.picture || '').trim() || null;

      const now = new Date();
      const googleId = `google:${googleSub}`;

      await col.googleUsers.updateOne(
        { _id: googleId } as any,
        {
          $setOnInsert: {
            _id: googleId,
            googleSub,
            createdAt: now
          },
          $set: {
            email,
            emailLower: emailLower || null,
            emailVerified,
            name,
            picture,
            updatedAt: now,
            lastLoginAt: now
          }
        } as any,
        { upsert: true }
      );

      const googleUser: any = await col.googleUsers.findOne({ _id: googleId } as any);
      const linkedWallet = String(googleUser?.ownerWallet || '').trim();

      if (linkedWallet && isEvmAddress(linkedWallet)) {
        const address = normalizeAddress(linkedWallet);
        const isAdmin = (cfg.security.adminAddresses || []).map((a) => a.toLowerCase()).includes(address);
        const token = signJwt(address, secret, isAdmin ? ['admin', 'google'] : ['google']);

        return res.json({
          ok: true,
          linked: true,
          address,
          token,
          authProvider: 'google'
        });
      }

      const jti = randomId(16);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      await col.googleLinkTokens.insertOne(
        {
          _id: jti,
          googleSub,
          email,
          name,
          picture,
          expiresAt,
          createdAt: now
        } as any
      );

      const googleLinkToken = signGoogleLinkToken(
        {
          jti,
          googleSub,
          email,
          name,
          picture
        },
        secret
      );

      return res.json({
        ok: true,
        linked: false,
        googleSub,
        email,
        name,
        googleLinkToken,
        expiresAt: expiresAt.toISOString(),
        next: 'LINK_WALLET'
      });
    } catch (e: any) {
      const msg = String(e?.message || 'GOOGLE_VERIFY_FAILED');
      const badReq = new Set([
        'MISSING_GOOGLE_ID_TOKEN',
        'GOOGLE_SUB_MISSING',
        'GOOGLE_BAD_AUDIENCE',
        'GOOGLE_BAD_ISSUER',
        'GOOGLE_TOKEN_EXPIRED'
      ]);
      return res.status(badReq.has(msg) ? 400 : 401).json({ error: msg });
    }
  });

  r.post('/me/google/link/confirm', requireJwt, async (req: AuthedRequest, res) => {
    try {
      const secret = String(process.env.JWT_SECRET || '').trim();
      if (!secret) return res.status(500).json({ error: 'JWT_SECRET_NOT_SET' });

      const ownerWallet = normalizeAddress(req.user!.address);
      const googleLinkToken = String(req.body?.googleLinkToken || '').trim();
      if (!googleLinkToken) return res.status(400).json({ error: 'MISSING_GOOGLE_LINK_TOKEN' });

      const { jti, googleSub } = verifyGoogleLinkToken(googleLinkToken, secret);

      const pending: any = await col.googleLinkTokens.findOne({ _id: jti } as any);
      if (!pending) return res.status(400).json({ error: 'GOOGLE_LINK_TOKEN_NOT_FOUND' });
      if (String(pending.googleSub || '') !== googleSub) return res.status(400).json({ error: 'GOOGLE_LINK_TOKEN_MISMATCH' });
      if (!(pending.expiresAt instanceof Date) || pending.expiresAt.getTime() < Date.now()) {
        return res.status(400).json({ error: 'GOOGLE_LINK_TOKEN_EXPIRED' });
      }

      const googleId = `google:${googleSub}`;
      const now = new Date();

      const existing: any = await col.googleUsers.findOne({ _id: googleId } as any);
      const existingOwner = String(existing?.ownerWallet || '').trim();
      if (existingOwner && normalizeAddress(existingOwner) !== ownerWallet) {
        return res.status(409).json({ error: 'GOOGLE_ALREADY_LINKED_TO_ANOTHER_WALLET' });
      }

      await col.googleUsers.updateOne(
        { _id: googleId } as any,
        {
          $set: {
            ownerWallet,
            linkedAt: now,
            updatedAt: now
          }
        } as any,
        { upsert: true }
      );

      await col.googleLinkTokens.deleteOne({ _id: jti } as any);

      return res.json({
        ok: true,
        linked: true,
        ownerWallet,
        googleSub
      });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'GOOGLE_LINK_FAILED') });
    }
  });

  r.get('/me/google/link/status', requireJwt, async (req: AuthedRequest, res) => {
    const ownerWallet = normalizeAddress(req.user!.address);

    const links = await col.googleUsers
      .find(
        { ownerWallet } as any,
        {
          projection: {
            _id: 1,
            googleSub: 1,
            email: 1,
            emailVerified: 1,
            name: 1,
            picture: 1,
            linkedAt: 1,
            updatedAt: 1,
            lastLoginAt: 1
          }
        }
      )
      .limit(20)
      .toArray();

    return res.json({
      ok: true,
      ownerWallet,
      linked: links.length > 0,
      links
    });
  });

  r.post('/me/google/link/unlink', requireJwt, async (req: AuthedRequest, res) => {
    const ownerWallet = normalizeAddress(req.user!.address);
    const googleSub = String(req.body?.googleSub || '').trim();
    if (!googleSub) return res.status(400).json({ error: 'MISSING_GOOGLE_SUB' });

    const googleId = `google:${googleSub}`;
    const doc: any = await col.googleUsers.findOne({ _id: googleId } as any);
    if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

    if (normalizeAddress(String(doc.ownerWallet || '')) !== ownerWallet) {
      return res.status(403).json({ error: 'NOT_LINKED_TO_THIS_WALLET' });
    }

    await col.googleUsers.updateOne(
      { _id: googleId } as any,
      {
        $set: {
          ownerWallet: null,
          linkedAt: null,
          updatedAt: new Date()
        }
      } as any
    );

    return res.json({ ok: true, unlinked: true, googleSub });
  });


// Telegram MiniApp auth (Telegram WebApp initData -> JWT)
r.post(['/auth/tg/verify', '/tg/auth/verify'], async (req, res) => {
  try {
    const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!botToken) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN_NOT_SET' });

    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET_NOT_SET' });

    const moduleId = String(req.body?.moduleId || 'tg').trim() || 'tg';
    const initData = String(req.body?.initData || '').trim();
    if (!initData) return res.status(400).json({ error: 'MISSING_INITDATA' });

    const maxAgeSec = Math.max(0, Number(process.env.TG_WEBAPP_MAX_AGE_SEC || 86400));
    const { tgId, username, user } = verifyTelegramInitData(initData, botToken, maxAgeSec);

    await col.tgSeenUsers.updateOne(
      { _id: `${moduleId}:tg:${tgId}` },
      {
        $set: {
          moduleId,
          tgId,
          username: user?.username ? String(user.username) : null,
          usernameLower: username || null,
          firstName: user?.first_name ? String(user.first_name) : null,
          lastName: user?.last_name ? String(user.last_name) : null,
          chatType: 'private',
          lastSeenAt: new Date()
        }
      },
      { upsert: true }
    );

    const sub = tgAccountId(moduleId, tgId);
    const token = jwt.sign({ sub, roles: ['tg'] }, secret, { algorithm: 'HS256', expiresIn: '24h' });
    return res.json({ ok: true, token, sub, moduleId, tgId, username: username || null });
  } catch (e: any) {
    const msg = String(e?.message || 'TG_VERIFY_FAILED');
    const code = (
      msg === 'MISSING_INITDATA' ||
      msg === 'MISSING_HASH' ||
      msg === 'BAD_AUTH_DATE' ||
      msg === 'MISSING_USER' ||
      msg === 'BAD_USER_JSON' ||
      msg === 'MISSING_TGID'
    ) ? 400 : 401;
    return res.status(code).json({ error: msg });
  }
});



r.post('/modules/:moduleId/tg/auth/token', requireModule(col), async (req, res) => {
  try {
    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET_NOT_SET' });

    const moduleId = String(req.params?.moduleId || 'tg').trim() || 'tg';
    const tgId = String(req.body?.tgId || '').trim();
    if (!tgId) return res.status(400).json({ error: 'MISSING_TG_ID' });

    // Keep a seen-user row so TG flows stay consistent with the rest of the system
    await col.tgSeenUsers.updateOne(
      { _id: `${moduleId}:tg:${tgId}` },
      {
        $set: {
          moduleId,
          tgId,
          chatType: 'private',
          lastSeenAt: new Date()
        }
      },
      { upsert: true }
    );

    const sub = tgAccountId(moduleId, tgId);
    const token = jwt.sign({ sub, roles: ['tg'] }, secret, {
      algorithm: 'HS256',
      expiresIn: '24h'
    });

    return res.json({ ok: true, token, sub, moduleId, tgId });
  } catch (e: any) {
    return res.status(400).json({ error: String(e?.message || 'TG_AUTH_TOKEN_FAILED') });
  }
});




function parseTgSub(sub: string) {
  const parts = String(sub || '').split(':');
  if (parts.length < 3 || parts[0] !== 'tg') throw new Error('BAD_TG_SUB');
  const moduleId = String(parts[1] || '').trim();
  const tgId = String(parts.slice(2).join(':') || '').trim();
  if (!moduleId || !tgId) throw new Error('BAD_TG_SUB');
  return { moduleId, tgId };
}

async function resolveMiniappTgAccount(moduleId: string, tgId: string) {
  const link = await col.tgLinks.findOne({ _id: `${moduleId}:tg:${tgId}` } as any);
  if (link?.ownerWallet) {
    const ownerWallet = normalizeAddress(String(link.ownerWallet));
    return { kind: 'linked_wallet' as const, ownerWallet, accountId: userAccountId(ownerWallet) };
  }
  return { kind: 'tg_holding' as const, ownerWallet: null, accountId: tgAccountId(moduleId, tgId) };
}

r.get('/tg/me/balances', requireTgJwt, async (req: AuthedRequest, res) => {
  try {
    const { moduleId, tgId } = parseTgSub((req as any).tg?.sub || '');
    const who = await resolveMiniappTgAccount(moduleId, tgId);
    const escId = escrowAccountId(who.accountId);

    const [mainBalances, escBalances] = await Promise.all([
      col.balances.find({ accountId: who.accountId }).toArray(),
      col.balances.find({ accountId: escId }).toArray()
    ]);

    const byKey = new Map<string, any>();
    for (const b of mainBalances) {
      const k = `${b.chainId}:${b.token}`;
      byKey.set(k, { chainId: b.chainId, token: b.token, availableRaw: b.balanceRaw, heldRaw: '0' });
    }
    for (const b of escBalances) {
      const k = `${b.chainId}:${b.token}`;
      const cur = byKey.get(k) || { chainId: b.chainId, token: b.token, availableRaw: '0', heldRaw: '0' };
      cur.heldRaw = b.balanceRaw;
      byKey.set(k, cur);
    }

    const items = Array.from(byKey.values()).map((x) => {
      const tok = resolveEnabledToken(cfg, Number(x.chainId), String(x.token));
      return {
        chainId: x.chainId,
        token: x.token,
        balanceRaw: x.availableRaw,
        availableRaw: x.availableRaw,
        heldRaw: x.heldRaw,
        totalRaw: (BigInt(x.availableRaw) + BigInt(x.heldRaw)).toString(),
        symbol: tok?.symbol,
        decimals: Number.isFinite(Number(tok?.decimals)) ? Number(tok?.decimals) : undefined
      };
    }).sort((a, b) => (a.chainId - b.chainId) || a.token.localeCompare(b.token));

    res.json({ ok: true, moduleId, tgId, accountId: who.accountId, linkedWallet: who.ownerWallet, items });
  } catch (e: any) {
    res.status(401).json({ error: String(e?.message || 'BAD_TOKEN') });
  }
});

r.get('/tg/me/ledger', requireTgJwt, async (req: AuthedRequest, res) => {
  try {
    const { moduleId, tgId } = parseTgSub((req as any).tg?.sub || '');
    const who = await resolveMiniappTgAccount(moduleId, tgId);
    const escId = escrowAccountId(who.accountId);
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const rawItems = await col.ledger.find({
      $or: [
        { fromAccountId: who.accountId },
        { toAccountId: who.accountId },
        { fromAccountId: escId },
        { toAccountId: escId }
      ]
    }).sort({ ts: -1 }).limit(limit).toArray();

    const items = rawItems.map((x: any) => {
      const tok = resolveEnabledToken(cfg, Number(x.chainId), String(x.token || ''));
      return {
        ...x,
        ts: x.ts instanceof Date ? x.ts.toISOString() : x.ts,
        symbol: tok?.symbol,
        decimals: Number.isFinite(Number(tok?.decimals)) ? Number(tok?.decimals) : undefined
      };
    });

    res.json({ ok: true, moduleId, tgId, accountId: who.accountId, linkedWallet: who.ownerWallet, items });
  } catch (e: any) {
    res.status(401).json({ error: String(e?.message || 'BAD_TOKEN') });
  }
});

r.post('/tg/me/transfer', requireTgJwt, async (req: AuthedRequest, res) => {
  try {
    const { moduleId, tgId } = parseTgSub((req as any).tg?.sub || '');
    const who = await resolveMiniappTgAccount(moduleId, tgId);

    const refId = String(req.body?.refId || '').trim();
    const chainId = Number(req.body?.chainId);
    const asset = String(req.body?.asset || req.body?.token || '').trim();
    const to = String(req.body?.to || '').trim();
    const amount = String(req.body?.amount || '').trim();

    if (!refId) return res.status(400).json({ error: 'MISSING_REFID' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!asset) return res.status(400).json({ error: 'BAD_ASSET' });
    if (!to) return res.status(400).json({ error: 'BAD_TO' });
    if (!amount) return res.status(400).json({ error: 'BAD_AMOUNT' });

    const resolved = resolveEnabledToken(cfg, chainId, asset);
    if (!resolved || !resolved.enabled || !resolved.token) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED' });

    let amountRaw = '';
    try {
      amountRaw = ethers.parseUnits(amount, Number(resolved.decimals || 18)).toString();
    } catch {
      return res.status(400).json({ error: 'BAD_AMOUNT' });
    }

    let resolvedToAccountId = '';
    if (to.startsWith('tg:')) {
      const p = to.split(':');
      const toMod = String(p[1] || '').trim();
      const toTgId = String(p.slice(2).join(':') || '').trim();
      if (!toMod || !toTgId) return res.status(400).json({ error: 'BAD_TG_TO' });
      const dest = await resolveMiniappTgAccount(toMod, toTgId);
      resolvedToAccountId = dest.accountId;
    } else if (to.startsWith('@')) {
      const uname = normalizeUsername(to);
      const seen = await col.tgSeenUsers.findOne({ moduleId, usernameLower: uname } as any);
      const targetTgId = String((seen as any)?.tgId || '').trim();
      if (!targetTgId) return res.status(400).json({ error: 'UNKNOWN_USERNAME' });
      const dest = await resolveMiniappTgAccount(moduleId, targetTgId);
      resolvedToAccountId = dest.accountId;
    } else if (isEvmAddress(to)) {
      resolvedToAccountId = userAccountId(normalizeAddress(to));
    } else {
      return res.status(400).json({ error: 'BAD_TO' });
    }

    const out = await applyLedgerEntryTx(db, col, {
      refId,
      kind: 'tg_transfer',
      chainId,
      token: String(resolved.token).toLowerCase(),
      moduleId,
      fromAccountId: who.accountId,
      toAccountId: resolvedToAccountId,
      amountRaw,
      meta: { source: 'tg-miniapp', tgId, to }
    });

    return res.json({ ok: true, refId, fromAccountId: who.accountId, toAccountId: resolvedToAccountId, symbol: resolved.symbol, decimals: resolved.decimals, entry: out.ledger });
  } catch (e: any) {
    const msg = String(e?.code || e?.message || 'LEDGER_ERROR');
    const status = Number(e?.statusCode || 400);
    return res.status(status).json({ error: msg });
  }
});

  // ---------------------
  // Wallet user views
  // ---------------------
  r.get('/me/balances', requireJwt, async (req: AuthedRequest, res) => {
    const address = req.user!.address;
    const accountId = userAccountId(address);
    const escId = escrowAccountId(accountId);

    const [mainBalances, escBalances] = await Promise.all([
      col.balances.find({ accountId }).toArray(),
      col.balances.find({ accountId: escId }).toArray()
    ]);

    const byKey = new Map<string, any>();

    for (const b of mainBalances) {
      const k = `${b.chainId}:${b.token}`;
      byKey.set(k, { chainId: b.chainId, token: b.token, availableRaw: b.balanceRaw, heldRaw: '0' });
    }
    for (const b of escBalances) {
      const k = `${b.chainId}:${b.token}`;
      const cur = byKey.get(k) || { chainId: b.chainId, token: b.token, availableRaw: '0', heldRaw: '0' };
      cur.heldRaw = b.balanceRaw;
      byKey.set(k, cur);
    }

    const items = Array.from(byKey.values())
      .map((x) => ({
        chainId: x.chainId,
        token: x.token,
        // backwards compatible:
        balanceRaw: x.availableRaw,
        availableRaw: x.availableRaw,
        heldRaw: x.heldRaw,
        totalRaw: (BigInt(x.availableRaw) + BigInt(x.heldRaw)).toString()
      }))
      .sort((a, b) => (a.chainId - b.chainId) || a.token.localeCompare(b.token));

    res.json({ ok: true, address, accountId, items });
  });

  // Withdraw quote (wallet-sign-per-withdraw). amount = GROSS debit (net + fee)
  r.post('/me/withdraw/quote', requireJwt, async (req: AuthedRequest, res) => {
    const chainId = Number(req.body?.chainId);
    const vaultId = String(req.body?.vaultId || '').trim();
    const debitRaw = String(req.body?.debitRaw || '').trim();
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });
    if (!/^[0-9]+$/.test(debitRaw)) return res.status(400).json({ error: 'BAD_AMOUNT' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    try {
      const { feeRaw, netRaw, bps } = calcFeeNet(debitRaw, Number((vault as any).withdrawFeeBps));
      res.json({ ok: true, chainId, vaultId, debitRaw, feeRaw, netRaw, bps });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message || 'BAD_AMOUNT') });
    }
  });

  // TypedData for wallet to sign (net amount is what leaves vault, debitRaw is gross)
  r.post('/me/withdraw/typedData', requireJwt, async (req: AuthedRequest, res) => {
    const ownerWallet = req.user!.address;
    const chainId = Number(req.body?.chainId);
    const vaultId = String(req.body?.vaultId || '').trim();

    const isNative = Boolean(req.body?.isNative || false);
    const token = normalizeAddress(String(req.body?.token || ''));
    const to = normalizeAddress(String(req.body?.to || ''));
    const debitRaw = String(req.body?.debitRaw || '').trim();
    const deadline = Number(req.body?.deadline || Math.floor(Date.now() / 1000) + 900);

    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });
    if (!isEvmAddress(to)) return res.status(400).json({ error: 'BAD_TO' });
    if (!/^[0-9]+$/.test(debitRaw)) return res.status(400).json({ error: 'BAD_AMOUNT' });
    if (!Number.isFinite(deadline) || deadline <= 0) return res.status(400).json({ error: 'BAD_DEADLINE' });
    if (!isNative && !isEvmAddress(token)) return res.status(400).json({ error: 'BAD_TOKEN' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    let feeRaw: string, netRaw: string, bps: number;
    try {
      ({ feeRaw, netRaw, bps } = calcFeeNet(debitRaw, Number((vault as any).withdrawFeeBps)));
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BAD_AMOUNT') });
    }

    const provider = new ethers.JsonRpcProvider(chain.rpcHttp);
    const domain = await getEip712Domain(vault.address, provider);
    const nonce = await getOwnerNonce(vault.address, provider, ownerWallet);

    const typed = isNative
      ? typedDataWithdrawNative(domain, {
          ownerWallet,
          to,
          amount: netRaw,
          nonce: nonce.toString(),
          deadline: String(deadline)
        })
      : typedDataWithdraw(domain, {
          ownerWallet,
          token,
          to,
          amount: netRaw,
          nonce: nonce.toString(),
          deadline: String(deadline)
        });

    res.json({
      ok: true,
      chainId,
      vaultId,
      vaultAddress: vault.address,
      ownerWallet,
      to,
      isNative,
      token: isNative ? undefined : token,
      debitRaw,
      feeRaw,
      netRaw,
      bps,
      deadline: String(deadline),
      typedData: typed
    });
  });

  r.get('/me/ledger', requireJwt, async (req: AuthedRequest, res) => {
    const address = req.user!.address;
    const accountId = userAccountId(address);
    const escId = escrowAccountId(accountId);
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const items = await col.ledger
      .find({
        $or: [
          { fromAccountId: accountId },
          { toAccountId: accountId },
          { fromAccountId: escId },
          { toAccountId: escId }
        ]
      })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();

    res.json({ ok: true, address, accountId, items });
  });

  // Client-side tx tracking (fast UI ack; indexer later marks as indexed)
  r.post('/me/tx/track', requireJwt, async (req: AuthedRequest, res) => {
    const address = req.user!.address;
    const accountId = userAccountId(address);
    const chainId = Number(req.body?.chainId);
    const txHash = String(req.body?.txHash || '').toLowerCase().trim();
    const kind = String(req.body?.kind || 'other') as any;
    const meta = (req.body?.meta && typeof req.body.meta === 'object') ? req.body.meta : undefined;

    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!/^0x[a-f0-9]{64}$/.test(txHash)) return res.status(400).json({ error: 'BAD_TXHASH' });

    const id = `${accountId}:${chainId}:${txHash}`;
    await col.txTracks.updateOne(
      { _id: id },
      {
        $setOnInsert: { _id: id, accountId, chainId, txHash, createdAt: new Date() },
        $set: { kind, meta, status: 'tracking', updatedAt: new Date() }
      },
      { upsert: true }
    );

    res.json({ ok: true, id, accountId, chainId, txHash });
  });

  r.get('/me/tx/status', requireJwt, async (req: AuthedRequest, res) => {
    const address = req.user!.address;
    const accountId = userAccountId(address);
    const chainId = Number(req.query.chainId);
    const txHash = String(req.query.txHash || '').toLowerCase().trim();

    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!/^0x[a-f0-9]{64}$/.test(txHash)) return res.status(400).json({ error: 'BAD_TXHASH' });

    const id = `${accountId}:${chainId}:${txHash}`;
    const track = await col.txTracks.findOne({ _id: id });
    const events = await col.events.find({ chainId, txHash }).sort({ logIndex: 1 }).limit(25).toArray();
    res.json({ ok: true, id, track, events });
  });

  // ---------------------
  // TG linking (2-step safe binding)
  // Step 1: Wallet confirms a TG code (creates a pending link)
  // Step 2: TG user approves inside Telegram (bot calls module endpoint to finalize)
  // ---------------------
  r.post('/me/tg/link/confirm', requireJwt, async (req: AuthedRequest, res) => {
    if (!enableTgLinking) return res.status(400).json({ error: 'FEATURE_DISABLED' });
    const ownerWallet = req.user!.address;
    const moduleId = String(req.body?.moduleId || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!moduleId || !code) return res.status(400).json({ error: 'BAD_PARAMS' });

    const now = new Date();
    const doc = await col.tgLinkCodes.findOne({ moduleId, code });
    if (!doc) return res.status(400).json({ error: 'BAD_CODE' });
    if (doc.expiresAt.getTime() < now.getTime()) return res.status(400).json({ error: 'CODE_EXPIRED' });

    // Mark this code as "wallet-confirmed" (pending TG approval)
    await col.tgLinkCodes.updateMany(
      { moduleId, tgId: doc.tgId },
      {
        $set: {
          ownerWallet: normalizeAddress(ownerWallet),
          status: 'wallet_confirmed',
          walletConfirmedAt: now
        }
      } as any
    );

    res.json({
      ok: true,
      pending: true,
      moduleId,
      tgId: doc.tgId,
      ownerWallet: normalizeAddress(ownerWallet),
      expiresAt: doc.expiresAt.toISOString(),
      next: 'Approve the link inside Telegram: /approve'
    });
  });

  // Wallet can check if it is linked (useful for UI)
  r.get('/me/tg/link/status', requireJwt, async (req: AuthedRequest, res) => {
    const ownerWallet = normalizeAddress(req.user!.address);
    const moduleId = String(req.query?.moduleId || '').trim() || 'tg';
    const links = await col.tgLinks
      .find({ moduleId, ownerWallet })
      .project({ _id: 1, moduleId: 1, tgId: 1, linkedAt: 1 })
      .limit(10)
      .toArray();
    res.json({ ok: true, moduleId, linked: links.length > 0, links });
  });


  // ---------------------
  // Session key setup (one-time wallet popups)
  // ---------------------
  r.post('/me/session/register/typedData', requireJwt, async (req: AuthedRequest, res) => {
    if (!enableTgSessWithdraw) return res.status(400).json({ error: 'FEATURE_DISABLED' });
    if (!sessionEncSecret) return res.status(500).json({ error: 'SESSION_KEY_ENC_SECRET_NOT_SET' });

    const ownerWallet = req.user!.address;
    const chainId = Number(req.body?.chainId);
    const vaultId = String(req.body?.vaultId || '').trim();
    const expirySeconds = Number(req.body?.expirySeconds || 86400 * 30); // 30 days
    const scopes = Number(req.body?.scopes || 1); // bitmask
    const deadline = Number(req.body?.deadline || Math.floor(Date.now() / 1000) + 900);

    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });
    if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) return res.status(400).json({ error: 'BAD_EXPIRY' });
    if (!Number.isFinite(scopes) || scopes <= 0) return res.status(400).json({ error: 'BAD_SCOPES' });
    if (!Number.isFinite(deadline) || deadline <= 0) return res.status(400).json({ error: 'BAD_DEADLINE' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    const provider = new ethers.JsonRpcProvider(chain.rpcHttp);
    const domain = await getEip712Domain(vault.address, provider);
    const nonce = await getOwnerNonce(vault.address, provider, ownerWallet);

    const sessionWallet = ethers.Wallet.createRandom();
    const sessionKey = sessionWallet.address;

    const newEpoch = await getNextSessionEpoch(vault.address, provider, ownerWallet, sessionKey);
    const expiry = Math.floor(Date.now() / 1000) + Math.floor(expirySeconds);

    // Store encrypted private key for later session-signing
    const encPriv = encryptBox(sessionEncSecret, sessionWallet.privateKey);
    await col.sessionKeys.updateOne(
      { _id: `${normalizeAddress(ownerWallet)}:${chainId}:${vaultId}` },
      {
        $set: {
          _id: `${normalizeAddress(ownerWallet)}:${chainId}:${vaultId}`,
          ownerWallet: normalizeAddress(ownerWallet),
          chainId,
          vaultId,
          vaultAddress: vault.address,
          sessionKey,
          encPriv,
          status: 'created',
          createdAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    const typed = typedDataRegisterSession(domain, {
      ownerWallet,
      sessionKey,
      newEpoch: newEpoch.toString(),
      expiry,
      scopes,
      nonce: nonce.toString(),
      deadline: String(deadline)
    });

    res.json({ ok: true, chainId, vaultId, vaultAddress: vault.address, sessionKey, expiry, scopes, typedData: typed });
  });

  r.post('/me/session/config/typedData', requireJwt, async (req: AuthedRequest, res) => {
    if (!enableTgSessWithdraw) return res.status(400).json({ error: 'FEATURE_DISABLED' });

    const ownerWallet = req.user!.address;
    const chainId = Number(req.body?.chainId);
    const vaultId = String(req.body?.vaultId || '').trim();
    const sessionKey = normalizeAddress(String(req.body?.sessionKey || ''));
    const deadline = Number(req.body?.deadline || Math.floor(Date.now() / 1000) + 900);

    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });
    if (!isEvmAddress(sessionKey)) return res.status(400).json({ error: 'BAD_SESSION_KEY' });
    if (!Number.isFinite(deadline) || deadline <= 0) return res.status(400).json({ error: 'BAD_DEADLINE' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    const limits = parseSessionLimits();
    const provider = new ethers.JsonRpcProvider(chain.rpcHttp);
    const domain = await getEip712Domain(vault.address, provider);
    const nonce = await getOwnerNonce(vault.address, provider, ownerWallet);

    const s = await getSessionState(vault.address, provider, ownerWallet, sessionKey);
    if (!s.enabled) return res.status(400).json({ error: 'SESSION_NOT_ACTIVE_ONCHAIN' });
    const epoch = s.epoch;

    const items: any[] = [];

    const addItem = (tokenKey: string, tokenAddrForSig: string) => {
      const lim = limits[tokenKey.toLowerCase()];
      if (!lim) return;
      items.push({
        tokenKey,
        token: tokenAddrForSig,
        allowed: true,
        maxPerTxRaw: lim.maxPerTxRaw,
        totalRaw: lim.maxTotalRaw,
        typedData: typedDataConfigSessionToken(domain, {
          ownerWallet,
          sessionKey,
          epoch: epoch.toString(),
          token: tokenAddrForSig,
          allowed: true,
          maxPerTx: lim.maxPerTxRaw,
          total: lim.maxTotalRaw,
          nonce: nonce.toString(),
          deadline: String(deadline)
        })
      });
    };

    // native rail uses tokenKey "native" and address(0) on-chain
    addItem('native', ethers.ZeroAddress);
    // wNative rail
    addItem(vault.wNative.toLowerCase(), vault.wNative);

    // ERC-20 tokens by address
    for (const t of chain.tokens.filter((x: any) => x.enabled)) {
      addItem(normalizeAddress(t.address), normalizeAddress(t.address));
    }

    res.json({ ok: true, chainId, vaultId, sessionKey, epoch: epoch.toString(), items });
  });

  // ---------------------
  // Admin: modules / treasuries
  // ---------------------
  r.post('/admin/modules/register', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    const moduleId = String(req.body?.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });

    const controllerAddress = normalizeAddress(String(req.body?.controllerAddress || ethers.ZeroAddress));
    const allowedTreasuries: string[] = Array.isArray(req.body?.allowedTreasuries) ? req.body.allowedTreasuries.map(String) : [];
    const scopes: string[] = Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : [];

    const apiKey = `yk_${ethers.hexlify(ethers.randomBytes(32)).slice(2)}`;
    const apiKeyHash = sha256Hex(apiKey);

    const now = new Date();
    await col.modules.updateOne(
      { _id: moduleId },
      {
        $set: {
          enabled: true,
          controllerAddress,
          apiKeyHash,
          allowedTreasuries,
          scopes,
          updatedAt: now,
          keyRotatedAt: now
        },
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );

    res.json({ ok: true, moduleId, apiKey, rotatedAt: now.toISOString() });
  });

  r.post('/admin/treasuries/create', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    const treasuryId = String(req.body?.treasuryId || '').trim();
    const moduleId = String(req.body?.moduleId || 'core').trim();
    const label = String(req.body?.label || treasuryId).trim();
    const chainId = Number(req.body?.chainId);
    const token = normalizeAddress(String(req.body?.token || ''));
    const enabled = req.body?.enabled == null ? true : Boolean(req.body.enabled);

    if (!treasuryId) return res.status(400).json({ error: 'BAD_TREASURY_ID' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!isEvmAddress(token)) return res.status(400).json({ error: 'BAD_TOKEN' });

    const exists = await col.treasuries.findOne({ _id: treasuryId });
    if (exists) return res.json({ ok: true, treasury: exists, created: false });

    const doc = {
      _id: treasuryId,
      moduleId,
      label,
      chainId,
      token,
      enabled,
      createdAt: new Date()
    };

    await col.treasuries.insertOne(doc as any);
    res.json({ ok: true, treasury: doc, created: true });
  });



  // ---------------------
  // Admin: blackjack
  // ---------------------

  r.get('/admin/blackjack/status', requireJwt, adminMw, async (_req: AuthedRequest, res) => {
    try {
      const chainId = 43113;

      const treasuryId = 'blackjack-43113-usdc';
      const treasuryAcc = treasuryAccountId(treasuryId);
      const feeTreasuryAcc = treasuryAccountId(String(process.env.FEE_TREASURY_ID || 'fees'));

      const activeHands = await col.blackjackHands.countDocuments({
        chainId,
        status: { $in: ['PLAYER_TURN', 'DEALER_TURN'] }
      } as any);

      const treasuryBal = await col.balances.findOne({
        accountId: treasuryAcc,
        chainId
      } as any);

      const token = String(treasuryBal?.token || '0x5425890298aed601595a70ab815c96711a31bc65').toLowerCase();
      const tok = resolveEnabledToken(cfg, chainId, token);

      const mod = await col.modules.findOne({ _id: 'blackjack' } as any);
      const treasuryDoc = await col.treasuries.findOne({ _id: treasuryId } as any);

      return res.json({
        ok: true,
        enabled: mod ? mod.enabled !== false : true,
        chainId,
        token,
        symbol: tok?.symbol || 'USDC',
        decimals: Number.isFinite(Number(tok?.decimals)) ? Number(tok?.decimals) : 6,
        treasuryId,
        treasuryAccountId: treasuryAcc,
        treasuryEnabled: treasuryDoc ? treasuryDoc.enabled !== false : true,
        feeTreasuryId: feeTreasuryAcc,
        activeHands
      });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_STATUS_FAILED') });
    }
  });

  r.get('/admin/blackjack/treasury', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    try {
      const chainId = Number(req.query?.chainId || 43113);
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });

      const treasuryId = 'blackjack-43113-usdc';
      const treasuryAcc = treasuryAccountId(treasuryId);
      const feeTreasuryAcc = treasuryAccountId(String(process.env.FEE_TREASURY_ID || 'fees'));

      const [treasuryBal, feeBal] = await Promise.all([
        col.balances.findOne({ accountId: treasuryAcc, chainId } as any),
        col.balances.findOne({
          accountId: feeTreasuryAcc,
          chainId,
          token: '0x5425890298aed601595a70ab815c96711a31bc65'
        } as any)
      ]);

      const token = String(
        treasuryBal?.token ||
        feeBal?.token ||
        '0x5425890298aed601595a70ab815c96711a31bc65'
      ).toLowerCase();

      const tok = resolveEnabledToken(cfg, chainId, token);
      const decimals = Number.isFinite(Number(tok?.decimals)) ? Number(tok?.decimals) : 6;
      const symbol = String(tok?.symbol || 'USDC');

      return res.json({
        ok: true,
        chainId,
        treasuryId,
        treasuryAccountId: treasuryAcc,
        treasuryBalanceRaw: String(treasuryBal?.balanceRaw || '0'),
        treasuryBalanceHuman: ethers.formatUnits(String(treasuryBal?.balanceRaw || '0'), decimals),
        feeTreasuryId: feeTreasuryAcc,
        feeBalanceRaw: String(feeBal?.balanceRaw || '0'),
        feeBalanceHuman: ethers.formatUnits(String(feeBal?.balanceRaw || '0'), decimals),
        token,
        symbol,
        decimals
      });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_TREASURY_FAILED') });
    }
  });

  r.get('/admin/blackjack/hands', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query?.limit || 10), 1), 100);

      const items = await col.blackjackHands
        .find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      return res.json({
        ok: true,
        items: items.map((x: any) => ({
          id: x._id,
          accountId: x.accountId,
          tgId: x.tgId || null,
          ownerWallet: x.ownerWallet || null,
          chainId: x.chainId,
          token: x.token,
          symbol: x.symbol || 'USDC',
          decimals: x.decimals ?? 6,
          betRaw: x.betRaw,
          doubled: !!x.doubled,
          status: x.status,
          payoutRaw: x.payoutRaw || '0',
          createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
          updatedAt: x.updatedAt instanceof Date ? x.updatedAt.toISOString() : x.updatedAt,
          resolvedAt: x.resolvedAt instanceof Date ? x.resolvedAt.toISOString() : (x.resolvedAt || null),
          clientRequestId: x.clientRequestId || null
        }))
      });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_HANDS_FAILED') });
    }
  });

  r.post('/admin/blackjack/enable', requireJwt, adminMw, async (_req: AuthedRequest, res) => {
    try {
      const now = new Date();

      await col.modules.updateOne(
        { _id: 'blackjack' } as any,
        {
          $setOnInsert: {
            _id: 'blackjack',
            createdAt: now
          },
          $set: {
            enabled: true,
            updatedAt: now
          }
        } as any,
        { upsert: true }
      );

      await col.treasuries.updateOne(
        { _id: 'blackjack-43113-usdc' } as any,
        {
          $set: {
            enabled: true,
            updatedAt: now
          }
        } as any
      );

      return res.json({ ok: true, enabled: true });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_ENABLE_FAILED') });
    }
  });

  r.post('/admin/blackjack/disable', requireJwt, adminMw, async (_req: AuthedRequest, res) => {
    try {
      const now = new Date();

      await col.modules.updateOne(
        { _id: 'blackjack' } as any,
        {
          $set: {
            enabled: false,
            updatedAt: now
          }
        } as any,
        { upsert: true }
      );

      await col.treasuries.updateOne(
        { _id: 'blackjack-43113-usdc' } as any,
        {
          $set: {
            enabled: false,
            updatedAt: now
          }
        } as any
      );

      return res.json({ ok: true, enabled: false });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_DISABLE_FAILED') });
    }
  });


  r.get('/modules/:moduleId/blackjack/admin/status', requireModule(col), async (req, res) => {
    try {
      const chainId = 43113;

      const treasuryId = 'blackjack-43113-usdc';
      const treasuryAcc = treasuryAccountId(treasuryId);
      const feeTreasuryAcc = treasuryAccountId(String(process.env.FEE_TREASURY_ID || 'fees'));

      const activeHands = await col.blackjackHands.countDocuments({
        chainId,
        status: { $in: ['PLAYER_TURN', 'DEALER_TURN'] }
      } as any);

      const treasuryBal = await col.balances.findOne({
        accountId: treasuryAcc,
        chainId
      } as any);

      const token = String(
        treasuryBal?.token || '0x5425890298aed601595a70ab815c96711a31bc65'
      ).toLowerCase();

      const tok = resolveEnabledToken(cfg, chainId, token);
      const mod = await col.modules.findOne({ _id: 'blackjack' } as any);
      const treasuryDoc = await col.treasuries.findOne({ _id: treasuryId } as any);

      return res.json({
        ok: true,
        enabled: mod ? mod.enabled !== false : true,
        chainId,
        token,
        symbol: tok?.symbol || 'USDC',
        decimals: Number.isFinite(Number(tok?.decimals)) ? Number(tok?.decimals) : 6,
        treasuryId,
        treasuryAccountId: treasuryAcc,
        treasuryEnabled: treasuryDoc ? treasuryDoc.enabled !== false : true,
        feeTreasuryId: feeTreasuryAcc,
        activeHands
      });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_STATUS_FAILED') });
    }
  });

  r.get('/modules/:moduleId/blackjack/admin/treasury', requireModule(col), async (req, res) => {
    try {
      const chainId = Number(req.query?.chainId || 43113);
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });

      const treasuryId = 'blackjack-43113-usdc';
      const treasuryAcc = treasuryAccountId(treasuryId);
      const feeTreasuryAcc = treasuryAccountId(String(process.env.FEE_TREASURY_ID || 'fees'));

      const [treasuryBal, feeBal] = await Promise.all([
        col.balances.findOne({ accountId: treasuryAcc, chainId } as any),
        col.balances.findOne({
          accountId: feeTreasuryAcc,
          chainId,
          token: '0x5425890298aed601595a70ab815c96711a31bc65'
        } as any)
      ]);

      const token = String(
        treasuryBal?.token ||
        feeBal?.token ||
        '0x5425890298aed601595a70ab815c96711a31bc65'
      ).toLowerCase();

      const tok = resolveEnabledToken(cfg, chainId, token);
      const decimals = Number.isFinite(Number(tok?.decimals)) ? Number(tok?.decimals) : 6;
      const symbol = String(tok?.symbol || 'USDC');

      return res.json({
        ok: true,
        chainId,
        treasuryId,
        treasuryAccountId: treasuryAcc,
        treasuryBalanceRaw: String(treasuryBal?.balanceRaw || '0'),
        treasuryBalanceHuman: ethers.formatUnits(String(treasuryBal?.balanceRaw || '0'), decimals),
        feeTreasuryId: feeTreasuryAcc,
        feeBalanceRaw: String(feeBal?.balanceRaw || '0'),
        feeBalanceHuman: ethers.formatUnits(String(feeBal?.balanceRaw || '0'), decimals),
        token,
        symbol,
        decimals
      });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_TREASURY_FAILED') });
    }
  });

  r.get('/modules/:moduleId/blackjack/admin/hands', requireModule(col), async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query?.limit || 10), 1), 100);

      const items = await col.blackjackHands
        .find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      return res.json({
        ok: true,
        items: items.map((x: any) => ({
          id: x._id,
          accountId: x.accountId,
          tgId: x.tgId || null,
          ownerWallet: x.ownerWallet || null,
          chainId: x.chainId,
          token: x.token,
          symbol: x.symbol || 'USDC',
          decimals: x.decimals ?? 6,
          betRaw: x.betRaw,
          doubled: !!x.doubled,
          status: x.status,
          payoutRaw: x.payoutRaw || '0',
          createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
          updatedAt: x.updatedAt instanceof Date ? x.updatedAt.toISOString() : x.updatedAt,
          resolvedAt: x.resolvedAt instanceof Date ? x.resolvedAt.toISOString() : (x.resolvedAt || null),
          clientRequestId: x.clientRequestId || null
        }))
      });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_HANDS_FAILED') });
    }
  });

  // ---------------------
  // Admin: fee sweep (session-key withdraw from fee treasury)
  // ---------------------

  r.post('/admin/fees/sweep/preview', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    const tokenFilter = Array.isArray(req.body?.tokenFilter)
      ? (req.body.tokenFilter as any[]).map((x) => String(x)).filter(Boolean)
      : undefined;

    const out = await sweepFeeTreasuryOnce({
      db,
      col,
      cfg,
      reason: 'admin_preview',
      tokenFilter,
      dryRun: true,
    });

    return res.json(out);
  });

  r.post('/admin/fees/sweep/run', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    const tokenFilter = Array.isArray(req.body?.tokenFilter)
      ? (req.body.tokenFilter as any[]).map((x) => String(x)).filter(Boolean)
      : undefined;

    const dryRun = Boolean(req.body?.dryRun);

    const out = await sweepFeeTreasuryOnce({
      db,
      col,
      cfg,
      reason: 'admin_manual',
      tokenFilter,
      dryRun,
    });

    return res.json(out);
  });


  // ---------------------
  // Admin: fees payout (internal credits) via X-Admin-Key
  // - Moves ALL balances in treasury `fees` to a target wallet's user account, across ALL enabled chains/tokens.
  // - No on-chain tx; ledger-only.
  // ---------------------

  function requireFeePayoutKey(req: any, res: any, next: any) {
    const need = String(process.env.FEE_PAYOUT_ADMIN_KEY || '').trim();
    if (!need) return res.status(500).json({ error: 'FEE_PAYOUT_ADMIN_KEY_NOT_SET' });

    const got = String(req.headers['x-admin-key'] || req.headers['x-admin_key'] || req.headers['x_admin_key'] || '').trim();
    if (!got || got !== need) return res.status(403).json({ error: 'BAD_ADMIN_KEY' });
    return next();
  }

  async function feesPayoutInternal(opts: { toWallet: string; dryRun: boolean; runId: string }) {
    const toWallet = normalizeAddress(opts.toWallet);
    const toAccountId = userAccountId(toWallet);
    const feeTreasuryId = String(process.env.FEE_TREASURY_ID || 'fees').trim() || 'fees';
    const fromAccountId = treasuryAccountId(feeTreasuryId);

    const enabledChains = (cfg.chains || []).filter((c: any) => !!c?.enabled);
    const moves: any[] = [];
    const skipped: any[] = [];

    for (const chain of enabledChains) {
      const chainId = Number(chain.chainId);
      const enabledTokens = (chain.tokens || []).filter((t: any) => !!t?.enabled).map((t: any) => normalizeAddress(String(t.address))).filter(Boolean);

      for (const tokenAddr of enabledTokens) {
        const token = tokenAddr.toLowerCase();

        const bal = await col.balances.findOne({ accountId: fromAccountId, chainId, token } as any);
        const raw = bal?.balanceRaw != null ? String(bal.balanceRaw) : '0';
        let amt = 0n;
        try { amt = BigInt(raw); } catch { amt = 0n; }

        if (amt <= 0n) {
          skipped.push({ chainId, token, amountRaw: raw });
          continue;
        }

        const refId = `fee_payout:${opts.runId}:${chainId}:${token}:${toWallet.toLowerCase()}`;

        if (opts.dryRun) {
          moves.push({ chainId, token, amountRaw: amt.toString(), refId, dryRun: true });
          continue;
        }

        try {
          const out = await applyLedgerEntryTx(db, col, {
            refId,
            kind: 'fee_payout',
            chainId,
            token,
            moduleId: 'fees',
            fromAccountId,
            toAccountId,
            amountRaw: amt.toString(),
            meta: { reason: 'fees_payout_internal', feeTreasuryId, toWallet }
          } as any);

          moves.push({ chainId, token, amountRaw: amt.toString(), refId, ok: true, ledgerId: out?.ledger?._id });
        } catch (e: any) {
          const msg = String(e?.message || e || 'UNKNOWN').slice(0, 300);
          // Idempotency: if already applied, treat as ok.
          if (msg.includes('DUPLICATE_REFID') || msg.includes('REFID_EXISTS')) {
            moves.push({ chainId, token, amountRaw: amt.toString(), refId, ok: true, already: true });
          } else {
            moves.push({ chainId, token, amountRaw: amt.toString(), refId, ok: false, error: msg });
          }
        }
      }
    }

    return {
      ok: true,
      dryRun: opts.dryRun,
      toWallet,
      toAccountId,
      fromAccountId,
      runId: opts.runId,
      moved: moves.filter((x) => x.ok || x.dryRun || x.already),
      errors: moves.filter((x) => x.ok === false),
      skippedCount: skipped.length,
      moveCount: moves.length
    };
  }

  r.post('/admin/fees/payout/preview', requireFeePayoutKey, async (req: any, res: any) => {
    const toWallet = String(req.body?.toWallet || process.env.FEE_PAYOUT_TO_WALLET || '').trim();
    if (!toWallet || !isEvmAddress(toWallet)) return res.status(400).json({ error: 'BAD_TO_WALLET' });

    const runIdIn = String(req.body?.runId || '').trim();
    const runId = runIdIn || new Date().toISOString().slice(0, 13).replace(/[:T]/g, '');

    const out = await feesPayoutInternal({ toWallet, dryRun: true, runId });
    return res.json(out);
  });

  r.post('/admin/fees/payout/run', requireFeePayoutKey, async (req: any, res: any) => {
    const toWallet = String(req.body?.toWallet || process.env.FEE_PAYOUT_TO_WALLET || '').trim();
    if (!toWallet || !isEvmAddress(toWallet)) return res.status(400).json({ error: 'BAD_TO_WALLET' });

    const runIdIn = String(req.body?.runId || '').trim();
    const runId = runIdIn || new Date().toISOString().slice(0, 13).replace(/[:T]/g, '');

    const out = await feesPayoutInternal({ toWallet, dryRun: false, runId });
    return res.json(out);
  });

// ---------------------
  // Admin: accounting (balances + ledger)
  // ---------------------

  function tokenMetaFor(chainId: number, token: string) {
    const chain = cfg.chains.find((c) => c.chainId === chainId);
    const t = chain?.tokens?.find((x: any) => normalizeAddress(x.address) === normalizeAddress(token));
    if (t) return { symbol: t.symbol, decimals: Number(t.decimals) };

    // Fallback for known vault rails (if token not in tokens list)
    const v = chain?.vaults?.[0];
    if (v?.usdc && normalizeAddress(v.usdc) === normalizeAddress(token)) return { symbol: 'USDC', decimals: 18 };
    if (v?.wNative && normalizeAddress(v.wNative) === normalizeAddress(token)) return { symbol: 'WBNB', decimals: 18 };

    return { symbol: token.slice(0, 6) + '...' + token.slice(-4), decimals: 18 };
  }

  // List balances by accountId or prefix (regex), optional chainId/token filters.
  r.get('/admin/accounting/balances', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    const accountId = String(req.query.accountId || '').trim();
    const prefix = String(req.query.prefix || '').trim(); // e.g. "treasury:" or "user:"
    const chainId = req.query.chainId != null ? Number(req.query.chainId) : null;
    const token = req.query.token != null ? normalizeAddress(String(req.query.token)) : null;
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 500)));
    const skip = Math.max(0, Number(req.query.skip || 0));

    const q: any = {};
    if (accountId) q.accountId = accountId;
    else if (prefix) q.accountId = { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };

    if (Number.isFinite(chainId as any)) q.chainId = chainId;
    if (token && isEvmAddress(token)) q.token = token;

    const rows = await col.balances
      .find(q)
      .sort({ accountId: 1, chainId: 1, token: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const out = rows.map((b) => {
      const meta = tokenMetaFor(b.chainId, b.token);
      return {
        accountId: b.accountId,
        chainId: b.chainId,
        token: b.token,
        symbol: meta.symbol,
        decimals: meta.decimals,
        balanceRaw: b.balanceRaw,
        updatedAt: b.updatedAt,
        createdAt: b.createdAt
      };
    });

    res.json({ ok: true, items: out, count: out.length, skip, limit });
  });

  // Ledger for an account (exact) or prefix; shows both inbound + outbound
  r.get('/admin/accounting/ledger', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    const accountId = String(req.query.accountId || '').trim();
    const prefix = String(req.query.prefix || '').trim();
    const chainId = req.query.chainId != null ? Number(req.query.chainId) : null;
    const token = req.query.token != null ? normalizeAddress(String(req.query.token)) : null;
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 200)));

    if (!accountId && !prefix) return res.status(400).json({ error: 'MISSING_ACCOUNT_FILTER' });

    const q: any = {};
    if (accountId) {
      q.$or = [{ fromAccountId: accountId }, { toAccountId: accountId }];
    } else {
      const rx = `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
      q.$or = [{ fromAccountId: { $regex: rx } }, { toAccountId: { $regex: rx } }];
    }

    if (Number.isFinite(chainId as any)) q.chainId = chainId;
    if (token && isEvmAddress(token)) q.token = token;

    const rows = await col.ledger.find(q).sort({ ts: -1 }).limit(limit).toArray();

    const out = rows.map((e) => {
      const meta = tokenMetaFor(e.chainId, e.token);
      return {
        refId: e.refId,
        ts: e.ts,
        kind: e.kind,
        chainId: e.chainId,
        token: e.token,
        symbol: meta.symbol,
        decimals: meta.decimals,
        amountRaw: e.amountRaw,
        fromAccountId: e.fromAccountId ?? null,
        toAccountId: e.toAccountId ?? null,
        moduleId: e.moduleId ?? null,
        meta: e.meta ?? null
      };
    });

    res.json({ ok: true, items: out, count: out.length, limit });
  });

  // ---------------------
  // Admin: solvency / on-chain reconciliation
  // Compares on-chain vault balances vs total credits in Mongo balances for each enabled token.
  // NOTE: "buckets" (treasuries/users/escrow) are OFF-CHAIN accounts; on-chain only holds the backing tokens.
  // ---------------------
  r.get('/admin/solvency/vault', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    const chainId = Number(req.query.chainId);
    const vaultId = String(req.query.vaultId || '').trim();
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    // Token list comes from indexer events (vaultTokens) + always include vault.wNative.
    const vt = await col.vaultTokens
      .find({ chainId, vaultId, enabled: true })
      .project({ token: 1, decimals: 1 })
      .sort({ token: 1 })
      .toArray();

    const tokenSet = new Map<string, { token: string; decimals: number }>();
    for (const t of vt) {
      const token = normalizeAddress(String((t as any).token || ''));
      if (!isEvmAddress(token)) continue;
      tokenSet.set(token, { token, decimals: Number((t as any).decimals || 18) });
    }

    // ensure wNative present
    if (isEvmAddress(String(vault.wNative || ''))) {
      const w = normalizeAddress(String(vault.wNative));
      if (!tokenSet.has(w)) tokenSet.set(w, { token: w, decimals: 18 });
    }

    const provider = new ethers.JsonRpcProvider(chain.rpcHttp);
    const vaultAddress = normalizeAddress(String(vault.address));

    const items: any[] = [];

    for (const { token } of tokenSet.values()) {
      // On-chain balance
      let onChainRaw = '0';
      try {
        const c = new ethers.Contract(token, ERC20_BALANCE_ABI, provider);
        const bal = await c.balanceOf(vaultAddress);
        onChainRaw = bal.toString();
      } catch (e: any) {
        items.push({ token, error: `RPC_ERROR:${String(e?.message || e)}` });
        continue;
      }

      // Total credits in Mongo for this chain/token across ALL accounts (users/treasuries/escrow)
      let ledgerTotal = 0n;
      const cur = col.balances
        .find({ chainId, token: token.toLowerCase() })
        .project({ balanceRaw: 1 })
        .batchSize(1000);

      for await (const b of cur as any) {
        const v = String((b as any).balanceRaw || '0');
        if (/^[0-9]+$/.test(v)) ledgerTotal += BigInt(v);
      }

      const onChain = BigInt(onChainRaw);
      const delta = onChain - ledgerTotal;

      items.push({
        token,
        onChainRaw,
        ledgerTotalRaw: ledgerTotal.toString(),
        deltaRaw: delta.toString(),
        solvent: delta >= 0n
      });
    }

    res.json({ ok: true, chainId, vaultId, vaultAddress, items });
  });


  // ---------------------
  // Module credits API
  // ---------------------
  r.post('/modules/:moduleId/ledger/transfer', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const fromAccountId = String(req.body?.fromAccountId || '').trim();
    const toAccountId = String(req.body?.toAccountId || '').trim();
    const chainId = Number(req.body?.chainId);
    const token = normalizeAddress(String(req.body?.token || ''));
    const debitRaw = String(req.body?.debitRaw || req.body?.amountRaw || '').trim();
    const refId = String(req.body?.refId || '').trim();
    const kind = String(req.body?.kind || 'transfer').trim();
    const reason = String(req.body?.reason || 'module_transfer');
    const meta = req.body?.meta;

    if (!refId) return res.status(400).json({ error: 'MISSING_REFID' });
    if (!fromAccountId || !toAccountId) return res.status(400).json({ error: 'BAD_ACCOUNTS' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!isEvmAddress(token)) return res.status(400).json({ error: 'BAD_TOKEN' });
    if (!/^[0-9]+$/.test(debitRaw)) return res.status(400).json({ error: 'BAD_AMOUNT' });

    // Enforce treasury scoping for this module
    const allowedTreasuries = new Set((req.moduleDoc?.allowedTreasuries || []).map(String));
    const touched = [fromAccountId, toAccountId]
      .filter((a) => a.startsWith('treasury:'))
      .map((a) => a.slice('treasury:'.length));

    for (const t of touched) {
      if (!allowedTreasuries.has(t)) return res.status(403).json({ error: 'TREASURY_NOT_ALLOWED' });
    }

    try {
      const out = await applyLedgerEntryTx(db, col, {
        refId,
        kind,
        chainId,
        token,
        moduleId,
        fromAccountId,
        toAccountId,
        amountRaw: debitRaw,
        meta: { ...meta, reason }
      });
      res.json({ ok: true, entry: out.ledger });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || 'FAILED' });
    }
  });

  // ---------------------
  // TG module helpers (link + session withdrawals)
  // ---------------------
  // ---------------------
  // Dice module (optional)
  // ---------------------
  if (String(process.env.ENABLE_GAME_DICE || '').trim() === '1') {
    registerDiceCoreRoutes({
      r,
      db,
      col,
      cfg,
      requireModuleMw: requireModule,
      requireJwtMw: requireJwt,
      applyLedgerEntry
    });
  }

  if (String(process.env.ENABLE_GAME_LOTTERY || '').trim() === '1') {
    registerLotteryCoreRoutes({
      r,
      db,
      col,
      cfg,
      requireModuleMw: requireModule,
      applyLedgerEntry: async (opts: any) => {
        return await applyLedgerEntryTx(db, col, {
          refId: opts.refId,
          kind: opts.kind,
          chainId: Number(opts.chainId),
          token: String(opts.token),
          moduleId: String(opts?.meta?.moduleId || 'lottery'),
          fromAccountId: String(opts.fromAccountId),
          toAccountId: String(opts.toAccountId),
          amountRaw: String(opts.amountRaw),
          meta: opts.meta || {}
        });
      }
    });
  }
  if (String(process.env.ENABLE_GAME_WHACK || '').trim() === '1') {
    registerWhackCoreRoutes({
      r,
      db,
      col,
      cfg,
      requireModuleMw: requireModule,
      applyLedgerEntry: async (opts: any) => {
        return await applyLedgerEntryTx(db, col, opts);
      }
    });
  }

  if (String(process.env.ENABLE_GAME_BLACKJACK || '').trim() === '1') {
    registerBlackjackCoreRoutes({
      r,
      db,
      col,
      cfg,
      requireJwtMw: requireJwt,
      requireTgJwtMw: requireTgJwt,
      applyLedgerEntryTx: async (db2: any, col2: any, opts: any) => {
        return await applyLedgerEntryTx(db2, col2, opts);
      }
    });
  }

  r.post('/modules/:moduleId/tg/link/request', requireModule(col), async (req: AuthedRequest, res) => {
    if (!enableTgLinking) return res.status(400).json({ error: 'FEATURE_DISABLED' });

    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });

    const ttlSeconds = Number(process.env.TG_LINK_CODE_TTL_SECONDS || 600);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await col.tgLinkCodes.deleteMany({ moduleId, tgId });
    await col.tgLinkCodes.insertOne({
      _id: randomId(16),
      moduleId,
      tgId,
      code,
      expiresAt,
      createdAt: new Date()
    } as any);

    res.json({ ok: true, moduleId, tgId, code, expiresAt: expiresAt.toISOString() });
  })
  // ---------------------
  // TG linking: bot checks pending wallet-confirmation for this TG user
  // ---------------------
  r.post('/modules/:moduleId/tg/link/pending', requireModule(col), async (req: AuthedRequest, res) => {
    if (!enableTgLinking) return res.status(400).json({ error: 'FEATURE_DISABLED' });

    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });

    const now = new Date();
    const doc = await col.tgLinkCodes
      .find({ moduleId, tgId, status: 'wallet_confirmed', expiresAt: { $gt: now } } as any)
      .sort({ createdAt: -1 })
      .limit(1)
      .next();

    if (!doc || !doc.ownerWallet) return res.json({ ok: true, pending: false });

    res.json({
      ok: true,
      pending: true,
      moduleId,
      tgId,
      code: doc.code,
      ownerWallet: doc.ownerWallet,
      expiresAt: doc.expiresAt.toISOString()
    });
  });

  // Finalize link after TG user approval (called by TG bot)
  r.post('/modules/:moduleId/tg/link/approve', requireModule(col), async (req: AuthedRequest, res) => {
    if (!enableTgLinking) return res.status(400).json({ error: 'FEATURE_DISABLED' });

    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!tgId || !code) return res.status(400).json({ error: 'BAD_PARAMS' });

    const now = new Date();
    const doc = await col.tgLinkCodes.findOne({ moduleId, tgId, code });
    if (!doc) return res.status(400).json({ error: 'BAD_CODE' });
    if (doc.expiresAt.getTime() < now.getTime()) return res.status(400).json({ error: 'CODE_EXPIRED' });
    if (!doc.ownerWallet) return res.status(400).json({ error: 'WALLET_NOT_CONFIRMED' });

    const ownerWallet = normalizeAddress(doc.ownerWallet);
    const key = { _id: `${moduleId}:tg:${tgId}` };
    await col.tgLinks.updateOne(
      key,
      { $set: { _id: key._id, moduleId, tgId, ownerWallet, linkedAt: now } },
      { upsert: true }
    );

    await col.tgLinkCodes.deleteMany({ moduleId, tgId });

    // Merge any pre-link tips held on tg:<moduleId>:<tgId> into the linked user account.
    // This keeps "tips before registration" intact after the user links their wallet.
    try {
      const tgHoldAcc = tgAccountId(moduleId, tgId);
      const userAcc = `user:${ownerWallet}`;
      const holds = await col.balances.find({ accountId: tgHoldAcc }).toArray();

      for (const b of holds) {
        const balRaw = String((b as any).balanceRaw || '0');
        let amt = 0n;
        try {
          amt = BigInt(balRaw);
        } catch {
          amt = 0n;
        }
        if (amt <= 0n) continue;

        const mergeRefId = `tg-merge:${moduleId}:${tgId}:${Number((b as any).chainId)}:${String((b as any).token || '').toLowerCase()}`;
        await applyLedgerEntryTx(db, col, {
          refId: mergeRefId,
          kind: 'tg_merge',
          chainId: Number((b as any).chainId),
          token: String((b as any).token || '').toLowerCase(),
          amountRaw: amt.toString(),
          fromAccountId: tgHoldAcc,
          toAccountId: userAcc,
          meta: { moduleId, tgId }
        } as any);
      }
    } catch {
      // ignore merge failures (link should still succeed)
    }

    res.json({ ok: true, moduleId, tgId, ownerWallet });
  });

  // Cancel pending codes (called by TG bot)
  r.post('/modules/:moduleId/tg/link/cancel', requireModule(col), async (req: AuthedRequest, res) => {
    if (!enableTgLinking) return res.status(400).json({ error: 'FEATURE_DISABLED' });

    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });

    await col.tgLinkCodes.deleteMany({ moduleId, tgId });
    res.json({ ok: true });
  });

  // ---------------------
  // TG welcome message (admin sets; bot shows once)
  // ---------------------
  r.post('/modules/:moduleId/tg/welcome/set', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const text = req.body?.text;
    const photoFileId = req.body?.photoFileId;

    const update: any = { updatedAt: new Date(), moduleId, _id: moduleId };
    if (typeof text === 'string') update.text = text;
    if (typeof photoFileId === 'string') update.photoFileId = photoFileId;

    await col.tgWelcome.updateOne({ _id: moduleId }, { $set: update }, { upsert: true });
    return res.json({ ok: true });
  });

  r.post('/modules/:moduleId/tg/welcome/get', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const doc: any = await col.tgWelcome.findOne({ _id: moduleId });
    return res.json({ ok: true, text: doc?.text || '', photoFileId: doc?.photoFileId || '' });
  });

  // ---------------------
  // TG maintenance mode (admin toggles; bot enforces)
  // ---------------------
  r.post('/modules/:moduleId/tg/maintenance/get', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ ok: false, error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ ok: false, error: 'MODULE_ID_MISMATCH' });

    const doc: any = await col.tgMaintenance.findOne({ _id: moduleId });
    return res.json({ ok: true, enabled: !!doc?.enabled });
  });

  r.post('/modules/:moduleId/tg/maintenance/set', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ ok: false, error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ ok: false, error: 'MODULE_ID_MISMATCH' });

    const enabled = !!req.body?.enabled;
    const updatedByTgId = String(req.body?.updatedByTgId || '').trim() || null;

    await col.tgMaintenance.updateOne(
      { _id: moduleId },
      { $set: { _id: moduleId, moduleId, enabled, updatedAt: new Date(), updatedByTgId } },
      { upsert: true }
    );
    return res.json({ ok: true, enabled });
  });

  // ----------
  // TG: SUCCESS MEDIA (tip/rain/monsoon)
  // ----------
  r.post('/modules/:moduleId/tg/success_media/set', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ ok: false, error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ ok: false, error: 'MODULE_ID_MISMATCH' });

    const keyRaw = String(req.body?.key || '').trim().toLowerCase();
    const allowedKeys = ['tip', 'rain', 'monsoon'] as const;
    type SuccessMediaKey = typeof allowedKeys[number];
    const isSuccessMediaKey = (v: string): v is SuccessMediaKey => (allowedKeys as readonly string[]).includes(v);
    if (!isSuccessMediaKey(keyRaw)) return res.status(400).json({ ok: false, error: 'BAD_KEY' });
    const key: SuccessMediaKey = keyRaw;

    const kindRaw = req.body?.kind;
    const fileIdRaw = req.body?.fileId;

    let kind: 'photo' | 'video' | 'animation' | null = null;
    if (kindRaw === null || kindRaw === undefined || kindRaw === '') kind = null;
    else if (kindRaw === 'photo' || kindRaw === 'video' || kindRaw === 'animation') kind = kindRaw;
    else return res.status(400).json({ ok: false, error: 'BAD_KIND' });

    let fileId: string | null = null;
    if (fileIdRaw === null || fileIdRaw === undefined || fileIdRaw === '') fileId = null;
    else fileId = String(fileIdRaw).trim();

    const _id = `${moduleId}:${key}`;
    await col.tgSuccessMedia.updateOne(
      { _id },
      { $set: { _id, moduleId, key, kind, fileId, updatedAt: new Date() } },
      { upsert: true }
    );

    return res.json({ ok: true });
  });

  r.post('/modules/:moduleId/tg/success_media/get', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ ok: false, error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ ok: false, error: 'MODULE_ID_MISMATCH' });

    const keyRaw = String(req.body?.key || '').trim().toLowerCase();
    const allowedKeys = ['tip', 'rain', 'monsoon'] as const;
    type SuccessMediaKey = typeof allowedKeys[number];
    const isSuccessMediaKey = (v: string): v is SuccessMediaKey => (allowedKeys as readonly string[]).includes(v);
    if (!isSuccessMediaKey(keyRaw)) return res.status(400).json({ ok: false, error: 'BAD_KEY' });
    const key: SuccessMediaKey = keyRaw;

    const doc: any = await col.tgSuccessMedia.findOne({ _id: `${moduleId}:${key}` });
    return res.json({ ok: true, key, kind: doc?.kind || null, fileId: doc?.fileId || '' });
  });

  r.post('/modules/:moduleId/tg/welcome/show', requireModule(col), async (req, res) => {
    try {
      const moduleId = String(req.params.moduleId || '').trim();
      const tgId = String(req.body?.tgId || '').trim();
      if (!tgId) return res.status(400).json({ error: 'MISSING_TG_ID' });

      const welcome = await col.tgWelcome.findOne({ _id: moduleId });
      const text = String(welcome?.text || '').trim();
      const photoFileId = String(welcome?.photoFileId || '').trim();
      if (!text && !photoFileId) return res.json({ show: false });

      const seenId = `${moduleId}:tg:${tgId}`;
      const seen = await col.tgWelcomeSeen.findOne({ _id: seenId });

      // Show if never seen OR welcome was updated after last seen.
      const updatedAt = (welcome as any)?.updatedAt instanceof Date ? (welcome as any).updatedAt : null;
      const shouldShow = !seen || (seen?.seenAt && updatedAt && seen.seenAt < updatedAt);
      if (!shouldShow) return res.json({ show: false });

      await col.tgWelcomeSeen.updateOne(
        { _id: seenId },
        { $set: { _id: seenId, moduleId, tgId, seenAt: new Date() } },
        { upsert: true }
      );

      return res.json({ show: true, text, photoFileId });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'SERVER_ERROR' });
    }
  });

  // ---------------------
  // TG seen-users (for pre-link tipping by @username)
  // ---------------------
  r.post('/modules/:moduleId/tg/seen/touch', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });

    const username = String(req.body?.username || '').trim();
    const firstName = String(req.body?.firstName || '').trim();
    const lastName = String(req.body?.lastName || '').trim();
    const chatType = String(req.body?.chatType || '').trim();

    const docId = `${moduleId}:tg:${tgId}`;
    const now = new Date();
    await col.tgSeenUsers.updateOne(
      { _id: docId },
      {
        $set: {
          _id: docId,
          moduleId,
          tgId,
          username: username || null,
          usernameLower: username ? normalizeUsername(username) : null,
          firstName: firstName || null,
          lastName: lastName || null,
          chatType: chatType || null,
          lastSeenAt: now
        }
      },
      { upsert: true }
    );
    return res.json({ ok: true });
  });

  r.post('/modules/:moduleId/tg/seen/resolve', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const q = String(req.body?.q || '').trim();
    if (!q) return res.status(400).json({ error: 'BAD_QUERY' });

    const tgId = q.replace(/^tg:/i, '').trim();
    let doc: any = null;
    if (/^[0-9]{3,}$/.test(tgId)) {
      doc = await col.tgSeenUsers.findOne({ _id: `${moduleId}:tg:${tgId}` });
    }
    if (!doc) {
      const uname = normalizeUsername(q);
      if (uname) doc = await col.tgSeenUsers.findOne({ moduleId, usernameLower: uname });
    }

    if (!doc) return res.json({ ok: true, found: false });
    return res.json({ ok: true, found: true, tgId: doc.tgId, username: doc.username || '' });
  });

  r.post('/modules/:moduleId/tg/seen/list', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const limit = Math.max(1, Math.min(200, Number(req.body?.limit || 50)));
    const rows = await col.tgSeenUsers
      .find({ moduleId }, { projection: { _id: 0, tgId: 1, username: 1, firstName: 1, lastName: 1, chatType: 1, lastSeenAt: 1 } })
      .sort({ lastSeenAt: -1 })
      .limit(limit)
      .toArray();

    return res.json({ ok: true, items: rows });
  });

  // ---------------------
  // TG chat activity (for /rain and /monsoon)
  // ---------------------
  r.post('/modules/:moduleId/tg/activity/log', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    const chatId = String(req.body?.chatId || '').trim();
    const messageId = String(req.body?.messageId || '').trim();
    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });
    if (!chatId) return res.status(400).json({ error: 'BAD_CHAT' });
    if (!messageId) return res.status(400).json({ error: 'BAD_MESSAGE' });

    const chatType = String(req.body?.chatType || '').trim();
    const username = String(req.body?.username || '').trim();
    const msgType = String(req.body?.msgType || '').trim();
    const textLower = String(req.body?.textLower || '').trim();

    const ts = (() => {
      const v = req.body?.ts;
      if (v) {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) return d;
      }
      return new Date();
    })();

    const _id = `${moduleId}:${chatId}:${messageId}`;
    await col.tgChatActivity.updateOne(
      { _id },
      {
        $set: {
          _id,
          moduleId,
          chatId,
          chatType: chatType || null,
          messageId,
          tgId,
          username: username || null,
          ts,
          msgType: msgType || null,
          textLower: textLower || null
        }
      },
      { upsert: true }
    );

    return res.json({ ok: true });
  });

  r.post('/modules/:moduleId/tg/activity/list', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const chatId = String(req.body?.chatId || '').trim();
    if (!chatId) return res.status(400).json({ error: 'BAD_CHAT' });

    const sinceMs = req.body?.sinceMs != null ? Number(req.body.sinceMs) : 0;
    const limit = Math.max(1, Math.min(5000, Number(req.body?.limit || 500)));

    const q: any = { moduleId, chatId };
    if (Number.isFinite(sinceMs) && sinceMs > 0) {
      q.ts = { $gte: new Date(sinceMs) };
    }

    const items = await col.tgChatActivity
      .find(q, { projection: { _id: 0, tgId: 1, username: 1, ts: 1, msgType: 1, messageId: 1 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();

    return res.json({ ok: true, items });
  });

  // ---------------------
  // TG DM notify outbox
  // ---------------------
  r.post('/modules/:moduleId/tg/alerts/get', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });

    const pref = await col.tgAlertPrefs.findOne({ _id: `${moduleId}:tg:${tgId}` } as any);
    const enabled = pref ? !!(pref as any).enabled : true; // default ON
    return res.json({ ok: true, enabled });
  });

  r.post('/modules/:moduleId/tg/alerts/set', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });

    const enabled = !!req.body?.enabled;
    const _id = `${moduleId}:tg:${tgId}`;
    const now = new Date();
    await col.tgAlertPrefs.updateOne(
      { _id } as any,
      { $set: { _id, moduleId, tgId, enabled, updatedAt: now } },
      { upsert: true }
    );

    // If disabling alerts, clear any pending notifications so the user doesn't get a backlog later.
    if (!enabled) {
      await col.tgNotifyOutbox.updateMany(
        { moduleId, tgId, status: 'pending' } as any,
        { $set: { status: 'sent', sentAt: now, updatedAt: now, 'meta.suppressed': true } as any }
      );
    }

    return res.json({ ok: true, enabled });
  });

  r.post('/modules/:moduleId/tg/notify/pull', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const limit = Math.max(1, Math.min(50, Number(req.body?.limit || 20)));

    function shortAddr(addr: string): string {
      const a = String(addr || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return addr;
      return `${a.slice(0, 6)}…${a.slice(-4)}`;
    }

    async function alertsEnabledFor(tgId: string): Promise<boolean> {
      const pref = await col.tgAlertPrefs.findOne({ _id: `${moduleId}:tg:${tgId}` } as any);
      return pref ? !!(pref as any).enabled : true;
    }

    async function resolveSenderLabel(item: any): Promise<string> {
      const meta = item?.meta || {};
      const senderTgId = String(meta?.tgId || '').trim();
      if (senderTgId) {
        const seen = await col.tgSeenUsers.findOne({ _id: `${moduleId}:tg:${senderTgId}` } as any);
        const uname = String((seen as any)?.username || '').trim();
        const first = String((seen as any)?.firstName || '').trim();
        const last = String((seen as any)?.lastName || '').trim();
        if (uname) return `@${uname.replace(/^@/, '')}`;
        const full = `${first} ${last}`.trim();
        return full || `tg:${senderTgId}`;
      }

      const fromAcc = String(item?.fromAccountId || '').trim();
      if (fromAcc.startsWith('treasury:')) return fromAcc.slice('treasury:'.length);
      if (fromAcc.startsWith('user:')) return shortAddr(fromAcc.slice('user:'.length));
      if (fromAcc.startsWith('tg:')) {
        const parts = fromAcc.split(':');
        const tid = String(parts[2] || '').trim();
        const seen = tid ? await col.tgSeenUsers.findOne({ _id: `${moduleId}:tg:${tid}` } as any) : null;
        const uname = String((seen as any)?.username || '').trim();
        if (uname) return `@${uname.replace(/^@/, '')}`;
        return tid ? `tg:${tid}` : 'telegram';
      }

      const mid = String(item?.moduleId || '').trim();
      return mid || 'system';
    }

    // Fetch a bit more than needed so filtering doesn't return empty too often.
    const raw = await col.tgNotifyOutbox
      .find({ moduleId, status: 'pending' }, { sort: { createdAt: 1 }, limit: Math.min(200, limit * 10) })
      .toArray();

    const out: any[] = [];
    for (const it of raw) {
      const tgId = String((it as any)?.tgId || '').trim();
      if (!tgId) continue;

      if (!(await alertsEnabledFor(tgId))) continue;

      const chainId = Number((it as any).chainId);
      const tokenAddr = String((it as any).token || '').trim();
      const resolved = resolveEnabledToken(cfg, chainId, tokenAddr);
      const decimals = resolved && (resolved as any).decimals != null ? Number((resolved as any).decimals) : 18;
      const symbol = resolved && (resolved as any).symbol ? String((resolved as any).symbol) : '';

      out.push({
        ...it,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        senderLabel: await resolveSenderLabel(it)
      });

      if (out.length >= limit) break;
    }

    return res.json({ ok: true, items: out });
  });

  r.post('/modules/:moduleId/tg/notify/ack', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x: any) => String(x || '').trim()).filter(Boolean) : [];
    if (!ids.length) return res.json({ ok: true, updated: 0 });

    const now = new Date();
    const r2 = await col.tgNotifyOutbox.updateMany(
      { _id: { $in: ids }, moduleId },
      { $set: { status: 'sent', sentAt: now, updatedAt: now } }
    );

    return res.json({ ok: true, updated: r2.modifiedCount || 0 });
  });

  r.post('/modules/:moduleId/tg/token/resolve', requireModule(col), async (req, res) => {
    try {
      const chainId = Number(req.body?.chainId);
      const asset = String(req.body?.asset || '').trim();
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });
      if (!asset) return res.status(400).json({ error: 'MISSING_ASSET' });

      const out = resolveEnabledToken(cfg, chainId, asset);
      if (!out) return res.status(404).json({ enabled: false });
      return res.json(out);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'SERVER_ERROR' });
    }
  });

  // ---------------------
  // TG balances for a linked TG account (called by TG bot)
  // ---------------------
  r.post('/modules/:moduleId/tg/balances', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    const chainId = Number(req.body?.chainId);
    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });

    const link = await col.tgLinks.findOne({ _id: `${moduleId}:tg:${tgId}` });

    let ownerWallet = '';
    let accountId = '';
    if (link?.ownerWallet) {
      ownerWallet = String(link.ownerWallet);
      accountId = userAccountId(ownerWallet);
    } else {
      // Unlinked TG users can still hold credits directly under their telegram account.
      accountId = tgAccountId("tg", String(tgId));
    }

    const bals = await col.balances.find({ accountId, chainId }).limit(200).toArray();

    const chain = cfg.chains.find((c) => c.chainId === chainId && c.enabled);
    const tokenMeta = new Map<string, any>();
    (chain?.tokens || []).forEach((t) => tokenMeta.set(normalizeAddress(t.address), t));

    const out = bals.map((b) => {
      const meta = tokenMeta.get(normalizeAddress(b.token));
      return {
        token: normalizeAddress(b.token),
        symbol: meta?.symbol || b.token.slice(0, 6),
        decimals: meta?.decimals ?? 18,
        enabled: meta?.enabled ?? false,
        balanceRaw: b.balanceRaw
      };
    });

    res.json({ ok: true, linked: !!link, ownerWallet: ownerWallet || null, balances: out });
  });

  // ---------------------
  // TG spend: transfer credits from linked wallet account (called by TG bot)
  // ---------------------

  // List module treasuries + balances (admin-only enforced by TG bot via TG_ADMIN_IDS)
  r.post('/modules/:moduleId/tg/treasuries/list', requireModule(col), async (req, res) => {
    try {
      const moduleId = String(req.params.moduleId || '').trim();
      const chainId = Number(req.body?.chainId);
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });
// ---------------------
// TG success media (optional media attached to success messages; configured via /mainadmin)
// ---------------------
r.post('/modules/:moduleId/tg/success_media/get', requireModule(col), async (req: AuthedRequest, res) => {
  const moduleId = String(req.params.moduleId || '').trim();
  if (!moduleId) return res.status(400).json({ ok: false, error: 'BAD_MODULE_ID' });
  if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ ok: false, error: 'MODULE_ID_MISMATCH' });

  const keyRaw = String(req.body?.key || '').trim().toLowerCase();
  const allowedKeys = ['tip', 'rain', 'monsoon'] as const;
  type SuccessMediaKey = typeof allowedKeys[number];
  const isSuccessMediaKey = (v: string): v is SuccessMediaKey => (allowedKeys as readonly string[]).includes(v);
  if (!isSuccessMediaKey(keyRaw)) return res.status(400).json({ ok: false, error: 'BAD_KEY' });
  const key: SuccessMediaKey = keyRaw;

  const doc = await col.tgSuccessMedia.findOne({ moduleId, key });
  return res.json({ ok: true, data: doc || { moduleId, key, kind: null, fileId: null } });
});

r.post('/modules/:moduleId/tg/success_media/set', requireModule(col), async (req: AuthedRequest, res) => {
  const moduleId = String(req.params.moduleId || '').trim();
  if (!moduleId) return res.status(400).json({ ok: false, error: 'BAD_MODULE_ID' });
  if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ ok: false, error: 'MODULE_ID_MISMATCH' });

  const keyRaw = String(req.body?.key || '').trim().toLowerCase();
  const allowedKeys = ['tip', 'rain', 'monsoon'] as const;
  type SuccessMediaKey = typeof allowedKeys[number];
  const isSuccessMediaKey = (v: string): v is SuccessMediaKey => (allowedKeys as readonly string[]).includes(v);
  if (!isSuccessMediaKey(keyRaw)) return res.status(400).json({ ok: false, error: 'BAD_KEY' });
  const key: SuccessMediaKey = keyRaw;

  const kindRaw = req.body?.kind;
  const allowedKinds = ['photo', 'video', 'animation'] as const;
  type SuccessMediaKind = typeof allowedKinds[number] | null;
  const isSuccessMediaKind = (v: string): v is Exclude<SuccessMediaKind, null> => (allowedKinds as readonly string[]).includes(v);

  const kind: SuccessMediaKind =
    kindRaw === null || kindRaw === undefined || String(kindRaw) === '' ? null :
    isSuccessMediaKind(String(kindRaw)) ? (String(kindRaw) as any) : null;

  const fileIdRaw = req.body?.fileId;
  const fileId: string | null =
    fileIdRaw === null || fileIdRaw === undefined || String(fileIdRaw) === '' ? null : String(fileIdRaw);

  if (kind && !fileId) return res.status(400).json({ ok: false, error: 'MISSING_FILEID' });

  await col.tgSuccessMedia.updateOne(
    { moduleId, key },
    { $set: { moduleId, key, kind, fileId, updatedAt: new Date() } },
    { upsert: true }
  );

  const doc = await col.tgSuccessMedia.findOne({ moduleId, key });
  return res.json({ ok: true, data: doc });
});



      const mod = await col.modules.findOne({ _id: moduleId });
      if (!mod) return res.status(404).json({ error: 'MODULE_NOT_FOUND' });

      const allowed: string[] = Array.isArray((mod as any).allowedTreasuries) ? (mod as any).allowedTreasuries : [];
      if (!allowed.length) return res.json({ moduleId, chainId, treasuries: [], tokens: [] });

      const treasuries = await col.treasuries
        .find({ treasuryId: { $in: allowed }, chainId })
        .sort({ treasuryId: 1 })
        .toArray();

      const treasuryAccountIds = treasuries.map((t: any) => `treasury:${t.treasuryId}`);
      const balances = await col.balances.find({ accountId: { $in: treasuryAccountIds } }).toArray();

      const tokenRows = cfg.chains.find((c: any) => Number(c.chainId) === chainId)?.tokens || [];
      const enabledTokens = tokenRows.filter((t: any) => t && t.enabled);

      const byAccount: Record<string, Record<string, string>> = {};
      for (const b of balances) {
        const acc = String((b as any).accountId || '');
        const token = String((b as any).token || '').toLowerCase();
        const balRaw = String((b as any).balanceRaw || '0');
        if (!byAccount[acc]) byAccount[acc] = {};
        byAccount[acc][token] = balRaw;
      }

      const outTreasuries = treasuries.map((t: any) => {
        const acc = `treasury:${t.treasuryId}`;
        const perToken: any[] = [];
        for (const tok of enabledTokens) {
          const addr = String(tok.address || '').toLowerCase();
          perToken.push({
            token: addr,
            symbol: tok.symbol,
            decimals: tok.decimals,
            balanceRaw: (byAccount[acc] && byAccount[acc][addr]) ? byAccount[acc][addr] : '0'
          });
        }
        return {
          treasuryId: t.treasuryId,
          label: t.label || t.treasuryId,
          enabled: Boolean(t.enabled),
          balances: perToken
        };
      });

      return res.json({
        moduleId,
        chainId,
        tokens: enabledTokens.map((t: any) => ({ address: String(t.address).toLowerCase(), symbol: t.symbol, decimals: t.decimals })),
        treasuries: outTreasuries
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'SERVER_ERROR' });
    }
  });




  // TG admin: list ALL treasury balances on a chain (not scoped to module.allowedTreasuries)
  // Security:
  //  - protected by module auth (x-module-id + x-module-key)
  //  - TG bot enforces TG_ADMIN_IDS before calling this
  r.post('/modules/:moduleId/tg/treasuries/admin/list', requireModule(col), async (req: AuthedRequest, res) => {
    try {
      const moduleId = String(req.params.moduleId || '').trim();
      const chainId = Number(req.body?.chainId);
      if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });

      if (req.moduleDoc?._id && req.moduleDoc._id !== moduleId) {
        return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });
      }

      // balances are stored on accounts like "treasury:<treasuryId>"
      const balRows = await col.balances.find({ chainId, accountId: { $regex: /^treasury:/ } }).toArray();

      // optional treasury labels from treasuries collection
      const treDocs = await col.treasuries
        .find({ chainId }, { projection: { _id: 0, treasuryId: 1, label: 1, enabled: 1, moduleId: 1 } })
        .toArray();
      const metaByTreasury = new Map<string, any>();
      for (const t of treDocs) metaByTreasury.set(String((t as any).treasuryId), t);

      const byTreasury = new Map<
        string,
        {
          treasuryId: string;
          label?: string;
          moduleId?: string;
          enabled?: boolean;
          balances: Array<{ token: string; symbol: string; decimals: number; balanceRaw: string; enabled: boolean }>;
        }
      >();

      // Seed from treasuries collection so admins can see treasuries even when
      // there are no balance rows yet (new/empty treasuries).
      for (const t of treDocs) {
        const treasuryId = String((t as any).treasuryId || '').trim();
        if (!treasuryId) continue;
        if (!byTreasury.has(treasuryId)) {
          byTreasury.set(treasuryId, {
            treasuryId,
            label: String((t as any).label || treasuryId),
            moduleId: (t as any).moduleId,
            enabled: Boolean((t as any).enabled ?? true),
            balances: []
          });
        }
      }

      for (const b of balRows) {
        const accountId = String((b as any).accountId || '');
        if (!accountId.startsWith('treasury:')) continue;
        const treasuryId = accountId.slice('treasury:'.length);
        if (!treasuryId) continue;

        const token = String((b as any).token || '').toLowerCase();
        if (!token) continue;

        const tokMeta = resolveEnabledToken(cfg, chainId, token);
        const symbol = tokMeta?.symbol ? String(tokMeta.symbol) : token.slice(0, 6);
        const decimals = Number.isFinite(Number(tokMeta?.decimals)) ? Number((tokMeta as any).decimals) : 18;
        const tokenEnabled = Boolean(tokMeta?.enabled);

        const tMeta = metaByTreasury.get(treasuryId) || {};
        const cur = byTreasury.get(treasuryId) || {
          treasuryId,
          label: tMeta.label || treasuryId,
          moduleId: tMeta.moduleId,
          enabled: Boolean(tMeta.enabled ?? true),
          balances: [] as any[]
        };

        cur.balances.push({
          token,
          symbol,
          decimals,
          balanceRaw: String((b as any).balanceRaw || '0'),
          enabled: tokenEnabled
        });

        byTreasury.set(treasuryId, cur);
      }

      const treasuries = Array.from(byTreasury.values())
        .sort((a, b) => a.treasuryId.localeCompare(b.treasuryId))
        .map((t) => ({
          ...t,
          balances: (t.balances || []).sort((x, y) => String(x.symbol).localeCompare(String(y.symbol)))
        }));

      return res.json({ ok: true, moduleId, chainId, treasuries });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'SERVER_ERROR' });
    }
  });

  // SUPER ADMIN (TG): move credits between linked wallet and a treasury
  // Body: { tgId, refId, chainId, token, treasuryId, direction: 'to_treasury'|'from_treasury', amountRaw }

// TG admin: move credits between admin wallet and any treasury (fund / defund).
// Auth: module headers (x-module-id / x-module-key). TG bot must additionally gate by TG_SUPERADMIN_IDS.
//
// body:
//  { tgId, chainId, token, treasuryId, amountRaw, dir: "to_treasury"|"from_treasury", refId? }
// TG admin: move credits between admin wallet and any treasury (fund / defund).
// Auth: module headers (x-module-id / x-module-key). TG bot must additionally gate by TG_SUPERADMIN_IDS.
//
// body:
//  { tgId, chainId, token, treasuryId, amountRaw, dir: "to_treasury"|"from_treasury", refId? }
r.post('/modules/:moduleId/tg/treasuries/admin/transfer', requireModule(col), async (req: AuthedRequest, res) => {
  try {
    const moduleId = String(req.params.moduleId || '').trim();
    const tgId = String(req.body?.tgId || '').trim();
    const treasuryId = String(req.body?.treasuryId || '').trim();
    const token = String(req.body?.token || '').trim().toLowerCase();
    const dir = String(req.body?.dir || '').trim();
    const amountRaw = String(req.body?.amountRaw || '').trim();
    const chainId = Number(req.body?.chainId);

    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });
    if (!treasuryId) return res.status(400).json({ error: 'BAD_TREASURY_ID' });
    if (!token || !/^0x[a-fA-F0-9]{40}$/.test(token)) return res.status(400).json({ error: 'BAD_TOKEN' });
    if (dir !== 'to_treasury' && dir !== 'from_treasury') return res.status(400).json({ error: 'BAD_DIR' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });

    let amt: bigint;
    try {
      amt = BigInt(amountRaw);
    } catch {
      return res.status(400).json({ error: 'BAD_AMOUNT' });
    }
    if (amt <= 0n) return res.status(400).json({ error: 'BAD_AMOUNT' });

    // Resolve admin's linked wallet (correct key shape)
    const link = await col.tgLinks.findOne({ _id: `${moduleId}:tg:${tgId}` });
    if (!link?.ownerWallet) return res.status(404).json({ error: 'NOT_LINKED' });

    const ownerWallet = normalizeAddress(String(link.ownerWallet));

    // Treasury must exist (correct key shape)
    const tre = await col.treasuries.findOne({ _id: treasuryId });
    if (!tre) return res.status(404).json({ error: 'TREASURY_NOT_FOUND' });

    const fromAccountId = dir === 'to_treasury' ? userAccountId(ownerWallet) : `treasury:${treasuryId}`;
    const toAccountId = dir === 'to_treasury' ? `treasury:${treasuryId}` : userAccountId(ownerWallet);

    const refId =
      String(req.body?.refId || '').trim() ||
      `tg-admin:${moduleId}:${tgId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

    const out = await applyLedgerEntryTx(db, col, {
      refId,
      kind: 'transfer',
      chainId,
      token,
      moduleId,
      fromAccountId,
      toAccountId,
      amountRaw: amt.toString(),
      meta: { source: 'tg-admin', tgId, treasuryId, dir }
    });

    return res.json({ ok: true, refId, fromAccountId, toAccountId, entry: out.ledger });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || 'SERVER_ERROR') });
  }
});

r.post('/modules/:moduleId/tg/ledger/transfer', requireModule(col), async (req: AuthedRequest, res) => {
    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    const refId = String(req.body?.refId || '').trim();
    const chainId = Number(req.body?.chainId);
    const asset = String(req.body?.asset || req.body?.token || '').trim();
    const to = String(req.body?.to || req.body?.toAddress || '').trim();
    const toAccountId = String(req.body?.toAccountId || '').trim();
    const kind = String(req.body?.kind || 'tg_transfer').trim();
    const reason = String(req.body?.reason || 'telegram transfer').trim();
    const meta = req.body?.meta;

    let amountRaw = String(req.body?.amountRaw || req.body?.debitRaw || '').trim();
    const amount = String(req.body?.amount || '').trim(); // human amount

    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });
    if (!refId) return res.status(400).json({ error: 'MISSING_REFID' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!asset) return res.status(400).json({ error: 'BAD_ASSET' });
    if (!amountRaw && !amount) return res.status(400).json({ error: 'BAD_AMOUNT' });

    // Resolve and enforce token is enabled
    let tokenCfg: { token: string; symbol: string; decimals: number };
    try {
      const resolved = resolveEnabledToken(cfg, chainId, asset);
      if (!resolved || !resolved.enabled || !resolved.token) {
        return res.status(400).json({ error: 'TOKEN_NOT_ENABLED' });
      }
      tokenCfg = {
        token: String(resolved.token),
        symbol: String(resolved.symbol || ''),
        decimals: Number(resolved.decimals || 18)
      };
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'TOKEN_NOT_ENABLED' });
    }

    if (!amountRaw) {
      try {
        amountRaw = ethers.parseUnits(amount, tokenCfg.decimals).toString();
      } catch {
        return res.status(400).json({ error: 'BAD_AMOUNT' });
      }
    }

    // Resolve sender account.
    // Linked users spend from their owner wallet account; unlinked users can still spend from their TG holding account
    // (credits can be received before registering/linking).
    const link = await col.tgLinks.findOne({ _id: `${moduleId}:tg:${tgId}` });

    let fromAccountId = '';
    let ownerWallet = '';
    if (link?.ownerWallet) {
      ownerWallet = normalizeAddress(String(link.ownerWallet));
      fromAccountId = userAccountId(ownerWallet);
    } else {
      fromAccountId = tgAccountId("tg", String(tgId));
    }

    // Resolve recipient:
    // - explicit toAccountId (advanced)
    // - `tg:<moduleId>:<tgId>` holding account
    // - `@username` (seen-users list, falls back to holding account if not linked)
    // - EVM address
    let resolvedToAccountId = '';
    if (toAccountId) {
      resolvedToAccountId = toAccountId;
    } else if (to.startsWith('tg:')) {
      const parts = to.split(':');
      const mod = String(parts[1] || '').trim();
      const tid = String(parts[2] || '').trim();
      if (mod && tid) resolvedToAccountId = tgAccountId(mod, tid);
    } else if (to.startsWith('@')) {
      const uname = normalizeUsername(to);
      if (uname) {
        const seen = await col.tgSeenUsers.findOne({ moduleId, usernameLower: uname });
        const targetTgId = String((seen as any)?.tgId || '').trim();
        if (targetTgId) {
          const targetLink = await col.tgLinks.findOne({ _id: `${moduleId}:tg:${targetTgId}` });
          if (targetLink?.ownerWallet) {
            resolvedToAccountId = userAccountId(String(targetLink.ownerWallet));
          } else {
            resolvedToAccountId = tgAccountId(moduleId, targetTgId);
          }
        }
      }
    } else if (isEvmAddress(to)) {
      resolvedToAccountId = userAccountId(to);
    }

    if (!resolvedToAccountId) return res.status(400).json({ error: 'BAD_TO' });

    // If the TG module is sending funds to a treasury, enforce allowedTreasuries for this module.
    if (resolvedToAccountId.startsWith('treasury:')) {
      const allowed = new Set((req.moduleDoc?.allowedTreasuries || []).map(String));
      const tid = resolvedToAccountId.slice('treasury:'.length);
      if (!allowed.has(tid)) return res.status(403).json({ error: 'TREASURY_NOT_ALLOWED' });
    }

    try {
      const { ledger } = await applyLedgerEntryTx(db, col, {
        refId,
        kind,
        chainId,
        token: tokenCfg.token,
        moduleId,
        fromAccountId,
        toAccountId: resolvedToAccountId,
        amountRaw,
        meta: { reason, tgId, to, ...meta }
      });
      res.json({ ok: true, ledger, ownerWallet, token: tokenCfg.token, symbol: tokenCfg.symbol, decimals: tokenCfg.decimals });
    } catch (e: any) {
      // Ledger engine uses LedgerError for insufficiency etc.
      const msg = String(e?.code || e?.message || 'LEDGER_ERROR');
      const status = Number(e?.statusCode || 400);
      res.status(status).json({ error: msg });
    }
  });

;

  // Create a session-signed withdraw intent + burn ledger credits immediately.
  r.post('/modules/:moduleId/tg/session/withdraw', requireModule(col), async (req: AuthedRequest, res) => {
    if (!enableTgSessWithdraw) return res.status(400).json({ error: 'FEATURE_DISABLED' });
    if (!sessionEncSecret) return res.status(500).json({ error: 'SESSION_KEY_ENC_SECRET_NOT_SET' });

    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    const refId = String(req.body?.refId || '').trim();
    const chainId = Number(req.body?.chainId);
    const vaultId = String(req.body?.vaultId || '').trim();
    const to = normalizeAddress(String(req.body?.to || ''));
    const debitRaw = String(req.body?.debitRaw || req.body?.amountRaw || '').trim();
    const asset = String(req.body?.asset || 'native').trim();
    const deadline = Number(req.body?.deadline || Math.floor(Date.now() / 1000) + 900);

    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });
    if (!refId) return res.status(400).json({ error: 'MISSING_REFID' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });
    if (!isEvmAddress(to)) return res.status(400).json({ error: 'BAD_TO' });
    if (!/^[0-9]+$/.test(debitRaw)) return res.status(400).json({ error: 'BAD_AMOUNT' });
    if (!Number.isFinite(deadline) || deadline <= 0) return res.status(400).json({ error: 'BAD_DEADLINE' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    const link = await col.tgLinks.findOne({ _id: `${moduleId}:tg:${tgId}` });
    if (!link) return res.status(400).json({ error: 'TG_NOT_LINKED' });
    const ownerWallet = normalizeAddress(link.ownerWallet);

    const sess = await col.sessionKeys.findOne({ _id: `${ownerWallet}:${chainId}:${vaultId}` });
    if (!sess || !sess.sessionKey || !sess.encPriv) return res.status(400).json({ error: 'SESSION_KEY_NOT_SET' });
    const sessionKey = normalizeAddress(sess.sessionKey);

    // Resolve asset -> token address (for sig/caps) + ledgerToken (what ledger tracks)
    let isNative = false;
    let tokenAddrForCaps = '';
    let ledgerToken = '';

    if (asset.toLowerCase() === 'native') {
      isNative = true;
      tokenAddrForCaps = ethers.ZeroAddress; // caps/signing
      ledgerToken = normalizeAddress(vault.wNative); // ledger uses wNative
    } else if (isEvmAddress(asset)) {
      isNative = false;
      tokenAddrForCaps = normalizeAddress(asset);
      ledgerToken = tokenAddrForCaps;
    } else {
      const t = chain.tokens.find((x: any) => x.enabled && String(x.symbol).toLowerCase() === asset.toLowerCase());
      if (!t) return res.status(400).json({ error: 'UNKNOWN_ASSET' });
      tokenAddrForCaps = normalizeAddress(t.address);
      ledgerToken = tokenAddrForCaps;
    }

    const fromAccountId = userAccountId(ownerWallet);

    // Ensure ledger balance exists
    const bal = await col.balances.findOne({ _id: `${fromAccountId}:${chainId}:${ledgerToken.toLowerCase()}` });
    const have = BigInt(String(bal?.balanceRaw || '0'));
    const wantGross = BigInt(debitRaw);
    if (wantGross <= 0n) return res.status(400).json({ error: 'BAD_AMOUNT' });
    if (have < wantGross) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });

    // Fee + net (GROSS debitRaw = net + fee)
    const { feeRaw, netRaw } = calcFeeNet(debitRaw, Number((vault as any).withdrawFeeBps));
    const wantNet = BigInt(netRaw);

    // On-chain caps (pre-check)
    const provider = new ethers.JsonRpcProvider(chain.rpcHttp);
    const domain = await getEip712Domain(vault.address, provider);
    const st = await getSessionState(vault.address, provider, ownerWallet, sessionKey);
    if (!st.enabled) return res.status(400).json({ error: 'SESSION_NOT_ACTIVE_ONCHAIN' });

    const caps = await getSessionTokenCaps(vault.address, provider, ownerWallet, sessionKey, st.epoch, tokenAddrForCaps);
    if (!caps.allowed) return res.status(400).json({ error: 'ASSET_NOT_ALLOWED_IN_SESSION' });

    if (wantNet > caps.maxPerTx) return res.status(400).json({ error: 'OVER_MAX_PER_TX' });
    if (wantNet > caps.remaining) return res.status(400).json({ error: 'OVER_REMAINING' });

    const pk = decryptBox(sessionEncSecret, sess.encPriv);
    const sessionWallet = new ethers.Wallet(pk);
    if (normalizeAddress(sessionWallet.address) !== normalizeAddress(sessionKey)) {
      return res.status(500).json({ error: 'SESSION_KEY_MISMATCH' });
    }

    const typed = isNative
      ? typedDataSessionWithdrawNative(domain, {
          ownerWallet,
          sessionKey,
          epoch: st.epoch.toString(),
          to,
          amount: netRaw,
          sessionNonce: st.nonce.toString(),
          deadline: String(deadline)
        })
      : typedDataSessionWithdraw(domain, {
          ownerWallet,
          sessionKey,
          epoch: st.epoch.toString(),
          token: tokenAddrForCaps,
          to,
          amount: netRaw,
          sessionNonce: st.nonce.toString(),
          deadline: String(deadline)
        });

    const sessionSig = await sessionWallet.signTypedData(typed.domain as any, typed.types as any, typed.message as any);

    // Create escrowed intent + hold funds (no burn yet)
    const intentId = randomId(16);
    const action = isNative ? 'withdrawNativeWithSessionSig' : 'withdrawWithSessionSig';

    const mongoSession = db.client.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        try {
          await col.vaultIntents.insertOne(
            {
              _id: intentId,
              refId,
              createdAt: new Date(),
              updatedAt: new Date(),
              status: 'pending',
              chainId,
              vaultId,
              vaultAddress: vault.address,
              action,
              ownerWallet,
              to,
              token: ledgerToken, // ledger token (wNative for native)
              amountRaw: netRaw, // NET (what the vault will send)
              debitRaw, // GROSS (held from user)
              feeRaw,
              escrowed: true,
              settled: false,
              attempts: 0,
              nextAttemptAt: new Date(),
              deadline,
              sig: '0x',
              sessionKey,
              sessionSig,
              epoch: st.epoch.toString(),
              // contract token only needed for ERC20 action; keep separately to avoid confusing native flow
              contractToken: isNative ? undefined : tokenAddrForCaps
            } as any,
            { session: mongoSession }
          );
        } catch (e: any) {
          if (String(e?.code) === '11000') throw Object.assign(new Error('DUPLICATE_REFID'), { code: 'DUPLICATE_REFID' });
          throw e;
        }

        await applyLedgerEntry(db, col, mongoSession, {
          refId: `hold:${refId}`,
          kind: 'withdraw_hold',
          chainId,
          token: ledgerToken,
          moduleId,
          fromAccountId,
          toAccountId: escrowAccountId(fromAccountId),
          amountRaw: debitRaw,
          meta: { action, to, vaultId, deadline, sessionKey }
        });
      });
    } catch (e: any) {
      if (e?.code == 'DUPLICATE_REFID') return res.status(409).json({ error: 'DUPLICATE_REFID' });
      throw e;
    } finally {
      await mongoSession.endSession();
    }

    res.json({ ok: true, intentId, ownerWallet, to, chainId, vaultId, asset: isNative ? 'native' : tokenAddrForCaps, debitRaw, feeRaw, netRaw });
  });

  // Withdraw all positive balances on a chain within caps
  r.post('/modules/:moduleId/tg/session/withdrawall', requireModule(col), async (req: AuthedRequest, res) => {
    if (!enableTgSessWithdraw) return res.status(400).json({ error: 'FEATURE_DISABLED' });
    if (!sessionEncSecret) return res.status(500).json({ error: 'SESSION_KEY_ENC_SECRET_NOT_SET' });

    const moduleId = String(req.params.moduleId || '').trim();
    if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
    if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

    const tgId = String(req.body?.tgId || '').trim();
    const chainId = Number(req.body?.chainId);
    const vaultId = String(req.body?.vaultId || '').trim();
    const to = normalizeAddress(String(req.body?.to || ''));
    const baseRefId = String(req.body?.refId || '').trim() || `tg-withdrawall:${moduleId}:${tgId}:${Date.now()}`;
    const deadline = Number(req.body?.deadline || Math.floor(Date.now() / 1000) + 900);

    if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });
    if (!isEvmAddress(to)) return res.status(400).json({ error: 'BAD_TO' });
    if (!Number.isFinite(deadline) || deadline <= 0) return res.status(400).json({ error: 'BAD_DEADLINE' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    const link = await col.tgLinks.findOne({ _id: `${moduleId}:tg:${tgId}` });
    if (!link) return res.status(400).json({ error: 'TG_NOT_LINKED' });

    const ownerWallet = normalizeAddress(link.ownerWallet);
    const fromAccountId = userAccountId(ownerWallet);

    const sess = await col.sessionKeys.findOne({ _id: `${ownerWallet}:${chainId}:${vaultId}` });
    if (!sess || !sess.sessionKey || !sess.encPriv) return res.status(400).json({ error: 'SESSION_KEY_NOT_SET' });
    const sessionKey = normalizeAddress(sess.sessionKey);

    const provider = new ethers.JsonRpcProvider(chain.rpcHttp);
    const domain = await getEip712Domain(vault.address, provider);
    const st = await getSessionState(vault.address, provider, ownerWallet, sessionKey);
    if (!st.enabled) return res.status(400).json({ error: 'SESSION_NOT_ACTIVE_ONCHAIN' });

    const pk = decryptBox(sessionEncSecret, sess.encPriv);
    const sessionWallet = new ethers.Wallet(pk);
    if (normalizeAddress(sessionWallet.address) !== normalizeAddress(sessionKey)) {
      return res.status(500).json({ error: 'SESSION_KEY_MISMATCH' });
    }

    const bals = await col.balances.find({ accountId: fromAccountId, chainId }).toArray();
    const positives = bals
      .map((b) => ({ token: normalizeAddress(b.token), balance: BigInt(String(b.balanceRaw || '0')) }))
      .filter((x) => x.balance > 0n);

    const results: any[] = [];

    // local nonce copy; contract increments per successful withdraw
    let sessionNonce = st.nonce;

    for (const b of positives) {
      const isNative = b.token === normalizeAddress(vault.wNative);
      const tokenAddrForCaps = isNative ? ethers.ZeroAddress : b.token;

      const caps = await getSessionTokenCaps(vault.address, provider, ownerWallet, sessionKey, st.epoch, tokenAddrForCaps);
      if (!caps.allowed) continue;

      let wantGross = b.balance;
      if (wantGross > caps.maxPerTx) wantGross = caps.maxPerTx;
      if (wantGross > caps.remaining) wantGross = caps.remaining;
      if (wantGross <= 0n) continue;

      const refId = `${baseRefId}:${isNative ? 'native' : tokenAddrForCaps}`;

      const debitRaw = wantGross.toString();
      const { feeRaw, netRaw } = calcFeeNet(debitRaw, Number((vault as any).withdrawFeeBps));

      const typed = isNative
        ? typedDataSessionWithdrawNative(domain, {
            ownerWallet,
            sessionKey,
            epoch: st.epoch.toString(),
            to,
            amount: netRaw,
            sessionNonce: sessionNonce.toString(),
            deadline: String(deadline)
          })
        : typedDataSessionWithdraw(domain, {
            ownerWallet,
            sessionKey,
            epoch: st.epoch.toString(),
            token: tokenAddrForCaps,
            to,
            amount: netRaw,
            sessionNonce: sessionNonce.toString(),
            deadline: String(deadline)
          });

      const sessionSig = await sessionWallet.signTypedData(typed.domain as any, typed.types as any, typed.message as any);

      const intentId = randomId(16);
      const action = isNative ? 'withdrawNativeWithSessionSig' : 'withdrawWithSessionSig';

      const sessTxn = db.client.startSession();
      try {
        await sessTxn.withTransaction(async () => {
          await col.vaultIntents.insertOne(
            {
              _id: intentId,
              refId,
              createdAt: new Date(),
              updatedAt: new Date(),
              status: 'pending',
              chainId,
              vaultId,
              vaultAddress: vault.address,
              action,
              ownerWallet,
              to,
              // Always store the ledger token (wNative for native). Relayer ignores token for native.
              token: b.token,
              amountRaw: netRaw,
              debitRaw,
              feeRaw,
              escrowed: true,
              settled: false,
              attempts: 0,
              nextAttemptAt: new Date(),
              deadline,
              sig: '0x',
              sessionKey,
              sessionSig,
              epoch: st.epoch.toString()
            } as any,
            { session: sessTxn }
          );

          await applyLedgerEntry(db, col, sessTxn, {
            refId: `hold:${refId}`,
            kind: 'withdraw_hold',
            chainId,
            token: b.token,
            moduleId,
            fromAccountId,
            toAccountId: escrowAccountId(fromAccountId),
            amountRaw: debitRaw,
            meta: { tgId, to, asset: isNative ? 'native' : tokenAddrForCaps, withdrawAll: true }
          });
        });
      } catch (e: any) {
        if (e?.code === 11000) {
          results.push({ ok: false, refId, error: 'DUP_REF' });
          continue
        }
        throw e
      } finally {
        await sessTxn.endSession();
      }

      results.push({ intentId, asset: isNative ? 'native' : tokenAddrForCaps, grossRaw: debitRaw, feeRaw, netRaw });

      sessionNonce = sessionNonce + 1n;
    }

    res.json({ ok: true, ownerWallet, chainId, vaultId, to, count: results.length, results });
  });


  r.post('/modules/:moduleId/blackjack/admin/enable', requireModule(col), async (req, res) => {
    try {
      const now = new Date();

      await col.modules.updateOne(
        { _id: 'blackjack' } as any,
        {
          $setOnInsert: { _id: 'blackjack', createdAt: now },
          $set: { enabled: true, updatedAt: now }
        } as any,
        { upsert: true }
      );

      await col.treasuries.updateOne(
        { _id: 'blackjack-43113-usdc' } as any,
        { $set: { enabled: true, updatedAt: now } } as any
      );

      return res.json({ ok: true, enabled: true });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_ENABLE_FAILED') });
    }
  });

  r.post('/modules/:moduleId/blackjack/admin/disable', requireModule(col), async (req, res) => {
    try {
      const now = new Date();

      await col.modules.updateOne(
        { _id: 'blackjack' } as any,
        {
          $set: { enabled: false, updatedAt: now }
        } as any,
        { upsert: true }
      );

      await col.treasuries.updateOne(
        { _id: 'blackjack-43113-usdc' } as any,
        { $set: { enabled: false, updatedAt: now } } as any
      );

      return res.json({ ok: true, enabled: false });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BLACKJACK_DISABLE_FAILED') });
    }
  });



  // ---------------------
  // Vault intents (user signs, relayer executes)
  // ---------------------
  /**
   * Wallet signs withdraw; server:
   *  - verifies sig against CURRENT on-chain nonce
   *  - creates intent
   *  - HOLDs debitRaw (gross) from user -> escrow
   * Relayer later executes on-chain, then marks confirmed/failed.
   */
  r.post('/vault/intents/withdraw', requireJwt, async (req: AuthedRequest, res) => {
    const ownerWallet = req.user!.address;

    const refId = String(req.body?.refId || '').trim();
    const chainId = Number(req.body?.chainId);
    const vaultId = String(req.body?.vaultId || '').trim();
    const isNative = Boolean(req.body?.isNative);
    const tokenIn = normalizeAddress(String(req.body?.token || ''));
    const to = normalizeAddress(String(req.body?.to || ''));
    const debitRaw = String(req.body?.debitRaw || '').trim();
    const deadline = Number(req.body?.deadline);
    const sig = String(req.body?.signature || req.body?.sig || '').trim();

    if (!refId) return res.status(400).json({ error: 'MISSING_REFID' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });
    if (!isEvmAddress(to)) return res.status(400).json({ error: 'BAD_TO' });
    if (!/^[0-9]+$/.test(debitRaw)) return res.status(400).json({ error: 'BAD_AMOUNT' });
    if (!Number.isFinite(deadline) || deadline <= 0) return res.status(400).json({ error: 'BAD_DEADLINE' });
    if (!sig) return res.status(400).json({ error: 'BAD_SIG' });
    if (!isNative && !isEvmAddress(tokenIn)) return res.status(400).json({ error: 'BAD_TOKEN' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    // Ledger token = wNative for native withdraw; else ERC20 token
    const ledgerToken = normalizeAddress(isNative ? vault.wNative : tokenIn);

    // fee bps: prefer vault.withdrawFeeBps if provided; else env
    const vaultFeeBps = Number((vault as any).withdrawFeeBps);
    let feeRaw: string, netRaw: string;
    try {
      ({ feeRaw, netRaw } = calcFeeNet(debitRaw, Number.isFinite(vaultFeeBps) ? vaultFeeBps : undefined));
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message || 'BAD_AMOUNT') });
    }

    // Verify signature against CURRENT nonce
    const provider = new ethers.JsonRpcProvider(chain.rpcHttp);
    const domain = await getEip712Domain(vault.address, provider);
    const nonce = await getOwnerNonce(vault.address, provider, ownerWallet);

    const typed = isNative
      ? typedDataWithdrawNative(domain, {
          ownerWallet,
          to,
          amount: netRaw,
          nonce: nonce.toString(),
          deadline: String(deadline)
        })
      : typedDataWithdraw(domain, {
          ownerWallet,
          token: ledgerToken,
          to,
          amount: netRaw,
          nonce: nonce.toString(),
          deadline: String(deadline)
        });

    const recovered = ethers.verifyTypedData(typed.domain as any, typed.types as any, typed.message as any, sig);
    if (normalizeAddress(recovered) !== normalizeAddress(ownerWallet)) {
      return res.status(400).json({ error: 'BAD_SIG' });
    }

    const intentId = randomId(16);

    // Create intent + HOLD credits atomically
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        try {
          await col.vaultIntents.insertOne(
            {
              _id: intentId,
              refId,
              status: 'pending',
              chainId,
              vaultId,
              vaultAddress: vault.address,
              ownerWallet: normalizeAddress(ownerWallet),
              to,
              token: ledgerToken,
              amountRaw: netRaw, // NET leaves vault
              debitRaw,          // GROSS debited from user ledger
              feeRaw,
              escrowed: true,
              settled: false,
              attempts: 0,
              nextAttemptAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
              action: isNative ? 'withdrawNativeWithSig' : 'withdrawWithSig',
              actionArgs: isNative
                ? { ownerWallet, to, amountRaw: netRaw, deadline, sig }
                : { ownerWallet, token: ledgerToken, to, amountRaw: netRaw, deadline, sig }
            } as any,
            { session }
          );
        } catch (e: any) {
          if (String(e?.code) === '11000') throw Object.assign(new Error('DUPLICATE_REFID'), { code: 11000 });
          throw e;
        }

        const userId = userAccountId(ownerWallet);
        await applyLedgerEntry(db, col, session, {
          refId: `hold:${refId}`,
          kind: 'withdraw_hold',
          chainId,
          token: ledgerToken,
          fromAccountId: userId,
          toAccountId: escrowAccountId(userId),
          amountRaw: debitRaw,
          meta: { vaultId, intentId, refId }
        });
      });
    } catch (e: any) {
      if (String(e?.code) === '11000') return res.status(409).json({ error: 'DUPLICATE_REFID' });

      // IMPORTANT: do NOT crash / 500 when a user simply doesn't have enough credits.
      // Treat it as a normal business-rule rejection.
      const msg = String(e?.message || '');
      if (e?.code == 'INSUFFICIENT_BALANCE' || msg.startsWith('INSUFFICIENT_BALANCE')) {
        return res.status(409).json({ error: 'INSUFFICIENT_BALANCE' });
      }

      throw e;
    } finally {
      await session.endSession();
    }

    res.json({ ok: true, intentId });
  });

  // Register a server-held session key (owner signs once). Relayer executes.
  r.post('/vault/intents/session/register', requireJwt, async (req: AuthedRequest, res) => {
    if (!enableTgLinking) return res.status(400).json({ error: 'FEATURE_DISABLED' });

    const ownerWallet = req.user!.address;
    const refId = String(req.body?.refId || '').trim();
    const chainId = Number(req.body?.chainId);
    const vaultId = String(req.body?.vaultId || '').trim();
    const sessionKey = normalizeAddress(String(req.body?.sessionKey || ''));
    const expiry = Number(req.body?.expiry);
    const scopes = Number(req.body?.scopes);
    const deadline = Number(req.body?.deadline);
    const sig = String(req.body?.sig || '').trim();

    if (!refId) return res.status(400).json({ error: 'MISSING_REFID' });
    if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
    if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });
    if (!isEvmAddress(sessionKey)) return res.status(400).json({ error: 'BAD_SESSION_KEY' });
    if (!Number.isFinite(expiry) || expiry <= 0) return res.status(400).json({ error: 'BAD_EXPIRY' });
    if (!Number.isFinite(scopes) || scopes <= 0) return res.status(400).json({ error: 'BAD_SCOPES' });
    if (!Number.isFinite(deadline) || deadline <= 0) return res.status(400).json({ error: 'BAD_DEADLINE' });
    if (!sig) return res.status(400).json({ error: 'BAD_SIG' });

    let chain: any, vault: any;
    try {
      ({ chain, vault } = getChainAndVault(chainId, vaultId));
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
    }

    // sessionKey must match what was created/stored for this owner/chain/vault
    const sess = await col.sessionKeys.findOne({ _id: `${normalizeAddress(ownerWallet)}:${chainId}:${vaultId}` });
    if (!sess || normalizeAddress(String(sess.sessionKey || '')) !== normalizeAddress(sessionKey)) {
      return res.status(400).json({ error: 'SESSION_KEY_NOT_CREATED' });
    }

    const intentId = randomId(16);
    try {
      await col.vaultIntents.insertOne({
        _id: intentId,
        refId,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'pending',
        chainId,
        vaultId,
        vaultAddress: vault.address,
        action: 'registerSessionWithSig',
        ownerWallet: normalizeAddress(ownerWallet),
        sessionKey,
        expiry,
        scopes,
        deadline,
        sig
      } as any);
    } catch (e: any) {
      if (String(e?.code) === '11000') return res.status(409).json({ error: 'DUPLICATE_REFID' });
      throw e;
    }

    await col.sessionKeys.updateOne(
      { _id: `${normalizeAddress(ownerWallet)}:${chainId}:${vaultId}` },
      { $set: { status: 'created', updatedAt: new Date() } }
    );

    res.json({ ok: true, intentId });
  });

  // Configure per-token limits for the active session key (owner signs)
  r.post('/vault/intents/session/config', requireJwt, async (req: AuthedRequest, res) => {
    if (!enableTgLinking) return res.status(400).json({ error: 'FEATURE_DISABLED' });

    const ownerWallet = req.user!.address;
    const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    const out: any[] = [];

    for (const it of items) {
      const refId = String(it?.refId || '').trim();
      const chainId = Number(it?.chainId);
      const vaultId = String(it?.vaultId || '').trim();
      const sessionKey = normalizeAddress(String(it?.sessionKey || ''));
      const epoch = String(it?.epoch || '').trim();
      const token = normalizeAddress(String(it?.token || ''));
      const allowed = Boolean(it?.allowed);
      const maxPerTxRaw = String(it?.maxPerTxRaw || '').trim();
      const totalRaw = String(it?.totalRaw || '').trim();
      const deadline = Number(it?.deadline);
      const sig = String(it?.sig || '').trim();

      if (!refId) return res.status(400).json({ error: 'MISSING_REFID' });
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN' });
      if (!vaultId) return res.status(400).json({ error: 'BAD_VAULT' });
      if (!isEvmAddress(sessionKey)) return res.status(400).json({ error: 'BAD_SESSION_KEY' });
      if (!epoch || !/^[0-9]+$/.test(epoch)) return res.status(400).json({ error: 'BAD_EPOCH' });
      // token can be address(0) for native in some setups; if your contract requires strict address, change this.
      if (!(token === ethers.ZeroAddress || isEvmAddress(token))) return res.status(400).json({ error: 'BAD_TOKEN' });
      if (!/^[0-9]+$/.test(maxPerTxRaw) || !/^[0-9]+$/.test(totalRaw)) return res.status(400).json({ error: 'BAD_LIMITS' });
      if (!Number.isFinite(deadline) || deadline <= 0) return res.status(400).json({ error: 'BAD_DEADLINE' });
      if (!sig) return res.status(400).json({ error: 'BAD_SIG' });

      let chain: any, vault: any;
      try {
        ({ chain, vault } = getChainAndVault(chainId, vaultId));
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'BAD_CHAIN_OR_VAULT' });
      }

      const intentId = randomId(16);
      try {
        await col.vaultIntents.insertOne({
          _id: intentId,
          refId,
          createdAt: new Date(),
          updatedAt: new Date(),
          status: 'pending',
          chainId,
          vaultId,
          vaultAddress: vault.address,
          action: 'configSessionTokenWithSig',
          ownerWallet: normalizeAddress(ownerWallet),
          sessionKey,
          epoch,
          token,
          allowed,
          maxPerTxRaw,
          totalRaw,
          deadline,
          sig
        } as any);
      } catch (e: any) {
        if (String(e?.code) === '11000') return res.status(409).json({ error: 'DUPLICATE_REFID' });
        throw e;
      }
      out.push({ intentId, refId, token });
    }

    res.json({ ok: true, items: out });
  });

  r.get('/me/vault/intents', requireJwt, async (req: AuthedRequest, res) => {
    const ownerWallet = req.user!.address;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const items = await col.vaultIntents
      .find({ ownerWallet: normalizeAddress(ownerWallet) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ ok: true, ownerWallet: normalizeAddress(ownerWallet), items });
  });

  r.post('/me/vault/intents/:refId/retry', requireJwt, async (req: AuthedRequest, res) => {
    const ownerWallet = normalizeAddress(req.user!.address);
    const refId = String(req.params.refId || '');

    const intent: any = await col.vaultIntents.findOne({ refId, ownerWallet });
    if (!intent) return res.status(404).json({ error: 'NOT_FOUND' });
    if (intent.status === 'confirmed') return res.status(400).json({ error: 'ALREADY_CONFIRMED' });
    if (intent.status === 'cancelled') return res.status(400).json({ error: 'CANCELLED' });

    if (intent.status !== 'failed') return res.status(400).json({ error: 'NOT_FAILED' });
    if (!intent.escrowed) return res.status(400).json({ error: 'NOT_ESCROWED' });

    await col.vaultIntents.updateOne(
      { refId, ownerWallet },
      {
        $set: {
          status: 'pending',
          error: undefined,
          nextAttemptAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    res.json({ ok: true });
  });

  // User-initiated cancel disabled
  r.post('/me/vault/intents/:refId/cancel', requireJwt, async (_req: AuthedRequest, res) => {
    return res.status(403).json({ error: 'CANCEL_DISABLED' });
  });

  // Admin tools: retry/cancel FAILED escrowed intents.
  r.post('/admin/vault/intents/:refId/retry', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    const refId = String(req.params.refId || '');
    const intent: any = await col.vaultIntents.findOne({ refId });
    if (!intent) return res.status(404).json({ error: 'NOT_FOUND' });
    if (intent.status === 'confirmed') return res.status(400).json({ error: 'ALREADY_CONFIRMED' });
    if (intent.status === 'cancelled') return res.status(400).json({ error: 'CANCELLED' });
    if (intent.status !== 'failed') return res.status(400).json({ error: 'NOT_FAILED' });
    if (!intent.escrowed) return res.status(400).json({ error: 'NOT_ESCROWED' });

    await col.vaultIntents.updateOne(
      { refId },
      { $set: { status: 'pending', error: undefined, nextAttemptAt: new Date(), updatedAt: new Date() } }
    );

    res.json({ ok: true });
  });

  r.post('/admin/vault/intents/:refId/cancel', requireJwt, adminMw, async (req: AuthedRequest, res) => {
    const refId = String(req.params.refId || '');
    const intent: any = await col.vaultIntents.findOne({ refId });
    if (!intent) return res.status(404).json({ error: 'NOT_FOUND' });
    if (intent.status === 'confirmed') return res.status(400).json({ error: 'ALREADY_CONFIRMED' });
    if (intent.status === 'cancelled') return res.json({ ok: true, already: true });
    if (intent.status !== 'failed') return res.status(400).json({ error: 'NOT_FAILED' });
    if (!intent.escrowed) return res.status(400).json({ error: 'NOT_ESCROWED' });
    if (intent.txHash) return res.status(400).json({ error: 'HAS_TXHASH' });

    const ownerWallet = String(intent.ownerWallet || '');
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const userId = userAccountId(ownerWallet);

        await applyLedgerEntry(db, col, session, {
          refId: `cancel:${refId}`,
          kind: 'withdraw_cancel',
          chainId: intent.chainId,
          token: intent.token,
          fromAccountId: escrowAccountId(userId),
          toAccountId: userId,
          amountRaw: intent.debitRaw,
          meta: { vaultId: intent.vaultId, intentId: intent._id, refId, by: req.user?.address || 'admin' }
        });

        await col.vaultIntents.updateOne(
          { refId },
          { $set: { status: 'cancelled', error: undefined, updatedAt: new Date() } },
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

    res.json({ ok: true });
  });

  // ---------------------
  // Relayer
  // ---------------------
  r.get('/relayer/intents', requireRelayer, async (req, res) => {
    const status = (['pending', 'submitted', 'confirmed', 'failed'] as const).includes(String(req.query.status || 'pending') as any)
      ? (String(req.query.status || 'pending') as any)
      : 'pending';

    const limit = Math.min(Number(req.query.limit || 20), 100);
    const now = new Date();
    const query: any = { status };

    if (status === 'pending') {
      query.$or = [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }];
    }

    const items = await col.vaultIntents.find(query).sort({ createdAt: 1 }).limit(limit).toArray();
    res.json({ ok: true, items });
  });

  r.post('/relayer/intents/:intentId/mark', requireRelayer, async (req, res) => {
    const intentIdParam = String(req.params.intentId || '').trim();
    const statusIn = String(req.body?.status || '').trim();
    const txHash = String(req.body?.txHash || '').trim();
    const errorMsg = String(req.body?.error || '').trim();

    if (!intentIdParam) return res.status(400).json({ error: 'BAD_INTENT_ID' });
    if (!['submitted', 'confirmed', 'failed'].includes(statusIn)) return res.status(400).json({ error: 'BAD_STATUS' });

    // Support BOTH styles of _id:
    //  - string ids (your real intents: "0x..." from randomId())
    //  - ObjectId ids (debug inserts when _id omitted)
    const findQuery: any = { _id: intentIdParam };
    if (/^[a-f0-9]{24}$/i.test(intentIdParam)) {
      // If it looks like an ObjectId hex, try both
      findQuery.$or = [{ _id: intentIdParam }, { _id: new ObjectId(intentIdParam) }];
      delete findQuery._id;
    }

    const intent: any = await col.vaultIntents.findOne(findQuery);
    if (!intent) return res.status(404).json({ error: 'NOT_FOUND' });

    // IMPORTANT: from here on, always update using the actual stored _id type
    const idFilter = { _id: intent._id };

    // never execute cancelled intents
    if (intent.status === 'cancelled') return res.json({ ok: true, ignored: true });

    const now = new Date();
    const MAX_RETRIES = 5;

    // FAILED: transient retry/backoff
    if (statusIn === 'failed') {
      const attempts = Number(intent.attempts || 0) + 1;
      const transient = isTransientRelayerError(errorMsg || '');
      const retrying = transient && attempts <= MAX_RETRIES;

      await col.vaultIntents.updateOne(idFilter, {
        $set: {
          status: (retrying ? 'pending' : 'failed') as any,
          error: errorMsg || undefined,
          attempts,
          nextAttemptAt: retrying ? new Date(now.getTime() + nextBackoffMs(attempts - 1)) : undefined,
          updatedAt: now,
          txHash: undefined
        }
      });

      return res.json({ ok: true, retrying });
    }

    // CONFIRMED: settle escrowed withdraws BEFORE finalizing
    if (statusIn === 'confirmed') {
      if (
        intent.escrowed &&
        !intent.settled &&
        (intent.action === 'withdrawWithSig' ||
          intent.action === 'withdrawNativeWithSig' ||
          intent.action === 'withdrawWithSessionSig' ||
          intent.action === 'withdrawNativeWithSessionSig')
      ) {
        const session = db.client.startSession();
        try {
          await session.withTransaction(async () => {
            const userId = userAccountId(intent.ownerWallet);
            const escId = escrowAccountId(userId);

            const fee = BigInt(intent.feeRaw || '0');
            if (fee > 0n) {
              await applyLedgerEntry(db, col, session, {
                refId: `settleFee:${intent.refId}`,
                kind: 'withdraw_fee',
                chainId: intent.chainId,
                token: intent.token,
                fromAccountId: escId,
                toAccountId: treasuryAccountId(feeTreasuryId),
                amountRaw: fee.toString(),
                meta: { vaultId: intent.vaultId, intentId: String(intent._id), refId: intent.refId }
              });
            }

            const net = BigInt(intent.amountRaw || '0');
            if (net <= 0n) throw new Error('BAD_NET');

            // burn net from escrow
            await applyLedgerEntry(db, col, session, {
              refId: `settleNet:${intent.refId}`,
              kind: 'withdraw_net',
              chainId: intent.chainId,
              token: intent.token,
              fromAccountId: escId,
              toAccountId: undefined,
              amountRaw: net.toString(),
              meta: { vaultId: intent.vaultId, intentId: String(intent._id), refId: intent.refId }
            });

            await col.vaultIntents.updateOne(
              idFilter,
              {
                $set: {
                  status: 'confirmed',
                  txHash: txHash || undefined,
                  error: undefined,
                  settled: true,
                  updatedAt: now
                }
              },
              { session }
            );
          });
        } finally {
          await session.endSession();
        }

        return res.json({ ok: true });
      }

      // non-escrow or non-withdraw intents
      await col.vaultIntents.updateOne(idFilter, {
        $set: { status: 'confirmed', txHash: txHash || undefined, error: undefined, updatedAt: now }
      });

      return res.json({ ok: true });
    }

    // SUBMITTED
    await col.vaultIntents.updateOne(idFilter, {
      $set: { status: 'submitted', txHash: txHash || undefined, error: undefined, updatedAt: now }
    });

    return res.json({ ok: true });
  });

  // ---------------------
  // SaaS public status (for group gating)
  // ---------------------
  r.get('/saas/chats/:chatId', async (req, res) => {
    const chatId = String(req.params.chatId || '').trim();
    if (!chatId) return res.status(400).json({ error: 'BAD_CHAT' });

    const doc = await col.saasChats.findOne({ _id: chatId });
    const now = Date.now();

    if (!doc) {
      return res.json({ ok: true, chat: { active: false, status: 'expired', expiresAt: 0, planId: 'basic' } });
    }

    const active = doc.status === 'active' && (doc.expiresAt || 0) > now;
    res.json({
      ok: true,
      chat: {
        active,
        status: doc.status,
        expiresAt: doc.expiresAt,
        planId: doc.planId,
        skin: doc.skin
      }
    });
  });

  // ---------------------
  // Events (from indexer)
  // ---------------------
  r.get('/me/events', requireJwt, async (req: AuthedRequest, res) => {
    const address = req.user!.address;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;

    const addr = normalizeAddress(address);
    const q: any = {
      $or: [
        { 'args.creditTo': { $in: [addr, address] } },
        { 'args.creditedTo': { $in: [addr, address] } },
        { 'args.ownerWallet': { $in: [addr, address] } }
      ]
    };
    if (Number.isFinite(chainId)) q.chainId = chainId;

    const items = await col.events.find(q).sort({ blockNumber: -1, logIndex: -1 }).limit(limit).toArray();
    res.json({ ok: true, address: addr, items });
  });

  // Indexer ingests raw chain logs (idempotent)
  r.post('/internal/indexer/event', requireIndexer, async (req, res) => {
    const ev = req.body as any;
    if (!ev || !Number.isFinite(ev.chainId) || !ev.txHash || !Number.isFinite(ev.logIndex) || !ev.name) {
      return res.status(400).json({ error: 'BAD_EVENT' });
    }

    const id = `${ev.chainId}:${String(ev.txHash).toLowerCase()}:${Number(ev.logIndex)}`;

    try {
      await col.events.insertOne({
        _id: id,
        chainId: Number(ev.chainId),
        vaultId: String(ev.vaultId || ''),
        vaultAddress: String(ev.vaultAddress || ''),
        blockNumber: Number(ev.blockNumber || 0),
        txHash: String(ev.txHash).toLowerCase(),
        logIndex: Number(ev.logIndex),
        name: String(ev.name),
        args: ev.args || {},
        ts: ev.ts ? new Date(ev.ts) : new Date()
      } as any);

      // Side effects
      const name = String(ev.name);

      if (name === 'Deposited') {
        const creditTo = normalizeAddress(String(ev.args?.creditTo || ''));
        const token = normalizeAddress(String(ev.args?.token || ''));
        const amountReceived = String(ev.args?.amountReceived || '0');

        if (isEvmAddress(creditTo) && isEvmAddress(token) && /^[0-9]+$/.test(amountReceived)) {
          const refId = `deposit:${ev.chainId}:${String(ev.txHash).toLowerCase()}:${Number(ev.logIndex)}`;
          await applyLedgerEntryTx(db, col, {
            refId,
            kind: 'deposit',
            chainId: Number(ev.chainId),
            token,
            toAccountId: userAccountId(creditTo),
            amountRaw: amountReceived,
            meta: {
              vaultId: String(ev.vaultId || ''),
              vaultAddress: String(ev.vaultAddress || ''),
              from: String(ev.args?.from || ''),
              txHash: String(ev.txHash).toLowerCase(),
              blockNumber: Number(ev.blockNumber || 0)
            }
          });

          await col.txTracks.updateMany(
            { chainId: Number(ev.chainId), txHash: String(ev.txHash).toLowerCase() },
            { $set: { status: 'indexed', updatedAt: new Date() } }
          );
        }
      } else if (name === 'TokenEnabled') {
        const token = normalizeAddress(String(ev.args?.token || ''));
        const decimals = Number(ev.args?.decimals || 0);
        if (isEvmAddress(token) && Number.isFinite(decimals)) {
          await col.vaultTokens.updateOne(
            { _id: `${Number(ev.chainId)}:${String(ev.vaultId || '')}:${token.toLowerCase()}` },
            {
              $set: {
                chainId: Number(ev.chainId),
                vaultId: String(ev.vaultId || ''),
                vaultAddress: String(ev.vaultAddress || ''),
                token: token.toLowerCase(),
                decimals,
                enabled: true,
                updatedAt: new Date()
              }
            },
            { upsert: true }
          );
        }
      } else if (name === 'TokenDisabled') {
        const token = normalizeAddress(String(ev.args?.token || ''));
        if (isEvmAddress(token)) {
          await col.vaultTokens.updateOne(
            { _id: `${Number(ev.chainId)}:${String(ev.vaultId || '')}:${token.toLowerCase()}` },
            { $set: { enabled: false, updatedAt: new Date() } },
            { upsert: true }
          );
        }
      }
    } catch (e: any) {
      if (String(e?.code) === '11000') return res.status(409).json({ error: 'DUPLICATE' });
      return res.status(500).json({ error: 'DB_ERROR' });
    }

    res.json({ ok: true, id, at: nowIso() });
  });

  return r;
}
