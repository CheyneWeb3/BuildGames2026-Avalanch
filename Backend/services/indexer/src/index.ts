import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { ethers } from 'ethers';
import { SystemConfigSchema, type SystemConfig } from '@hauscashier/common';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// vault.min.json may not include param names, so we must support positional args.
// NOTE: keep ABI outside dist so `tsc` doesn't need to copy JSON assets.
// dist/index.js lives in services/indexer/dist, so `../abi/*` resolves to services/indexer/abi.
const ABI = require('../abi/vault.min.json');

type CursorFile = Record<string, number>; // `${chainId}:${vaultId}` -> last processed block

function loadConfig(): SystemConfig {
  const cfgPath = process.env.CONFIG_PATH
    ? path.resolve(process.env.CONFIG_PATH)
    : path.resolve(__dirname, '../../core-api/config/system.json');
  const raw = fs.readFileSync(cfgPath, 'utf8');
  return SystemConfigSchema.parse(JSON.parse(raw));
}

const CURSORS_PATH = path.resolve(process.cwd(), 'cursors.json');

function loadCursors(): CursorFile {
  if (!fs.existsSync(CURSORS_PATH)) return {};
  const c = JSON.parse(fs.readFileSync(CURSORS_PATH, 'utf8')) as CursorFile;

  // Backward-compat: if an old cursor key exists like "bsc-hauscashier-v3",
  // migrate it into the new scoped key if missing.
  for (const k of Object.keys(c)) {
    if (k.includes(':')) continue;
    // best-effort migrate (only if we can infer chainId from config at runtime later)
    // We'll also keep it around, but processVault will prefer the scoped key.
  }

  return c;
}

function saveCursors(c: CursorFile) {
  fs.writeFileSync(CURSORS_PATH, JSON.stringify(c, null, 2));
}

function cursorKey(chainId: number, vaultId: string) {
  return `${chainId}:${vaultId}`;
}

function argString(args: any, name: string, idx: number): string {
  const v = args?.[name] ?? args?.[idx];
  return v === undefined || v === null ? '' : String(v);
}

function argNumber(args: any, name: string, idx: number): number {
  const v = args?.[name] ?? args?.[idx];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function argBool(args: any, name: string, idx: number): boolean {
  const v = args?.[name] ?? args?.[idx];
  return Boolean(v);
}

async function postEvent(coreUrl: string, key: string, payload: any) {
  const res = await fetch(`${coreUrl}/internal/indexer/event`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-indexer-key': key
    },
    body: JSON.stringify(payload)
  });

  if (res.ok) return;

  const t = await res.text().catch(() => '');

  // Replays may produce 409 DUPLICATE; treat as success.
  if (res.status === 409) {
    // core might reply plain text "DUPLICATE" or JSON body containing it
    if (t.toUpperCase().includes('DUPLICATE')) return;
    try {
      const j = JSON.parse(t);
      const s = JSON.stringify(j).toUpperCase();
      if (s.includes('DUPLICATE')) return;
    } catch {}
    // even if body doesn't contain the string, 409 should never brick the indexer
    return;
  }

  throw new Error(`core rejected event ${res.status}: ${t}`);
}

async function processVault(cfg: SystemConfig, cursors: CursorFile, chainId: number, vaultId: string) {
  const coreUrl = process.env.CORE_API_URL || 'http://localhost:8088';
  const key = process.env.INDEXER_SHARED_KEY || '';
  if (!key) throw new Error('INDEXER_SHARED_KEY missing');

  const chain = cfg.chains.find(c => c.chainId === chainId);
  if (!chain || !chain.enabled) return;

  const vault = chain.vaults.find(v => v.id === vaultId);
  if (!vault || !vault.enabled) return;

  const provider = new ethers.JsonRpcProvider(chain.rpcHttp);
  const contract = new ethers.Contract(vault.address, ABI, provider);

  const latest = await provider.getBlockNumber();
  const startBlock = Number(process.env.START_BLOCK || 0);
  const chunk = Math.max(1, Number(process.env.BLOCK_CHUNK || 2000));

  const scopedKey = cursorKey(chainId, vaultId);

  // Backward compat: if old key exists (vaultId only), use it IF scoped key is missing
  const oldKey = vaultId;
  const last =
    cursors[scopedKey] ??
    cursors[oldKey] ??
    startBlock;

  const fromBlock = Math.max(last + 1, startBlock);
  const toBlock = Math.min(fromBlock + chunk, latest);
  if (fromBlock > toBlock) return;

  log.info({ chainId, vaultId, fromBlock, toBlock }, 'indexing');

  // If the RPC prunes old history, eth_getLogs / queryFilter will hard-fail and the indexer
  // will loop forever on the same block range. When that happens, we "jump" the cursor close
  // to the tip so the system stays live (safe Option A).
  const isPrunedHistoryError = (e: any) => {
    const msg = String(e?.error?.message || e?.message || '').toLowerCase();
    const code = String(e?.error?.code || e?.code || '');
    return (
      code === '-32701' ||
      msg.includes('history has been pruned') ||
      msg.includes('pruned')
    );
  };

  const jumpCursorNearTip = async (reason: string) => {
    const newCursor = Math.max(latest - 5000, startBlock);
    cursors[scopedKey] = newCursor;
    // keep backward-compat key in sync too
    cursors[oldKey] = newCursor;
    saveCursors(cursors);
    log.warn({ chainId, vaultId, reason, newCursor }, 'rpc history pruned; advanced cursor near tip');
  };

  const queryFilterSafe = async (filter: any) => {
    try {
      return await contract.queryFilter(filter, fromBlock, toBlock);
    } catch (e: any) {
      if (isPrunedHistoryError(e)) {
        await jumpCursorNearTip(String(e?.error?.message || e?.message || 'pruned history'));
        return null;
      }
      throw e;
    }
  };

  // Deposited(creditTo, token, amountReceived, from)
  const depositedLogs = await queryFilterSafe(contract.filters.Deposited());
  if (!depositedLogs) return;
  for (const l of depositedLogs) {
    const args = (l as any).args;
    await postEvent(coreUrl, key, {
      chainId,
      vaultId,
      vaultAddress: vault.address,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
      logIndex: (l as any).index ?? (l as any).logIndex ?? 0,
      name: 'Deposited',
      args: {
        creditTo: argString(args, 'creditTo', 0),
        token: argString(args, 'token', 1),
        amountReceived: argString(args, 'amountReceived', 2),
        from: argString(args, 'from', 3)
      }
    });
  }

  // TokenEnabled(token, decimals) / TokenDisabled(token)
  try {
    const enabledLogs = await queryFilterSafe(contract.filters.TokenEnabled());
    if (!enabledLogs) return;
    for (const l of enabledLogs) {
      const args = (l as any).args;
      await postEvent(coreUrl, key, {
        chainId,
        vaultId,
        vaultAddress: vault.address,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: (l as any).index ?? (l as any).logIndex ?? 0,
        name: 'TokenEnabled',
        args: {
          token: argString(args, 'token', 0),
          decimals: argNumber(args, 'decimals', 1)
        }
      });
    }

    const disabledLogs = await queryFilterSafe(contract.filters.TokenDisabled());
    if (!disabledLogs) return;
    for (const l of disabledLogs) {
      const args = (l as any).args;
      await postEvent(coreUrl, key, {
        chainId,
        vaultId,
        vaultAddress: vault.address,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: (l as any).index ?? (l as any).logIndex ?? 0,
        name: 'TokenDisabled',
        args: {
          token: argString(args, 'token', 0)
        }
      });
    }
  } catch {
    // If the deployed vault ABI doesn't include these events, ignore.
  }

  // Withdrawn(ownerWallet, token, to, amount, nonceOrSessionNonce, usedSession)
  const withdrawnLogs = await queryFilterSafe(contract.filters.Withdrawn());
  if (!withdrawnLogs) return;
  for (const l of withdrawnLogs) {
    const args = (l as any).args;
    await postEvent(coreUrl, key, {
      chainId,
      vaultId,
      vaultAddress: vault.address,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
      logIndex: (l as any).index ?? (l as any).logIndex ?? 0,
      name: 'Withdrawn',
      args: {
        ownerWallet: argString(args, 'ownerWallet', 0),
        token: argString(args, 'token', 1),
        to: argString(args, 'to', 2),
        amount: argString(args, 'amount', 3),
        nonceOrSessionNonce: argString(args, 'nonceOrSessionNonce', 4),
        usedSession: argBool(args, 'usedSession', 5)
      }
    });
  }

  // CCIPReceived(sourceSelector, messageId, creditedTo, token, amount)
  const ccipReceivedLogs = await queryFilterSafe(contract.filters.CCIPReceived());
  if (!ccipReceivedLogs) return;
  for (const l of ccipReceivedLogs) {
    const args = (l as any).args;
    await postEvent(coreUrl, key, {
      chainId,
      vaultId,
      vaultAddress: vault.address,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
      logIndex: (l as any).index ?? (l as any).logIndex ?? 0,
      name: 'CCIPReceived',
      args: {
        sourceSelector: argString(args, 'sourceSelector', 0),
        messageId: argString(args, 'messageId', 1),
        creditedTo: argString(args, 'creditedTo', 2),
        token: argString(args, 'token', 3),
        amount: argString(args, 'amount', 4)
      }
    });
  }

  // Advance cursor toBlock once the range is processed successfully.
  cursors[scopedKey] = toBlock;

  // Optional: keep old key in sync so you don't get two conflicting keys forever
  if (cursors[oldKey] !== undefined) cursors[oldKey] = toBlock;
}

async function main() {
  const cfg = loadConfig();
  const cursors = loadCursors();
  const pollMs = Number(process.env.POLL_MS || 3000);

  while (true) {
    try {
      for (const chain of cfg.chains) {
        if (!chain.enabled) continue;
        for (const v of chain.vaults) {
          if (!v.enabled) continue;
          await processVault(cfg, cursors, chain.chainId, v.id);
        }
      }
      saveCursors(cursors);
    } catch (e: any) {
      log.error({ err: e?.message || e }, 'indexer loop error');
    }

    await new Promise(r => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  log.fatal({ err: e?.message || e }, 'fatal');
  process.exit(1);
});
