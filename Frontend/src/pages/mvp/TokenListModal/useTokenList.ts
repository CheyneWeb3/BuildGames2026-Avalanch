/*  useTokenList.ts  – MULTICHAIN READY (2025-10-21)
 *  ------------------------------------------------------------------
 *  • merges bundled JSON, remote list, the Launchpad token list (listed only),
 *    and user-imported custom tokens
 *  • keeps custom tokens in localStorage  (key = STORAGE_KEY)
 *  • exposes helpers   load / save / remove / importToken()
 *  • dedupes by “address + symbol”  ⇒ ETH & WETH can coexist
 *  • pulls per-chain values from useChain() (id/WETH/logo), not globals
 *  ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserProvider, Contract, Interface } from 'ethers';
import { useAppKitNetwork, useAppKitProvider, getChainById } from '../../../config';

import bundled from './localtokenlist.json';            // vite/TS json import

// 🔴 Multichain constants & hook
import {
  useChain,
  LAUNCHPAD_TOKENLIST_URL,
  STORAGE_KEY,
  TOKENLIST_REMOTE_URL,
  FOXY_TOKENLIST_URL,
} from './constantsNEW';



/* ── types ───────────────────────────────────────────────────────── */
export interface TokenEntry {
  name:     string;
  symbol:   string;
  address:  string;
  chainId:  number;
  decimals: number;
  logoURI?: string;
  isNative?: boolean;
}

/* ── localStorage helpers (JSON) ─────────────────────────────────── */
function readStorage(): TokenEntry[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}
function writeStorage(list: TokenEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/* dedupe by *address + symbol* (case-insensitive) */
function dedupe(list: TokenEntry[]): TokenEntry[] {
  const seen = new Set<string>();
  return list.filter(t => {
    const key = `${t.address.toLowerCase()}:${t.symbol.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* exported helpers – used by modal + manage sheet */
export const loadCustomTokens = (): TokenEntry[] => dedupe(readStorage());

export function saveCustomToken(tok: TokenEntry) {
  writeStorage(dedupe([...readStorage(), tok]));
}

/** Multichain-safe removal: if chainId omitted, remove by address (and symbol if provided) across chains. */
export function removeCustomToken(addr: string, sym = '', chainId?: number) {
  const next = readStorage().filter(t => {
    const addrMatch = t.address.toLowerCase() === addr.toLowerCase();
    const symMatch  = sym ? t.symbol.toLowerCase() === sym.toLowerCase() : true;
    const chainOk   = chainId != null ? (t.chainId === chainId) : true;
    return !(addrMatch && symMatch && chainOk);
  });
  writeStorage(next);
}

/* ── on-chain ERC-20 metadata fetch ─────────────────────────────── */
const ERC20_IFACE = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
]);

async function fetchErc20Meta(
  provider: BrowserProvider | undefined,
  addr: string
): Promise<{ name:string; symbol:string; decimals:number } | null> {
  if (!provider) return null;
  try {
    const erc = new Contract(addr, ERC20_IFACE, provider);
    const [name, symbol, dec] = await Promise.all([
      erc.name(), erc.symbol(), erc.decimals()
    ]);
    return { name, symbol, decimals: Number(dec) || 18 };
  } catch { return null; }
}

/* ── helpers to fetch remote lists ───────────────────────────────── */
async function fetchJson<T = any>(url: string | null | undefined): Promise<T | null> {
  if (!url) return null;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

/* Coerce any Token List → TokenEntry[], but:
   • keep only current chain
*/
function mapGenericList(list: any, onlyChainId: number): TokenEntry[] {
  const tokens: any[] = Array.isArray(list?.tokens) ? list.tokens : [];
  return tokens
    .filter(t => Number(t?.chainId) === onlyChainId)
    .map(t => ({
      name    : String(t?.name ?? t?.symbol ?? ''),
      symbol  : String(t?.symbol ?? ''),
      address : String(t?.address ?? '').toLowerCase(),
      chainId : Number(t?.chainId ?? onlyChainId),
      decimals: Number(t?.decimals ?? 18),
      logoURI : t?.logoURI || undefined
    }))
    .filter(t => t.address && t.symbol);
}

function mapLaunchpadList(list: any, onlyChainId: number): TokenEntry[] {
  const tokens: any[] = Array.isArray(list?.tokens) ? list.tokens : [];
  return tokens
    .filter(t =>
      Number(t?.chainId) === onlyChainId &&
      (t?.extensions?.listed === true)        // 🔒 listed/bonded only
    )
    .map(t => ({
      name    : String(t?.name ?? t?.symbol ?? ''),
      symbol  : String(t?.symbol ?? ''),
      address : String(t?.address ?? '').toLowerCase(),
      chainId : Number(t?.chainId ?? onlyChainId),
      decimals: Number(t?.decimals ?? 18),
      logoURI : t?.logoURI || undefined
    }))
    .filter(t => t.address && t.symbol);
}

/* native ticker by chain id */
/* ── main hook ───────────────────────────────────────────────────── */
export function useTokenList() {
  const { chainId }        = useAppKitNetwork();
  const { walletProvider } = useAppKitProvider('eip155');

  // 🔴 pull current chain config
  const { id: CHAIN_ID, WETH, NATIVE_LOGO } = useChain();

  // ✅ derive native currency details from src/config.ts (so BNB/RBAT/etc show correctly)
  const chainMeta = useMemo(
    () => getChainById(chainId ?? CHAIN_ID),
    [chainId, CHAIN_ID]
  );
  // IMPORTANT: Don't default to ETH (that makes every chain look like ETH).
  // Fall back to a neutral "NATIVE" label if config is missing nativeCurrency.
  const nativeSymbol = useMemo(
    () => (chainMeta?.nativeCurrency?.symbol || 'NATIVE').toUpperCase(),
    [chainMeta]
  );
  const nativeName = useMemo(
    () => chainMeta?.nativeCurrency?.name || nativeSymbol,
    [chainMeta, nativeSymbol]
  );
  const nativeDecimals = useMemo(
    () => chainMeta?.nativeCurrency?.decimals ?? 18,
    [chainMeta]
  );


  const [tokens,  setTokens] = useState<TokenEntry[]>([]);
  const [loading, setBusy  ] = useState(false);

  /* 1️⃣ load (bundled + remote + LAUNCHPAD + custom) whenever *config* changes */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        /* bundled list filtered to current chain */
        const local: TokenEntry[] = mapGenericList(bundled, CHAIN_ID);

        /* remote list (ignore network errors) */
        const remoteJson = await fetchJson(TOKENLIST_REMOTE_URL);
        const remote: TokenEntry[] = mapGenericList(remoteJson, CHAIN_ID);

        /* launchpad list (listed only) */
        const launchpadJson = await fetchJson(LAUNCHPAD_TOKENLIST_URL);
        const launchpad: TokenEntry[] = mapLaunchpadList(launchpadJson, CHAIN_ID);

        /* 🔹 FOXY on-chain listing token list */
        const foxyJson = await fetchJson(FOXY_TOKENLIST_URL);
        const foxy: TokenEntry[] = mapGenericList(foxyJson, CHAIN_ID);

        /* user-imported tokens (all chains; we’ll filter later for display) */
        const custom = loadCustomTokens();

        /* native entry goes first so it’s always present */
        const merged = dedupe([
          {
            name    : nativeName,
            symbol  : nativeSymbol,
            address : WETH,                  // canonical wrapped native
            chainId : CHAIN_ID,
            decimals: nativeDecimals,
            logoURI : NATIVE_LOGO,
            isNative: true
          },
          ...local,
          ...remote,
          ...launchpad,
          ...foxy,      // 🔹 include Foxy-listed tokens
          ...custom
        ]);

        if (!cancelled) setTokens(merged);
      } finally { if (!cancelled) setBusy(false); }
    })();


    return () => { cancelled = true; };
  }, [CHAIN_ID, WETH, NATIVE_LOGO, nativeName, nativeSymbol, nativeDecimals]);

  /* 2️⃣ helper: import an arbitrary address, optionally save */
  const importToken = useCallback(
    async (addr: string, persist = false): Promise<TokenEntry | null> => {
      const lower = addr.toLowerCase();

      /* already in list for this chain? return it */
      const already = tokens.find(
        t => t.address.toLowerCase() === lower && t.chainId === chainId
      );
      if (already) return already;

      /* otherwise fetch metadata on-chain */
      const provider = walletProvider
        ? new BrowserProvider(walletProvider) : undefined;
      const meta = await fetchErc20Meta(provider, addr);
      if (!meta) return null;                          // not an ERC-20

      const tok: TokenEntry = {
        ...meta,
        address: addr,
        chainId: Number(chainId ?? CHAIN_ID),
        logoURI: ''
      };

      if (persist) {
        saveCustomToken(tok);
        // keep it in our in-memory set too
        setTokens(cur => dedupe([...cur, tok]));
      }

      return tok;
    },
    [tokens, chainId, walletProvider, CHAIN_ID]
  );

  /* exposed contract */
  return {
    tokens : tokens.filter(t => (chainId == null ? true : t.chainId === chainId)),
    loading: loading,
    importToken,
    nativeSymbol,
    nativeName,
    nativeDecimals,
  };
}

export { STORAGE_KEY };
