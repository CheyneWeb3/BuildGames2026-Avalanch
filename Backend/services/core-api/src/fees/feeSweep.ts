import { ethers } from 'ethers';
import crypto from 'crypto';

import type { Db } from 'mongodb';

import { normalizeAddress, treasuryAccountId } from '@hauscashier/common';

import type { MongoCollections } from '../db/mongo';
import { applyLedgerEntryTx } from '../db/ledgerEngine';
import { decryptBox } from '../security/cryptoBox';
import {
  getEip712Domain,
  getSessionState,
  getSessionTokenCaps,
  typedDataSessionWithdraw,
} from '../vault/eip712';

const DEST_ALLOWED_ABI = [
  'function destAllowed(address ownerWallet, address dest) view returns (bool)',
];

export type FeeSweepEnv = {
  enabled: boolean;
  auto: boolean;
  everyHours: number;
  chainId?: number;
  vaultId: string;
  ownerWallet: string;
  to: string;
  deadlineSecs: number;
  feeTreasuryId: string;
  dryRun: boolean;
};

export function readFeeSweepEnv(): FeeSweepEnv {
  const enabled = (process.env.FEE_SWEEP_ENABLED ?? '0') === '1';
  const auto = (process.env.FEE_SWEEP_AUTO ?? '0') === '1';
  const everyHours = Number(process.env.FEE_SWEEP_EVERY_HOURS ?? '38');
  const chainId = process.env.FEE_SWEEP_CHAIN_ID
    ? Number(process.env.FEE_SWEEP_CHAIN_ID)
    : undefined;
  const vaultId = process.env.FEE_SWEEP_VAULT_ID ?? 'main';
  const ownerWallet = process.env.FEE_SWEEP_OWNER_WALLET ?? '';
  const to = process.env.FEE_SWEEP_TO ?? '';
  const deadlineSecs = Number(process.env.FEE_SWEEP_DEADLINE_SECS ?? '1800');
  const feeTreasuryId = process.env.FEE_TREASURY_ID ?? 'fees';
  const dryRun = (process.env.FEE_SWEEP_DRY_RUN ?? '0') === '1';

  if (!Number.isFinite(everyHours) || everyHours <= 0) {
    throw new Error('FEE_SWEEP_EVERY_HOURS must be a positive number');
  }
  if (!Number.isFinite(deadlineSecs) || deadlineSecs <= 0) {
    throw new Error('FEE_SWEEP_DEADLINE_SECS must be a positive number');
  }

  return {
    enabled,
    auto,
    everyHours,
    chainId,
    vaultId,
    ownerWallet,
    to,
    deadlineSecs,
    feeTreasuryId,
    dryRun,
  };
}

export type FeeSweepTokenResult = {
  token: string;
  requestedRaw: string;
  sweepRaw: string;
  skipped?: string;
  intentId?: string;
  refId?: string;
};

export type FeeSweepResult = {
  ok: boolean;
  reason: string;
  chainId: number;
  vaultId: string;
  ownerWallet: string;
  to: string;
  window: number;
  tokens: FeeSweepTokenResult[];
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sweepWindow(everyHours: number): number {
  const everySeconds = Math.floor(everyHours * 3600);
  return Math.floor(nowSeconds() / everySeconds);
}

function parseMaybeAddress(v: string, name: string): string {
  if (!v) throw new Error(`${name} is required`);
  return ethers.getAddress(v);
}

function newIntentId(): string {
  // short, url-safe enough for mongo _id
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Sweeps the fee treasury using a pre-registered on-chain session key.
 *
 * Requirements (on-chain):
 * - ownerWallet has registered a sessionKey and configured token caps.
 * - ownerWallet has allowed the destination (setDestAllowed), unless to == ownerWallet.
 */
export async function sweepFeeTreasuryOnce(args: {
  db: Db;
  col: MongoCollections;
  cfg: any; // SystemConfig (kept as any to avoid tight coupling)
  reason: string;
  tokenFilter?: string[];
  dryRun?: boolean;
}): Promise<FeeSweepResult> {
  const { db, col, cfg, reason, tokenFilter } = args;
  const env = readFeeSweepEnv();
  const effectiveDryRun = args.dryRun ?? env.dryRun;

  const chainId = env.chainId ?? cfg.chainId;

  if (!env.enabled) {
    return {
      ok: false,
      reason: 'disabled',
      chainId,
      vaultId: env.vaultId,
      ownerWallet: env.ownerWallet,
      to: env.to,
      window: sweepWindow(env.everyHours),
      tokens: [],
    };
  }

  const chain = cfg.chains?.find((c: any) => c.chainId === chainId);
  if (!chain) throw new Error(`Unknown chainId ${chainId}`);
  const vault = chain.vaults?.find((v: any) => v.id === env.vaultId);
  if (!vault) throw new Error(`Unknown vaultId ${env.vaultId} on chain ${chainId}`);

  const ownerWallet = parseMaybeAddress(env.ownerWallet, 'FEE_SWEEP_OWNER_WALLET');
  const to = parseMaybeAddress(env.to, 'FEE_SWEEP_TO');

  // session key (server-held, encrypted)
  const sessionId = `${normalizeAddress(ownerWallet)}:${chainId}:${env.vaultId}`;
  const sk = await col.sessionKeys.findOne({ _id: sessionId });
  if (!sk) {
    throw new Error(
      `Missing session key for ${sessionId}. Create it via POST /vault/intents/session/register (owner signs register typedData).`
    );
  }
  if (!process.env.SESSION_KEY_ENC_SECRET) {
    throw new Error('Missing SESSION_KEY_ENC_SECRET');
  }

  const sessionPriv = decryptBox(sk.encPriv, process.env.SESSION_KEY_ENC_SECRET);
  const sessionWallet = new ethers.Wallet(sessionPriv);

  const provider = new ethers.JsonRpcProvider(chain.rpcHttp);
  const vaultRead = new ethers.Contract(vault.address, DEST_ALLOWED_ABI, provider);

  // Ensure destination is allowed, unless withdrawing to self.
  if (normalizeAddress(to) !== normalizeAddress(ownerWallet)) {
    const allowed = (await vaultRead.destAllowed(ownerWallet, to)) as boolean;
    if (!allowed) {
      throw new Error(
        `Destination not allowed for ownerWallet. Call setDestAllowed(${to}, true) from ${ownerWallet} first.`
      );
    }
  }

  const feeAcc = treasuryAccountId(env.feeTreasuryId);
  const escrowAcc = `${feeAcc}:escrow`;
  const window = sweepWindow(env.everyHours);

  // Token list comes from indexer-tracked enabled tokens.
  const enabled = await col.vaultTokens
    .find({ chainId, vaultId: env.vaultId, enabled: true })
    .project({ token: 1 })
    .toArray();

  const enabledTokens = enabled.map((x: any) => ethers.getAddress(x.token));
  const wanted = tokenFilter?.length
    ? tokenFilter.map((t) => ethers.getAddress(t))
    : enabledTokens;

  const results: FeeSweepTokenResult[] = [];

  const domain = await getEip712Domain(vault.address, provider);
  const s = await getSessionState(vault.address, provider, ownerWallet, sk.sessionKey);
  let nextNonce = s.nonce; // IMPORTANT: increment locally per-created intent

  for (const token of wanted) {
    const balance = await col.balances.findOne({ chainId, accountId: feeAcc, token });
    const balanceRaw = balance?.balanceRaw ?? '0';

    // nothing to sweep
    if (ethers.toBigInt(balanceRaw) <= 0n) {
      results.push({ token, requestedRaw: balanceRaw, sweepRaw: '0', skipped: 'zero' });
      continue;
    }

    // On-chain caps / remaining.
    const caps = await getSessionTokenCaps(vault.address, provider, ownerWallet, sk.sessionKey, s.epoch, token);
    if (!caps.allowed) {
      results.push({ token, requestedRaw: balanceRaw, sweepRaw: '0', skipped: 'token_not_allowed_in_session' });
      continue;
    }

    const requested = ethers.toBigInt(balanceRaw);
    const remaining = caps.remaining;
    const maxPerTx = caps.maxPerTx;

    if (remaining <= 0n || maxPerTx <= 0n) {
      results.push({ token, requestedRaw: balanceRaw, sweepRaw: '0', skipped: 'session_limit_zero' });
      continue;
    }

    const amount = requested < remaining ? requested : remaining;
    const sweepAmt = amount < maxPerTx ? amount : maxPerTx;

    if (sweepAmt <= 0n) {
      results.push({ token, requestedRaw: balanceRaw, sweepRaw: '0', skipped: 'session_limit' });
      continue;
    }

    const refId = `feeSweep:${chainId}:${env.vaultId}:${window}:${normalizeAddress(token)}`;

    // If intent already exists, skip (unless it previously failed).
    const existing = await col.vaultIntents.findOne({ refId });
    if (existing && existing.status !== 'failed') {
      results.push({
        token,
        requestedRaw: balanceRaw,
        sweepRaw: balanceRaw,
        skipped: 'already_created',
        intentId: existing._id,
        refId,
      });
      continue;
    }

    // For fee sweeps we do NOT apply an additional withdraw fee at the ledger layer (fee treasury -> on-chain dest).
    const debitRaw = sweepAmt.toString();
    const netRaw = debitRaw;

    const deadline = nowSeconds() + env.deadlineSecs;

    const typed = typedDataSessionWithdraw(domain, {
      ownerWallet,
      sessionKey: sk.sessionKey,
      epoch: s.epoch.toString(),
      token,
      to,
      amount: netRaw,
      sessionNonce: nextNonce.toString(),
      deadline: deadline.toString(),
    });

    const sessionSig = await sessionWallet.signTypedData(typed.domain, typed.types as any, typed.message);

    if (effectiveDryRun) {
      results.push({ token, requestedRaw: balanceRaw, sweepRaw: netRaw, skipped: 'dry_run', refId });
      continue;
    }

    // Create / revive intent + hold credits atomically.
    const intentId = existing?._id ?? newIntentId();

    const now = new Date();

    if (!existing) {
      await col.vaultIntents.insertOne({
        _id: intentId,
        refId,
        createdAt: now,
        updatedAt: now,
        status: 'failed',
        error: 'funding',
        chainId,
        vaultId: env.vaultId,
        vaultAddress: vault.address,
        action: 'withdrawWithSessionSig',
        accountId: feeAcc,

        ownerWallet,
        sessionKey: sk.sessionKey,
        sessionSig,
        sig: '0x',
        epoch: s.epoch.toString(),
        sessionNonce: nextNonce.toString(),
        deadline: deadline,

        token,
        contractToken: token,
        to,

        amountRaw: netRaw,
        debitRaw,
        feeRaw: '0',
        netRaw,

        escrowed: true,
        settled: false,
      } as any);
    } else {
      await col.vaultIntents.updateOne(
        { _id: intentId },
        {
          $set: {
            updatedAt: now,
            status: 'failed',
            error: 'funding',
            action: 'withdrawWithSessionSig',
            accountId: feeAcc,

            ownerWallet,
            sessionKey: sk.sessionKey,
            sessionSig,
            sig: '0x',
            epoch: s.epoch.toString(),
            sessionNonce: nextNonce.toString(),
            deadline: deadline,

            token,
            contractToken: token,
            to,

            amountRaw: netRaw,
            debitRaw,
            feeRaw: '0',
            netRaw,

            escrowed: true,
            settled: false,
          },
        }
      );
    }

    // Hold NET in escrow so relayer can only execute what is backed by credits.
    await applyLedgerEntryTx(db, col, {
      kind: 'withdraw_hold',
      chainId,
      token,
      fromAccountId: feeAcc,
      toAccountId: escrowAcc,
      amountRaw: netRaw,
      refId: `hold:${refId}`,
      meta: { kind: 'fee_sweep', reason },
    });

    await col.vaultIntents.updateOne(
      { _id: intentId },
      { $set: { status: 'pending', error: undefined, updatedAt: new Date() } }
    );


    results.push({ token, requestedRaw: balanceRaw, sweepRaw: netRaw, intentId, refId });

    // bump nonce for next intent we create
    nextNonce = nextNonce + 1n;


    // bump nonce for next intent we create
    nextNonce = nextNonce + 1n;
  }

  return {
    ok: true,
    reason,
    chainId,
    vaultId: env.vaultId,
    ownerWallet,
    to,
    window,
    tokens: results,
  };
}
