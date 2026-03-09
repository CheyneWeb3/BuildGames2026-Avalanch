// src/lib/telegram.ts
export function getTelegramInitData(): string {
  const w = window as any;
  return String(w?.Telegram?.WebApp?.initData || "").trim();
}

export function isTelegramWebApp(): boolean {
  const w = window as any;
  return !!w?.Telegram?.WebApp;
}
