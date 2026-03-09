/*  useTokenBalances.ts — MULTICHAIN READY (2025-10-21)  */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserProvider, JsonRpcProvider, Contract, Interface } from 'ethers';
import type { TokenEntry } from './useTokenList';

// 🔴 pull Multicall address dynamically
import { useChain } from './constantsNEW';

// DEFAULT_MC3 (aggregate3) and legacy aggregate ABIs
const MC3_ABI = [{
  inputs: [{
    components: [
      { internalType: 'address', name: 'target',       type: 'address' },
      { internalType: 'bool',    name: 'allowFailure', type: 'bool'    },
      { internalType: 'bytes',   name: 'callData',     type: 'bytes'   }
    ],
    internalType: 'struct Call[]', name: 'calls', type: 'tuple[]'
  }],
  name: 'aggregate3',
  outputs: [{
    components: [
      { internalType: 'bool',  name: 'success',    type: 'bool'  },
      { internalType: 'bytes', name: 'returnData', type: 'bytes' }
    ],
    internalType: 'struct Result[]', name: 'returnData', type: 'tuple[]'
  }],
  stateMutability: 'payable', type: 'function'
}];

const MC_AGG_ABI = [
  'function aggregate(tuple(address target, bytes callData)[]) view returns (uint256 blockNumber, bytes[] returnData)'
];

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// ---------- small resilience helpers ----------
function withTimeout<T>(p: Promise<T>, ms = 2500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(to); resolve(v); },
           e => { clearTimeout(to); reject(e); });
  });
}

// cache
const BAL_CACHE_KEY = 'balances:lastGood:v1';
function loadCache(): Record<string, bigint> {
  try {
    const raw = JSON.parse(localStorage.getItem(BAL_CACHE_KEY) || '{}') as Record<string, string>;
    const out: Record<string, bigint> = {};
    for (const k in raw) out[k] = BigInt(raw[k]);
    return out;
  } catch { return {}; }
}
function saveCache(obj: Record<string, bigint>) {
  try {
    const asStr: Record<string, string> = {};
    for (const k in obj) asStr[k] = obj[k].toString();
    localStorage.setItem(BAL_CACHE_KEY, JSON.stringify(asStr));
  } catch {}
}

// ---------- hook ----------
export function useTokenBalances(
  owner : string | null | undefined,
  tokens: TokenEntry[],
  provider?: BrowserProvider | JsonRpcProvider
) {
  const { DEFAULT_MC3 } = useChain();

  // addr-lower -> balance; includes "native"
  const [map, setMap] = useState<Record<string, bigint>>(() => {
    const cached = loadCache();
    if (cached.native === undefined) cached.native = 0n;
    return cached;
  });

  // coalesce concurrent runs
  const inflightRef = useRef<Promise<void> | null>(null);
  const lastGoodRef = useRef<Record<string, bigint>>(map);

  // stable list of non-native ERC20 addresses (lowercased, deduped)
  const ercAddrs = useMemo(() => {
    const s = new Set<string>();
    for (const t of tokens) {
      if (!t?.isNative && t?.address) s.add(t.address.toLowerCase());
    }
    return Array.from(s);
  }, [tokens]);

  useEffect(() => {
    if (!owner || !provider) return;
    if (inflightRef.current) return; // coalesce callers

    let dead = false;

    const run = (async () => {
      const next: Record<string, bigint> = {};
      const iface = new Interface(ERC20_ABI);

      // native
      try {
        next.native = await withTimeout((provider as any).getBalance(owner), 2500);
      } catch {
        // keep previous native on failure
      }

      // ERC20 balances: try aggregate3 (static) -> aggregate -> per-token fallback
      if (ercAddrs.length) {
        // aggregate3 (static)
        try {
          if (!DEFAULT_MC3) throw new Error('no MC3');
          const mc3 = new Contract(DEFAULT_MC3, MC3_ABI, provider);
          const calls = ercAddrs.map((addr) => ({
            target: addr,
            allowFailure: true,
            callData: iface.encodeFunctionData('balanceOf', [owner]),
          }));
          const res: Array<{ success: boolean; returnData: string }> =
            await withTimeout(mc3.aggregate3.staticCall(calls), 2500);

          res.forEach((r, i) => {
            let bal = 0n;
            if (r?.success && r.returnData !== '0x') {
              bal = iface.decodeFunctionResult('balanceOf', r.returnData)[0] as bigint;
            }
            next[ercAddrs[i]] = bal;
          });
        } catch {
          // legacy aggregate
          try {
            if (!DEFAULT_MC3) throw new Error('no agg');
            const mc = new Contract(DEFAULT_MC3, MC_AGG_ABI, provider);
            const calls = ercAddrs.map((addr) => ({
              target: addr,
              callData: iface.encodeFunctionData('balanceOf', [owner]),
            }));
            const [, data]: [bigint, string[]] = await withTimeout(mc.aggregate(calls), 2500);
            data.forEach((ret, i) => {
              let bal = 0n;
              if (ret && ret !== '0x') {
                bal = iface.decodeFunctionResult('balanceOf', ret)[0] as bigint;
              }
              next[ercAddrs[i]] = bal;
            });
          } catch {
            // per-token fallback (throttle)
            for (const addr of ercAddrs) {
              try {
                const erc20 = new Contract(addr, ERC20_ABI, provider);
                const bal: bigint = await withTimeout(erc20.balanceOf(owner), 1500);
                next[addr] = bal;
              } catch { /* keep previous */ }
            }
          }
        }
      }

      if (dead) return;

      // Merge into last-known; only replace keys we actually fetched.
      setMap((prev) => {
        const merged: Record<string, bigint> = { ...prev };
        for (const [k, v] of Object.entries(next)) merged[k] = v;
        // ensure keys for current tokens exist; prefer last good
        for (const t of tokens) {
          const key = t.isNative ? 'native' : t.address.toLowerCase();
          if (!(key in merged)) merged[key] = lastGoodRef.current[key] ?? 0n;
        }
        lastGoodRef.current = merged;
        saveCache(merged);
        return merged;
      });
    })();

    inflightRef.current = run;
    run.finally(() => { inflightRef.current = null; });

    return () => { dead = true; };
  }, [owner, provider, ercAddrs, DEFAULT_MC3, tokens]);

  return map; // addr-lower → BigInt balance (native = map.native)
}
