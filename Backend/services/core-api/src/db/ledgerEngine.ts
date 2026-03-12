import type { Db, ClientSession } from 'mongodb';
import { userAccountId } from '@hauscashier/common';
import type { MongoCollections, BalanceDoc, LedgerDoc } from './mongo';

export type LedgerEntryInput = {
  refId: string; // idempotency key
  kind: string; // deposit, withdraw, transfer, game_bet...
  chainId: number;
  token: string; // address
  moduleId?: string;
  fromAccountId?: string; // optional (mint)
  toAccountId?: string; // optional (burn)
  amountRaw: string; // uint256-as-dec-string
  meta?: Record<string, any>;
};

export class LedgerError extends Error {
  public code: string;
  public statusCode: number;
  public details?: Record<string, any>;
  constructor(code: string, message: string, statusCode = 400, details?: Record<string, any>) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function isLedgerError(e: any): e is LedgerError {
  return !!e && (e instanceof LedgerError || (typeof e === 'object' && e.name === 'LedgerError' && typeof (e as any).code === 'string'));
}


export function toBigIntString(v: string): bigint {
  if (!/^[0-9]+$/.test(v)) throw new Error('amountRaw must be uint256-dec-string');
  return BigInt(v);
}

export async function applyLedgerEntry(db: Db, c: MongoCollections, session: ClientSession, input: LedgerEntryInput): Promise<LedgerDoc> {
  const amount = toBigIntString(input.amountRaw);
  if (amount <= 0n) throw new Error('amountRaw must be > 0');

  // idempotency: if refId already exists, return it (do not re-apply)
  const existing = await c.ledger.findOne({ _id: input.refId }, { session });
  if (existing) return existing;

  const now = new Date();
  const doc: LedgerDoc = {
    _id: input.refId,
    refId: input.refId,
    ts: now,
    kind: input.kind,
    chainId: input.chainId,
    token: input.token.toLowerCase(),
    moduleId: input.moduleId,
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amountRaw: amount.toString(),
    meta: input.meta
  };

  // Update balances (mint/burn supported)
  if (input.fromAccountId) {
    await bumpBalance(c, session, input.fromAccountId, input.chainId, input.token, -amount);
  }
  if (input.toAccountId) {
    await bumpBalance(c, session, input.toAccountId, input.chainId, input.token, amount);
  }

  await c.ledger.insertOne(doc, { session });
  return doc;
}

/**
 * Transaction wrapper used by HTTP routes.
 * Ensures idempotency by refId and performs balance deltas atomically.
 */
export async function applyLedgerEntryTx(db: Db, c: MongoCollections, input: LedgerEntryInput): Promise<{ ledger: LedgerDoc }> {
  const session = db.client.startSession();
  try {
    let out: LedgerDoc | null = null;

    await session.withTransaction(async () => {
      // detect idempotent replays so we don't enqueue duplicate notifications
      const existing = await c.ledger.findOne({ _id: input.refId }, { session });
      if (existing) {
        out = existing;
        return;
      }

      out = await applyLedgerEntry(db, c, session, input);

      // Enqueue TG DM notifications.
      // - If recipient is linked user account (user:0x...) and user has one or more tgLinks
      // - OR if recipient is a tg holding account (tg:<moduleId>:<tgId>) for pre-link tips
      const toAcc = String(input.toAccountId || '').trim();
      if (toAcc.startsWith('user:')) {
        const ownerWallet = toAcc.slice(5).toLowerCase();
        const links = await c.tgLinks.find({ ownerWallet } as any, { session }).toArray();

        for (const link of links) {
          const moduleId = String((link as any).moduleId || '');
          const tgId = String((link as any).tgId || '');
          if (!moduleId || !tgId) continue;

          const outboxId = `${moduleId}:${tgId}:${input.refId}`;
          await c.tgNotifyOutbox.updateOne(
            { _id: outboxId },
            {
              $setOnInsert: {
                _id: outboxId,
                moduleId,
                tgId,
                ownerWallet,
                refId: input.refId,
                kind: input.kind,
                chainId: input.chainId,
                token: String(input.token || '').toLowerCase(),
                amountRaw: String(input.amountRaw || '0'),
                fromAccountId: input.fromAccountId || null,
                toAccountId: input.toAccountId || null,
                status: 'pending',
                createdAt: new Date(),
                meta: input.meta || undefined
              }
            },
            { upsert: true, session }
          );
        }
      } else if (toAcc.startsWith('tg:')) {
        const parts = toAcc.split(':');
        const moduleId = String(parts[1] || '').trim();
        const tgId = String(parts[2] || '').trim();
        if (moduleId && tgId) {
          const link = await c.tgLinks.findOne({ moduleId, tgId } as any, { session });
          const ownerWallet = String((link as any)?.ownerWallet || '').toLowerCase();

          const outboxId = `${moduleId}:${tgId}:${input.refId}`;
          await c.tgNotifyOutbox.updateOne(
            { _id: outboxId },
            {
              $setOnInsert: {
                _id: outboxId,
                moduleId,
                tgId,
                ownerWallet,
                refId: input.refId,
                kind: input.kind,
                chainId: input.chainId,
                token: String(input.token || '').toLowerCase(),
                amountRaw: String(input.amountRaw || '0'),
                fromAccountId: input.fromAccountId || null,
                toAccountId: input.toAccountId || null,
                status: 'pending',
                createdAt: new Date(),
                meta: input.meta || undefined
              }
            },
            { upsert: true, session }
          );
        }
      }
    });

    return { ledger: out! };
  } finally {
    await session.endSession();
  }
}

async function bumpBalance(
  c: MongoCollections,
  session: ClientSession,
  accountId: string,
  chainId: number,
  token: string,
  delta: bigint
) {
  const key = { accountId, chainId, token: token.toLowerCase() };
  const cur = await c.balances.findOne(key, { session });
  const curBal = cur ? BigInt(cur.balanceRaw) : 0n;
  const next = curBal + delta;
  if (next < 0n) throw new LedgerError('INSUFFICIENT_BALANCE', `INSUFFICIENT_BALANCE: ${accountId}`, 409, { accountId });

  const update: Partial<BalanceDoc> = {
    accountId,
    chainId,
    token: token.toLowerCase(),
    balanceRaw: next.toString(),
    updatedAt: new Date()
  };
  if (cur) {
    await c.balances.updateOne({ _id: cur._id }, { $set: update }, { session });
  } else {
    await c.balances.insertOne({
      _id: `${accountId}:${chainId}:${token.toLowerCase()}`,
      ...update,
      createdAt: new Date()
    } as BalanceDoc, { session });
  }
}

export function accountIdFromAddress(address: string): string {
  return userAccountId(address);
}
