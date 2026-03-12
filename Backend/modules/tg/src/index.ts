import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import { registerDiceTelegram, DICE_ADMIN_ROOT_CB } from '@hauscashier/module-dice';
import { registerLotteryTelegram, LOTTERY_ADMIN_ROOT_CB } from '@hauscashier/module-lottery';
import { registerWhackTelegram, WHACK_ADMIN_ROOT_CB } from '@hauscashier/module-whack';

export type TgModuleConfig = {
  coreApiUrl: string;
  moduleId: string;
  moduleKey: string;
  chainId: number;
  token: string; // legacy/default token (not used for multi-token ops)
  treasuryId: string;
  enableRain: boolean;
  enableMonsoon: boolean;
  webAppUrl?: string; // e.g. http://localhost:3102 or https://myapp.netlify.app
};

type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

function buildRegisterUrl(base: string, moduleId: string, code: string): string {
  const b = String(base || '').trim();
  if (!b) return '';
  const m = encodeURIComponent(moduleId);
  const c = encodeURIComponent(code);

  // Supports:
  //  - http://localhost:3102      -> http://localhost:3102/#/tg/register?...
  //  - http://localhost:3102/#    -> http://localhost:3102/#/tg/register?...
  //  - http://localhost:3102/#/   -> http://localhost:3102/#/tg/register?...
  if (b.includes('#')) {
    const noTrail = b.replace(/\/+$/, '');
    if (noTrail.endsWith('#')) return `${noTrail}/tg/register?moduleId=${m}&code=${c}`;
    if (noTrail.endsWith('#/')) return `${noTrail}tg/register?moduleId=${m}&code=${c}`;
    return `${noTrail}/tg/register?moduleId=${m}&code=${c}`;
  }

  const noTrail = b.replace(/\/+$/, '');
  return `${noTrail}/#/tg/register?moduleId=${m}&code=${c}`;
}

async function apiFetch<T>(cfg: TgModuleConfig, path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const base = cfg.coreApiUrl.replace(/\/+$/, '');
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
}

// ----------
// TG Alerts (DM notifications)
// ----------
async function getAlertsEnabled(cfg: TgModuleConfig, tgId: string): Promise<boolean> {
  const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/alerts/get`, {
    method: 'POST',
    body: JSON.stringify({ tgId })
  });
  if (!r.ok) return true; // fail-open
  return !!(r.data as any)?.enabled;
}

async function setAlertsEnabled(cfg: TgModuleConfig, tgId: string, enabled: boolean): Promise<ApiResponse<{ enabled: boolean }>> {
  return apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/alerts/set`, {
    method: 'POST',
    body: JSON.stringify({ tgId, enabled })
  });
}

async function pullNotify(cfg: TgModuleConfig, limit = 20): Promise<ApiResponse<{ items: any[] }>> {
  return apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/notify/pull`, {
    method: 'POST',
    body: JSON.stringify({ limit })
  });
}

async function ackNotify(cfg: TgModuleConfig, ids: string[]): Promise<ApiResponse<{ updated: number }>> {
  return apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/notify/ack`, {
    method: 'POST',
    body: JSON.stringify({ ids })
  });
}

function parseArgs(text?: string): string[] {
  return (text || '').trim().split(/\s+/).filter(Boolean);
}

function parseWindowToMs(v: string): number {
  const s = String(v || '').trim().toLowerCase();
  const m = s.match(/^([0-9]{1,3})([mh])$/);
  if (!m) throw new Error('BAD_WINDOW');
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) throw new Error('BAD_WINDOW');
  if (unit === 'm') {
    if (n > 59) throw new Error('BAD_WINDOW');
    return n * 60 * 1000;
  }
  // hours
  if (n > 100) throw new Error('BAD_WINDOW');
  return n * 60 * 60 * 1000;
}

function isEvmAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(String(v || '').trim());
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

export function registerTgModule(bot: Telegraf, cfg: TgModuleConfig) {
  // ---- hard log any handler crash (this is what you need with PM2 restarts)
  bot.catch((err: any, ctx: any) => {
    try {
      const who = ctx?.from?.id ? `from=${ctx.from.id}` : 'from=?';
      const chat = ctx?.chat?.id ? `chat=${ctx.chat.id}` : 'chat=?';
      console.error('[tg-bot] UNCAUGHT', who, chat, err);
    } catch {
      console.error('[tg-bot] UNCAUGHT', err);
    }
  });

  // ----------
  // ADMIN
  // ----------
  const adminIds = new Set(
    String(process.env.TG_ADMIN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

const superAdminIds = new Set(
    String(process.env.TG_SUPER_ADMIN_IDS || process.env.TG_ADMIN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  // Optional game toggles (keeps drop-in modules clean)
  const enableDice = (() => {
    const v = String(process.env.ENABLE_GAME_DICE || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  })();

  const enableLottery = (() => {
    const v = String(process.env.ENABLE_GAME_LOTTERY || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  })();

  
  const enableWhack = (() => {
    const v = String(process.env.ENABLE_GAME_WHACK || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  })();
async function isAdminTg(ctx: any): Promise<boolean> {
    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return false;
    return adminIds.has(tgId);
  }

  // ----------
  // MAINTENANCE MODE (server-persisted; bot-enforced)
  // ----------
  const maintenanceDefault = (() => {
    const v = String(process.env.TG_MAINTENANCE_DEFAULT || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  })();

  const maintenanceUrl = String(process.env.TG_MAINTENANCE_URL || '').trim(); // e.g. https://t.me/YourChat
  const maintenanceMsg = (() => {
    const v = String(process.env.TG_MAINTENANCE_MESSAGE || '').trim();
    if (v) return v;
    return '🛠 Maintenance mode is ON.\n\nPlease come back later.';
  })();

  let maintenanceCache: { enabled: boolean; ts: number } = { enabled: maintenanceDefault, ts: 0 };
  const maintenanceNoticeThrottle = new Map<string, number>();

  async function getMaintenanceEnabled(): Promise<boolean> {
    const now = Date.now();
    // small TTL to avoid hammering core-api on busy group chats
    if (now - maintenanceCache.ts < 5000) return maintenanceCache.enabled;

    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/maintenance/get`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    if (r.ok) {
      maintenanceCache = { enabled: !!(r.data as any)?.enabled, ts: now };
      return maintenanceCache.enabled;
    }
    // fallback to last-known
    maintenanceCache = { enabled: maintenanceCache.enabled, ts: now };
    return maintenanceCache.enabled;
  }

  async function setMaintenanceEnabled(enabled: boolean, updatedByTgId: string) {
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/maintenance/set`, {
      method: 'POST',
      body: JSON.stringify({ enabled, updatedByTgId })
    });
    if (r.ok) maintenanceCache = { enabled: !!(r.data as any)?.enabled, ts: Date.now() };
    return r;
  }

  async function replyMaintenance(ctx: any) {
    const chatId = String(ctx?.chat?.id ?? '').trim();
    const tgId = String(ctx?.from?.id ?? '').trim();
    const throttleKey = `${chatId}:${tgId}`;
    const now = Date.now();
    const last = maintenanceNoticeThrottle.get(throttleKey) || 0;
    if (now - last < 60_000) return; // 1 min per user per chat
    maintenanceNoticeThrottle.set(throttleKey, now);

    const text = maintenanceUrl ? `${maintenanceMsg}\n\nJoin chat: ${maintenanceUrl}` : maintenanceMsg;
    await (ctx as any).reply(text).catch(() => null);
  }

  // Enforce maintenance for all non-admin interactions
  bot.use(async (ctx: any, next: any) => {
    try {
      const enabled = await getMaintenanceEnabled();
      if (!enabled) return next();

      // admins can operate while maintenance is on
      if (await isAdminTg(ctx)) return next();

      // block everyone else
      if (ctx?.callbackQuery) {
        try {
          await ctx.answerCbQuery('Maintenance mode', { show_alert: true });
        } catch {}
      }

      await replyMaintenance(ctx);
      return; // do NOT call next()
    } catch (e) {
      // if maintenance check fails, fail open (do not brick the bot)
      return next();
    }
  });

async function isSuperAdminTg(ctx: any): Promise<boolean> {
    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return false;
    return superAdminIds.has(tgId);
  }

  // Register optional Dice module commands/admin UI
  if (enableDice) {
    try {
      registerDiceTelegram(bot as any, cfg as any);
      console.log('[tg] dice module enabled');
    } catch (e) {
      console.error('[tg] failed to register dice module', e);
    }
  }

  if (enableLottery) {
    try {
      registerLotteryTelegram(bot as any, cfg as any);
      console.log('[tg] lottery module enabled');
    } catch (e) {
      console.error('[tg] failed to register lottery module', e);
    }
  }

  if (enableWhack) {
    try {
      registerWhackTelegram({ bot, apiFetch, isAdminTg } as any);
      console.log('[tg] whack module enabled');
    } catch (e) {
      console.error('[tg] failed to register whack module', e);
    }
  }


  // ----------
  // “SEEN” tracking — MUST NOT swallow commands
  // Put this in bot.use() so it always calls next()
  // ----------
  async function touchSeen(ctx: any) {
    const from = ctx?.from;
    const chat = ctx?.chat;

    const tgId = String(from?.id || '').trim();
    if (!tgId) return;

    const username = from?.username ? String(from.username) : '';
    const firstName = from?.first_name ? String(from.first_name) : '';
    const lastName = from?.last_name ? String(from.last_name) : '';
    const chatId = chat?.id != null ? String(chat.id) : '';
    const chatType = chat?.type ? String(chat.type) : '';

    // chainId from cfg
    const chainId = cfg.chainId;

    await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/seen/touch`, {
      method: 'POST',
      body: JSON.stringify({
        tgId,
        chainId,
        username,
        firstName,
        lastName,
        chatId,
        chatType
      })
    }).catch(() => null);
  }

  // Track chat speakers for /rain and /monsoon
  const bannedPhrases = new Set(
    String(process.env.TG_RAIN_BANNED_PHRASES || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const bannedTgIds = new Set(
    String(process.env.TG_RAIN_BANNED_TG_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  function isCountableMessage(ctx: any): { ok: boolean; msgType: string; textLower: string } {
    const m: any = ctx?.message;
    if (!m) return { ok: false, msgType: 'none', textLower: '' };

    // ignore stickers / joins / leaves / etc.
    if (m.sticker) return { ok: false, msgType: 'sticker', textLower: '' };
    if (m.new_chat_members || m.left_chat_member) return { ok: false, msgType: 'service', textLower: '' };

    const text = String(m.text || m.caption || '').trim();
    if (!text) return { ok: false, msgType: 'no_text', textLower: '' };

    const textLower = text.toLowerCase();
    for (const p of bannedPhrases) {
      if (p && textLower.includes(p)) return { ok: false, msgType: 'banned_phrase', textLower };
    }

    return { ok: true, msgType: m.text ? 'text' : 'caption', textLower };
  }

  async function touchChatActivity(ctx: any) {
    const chat = ctx?.chat;
    const from = ctx?.from;
    if (!chat || !from) return;

    // Only track group chats for rain/monsoon
    const chatType = String(chat?.type || '').toLowerCase();
    if (chatType === 'private') return;

    const tgId = String(from?.id || '').trim();
    if (!tgId) return;
    if (bannedTgIds.has(tgId)) return;

    const { ok, msgType, textLower } = isCountableMessage(ctx);
    if (!ok) return;

    const chatId = chat?.id != null ? String(chat.id) : '';
    const messageId = String((ctx?.message as any)?.message_id ?? '').trim();
    if (!chatId || !messageId) return;

    const username = from?.username ? String(from.username) : '';

    await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/activity/log`, {
      method: 'POST',
      body: JSON.stringify({
        tgId,
        username,
        chatId,
        chatType,
        messageId,
        msgType,
        textLower
      })
    }).catch(() => null);
  }

  bot.use(async (ctx: any, next: any) => {
    try {
      await touchSeen(ctx);
      await touchChatActivity(ctx);
    } catch (e) {
      // don’t block bot
      console.error('[tg-bot] touchSeen failed', e);
    }
    return next();
  });

  // ----------
  // WELCOME (admin configured)
  // ----------
  async function setWelcome(partial: { text?: string | null; photoFileId?: string | null }) {
    return apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/welcome/set`, {
      method: 'POST',
      body: JSON.stringify(partial)
    });
  }

  async function getWelcome() {
    return apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/welcome/get`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  }

  // ----------
  // SUCCESS MEDIA (tip/rain/monsoon)
  // ----------
  type SuccessMediaKey = 'tip' | 'rain' | 'monsoon';
  type SuccessMediaKind = 'photo' | 'video' | 'animation' | null;

  async function getSuccessMedia(key: SuccessMediaKey) {
    return apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/success_media/get`, {
      method: 'POST',
      body: JSON.stringify({ key })
    });
  }

  async function setSuccessMedia(partial: { key: SuccessMediaKey; kind: SuccessMediaKind; fileId: string | null }) {
    return apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/success_media/set`, {
      method: 'POST',
      body: JSON.stringify(partial)
    });
  }

  async function sendSuccessWithOptionalMedia(ctx: any, key: SuccessMediaKey, caption: string) {
  try {
    const r = await getSuccessMedia(key);
    // apiFetch returns { ok, data }, but keep fallback if shape differs
    const doc: any = (r as any)?.data ?? r;
    const kind = (doc as any)?.kind as SuccessMediaKind;
    const fileId = String((doc as any)?.fileId || '').trim();
    if (kind && fileId) {
      if (kind === 'photo') return (ctx as any).replyWithPhoto(fileId, { caption });
      if (kind === 'video') return (ctx as any).replyWithVideo(fileId, { caption });
      if (kind === 'animation') return (ctx as any).replyWithAnimation(fileId, { caption });
    }
  } catch (e) {
    // keep silent to avoid spamming chats
  }
  return ctx.reply(caption);
}


  // ----------
  // START / HELP
  // ----------
  bot.start(async (ctx) => {
    const tgId = String(ctx.from?.id || '').trim();

    const alertsEnabled = tgId ? await getAlertsEnabled(cfg, tgId) : true;

    // Show welcome once (if configured)
    if (tgId) {
      try {
        const w = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/welcome/show`, {
          method: 'POST',
          body: JSON.stringify({ tgId })
        });

        if (w.ok && w.data?.show) {
          const text = String(w.data?.text || '').trim();
          const photoFileId = String(w.data?.photoFileId || '').trim();

          if (photoFileId) {
            await (ctx as any).replyWithPhoto(photoFileId, text ? { caption: text } : undefined);
          } else if (text) {
            await ctx.reply(text);
          }
        }
      } catch (e) {
        console.error('[tg-bot] welcome/show failed', e);
      }
    }


    await ctx.reply(
      `Welcome.\n\n` +
        `Commands:\n` +
        `/register - get a link to bind wallet\n` +
        `/link - get a one-time code (manual)\n` +
        `/approve - approve link in Telegram\n` +
        `/balance - view your credits\n` +
        `/tip <@user|0xAddr> <amount> [SYMBOL|0xToken] - tip in group or DM\n` +
        `/withdraw <amount> <SYMBOL|0xToken|native> [0xTo] - withdraw (if enabled)\n` +
        `/alerts - toggle DM alerts (currently: ${alertsEnabled ? 'ON' : 'OFF'})\n` +
        `/treasuries - admin: list ALL treasuries\n` +
        `/module_treasuries - admin: module treasuries\n` +
        `/lottery - open lottery panel (group)\n` +
        `/lotteryadmin - lottery admin panel (group admin)\n` +
        `/mainadmin - admin menu\n` +
        `/ping - health\n`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`🔔 Alerts: ${alertsEnabled ? 'ON' : 'OFF'}`, 'tg_alerts_toggle')]
      ])
    );
  });

  bot.command('alerts', async (ctx) => {
    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return ctx.reply('Missing TG id.');

    const args = parseArgs((ctx as any)?.message?.text).slice(1);
    const a0 = String(args[0] || '').trim().toLowerCase();

    let next: boolean;
    if (a0 === 'on' || a0 === '1' || a0 === 'true' || a0 === 'yes') next = true;
    else if (a0 === 'off' || a0 === '0' || a0 === 'false' || a0 === 'no') next = false;
    else next = !(await getAlertsEnabled(cfg, tgId));

    const r = await setAlertsEnabled(cfg, tgId, next);
    if (!r.ok) return ctx.reply(`Failed: ${r.error}`);

    return ctx.reply(`🔔 Alerts are now ${next ? 'ON' : 'OFF'}.`);
  });

  bot.action('tg_alerts_toggle', async (ctx) => {
    try {
      const tgId = String((ctx as any).from?.id || '').trim();
      if (!tgId) return ctx.answerCbQuery('Missing TG id', { show_alert: true });

      const cur = await getAlertsEnabled(cfg, tgId);
      const next = !cur;
      const r = await setAlertsEnabled(cfg, tgId, next);
      if (!r.ok) return ctx.answerCbQuery(`Failed: ${r.error}`, { show_alert: true });

      await ctx.answerCbQuery(`Alerts ${next ? 'ON' : 'OFF'}`);
      await (ctx as any).reply(`🔔 Alerts are now ${next ? 'ON' : 'OFF'}.`);
    } catch (e) {
      console.error('[tg] tg_alerts_toggle failed', e);
    }
  });

  bot.command('ping', async (ctx) => {
    await ctx.reply('pong ✅');
  });

  // ----------
  // ADMIN UI
  // ----------
  const setupState = new Map<string, 'await_text' | 'await_image'>();
  const successState = new Map<string, { key: SuccessMediaKey }>();

  async function replyMainAdminMenu(ctx: any) {
    const enabled = await getMaintenanceEnabled();
    const label = enabled ? '🛠 Maintenance: ON' : '🛠 Maintenance: OFF';
    await (ctx as any).reply(
      `Admin menu:`,
      Markup.inlineKeyboard([
        [Markup.button.callback(label, 'tg_admin_maintenance_toggle')],
        [Markup.button.callback('⚙️ Setup welcome', 'tg_admin_setup')],
        [Markup.button.callback('🏦 Treasuries', 'tg_admin_treasuries')],
        [Markup.button.callback('🎉 Success media', 'tg_admin_success_media')],
        ...(enableDice ? [[Markup.button.callback('🎲 Dice', DICE_ADMIN_ROOT_CB)]] : []),
        ...(enableLottery ? [[Markup.button.callback('🎟️ Lottery', LOTTERY_ADMIN_ROOT_CB)]] : []),
        [Markup.button.callback('👀 Preview welcome', 'tg_setup_preview')],
        [
          Markup.button.callback('🧹 Clear text', 'tg_setup_clear_text'),
          Markup.button.callback('🧹 Clear image', 'tg_setup_clear_image')
        ]
      ])
    );
  }

  bot.command('mainadmin', async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.reply('Not allowed.');

    await replyMainAdminMenu(ctx);
  });

  bot.action('tg_admin_maintenance_toggle', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      const fromId = String(ctx.from?.id || '').trim();
      if (!fromId) return ctx.answerCbQuery('Missing from', { show_alert: true });

      const cur = await getMaintenanceEnabled();
      const nextEnabled = !cur;
      const r = await setMaintenanceEnabled(nextEnabled, fromId);
      if (!r.ok) return ctx.answerCbQuery(`Failed: ${r.error}`, { show_alert: true });

      await ctx.answerCbQuery(nextEnabled ? 'Maintenance ON' : 'Maintenance OFF');
      await replyMainAdminMenu(ctx);
    } catch (e) {
      console.error('[tg-bot] tg_admin_maintenance_toggle failed', e);
    }
  });

  bot.command('setup', async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.reply('Not allowed.');

    await ctx.reply(
      `TG setup:\nChoose an action:`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Set welcome text', 'tg_setup_welcome_text')],
        [Markup.button.callback('🖼️ Set welcome image', 'tg_setup_welcome_image')],
        [Markup.button.callback('👀 Preview welcome', 'tg_setup_preview')],
        [
          Markup.button.callback('🧹 Clear text', 'tg_setup_clear_text'),
          Markup.button.callback('🧹 Clear image', 'tg_setup_clear_image')
        ]
      ])
    );
  });

  bot.action('tg_admin_setup', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      await ctx.answerCbQuery('Opening setup…');
      await (ctx as any).reply(
        `TG setup:\nChoose an action:`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Set welcome text', 'tg_setup_welcome_text')],
          [Markup.button.callback('🖼️ Set welcome image', 'tg_setup_welcome_image')],
          [Markup.button.callback('👀 Preview welcome', 'tg_setup_preview')],
          [
            Markup.button.callback('🧹 Clear text', 'tg_setup_clear_text'),
            Markup.button.callback('🧹 Clear image', 'tg_setup_clear_image')
          ]
        ])
      );
    } catch (e) {
      console.error('[tg-bot] tg_admin_setup action failed', e);
    }
  });

  bot.action('tg_admin_success_media', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      await ctx.answerCbQuery('Success media…');
      await (ctx as any).reply(
        `Success media:\nChoose which action to customize:`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Tip', 'tg_success_pick_tip')],
          ...(cfg.enableRain ? [[Markup.button.callback('🌧️ Rain', 'tg_success_pick_rain')]] : []),
          ...(cfg.enableMonsoon ? [[Markup.button.callback('🌊 Monsoon', 'tg_success_pick_monsoon')]] : []),
          [Markup.button.callback('⬅️ Back', 'tg_mainadmin_back')]
        ])
      );
    } catch (e) {
      console.error('[tg-bot] tg_admin_success_media failed', e);
    }
  });

  async function openSuccessKeyMenu(ctx: any, key: SuccessMediaKey) {
    await (ctx as any).reply(
      `Success media for: ${key}\n\nSet/replace then send a PHOTO / GIF / VIDEO.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Set / replace', `tg_success_set:${key}`)],
        [Markup.button.callback('👀 Preview', `tg_success_preview:${key}`)],
        [Markup.button.callback('🧹 Clear', `tg_success_clear:${key}`)],
        [Markup.button.callback('⬅️ Back', 'tg_admin_success_media')]
      ])
    );
  }

  bot.action('tg_success_pick_tip', async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    await ctx.answerCbQuery('Tip');
    await openSuccessKeyMenu(ctx, 'tip');
  });
  bot.action('tg_success_pick_rain', async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    await ctx.answerCbQuery('Rain');
    await openSuccessKeyMenu(ctx, 'rain');
  });
  bot.action('tg_success_pick_monsoon', async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    await ctx.answerCbQuery('Monsoon');
    await openSuccessKeyMenu(ctx, 'monsoon');
  });

  bot.action(/tg_success_set:(tip|rain|monsoon)/, async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    const key = String((ctx as any).match?.[1] || '') as SuccessMediaKey;
    const fromId = String(ctx.from?.id || '');
    if (!fromId) return ctx.answerCbQuery('Missing from', { show_alert: true });
    successState.set(fromId, { key });
    await ctx.answerCbQuery('Send media now');
    return (ctx as any).reply(`Send a PHOTO / GIF / VIDEO now to set success media for: ${key}`);
  });

  bot.action(/tg_success_preview:(tip|rain|monsoon)/, async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    const key = String((ctx as any).match?.[1] || '') as SuccessMediaKey;
    await ctx.answerCbQuery('Preview');
    return sendSuccessWithOptionalMedia(ctx, key, `Preview: ${key} success media`);
  });

  bot.action(/tg_success_clear:(tip|rain|monsoon)/, async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
    const key = String((ctx as any).match?.[1] || '') as SuccessMediaKey;
    await ctx.answerCbQuery('Clearing…');
    await setSuccessMedia({ key, kind: null, fileId: null });
    return (ctx as any).reply(`Cleared success media for: ${key}`);
  });

  bot.action('tg_mainadmin_back', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      await ctx.answerCbQuery('Back');
      await replyMainAdminMenu(ctx);
    } catch (e) {
      console.error('[tg-bot] tg_mainadmin_back failed', e);
    }
  });

  bot.action('tg_setup_welcome_text', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      setupState.set(String(ctx.from?.id || ''), 'await_text');
      await ctx.answerCbQuery('Send the welcome text now');
      await (ctx as any).reply('Send the welcome text (one message).');
    } catch (e) {
      console.error('[tg-bot] tg_setup_welcome_text action failed', e);
    }
  });

  bot.action('tg_setup_welcome_image', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      setupState.set(String(ctx.from?.id || ''), 'await_image');
      await ctx.answerCbQuery('Send the welcome image now');
      await (ctx as any).reply('Send the welcome image as a PHOTO (not document).');
    } catch (e) {
      console.error('[tg-bot] tg_setup_welcome_image action failed', e);
    }
  });

  bot.action('tg_setup_clear_text', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      const r = await setWelcome({ text: '' });
      if (!r.ok) return ctx.answerCbQuery(`Failed: ${r.error}`, { show_alert: true });
      await ctx.answerCbQuery('Cleared');
      await (ctx as any).reply('✅ Welcome text cleared.');
    } catch (e) {
      console.error('[tg-bot] tg_setup_clear_text action failed', e);
    }
  });

  bot.action('tg_setup_clear_image', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      const r = await setWelcome({ photoFileId: '' });
      if (!r.ok) return ctx.answerCbQuery(`Failed: ${r.error}`, { show_alert: true });
      await ctx.answerCbQuery('Cleared');
      await (ctx as any).reply('✅ Welcome image cleared.');
    } catch (e) {
      console.error('[tg-bot] tg_setup_clear_image action failed', e);
    }
  });

  bot.action('tg_setup_preview', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      const r = await getWelcome();
      if (!r.ok) return ctx.answerCbQuery(`Failed: ${r.error}`, { show_alert: true });

      const text = String((r.data as any)?.text || '').trim();
      const photoFileId = String((r.data as any)?.photoFileId || '').trim();

      if (photoFileId) {
        await (ctx as any).replyWithPhoto(photoFileId, text ? { caption: text } : undefined);
      } else if (text) {
        await (ctx as any).reply(text);
      } else {
        await (ctx as any).reply('No welcome configured yet.');
      }

      await ctx.answerCbQuery('Preview sent');
    } catch (e) {
      console.error('[tg-bot] tg_setup_preview action failed', e);
    }
  });

  // Capture admin setup replies (text/photo) WITHOUT swallowing commands
  // Capture admin replies for setup (text/photo)
  // ✅ IMPORTANT: must call next() when not handling setup, or it swallows ALL commands.

  bot.on('text', async (ctx, next) => {
    try {
      const tgId = String(ctx.from?.id || '').trim();
      if (!tgId) return next();

      const state = setupState.get(tgId);
      if (state !== 'await_text') return next();

      // ignore commands (do not swallow /balance etc)
      const msg = String((ctx.message as any)?.text || '');
      if (msg.trim().startsWith('/')) return next();

      if (!(await isAdminTg(ctx))) return next();

      setupState.delete(tgId);
      const r = await setWelcome({ text: msg });

      if (!r.ok) {
        await ctx.reply(`Failed: ${r.error}`);
        return;
      }

      await ctx.reply('✅ Welcome text saved.');
      // do not call next() because we consumed this message intentionally
    } catch (e) {
      // never crash the bot from setup flow
      return next();
    }
  });

  bot.on('photo', async (ctx, next) => {
    try {
      const tgId = String(ctx.from?.id || '').trim();
      if (!tgId) return next();

      // Success media capture (admin only)
      const sm = successState.get(tgId);
      if (sm) {
        if (!(await isAdminTg(ctx))) return next();
        const photos = (ctx.message as any)?.photo || [];
        const best = photos[photos.length - 1];
        const fileId = String(best?.file_id || '').trim();
        if (!fileId) {
          await ctx.reply('Could not read photo file_id.');
          return;
        }
        const resp = await setSuccessMedia({ key: sm.key, kind: 'photo', fileId });
        successState.delete(tgId);
        if (!(resp as any)?.ok) {
          await ctx.reply(`❌ Failed to save success media for ${sm.key}: ${String((resp as any)?.error || (resp as any)?.message || (resp as any)?.status || 'ERROR')}`);
        } else {
          await ctx.reply(`✅ Saved success media for ${sm.key}.`);
        }
        return;
      }

      const state = setupState.get(tgId);
      if (state !== 'await_image') return next();

      if (!(await isAdminTg(ctx))) return next();

      const photos = (ctx.message as any)?.photo || [];
      const best = photos[photos.length - 1];
      const fileId = String(best?.file_id || '').trim();

      if (!fileId) {
        await ctx.reply('Could not read photo file_id.');
        return;
      }

      setupState.delete(tgId);
      const r = await setWelcome({ photoFileId: fileId });

      if (!r.ok) {
        await ctx.reply(`Failed: ${r.error}`);
        return;
      }

      await ctx.reply('✅ Welcome image saved.');
      // consumed intentionally
    } catch (e) {
      return next();
    }
  });
  bot.on('video', async (ctx, next) => {
    try {
      const tgId = String(ctx.from?.id || '').trim();
      if (!tgId) return next();
      const sm = successState.get(tgId);
      if (!sm) return next();
      if (!(await isAdminTg(ctx))) return next();

      const fileId = String((ctx.message as any)?.video?.file_id || '').trim();
      if (!fileId) return ctx.reply('Could not read video file_id.');

      const resp = await setSuccessMedia({ key: sm.key, kind: 'video', fileId });
      successState.delete(tgId);
      if (!(resp as any)?.ok) {
        await ctx.reply(`❌ Failed to save success media for ${sm.key}: ${String((resp as any)?.error || (resp as any)?.message || (resp as any)?.status || 'ERROR')}`);
      } else {
        await ctx.reply(`✅ Saved success media for ${sm.key}.`);
      }
    } catch {
      return next();
    }
  });

  bot.on('animation', async (ctx, next) => {
    try {
      const tgId = String(ctx.from?.id || '').trim();
      if (!tgId) return next();
      const sm = successState.get(tgId);
      if (!sm) return next();
      if (!(await isAdminTg(ctx))) return next();

      const fileId = String((ctx.message as any)?.animation?.file_id || '').trim();
      if (!fileId) return ctx.reply('Could not read animation file_id.');

      const resp = await setSuccessMedia({ key: sm.key, kind: 'animation', fileId });
      successState.delete(tgId);
      if (!(resp as any)?.ok) {
        await ctx.reply(`❌ Failed to save success media for ${sm.key}: ${String((resp as any)?.error || (resp as any)?.message || (resp as any)?.status || 'ERROR')}`);
      } else {
        await ctx.reply(`✅ Saved success media for ${sm.key}.`);
      }
    } catch {
      return next();
    }
  });


  // ----------
  // ADMIN: LIST TREASURIES + BALANCES
  // ----------
  async function listTreasuries(ctx: any) {
    const chainId = cfg.chainId;
    // Admin intent: list ALL treasuries on the system (not restricted to module.allowedTreasuries)
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/treasuries/admin/list`, {
      method: 'POST',
      body: JSON.stringify({ chainId })
    });
    if (!r.ok) return ctx.reply(`Treasury list failed: ${r.error}`);

    const treasuries = (r.data as any)?.treasuries || [];
    if (!treasuries.length) return ctx.reply('No treasuries found.');

    // Hide tiny “dust” balances by default (can be overridden via env)
    const showDust = String(process.env.TG_TREASURY_SHOW_DUST || '0') === '1';

    function isDust(balanceRaw: string, decimals: number): boolean {
      if (showDust) return false;
      try {
        const n = BigInt(String(balanceRaw || '0'));
        if (n === 0n) return true;
        const d = Math.max(0, Math.min(36, Number(decimals || 18)));
        // default dust threshold = 0.000001
        const pow = d > 6 ? BigInt(10) ** BigInt(d - 6) : 1n;
        return n < pow;
      } catch {
        return false;
      }
    }

    // Totals across all treasuries (per token address)
    const totals = new Map<string, { token: string; symbol: string; decimals: number; sum: bigint }>();
    for (const t of treasuries) {
      for (const b of (t.balances || []).filter((x: any) => x && x.enabled)) {
        const token = String(b.token || '').toLowerCase();
        if (!token) continue;
        const decimals = Number(b.decimals || 18);
        const symbol = String(b.symbol || token.slice(0, 6));
        let cur = totals.get(token);
        if (!cur) {
          cur = { token, symbol, decimals, sum: 0n };
          totals.set(token, cur);
        }
        try {
          cur.sum += BigInt(String(b.balanceRaw || '0'));
        } catch {
          // ignore
        }
      }
    }

    const lines: string[] = [];
    lines.push(`Admin treasuries (chain ${chainId})`);

    if (totals.size) {
      lines.push(`\nTotals:`);
      const totArr = Array.from(totals.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
      for (const t of totArr) {
        if (isDust(t.sum.toString(), t.decimals)) continue;
        lines.push(`• ${t.symbol}: ${formatUnits(t.sum.toString(), t.decimals)}`);
      }
    }

    // Treasuries detail
    for (const t of treasuries) {
      const title = `${t.treasuryId}${t.label && t.label !== t.treasuryId ? ` (${t.label})` : ''}`;
      const mod = t.moduleId ? ` · module=${t.moduleId}` : '';
      const dis = t.enabled === false ? ` · disabled` : '';
      lines.push(`\n🏦 ${title}${mod}${dis}`);

      const bals = (t.balances || []).filter((b: any) => b && b.enabled && !isDust(String(b.balanceRaw || '0'), Number(b.decimals || 18)));
      if (!bals.length) {
        lines.push(`  • (no balances)`);
      } else {
        for (const b of bals) {
          lines.push(`  • ${b.symbol}: ${formatUnits(String(b.balanceRaw || '0'), Number(b.decimals || 18))}`);
        }
      }
    }

    return ctx.reply(lines.join('\n').trim());
  }

  // Optional: module-restricted view (handy for debugging module allowlists)
  async function listModuleTreasuries(ctx: any) {
    const chainId = cfg.chainId;
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/treasuries/list`, {
      method: 'POST',
      body: JSON.stringify({ chainId })
    });
    if (!r.ok) return ctx.reply(`Treasury list failed: ${r.error}`);
    const treasuries = (r.data as any)?.treasuries || [];
    if (!treasuries.length) return ctx.reply('No module treasuries found.');

    const lines: string[] = [];
    lines.push(`Module treasuries (module ${cfg.moduleId}, chain ${chainId})`);
    for (const t of treasuries) {
      const title = `${t.treasuryId}${t.label && t.label !== t.treasuryId ? ` (${t.label})` : ''}`;
      lines.push(`\n🏦 ${title}`);
      const bals = (t.balances || []).filter((b: any) => b && b.enabled);
      if (!bals.length) lines.push(`  • (no balances)`);
      else for (const b of bals) lines.push(`  • ${b.symbol}: ${formatUnits(String(b.balanceRaw || '0'), Number(b.decimals || 18))}`);
    }
    return ctx.reply(lines.join('\n').trim());
  }

  bot.command('treasuries', async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.reply('Not allowed.');
    return listTreasuries(ctx);
  });

  bot.command('module_treasuries', async (ctx) => {
    if (!(await isAdminTg(ctx))) return ctx.reply('Not allowed.');
    return listModuleTreasuries(ctx);
  });

  bot.action('tg_admin_treasuries', async (ctx) => {
    try {
      if (!(await isAdminTg(ctx))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
      await ctx.answerCbQuery('Listing...');
      await listTreasuries(ctx);
    } catch (e) {
      console.error('[tg-bot] tg_admin_treasuries action failed', e);
    }
  });


  // ----------
  // SUPER ADMIN: FUND / DRAIN TREASURIES (credits, not on-chain)
  // Moves credits between your linked wallet account and a treasury account.
  //
  // Env:
  //   TG_SUPER_ADMIN_IDS=comma-separated TG ids (defaults to TG_ADMIN_IDS)
  //
  // Commands:
  //   /fundtreasury <treasuryId> <amount> <SYMBOL|0xToken|native>
  //   /draintreasury <treasuryId> <amount> <SYMBOL|0xToken|native>
  // ----------
  async function handleTreasuryMove(ctx: any, direction: 'to_treasury' | 'from_treasury') {
    if (!(await isSuperAdminTg(ctx))) return ctx.reply('Not allowed.');

    const args = parseArgs((ctx.message as any)?.text || '').slice(1);
    const treasuryId = String(args[0] || '').trim();
    const amountHuman = String(args[1] || '').trim();
    const asset = String(args[2] || 'native').trim();

    if (!treasuryId || !amountHuman) {
      return ctx.reply(
        `Usage:\n` +
          (direction === 'to_treasury'
            ? `/fundtreasury <treasuryId> <amount> <SYMBOL|0xToken|native>`
            : `/draintreasury <treasuryId> <amount> <SYMBOL|0xToken|native>`)
      );
    }

    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return ctx.reply('Cannot read your TG id.');

    // Resolve token (symbol -> token + decimals)
    const resolved = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/token/resolve`, {
      method: 'POST',
      body: JSON.stringify({ chainId: cfg.chainId, asset })
    });
    if (!resolved.ok) return ctx.reply(`Token resolve failed: ${resolved.error}`);
    if (!resolved.data?.enabled) return ctx.reply(`Token not enabled: ${asset}`);

    let amountRaw: string;
    try {
      amountRaw = parseUnits(amountHuman, Number(resolved.data.decimals || 18));
    } catch (e: any) {
      return ctx.reply(`Bad amount: ${String(e?.message || e)}`);
    }

    const refId = `tg:${cfg.moduleId}:${tgId}:${direction}:${treasuryId}:${Date.now()}`;

    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/treasuries/admin/transfer`, {
      method: 'POST',
      body: JSON.stringify({
        tgId,
        refId,
        chainId: cfg.chainId,
        token: resolved.data.token,
        treasuryId,
        dir: direction,
        amountRaw
      })

    });

    if (!r.ok) return ctx.reply(`Treasury move failed: ${r.error}`);

    const sym = String(resolved.data.symbol || '').trim() || 'TOKEN';
    const pretty = formatUnits(String(amountRaw), Number(resolved.data.decimals || 18));

    return ctx.reply(
      `✅ ${direction === 'to_treasury' ? 'Funded' : 'Drained'} treasury\n` +
        `Treasury: ${treasuryId}\n` +
        `Token: ${sym}\n` +
        `Amount: ${pretty}\n` +
        `Ref: ${refId}`
    );
  }

  bot.command('fundtreasury', (ctx) => handleTreasuryMove(ctx, 'to_treasury'));
  bot.command('draintreasury', (ctx) => handleTreasuryMove(ctx, 'from_treasury'));

// ----------
  // LINKING FLOW
  // ----------
  bot.command('link', async (ctx) => {
    if (!(await requirePrivateCommand(ctx, 'link'))) return;
    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return ctx.reply('Cannot read your TG id.');

    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/link/request`, {
      method: 'POST',
      body: JSON.stringify({ tgId })
    });
    if (!r.ok) return ctx.reply(`Link request failed: ${r.error}`);

    await ctx.reply(
      `Your link code: ${(r.data as any).code}\n` +
        `Expires: ${(r.data as any).expiresAt}\n\n` +
        `Next steps:\n` +
        `1) Open your dApp and connect wallet\n` +
        `2) Go to /#/tg/register and enter this code\n` +
        `3) Back here: /approve to finalize`
    );
  });

  bot.command('register', async (ctx) => {
    if (!(await requirePrivateCommand(ctx, 'register'))) return;
    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return ctx.reply('Cannot read your TG id.');

    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/link/request`, {
      method: 'POST',
      body: JSON.stringify({ tgId })
    });
    if (!r.ok) return ctx.reply(`Register failed: ${r.error}`);

    const regUrl = cfg.webAppUrl ? buildRegisterUrl(cfg.webAppUrl, cfg.moduleId, String((r.data as any).code)) : '';

    await ctx.reply(
      `✅ Registration started\n\n` +
        `Code: ${(r.data as any).code}\n` +
        `Expires: ${(r.data as any).expiresAt}\n\n` +
        (regUrl
          ? `Open this link to bind your wallet:\n${regUrl}\n\n`
          : `Open your dApp and go to /#/tg/register then use the code above.\n\n`) +
        `After confirming on the website, come back here and run /approve to finalize.`
    );
  });

  bot.command('approve', async (ctx) => {
    if (!(await requirePrivateCommand(ctx, 'approve'))) return;
    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return ctx.reply('Cannot read your TG id.');

    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/link/pending`, {
      method: 'POST',
      body: JSON.stringify({ tgId })
    });

    if (!r.ok) return ctx.reply(`Approve check failed: ${r.error}`);
    if (!(r.data as any)?.pending) {
      return ctx.reply(
        `No pending link found.\n\n` +
          `If you haven't yet: run /register, confirm on the website, then try /approve again.`
      );
    }

    const code = String((r.data as any).code);
    const wallet = String((r.data as any).ownerWallet);

    await ctx.reply(
      `Pending link request found:\nWallet: ${wallet}\nCode: ${code}\n\nConfirm?`,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Confirm link', `tg_link_confirm:${code}`),
        Markup.button.callback('❌ Cancel', `tg_link_cancel:${code}`)
      ])
    );
  });

  bot.action(/tg_link_confirm:(.+)/, async (ctx) => {
    try {
      const code = String((ctx as any).match?.[1] || '').trim();
      const tgId = String(ctx.from?.id || '').trim();
      if (!tgId || !code) return;

      const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/link/approve`, {
        method: 'POST',
        body: JSON.stringify({ tgId, code })
      });

      if (!r.ok) {
        await ctx.answerCbQuery(`Failed: ${r.error}`, { show_alert: true });
        return;
      }

      await ctx.answerCbQuery('Linked ✅');
      await ctx.editMessageText(`Linked wallet: ${(r.data as any).ownerWallet}\nYou can now use /balance and /tip.`);
    } catch (e) {
      console.error('[tg-bot] tg_link_confirm failed', e);
      try {
        await (ctx as any).answerCbQuery('Error', { show_alert: true });
      } catch {}
    }
  });

  bot.action(/tg_link_cancel:(.+)/, async (ctx) => {
    try {
      const tgId = String(ctx.from?.id || '').trim();
      if (!tgId) return;

      await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/link/cancel`, {
        method: 'POST',
        body: JSON.stringify({ tgId })
      });

      await ctx.answerCbQuery('Cancelled');
      await ctx.editMessageText('Cancelled pending link. Run /register again any time.');
    } catch (e) {
      console.error('[tg-bot] tg_link_cancel failed', e);
      try {
        await (ctx as any).answerCbQuery('Error', { show_alert: true });
      } catch {}
    }
  });

  // ----------
  // BALANCES
  // ----------
  bot.command('balance', async (ctx) => {
    if (!(await requirePrivateCommand(ctx, 'balance'))) return;
    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return ctx.reply('Cannot read your TG id.');

    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/balances`, {
      method: 'POST',
      body: JSON.stringify({ tgId, chainId: cfg.chainId })
    });

    if (!r.ok) {
      if (r.error === 'NOT_LINKED') {
        return ctx.reply(
          `You are not linked yet.\n\n` +
            `1) Run /register to get your link\n` +
            `2) Confirm on the website\n` +
            `3) Back here: /approve`
        );
      }
      return ctx.reply(`Balance failed: ${r.error}`);
    }

    const lines = ((r.data as any).balances || [])
      .filter((b: any) => b.enabled)
      .map((b: any) => `• ${b.symbol}: ${formatUnits(String(b.balanceRaw || '0'), Number(b.decimals || 18))}`);

    await ctx.reply(
      `Linked wallet: ${(r.data as any).ownerWallet}\n` +
        (lines.length ? `\nBalances:\n${lines.join('\n')}` : `\nNo balances yet.`)
    );
  });

  // ----------
  // TIP / GIFT (alias) — PUBLIC (groups + replies supported)
  // ----------
  async function handleTip(ctx: any) {
    const usedCmd = String((ctx.message as any)?.text || '').trim().split(/\s+/)[0].replace(/^\//, '') || 'giftuser';
    const isPrivate = isPrivateChatCtx(ctx);

    // Args after command
    const args = parseArgs((ctx.message as any)?.text || '').slice(1);

    // Group support:
    // - reply-to user: /tip <amount> [SYMBOL|0xToken]
    // - mention user:  /tip @username <amount> [SYMBOL|0xToken]
    // - address:       /tip 0xAddress <amount> [SYMBOL|0xToken]
    //
    // We send to:
    // - tg:<moduleId>:<tgId> (holding account; backend upgrades to linked wallet if linked)
    // - @username (backend resolves via seen-users table)
    // - 0xAddress (direct to wallet)

    const replyUser = (ctx.message as any)?.reply_to_message?.from;
    const replyTgId = replyUser?.id != null ? String(replyUser.id) : '';

    let to = '';
    let amountHuman = '';
    let asset = 'native';

    if (!isPrivate && replyTgId) {
      // Reply mode: /tip <amount> [asset]
      to = `tg:${cfg.moduleId}:${replyTgId}`;
      amountHuman = String(args[0] || '').trim();
      asset = String(args[1] || 'native').trim();
      if (!amountHuman) {
        return ctx.reply('Usage (reply): reply to a user then send: /tip <amount> [SYMBOL|0xToken]\n');
      }
    } else {
      // Non-reply mode: /tip <to> <amount> [asset]
      to = String(args[0] || '').trim();
      amountHuman = String(args[1] || '').trim();
      asset = String(args[2] || 'native').trim();

      if (!to || !amountHuman) {
        return ctx.reply(
          'Usage:\n' +
            '/tip <@username|0xAddress> <amount> [SYMBOL|0xToken]\n' +
            'OR reply to a user: /tip <amount> [SYMBOL|0xToken]\n'
        );
      }
    }

    // Disallow tipping the bot itself (common mistake in replies)
    const botId = (ctx as any)?.botInfo?.id != null ? String((ctx as any).botInfo.id) : '';
    if (botId && to.includes(`:${botId}`)) {
      return ctx.reply('You cannot tip the bot.');
    }

    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return ctx.reply('Cannot read your TG id.');

    const resolved = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/token/resolve`, {
      method: 'POST',
      body: JSON.stringify({ chainId: cfg.chainId, asset })
    });
    if (!resolved.ok) return ctx.reply(`Token resolve failed: ${resolved.error}`);
    if (!(resolved.data as any)?.enabled) return ctx.reply(`Token not enabled: ${asset}`);

    let amountRaw: string;
    try {
      amountRaw = parseUnits(amountHuman, Number((resolved.data as any).decimals || 18));
    } catch (e: any) {
      return ctx.reply(`Bad amount: ${String(e?.message || e)}`);
    }

    const refId = `tg-tip:${cfg.moduleId}:${tgId}:${Date.now()}`;
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/ledger/transfer`, {
      method: 'POST',
      body: JSON.stringify({
        tgId,
        refId,
        chainId: cfg.chainId,
        asset, // backend resolves + enforces enabled
        to,
        amountRaw,
        kind: 'tg_tip',
        reason: usedCmd === 'giftuser' ? 'giftuser' : 'tip',
        meta: {
          chatId: String(ctx.chat?.id ?? ''),
          chatType: String(ctx.chat?.type ?? ''),
          messageId: String((ctx.message as any)?.message_id ?? ''),
          replyToMessageId: String((ctx.message as any)?.reply_to_message?.message_id ?? ''),
          toHint: to.startsWith('tg:') ? `tg:${replyTgId}` : to
        }
      })
    });
    if (!r.ok) return ctx.reply(`Tip failed: ${r.error}`);

    // Pretty recipient
    let toPretty = to;
    if (to.startsWith('tg:') && replyUser) {
      const uname = replyUser?.username ? `@${replyUser.username}` : '';
      const name = [replyUser?.first_name, replyUser?.last_name].filter(Boolean).join(' ').trim();
      toPretty = uname || name || `tg:${replyTgId}`;
    }

    await ctx.reply(
      `✅ Sent\n` +
        `To: ${toPretty}\n` +
        `Token: ${(resolved.data as any).symbol}\n` +
        `Amount: ${amountHuman}\n` +
        `Ref: ${refId}`
    );
  }

  bot.command('tip', handleTip);
  bot.command('giftuser', handleTip);

  // ----------
  // RAIN / MONSOON (group-only)
  // Spec:
  //  /rain <amount> <SYMBOL|0xToken|native> <count>
  //  /monsoon <amount> <SYMBOL|0xToken|native> <window>   (e.g. 15m, 1h)
  // Excludes stickers + banned phrases/users. Equal split.
  // ----------
  const rainMaxUsers = Math.max(1, Math.min(500, Number(process.env.TG_RAIN_MAX_USERS || 50)));
  const monsoonMaxUsers = Math.max(1, Math.min(2000, Number(process.env.TG_MONSOON_MAX_USERS || 200)));

  async function fetchChatActivity(chatId: string, sinceMs: number | null, limitDocs: number): Promise<any[]> {
    const body: any = { chatId, limit: limitDocs };
    if (sinceMs != null) body.sinceMs = sinceMs;
    const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/activity/list`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(r.error);
    return Array.isArray((r.data as any).items) ? (r.data as any).items : [];
  }

  function uniqByRecent(items: any[], want: number, excludeTgId: string): { tgIds: string[]; sampleNames: Record<string, string> } {
    const out: string[] = [];
    const seen = new Set<string>();
    const names: Record<string, string> = {};
    for (const it of items) {
      const tid = String(it?.tgId || '').trim();
      if (!tid) continue;
      if (tid === excludeTgId) continue;
      if (seen.has(tid)) continue;
      seen.add(tid);
      out.push(tid);
      const uname = String(it?.username || '').trim();
      if (uname) names[tid] = `@${uname}`;
      if (out.length >= want) break;
    }
    return { tgIds: out, sampleNames: names };
  }

  async function ensureSenderHasFunds(tgId: string, chainId: number, tokenAddrLower: string, needRaw: bigint): Promise<void> {
    const bal = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/balances`, {
      method: 'POST',
      body: JSON.stringify({ tgId, chainId })
    });
    if (!bal.ok) throw new Error(bal.error);
    const list = Array.isArray((bal.data as any)?.balances) ? (bal.data as any).balances : [];
    const match = list.find((b: any) => String(b?.token || '').toLowerCase() === String(tokenAddrLower).toLowerCase());
    const have = BigInt(String(match?.balanceRaw || '0'));
    if (have < needRaw) throw new Error('INSUFFICIENT');
  }

  async function handleRain(ctx: any) {
    if (isPrivateChatCtx(ctx)) {
      return ctx.reply('Rain is group-only. Use it in a group chat.');
    }

    const args = parseArgs((ctx.message as any)?.text || '').slice(1);
    const amountHuman = String(args[0] || '').trim();
    const asset = String(args[1] || '').trim();
    const count = Number(args[2] || 0);
    if (!amountHuman || !asset || !Number.isFinite(count) || count <= 0) {
      return ctx.reply('Usage: /rain <amount> <SYMBOL|0xToken|native> <peopleCount>\nExample: /rain 15000 haus 15');
    }
    if (count > rainMaxUsers) {
      return ctx.reply(`Too many people. Max is ${rainMaxUsers}.`);
    }

    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return ctx.reply('Cannot read your TG id.');

    const chatId = String(ctx.chat?.id ?? '').trim();
    if (!chatId) return ctx.reply('Cannot read chat id.');

    const resolved = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/token/resolve`, {
      method: 'POST',
      body: JSON.stringify({ chainId: cfg.chainId, asset })
    });
    if (!resolved.ok) return ctx.reply(`Token resolve failed: ${resolved.error}`);
    if (!(resolved.data as any)?.enabled) return ctx.reply(`Token not enabled: ${asset}`);

    let totalRawStr: string;
    try {
      totalRawStr = parseUnits(amountHuman, Number((resolved.data as any).decimals || 18));
    } catch (e: any) {
      return ctx.reply(`Bad amount: ${String(e?.message || e)}`);
    }
    const totalRaw = BigInt(totalRawStr);
    if (totalRaw <= 0n) return ctx.reply('Amount must be > 0.');

    // Fetch recent activity and select last N unique speakers
    const limitDocs = Math.min(2000, Math.max(200, count * 10));
    let items: any[] = [];
    try {
      items = await fetchChatActivity(chatId, null, limitDocs);
    } catch (e: any) {
      return ctx.reply(`Rain failed (activity): ${String(e?.message || e)}`);
    }
    const { tgIds } = uniqByRecent(items, count, tgId);
    if (tgIds.length < count) {
      return ctx.reply(`Not enough eligible speakers. Found ${tgIds.length}, need ${count}.`);
    }

    const n = BigInt(tgIds.length);
    const each = totalRaw / n;
    const rem = totalRaw - each * n;
    if (each <= 0n) return ctx.reply('Amount too small to split across recipients.');

    // Ensure sender has enough (avoid partial sends)
    try {
      await ensureSenderHasFunds(tgId, cfg.chainId, String((resolved.data as any).token || '').toLowerCase(), totalRaw);
    } catch (e: any) {
      const msg = String(e?.message || e);
      return ctx.reply(msg === 'NOT_LINKED' ? 'You must /register before you can rain.' : `Insufficient balance for this rain.`);
    }

    const rootRef = `tg-rain:${cfg.moduleId}:${tgId}:${Date.now()}`;
    const sym = String((resolved.data as any).symbol || asset);

    // Execute transfers
    let okCount = 0;
    for (let i = 0; i < tgIds.length; i++) {
      const tid = tgIds[i];
      const amt = (i === 0 ? (each + rem) : each).toString();
      const refId = `${rootRef}:${i}`;
      const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/ledger/transfer`, {
        method: 'POST',
        body: JSON.stringify({
          tgId,
          refId,
          chainId: cfg.chainId,
          asset,
          to: `tg:${cfg.moduleId}:${tid}`,
          amountRaw: amt,
          kind: 'tg_rain',
          reason: 'rain',
          meta: {
            chatId,
            chatType: String(ctx.chat?.type ?? ''),
            people: tgIds.length,
            mode: 'last_n'
          }
        })
      });
      if (!r.ok) {
        return ctx.reply(`Rain failed after ${okCount}/${tgIds.length} sends: ${r.error}\nRef: ${rootRef}`);
      }
      okCount++;
    }

    const eachHuman = formatUnits(each.toString(), Number((resolved.data as any).decimals || 18));
    return ctx.reply(`🌧️ Rain complete\nTotal: ${amountHuman} ${sym}\nPeople: ${tgIds.length}\nEach: ${eachHuman} ${sym}`);
  }

  async function handleMonsoon(ctx: any) {
    if (isPrivateChatCtx(ctx)) {
      return ctx.reply('Monsoon is group-only. Use it in a group chat.');
    }

    const args = parseArgs((ctx.message as any)?.text || '').slice(1);
    const amountHuman = String(args[0] || '').trim();
    const asset = String(args[1] || '').trim();
    const windowHint = String(args[2] || '').trim();
    if (!amountHuman || !asset || !windowHint) {
      return ctx.reply('Usage: /monsoon <amount> <SYMBOL|0xToken|native> <window>\nExample: /monsoon 15000 haus 1h');
    }

    let windowMs = 0;
    try {
      windowMs = parseWindowToMs(windowHint);
    } catch {
      return ctx.reply('Bad window. Use like 15m (1..59) or 1h (1..100). Max 100h.');
    }

    const tgId = String(ctx.from?.id || '').trim();
    if (!tgId) return ctx.reply('Cannot read your TG id.');

    const chatId = String(ctx.chat?.id ?? '').trim();
    if (!chatId) return ctx.reply('Cannot read chat id.');

    const resolved = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/token/resolve`, {
      method: 'POST',
      body: JSON.stringify({ chainId: cfg.chainId, asset })
    });
    if (!resolved.ok) return ctx.reply(`Token resolve failed: ${resolved.error}`);
    if (!(resolved.data as any)?.enabled) return ctx.reply(`Token not enabled: ${asset}`);

    let totalRawStr: string;
    try {
      totalRawStr = parseUnits(amountHuman, Number((resolved.data as any).decimals || 18));
    } catch (e: any) {
      return ctx.reply(`Bad amount: ${String(e?.message || e)}`);
    }
    const totalRaw = BigInt(totalRawStr);
    if (totalRaw <= 0n) return ctx.reply('Amount must be > 0.');

    const sinceMs = Date.now() - windowMs;
    const limitDocs = Math.min(5000, Math.max(500, monsoonMaxUsers * 15));
    let items: any[] = [];
    try {
      items = await fetchChatActivity(chatId, sinceMs, limitDocs);
    } catch (e: any) {
      return ctx.reply(`Monsoon failed (activity): ${String(e?.message || e)}`);
    }

    // unique all within window
    const { tgIds } = uniqByRecent(items, monsoonMaxUsers + 1, tgId);
    if (!tgIds.length) {
      return ctx.reply(`No eligible speakers found in the last ${windowHint}.`);
    }
    if (tgIds.length > monsoonMaxUsers) {
      return ctx.reply(`Too many eligible users (${tgIds.length}) for window ${windowHint}. Max allowed is ${monsoonMaxUsers}. No transaction was made.`);
    }

    const n = BigInt(tgIds.length);
    const each = totalRaw / n;
    const rem = totalRaw - each * n;
    if (each <= 0n) return ctx.reply('Amount too small to split across recipients.');

    try {
      await ensureSenderHasFunds(tgId, cfg.chainId, String((resolved.data as any).token || '').toLowerCase(), totalRaw);
    } catch {
      return ctx.reply('Insufficient balance for this monsoon.');
    }

    const rootRef = `tg-monsoon:${cfg.moduleId}:${tgId}:${Date.now()}`;
    const sym = String((resolved.data as any).symbol || asset);

    let okCount = 0;
    for (let i = 0; i < tgIds.length; i++) {
      const tid = tgIds[i];
      const amt = (i === 0 ? (each + rem) : each).toString();
      const refId = `${rootRef}:${i}`;
      const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/ledger/transfer`, {
        method: 'POST',
        body: JSON.stringify({
          tgId,
          refId,
          chainId: cfg.chainId,
          asset,
          to: `tg:${cfg.moduleId}:${tid}`,
          amountRaw: amt,
          kind: 'tg_monsoon',
          reason: 'monsoon',
          meta: {
            chatId,
            chatType: String(ctx.chat?.type ?? ''),
            people: tgIds.length,
            window: windowHint,
            sinceMs
          }
        })
      });
      if (!r.ok) {
        return ctx.reply(`Monsoon failed after ${okCount}/${tgIds.length} sends: ${r.error}\nRef: ${rootRef}`);
      }
      okCount++;
    }

    const eachHuman = formatUnits(each.toString(), Number((resolved.data as any).decimals || 18));
    return ctx.reply(`🌊 Monsoon complete\nTotal: ${amountHuman} ${sym}\nWindow: ${windowHint}\nPeople: ${tgIds.length}\nEach: ${eachHuman} ${sym}`);
  }

  if (cfg.enableRain) bot.command('rain', handleRain);
  if (cfg.enableMonsoon) bot.command('monsoon', handleMonsoon);

  // ----------
  // WITHDRAW (session)
  // ----------
  bot.command('withdraw', async (ctx) => {
    if (!(await requirePrivateCommand(ctx, 'withdraw'))) return;
    try {
      if (String(process.env.ENABLE_TG_SESSION_WITHDRAW || '0') !== '1') {
        return ctx.reply('Withdraw is disabled on this bot (ENABLE_TG_SESSION_WITHDRAW=0).');
      }

      const args = parseArgs((ctx.message as any)?.text || '');
      const amountHuman = args[1];
      const assetHint = args[2];
      const toHint = args[3] || '';

      if (!amountHuman || !assetHint) {
        return ctx.reply('Usage: /withdraw <amount> <SYMBOL|0xToken|native> [0xToAddress]');
      }

      const tgId = String(ctx.from?.id || '').trim();
      if (!tgId) return ctx.reply('Cannot read your TG id.');

      const chainId = Number(process.env.WITHDRAW_DEFAULT_CHAIN_ID || cfg.chainId);

      const bal = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/balances`, {
        method: 'POST',
        body: JSON.stringify({ tgId, chainId })
      });

      if (!bal.ok) {
        if (bal.error === 'NOT_LINKED') {
          return ctx.reply(
            `You are not linked yet.\n\n` +
              `1) Run /register to get your link\n` +
              `2) Confirm on the website\n` +
              `3) Back here: /approve`
          );
        }
        return ctx.reply(`Balance lookup failed: ${bal.error}`);
      }

      const linkedWallet = String((bal.data as any).ownerWallet || '').trim();
      const to = toHint && isEvmAddress(toHint) ? toHint : linkedWallet;
      if (!isEvmAddress(to)) return ctx.reply('Recipient address is invalid.');

      const assetLower = String(assetHint).trim().toLowerCase();
      const balances = ((bal.data as any).balances || []).filter((b: any) => b && b.enabled);

      const match = balances.find((b: any) => {
        const sym = String(b.symbol || '').toLowerCase();
        const tok = String(b.token || '').toLowerCase();
        if (assetLower === 'native') {
          const wNative = String((bal.data as any).wNative || '').toLowerCase();
          return sym === 'wbnb' || sym === 'weth' || sym === 'wavax' || (wNative && tok === wNative);
        }
        if (isEvmAddress(assetLower)) return tok === assetLower;
        return sym === assetLower;
      });

      if (!match) {
        const syms = balances.map((b: any) => String(b.symbol || '').trim()).filter(Boolean);
        return ctx.reply(`Unknown/disabled asset "${assetHint}". Enabled: ${syms.join(', ') || '(none)'}`);
      }

      const decimals = Number(match.decimals || 18);
      const debitRawStr = parseUnits(String(amountHuman), decimals);
      const debitRaw = BigInt(debitRawStr);
      if (debitRaw <= 0n) return ctx.reply('Amount must be > 0.');

      const vaultId =
        String(process.env.WITHDRAW_DEFAULT_VAULT_ID || '').trim() ||
        String(process.env.DEFAULT_VAULT_ID || '').trim();

      if (!vaultId) return ctx.reply('Withdraw is not configured (DEFAULT_VAULT_ID is missing).');

      const refId = `tg:${tgId}:withdraw:${Date.now()}:${Math.random().toString(16).slice(2)}`;

      const r = await apiFetch<any>(cfg, `/modules/${cfg.moduleId}/tg/session/withdraw`, {
        method: 'POST',
        body: JSON.stringify({
          tgId,
          chainId,
          vaultId,
          refId,
          to,
          asset: isEvmAddress(assetHint) ? assetHint : String(match.symbol || assetHint),
          debitRaw: debitRaw.toString()
        })
      });

      if (!r.ok) {
        if (r.error === 'SESSION_KEY_NOT_SET') {
          return ctx.reply(
            `Withdraw is enabled, but your session key is not set yet.\n\n` +
              `Create + activate a session key for:\n` +
              `• Vault: ${vaultId}\n` +
              `• Chain: ${chainId}\n\n` +
              `Then retry /withdraw.`
          );
        }
        if (r.error === 'ASSET_NOT_ALLOWED_IN_SESSION') {
          return ctx.reply(
            `Your session key does not allow this asset.\n` +
              `Update your session allowlist to include ${String(match.symbol || assetHint)}.`
          );
        }
        if (r.error === 'OVER_MAX_PER_TX' || r.error === 'OVER_REMAINING') {
          return ctx.reply(
            `Blocked by your session limits (${r.error}).\n` +
              `Lower the amount, or update your session caps.`
          );
        }
        return ctx.reply(`Withdraw failed: ${r.error}`);
      }

      const feeRaw = BigInt(String((r.data as any).feeRaw || '0'));
      const netRaw = BigInt(String((r.data as any).netRaw || '0'));

      return ctx.reply(
        `✅ Withdraw submitted\n` +
          `To: ${to}\n` +
          `Asset: ${String(match.symbol || assetHint)}\n` +
          `Net: ${formatUnits(netRaw.toString(), decimals)}\n` +
          `Fee: ${formatUnits(feeRaw.toString(), decimals)}\n` +
          ((r.data as any).txHash ? `Tx: ${(r.data as any).txHash}` : '')
      );
    } catch (e: any) {
      return ctx.reply(`Withdraw crashed: ${String(e?.message || e)}`);
    }
  });

  // ----------
  // Background DM notifications (funds received)
  // Core enqueues to tg_notify_outbox; bot polls + sends DMs.
  // ----------
  const pollEveryMs = Math.max(2000, Math.min(30_000, Number(process.env.TG_NOTIFY_POLL_MS || 4000)));
  let notifyBusy = false;

  async function tickNotify() {
    if (notifyBusy) return;
    notifyBusy = true;
    try {
      const r = await pullNotify(cfg, 20);
      if (!r.ok) return;
      const items = Array.isArray((r.data as any)?.items) ? (r.data as any).items : [];
      if (!items.length) return;

      const sentIds: string[] = [];
      for (const it of items) {
        const tgId = String(it?.tgId || '').trim();
        if (!tgId) {
          continue;
        }

        const id = String(it?._id || '').trim();
        const amountRaw = String(it?.amountRaw || '0');
        const decimals = Number(it?.tokenDecimals ?? it?.token_decimals ?? 18);
        const symbol = String(it?.tokenSymbol || it?.token_symbol || '').trim() || 'TOKEN';
        const sender = String(it?.senderLabel || it?.sender_label || it?.moduleId || 'system').trim();
        const chainId = Number(it?.chainId);
        const kind = String(it?.kind || '').trim();

        const amountFmt = formatUnits(amountRaw, Number.isFinite(decimals) ? decimals : 18);
        const lines = [
          `💸 Received ${amountFmt} ${symbol}`,
          sender ? `From: ${sender}` : '',
          Number.isFinite(chainId) ? `Chain: ${chainId}` : '',
          kind ? `Type: ${kind}` : ''
        ].filter(Boolean);

        try {
          await (bot as any).telegram.sendMessage(Number(tgId), lines.join('\n'), { disable_web_page_preview: true });
        } catch (e) {
          // If user never started bot / blocked it, Telegram returns 403.
          // Ack anyway so we don't build an endless queue.
        }

        if (id) sentIds.push(id);
      }

      if (sentIds.length) {
        await ackNotify(cfg, sentIds);
      }
    } catch (e) {
      console.error('[tg] notify poll failed', e);
    } finally {
      notifyBusy = false;
    }
  }

  // Start poller
  setInterval(() => {
    tickNotify().catch(() => null);
  }, pollEveryMs);

  // Run one tick shortly after boot
  setTimeout(() => {
    tickNotify().catch(() => null);
  }, 1500);
}

// Backwards-compatible name
export const registerTelegramModule = registerTgModule;

function isPrivateChatCtx(ctx: any) {
  const t = String(ctx?.chat?.type || '').toLowerCase();
  return t === 'private';
}

async function requirePrivateCommand(ctx: any, commandName: string): Promise<boolean> {
  if (isPrivateChatCtx(ctx)) return true;

  const botUsername = String(ctx?.botInfo?.username || '').trim();
  const deepLink = botUsername ? `https://t.me/${botUsername}?start=wallet` : '';
  const msg = [
    `🔒 /${commandName} is DM-only for privacy.`,
    `Please open a private chat with the bot and run /${commandName} there.`,
    deepLink ? `
Open DM: ${deepLink}` : ''
  ].join('');

  try { await ctx.reply(msg); } catch {}

  try {
    if (ctx?.from?.id) {
      const dm = [
        `You used /${commandName} in a group.`,
        `For privacy, use /${commandName} here in DM.`
      ].join(' ');
      await ctx.telegram.sendMessage(ctx.from.id, dm + (deepLink ? `\n\nOpen: ${deepLink}` : ''));
    }
  } catch {}

  return false;
}

