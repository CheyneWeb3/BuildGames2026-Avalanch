import { z } from 'zod';
import type { Db } from 'mongodb';
import type { MongoCollections, SaasChatDoc, SaasChatRail } from '../db/mongo';
import { applyLedgerEntryTx } from '../db/ledgerEngine';
import { normalizeAddress, treasuryAccountId, userAccountId } from '@hauscashier/common';

// -----------------------------
// SaaS plans (v0)
// -----------------------------

export const SaaSPlanSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // Raw amount in the selected payment token (e.g. USDC 6 decimals)
  pricePerDayRaw: z.string().regex(/^\d+$/),
  // Platform cuts + optional group revenue share
  chatRevenueShareBps: z.number().int().min(0).max(10_000).default(0),
  includedModules: z.array(z.string()).default([]),
});
export type SaaSPlan = z.infer<typeof SaaSPlanSchema>;

export const DEFAULT_SAAS_PLANS: SaaSPlan[] = [
  {
    id: 'basic',
    name: 'Basic SaaS Bot',
    // ~US$2/day, paid in credits (USDC rail recommended)
    pricePerDayRaw: '2000000',
    // Example: 10% share into the chat bucket
    chatRevenueShareBps: 1000,
    includedModules: ['tips', 'gift', 'dice', 'blackjack', 'whack', 'lottery'],
  },
];

export function getPlanOrThrow(planId: string): SaaSPlan {
  const p = DEFAULT_SAAS_PLANS.find((x) => x.id === planId);
  if (!p) throw new Error('UNKNOWN_PLAN');
  return p;
}

// -----------------------------
// Rail + treasury ids
// -----------------------------

export function railKey(chainId: number, token: string): string {
  return `${chainId}:${token.toLowerCase()}`;
}

export function saasFeeTreasuryId(chainId: number, token: string): string {
  return `saas_fee_${chainId}_${token.toLowerCase()}`;
}

export function saasChatTreasuryId(chatId: string, chainId: number, token: string): string {
  return `saas_chat_${chatId}_${chainId}_${token.toLowerCase()}`;
}

export async function ensureTreasury(
  col: MongoCollections,
  args: { treasuryId: string; moduleId: string; chainId: number; token: string; label?: string }
): Promise<void> {
  const existing = await col.treasuries.findOne({ _id: args.treasuryId });
  if (existing) return;
  await col.treasuries.insertOne({
    _id: args.treasuryId,
    moduleId: args.moduleId,
    label: args.label ?? args.treasuryId,
    chainId: args.chainId,
    token: normalizeAddress(args.token),
    enabled: true,
    createdAt: new Date(),
  });
}

export async function upsertSaasChat(
  col: MongoCollections,
  args: {
    chatId: string;
    title?: string;
    adminAddress: string;
    planId: string;
    rail: SaasChatRail;
  }
): Promise<SaasChatDoc> {
  const now = Date.now();
  const doc: SaasChatDoc = {
    _id: args.chatId,
    chatId: args.chatId,
    title: args.title,
    adminAddress: normalizeAddress(args.adminAddress),
    planId: args.planId,
    status: 'expired',
    expiresAt: 0,
    createdAt: now,
    updatedAt: now,
    rails: {
      [railKey(args.rail.chainId, args.rail.token)]: args.rail,
    },
  };

  await col.saasChats.updateOne(
    { _id: args.chatId },
    {
      $setOnInsert: {
        _id: doc._id,
        chatId: doc.chatId,
        createdAt: now,
      },
      $set: {
        title: args.title,
        adminAddress: doc.adminAddress,
        planId: doc.planId,
        updatedAt: now,
        [`rails.${railKey(args.rail.chainId, args.rail.token)}`]: args.rail,
      },
    },
    { upsert: true }
  );

  const out = await col.saasChats.findOne({ _id: args.chatId });
  if (!out) throw new Error('SAAS_UPSERT_FAILED');
  return out;
}

export async function getSaasChat(col: MongoCollections, chatId: string): Promise<SaasChatDoc | null> {
  return col.saasChats.findOne({ _id: chatId });
}

export async function setSkin(
  col: MongoCollections,
  chatId: string,
  skin: Record<string, any>
): Promise<void> {
  await col.saasChats.updateOne(
    { _id: chatId },
    { $set: { skin, updatedAt: Date.now() } }
  );
}

// -----------------------------
// Subscription payments (credits)
// -----------------------------

export async function subscribeWithCredits(
  db: Db,
  col: MongoCollections,
  args: {
    chatId: string;
    payerAddress: string;
    planId: string;
    chainId: number;
    token: string;
    daysToAdd: number;
    refId: string;
  }
): Promise<{ expiresAt: number; costRaw: bigint; daysAdded: number }> {
  if (args.daysToAdd <= 0) throw new Error('BAD_DAYS');

  const plan = getPlanOrThrow(args.planId);
  const pricePerDay = BigInt(plan.pricePerDayRaw);
  const cost = pricePerDay * BigInt(args.daysToAdd);

  const chat = await getSaasChat(col, args.chatId);
  if (!chat) throw new Error('CHAT_NOT_REGISTERED');

  const rk = railKey(args.chainId, args.token);
  const rail = chat.rails?.[rk];
  if (!rail) throw new Error('RAIL_NOT_CONFIGURED');

  // 1) Debit payer -> fee treasury
  await applyLedgerEntryTx(db, col, {
    refId: `${args.refId}:fee`,
    kind: 'transfer',
    moduleId: 'saas',
    chainId: args.chainId,
    token: args.token,
    fromAccountId: userAccountId(normalizeAddress(args.payerAddress)),
    toAccountId: treasuryAccountId(rail.feeTreasuryId),
    amountRaw: cost.toString(),
    meta: { chatId: args.chatId, planId: args.planId, days: args.daysToAdd, role: 'fee' },
  });

  // 2) Optional revenue share: fee treasury -> chat treasury
  const share = (cost * BigInt(plan.chatRevenueShareBps)) / BigInt(10_000);
  if (share > 0n) {
    await applyLedgerEntryTx(db, col, {
      refId: `${args.refId}:share`,
      kind: 'transfer',
      moduleId: 'saas',
      chainId: args.chainId,
      token: args.token,
      fromAccountId: treasuryAccountId(rail.feeTreasuryId),
      toAccountId: treasuryAccountId(rail.chatTreasuryId),
      amountRaw: share.toString(),
      meta: { chatId: args.chatId, planId: args.planId, days: args.daysToAdd, role: 'chat_share' },
    });
  }

  const now = Date.now();
  const base = Math.max(now, chat.expiresAt || 0);
  const next = base + args.daysToAdd * 86_400_000;
  const status: SaasChatDoc['status'] = next > now ? 'active' : 'expired';

  await col.saasChats.updateOne(
    { _id: args.chatId },
    {
      $set: {
        expiresAt: next,
        status,
        updatedAt: now,
      },
    }
  );

  return { expiresAt: next, costRaw: cost, daysAdded: args.daysToAdd };
}
