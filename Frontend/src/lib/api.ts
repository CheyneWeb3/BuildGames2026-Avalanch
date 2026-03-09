// src/lib/api.ts
/**
 * Shared Miniapp API helpers
 * - Uses Telegram initData to create a session via POST /auth/tg
 * - Stores session in localStorage under 'yeti_tg_session'
 * - Sends 'x-session' header for authenticated mini routes
 *
 * IMPORTANT:
 * This frontend resolves the Core API base URL from the on-chain TunnelUrlRegistry
 * (via ApiBaseContext.tsx) and caches it in localStorage.
 * There is NO hardcoded fallback URL.
 */

export const SESSION_KEY = "yeti_tg_session";

function normalizeOrigin(input: string): string {
  let s = (input || "").trim();
  if (!s) return "";
  // Strip trailing slashes
  s = s.replace(/\/+$/, "");
  return s;
}

function cacheKey(): string {
  const registryAddress = String(import.meta.env.VITE_TUNNEL_REGISTRY_ADDRESS || "").trim();
  const tunnelId = Number(import.meta.env.VITE_TUNNEL_ID || "10");
  // Must match ApiBaseContext.tsx cache key.
  return `haus:apiBase:v4:${registryAddress}:${tunnelId}`;
}

/**
 * Returns the currently resolved API origin (e.g. https://xxxx.trycloudflare.com).
 * Throws if not resolved yet (tunnel must resolve via ApiBaseProvider first).
 */
export function getApiBase(): string {
  const key = cacheKey();
  const v = normalizeOrigin(localStorage.getItem(key) || "");
  if (!v) {
    throw new Error(
      "Core API base not resolved from on-chain tunnel registry yet. " +
        "Open the app root so it can resolve, or check VITE_TUNNEL_* env + registry."
    );
  }
  return v;
}

export function getSession(): string {
  return String(localStorage.getItem(SESSION_KEY) || "");
}

export function setSession(session: string) {
  localStorage.setItem(SESSION_KEY, session);
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

type TgAuthResp = {
  ok: boolean;
  session?: string;
  telegramUserId?: string;
  telegramHandle?: string;
  firstName?: string;
  error?: string;
};

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const apiBase = getApiBase();
  const url = `${apiBase}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      "content-type": "application/json",
    },
  });

  const txt = await res.text().catch(() => "");
  let js: any = null;
  try {
    js = txt ? JSON.parse(txt) : null;
  } catch {
    js = null;
  }

  if (!res.ok) {
    const msg = js?.error ? String(js.error) : txt || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }

  return (js ?? ({} as any)) as T;
}

export async function authWithTelegram(initData: string): Promise<string> {
  const out = await apiJson<TgAuthResp>("/auth/tg", {
    method: "POST",
    body: JSON.stringify({ initData }),
  });

  if (!out?.ok || !out.session) throw new Error(out?.error || "Auth failed");
  setSession(out.session);
  return out.session;
}

export async function apiGet<T>(path: string): Promise<T> {
  const s = getSession();
  return apiJson<T>(path, {
    method: "GET",
    headers: s ? { "x-session": s } : undefined,
  });
}

export async function apiPost<T>(path: string, body?: any): Promise<T> {
  const s = getSession();
  return apiJson<T>(path, {
    method: "POST",
    headers: s ? { "x-session": s } : undefined,
    body: JSON.stringify(body ?? {}),
  });
}
