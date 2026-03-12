import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import crypto from 'crypto';

import type { Router } from 'express';
import type { Db } from 'mongodb';

import { normalizeAddress, userAccountId, treasuryAccountId } from '@hauscashier/common';

// We keep these as `any` to avoid tight coupling between packages; MongoDB is schemaless.
// core-api owns the authoritative collection typing.
type MongoCollections = any;
type SystemConfig = any;

export const DICE_ADMIN_ROOT_CB = 'tg_admin_dice';

// -------------------------
// shared helpers
// -------------------------

type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

type TgModuleLikeConfig = {
  coreApiUrl: string;
  moduleId: string;
  moduleKey: string;
  chainId: number;
};

function parseArgs(text?: string): string[] {
  return (text || '').trim().split(/\s+/).filter(Boolean);
}

function formatUnits(amountRaw: string, decimals: number): string {
  try {
    const neg = amountRaw.startsWith('-');
    const s = neg ? amountRaw.slice(1) : amountRaw;
    const n = BigInt(s || '0');
    const d = BigInt(10) ** BigInt(decimals);
    const whole = n / d;
    const frac = n % d;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    const out = fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
    return neg ? `-${out}` : out;
  } catch {
    return amountRaw;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function randHex(bytes = 16) {
  return '0x' + crypto.randomBytes(bytes).toString('hex');
}

function apiFetchFactory(cfg: TgModuleLikeConfig) {
  return async function apiFetch<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
    const base = String(cfg.coreApiUrl || '').replace(/\/+$/, '');
    const url = `${base}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-module-id': cfg.moduleId,
          'x-module-key': cfg.moduleKey,
          ...(init?.headers || {})
        }
      });
    } catch (e: any) {
      return { ok: false, error: `FETCH_FAILED:${String(e?.message || e)}` };
    }

    const json = await res.json().catch(() => ({} as any));
    if (!res.ok) return { ok: false, error: (json as any)?.error || (json as any)?.message || `HTTP_${res.status}` };
    return { ok: true, data: json as T };
  };
}

// -------------------------
// Telegram integration
// -------------------------

export function registerDiceTelegram(bot: Telegraf, cfg: TgModuleLikeConfig) {
  const apiFetch = apiFetchFactory(cfg);

  const adminIds = new Set(
    String(process.env.TG_ADMIN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  async function isAdminTg(ctx: any): Promise<boolean> {
    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return false;
    return adminIds.has(tgId);
  }

  // Admin prompt-capture states (same pattern as welcome setup)
  type DiceAdminState =
    | { mode: 'enable_token' }
    | { mode: 'remove_token' }
    | { mode: 'set_default' }
    | { mode: 'fund' }
    | null;

  const adminState = new Map<string, DiceAdminState>();

  async function diceInfo() {
    return apiFetch<any>(`/modules/${cfg.moduleId}/tg/dice/info`, {
      method: 'POST',
      body: JSON.stringify({ chainId: cfg.chainId })
    } as any);
  }

  function renderDiceInfo(d: any): string {
    const enabled = Array.isArray(d?.enabledTokens) ? d.enabledTokens : [];
    const def = String(d?.defaultTokenSymbol || '').trim();

    const lines: string[] = [];
    lines.push(`🎲 Dice (${cfg.chainId})`);
    lines.push(`Default: ${def || '(not set)'}`);
    lines.push(`Enabled tokens: ${enabled.length ? enabled.join(', ') : '(none)'}`);
    return lines.join('\n');
  }

  // /dice <amount> [token]
  bot.command('dice', async (ctx) => {
    try {
      const parts = parseArgs((ctx.message as any)?.text);
      // ['/dice', ...]
      const a1 = parts[1] ? String(parts[1]).trim() : '';
      const a2 = parts[2] ? String(parts[2]).trim() : '';

      if (!a1 || a1.toLowerCase() === 'help') {
        const info = await diceInfo();
        const extra = info.ok ? `\n\n${renderDiceInfo(info.data)}` : '';
        return ctx.reply(
          `Usage:\n` +
            `/dice <amount> [SYMBOL]\n\n` +
            `Examples:\n` +
            `/dice 50\n` +
            `/dice 2.5 usdc\n` +
            `/dice help\n` +
            extra
        );
      }

      if (a1.toLowerCase() === 'tokens') {
        const info = await diceInfo();
        if (!info.ok) return ctx.reply(`Failed: ${info.error}`);
        return ctx.reply(renderDiceInfo(info.data));
      }

      const betHuman = a1;
      const asset = a2; // optional

      const tgId = String(ctx.from?.id || '').trim();
      const msgId = Number((ctx.message as any)?.message_id || 0);

      const r = await apiFetch<any>(`/modules/${cfg.moduleId}/tg/dice/roll`, {
        method: 'POST',
        body: JSON.stringify({ tgId, chainId: cfg.chainId, betHuman, asset, msgId })
      } as any);

      if (!r.ok) return ctx.reply(`Dice failed: ${r.error}`);

      const out = r.data || {};
      const sym = String(out.symbol || '').trim();
      const dec = Number(out.decimals ?? 18);

      const betRaw = String(out.betRaw || '0');
      const payoutRaw = String(out.payoutRaw || '0');
      const feeRaw = String(out.feeRaw || '0');
      const feeBps = Number(out.feeBps ?? 0);

      const betFmt = formatUnits(betRaw, dec);
      const payoutFmt = formatUnits(payoutRaw, dec);
      const feeFmt = formatUnits(feeRaw, dec);

      const roll = out.roll;
      const mul = out.multiplier;
      const outcome = String(out.outcome || '').toUpperCase();

      const lines: string[] = [];
      lines.push(`🎲 Roll: ${roll}`);
      lines.push(`Multiplier: x${mul}`);
      lines.push(`Bet: ${betFmt} ${sym}`);
      if (BigInt(feeRaw || '0') > 0n) lines.push(`Loss fee: ${feeFmt} ${sym} (${feeBps} bps → fees bucket)`);
      lines.push(`Result: ${outcome === 'WIN' ? '✅ WIN' : '❌ LOSS'}`);
      if (BigInt(feeRaw || '0') > 0n) lines.push(`To dice bank: ${formatUnits((BigInt(betRaw||'0')-BigInt(feeRaw||'0')).toString(), dec)} ${sym}`);
      if (outcome === 'WIN') lines.push(`Payout: ${payoutFmt} ${sym}`);

      return ctx.reply(lines.join('\n'));
    } catch (e: any) {
      return ctx.reply(`Dice error: ${String(e?.message || e)}`);
    }
  });

  // ---- Admin menu wiring ----

  async function showDiceAdminRoot(ctx: any) {
    const info = await diceInfo();
    const header = info.ok ? renderDiceInfo(info.data) : `Failed to load dice config: ${info.error}`;

    await (ctx as any).reply(
      `${header}\n\nAdmin actions:`,
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Enable token', 'dice_admin_enable')],
        [Markup.button.callback('➖ Remove token', 'dice_admin_remove')],
        [Markup.button.callback('⭐ Set default token', 'dice_admin_set_default')],
        [Markup.button.callback('💰 Fund dice treasury', 'dice_admin_fund')],
        [Markup.button.callback('🔄 Refresh', 'dice_admin_refresh')]
      ])
    );
  }

  bot.action(DICE_ADMIN_ROOT_CB, async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      await ctx.answerCbQuery('Dice…');
      await showDiceAdminRoot(ctx);
    } catch (e) {
      console.error('[dice] admin root failed', e);
    }
  });

  bot.action('dice_admin_refresh', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      await ctx.answerCbQuery('Refreshing…');
      await showDiceAdminRoot(ctx);
    } catch (e) {
      console.error('[dice] refresh failed', e);
    }
  });

  bot.action('dice_admin_enable', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      adminState.set(String(ctx.from?.id || ''), { mode: 'enable_token' });
      await ctx.answerCbQuery('Send token symbol or 0x…');
      await (ctx as any).reply('Send token SYMBOL (e.g. USDC) or 0xTokenAddress to enable for Dice.');
    } catch (e) {
      console.error('[dice] enable prompt failed', e);
    }
  });

  bot.action('dice_admin_remove', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      adminState.set(String(ctx.from?.id || ''), { mode: 'remove_token' });
      await ctx.answerCbQuery('Send token symbol or 0x…');
      await (ctx as any).reply('Send token SYMBOL (e.g. USDC) or 0xTokenAddress to remove from Dice.');
    } catch (e) {
      console.error('[dice] remove prompt failed', e);
    }
  });

  bot.action('dice_admin_set_default', async (ctx) => {
  try {
    if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    adminState.set(String(ctx.from?.id || ''), { mode: 'set_default' });
    await ctx.answerCbQuery('Send token symbol…');
    await (ctx as any).reply('Send token SYMBOL (e.g. USDC) to set as Dice default. Must already be enabled.');
  } catch (e) {
    console.error('[dice] set default prompt failed', e);
  }
});

bot.action('dice_admin_fund', async (ctx) => {
  try {
    if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    adminState.set(String(ctx.from?.id || ''), { mode: 'fund' });
    // ACK with a hint so Telegram stops pulsing + user knows what to do next
    await ctx.answerCbQuery('Send amount (e.g. "50 usdc")');
    await (ctx as any).reply('Send funding amount like: "50" (uses default) or "50 USDC"');
  } catch (e) {
    console.error('[dice] fund prompt failed', e);
  }
});

bot.on('text', async (ctx, next) => {
    try {
      const tgId = String(ctx.from?.id || '').trim();
      if (!tgId) return next();

      const st = adminState.get(tgId);
      if (!st) return next();

      // don't swallow commands
      const msg = String((ctx.message as any)?.text || '');
      if (msg.trim().startsWith('/')) return next();

      if (!(await isAdminTg(ctx))) {
        adminState.delete(tgId);
        return next();
      }

      const asset = msg.trim();
      adminState.delete(tgId);

      if (st.mode === 'enable_token') {
        const r = await apiFetch<any>(`/modules/${cfg.moduleId}/tg/dice/admin/enableToken`, {
          method: 'POST',
          body: JSON.stringify({ chainId: cfg.chainId, asset })
        } as any);
        if (!r.ok) return ctx.reply(`Failed: ${r.error}`);
        await ctx.reply('✅ Enabled.');
        return showDiceAdminRoot(ctx);
      }

      if (st.mode === 'remove_token') {
        const r = await apiFetch<any>(`/modules/${cfg.moduleId}/tg/dice/admin/removeToken`, {
          method: 'POST',
          body: JSON.stringify({ chainId: cfg.chainId, asset })
        } as any);
        if (!r.ok) return ctx.reply(`Failed: ${r.error}`);
        await ctx.reply('✅ Removed.');
        return showDiceAdminRoot(ctx);
      }

      if (st.mode === 'set_default') {
        const r = await apiFetch<any>(`/modules/${cfg.moduleId}/tg/dice/admin/setDefault`, {
          method: 'POST',
          body: JSON.stringify({ chainId: cfg.chainId, asset })
        } as any);
        if (!r.ok) return ctx.reply(`Failed: ${r.error}`);
        await ctx.reply('✅ Default set.');
        return showDiceAdminRoot(ctx);
      }


      if (st.mode === 'fund') {
        const parts = parseArgs(asset);
        const amountHuman = parts[0] || '';
        const tok = parts[1] || '';
        const msgId2 = Number((ctx.message as any)?.message_id || 0);

        if (!amountHuman) return ctx.reply('Missing amount. Example: "50 usdc"');

        const r = await apiFetch<any>(`/modules/${cfg.moduleId}/tg/dice/admin/fund`, {
          method: 'POST',
          body: JSON.stringify({ tgId, chainId: cfg.chainId, amountHuman, asset: tok, msgId: msgId2 })
        } as any);
        if (!r.ok) return ctx.reply(`Failed: ${r.error}`);
        await ctx.reply(`✅ Funded dice treasury.`);
        return showDiceAdminRoot(ctx);
      }

return next();
    } catch {
      return next();
    }
  });
}

// -------------------------
// core-api integration
// -------------------------

function isEvmAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(String(v || '').trim());
}

function parseUnits(amount: string, decimals: number): string {
  const s = String(amount || '').trim();
  if (!s) throw new Error('BAD_AMOUNT');
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('BAD_AMOUNT');

  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error('TOO_MANY_DECIMALS');
  const fracPadded = frac.padEnd(decimals, '0');
  const combined = `${whole}${fracPadded}`.replace(/^0+/, '') || '0';
  return BigInt(combined).toString();
}

function getDiceCfg(moduleDoc: any) {
  const dice = (moduleDoc as any)?.gameConfig?.dice || {};
  const enabledTokensByChain = dice.enabledTokensByChain || {};
  const defaultTokenByChain = dice.defaultTokenByChain || {};
  return { dice, enabledTokensByChain, defaultTokenByChain };
}

function diceTreasuryIdFor(chainId: number, symbol: string) {
  const s = String(symbol || '').trim().toLowerCase() || 'token';
  return `dice-${chainId}-${s}`;
}

type ResolvedEnabledToken = {
  enabled: true;
  token: string; // lowercase address
  symbol: string;
  decimals: number;
};

function isResolvedEnabledToken(t: any): t is ResolvedEnabledToken {
  return (
    !!t &&
    t.enabled === true &&
    typeof t.token === 'string' &&
    t.token.length > 0 &&
    typeof t.symbol === 'string' &&
    t.symbol.length > 0 &&
    Number.isFinite(Number(t.decimals))
  );
}

function resolveEnabledTokenFromCfg(cfg: SystemConfig, chainId: number, asset: string) {
  const chain = (cfg?.chains || []).find((c: any) => Number(c.chainId) === Number(chainId) && c.enabled);
  if (!chain) return null;
  const tokens = Array.isArray(chain.tokens) ? chain.tokens : [];
  const enabled = tokens.filter((t: any) => t && t.enabled);

  const a = String(asset || '').trim();
  let al = a.toLowerCase();

  const wNative = String(chain.vaults?.[0]?.wNative || '').toLowerCase();

  // BSC convenience aliases: bnb/wbnb/native -> wNative (wBNB)
  if (Number(chainId) === 56 && (al === 'bnb' || al === 'wbnb' || al === 'native')) {
    al = 'native';
  }

  // Map native -> wrapped native (wNative) for this chain
  if (al === 'native' && wNative) {
    const t = enabled.find((x: any) => String(x.address || '').toLowerCase() === wNative);
    if (!t) return { enabled: false };
    return { enabled: true, token: String(t.address).toLowerCase(), symbol: Number(chainId) === 56 ? 'BNB' : String(t.symbol), decimals: Number(t.decimals) };
  }

  if (isEvmAddress(a)) {
    const t = enabled.find((x: any) => String(x.address || '').toLowerCase() === al);
    if (!t) return { enabled: false };
    if (!t.address || !t.symbol) return { enabled: false };
    const addr = String(t.address).toLowerCase();
    const sym = (Number(chainId) === 56 && wNative && addr === wNative) ? 'BNB' : String(t.symbol);
    return { enabled: true, token: addr, symbol: sym, decimals: Number(t.decimals) };
  }

  // symbol alias support
  if (Number(chainId) === 56 && al === 'wbnb') al = 'bnb';

  const t = enabled.find((x: any) => String(x.symbol || '').toLowerCase() === al);
  if (!t) return { enabled: false };
  if (!t.address || !t.symbol) return { enabled: false };
  const addr = String(t.address).toLowerCase();
  const sym = (Number(chainId) === 56 && wNative && addr === wNative) ? 'BNB' : String(t.symbol);
  return { enabled: true, token: addr, symbol: sym, decimals: Number(t.decimals) };
}

async function ensureTreasury(col: MongoCollections, moduleId: string, chainId: number, token: string, symbol: string) {
  const symIn = String(symbol || '').trim();
  const canonicalSymbol =
    (Number(chainId) === 56 && ['BNB', 'WBNB'].includes(symIn.toUpperCase()))
      ? 'BNB'
      : symIn;

  const desiredId = diceTreasuryIdFor(chainId, canonicalSymbol);

  // Back-compat: if you already created dice-56-wbnb, keep using it (so BNB/WBNB don't split buckets)
  const legacyId = (Number(chainId) === 56 && canonicalSymbol === 'BNB') ? diceTreasuryIdFor(chainId, 'WBNB') : '';

  let treasuryId = desiredId;
  if (legacyId) {
    const legacy = await col.treasuries.findOne({ _id: legacyId });
    if (legacy) treasuryId = legacyId;
  }

  const existing = await col.treasuries.findOne({ _id: treasuryId });
  if (!existing) {
    const doc = {
      _id: treasuryId,
      treasuryId,
      moduleId,
      label: `Dice Treasury (${canonicalSymbol})`,
      chainId,
      token: token.toLowerCase(),
      enabled: true,
      maxBetBps: Number(process.env.DICE_MAX_BET_BPS ?? 500),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await col.treasuries.insertOne(doc as any);
  } else {
    // keep label up to date
    await col.treasuries.updateOne(
      { _id: treasuryId },
      { $set: { label: `Dice Treasury (${canonicalSymbol})`, updatedAt: new Date() } }
    );
  }

  // Ensure module allowedTreasuries includes it
  await col.modules.updateOne(
    { _id: moduleId },
    { $addToSet: { allowedTreasuries: treasuryId }, $set: { updatedAt: new Date() } }
  );

  return treasuryId;
}

function pickRoll6() {
  // 1..6
  const b = crypto.randomBytes(1)[0];
  return (b % 6) + 1;
}

function pickMul25() {
  // 50/50
  const b = crypto.randomBytes(1)[0];
  return (b & 1) === 0 ? 2 : 5;
}

export function registerDiceCoreRoutes(args: {
  r: Router;
  db: Db;
  col: MongoCollections;
  cfg: SystemConfig;
  requireModuleMw: any;
  requireJwtMw?: any;
  applyLedgerEntry: any;
}) {
  const { r, db, col, cfg, requireModuleMw, requireJwtMw, applyLedgerEntry } = args;

  const adminIds = new Set(
    String(process.env.TG_ADMIN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const isAdminTgId = (tgId: string) => adminIds.has(String(tgId || '').trim());

  const tgAccountId = (moduleId: string, tgId: string) => `tg:${String(moduleId || '').trim()}:${String(tgId || '').trim()}`;

  async function assertTgNotLocked(moduleId: string, tgId: string) {
    const lock = await col.tgLinkLocks?.findOne({ _id: `lock:${moduleId}:${tgId}` });
    const until = Number((lock as any)?.lockedUntil || 0);
    if (until && until > Date.now()) throw new Error('LINK_IN_PROGRESS');
  }




  function browserDiceModuleId() {
    return String(process.env.BROWSER_DICE_MODULE_ID || 'tg').trim() || 'tg';
  }

  async function loadBrowserDiceModuleDoc() {
    const moduleId = browserDiceModuleId();
    const moduleDoc = await col.modules.findOne({ _id: moduleId });
    if (!moduleDoc || !(moduleDoc as any).enabled) throw new Error('DICE_MODULE_DISABLED');
    return { moduleId, moduleDoc };
  }

  // Public-ish info for TG module (still requireModule)
  r.post('/modules/:moduleId/tg/dice/info', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '').trim();
      const chainId = Number(req.body?.chainId);
      if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });
      if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

      const { enabledTokensByChain, defaultTokenByChain } = getDiceCfg(req.moduleDoc);
      const enabled: string[] = Array.isArray(enabledTokensByChain[String(chainId)])
        ? enabledTokensByChain[String(chainId)].map((x: any) => String(x).toLowerCase())
        : [];

      // convert to symbols for display
      const chain = (cfg?.chains || []).find((c: any) => Number(c.chainId) === Number(chainId) && c.enabled);
      const metaByToken = new Map<string, any>();
      (chain?.tokens || []).forEach((t: any) => metaByToken.set(String(t.address || '').toLowerCase(), t));

      const enabledSymbols = enabled
        .map((t) => metaByToken.get(t)?.symbol)
        .filter(Boolean);

      const defTok = String(defaultTokenByChain[String(chainId)] || '').toLowerCase();
      const defSym = defTok ? metaByToken.get(defTok)?.symbol : '';

      return res.json({
        ok: true,
        chainId,
        enabledTokens: enabledSymbols,
        defaultToken: defTok || '',
        defaultTokenSymbol: defSym || ''
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'SERVER_ERROR' });
    }
  });

  // Admin config endpoints (called via TG admin menu)
  r.post('/modules/:moduleId/tg/dice/admin/enableToken', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '').trim();
      const chainId = Number(req.body?.chainId);
      const asset = String(req.body?.asset || '').trim();
      if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });
      if (!asset) return res.status(400).json({ error: 'MISSING_ASSET' });
      if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

      const tok0 = resolveEnabledTokenFromCfg(cfg, chainId, asset);
      if (!isResolvedEnabledToken(tok0)) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_IN_SYSTEM' });
      const tok = tok0;

      // Ensure treasury + allowlist
      await ensureTreasury(col, moduleId, chainId, tok.token, tok.symbol);

      const moduleDoc = await col.modules.findOne({ _id: moduleId });
      const { enabledTokensByChain, defaultTokenByChain } = getDiceCfg(moduleDoc);

      const key = String(chainId);
      const cur = Array.isArray(enabledTokensByChain[key]) ? enabledTokensByChain[key].map((x: any) => String(x).toLowerCase()) : [];
      if (!cur.includes(tok.token)) cur.push(tok.token);
      enabledTokensByChain[key] = cur;

      if (!defaultTokenByChain[key]) defaultTokenByChain[key] = tok.token;

      await col.modules.updateOne(
        { _id: moduleId },
        {
          $set: {
            'gameConfig.dice.enabledTokensByChain': enabledTokensByChain,
            'gameConfig.dice.defaultTokenByChain': defaultTokenByChain,
            updatedAt: new Date()
          }
        }
      );

      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'FAILED' });
    }
  });

  r.post('/modules/:moduleId/tg/dice/admin/removeToken', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '').trim();
      const chainId = Number(req.body?.chainId);
      const asset = String(req.body?.asset || '').trim();
      if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });
      if (!asset) return res.status(400).json({ error: 'MISSING_ASSET' });
      if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

      const tok0 = resolveEnabledTokenFromCfg(cfg, chainId, asset);
      if (!isResolvedEnabledToken(tok0)) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_IN_SYSTEM' });
      const tok = tok0;

      const moduleDoc = await col.modules.findOne({ _id: moduleId });
      const { enabledTokensByChain, defaultTokenByChain } = getDiceCfg(moduleDoc);

      const key = String(chainId);
      const cur = Array.isArray(enabledTokensByChain[key]) ? enabledTokensByChain[key].map((x: any) => String(x).toLowerCase()) : [];
      enabledTokensByChain[key] = cur.filter((x: string) => x !== tok.token);

      if (String(defaultTokenByChain[key] || '').toLowerCase() === tok.token) {
        defaultTokenByChain[key] = enabledTokensByChain[key]?.[0] || '';
      }

      await col.modules.updateOne(
        { _id: moduleId },
        {
          $set: {
            'gameConfig.dice.enabledTokensByChain': enabledTokensByChain,
            'gameConfig.dice.defaultTokenByChain': defaultTokenByChain,
            updatedAt: new Date()
          }
        }
      );

      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'FAILED' });
    }
  });

  r.post('/modules/:moduleId/tg/dice/admin/setDefault', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '').trim();
      const chainId = Number(req.body?.chainId);
      const asset = String(req.body?.asset || '').trim();
      if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });
      if (!asset) return res.status(400).json({ error: 'MISSING_ASSET' });
      if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

      const tok0 = resolveEnabledTokenFromCfg(cfg, chainId, asset);
      if (!isResolvedEnabledToken(tok0)) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_IN_SYSTEM' });
      const tok = tok0;

      const moduleDoc = await col.modules.findOne({ _id: moduleId });
      const { enabledTokensByChain, defaultTokenByChain } = getDiceCfg(moduleDoc);

      const key = String(chainId);
      const cur = Array.isArray(enabledTokensByChain[key]) ? enabledTokensByChain[key].map((x: any) => String(x).toLowerCase()) : [];
      if (!cur.includes(tok.token)) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_FOR_DICE' });

      defaultTokenByChain[key] = tok.token;

      await col.modules.updateOne(
        { _id: moduleId },
        {
          $set: {
            'gameConfig.dice.defaultTokenByChain': defaultTokenByChain,
            updatedAt: new Date()
          }
        }
      );

      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'FAILED' });
    }
  });


  // Fund dice treasury from an admin's wallet credits
  r.post('/modules/:moduleId/tg/dice/admin/fund', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '').trim();
      if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
      if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

      const tgId = String(req.body?.tgId || '').trim();
      const chainId = Number(req.body?.chainId);
      const amountHuman = String(req.body?.amountHuman || '').trim();
      const asset = String(req.body?.asset || '').trim();
      const msgId = String(req.body?.msgId || '').trim();

      if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });
      if (!isAdminTgId(tgId)) return res.status(403).json({ error: 'NOT_ADMIN' });
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });
      if (!amountHuman) return res.status(400).json({ error: 'BAD_AMOUNT' });

      // Telegram-first onboarding: allow unlinked users to play from tg:<moduleId>:<tgId>.
      // Also prevent spends while a link-merge is running.
      try {
        await assertTgNotLocked(moduleId, tgId);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'LINK_IN_PROGRESS' });
      }

      const link = await col.tgLinks.findOne({ _id: `${moduleId}:tg:${tgId}` });
      const senderLinked = !!(link && (link as any).ownerWallet);
      const fromAccountId = senderLinked ? userAccountId(String((link as any).ownerWallet)) : tgAccountId(moduleId, tgId);

      const moduleDoc = await col.modules.findOne({ _id: moduleId });
      const { enabledTokensByChain, defaultTokenByChain } = getDiceCfg(moduleDoc);
      const key = String(chainId);
      const enabled: string[] = Array.isArray(enabledTokensByChain[key])
        ? enabledTokensByChain[key].map((x: any) => String(x).toLowerCase())
        : [];

      if (!enabled.length) return res.status(400).json({ error: 'DICE_NO_ENABLED_TOKENS' });

      let resolved: any;
      if (asset) {
        resolved = resolveEnabledTokenFromCfg(cfg, chainId, asset);
      } else {
        const defTok = String(defaultTokenByChain[key] || '').toLowerCase();
        if (!defTok) return res.status(400).json({ error: 'DICE_DEFAULT_TOKEN_NOT_SET' });
        resolved = { enabled: true, token: defTok, symbol: '', decimals: 18 };
        const chain = (cfg?.chains || []).find((c: any) => Number(c.chainId) === Number(chainId) && c.enabled);
        const meta = (chain?.tokens || []).find((t: any) => String(t.address || '').toLowerCase() === defTok);
        if (meta) {
          resolved.symbol = meta.symbol;
          resolved.decimals = meta.decimals;
        }
      }

      if (!resolved || !resolved.enabled) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_IN_SYSTEM' });

      const token = String(resolved.token || '').toLowerCase();
      if (!enabled.includes(token)) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_FOR_DICE' });

      const symbol = String(resolved.symbol || token.slice(0, 6));
      const decimals = Number(resolved.decimals ?? 18);

      const amountRaw = parseUnits(amountHuman, decimals);
      if (BigInt(amountRaw) <= 0n) return res.status(400).json({ error: 'BAD_AMOUNT' });

      const treasuryId = await ensureTreasury(col, moduleId, chainId, token, symbol);

      const userAcc = userAccountId(String(link.ownerWallet || ''));
      const treAcc = treasuryAccountId(treasuryId);

      const userBalRow = await col.balances.findOne({ _id: `${userAcc}:${chainId}:${token}` });
      const userBal = BigInt(String(userBalRow?.balanceRaw || '0'));
      const amt = BigInt(amountRaw);
      if (userBal < amt) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });

      const baseRef = `dicefund:${moduleId}:${tgId}:${msgId || randHex(8)}:${chainId}:${token}:${amountRaw}`;

      const session = db.client.startSession();
      try {
        await session.withTransaction(async () => {
          await applyLedgerEntry(db, col, session, {
            refId: baseRef,
            kind: 'dice_fund',
            chainId,
            token,
            moduleId,
            fromAccountId: userAcc,
            toAccountId: treAcc,
            amountRaw,
            meta: { game: 'dice', action: 'fund', tgId, msgId, ts: nowIso() }
          });
        });
      } finally {
        await session.endSession();
      }

      return res.json({ ok: true, chainId, token, symbol, decimals, amountRaw, treasuryId });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'FAILED' });
    }
  });

// Roll endpoint (single-shot dice)
  r.post('/modules/:moduleId/tg/dice/roll', requireModuleMw(col), async (req: any, res: any) => {
    try {
      const moduleId = String(req.params.moduleId || '').trim();
      if (!moduleId) return res.status(400).json({ error: 'BAD_MODULE_ID' });
      if (req.moduleDoc!._id !== moduleId) return res.status(403).json({ error: 'MODULE_ID_MISMATCH' });

      const tgId = String(req.body?.tgId || '').trim();
      const chainId = Number(req.body?.chainId);
      const betHuman = String(req.body?.betHuman || '').trim();
      const asset = String(req.body?.asset || '').trim();
      const msgId = String(req.body?.msgId || '').trim();

      if (!tgId) return res.status(400).json({ error: 'BAD_TGID' });
      if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });
      if (!betHuman) return res.status(400).json({ error: 'BAD_BET' });

      // Telegram-first onboarding: allow unlinked users to play from tg:<moduleId>:<tgId>.
      // Also prevent spends while a link-merge is running.
      try {
        await assertTgNotLocked(moduleId, tgId);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'LINK_IN_PROGRESS' });
      }

      const link = await col.tgLinks.findOne({ _id: `${moduleId}:tg:${tgId}` });
      const senderLinked = !!(link && (link as any).ownerWallet);
      const fromAccountId = senderLinked ? userAccountId(String((link as any).ownerWallet)) : tgAccountId(moduleId, tgId);

      const moduleDoc = await col.modules.findOne({ _id: moduleId });
      const { enabledTokensByChain, defaultTokenByChain } = getDiceCfg(moduleDoc);
      const key = String(chainId);
      const enabled: string[] = Array.isArray(enabledTokensByChain[key])
        ? enabledTokensByChain[key].map((x: any) => String(x).toLowerCase())
        : [];

      if (!enabled.length) return res.status(400).json({ error: 'DICE_NO_ENABLED_TOKENS' });

      const chosenAsset = asset || '';
      let resolved: any;

      if (chosenAsset) {
        resolved = resolveEnabledTokenFromCfg(cfg, chainId, chosenAsset);
      } else {
        const defTok = String(defaultTokenByChain[key] || '').toLowerCase();
        if (!defTok) return res.status(400).json({ error: 'DICE_DEFAULT_TOKEN_NOT_SET' });
        resolved = { enabled: true, token: defTok, symbol: '', decimals: 18 };
        // fill meta
        const chain = (cfg?.chains || []).find((c: any) => Number(c.chainId) === Number(chainId) && c.enabled);
        const meta = (chain?.tokens || []).find((t: any) => String(t.address || '').toLowerCase() === defTok);
        if (meta) {
          resolved.symbol = meta.symbol;
          resolved.decimals = meta.decimals;
        }
      }

      if (!resolved || !resolved.enabled) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_IN_SYSTEM' });

      const token = String(resolved.token || '').toLowerCase();
      if (!enabled.includes(token)) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_FOR_DICE' });

      const symbol = String(resolved.symbol || token.slice(0, 6));
      const decimals = Number(resolved.decimals ?? 18);

      const betRaw = parseUnits(betHuman, decimals);
      if (BigInt(betRaw) <= 0n) return res.status(400).json({ error: 'BAD_BET' });

      // ensure treasury exists + allowed
      const treasuryId = await ensureTreasury(col, moduleId, chainId, token, symbol);

      // balances
      const userAcc = userAccountId(String(link.ownerWallet || ''));
      const treAcc = treasuryAccountId(treasuryId);

      const userBalRow = await col.balances.findOne({ _id: `${userAcc}:${chainId}:${token}` });
      const userBal = BigInt(String(userBalRow?.balanceRaw || '0'));
      const bet = BigInt(betRaw);
      if (userBal < bet) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });

      // Treasury balance (used for solvency + OG max-bet cap)
      const treBalRow = await col.balances.findOne({ _id: `${treAcc}:${chainId}:${token}` });
      const treBal = BigInt(String(treBalRow?.balanceRaw || '0'));

      // OG dice max bet: treasuryBalance * maxBetBps (default 500 = 5%)
      const treDoc = await col.treasuries.findOne({ _id: treasuryId });
      const maxBetBps = Math.max(0, Number(treDoc?.maxBetBps ?? process.env.DICE_MAX_BET_BPS ?? 500) || 0);
      const maxBetRaw = (treBal * BigInt(maxBetBps)) / 10_000n;
      if (maxBetRaw > 0n && bet > maxBetRaw) {
        return res.status(400).json({ error: `BET_EXCEEDS_MAX_${maxBetBps}BPS` });
      }

      // RNG (roll + multiplier chosen at roll time)
      const roll = pickRoll6();
      const multiplier = pickMul25();
      const isWin = roll === 6;

      // Loss split fee (only on LOSS): fee to fees bucket, remainder to dice bank
      const lossFeeBps = Math.max(0, Math.min(10_000, Number(process.env.DICE_LOSS_FEE_BPS ?? 3000) || 0));
      const fee = (!isWin && lossFeeBps > 0) ? (bet * BigInt(lossFeeBps)) / 10_000n : 0n;
      const payout = isWin ? bet * BigInt(multiplier) : 0n;

      // Require treasury can cover worst-case extra (5x => extra 4x) BEFORE accepting bet.
      const requiredExtra = bet * 4n;
      if (treBal < requiredExtra) return res.status(400).json({ error: 'TREASURY_INSUFFICIENT_FOR_5X' });

      // Idempotency base
      const baseRef = `dice:${moduleId}:${tgId}:${msgId || randHex(8)}:${chainId}:${token}:${betRaw}`;

      const session = db.client.startSession();
      try {
        await session.withTransaction(async () => {
          await applyLedgerEntry(db, col, session, {
            refId: `${baseRef}:bet`,
            kind: 'dice_bet',
            chainId,
            token,
            moduleId,
            fromAccountId: userAcc,
            toAccountId: treAcc,
            amountRaw: (isWin ? betRaw : (bet - fee).toString()),
            meta: { game: 'dice', tgId, msgId, roll, multiplier, ts: nowIso() }
          });

          if (fee > 0n) {
            const feeTreasuryId = String(process.env.FEE_TREASURY_ID || 'fees');
            const feeAcc = treasuryAccountId(feeTreasuryId);
            await applyLedgerEntry(db, col, session, {
              refId: `${baseRef}:fee`,
              kind: 'dice_loss_fee',
              chainId,
              token,
              moduleId,
              fromAccountId: userAcc,
              toAccountId: feeAcc,
              amountRaw: fee.toString(),
              meta: { game: 'dice', tgId, msgId, roll, multiplier, lossFeeBps, ts: nowIso() }
            });
          }



          if (payout > 0n) {
            await applyLedgerEntry(db, col, session, {
              refId: `${baseRef}:payout`,
              kind: 'dice_payout',
              chainId,
              token,
              moduleId,
              fromAccountId: treAcc,
              toAccountId: userAcc,
              amountRaw: payout.toString(),
              meta: { game: 'dice', tgId, msgId, roll, multiplier, ts: nowIso() }
            });
          }
        });
      } finally {
        await session.endSession();
      }

      return res.json({
        ok: true,
        chainId,
        token,
        symbol,
        decimals,
        treasuryId,
        betRaw,
        roll,
        multiplier,
        payoutRaw: payout.toString(),
        feeBps: lossFeeBps,
        feeRaw: fee.toString(),
        outcome: isWin ? 'WIN' : 'LOSS'
      });
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'FAILED' });
    }
  });


  if (requireJwtMw) {
    r.post('/games/dice/info', requireJwtMw, async (req: any, res: any) => {
      try {
        const chainId = Number(req.body?.chainId ?? req.query?.chainId ?? process.env.BROWSER_DICE_CHAIN_ID ?? 43113);
        if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });

        const { moduleId, moduleDoc } = await loadBrowserDiceModuleDoc();
        const { enabledTokensByChain, defaultTokenByChain } = getDiceCfg(moduleDoc);
        const enabled: string[] = Array.isArray(enabledTokensByChain[String(chainId)])
          ? enabledTokensByChain[String(chainId)].map((x: any) => String(x).toLowerCase())
          : [];

        const chain = (cfg?.chains || []).find((c: any) => Number(c.chainId) === Number(chainId) && c.enabled);
        const metaByToken = new Map<string, any>();
        (chain?.tokens || []).forEach((t: any) => metaByToken.set(String(t.address || '').toLowerCase(), t));

        const enabledTokenMeta = enabled.map((t) => {
          const meta = metaByToken.get(t);
          return {
            token: t,
            symbol: String(meta?.symbol || t.slice(0, 6)).toUpperCase(),
            decimals: Number(meta?.decimals ?? 18)
          };
        });

        const defTok = String(defaultTokenByChain[String(chainId)] || '').toLowerCase();
        const defSym = defTok ? metaByToken.get(defTok)?.symbol : '';

        return res.json({
          ok: true,
          moduleId,
          chainId,
          enabledTokens: enabledTokenMeta.map((x: any) => x.symbol),
          enabledTokenMeta,
          defaultToken: defTok || '',
          defaultTokenSymbol: defSym || ''
        });
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'FAILED' });
      }
    });

    r.post('/games/dice/roll', requireJwtMw, async (req: any, res: any) => {
      try {
        const owner = normalizeAddress(String(req.user?.address || ''));
        if (!isEvmAddress(owner)) return res.status(401).json({ error: 'BAD_TOKEN' });

        const { moduleId, moduleDoc } = await loadBrowserDiceModuleDoc();

        const chainId = Number(req.body?.chainId);
        const betHuman = String(req.body?.betHuman || '').trim();
        const asset = String(req.body?.asset || req.body?.token || '').trim();
        const clientRequestId = String(req.body?.clientRequestId || '').trim();

        if (!Number.isFinite(chainId)) return res.status(400).json({ error: 'BAD_CHAIN_ID' });
        if (!betHuman) return res.status(400).json({ error: 'BAD_BET' });

        const { enabledTokensByChain, defaultTokenByChain } = getDiceCfg(moduleDoc);
        const key = String(chainId);
        const enabled: string[] = Array.isArray(enabledTokensByChain[key])
          ? enabledTokensByChain[key].map((x: any) => String(x).toLowerCase())
          : [];
        if (!enabled.length) return res.status(400).json({ error: 'DICE_NO_ENABLED_TOKENS' });

        let resolved: any;
        if (asset) {
          resolved = resolveEnabledTokenFromCfg(cfg, chainId, asset);
        } else {
          const defTok = String(defaultTokenByChain[key] || '').toLowerCase();
          if (!defTok) return res.status(400).json({ error: 'DICE_DEFAULT_TOKEN_NOT_SET' });
          resolved = { enabled: true, token: defTok, symbol: '', decimals: 18 };
          const chain = (cfg?.chains || []).find((c: any) => Number(c.chainId) === Number(chainId) && c.enabled);
          const meta = (chain?.tokens || []).find((t: any) => String(t.address || '').toLowerCase() === defTok);
          if (meta) {
            resolved.symbol = meta.symbol;
            resolved.decimals = meta.decimals;
          }
        }

        if (!resolved || !resolved.enabled) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_IN_SYSTEM' });

        const token = String(resolved.token || '').toLowerCase();
        if (!enabled.includes(token)) return res.status(400).json({ error: 'TOKEN_NOT_ENABLED_FOR_DICE' });

        const symbol = String(resolved.symbol || token.slice(0, 6));
        const decimals = Number(resolved.decimals ?? 18);
        const betRaw = parseUnits(betHuman, decimals);
        const bet = BigInt(betRaw);
        if (bet <= 0n) return res.status(400).json({ error: 'BAD_BET' });

        const treasuryId = await ensureTreasury(col, moduleId, chainId, token, symbol);
        const userAcc = userAccountId(owner);
        const treAcc = treasuryAccountId(treasuryId);

        const userBalRow = await col.balances.findOne({ _id: `${userAcc}:${chainId}:${token}` });
        const userBal = BigInt(String(userBalRow?.balanceRaw || '0'));
        if (userBal < bet) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE' });

        const treBalRow = await col.balances.findOne({ _id: `${treAcc}:${chainId}:${token}` });
        const treBal = BigInt(String(treBalRow?.balanceRaw || '0'));
        const treDoc = await col.treasuries.findOne({ _id: treasuryId });
        const maxBetBps = Math.max(0, Number(treDoc?.maxBetBps ?? process.env.DICE_MAX_BET_BPS ?? 500) || 0);
        const maxBetRaw = (treBal * BigInt(maxBetBps)) / 10_000n;
        if (maxBetRaw > 0n && bet > maxBetRaw) return res.status(400).json({ error: `BET_EXCEEDS_MAX_${maxBetBps}BPS` });

        const roll = pickRoll6();
        const multiplier = pickMul25();
        const isWin = roll === 6;
        const lossFeeBps = Math.max(0, Math.min(10_000, Number(process.env.DICE_LOSS_FEE_BPS ?? 3000) || 0));
        const fee = (!isWin && lossFeeBps > 0) ? (bet * BigInt(lossFeeBps)) / 10_000n : 0n;
        const payout = isWin ? bet * BigInt(multiplier) : 0n;

        const requiredExtra = bet * 4n;
        if (treBal < requiredExtra) return res.status(400).json({ error: 'TREASURY_INSUFFICIENT_FOR_5X' });

        const requestKey = clientRequestId || randHex(8);
        const baseRef = `diceweb:${moduleId}:${owner}:${requestKey}:${chainId}:${token}:${betRaw}`;

        const session = db.client.startSession();
        try {
          await session.withTransaction(async () => {
            await applyLedgerEntry(db, col, session, {
              refId: `${baseRef}:bet`,
              kind: 'dice_bet',
              chainId,
              token,
              moduleId,
              fromAccountId: userAcc,
              toAccountId: treAcc,
              amountRaw: (isWin ? betRaw : (bet - fee).toString()),
              meta: { game: 'dice', source: 'browser', ownerWallet: owner, requestKey, roll, multiplier, ts: nowIso() }
            });

            if (fee > 0n) {
              const feeTreasuryId = String(process.env.FEE_TREASURY_ID || 'fees');
              const feeAcc = treasuryAccountId(feeTreasuryId);
              await applyLedgerEntry(db, col, session, {
                refId: `${baseRef}:fee`,
                kind: 'dice_loss_fee',
                chainId,
                token,
                moduleId,
                fromAccountId: userAcc,
                toAccountId: feeAcc,
                amountRaw: fee.toString(),
                meta: { game: 'dice', source: 'browser', ownerWallet: owner, requestKey, roll, multiplier, lossFeeBps, ts: nowIso() }
              });
            }

            if (payout > 0n) {
              await applyLedgerEntry(db, col, session, {
                refId: `${baseRef}:payout`,
                kind: 'dice_payout',
                chainId,
                token,
                moduleId,
                fromAccountId: treAcc,
                toAccountId: userAcc,
                amountRaw: payout.toString(),
                meta: { game: 'dice', source: 'browser', ownerWallet: owner, requestKey, roll, multiplier, ts: nowIso() }
              });
            }
          });
        } finally {
          await session.endSession();
        }

        return res.json({
          ok: true,
          moduleId,
          chainId,
          token,
          symbol,
          decimals,
          treasuryId,
          betRaw,
          roll,
          multiplier,
          payoutRaw: payout.toString(),
          feeBps: lossFeeBps,
          feeRaw: fee.toString(),
          outcome: isWin ? 'WIN' : 'LOSS',
          requestKey
        });
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'FAILED' });
      }
    });
  }

}
