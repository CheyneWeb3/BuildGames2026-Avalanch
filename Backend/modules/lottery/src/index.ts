import type { Router } from 'express';
import type { Db } from 'mongodb';
import { Markup, type Telegraf } from 'telegraf';
import { treasuryAccountId, userAccountId } from '@hauscashier/common';
import { z } from 'zod';

export const LOTTERY_ADMIN_ROOT_CB = 'lottery_admin_root';

type RequireModuleMw = any;
type ApplyLedgerEntry = (opts: {
  db: Db;
  col: any;
  refId: string;
  ts?: Date;
  chainId: number;
  token: string;
  amountRaw: string;
  fromAccountId: string;
  toAccountId: string;
  kind: string;
  meta?: any;
}) => Promise<any>;

type CoreDeps = {
  r: Router;
  db: Db;
  col: any;
  cfg: any;
  requireModuleMw: RequireModuleMw;
  applyLedgerEntry: ApplyLedgerEntry;
};

type TgCfg = {
  coreApiUrl: string;
  moduleId: string;
  moduleKey: string;
  chainId: number;
  token: string;
  treasuryId: string;
  enableRain?: boolean;
  enableMonsoon?: boolean;
};

const lotteryChatCfgSchema = z.object({
  chatId: z.string().min(1),
  defaultChainId: z.number().int().positive().optional(),
  defaultToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  defaultTicketPriceRaw: z.string().regex(/^\d+$/).optional(),
  defaultDurationSec: z.number().int().min(60).max(60*60*24*30).optional(),
  defaultTitle: z.string().max(120).nullable().optional(),
  buttonTicketOptions: z.array(z.number().int().positive()).max(8).optional(),
  updatedByTgId: z.string().optional(),
});

const createReqSchema = z.object({
  chatId: z.string().min(1),
  chainId: z.number().int().positive(),
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  ticketPriceRaw: z.string().regex(/^\d+$/),
  durationSec: z.number().int().min(60).max(60 * 60 * 24 * 30),
  title: z.string().max(160).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  imageUrl: z.string().url().max(500).optional().nullable(),
  buttonTicketOptions: z.array(z.number().int().positive().max(1000)).max(8).optional().nullable(),
  shillEnabled: z.boolean().optional(),
  shillIntervalSec: z.number().int().min(60).max(86400).optional()
});

function nowIso() { return new Date().toISOString(); }
function rid(prefix: string) { return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`; }
function isAdmin(cfg: any, tgId?: string) {
  const s = new Set(String(process.env.TG_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
  return !!tgId && s.has(String(tgId));
}

function isSuperAdmin(tgId?: string) {
  const s = new Set(String(process.env.TG_SUPER_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
  return !!tgId && s.has(String(tgId));
}

function parseHumanToRaw(amount: string, decimals: number): string {
  const s = String(amount || '').trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('BAD_AMOUNT');
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error('TOO_MANY_DECIMALS');
  const combined = `${w}${f.padEnd(decimals, '0')}`.replace(/^0+/, '') || '0';
  return BigInt(combined).toString();
}
function formatRaw(amountRaw: string, decimals: number): string {
  const n = BigInt(String(amountRaw || '0'));
  const d = BigInt(10) ** BigInt(decimals);
  const w = n / d;
  const f = (n % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}

function getChain(cfg: any, chainId: number) {
  return (cfg?.chains || []).find((c: any) => Number(c?.chainId) === Number(chainId) && c?.enabled !== false);
}
function getTokenMeta(cfg: any, chainId: number, token: string) {
  const c = getChain(cfg, chainId);
  const low = String(token).toLowerCase();
  const t = (c?.tokens || []).find((x: any) => String(x?.address || '').toLowerCase() === low && x?.enabled !== false);
  return t || null;
}
function getVaultId(v: any): string {
  return String(v?.id || v?.vaultId || '').trim();
}

// Dynamic enabled-token check:
// - Always allow vault.usdc and vault.wNative (they are part of the vault config)
// - For all other ERC20s, rely on indexed TokenEnabled/TokenDisabled state (col.vaultTokens)
async function tokenEnabledOnAnyVaultDb(col: any, cfg: any, chainId: number, token: string) {
  const c = getChain(cfg, chainId);
  const low = String(token).toLowerCase();
  for (const v of (c?.vaults || [])) {
    if (v?.enabled === false) continue;
    if (String(v?.usdc || '').toLowerCase() === low) return true;
    if (String(v?.wNative || '').toLowerCase() === low) return true;

    const vaultId = getVaultId(v);
    if (!vaultId) continue;

    const hit = await col.vaultTokens?.findOne?.({
      chainId: Number(chainId),
      vaultId,
      token: low,
      enabled: true
    });
    if (hit) return true;
  }
  return false;
}

async function listEnabledLotteryTokensDb(col: any, cfg: any) {
  const out: any[] = [];
  for (const c of (cfg?.chains || [])) {
    if (c?.enabled === false) continue;
    const chainId = Number(c?.chainId);
    if (!Number.isFinite(chainId)) continue;

    // Collect enabled token addresses from:
    // - vault.usdc / vault.wNative
    // - indexed vaultTokens (TokenEnabled events)
    const addrSet = new Set<string>();

    for (const v of (c?.vaults || [])) {
      if (v?.enabled === false) continue;

      const usdc = String(v?.usdc || '').trim();
      if (/^0x[a-fA-F0-9]{40}$/.test(usdc)) addrSet.add(usdc.toLowerCase());

      const wNative = String(v?.wNative || '').trim();
      if (/^0x[a-fA-F0-9]{40}$/.test(wNative)) addrSet.add(wNative.toLowerCase());

      const vaultId = getVaultId(v);
      if (!vaultId) continue;

      const rows = await col.vaultTokens
        .find({ chainId, vaultId, enabled: true })
        .project({ token: 1, decimals: 1, enabled: 1 })
        .toArray()
        .catch(() => []);

      for (const r of rows) {
        const t = String(r?.token || '').trim();
        if (/^0x[a-fA-F0-9]{40}$/.test(t)) addrSet.add(t.toLowerCase());
      }
    }

    // Build display rows using cfg token metadata when available; otherwise fallback to vaultTokens decimals.
    const tokenMetaList = Array.isArray(c?.tokens) ? c.tokens : [];

    for (const low of addrSet) {
      const addr = low; // already lowercase
      const meta = tokenMetaList.find((x: any) => String(x?.address || '').toLowerCase() === addr && x?.enabled !== false) || null;

      let symbol = meta?.symbol || 'TOKEN';
      let decimals = Number(meta?.decimals ?? 18);

      // If not present in cfg tokens, try to read decimals from any vaultTokens entry.
      if (!meta) {
        const anyRow = await col.vaultTokens?.findOne?.({ chainId, token: addr, enabled: true });
        if (anyRow && Number.isFinite(Number(anyRow.decimals))) decimals = Number(anyRow.decimals);
        symbol = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
      }

      out.push({
        chainId,
        chainName: c?.name || `chain ${chainId}`,
        token: `0x${addr.slice(2)}`, // normalize to 0x + lowercase
        symbol,
        decimals
      });
    }
  }

  // stable ordering
  out.sort((a, b) => (a.chainId - b.chainId) || String(a.symbol).localeCompare(String(b.symbol)) || String(a.token).localeCompare(String(b.token)));
  return out;
}

async function getLinkedWallet(col: any, moduleId: string, tgId: string): Promise<string> {
  const rows = await col.tgLinks?.find?.({ moduleId, tgId, revokedAt: { $exists: false } }).sort({ createdAt: -1 }).limit(1).toArray();
  const row = rows?.[0];
  const w = String(row?.ownerWallet || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(w)) throw new Error('NOT_LINKED');
  return w;
}

function lotteryCols(db: Db) {
  return {
    cfgs: db.collection('module_lottery_configs'),
    lotteries: db.collection('module_lotteries'),
    tickets: db.collection('module_lottery_tickets')
  };
}

export function registerLotteryCoreRoutes(deps: CoreDeps) {
  const { r, db, col, cfg, requireModuleMw, applyLedgerEntry } = deps;
  const L = lotteryCols(db);

  r.post('/modules/:moduleId/lottery/token-options', requireModuleMw(col), async (req: any, res: any) => {
    const moduleId = String(req.params.moduleId || '');
    res.json({ ok: true, moduleId, items: await listEnabledLotteryTokensDb(col, cfg) });
  });

  r.post('/modules/:moduleId/lottery/stats', requireModuleMw(col), async (req: any, res: any) => {
    const moduleId = String(req.params.moduleId || '');
    const chatId = String(req.body?.chatId || '').trim();
    if (!chatId) return res.status(400).json({ error: 'BAD_CHAT_ID' });
    const active = await L.lotteries.findOne({ moduleId, chatId, status: 'OPEN' } as any, { sort: { createdAt: -1 } as any });
    if (!active) return res.json({ ok: true, running: false });

    const soldAgg = await L.tickets.aggregate([
      { $match: { moduleId, lotteryId: active.lotteryId, kind: 'BUY' } },
      { $group: { _id: null, total: { $sum: '$ticketCount' }, entrants: { $addToSet: '$tgId' }, spentRaw: { $sum: { $toDecimal: '$amountRaw' } } } }
    ]).toArray().catch(() => []);
    const boostAgg = await L.tickets.aggregate([
      { $match: { moduleId, lotteryId: active.lotteryId, kind: 'BOOST' } },
      { $group: { _id: null, boostedRaw: { $sum: { $toDecimal: '$amountRaw' } } } }
    ]).toArray().catch(() => []);

    const totalTickets = Number(soldAgg?.[0]?.total || 0);
    const uniqueEntrants = Array.isArray(soldAgg?.[0]?.entrants) ? soldAgg[0].entrants.length : 0;
    const potRaw = String(active.potRaw || '0');
    const boostedRaw = String(boostAgg?.[0]?.boostedRaw?.toString?.() || active.boostedRaw || '0');
    const endsAt = new Date(active.endsAt);
    const msLeft = Math.max(0, endsAt.getTime() - Date.now());

    res.json({ ok: true, running: true, ...active,
      potHuman: formatRaw(potRaw, Number(active.decimals || 18)),
      boostedHuman: formatRaw(boostedRaw, Number(active.decimals || 18)),
      ticketHuman: formatRaw(String(active.ticketPriceRaw || '0'), Number(active.decimals || 18)),
      totalTickets, uniqueEntrants, msLeft, endsAt: endsAt.toISOString() });
  });

  r.post('/modules/:moduleId/lottery/mytickets', requireModuleMw(col), async (req: any, res: any) => {
    const moduleId = String(req.params.moduleId || '');
    const chatId = String(req.body?.chatId || '').trim();
    const tgId = String(req.body?.tgId || '').trim();
    if (!chatId || !tgId) return res.status(400).json({ error: 'BAD_ARGS' });
    const active = await L.lotteries.findOne({ moduleId, chatId, status: 'OPEN' } as any, { sort: { createdAt: -1 } as any });
    if (!active) return res.json({ ok: true, running: false });

    const mine = await L.tickets.aggregate([
      { $match: { moduleId, lotteryId: active.lotteryId, tgId, kind: 'BUY' } },
      { $group: { _id: null, tickets: { $sum: '$ticketCount' }, spentRaw: { $sum: { $toDecimal: '$amountRaw' } } } }
    ]).toArray().catch(() => []);
    const all = await L.tickets.aggregate([
      { $match: { moduleId, lotteryId: active.lotteryId, kind: 'BUY' } },
      { $group: { _id: null, tickets: { $sum: '$ticketCount' } } }
    ]).toArray().catch(() => []);
    const totalTickets = Number(all?.[0]?.tickets || 0);
    const userTickets = Number(mine?.[0]?.tickets || 0);
    const userSpentRaw = String(mine?.[0]?.spentRaw?.toString?.() || '0');
    const userSharePct = totalTickets > 0 ? ((userTickets / totalTickets) * 100).toFixed(2) : '0.00';

    res.json({ ok: true, running: true, lotteryId: active.lotteryId, userTickets, userSpentHuman: formatRaw(userSpentRaw, Number(active.decimals || 18)), userSharePct,
      ticketHuman: formatRaw(String(active.ticketPriceRaw || '0'), Number(active.decimals || 18)), potHuman: formatRaw(String(active.potRaw || '0'), Number(active.decimals || 18)), boostedHuman: formatRaw(String(active.boostedRaw || '0'), Number(active.decimals || 18)), totalTickets,
      uniqueEntrants: 0, msLeft: Math.max(0, new Date(active.endsAt).getTime() - Date.now()), endsAt: new Date(active.endsAt).toISOString(), imageUrl: active.imageUrl || null, description: active.description || null, title: active.title || null, buttonTicketOptions: active.buttonTicketOptions || null });
  });

  r.post('/modules/:moduleId/lottery/admin/create', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '');
      const p = createReqSchema.parse(req.body || {});
      let tMeta = getTokenMeta(cfg, p.chainId, p.token);
      // If token is enabled on the vault but not present in cfg token list, allow it (use vaultTokens decimals fallback).
      if (!tMeta) {
        const low = String(p.token).toLowerCase();
        const anyRow = await col.vaultTokens?.findOne?.({ chainId: Number(p.chainId), token: low, enabled: true });
        if (anyRow) tMeta = { symbol: `${low.slice(0,6)}…${low.slice(-4)}`, decimals: Number(anyRow.decimals ?? 18), address: p.token, enabled: true } as any;
      }
      if (!tMeta) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_ON_CHAIN' });
      if (!(await tokenEnabledOnAnyVaultDb(col, cfg, p.chainId, p.token))) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_ON_VAULT' });
      if (BigInt(p.ticketPriceRaw) <= 0n) return res.status(400).json({ error: 'BAD_TICKET_PRICE' });

      const existing = await L.lotteries.findOne({ moduleId, chatId: p.chatId, status: 'OPEN' } as any);
      if (existing) return res.status(400).json({ error: 'LOTTERY_ALREADY_RUNNING' });

      const lotteryId = rid('lottery');
      const now = new Date();
      const endsAt = new Date(Date.now() + p.durationSec * 1000);
      const doc = {
        moduleId, lotteryId, chatId: p.chatId, status: 'OPEN',
        chainId: p.chainId, token: p.token, symbol: String(tMeta.symbol || 'TOKEN'), decimals: Number(tMeta.decimals || 18),
        ticketPriceRaw: p.ticketPriceRaw, potRaw: '0', boostedRaw: '0',
        title: p.title || null, description: p.description || null, imageUrl: p.imageUrl || null,
        buttonTicketOptions: p.buttonTicketOptions || [1,3,5],
        shillEnabled: p.shillEnabled ?? true, shillIntervalSec: p.shillIntervalSec ?? 900, shillMessageId: null,
        createdAt: now, updatedAt: now, endsAt
      };
      await L.lotteries.insertOne(doc as any);
      res.json({ ok: true, ...doc, endsAt: endsAt.toISOString() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || 'FAILED' });
    }
  });

  r.post('/modules/:moduleId/lottery/admin/update', requireModuleMw(col), async (req: any, res: any) => {
    const moduleId = String(req.params.moduleId || '');
    const chatId = String(req.body?.chatId || '').trim();
    if (!chatId) return res.status(400).json({ error: 'BAD_CHAT_ID' });
    const active = await L.lotteries.findOne({ moduleId, chatId, status: 'OPEN' } as any, { sort: { createdAt: -1 } as any });
    if (!active) return res.status(404).json({ error: 'NO_LOTTERY' });
    const patch: any = {};
    for (const k of ['title','description','imageUrl']) if (req.body?.[k] !== undefined) patch[k] = req.body[k] || null;
    if (req.body?.buttonTicketOptions && Array.isArray(req.body.buttonTicketOptions)) patch.buttonTicketOptions = req.body.buttonTicketOptions.map((n:any)=>Number(n)).filter((n:number)=>Number.isFinite(n)&&n>0).slice(0,8);
    if (req.body?.shillEnabled !== undefined) patch.shillEnabled = !!req.body.shillEnabled;
    if (req.body?.shillIntervalSec !== undefined) patch.shillIntervalSec = Math.max(60, Math.min(86400, Number(req.body.shillIntervalSec)||900));
    if (req.body?.durationSec !== undefined) patch.endsAt = new Date(Date.now() + Math.max(60, Math.min(60*60*24*30, Number(req.body.durationSec)||3600))*1000);
    if (req.body?.shillMessageId !== undefined) patch.shillMessageId = Number.isFinite(Number(req.body.shillMessageId)) ? Number(req.body.shillMessageId) : null;
    patch.updatedAt = new Date();
    await L.lotteries.updateOne({ _id: (active as any)._id } as any, { $set: patch } as any);
    res.json({ ok: true, patch });
  });



  async function doBuyLike(params: { moduleId: string; chatId: string; tgId: string; amountRaw: string; kind: 'BUY'|'BOOST'; fromUsername?: string }) {
    const { moduleId, chatId, tgId, amountRaw, kind } = params;
    const active: any = await L.lotteries.findOne({ moduleId, chatId, status: 'OPEN' } as any, { sort: { createdAt: -1 } as any });
    if (!active) throw new Error('NO_LOTTERY');
    if (new Date(active.endsAt).getTime() <= Date.now()) throw new Error('LOTTERY_ENDED');

    const ownerWallet = await getLinkedWallet(col, moduleId, tgId);
    const userAccount = userAccountId(ownerWallet);
    const potTreasuryId = `lottery:${chatId}`;
    const potAccount = treasuryAccountId(potTreasuryId);
    const dec = Number(active.decimals || 18);

    let ticketCount = 0;
    let debitRaw = '0';
    if (kind === 'BUY') {
      const ticketPrice = BigInt(String(active.ticketPriceRaw || '0'));
      const reqRaw = BigInt(String(amountRaw || '0'));
      if (ticketPrice <= 0n) throw new Error('BAD_TICKET_PRICE');
      ticketCount = Number(reqRaw / ticketPrice);
      if (ticketCount <= 0) throw new Error('AMOUNT_LT_ONE_TICKET');
      debitRaw = (BigInt(ticketCount) * ticketPrice).toString();
    } else {
      if (BigInt(amountRaw) <= 0n) throw new Error('BAD_AMOUNT');
      debitRaw = String(amountRaw);
    }

    const refId = rid(kind === 'BUY' ? 'lottery_buy' : 'lottery_boost');
    await applyLedgerEntry({ db, col, refId, ts: new Date(), chainId: Number(active.chainId), token: String(active.token), amountRaw: debitRaw,
      fromAccountId: userAccount, toAccountId: potAccount, kind: kind === 'BUY' ? 'lottery_buy' : 'lottery_boost',
      meta: { moduleId, chatId, lotteryId: active.lotteryId, tgId, fromUsername: params.fromUsername || '', ticketCount, symbol: active.symbol } });

    await L.tickets.insertOne({ moduleId, lotteryId: active.lotteryId, chatId, tgId, chainId: Number(active.chainId), token: String(active.token), amountRaw: debitRaw,
      ticketCount, kind, ownerWallet, createdAt: new Date(), fromUsername: params.fromUsername || null } as any);

    const inc: any = { potRaw: BigInt(debitRaw) };
    if (kind === 'BOOST') inc.boostedRaw = BigInt(debitRaw);
    const currentPot = BigInt(String(active.potRaw || '0')) + BigInt(debitRaw);
    const currentBoost = BigInt(String(active.boostedRaw || '0')) + (kind==='BOOST' ? BigInt(debitRaw) : 0n);
    await L.lotteries.updateOne({ _id: active._id } as any, { $set: { potRaw: currentPot.toString(), boostedRaw: currentBoost.toString(), updatedAt: new Date() } } as any);

    return { lottery: { ...active, potRaw: currentPot.toString(), boostedRaw: currentBoost.toString() }, ticketCount, debitRaw, debitHuman: formatRaw(debitRaw, dec), ticketHuman: formatRaw(String(active.ticketPriceRaw||'0'), dec) };
  }

  r.post('/modules/:moduleId/lottery/buy', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '');
      const chatId = String(req.body?.chatId || '').trim();
      const tgId = String(req.body?.tgId || '').trim();
      const amountRaw = String(req.body?.amountRaw || '').trim();
      if (!chatId || !tgId || !/^\d+$/.test(amountRaw)) return res.status(400).json({ error: 'BAD_ARGS' });
      const out = await doBuyLike({ moduleId, chatId, tgId, amountRaw, kind: 'BUY', fromUsername: String(req.body?.fromUsername || '') });
      res.json({ ok: true, ticketCount: out.ticketCount, amountRaw: out.debitRaw, amountHuman: out.debitHuman, ticketHuman: out.ticketHuman, lotteryId: out.lottery.lotteryId });
    } catch (e:any) { res.status(400).json({ error: e?.message || 'FAILED' }); }
  });

  r.post('/modules/:moduleId/lottery/boost', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '');
      const chatId = String(req.body?.chatId || '').trim();
      const tgId = String(req.body?.tgId || '').trim();
      const amountRaw = String(req.body?.amountRaw || '').trim();
      if (!chatId || !tgId || !/^\d+$/.test(amountRaw)) return res.status(400).json({ error: 'BAD_ARGS' });
      const out = await doBuyLike({ moduleId, chatId, tgId, amountRaw, kind: 'BOOST', fromUsername: String(req.body?.fromUsername || '') });
      res.json({ ok: true, amountRaw: out.debitRaw, amountHuman: out.debitHuman, lotteryId: out.lottery.lotteryId });
    } catch (e:any) { res.status(400).json({ error: e?.message || 'FAILED' }); }
  });

  // Cancel ALWAYS refunds all BUY + BOOST contributions back to users (idempotent per wallet).
  r.post('/modules/:moduleId/lottery/admin/cancel', requireModuleMw(col), async (req: any, res: any) => {
    const moduleId = String(req.params.moduleId || '');
    const chatId = String(req.body?.chatId || '').trim();
    if (!chatId) return res.status(400).json({ error: 'BAD_CHAT_ID' });
    const active: any = await L.lotteries.findOne({ moduleId, chatId, status: 'OPEN' } as any, { sort: { createdAt: -1 } as any });
    if (!active) return res.status(404).json({ error: 'NO_LOTTERY' });

    const potAccount = treasuryAccountId(`lottery:${chatId}`);

    // Aggregate ALL contributions per wallet for this lottery.
    // (Do not rely on `kind` only — older/stale docs may have different kind strings.)
    const rows = await L.tickets.aggregate([
      { $match: { moduleId, lotteryId: active.lotteryId } },
      { $group: { _id: { ownerWallet: '$ownerWallet' }, amountRaw: { $sum: { $toDecimal: '$amountRaw' } } } }
    ]).toArray().catch(() => []);

    const refunds: any[] = [];
    for (const r of rows || []) {
      const w = String(r?._id?.ownerWallet || '').trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(w)) continue;
      const amt = String(r?.amountRaw?.toString?.() || '0');
      if (!/^\d+$/.test(amt)) continue;
      if (BigInt(amt) <= 0n) continue;

      const toAcc = userAccountId(w);
      const refId = `lottery_refund:${active.lotteryId}:${w.toLowerCase()}`;
      try {
        await applyLedgerEntry({
          db,
          col,
          refId,
          ts: new Date(),
          chainId: Number(active.chainId),
          token: String(active.token),
          amountRaw: amt,
          fromAccountId: potAccount,
          toAccountId: toAcc,
          kind: 'lottery_refund',
          meta: { moduleId, chatId, lotteryId: active.lotteryId, reason: 'cancel', ownerWallet: w }
        });
        refunds.push({ wallet: w, amountRaw: amt, ok: true });
      } catch (e: any) {
        // Idempotency: if refId already exists, treat as already refunded.
        const msg = String(e?.message || e);
        if (msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('refid')) {
          refunds.push({ wallet: w, amountRaw: amt, ok: true, already: true });
        } else {
          refunds.push({ wallet: w, amountRaw: amt, ok: false, error: msg });
        }
      }
    }

    await L.lotteries.updateOne(
      { _id: active._id } as any,
      { $set: { status: 'CANCELLED_REFUNDED', refundedAt: new Date(), refundCount: refunds.filter((x) => x.ok).length, updatedAt: new Date() } } as any
    );

    res.json({ ok: true, lotteryId: active.lotteryId, cancelled: true, refunded: true, refundCount: refunds.filter((x) => x.ok).length });
  });

  async function drawLottery(moduleId: string, chatId: string) {
    const active: any = await L.lotteries.findOne({ moduleId, chatId, status: 'OPEN' } as any, { sort: { createdAt: -1 } as any });
    if (!active) return { ok: true, drawn: false, reason: 'NO_LOTTERY' };
    if (new Date(active.endsAt).getTime() > Date.now()) return { ok: true, drawn: false, reason: 'NOT_DUE', msLeft: new Date(active.endsAt).getTime() - Date.now() };

    const buys = await L.tickets.find({ moduleId, lotteryId: active.lotteryId, kind: 'BUY', ticketCount: { $gt: 0 } } as any).toArray();
    const totalTickets = buys.reduce((a: number, x: any) => a + Number(x.ticketCount || 0), 0);
    const potRaw = BigInt(String(active.potRaw || '0'));
    if (totalTickets <= 0 || potRaw <= 0n) {
      await L.lotteries.updateOne({ _id: active._id } as any, { $set: { status: 'DRAWN', updatedAt: new Date(), drawResult: { cancelled: true, reason: 'NO_ENTRIES' } } } as any);
      return { ok: true, drawn: true, cancelled: true, reason: 'NO_ENTRIES', lotteryId: active.lotteryId };
    }

    const idx = Math.floor(Math.random() * totalTickets);
    let cursor = 0;
    let winnerEntry: any = null;
    for (const e of buys) { cursor += Number(e.ticketCount || 0); if (idx < cursor) { winnerEntry = e; break; } }
    if (!winnerEntry) winnerEntry = buys[buys.length - 1];

    const winnerWallet = String(winnerEntry.ownerWallet || '').toLowerCase();
    const winnerAccount = userAccountId(winnerWallet);
    const potAccount = treasuryAccountId(`lottery:${chatId}`);
    const devAccount = treasuryAccountId(`lottery_dev:${chatId}`);
    const winnerRaw = ((potRaw * 9000n) / 10000n).toString();
    const devRaw = (potRaw - BigInt(winnerRaw)).toString();

    if (BigInt(winnerRaw) > 0n) {
      await applyLedgerEntry({ db, col, refId: rid('lottery_draw_win'), ts: new Date(), chainId: Number(active.chainId), token: String(active.token), amountRaw: winnerRaw,
        fromAccountId: potAccount, toAccountId: winnerAccount, kind: 'lottery_payout', meta: { moduleId, chatId, lotteryId: active.lotteryId, tgId: winnerEntry.tgId, winner: true } });
    }
    if (BigInt(devRaw) > 0n) {
      await applyLedgerEntry({ db, col, refId: rid('lottery_draw_dev'), ts: new Date(), chainId: Number(active.chainId), token: String(active.token), amountRaw: devRaw,
        fromAccountId: potAccount, toAccountId: devAccount, kind: 'lottery_fee', meta: { moduleId, chatId, lotteryId: active.lotteryId, tgId: winnerEntry.tgId } });
    }

    const winnerUsername = String((winnerEntry as any)?.fromUsername || '').replace(/^@+/, '');
    const result = {
      drawnAt: nowIso(),
      winnerTgId: String(winnerEntry.tgId),
      winnerUsername: winnerUsername || null,
      winnerWallet,
      totalTickets,
      winnerTicketCount: Number(winnerEntry.ticketCount||0),
      potRaw: potRaw.toString(),
      winnerRaw,
      devRaw
    };
    await L.lotteries.updateOne({ _id: active._id } as any, { $set: { status: 'DRAWN', updatedAt: new Date(), drawResult: result } } as any);

    return { ok: true, drawn: true, lotteryId: active.lotteryId, ...result,
      potHuman: formatRaw(potRaw.toString(), Number(active.decimals || 18)),
      winnerHuman: formatRaw(winnerRaw, Number(active.decimals || 18)),
      devHuman: formatRaw(devRaw, Number(active.decimals || 18)),
      tokenSymbol: active.symbol,
      title: active.title || null,
      description: active.description || null,
      imageUrl: active.imageUrl || null };
  }



  const chatCfgColl = () => (db as any).collection('module_lottery_chat_cfg');

  r.post('/modules/:moduleId/lottery/admin/config/get', requireModuleMw(col), async (req: any, res: any) => {
    const moduleId = String(req.params.moduleId || '');
    const chatId = String(req.body?.chatId || '').trim();
    if (!chatId) return res.status(400).json({ error: 'BAD_CHAT_ID' });
    const cfgDoc: any = await chatCfgColl().findOne({ moduleId, chatId } as any);
    res.json({ ok: true, item: cfgDoc ? {
      chatId: cfgDoc.chatId,
      defaultChainId: cfgDoc.defaultChainId ?? null,
      defaultToken: cfgDoc.defaultToken ?? null,
      defaultTicketPriceRaw: cfgDoc.defaultTicketPriceRaw ?? null,
      defaultDurationSec: cfgDoc.defaultDurationSec ?? null,
      defaultTitle: cfgDoc.defaultTitle ?? null,
      buttonTicketOptions: cfgDoc.buttonTicketOptions ?? [1,3,5],
      updatedByTgId: cfgDoc.updatedByTgId ?? null,
      updatedAt: cfgDoc.updatedAt ? new Date(cfgDoc.updatedAt).toISOString() : null,
    } : null });
  });

  r.post('/modules/:moduleId/lottery/admin/config/set', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '');
      const p = lotteryChatCfgSchema.parse(req.body || {});
      const chatId = String(p.chatId);
      const patch: any = {};
      if (p.defaultChainId != null) patch.defaultChainId = Number(p.defaultChainId);
      if (p.defaultToken != null) patch.defaultToken = String(p.defaultToken);
      if (p.defaultTicketPriceRaw != null) {
        if (BigInt(String(p.defaultTicketPriceRaw)) <= 0n) return res.status(400).json({ error: 'BAD_TICKET_PRICE' });
        patch.defaultTicketPriceRaw = String(p.defaultTicketPriceRaw);
      }
      if (p.defaultDurationSec != null) patch.defaultDurationSec = Number(p.defaultDurationSec);
      if (p.defaultTitle !== undefined) patch.defaultTitle = p.defaultTitle || null;
      if (p.buttonTicketOptions) patch.buttonTicketOptions = p.buttonTicketOptions.map((n:any)=>Number(n)).filter((n:number)=>Number.isFinite(n)&&n>0).slice(0,8);
      if (p.updatedByTgId) patch.updatedByTgId = String(p.updatedByTgId);

      const checkChain = patch.defaultChainId ?? undefined;
      const checkToken = patch.defaultToken ?? undefined;
      if (checkToken) {
        const cid = Number(checkChain);
        if (!Number.isFinite(cid)) return res.status(400).json({ error: 'DEFAULT_CHAIN_REQUIRED_FOR_TOKEN' });
        let tMeta = getTokenMeta(cfg, cid, checkToken);
        if (!tMeta) {
          const low = String(checkToken).toLowerCase();
          const anyRow = await col.vaultTokens?.findOne?.({ chainId: Number(cid), token: low, enabled: true });
          if (anyRow) tMeta = { symbol: `${low.slice(0,6)}…${low.slice(-4)}`, decimals: Number(anyRow.decimals ?? 18), address: checkToken, enabled: true } as any;
        }
        if (!tMeta) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_ON_CHAIN' });
        if (!(await tokenEnabledOnAnyVaultDb(col, cfg, cid, checkToken))) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_ON_VAULT' });
      }

      patch.updatedAt = new Date();
      await chatCfgColl().updateOne({ moduleId, chatId } as any, { $set: { moduleId, chatId, ...patch }, $setOnInsert: { createdAt: new Date() } } as any, { upsert: true } as any);
      const item: any = await chatCfgColl().findOne({ moduleId, chatId } as any);
      res.json({ ok: true, item });
    } catch (e:any) {
      res.status(400).json({ error: e?.message || 'FAILED' });
    }
  });

  r.post('/modules/:moduleId/lottery/drawIfDue', requireModuleMw(col), async (req: any, res: any) => {
    try { res.json(await drawLottery(String(req.params.moduleId || ''), String(req.body?.chatId || '').trim())); }
    catch (e:any) { res.status(400).json({ error: e?.message || 'FAILED' }); }
  });
  r.post('/modules/:moduleId/lottery/admin/draw', requireModuleMw(col), async (req: any, res: any) => {
    try { res.json(await drawLottery(String(req.params.moduleId || ''), String(req.body?.chatId || '').trim())); }
    catch (e:any) { res.status(400).json({ error: e?.message || 'FAILED' }); }
  });
}

async function apiFetch<T>(cfg: TgCfg, path: string, init?: RequestInit): Promise<{ok:true,data:T}|{ok:false,error:string}> {
  const url = `${String(cfg.coreApiUrl || '').replace(/\/+$/, '')}${path}`;
  let r: Response;
  try {
    r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', 'x-module-id': cfg.moduleId, 'x-module-key': cfg.moduleKey, ...(init?.headers || {}) } });
  } catch (e:any) { return { ok:false, error: `FETCH_FAILED:${String(e?.message||e)}`}; }
  const j = await r.json().catch(()=>({}));
  if (!r.ok) return { ok:false, error: (j as any)?.error || `HTTP_${r.status}` };
  return { ok:true, data: j as T };
}
function tgArgs(ctx:any){ return String(ctx.message?.text||'').trim().split(/\s+/).slice(1); }
async function requireGroup(ctx:any){ const t = String(ctx.chat?.type||''); if (t !== 'group' && t !== 'supergroup') { await ctx.reply('Use this in a group.'); return false; } return true; }
function hasEnvTgAdmin(tgId?: string){
  const id = String(tgId || '').trim();
  if (!id) return false;
  const admins = new Set([
    ...String(process.env.TG_ADMIN_IDS || '').split(',').map((x)=>x.trim()).filter(Boolean),
    ...String(process.env.TG_SUPER_ADMIN_IDS || process.env.TG_ADMIN_IDS || '').split(',').map((x)=>x.trim()).filter(Boolean),
  ]);
  return admins.has(id);
}
async function isGroupAdmin(ctx:any){ try { const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id); return ['administrator','creator'].includes(String(m?.status||'')); } catch { return false; } }
async function isLotteryAdmin(ctx:any){
  const tgId = String(ctx?.from?.id || '');
  if (hasEnvTgAdmin(tgId)) return true;
  return await isGroupAdmin(ctx);
}
export function registerLotteryTelegram(bot: Telegraf<any>, cfg: TgCfg) {
  const pendingAdmin = new Map<string, { field: 'title'|'desc'|'image'|'duration'|'buttons'|'setup_token'|'setup_ticket'|'setup_duration'|'setup_chain'|'setup_title'; expires: number }>();
  const shillTickChats = new Set<string>();
  const seenChats = new Set<string>();

  // Seed from PUBLIC_CHAT_IDS so end-time draws happen even if the chat is quiet.
  try {
    const raw = String(process.env.PUBLIC_CHAT_IDS || '').trim();
    for (const x of raw.split(',').map((s)=>s.trim()).filter(Boolean)) seenChats.add(x);
  } catch {}

  function fmtStats(r:any) {
    if (!r?.running) return '🎟️ No lottery is running right now.';
    return [
      `🎟️ Lottery ${r.title ? `- ${r.title}` : ''}`,
      `Token: ${r.tokenSymbol || r.symbol}`,
      `Chain: ${r.chainId}`,
      `Ticket: ${r.ticketHuman}`,
      `Pot: ${r.potHuman}`,
      r.boostedHuman && r.boostedHuman !== '0' ? `Boosted: ${r.boostedHuman}` : '',
      `Tickets: ${r.totalTickets}`,
      `Entrants: ${r.uniqueEntrants}`,
      `Ends: ${new Date(r.endsAt).toLocaleString()}`,
      r.description ? `\n📣 ${r.description}` : ''
    ].filter(Boolean).join('\n');
  }
  function mainKb() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🎟️ Buy 1', 'lottery:buy:1'), Markup.button.callback('🎟️ Buy 3', 'lottery:buy:3'), Markup.button.callback('🎟️ Buy 5', 'lottery:buy:5')],
      [Markup.button.callback('👤 My tickets', 'lottery:my'), Markup.button.callback('🔄 Refresh', 'lottery:refresh')],
      [Markup.button.callback('🛠️ Admin', LOTTERY_ADMIN_ROOT_CB)]
    ]);
  }
  async function postOrRefreshShill(ctx:any) {
    const chatId = String(ctx.chat?.id || '');
    const s = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/stats`, { method:'POST', body: JSON.stringify({ chatId }) });
    if (!s.ok) return ctx.reply(`Lottery stats failed: ${s.error}`);
    if (!(s.data as any).running) return ctx.reply('No lottery running.');
    const r:any = s.data;
    const text = fmtStats(r);
    let msg:any;
    if (r.imageUrl) msg = await ctx.replyWithPhoto(r.imageUrl, { caption: text, ...mainKb() });
    else msg = await ctx.reply(text, mainKb());
    await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/update`, { method:'POST', body: JSON.stringify({ chatId, shillMessageId: msg?.message_id }) });
  }

  bot.command('lotterystats', async (ctx:any) => { if (!(await requireGroup(ctx))) return; const chatId=String(ctx.chat.id); const s=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/stats`, {method:'POST', body:JSON.stringify({chatId})}); if(!s.ok) return ctx.reply(`Failed: ${s.error}`); return ctx.reply(fmtStats(s.data), mainKb()); });

  bot.command('lotterymytickets', async (ctx:any) => {
    if (!(await requireGroup(ctx))) return;
    const chatId = String(ctx.chat.id), tgId = String(ctx.from?.id||'');
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/mytickets`, { method:'POST', body: JSON.stringify({ chatId, tgId }) });
    if (!r.ok) return ctx.reply(`Failed: ${r.error}`);
    if (!(r.data as any).running) return ctx.reply('No lottery running.');
    const x:any=(r.data as any);
    return ctx.reply([`🎟️ My Tickets`, `Tickets: ${x.userTickets}`, `Spent: ${x.userSpentHuman}`, `Share: ${x.userSharePct}%`, `Pot: ${x.potHuman}`, `Ends: ${new Date(x.endsAt).toLocaleString()}`].join('\n'));
  });

  bot.command('lotteryboost', async (ctx:any) => {
    if (!(await requireGroup(ctx))) return;
    const args=tgArgs(ctx); if (!args[0]) return ctx.reply('Usage: /lotteryboost <amount>');
    const chatId = String(ctx.chat.id), tgId=String(ctx.from.id);
    const s=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/stats`, {method:'POST', body:JSON.stringify({chatId})}); if(!s.ok) return ctx.reply(`Failed: ${s.error}`); if(!(s.data as any).running) return ctx.reply('No lottery running.');
    const st:any=s.data; let amountRaw:string; try { amountRaw = parseHumanToRaw(args[0], Number(st.decimals||18)); } catch(e:any){ return ctx.reply(`Bad amount: ${String(e?.message||e)}`); }
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/boost`, { method:'POST', body: JSON.stringify({ chatId, tgId, amountRaw, fromUsername: ctx.from?.username || '' }) });
    if(!r.ok) return ctx.reply(`Boost failed: ${r.error}`);
    await ctx.reply(`🔥 Boosted ${st.symbol || st.tokenSymbol} by ${r.data.amountHuman}`);
  });

  bot.command('lotterybuy', async (ctx:any) => {
    if (!(await requireGroup(ctx))) return;
    const args=tgArgs(ctx); if (!args[0]) return ctx.reply('Usage: /lotterybuy <amount>');
    const chatId=String(ctx.chat.id), tgId=String(ctx.from.id);
    const s=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/stats`, {method:'POST', body:JSON.stringify({chatId})}); if(!s.ok) return ctx.reply(`Failed: ${s.error}`); if(!(s.data as any).running) return ctx.reply('No lottery running.');
    const st:any=s.data; let amountRaw:string; try { amountRaw = parseHumanToRaw(args[0], Number(st.decimals||18)); } catch(e:any){ return ctx.reply(`Bad amount: ${String(e?.message||e)}`); }
    const r=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/buy`, { method:'POST', body: JSON.stringify({ chatId, tgId, amountRaw, fromUsername: ctx.from?.username || '' }) });
    if(!r.ok) return ctx.reply(`Buy failed: ${r.error}`);
    await ctx.reply(`✅ Bought ${r.data.ticketCount} ticket(s) for ${r.data.amountHuman} ${st.symbol || st.tokenSymbol}`);
  });

  async function getChatSetup(chatId: string) {
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/config/get`, { method:'POST', body: JSON.stringify({ chatId }) });
    return r.ok ? ((r.data as any)?.item || null) : null;
  }
  function parseDurationText(raw: string) {
    const m = /^([0-9]+)([smhd])$/i.exec(String(raw||'').trim()); if (!m) return null;
    const n = Number(m[1]); const mult:any = { s:1, m:60, h:3600, d:86400 };
    return n * mult[m[2].toLowerCase()];
  }
  function fmtDurationSec(sec: any) {
    const n = Number(sec||0); if (!Number.isFinite(n) || n<=0) return '—';
    if (n % 86400 === 0) return `${n/86400}d`; if (n % 3600 === 0) return `${n/3600}h`; if (n % 60 === 0) return `${n/60}m`; return `${n}s`;
  }
  function resolveTokenMatch(opts:any[], assetRaw:string, defaultChainId?: number|null) {
    const asset = String(assetRaw||'').trim();
    const m = /^([^:@]+)[:@](\d+)$/.exec(asset);
    const explicitChain = m ? Number(m[2]) : null;
    const needle = (m ? m[1] : asset).toLowerCase();
    let cands = (opts||[]).filter((x:any)=> String(x.token||'').toLowerCase()===needle || String(x.symbol||'').toLowerCase()===needle);
    if (explicitChain != null) cands = cands.filter((x:any)=>Number(x.chainId)===explicitChain);
    else if (defaultChainId != null) { const on = cands.filter((x:any)=>Number(x.chainId)===Number(defaultChainId)); if (on.length) cands = on; }
    if (cands.length === 1) return cands[0];
    return null;
  }

  bot.command('lottery', async (ctx:any) => {
    if (!(await requireGroup(ctx))) return;
    const args = tgArgs(ctx);
    const chatId = String(ctx.chat.id);

    if (args.length >= 1 && /^[0-9]+(\.[0-9]+)?$/.test(args[0]) && (args.length === 1 || !/^0x[a-fA-F0-9]{40}$/.test(args[0]))) {
      const tgId=String(ctx.from.id);
      const s=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/stats`, {method:'POST', body:JSON.stringify({chatId})}); if(!s.ok) return ctx.reply(`Failed: ${s.error}`); if(!(s.data as any).running) return ctx.reply('No lottery running.');
      const st:any=s.data; let amountRaw:string; try { amountRaw = parseHumanToRaw(args[0], Number(st.decimals||18)); } catch(e:any){ return ctx.reply(`Bad amount: ${String(e?.message||e)}`); }
      const r=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/buy`, { method:'POST', body: JSON.stringify({ chatId, tgId, amountRaw, fromUsername: ctx.from?.username || '' }) });
      if(!r.ok) return ctx.reply(`Buy failed: ${r.error}`);
      return ctx.reply(`✅ Bought ${r.data.ticketCount} ticket(s) for ${r.data.amountHuman} ${st.symbol || st.tokenSymbol}`);
    }

    if (!(await isLotteryAdmin(ctx))) return ctx.reply('Only group admins or configured TG admins can create lotteries.');
    const tok = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/token-options`, { method:'POST', body: JSON.stringify({}) });
    if (!tok.ok) return ctx.reply(`Token list failed: ${tok.error}`);
    const opts = (tok.data as any).items || [];
    const setup = await getChatSetup(chatId);

    if (args[0] && /^(create|start)$/i.test(args[0])) {
      if (!setup?.defaultChainId || !setup?.defaultToken || !setup?.defaultTicketPriceRaw || !setup?.defaultDurationSec) {
        return ctx.reply('Setup incomplete. Use /lotteryadmin → Setup buttons (chain, token, ticket, duration).');
      }
      const tMeta = opts.find((x:any)=>Number(x.chainId)===Number(setup.defaultChainId) && String(x.token).toLowerCase()===String(setup.defaultToken).toLowerCase());
      if (!tMeta) return ctx.reply('Configured default token is not currently enabled. Reconfigure in /lotteryadmin.');
      const title = args.slice(1).join(' ').trim() || setup.defaultTitle || null;
      const cr = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/create`, { method:'POST', body: JSON.stringify({
        chatId, chainId: Number(setup.defaultChainId), token: setup.defaultToken, ticketPriceRaw: String(setup.defaultTicketPriceRaw), durationSec: Number(setup.defaultDurationSec),
        title, buttonTicketOptions: Array.isArray(setup.buttonTicketOptions) && setup.buttonTicketOptions.length ? setup.buttonTicketOptions : [1,3,5], shillEnabled: true
      }) });
      if (!cr.ok) return ctx.reply(`Create failed: ${cr.error}`);
      await ctx.reply(`✅ Lottery created (${tMeta.symbol} · chain ${tMeta.chainId})\nTicket: ${formatRaw(String(setup.defaultTicketPriceRaw), Number(tMeta.decimals||18))} ${tMeta.symbol}\nDuration: ${fmtDurationSec(setup.defaultDurationSec)}${title ? `\nTitle: ${title}` : ''}`);
      return postOrRefreshShill(ctx);
    }

    if (args.length < 4) {
      return ctx.reply('Admin create:\n/lottery <SYMBOL|SYMBOL:chainId|0xToken> <ticketPrice> <duration> [title...]\nQuick create from saved defaults:\n/lottery start [title...]\nExamples:\n/lottery USDC:43113 1 24h Friday Night Pot\n/lottery USDC:43113 1 12h Test\n/lottery start Friday Night Pot');
    }
    const [asset, ticketPriceHuman, durationRaw, ...rest] = args;
    const match = resolveTokenMatch(opts, asset, Number(setup?.defaultChainId || cfg.chainId));
    if (!match) {
      const same = opts.filter((x:any)=> String(x.symbol||'').toLowerCase() === String(asset).split(/[:@]/)[0].toLowerCase());
      if (same.length > 1) return ctx.reply(`Token symbol matches multiple chains. Use SYMBOL:chainId (e.g. ${same[0].symbol}:${same[0].chainId}).`);
      return ctx.reply(`Token not enabled for lottery: ${asset}`);
    }
    const durationSec = parseDurationText(durationRaw);
    if (!durationSec) return ctx.reply('Bad duration. Use 30m, 2h, 1d');
    let ticketPriceRaw:string; try { ticketPriceRaw = parseHumanToRaw(ticketPriceHuman, Number(match.decimals||18)); } catch(e:any) { return ctx.reply(`Bad ticket price: ${String(e?.message||e)}`); }

    const cr = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/create`, { method:'POST', body: JSON.stringify({ chatId, chainId: Number(match.chainId), token: match.token, ticketPriceRaw, durationSec, title: rest.join(' ').trim() || null, buttonTicketOptions: [1,3,5], shillEnabled: true }) });
    if (!cr.ok) return ctx.reply(`Create failed: ${cr.error}`);
    await ctx.reply(`✅ Lottery created on ${match.symbol} (chain ${match.chainId})\nTicket: ${ticketPriceHuman} ${match.symbol}\nDuration: ${durationRaw}`);
    await postOrRefreshShill(ctx);
  });

  bot.command('lotteryadmin', async (ctx:any) => {
    if (!(await requireGroup(ctx))) return;
    if (!(await isLotteryAdmin(ctx))) return ctx.reply('Only group admins or configured TG admins.');
    return ctx.reply('Lottery admin', Markup.inlineKeyboard([
      [Markup.button.callback('⚙️ View setup', 'lottery:admin:setup:view')],
      [Markup.button.callback('🧭 Set default chain', 'lottery:admin:setup:chain'), Markup.button.callback('🪙 Set default token', 'lottery:admin:setup:token')],
      [Markup.button.callback('🎫 Set ticket price', 'lottery:admin:setup:ticket'), Markup.button.callback('⏱️ Set default duration', 'lottery:admin:setup:duration')],
      [Markup.button.callback('🏷️ Set default title', 'lottery:admin:setup:title')],
      [Markup.button.callback('▶️ Create from defaults', 'lottery:admin:createfromdefaults')],
      [Markup.button.callback('📣 Repost shill', 'lottery:admin:repost')],
      [Markup.button.callback('📝 Edit title', 'lottery:admin:title'), Markup.button.callback('🗒️ Edit desc', 'lottery:admin:desc')],
      [Markup.button.callback('🖼️ Set image', 'lottery:admin:image'), Markup.button.callback('⏱️ Set duration', 'lottery:admin:duration')],
      [Markup.button.callback('🔘 Buy buttons', 'lottery:admin:buttons'), Markup.button.callback('🎲 Draw now', 'lottery:admin:draw')],
      [Markup.button.callback('🛑 Cancel lottery', 'lottery:admin:cancel')]
    ]));
  });

  bot.command('lotterytokens', async (ctx:any) => {
    if (!(await requireGroup(ctx))) return;
    const tok = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/token-options`, { method:'POST', body: JSON.stringify({}) });
    if (!tok.ok) return ctx.reply(`Token list failed: ${tok.error}`);
    const items = ((tok.data as any).items || []).slice(0,80);
    const lines = items.map((x:any)=>`• ${x.symbol} (chain ${x.chainId}) ${x.token}`);
    await ctx.reply(`Enabled lottery tokens (${items.length} shown):\n` + lines.join('\n'));
  });

  bot.action(LOTTERY_ADMIN_ROOT_CB, async (ctx:any)=>{ if (!(await isLotteryAdmin(ctx))) return ctx.answerCbQuery('Admins only', {show_alert:true}); await ctx.answerCbQuery('Lottery admin'); await ctx.reply('Lottery admin', Markup.inlineKeyboard([[Markup.button.callback('Open admin panel', 'lottery:admin:repost')]])); });
  bot.action(/^lottery:refresh$/, async (ctx:any)=>{ await ctx.answerCbQuery('Refreshing…'); return postOrRefreshShill(ctx); });
  bot.action(/^lottery:my$/, async (ctx:any)=>{
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id), tgId = String(ctx.from.id);
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/mytickets`, { method:'POST', body: JSON.stringify({ chatId, tgId }) });
    if (!r.ok) return ctx.reply(`Failed: ${r.error}`);
    if (!(r.data as any).running) return ctx.reply('No lottery running.');
    const x:any = r.data;
    return ctx.reply([`🎟️ My Tickets`, `Tickets: ${x.userTickets}`, `Spent: ${x.userSpentHuman}`, `Share: ${x.userSharePct}%`, `Pot: ${x.potHuman}`, `Ends: ${new Date(x.endsAt).toLocaleString()}`].join('\n'));
  });
  bot.action(/^lottery:buy:(\d+)$/, async (ctx:any)=>{
    const count = Number((ctx.match||[])[1]||1); const chatId=String(ctx.chat.id), tgId=String(ctx.from.id);
    const s=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/stats`, {method:'POST', body:JSON.stringify({chatId})}); if(!s.ok){ await ctx.answerCbQuery(`Failed: ${s.error}`, {show_alert:true}); return; }
    if(!(s.data as any).running){ await ctx.answerCbQuery('No lottery', {show_alert:true}); return; }
    const st:any=s.data; const amountRaw=(BigInt(String(st.ticketPriceRaw||'0')) * BigInt(count)).toString();
    const r=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/buy`, { method:'POST', body: JSON.stringify({ chatId, tgId, amountRaw, fromUsername: ctx.from?.username || '' }) });
    if(!r.ok){ await ctx.answerCbQuery(`Buy failed: ${r.error}`, {show_alert:true}); return; }
    await ctx.answerCbQuery(`Bought ${r.data.ticketCount} ticket(s)`);
    try { await postOrRefreshShill(ctx); } catch {}
  });

  bot.action(/^lottery:admin:(title|desc|image|duration|buttons)$/, async (ctx:any)=>{
    if (!(await isLotteryAdmin(ctx))) return ctx.answerCbQuery('Admins only', {show_alert:true});
    const field = (ctx.match||[])[1];
    pendingAdmin.set(`${ctx.chat.id}:${ctx.from.id}`, { field, expires: Date.now()+120000 } as any);
    await ctx.answerCbQuery('Send next message…');
    const hints:any = { title:'Send new title text', desc:'Send new description text', image:'Send image URL (or blank to clear)', duration:'Send duration like 30m / 2h / 1d', buttons:'Send CSV numbers like 1,3,5' };
    await ctx.reply(`✍️ ${hints[field]}`);
  });
  bot.action(/^lottery:admin:setup:(view|chain|token|ticket|duration|title)$/, async (ctx:any)=>{
    if (!(await isLotteryAdmin(ctx))) return ctx.answerCbQuery('Admins only', {show_alert:true});
    const mode = (ctx.match||[])[1];
    const chatId = String(ctx.chat.id);
    if (mode === 'view') {
      const setup = await getChatSetup(chatId);
      const tok = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/token-options`, { method:'POST', body: JSON.stringify({}) });
      let sym = '';
      if (tok.ok && setup?.defaultToken && setup?.defaultChainId) {
        const m = (((tok.data as any).items)||[]).find((x:any)=>Number(x.chainId)===Number(setup.defaultChainId)&&String(x.token).toLowerCase()===String(setup.defaultToken).toLowerCase());
        if (m) sym = String(m.symbol||'');
      }
      await ctx.answerCbQuery('Setup');
      return ctx.reply([
        '⚙️ Lottery setup',
        `Default chain: ${setup?.defaultChainId ?? '—'}`,
        `Default token: ${sym ? `${sym} ` : ''}${setup?.defaultToken ?? '—'}`,
        `Default ticket: ${setup?.defaultTicketPriceRaw ?? '— raw'}`,
        `Default duration: ${setup?.defaultDurationSec ? fmtDurationSec(setup.defaultDurationSec) : '—'}`,
        `Default title: ${setup?.defaultTitle ?? '—'}`,
        `Buy buttons: ${Array.isArray(setup?.buttonTicketOptions) ? setup.buttonTicketOptions.join(',') : '1,3,5'}`,
        '',
        'Create with defaults: /lottery start [title]'
      ].join('\n'));
    }
    const map:any = { chain:'setup_chain', token:'setup_token', ticket:'setup_ticket', duration:'setup_duration', title:'setup_title' };
    pendingAdmin.set(`${ctx.chat.id}:${ctx.from.id}`, { field: map[mode], expires: Date.now()+180000 } as any);
    await ctx.answerCbQuery('Send next message…');
    const hints:any = {
      chain: 'Send chainId (example: 43113)',
      token: 'Send token symbol or address. Use SYMBOL:chainId if needed (e.g. USDC:43113)',
      ticket: 'Send default ticket price (human), e.g. 1 or 0.5',
      duration: 'Send default duration like 30m / 2h / 1d',
      title: 'Send default title (or - to clear)'
    };
    return ctx.reply(`✍️ ${hints[mode]}`);
  });

  bot.action(/^lottery:admin:createfromdefaults$/, async (ctx:any)=>{
    if (!(await isLotteryAdmin(ctx))) return ctx.answerCbQuery('Admins only',{show_alert:true});
    await ctx.answerCbQuery('Creating…');
    const chatId = String(ctx.chat.id);
    const setup = await getChatSetup(chatId);
    if (!setup?.defaultChainId || !setup?.defaultToken || !setup?.defaultTicketPriceRaw || !setup?.defaultDurationSec) return ctx.reply('Setup incomplete. Configure defaults first.');
    const cr = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/create`, { method:'POST', body: JSON.stringify({
      chatId, chainId: Number(setup.defaultChainId), token: String(setup.defaultToken), ticketPriceRaw: String(setup.defaultTicketPriceRaw), durationSec: Number(setup.defaultDurationSec),
      title: setup.defaultTitle || null, buttonTicketOptions: Array.isArray(setup.buttonTicketOptions)&&setup.buttonTicketOptions.length?setup.buttonTicketOptions:[1,3,5], shillEnabled: true
    }) });
    if (!cr.ok) return ctx.reply(`Create failed: ${cr.error}`);
    await ctx.reply('✅ Lottery created from saved defaults.');
    return postOrRefreshShill(ctx);
  });

  bot.action(/^lottery:admin:repost$/, async (ctx:any)=>{ if (!(await isLotteryAdmin(ctx))) return ctx.answerCbQuery('Admins only', {show_alert:true}); await ctx.answerCbQuery('Reposting…'); await postOrRefreshShill(ctx); });
  bot.action(/^lottery:admin:cancel$/, async (ctx:any)=>{
    if (!(await isLotteryAdmin(ctx))) return ctx.answerCbQuery('Admins only',{show_alert:true});
    const r=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/cancel`, {method:'POST', body:JSON.stringify({chatId:String(ctx.chat.id)})});
    if(!r.ok) return ctx.answerCbQuery(`Cancel failed: ${r.error}`, {show_alert:true});
    await ctx.answerCbQuery('Cancelled');
    const refunded = !!(r.data as any)?.refunded;
    const cnt = Number((r.data as any)?.refundCount || 0);
    await ctx.reply(refunded ? `🛑 Lottery cancelled. ✅ Refunded ${cnt} wallet(s).` : '🛑 Lottery cancelled.');
  });
  bot.action(/^lottery:admin:draw$/, async (ctx:any)=>{
    if (!(await isLotteryAdmin(ctx))) return ctx.answerCbQuery('Admins only',{show_alert:true});
    const r=await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/draw`, {method:'POST', body:JSON.stringify({chatId:String(ctx.chat.id)})});
    if(!r.ok) return ctx.answerCbQuery(`Draw failed: ${r.error}`, {show_alert:true});
    await ctx.answerCbQuery('Draw processed');
    const d:any=r.data;
    if(!d.drawn) return ctx.reply(`Not drawn: ${d.reason || 'not due'}`);
    if(d.cancelled) return ctx.reply(`🎟️ Lottery ended with no entries.`);
    const uname = String(d.winnerUsername || '').replace(/^@+/, '');
    const winnerLabel = uname ? `@${uname}` : `tgId ${d.winnerTgId}`;
    await ctx.reply(`🏆 Lottery Drawn!\nWinner: ${winnerLabel}\nPayout: ${d.winnerHuman} ${d.tokenSymbol}\nPot: ${d.potHuman} ${d.tokenSymbol}`);
  });

  bot.on('text', async (ctx:any, next:any) => {
    const key = `${ctx.chat?.id}:${ctx.from?.id}`;
    const p = pendingAdmin.get(key);
    if (!p || p.expires < Date.now()) { if (p) pendingAdmin.delete(key); return next(); }
    pendingAdmin.delete(key);
    if (!(await isLotteryAdmin(ctx))) return next();
    const text = String(ctx.message?.text || '').trim();
    const chatId = String(ctx.chat.id);
    if (String(p.field).startsWith('setup_')) {
      if (p.field === 'setup_chain') {
        const chainId = Number(text);
        if (!Number.isFinite(chainId) || chainId <= 0) return ctx.reply('Bad chainId');
        const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/config/set`, { method:'POST', body: JSON.stringify({ chatId, defaultChainId: chainId, updatedByTgId: String(ctx.from.id) }) });
        if (!r.ok) return ctx.reply(`Setup failed: ${r.error}`);
        return ctx.reply(`✅ Default chain set: ${chainId}`);
      }
      if (p.field === 'setup_token') {
        const tok = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/token-options`, { method:'POST', body: JSON.stringify({}) });
        if (!tok.ok) return ctx.reply(`Token list failed: ${tok.error}`);
        const setup = await getChatSetup(chatId);
        const match = resolveTokenMatch(((tok.data as any).items||[]), text, Number(setup?.defaultChainId || cfg.chainId));
        if (!match) return ctx.reply('Token not found/enabled. Use /lotterytokens and optionally SYMBOL:chainId');
        const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/config/set`, { method:'POST', body: JSON.stringify({ chatId, defaultChainId: Number(match.chainId), defaultToken: String(match.token), updatedByTgId: String(ctx.from.id) }) });
        if (!r.ok) return ctx.reply(`Setup failed: ${r.error}`);
        return ctx.reply(`✅ Default token set: ${match.symbol} (chain ${match.chainId})`);
      }
      if (p.field === 'setup_ticket') {
        const setup = await getChatSetup(chatId);
        if (!setup?.defaultToken || !setup?.defaultChainId) return ctx.reply('Set default chain/token first.');
        const tok = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/token-options`, { method:'POST', body: JSON.stringify({}) });
        if (!tok.ok) return ctx.reply(`Token list failed: ${tok.error}`);
        const match = (((tok.data as any).items)||[]).find((x:any)=>Number(x.chainId)===Number(setup.defaultChainId)&&String(x.token).toLowerCase()===String(setup.defaultToken).toLowerCase());
        if (!match) return ctx.reply('Configured default token is not enabled anymore.');
        let raw: string; try { raw = parseHumanToRaw(text, Number(match.decimals||18)); } catch(e:any) { return ctx.reply(`Bad ticket price: ${String(e?.message||e)}`); }
        const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/config/set`, { method:'POST', body: JSON.stringify({ chatId, defaultTicketPriceRaw: raw, updatedByTgId: String(ctx.from.id) }) });
        if (!r.ok) return ctx.reply(`Setup failed: ${r.error}`);
        return ctx.reply(`✅ Default ticket price set: ${text} ${match.symbol}`);
      }
      if (p.field === 'setup_duration') {
        const sec = parseDurationText(text);
        if (!sec) return ctx.reply('Bad duration. Use 30m/2h/1d');
        const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/config/set`, { method:'POST', body: JSON.stringify({ chatId, defaultDurationSec: sec, updatedByTgId: String(ctx.from.id) }) });
        if (!r.ok) return ctx.reply(`Setup failed: ${r.error}`);
        return ctx.reply(`✅ Default duration set: ${fmtDurationSec(sec)}`);
      }
      if (p.field === 'setup_title') {
        const v = text === '-' ? null : text;
        const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/config/set`, { method:'POST', body: JSON.stringify({ chatId, defaultTitle: v, updatedByTgId: String(ctx.from.id) }) });
        if (!r.ok) return ctx.reply(`Setup failed: ${r.error}`);
        return ctx.reply(`✅ Default title ${v ? 'set' : 'cleared'}.`);
      }
      return;
    }

    const body: any = { chatId };
    if (p.field === 'title') body.title = text || null;
    if (p.field === 'desc') body.description = text || null;
    if (p.field === 'image') body.imageUrl = text || null;
    if (p.field === 'buttons') body.buttonTicketOptions = text.split(',').map((x:string)=>Number(x.trim())).filter((n:number)=>Number.isFinite(n)&&n>0).slice(0,8);
    if (p.field === 'duration') {
      const m=/^([0-9]+)([smhd])$/i.exec(text||''); if(!m) return ctx.reply('Bad duration. Use 30m/2h/1d');
      const n=Number(m[1]); const mult:any={s:1,m:60,h:3600,d:86400}; body.durationSec = n * mult[m[2].toLowerCase()];
    }
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/admin/update`, { method:'POST', body: JSON.stringify(body) });
    if (!r.ok) return ctx.reply(`Update failed: ${r.error}`);
    await ctx.reply('✅ Lottery updated.');
    try { await postOrRefreshShill(ctx); } catch {}
  });

  // background-ish on message traffic: draw due + shill repost if enabled
  bot.on('message', async (ctx:any, next:any) => {
    try {
      const chatId = String(ctx.chat?.id || '');
      const t = String(ctx.chat?.type || '');
      if (chatId && (t === 'group' || t === 'supergroup')) {
        seenChats.add(chatId);
        const key = `${chatId}`;
        if (!shillTickChats.has(key)) {
          shillTickChats.add(key);
          const tmr:any = setTimeout(() => shillTickChats.delete(key), 15000); if (tmr && typeof tmr.unref === 'function') tmr.unref();
          const d = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/drawIfDue`, { method:'POST', body: JSON.stringify({ chatId }) });
	          if (d.ok && (d.data as any).drawn) {
	            const x:any=d.data;
	            if (x.cancelled) await ctx.reply('🎟️ Lottery ended with no entries.');
	            else {
	              const uname = String(x.winnerUsername || '').replace(/^@+/, '');
	              const winnerLabel = uname ? `@${uname}` : `tgId ${x.winnerTgId}`;
	              await ctx.reply(`🏆 Lottery Drawn!\nWinner: ${winnerLabel}\nPayout: ${x.winnerHuman} ${x.tokenSymbol}\nPot: ${x.potHuman} ${x.tokenSymbol}`);
	            }
	          }
        }
      }
    } catch {}
    return next();
  });

  // Interval-based draw checks so lotteries complete at end time even if the chat is silent.
  const intervalSec = (() => {
    const v = Number(String(process.env.LOTTERY_DRAW_INTERVAL_SEC || '').trim() || '30');
    if (!Number.isFinite(v) || v <= 0) return 30;
    return Math.max(10, Math.min(300, Math.floor(v)));
  })();

  const poll = async () => {
    for (const chatId of Array.from(seenChats)) {
      try {
        const d = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/lottery/drawIfDue`, { method:'POST', body: JSON.stringify({ chatId }) });
	        if (d.ok && (d.data as any).drawn) {
	          const x:any=d.data;
	          if (x.cancelled) await bot.telegram.sendMessage(chatId, '🎟️ Lottery ended with no entries.');
	          else {
	            const uname = String(x.winnerUsername || '').replace(/^@+/, '');
	            const winnerLabel = uname ? `@${uname}` : `tgId ${x.winnerTgId}`;
	            await bot.telegram.sendMessage(chatId, `🏆 Lottery Drawn!\nWinner: ${winnerLabel}\nPayout: ${x.winnerHuman} ${x.tokenSymbol}\nPot: ${x.potHuman} ${x.tokenSymbol}`);
	          }
	        }
      } catch {}
    }
  };
  const tmr:any = setInterval(poll, intervalSec * 1000);
  if (tmr && typeof tmr.unref === 'function') tmr.unref();
}
