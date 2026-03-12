import type { Context, Telegraf } from 'telegraf';

export type SaaSModuleConfig = {
  /** Core API base URL (e.g. https://api.example.com) */
  coreApiBaseUrl: string;

  /** Public subscription/skin endpoint path. Defaults to /saas/chats/:chatId */
  publicChatEndpoint?: string;

  /** A link users can open to subscribe/manage (miniapp, dapp, website). */
  subscribeUrl?: string;

  /** Cache time for chat status (ms). Default 10s. */
  cacheMs?: number;
};

type ChatPublic = {
  active: boolean;
  status: 'active' | 'expired' | 'disabled';
  expiresAt: number;
  planId: string;
  skin?: {
    brandName?: string;
    shortName?: string;
    accentHex?: string;
    logoUrl?: string;
    bannerUrl?: string;
    theme?: 'dark' | 'light';
  };
};

function chatIdFromCtx(ctx: any): string | null {
  const id = ctx?.chat?.id;
  if (id === undefined || id === null) return null;
  return String(id);
}

function isGroupChat(ctx: any): boolean {
  const t = ctx?.chat?.type;
  return t === 'group' || t === 'supergroup';
}

function defaultSubscribeText(chat: ChatPublic, cfg: SaaSModuleConfig): string {
  const brand = chat.skin?.brandName || 'This group';
  const exp = chat.expiresAt ? new Date(chat.expiresAt).toISOString().slice(0, 10) : '—';
  const link = cfg.subscribeUrl ? `\n\nSubscribe / manage: ${cfg.subscribeUrl}` : '';
  if (chat.active) {
    return `✅ ${brand} is subscribed (plan: ${chat.planId}).\nExpires: ${exp}${link}`;
  }
  return `⚠️ ${brand} is NOT subscribed (status: ${chat.status}).${link}`;
}

export function registerSaasTelegram(bot: Telegraf<Context>, cfg: SaaSModuleConfig) {
  const cacheMs = cfg.cacheMs ?? 10_000;
  const endpointTpl = cfg.publicChatEndpoint ?? '/saas/chats/:chatId';

  const cache = new Map<string, { at: number; data: ChatPublic }>();

  async function fetchChatPublic(chatId: string): Promise<ChatPublic> {
    const now = Date.now();
    const hit = cache.get(chatId);
    if (hit && now - hit.at <= cacheMs) return hit.data;

    const ep = endpointTpl.replace(':chatId', encodeURIComponent(chatId));
    const url = cfg.coreApiBaseUrl.replace(/\/$/, '') + ep;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      // Fail closed: treat as not subscribed in groups.
      const data: ChatPublic = { active: false, status: 'expired', expiresAt: 0, planId: 'basic' };
      cache.set(chatId, { at: now, data });
      return data;
    }
    const json = (await res.json()) as any;
    const data: ChatPublic = json?.chat ?? { active: false, status: 'expired', expiresAt: 0, planId: 'basic' };
    cache.set(chatId, { at: now, data });
    return data;
  }

  // Group gate: if not subscribed, block most commands.
  bot.use(async (ctx, next) => {
    const chatId = chatIdFromCtx(ctx);
    if (!chatId) return next();
    if (!isGroupChat(ctx)) return next(); // DM always allowed.

    // Allow these always (so groups can subscribe / check status).
    const text = (ctx as any)?.message?.text as string | undefined;
    const cmd = text?.startsWith('/') ? text.split(/\s+/)[0].toLowerCase() : '';
    if (cmd === '/subscribe' || cmd === '/substatus' || cmd === '/start' || cmd === '/help') {
      return next();
    }

    const pub = await fetchChatPublic(chatId);
    if (pub.active) return next();

    await ctx.reply(defaultSubscribeText(pub, cfg));
  });

  bot.command('substatus', async (ctx) => {
    const chatId = chatIdFromCtx(ctx);
    if (!chatId) return;
    const pub = await fetchChatPublic(chatId);
    await ctx.reply(defaultSubscribeText(pub, cfg));
  });

  bot.command('subscribe', async (ctx) => {
    const chatId = chatIdFromCtx(ctx);
    if (!chatId) return;
    const pub = await fetchChatPublic(chatId);
    await ctx.reply(defaultSubscribeText(pub, cfg));
  });
}
