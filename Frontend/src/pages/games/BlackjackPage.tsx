// src/pages/games/BlackjackPage.tsx
import * as React from "react";
import {
  Box,
  Paper,
  Typography,
  Stack,
  Button,
  Divider,
  Chip,
  CircularProgress,
  useMediaQuery,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Fade,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useApiBase } from "../../ApiBaseContext";

declare global {
  interface Window {
    Telegram?: any;
    visualViewport?: VisualViewport;
  }
}

/** =========================
 *  Config
 *  ========================= */
const DEFAULT_CASHIER_URL = "https://yetitipbot-poc.netlify.app/#/home";

// NOTE (Vite/Netlify): only env vars prefixed with VITE_ are exposed to the frontend.
// Cashier URL can be overridden via VITE_CASHIER_URL; API base is resolved on-chain.

function getCashierUrl() {
  // allow override via query param ?cashier=https://...
  try {
    const u = new URL(window.location.href);
    const qp = u.searchParams.get("cashier");
    if (qp && qp.startsWith("http")) return qp;
  } catch {}

  // Vite env (Netlify)
  const envUrl = (import.meta as any).env?.VITE_CASHIER_URL;
  if (envUrl && String(envUrl).startsWith("http")) return String(envUrl);

  return DEFAULT_CASHIER_URL;
}

const AUTH_TG_PATH = "/auth/tg";
const ME_BALANCES_PATH = "/mini/me/balances";

/**
 * Deposit link:
 * We *optionally* fetch a session-bound deposit URL from the API, but we NEVER fall back
 * to the API host (because that would open `${API_BASE}/deposit`). If the API doesn't
 * return a valid cashier URL, we fall back to the Cashier app URL.
 *
 * Security/consistency: we only accept a returned URL if it matches the Cashier origin.
 *
 * IMPORTANT: adjust these candidates to match your API if needed.
 */
const DEPOSIT_LINK_CANDIDATES = [
  "/mini/me/deposit", // preferred
  "/mini/me/deposit-link",
  "/mini/deposit",
  "/mini/deposit-link",
  "/tg/deposit",
  "/tg/deposit-link",
];

// Blackjack endpoints
const BJ_START = "/mini/blackjack/start";
const BJ_STATUS = "/mini/blackjack/status";
const BJ_HIT = "/mini/blackjack/hit";
const BJ_STAND = "/mini/blackjack/stand";
const BJ_DOUBLE = "/mini/blackjack/double";
const BJ_SPLIT = "/mini/blackjack/split";

/** =========================
 *  Types
 *  ========================= */
type TgAuthResp = {
  ok: boolean;
  session?: string;
  telegramUserId?: string;
  telegramHandle?: string;
  firstName?: string;
  error?: string;
};

type MiniBalances = {
  ok: boolean;
  railsPaused: boolean;
  telegramUserId: string;
  wallet: string;
  walletVerified: boolean;
  offchain: { raw: string; human: string };
  error?: string;
};

type DepositLinkResp = {
  ok: boolean;
  url?: string;
  link?: string;
  depositUrl?: string;
  error?: string;
};

type BJCard = { r: string; s: string };

type BJState = {
  ok?: boolean;
  gameId: string;
  status: "ACTIVE" | "DEALER_TURN" | "RESOLVED" | "CANCELLED";

  outcome?: string | null;
  outcomeHands?: (string | null)[];

  betHuman: string;
  betHandsHuman: string[];
  totalBetHuman: string;
  payoutHuman?: string;
  profitHuman?: string;

  playerHands: BJCard[][];
  activeHand: number;
  doubledHands: number[];
  handTotals: number[];

  dealerUp: BJCard[];
  dealerUpTotal: number;
  dealer?: BJCard[];
  dealerShown?: number;
  dealerVisibleTotal?: number;
  dealerTotal?: number;
  dealerNextAtMs?: number | null;

  canHit: boolean;
  canStand: boolean;
  canDouble: boolean;
  canSplit: boolean;

  expiresAtMs: number;
  updatedAtMs?: number;
};

/** =========================
 *  Theme tokens
 *  ========================= */
const UI = {
  textMain: "rgba(240,247,255,0.94)",
  textDim: "rgba(240,247,255,0.72)",
  textFaint: "rgba(240,247,255,0.52)",
  border: "rgba(255,255,255,0.14)",
  borderStrong: "rgba(255,200,0,0.62)",
  good: "rgba(120,255,160,0.95)",
  bad: "rgba(255,120,120,0.95)",
  panelBg2: "rgba(255,255,255,0.04)",
  feltBg:
    "radial-gradient(1200px 700px at 20% 0%, rgba(255,200,0,0.12), transparent 55%), radial-gradient(900px 600px at 80% 0%, rgba(0,255,200,0.10), transparent 55%), rgba(10,12,18,0.62)",
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function getTelegramInitData(): string {
  const tg = window.Telegram?.WebApp;
  return String(tg?.initData || "").trim();
}
function isTelegramWebApp(): boolean {
  return !!window.Telegram?.WebApp;
}

function isSameOriginAsCashier(url: string, cashierUrl: string): boolean {
  try {
    const cash = new URL(cashierUrl);
    const u = new URL(url);
    return u.origin === cash.origin;
  } catch {
    return false;
  }
}

function getSession(): string {
  return localStorage.getItem("yeti_tg_session") || "";
}
function setSession(s: string) {
  localStorage.setItem("yeti_tg_session", s);
}
function clearSession() {
  localStorage.removeItem("yeti_tg_session");
}

async function apiJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
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

/** =========================
 *  Utils
 *  ========================= */
function safeNumFromString(s: string): number {
  const n = Number(String(s || "").trim());
  return Number.isFinite(n) ? n : 0;
}

function clampBetHuman(b: string) {
  const x = String(b || "").trim();
  if (!x) return "0";
  if (/^\d+(\.\d+)?$/.test(x)) return x;
  const cleaned = x.replace(/[^\d.]/g, "");
  const parts = cleaned.split(".");
  return parts.length <= 2 ? cleaned : `${parts[0]}.${parts.slice(1).join("")}`;
}

// credits display: ZERO decimals
function formatCreditsZero(human?: string) {
  const s = String(human ?? "").trim();
  if (!s) return "0";
  const n = Number(s);
  if (!Number.isFinite(n)) return s.split(".")[0] || s;
  return String(Math.floor(n));
}

function msToShort(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/** =========================
 *  Hand math / display
 *  ========================= */
function normalizeSuit(s: string) {
  if (s === "♥") return "♥️";
  if (s === "♦") return "♦️";
  if (s === "♠") return "♠️";
  if (s === "♣") return "♣️";
  return s;
}
function suitIsRed(s: string) {
  return s === "♥" || s === "♦" || s === "♥️" || s === "♦️";
}
function rankToVal(r: string): number {
  const R = String(r || "").toUpperCase();
  if (R === "🂠") return 0;
  if (R === "A") return 11;
  if (R === "K" || R === "Q" || R === "J") return 10;
  const n = Number(R);
  return Number.isFinite(n) ? n : 0;
}
function computeHandTotal(cards: BJCard[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const rr = String(c?.r || "").toUpperCase();
    if (rr === "🂠") continue;
    const v = rankToVal(rr);
    total += v;
    if (rr === "A") aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function outcomeMeta(outcomeRaw?: string | null) {
  const o = String(outcomeRaw || "").toUpperCase();
  switch (o) {
    case "PLAYER_WIN":
      return { emoji: "✅", label: "YOU WIN", tone: "good" as const };
    case "DEALER_WIN":
      return { emoji: "❌", label: "YOU LOSE", tone: "bad" as const };
    case "PUSH":
      return { emoji: "🤝", label: "PUSH", tone: "mid" as const };
    case "PLAYER_BUST":
      return { emoji: "💥", label: "BUST", tone: "bad" as const };
    case "DEALER_BUST":
      return { emoji: "✅", label: "DEALER BUST", tone: "good" as const };
    case "PLAYER_BLACKJACK":
      return { emoji: "🟩", label: "BLACKJACK!", tone: "good" as const };
    case "DEALER_BLACKJACK":
      return { emoji: "🟥", label: "DEALER BLACKJACK", tone: "bad" as const };
    case "BOTH_BLACKJACK":
      return { emoji: "🤝", label: "BOTH BLACKJACK", tone: "mid" as const };
    case "CANCELLED":
      return { emoji: "⚠️", label: "CANCELLED", tone: "mid" as const };
    default:
      return { emoji: "•", label: outcomeRaw ? String(outcomeRaw) : "RESULT", tone: "mid" as const };
  }
}

function profitTone(profitHuman?: string) {
  const p = String(profitHuman ?? "").trim();
  const n = Number(p);
  if (Number.isFinite(n)) {
    if (n > 0) return { tone: "good" as const, text: `+${p}` };
    if (n < 0) return { tone: "bad" as const, text: p };
    return { tone: "mid" as const, text: p };
  }
  return { tone: "mid" as const, text: p };
}

/** =========================
 *  Viewport hook (Telegram-safe)
 *  ========================= */
function useStableViewportHeight() {
  const [vh, setVh] = React.useState<number>(() => {
    const tg = window.Telegram?.WebApp;
    const tgh = Number(tg?.viewportHeight);
    if (Number.isFinite(tgh) && tgh > 0) return tgh;
    const vv = window.visualViewport?.height;
    if (vv && vv > 0) return vv;
    return window.innerHeight || 700;
  });

  React.useEffect(() => {
    const tg = window.Telegram?.WebApp;

    const read = () => {
      const tgh = Number(tg?.viewportHeight);
      const vv = window.visualViewport?.height;
      const next =
        Number.isFinite(tgh) && tgh > 0 ? tgh : vv && vv > 0 ? vv : window.innerHeight || 700;

      setVh((prev) => (Math.abs(prev - next) > 1 ? next : prev));
      document.documentElement.style.setProperty("--app-vh", `${next}px`);
    };

    read();

    const onResize = () => read();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);

    try {
      tg?.onEvent?.("viewportChanged", read);
    } catch {}

    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      try {
        tg?.offEvent?.("viewportChanged", read);
      } catch {}
    };
  }, []);

  return vh;
}

function useBoxMeasure() {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [h, setH] = React.useState(0);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const read = () => setH(Math.round(el.getBoundingClientRect().height || 0));
    read();

    const ro = new ResizeObserver(() => read());
    ro.observe(el);

    return () => ro.disconnect();
  }, []);

  return { ref, h };
}

/** =========================
 *  Cards
 *  ========================= */
type CardDims = {
  w: number;
  h: number;
  rank: number;
  suit: number;
  center: number;
  radius: number;
};

function PlayingCard({ c, faceDown, dims }: { c?: BJCard; faceDown?: boolean; dims: CardDims }) {
  const w = dims.w;
  const h = dims.h;

  const isPlaceholderDown = String(c?.r || "") === "🂠";
  const down = !!faceDown || isPlaceholderDown;

  if (down) {
    return (
      <Box
        sx={{
          width: w,
          height: h,
          borderRadius: dims.radius,
          border: `1px solid ${UI.border}`,
          background: "linear-gradient(135deg, rgba(60,140,255,1), rgba(10,20,60,1))",
          position: "relative",
          overflow: "hidden",
          boxShadow: "0 10px 22px rgba(0,0,0,0.35)",
        }}
      >
        <Box
          sx={{
            position: "absolute",
            inset: Math.max(5, Math.round(w * 0.12)),
            borderRadius: Math.max(0, Math.round(dims.radius * 0.8)),
            border: "1px dashed rgba(255,255,255,0.35)",
            opacity: 0.9,
          }}
        />
        <Typography
          sx={{
            position: "absolute",
            bottom: 5,
            right: 7,
            fontWeight: 950,
            fontSize: Math.max(9, Math.round(dims.rank * 0.55)),
            color: UI.textMain,
            letterSpacing: 0.2,
          }}
        >
          BJ
        </Typography>
      </Box>
    );
  }

  const rank = c?.r ?? "?";
  const suit = normalizeSuit(c?.s ?? "?");
  const red = suitIsRed(suit);
  const mainColor = red ? "rgba(220,30,30,0.95)" : "rgba(15,18,24,0.94)";

  return (
    <Box
      sx={{
        width: w,
        height: h,
        borderRadius: dims.radius,
        border: "1px solid rgba(0,0,0,0.18)",
        background: "#fff",
        position: "relative",
        overflow: "hidden",
        boxShadow: "0 12px 26px rgba(0,0,0,0.28)",
      }}
    >
      <Typography
        sx={{
          position: "absolute",
          top: Math.max(5, Math.round(h * 0.08)),
          left: Math.max(7, Math.round(w * 0.14)),
          fontWeight: 950,
          fontSize: dims.rank,
          lineHeight: 1,
          color: mainColor,
        }}
      >
        {rank}
      </Typography>
      <Typography
        sx={{
          position: "absolute",
          top: Math.max(18, Math.round(h * 0.24)),
          left: Math.max(7, Math.round(w * 0.14)),
          fontWeight: 950,
          fontSize: dims.suit,
          lineHeight: 1,
          color: mainColor,
          opacity: 0.98,
        }}
      >
        {suit}
      </Typography>

      <Typography
        sx={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 990,
          fontSize: dims.center,
          color: mainColor,
          letterSpacing: -0.2,
          transform: "translateY(1px)",
        }}
      >
        {rank}
        {suit}
      </Typography>
    </Box>
  );
}

function computeOverlap(cardW: number, n: number, maxWidth: number) {
  const base = clamp(Math.round(cardW * 0.32), 10, 22);
  if (n <= 1) return base;
  const required = cardW - (maxWidth - cardW) / (n - 1);
  const need = clamp(Math.ceil(required), 6, cardW - 6);
  return Math.max(base, need);
}

function Fan({
  cards,
  forceHoleCard,
  dims,
  maxWidth,
}: {
  cards: BJCard[];
  forceHoleCard?: boolean;
  dims: CardDims;
  maxWidth: number;
}) {
  const list: Array<{ c?: BJCard; faceDown?: boolean; k: string }> = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    list.push({ c, k: `${c.r}${c.s}-${i}` });
  }

  // Dealer ACTIVE: show 2 cards (upcard + facedown)
  if (forceHoleCard) {
    if (list.length === 0) list.push({ c: { r: "?", s: "?" }, k: "hole-0" });
    if (list.length === 1) list.push({ faceDown: true, k: "hole-1" });
    if (list.length >= 2) list[1] = { faceDown: true, k: "hole-1" };
  }

  const n = list.length || 1;
  const overlap = computeOverlap(dims.w, n, Math.max(40, maxWidth));

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        "@keyframes dealIn": {
          from: { opacity: 0, transform: "translateY(8px) scale(0.985)" },
          to: { opacity: 1, transform: "translateY(0px) scale(1)" },
        },
      }}
    >
      {list.map((x, i) => (
        <Box
          key={x.k}
          sx={{
            ml: i === 0 ? 0 : `-${overlap}px`,
            animation: "dealIn 140ms ease both",
            animationDelay: `${Math.min(180, i * 38)}ms`,
            willChange: "transform, opacity",
          }}
        >
          <PlayingCard c={x.c} faceDown={x.faceDown} dims={dims} />
        </Box>
      ))}
    </Box>
  );
}

/** =========================
 *  Small turn toast (non-blocking)
 *  ========================= */
type ToastState = {
  open: boolean;
  title: string;
  sub?: string;
};

function TurnToast({
  toast,
  onClose,
  widthPx,
  topPx,
}: {
  toast: ToastState;
  onClose: () => void;
  widthPx: number;
  topPx: number;
}) {
  if (!toast.open) return null;

  return (
    <Box
      sx={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        top: `${topPx}px`,
        width: `${widthPx}px`,
        zIndex: 2000,
        pointerEvents: "none",
      }}
    >
      <Paper
        elevation={0}
        sx={{
          pointerEvents: "auto",
          borderRadius: 2,
          border: `1px solid ${UI.border}`,
          bgcolor: "rgba(10,12,16,0.62)",
          backdropFilter: "blur(10px)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.40)",
          px: 1.2,
          py: 0.9,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 990, color: UI.textMain, fontSize: 13, lineHeight: 1.15 }} noWrap>
            {toast.title}
          </Typography>
          {toast.sub ? (
            <Typography sx={{ color: UI.textDim, fontSize: 12, mt: 0.1 }} noWrap>
              {toast.sub}
            </Typography>
          ) : null}
        </Box>

        <IconButton onClick={onClose} size="small" sx={{ color: UI.textMain }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Paper>
    </Box>
  );
}

/** =========================
 *  Big CENTER overlay: YOU WIN / YOU LOSE / PUSH (non-blocking)
 *  ========================= */
type CenterOverlayState = {
  open: boolean;
  text: string;
  tone: "good" | "bad" | "mid";
};

function CenterResultOverlay({ overlay }: { overlay: CenterOverlayState }) {
  const bg =
    overlay.tone === "good"
      ? "rgba(0,180,90,0.52)"
      : overlay.tone === "bad"
        ? "rgba(220,30,30,0.50)"
        : "rgba(255,255,255,0.14)";

  const border =
    overlay.tone === "good"
      ? "rgba(120,255,160,0.55)"
      : overlay.tone === "bad"
        ? "rgba(255,120,120,0.55)"
        : "rgba(255,255,255,0.18)";

  return (
    <Fade in={overlay.open} timeout={140}>
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          zIndex: 2050,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <Paper
          elevation={0}
          sx={{
            borderRadius: 4,
            border: `1px solid ${border}`,
            bgcolor: bg,
            backdropFilter: "blur(10px)",
            boxShadow: "0 24px 90px rgba(0,0,0,0.55)",
            px: 2.2,
            py: 1.6,
            minWidth: 220,
            maxWidth: "min(520px, calc(100vw - 34px))",
            textAlign: "center",
          }}
        >
          <Typography
            sx={{
              fontWeight: 1100,
              fontSize: 28,
              letterSpacing: 0.6,
              color: UI.textMain,
              textTransform: "uppercase",
              lineHeight: 1.05,
              textShadow: "0 10px 28px rgba(0,0,0,0.45)",
            }}
          >
            {overlay.text}
          </Typography>
        </Paper>
      </Box>
    </Fade>
  );
}

/** =========================
 *  Bottom result toast overlay (NON-LAYOUT; fixes squashing)
 *  - Darker, readable background
 *  - Still tone-tinted for win/lose/push
 *  ========================= */
type ResultToastState = {
  open: boolean;
  tone: "good" | "bad" | "mid";
  title: string; // "YOU WIN" / "YOU LOSE" / "PUSH" / "CANCELLED"
  net?: string;
  bet?: string;
};

function ResultToastOverlay({
  toast,
  onClose,
  widthPx,
  bottomPx,
}: {
  toast: ResultToastState;
  onClose: () => void;
  widthPx: number;
  bottomPx: number;
}) {
  if (!toast.open) return null;

  // darker base + subtle tone tint overlay
  const bgBase = "rgba(10,12,16,0.92)";
  const bgTint =
    toast.tone === "good"
      ? "rgba(0,180,90,0.16)"
      : toast.tone === "bad"
        ? "rgba(220,30,30,0.16)"
        : "rgba(255,255,255,0.08)";

  const border =
    toast.tone === "good"
      ? "rgba(120,255,160,0.55)"
      : toast.tone === "bad"
        ? "rgba(255,120,120,0.55)"
        : "rgba(255,255,255,0.22)";

  const icon =
    toast.tone === "good"
      ? "✅"
      : toast.tone === "bad"
        ? "❌"
        : toast.title?.toUpperCase() === "CANCELLED"
          ? "⚠️"
          : "🤝";

  return (
    <Fade in={toast.open} timeout={140}>
      <Box
        sx={{
          position: "fixed",
          left: "50%",
          transform: "translateX(-50%)",
          bottom: `${bottomPx}px`,
          width: `${widthPx}px`,
          zIndex: 2040,
          pointerEvents: "none",
        }}
      >
        <Paper
          elevation={0}
          sx={{
            pointerEvents: "auto",
            borderRadius: 3,
            border: `1px solid ${border}`,
            bgcolor: bgBase,
            backgroundImage: `linear-gradient(0deg, ${bgTint}, ${bgTint})`,
            backdropFilter: "blur(12px) saturate(140%)",
            boxShadow: "0 18px 60px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.06)",
            px: 1.3,
            py: 1.05,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography
              sx={{
                fontWeight: 1100,
                color: UI.textMain,
                fontSize: 14,
                lineHeight: 1.15,
                textShadow: "0 2px 10px rgba(0,0,0,0.55)",
              }}
              noWrap
            >
              {icon} {toast.title}
            </Typography>

            <Typography
              sx={{
                color: UI.textDim,
                fontSize: 12,
                mt: 0.25,
                textShadow: "0 2px 10px rgba(0,0,0,0.55)",
              }}
              noWrap
            >
              {toast.net != null ? `Net: ${toast.net}` : ""}
              {toast.net != null && toast.bet != null ? "   •   " : ""}
              {toast.bet != null ? `Bet: ${toast.bet}` : ""}
            </Typography>
          </Box>

          <IconButton
            onClick={onClose}
            size="small"
            sx={{
              color: UI.textMain,
              ml: 0.5,
              bgcolor: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.10)",
              "&:hover": { bgcolor: "rgba(255,255,255,0.10)" },
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Paper>
      </Box>
    </Fade>
  );
}

/** =========================
 *  Modal helper (only for bet/cashier)
 *  ========================= */
function ModalShell({
  open,
  title,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      PaperProps={{
        sx: {
          borderRadius: 3,
          bgcolor: "rgba(12,16,24,0.98)",
          color: UI.textMain,
          border: `1px solid ${UI.border}`,
        },
      }}
    >
      <DialogTitle sx={{ fontWeight: 990, pr: 6, color: UI.textMain }}>
        {title}
        <IconButton onClick={onClose} sx={{ position: "absolute", right: 10, top: 10, color: UI.textMain }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ borderColor: UI.border }}>
        {children}
      </DialogContent>
      {actions ? <DialogActions sx={{ px: 2, py: 1.5 }}>{actions}</DialogActions> : null}
    </Dialog>
  );
}

/** =========================
 *  Gamebar helpers: fixed height, no greyed buttons
 *  ========================= */
function Slot({ show, children, h }: { show: boolean; children: React.ReactNode; h: number }) {
  if (show) return <>{children}</>;
  return <Box sx={{ height: h, flex: 1, borderRadius: 2.2, opacity: 0 }} />;
}

function ActionBtn({
  children,
  onClick,
  variant,
  color,
  outlined,
  h,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant: "contained" | "outlined";
  color?: "success" | "error";
  outlined?: boolean;
  h: number;
  disabled?: boolean;
}) {
  return (
    <Button
      onClick={onClick}
      variant={variant}
      color={color}
      disabled={disabled}
      fullWidth
      sx={{
        height: h,
        fontWeight: 1000,
        borderRadius: 2.2,
        textTransform: "none",
        ...(outlined ? { color: UI.textMain, borderColor: UI.border } : {}),
      }}
    >
      {children}
    </Button>
  );
}

/** =========================
 *  Page
 *  ========================= */
export default function BlackjackPage() {
  const API_BASE = useApiBase();
  const isWide = useMediaQuery("(min-width:900px)");
  const isMobile = useMediaQuery("(max-width:600px)");

  // viewport + measures
  const vh = useStableViewportHeight();
  const headerM = useBoxMeasure();
  const dockM = useBoxMeasure();

  const CASHIER_URL = React.useMemo(() => getCashierUrl(), []);


  // lock body scroll while mounted
  React.useEffect(() => {
    const prevHtml = document.documentElement.style.overflow;
    const prevBody = document.body.style.overflow;
    const prevBodyH = document.body.style.height;
    const prevHtmlH = document.documentElement.style.height;

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.documentElement.style.height = "100%";
    document.body.style.height = "100%";

    return () => {
      document.documentElement.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
      document.body.style.height = prevBodyH;
      document.documentElement.style.height = prevHtmlH;
    };
  }, []);

  const [actionBusy, setActionBusy] = React.useState(false);
  const [err, setErr] = React.useState<string>("");

  const [tgLabel, setTgLabel] = React.useState<string>("");
  const [bal, setBal] = React.useState<MiniBalances | null>(null);
  const [signedIn, setSignedIn] = React.useState<boolean>(() => !!getSession());

  const [bet, setBet] = React.useState("10");
  const [lastBet, setLastBet] = React.useState("10");
  const [state, setState] = React.useState<BJState | null>(null);

  // modals
  const [betModalOpen, setBetModalOpen] = React.useState(false);
  const [cashierOpen, setCashierOpen] = React.useState(false);

  // cashier: deposit url (fetched from API)
  const [depositUrl, setDepositUrl] = React.useState<string>("");
  const [depositBusy, setDepositBusy] = React.useState<boolean>(false);

  // small toast (turn/errors)
  const [turnToast, setTurnToast] = React.useState<ToastState>({ open: false, title: "" });
  const turnTimer = React.useRef<number | null>(null);

  // center overlay (YOU WIN / YOU LOSE / PUSH)
  const [overlay, setOverlay] = React.useState<CenterOverlayState>({ open: false, text: "", tone: "mid" });
  const overlayTimer = React.useRef<number | null>(null);

  // bottom result toast (overlay; DOES NOT change layout)
  const [resultToast, setResultToast] = React.useState<ResultToastState>({
    open: false,
    tone: "mid",
    title: "",
  });
  const resultTimer = React.useRef<number | null>(null);

  const stateRef = React.useRef<BJState | null>(null);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function showTurnToast(next: ToastState, autoMs = 900) {
    if (turnTimer.current) window.clearTimeout(turnTimer.current);
    setTurnToast(next);
    if (autoMs > 0) {
      turnTimer.current = window.setTimeout(() => {
        setTurnToast((t) => ({ ...t, open: false }));
        turnTimer.current = null;
      }, autoMs);
    }
  }

  function showCenterOverlay(next: Omit<CenterOverlayState, "open">, autoMs = 2000 /* doubled */) {
    if (overlayTimer.current) window.clearTimeout(overlayTimer.current);
    setOverlay({ open: true, ...next });
    overlayTimer.current = window.setTimeout(() => {
      setOverlay((o) => ({ ...o, open: false }));
      overlayTimer.current = null;
    }, autoMs);
  }

  function showResultToast(next: Omit<ResultToastState, "open">, autoMs = 2600) {
    if (resultTimer.current) window.clearTimeout(resultTimer.current);
    setResultToast({ open: true, ...next });
    if (autoMs > 0) {
      resultTimer.current = window.setTimeout(() => {
        setResultToast((t) => ({ ...t, open: false }));
        resultTimer.current = null;
      }, autoMs);
    }
  }

  React.useEffect(() => {
    return () => {
      if (turnTimer.current) window.clearTimeout(turnTimer.current);
      if (overlayTimer.current) window.clearTimeout(overlayTimer.current);
      if (resultTimer.current) window.clearTimeout(resultTimer.current);
    };
  }, []);

  // Telegram UX
  React.useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    try {
      tg.ready?.();
      tg.expand?.();
      const u = tg.initDataUnsafe?.user;
      if (u?.username) setTgLabel(`@${u.username}`);
      else if (u?.first_name) setTgLabel(String(u.first_name));
    } catch {}
  }, []);

  async function ensureAuth(): Promise<string> {
    const existing = getSession();
    if (existing) return existing;

    const initData = getTelegramInitData();
    if (!initData) {
      const msg = isTelegramWebApp()
        ? "No initData found (Telegram didn’t pass auth payload)."
        : "Open this page from Telegram (Mini App) so initData is available.";
      throw new Error(msg);
    }

    const out = await apiJson<TgAuthResp>(API_BASE, AUTH_TG_PATH, {
      method: "POST",
      body: JSON.stringify({ initData }),
    });

    if (!out?.ok || !out.session) throw new Error(out?.error || "Auth failed");
    setSession(out.session);
    setSignedIn(true);

    const label = out.telegramHandle ? `@${out.telegramHandle}` : out.firstName || "";
    if (label) setTgLabel(label);

    return out.session;
  }

  async function loadBalances(s?: string) {
    const sess = s || getSession();
    if (!sess) return;
    const out = await apiJson<MiniBalances>(API_BASE, ME_BALANCES_PATH, {
      method: "GET",
      headers: { "x-session": sess },
    });
    if (!out?.ok) throw new Error(out?.error || "Bad balances response");
    setBal(out);
  }

  async function loadDepositUrlFromApi(s?: string) {
    const sess = s || getSession();
    if (!sess) {
      setDepositUrl("");
      return;
    }

    setDepositBusy(true);
    try {
      for (const p of DEPOSIT_LINK_CANDIDATES) {
        try {
          const out = await apiJson<DepositLinkResp>(API_BASE, p, {
            method: "GET",
            headers: { "x-session": sess },
          });

          const url = String(out?.url || out?.link || out?.depositUrl || "").trim();
          if (out?.ok && url.startsWith("http")) {
            // SECURITY / UX: only accept URLs that point to the cashier app origin.
            // This prevents accidentally opening the API host (eg ...trycloudflare.com/deposit).
            if (isSameOriginAsCashier(url, CASHIER_URL)) {
              setDepositUrl(url);
              return;
            }
          }
        } catch {
          // try next candidate
        }
      }

      // fallback: do NOT open the API host; keep depositUrl blank so UI uses CASHIER_URL.
      setDepositUrl("");
    } finally {
      setDepositBusy(false);
    }
  }

  async function signIn() {
    setErr("");
    setActionBusy(true);
    try {
      const s = await ensureAuth();
      await loadBalances(s);
      // fetch deposit link too (since you want the REAL link from your /deposit flow)
      void loadDepositUrlFromApi(s);
      showTurnToast({ open: true, title: "✅ Signed in" }, 800);
    } catch (e: any) {
      const msg = String(e?.message || e);
      setErr(msg);
      showTurnToast({ open: true, title: "❌ Sign in failed", sub: msg }, 1400);
      setSignedIn(!!getSession());
    } finally {
      setActionBusy(false);
    }
  }

  function signOut() {
    clearSession();
    setSignedIn(false);
    setBal(null);
    setState(null);
    setErr("");
    setDepositUrl("");
    setOverlay((o) => ({ ...o, open: false }));
    setResultToast((t) => ({ ...t, open: false }));
    showTurnToast({ open: true, title: "Signed out" }, 800);
  }

  // auto-auth in Telegram
  React.useEffect(() => {
    if (!isTelegramWebApp()) return;
    (async () => {
      try {
        if (getSession()) {
          setSignedIn(true);
          await loadBalances();
          void loadDepositUrlFromApi();
          return;
        }
        const s = await ensureAuth();
        await loadBalances(s);
        void loadDepositUrlFromApi(s);
      } catch {
        // show Sign In
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // when opening cashier modal, refresh deposit link (and balances) quietly
  React.useEffect(() => {
    if (!cashierOpen) return;
    if (!signedIn) return;
    (async () => {
      try {
        const s = await ensureAuth();
        await loadBalances(s);
        void loadDepositUrlFromApi(s);
      } catch {
        // silent
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashierOpen, signedIn]);

  const canPlay = signedIn && !bal?.railsPaused;

  async function startWithBet(betHuman: string) {
    setErr("");
    setActionBusy(true);
    try {
      const s = await ensureAuth();
      if (bal?.railsPaused) throw new Error("Rails are paused. Movement actions are disabled.");

      const b = clampBetHuman(betHuman);
      if (safeNumFromString(b) <= 0) throw new Error("Bet must be > 0");

      const out = await apiJson<BJState>(API_BASE, BJ_START, {
        method: "POST",
        headers: { "x-session": s },
        body: JSON.stringify({ betHuman: b }),
      });

      if (!out || !out.gameId) throw new Error("Bad response from /mini/blackjack/start");

      setState(out);
      setLastBet(b); // lastBet is the rebet anchor
      setOverlay((o) => ({ ...o, open: false }));
      setResultToast((t) => ({ ...t, open: false }));
      await loadBalances(s);

      showTurnToast({ open: true, title: "🎴 Dealt", sub: "Your turn" }, 800);
    } catch (e: any) {
      const msg = String(e?.message || e);
      setErr(msg);
      showTurnToast({ open: true, title: "❌ Deal failed", sub: msg }, 1400);
    } finally {
      setActionBusy(false);
    }
  }

  async function start() {
    return startWithBet(bet);
  }

  async function act(path: string) {
    const cur = stateRef.current;
    if (!cur) return;

    setErr("");
    setActionBusy(true);
    try {
      const s = await ensureAuth();

      const out = await apiJson<BJState>(API_BASE, path, {
        method: "POST",
        headers: { "x-session": s },
        body: JSON.stringify({ gameId: cur.gameId }),
      });

      setState(out);

      if (out.status !== "ACTIVE") {
        await loadBalances(s);
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      setErr(msg);
      showTurnToast({ open: true, title: "❌ Action failed", sub: msg }, 1400);
    } finally {
      setActionBusy(false);
    }
  }

  async function refreshSilent() {
    const cur = stateRef.current;
    if (!cur) return;

    try {
      const s = await ensureAuth();
      const qp = new URLSearchParams();
      qp.set("gameId", cur.gameId);

      const out = await apiJson<BJState>(API_BASE, `${BJ_STATUS}?${qp.toString()}`, {
        method: "GET",
        headers: { "x-session": s },
      });

      setState(out);

      if (cur.status === "DEALER_TURN" && out.status !== "DEALER_TURN") {
        await loadBalances(s);
      }
    } catch {
      // silent
    }
  }

  // silent polling while ACTIVE/DEALER_TURN
  React.useEffect(() => {
    const cur = stateRef.current;
    if (!cur) return;
    if (cur.status !== "ACTIVE" && cur.status !== "DEALER_TURN") return;

    const tick = () => {
      if (actionBusy) return;
      void refreshSilent();
    };

    let intervalMs = 1500;
    if (cur.status === "DEALER_TURN") {
      const nextAt = typeof cur.dealerNextAtMs === "number" ? cur.dealerNextAtMs : null;
      if (nextAt && nextAt > Date.now()) intervalMs = Math.min(1200, Math.max(300, nextAt - Date.now()));
      else intervalMs = 750;
    }

    const t = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(t);
  }, [actionBusy, state?.status, state?.gameId, state?.dealerNextAtMs]);

  /** =========================
   *  Overlay trigger at end of hand
   *  - ALWAYS: good => YOU WIN, bad => YOU LOSE, mid => PUSH
   *  - Works for PLAYER_BLACKJACK / DEALER_BLACKJACK too
   *  - ALSO: bottom result toast overlay (no layout squash)
   * ========================= */
  const prevStatusRef = React.useRef<BJState["status"] | null>(null);
  const prevGameIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const st = state;
    if (!st) return;

    if (prevGameIdRef.current && prevGameIdRef.current !== st.gameId) {
      setTurnToast((t) => ({ ...t, open: false }));
      setOverlay((o) => ({ ...o, open: false }));
      setResultToast((t) => ({ ...t, open: false }));
    }
    prevGameIdRef.current = st.gameId;

    const prev = prevStatusRef.current;
    prevStatusRef.current = st.status;

    if (st.status === "DEALER_TURN" && prev !== "DEALER_TURN") {
      showTurnToast(
        {
          open: true,
          title: "🎴 Dealer turn",
          sub: typeof st.dealerNextAtMs === "number" ? `Next: ${msToShort(st.dealerNextAtMs - Date.now())}` : "Drawing…",
        },
        900
      );
    }

    if ((st.status === "RESOLVED" || st.status === "CANCELLED") && prev !== st.status) {
      const meta = outcomeMeta(st.outcome ?? (st.status === "CANCELLED" ? "CANCELLED" : null));

      // Big center overlay (kept)
      if (meta.label === "CANCELLED") {
        showCenterOverlay({ text: "CANCELLED", tone: "mid" }, 2000);
      } else if (meta.tone === "good") {
        showCenterOverlay({ text: "YOU WIN", tone: "good" }, 2000);
      } else if (meta.tone === "bad") {
        showCenterOverlay({ text: "YOU LOSE", tone: "bad" }, 2000);
      } else {
        showCenterOverlay({ text: "PUSH", tone: "mid" }, 2000);
      }

      // Bottom result toast overlay (replaces the old dock strip)
      const title =
        meta.label === "CANCELLED"
          ? "CANCELLED"
          : meta.tone === "good"
            ? "YOU WIN"
            : meta.tone === "bad"
              ? "YOU LOSE"
              : "PUSH";

      showResultToast(
        {
          tone: meta.tone === "good" ? "good" : meta.tone === "bad" ? "bad" : "mid",
          title,
          net: profitTone(st.profitHuman).text || "0",
          bet: st.totalBetHuman || st.betHuman || "",
        },
        2600
      );
    }
  }, [state]);

  /** =========================
   *  Layout sizing
   *  ========================= */
  const maxWidth = 980;
  const sidePad = isMobile ? 10 : 14;

  const dockH = dockM.h || 0;
  const headerH = headerM.h || 0;

  const safeBottomExtra = 10;
  const usableH = Math.max(260, Math.floor(vh - dockH - safeBottomExtra - 8));
  const tableH = Math.max(220, Math.floor(usableH - headerH - 8));

  const dealerH = clamp(Math.floor(tableH * 0.38), 120, isMobile ? 170 : 220);
  const playerH = Math.max(140, tableH - dealerH - 10);

  const vw = typeof window !== "undefined" ? window.innerWidth : 390;
  const contentW = Math.min(maxWidth, vw) - sidePad * 2;

  const hasMultiHands = !!state && state.playerHands && state.playerHands.length > 1;
  const stackHands = hasMultiHands && !isWide;

  const dealerCardH = clamp(Math.round(dealerH * 0.56), isMobile ? 70 : 78, isWide ? 120 : 104);
  const dealerCardW = clamp(Math.round(dealerCardH * 0.70), isMobile ? 52 : 58, isWide ? 84 : 72);

  const playerCardH = clamp(
    Math.round(playerH * (hasMultiHands ? 0.42 : 0.52)),
    isMobile ? 68 : 78,
    isWide ? 116 : 100
  );
  const playerCardW = clamp(Math.round(playerCardH * 0.70), isMobile ? 50 : 58, isWide ? 82 : 70);

  const mkDims = (w: number, h: number): CardDims => {
    const minSide = Math.min(w, h);
    const radius = isMobile ? 0 : clamp(Math.round(minSide * 0.05), 2, 4);
    const rank = clamp(Math.round(h * 0.18), 13, 22);
    const suit = clamp(Math.round(h * 0.16), 12, 20);
    const center = clamp(Math.round(h * 0.28), 18, 30);
    return { w, h, radius, rank, suit, center };
  };

  const dealerDims = mkDims(dealerCardW, dealerCardH);
  const playerDims = mkDims(playerCardW, playerCardH);

  const isActive = state?.status === "ACTIVE";
  const isDealerTurn = state?.status === "DEALER_TURN";

  const dealerCards: BJCard[] =
    state?.dealer && state.dealer.length ? state.dealer : state?.dealerUp?.length ? state.dealerUp : [];

  const dealerTotal =
    isActive
      ? state?.dealerUpTotal ?? computeHandTotal(state?.dealerUp || [])
      : isDealerTurn
        ? typeof state?.dealerVisibleTotal === "number"
          ? state.dealerVisibleTotal
          : computeHandTotal(dealerCards)
        : typeof state?.dealerTotal === "number"
          ? state.dealerTotal
          : computeHandTotal(dealerCards);

  const activeHandTotal =
    state && state.playerHands?.length
      ? state.handTotals?.[state.activeHand] ?? computeHandTotal(state.playerHands[state.activeHand] || [])
      : 0;

  const betVal = safeNumFromString(clampBetHuman(bet));
  const setBetHuman = (v: number) => setBet(String(Math.max(0, Math.floor(v))));

  // small toast geometry
  const toastW = clamp(Math.floor(contentW - 18), 220, 360);
  const toastTop = clamp((headerH || 54) + 8, 56, 92);

  // bottom result toast geometry (above dock, no layout changes)
  const resultToastW = clamp(Math.floor(contentW - 18), 260, 520);
  const resultToastBottom = Math.floor(dockH + 18 + 10);

  // Turn highlighting
  const dealerGlow = isDealerTurn
    ? {
        borderColor: UI.borderStrong,
        boxShadow: "0 0 0 2px rgba(255,200,0,0.22), 0 18px 40px rgba(0,0,0,0.30)",
        background: "rgba(255,200,0,0.06)",
      }
    : {};

  const playerGlow = isActive
    ? {
        borderColor: UI.borderStrong,
        boxShadow: "0 0 0 2px rgba(255,200,0,0.22), 0 18px 40px rgba(0,0,0,0.30)",
        background: "rgba(255,200,0,0.06)",
      }
    : {};

  const creditsLabel = bal?.offchain?.human ? formatCreditsZero(bal.offchain.human) : "—";

  const canDeal = !actionBusy && canPlay && !(state?.status === "ACTIVE" || state?.status === "DEALER_TURN");
  const betLocked = !!state && (state.status === "ACTIVE" || state.status === "DEALER_TURN");

  // Header bet chip: to the RIGHT of the turn pill
  const headerBetLabel = `Bet ${state?.totalBetHuman ? state.totalBetHuman : clampBetHuman(bet)}`;

  // Gamebar fixed button sizing
  const BTN_H = isMobile ? 44 : 46;

  // Decide gamebar mode
  const mode: "ACTIVE" | "DEALER" | "END" | "IDLE" =
    state?.status === "ACTIVE"
      ? "ACTIVE"
      : state?.status === "DEALER_TURN"
        ? "DEALER"
        : state?.status === "RESOLVED" || state?.status === "CANCELLED"
          ? "END"
          : "IDLE";

  // ACTIVE buttons (only show when actually usable -> no greyed buttons)
  const canShowHit = mode === "ACTIVE" && !!state?.canHit && !actionBusy;
  const canShowStand = mode === "ACTIVE" && !!state?.canStand && !actionBusy;
  const canShowDouble = mode === "ACTIVE" && !!state?.canDouble && !actionBusy;
  const canShowSplit = mode === "ACTIVE" && !!state?.canSplit && !actionBusy;

  // END/IDLE buttons
  const canShowBet = (mode === "IDLE" || mode === "END") && canPlay && !betLocked && !actionBusy;
  const canShowDeal = (mode === "IDLE" || mode === "END") && canDeal;

  // Rebet greys if bet changed (bet != lastBet)
  const betNow = clampBetHuman(bet);
  const rebetDisabled = betNow !== clampBetHuman(lastBet);

  const canShowRebet = (mode === "IDLE" || mode === "END") && canPlay && !actionBusy;

  const canShowCashOrSign = !actionBusy && (signedIn ? true : isTelegramWebApp());
  const onCashOrSign = () => {
    if (signedIn) setCashierOpen(true);
    else void signIn();
  };

  const resolvedDepositUrl =
    (depositUrl && depositUrl.startsWith("http") ? depositUrl : "") || CASHIER_URL;

  return (
    <Box
      sx={{
        height: "var(--app-vh, 100dvh)",
        width: "100%",
        overflow: "hidden",
        position: "relative",
        color: UI.textMain,
        display: "flex",
        justifyContent: "center",
      }}
    >
      {/* Small turn toast */}
      <TurnToast
        toast={turnToast}
        onClose={() => setTurnToast((t) => ({ ...t, open: false }))}
        widthPx={toastW}
        topPx={toastTop}
      />

      {/* Big center overlay (YOU WIN / YOU LOSE / PUSH) */}
      <CenterResultOverlay overlay={overlay} />

      {/* Bottom result toast overlay (FIXES SQUASHING) */}
      <ResultToastOverlay
        toast={resultToast}
        onClose={() => setResultToast((t) => ({ ...t, open: false }))}
        widthPx={resultToastW}
        bottomPx={resultToastBottom}
      />

      {/* Centered container */}
      <Box
        sx={{
          width: "100%",
          maxWidth,
          height: "100%",
          px: `${sidePad}px`,
          pt: isMobile ? 1 : 1.5,
          pb: `calc(${dockH}px + ${safeBottomExtra}px + env(safe-area-inset-bottom))`,
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        <Box
          sx={{
            borderRadius: 4,
            overflow: "hidden",
            border: `1px solid ${UI.border}`,
            background: UI.feltBg,
            backdropFilter: "blur(10px)",
            boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
            height: "100%",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <Box
            ref={headerM.ref}
            sx={{
              p: isMobile ? 1.0 : 1.2,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 1,
              flexWrap: "wrap",
              flex: "0 0 auto",
            }}
          >
            <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
              {/*

    {tgLabel ? (
      <Chip
        size="small"
        variant="outlined"
        label={tgLabel}
        sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 900 }}
      />
    ) : null}


    <Button
      onClick={() => setCashierOpen(true)}
      variant="outlined"
      disabled={!signedIn}
      sx={{ borderRadius: 2, fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
    >
      💰 Cashier
    </Button>

    {!signedIn ? (
      <Button
        onClick={signIn}
        variant="contained"
        disabled={actionBusy || !isTelegramWebApp()}
        sx={{ borderRadius: 2, fontWeight: 950 }}
      >
        Sign In
      </Button>
    ) : (
      <Button
        onClick={signOut}
        variant="outlined"
        disabled={actionBusy}
        sx={{ borderRadius: 2, fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
      >
        Sign Out
      </Button>
    )}

    {actionBusy ? <CircularProgress size={20} /> : null}

    */}

              {bal?.railsPaused ? <Chip size="small" color="warning" label="Paused" /> : null}

              <Chip
                size="small"
                variant="outlined"
                label={`🪙 ${creditsLabel}`}
                sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
              />
            </Box>

            {/* RIGHT cluster: Turn pill + Bet amount pill */}
            <Box sx={{ display: "flex", gap: 1, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Chip
                size="small"
                variant="outlined"
                label={
                  state?.status
                    ? state.status === "ACTIVE"
                      ? "Your turn"
                      : state.status === "DEALER_TURN"
                        ? "Dealer turn"
                        : "Done"
                    : "Ready"
                }
                sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 900 }}
              />
              <Chip
                size="small"
                variant="outlined"
                label={headerBetLabel}
                sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
              />
            </Box>
          </Box>

          {/* Table */}
          <Box
            sx={{
              flex: "1 1 auto",
              overflow: "hidden",
              px: isMobile ? 1.0 : 1.4,
              pb: isMobile ? 1.0 : 1.4,
              minHeight: 0,
            }}
          >
            <Paper
              variant="outlined"
              sx={{
                height: `${tableH}px`,
                p: isMobile ? 1.0 : 1.2,
                borderRadius: 4,
                background:
                  "radial-gradient(900px 520px at 50% 0%, rgba(0,255,160,0.09), transparent 60%), rgba(0,0,0,0.22)",
                borderColor: UI.border,
                display: "flex",
                flexDirection: "column",
                gap: 1.2,
                overflow: "hidden",
              }}
            >
              {/* Dealer */}
              <Paper
                variant="outlined"
                sx={{
                  height: `${dealerH}px`,
                  p: isMobile ? 1.0 : 1.1,
                  borderRadius: 3,
                  borderColor: UI.border,
                  background: UI.panelBg2,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  overflow: "hidden",
                  ...(dealerGlow as any),
                }}
              >
                <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Typography sx={{ fontWeight: 990, fontSize: isMobile ? 13 : 14, color: UI.textMain }}>
                    Dealer {isDealerTurn ? "• TURN" : ""}
                  </Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`TOTAL ${dealerTotal}`}
                    sx={{ fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
                  />
                </Box>

                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    flex: "1 1 auto",
                    minHeight: 0,
                  }}
                >
                  <Fan cards={dealerCards} forceHoleCard={!!isActive} dims={dealerDims} maxWidth={contentW - 28} />
                </Box>

                <Box sx={{ display: "flex", justifyContent: "center", minHeight: 20 }}>
                  {isDealerTurn ? (
                    <Typography sx={{ color: UI.textDim, fontWeight: 900, fontSize: 12 }}>
                      ⏳ Dealer drawing…{" "}
                      {typeof state?.dealerNextAtMs === "number" ? msToShort(state.dealerNextAtMs - Date.now()) : ""}
                    </Typography>
                  ) : (
                    <Typography sx={{ color: "transparent" }}>.</Typography>
                  )}
                </Box>
              </Paper>

              {/* Player */}
              <Paper
                variant="outlined"
                sx={{
                  height: `${playerH}px`,
                  p: isMobile ? 1.0 : 1.1,
                  borderRadius: 3,
                  borderColor: UI.border,
                  background: UI.panelBg2,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                  gap: 1.0,
                  ...(playerGlow as any),
                }}
              >
                <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Typography sx={{ fontWeight: 990, fontSize: isMobile ? 13 : 14, color: UI.textMain }}>
                    Player {isActive ? "• TURN" : ""}
                  </Typography>
                  {state ? (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`TOTAL ${activeHandTotal}`}
                      sx={{ fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
                    />
                  ) : (
                    <Chip size="small" variant="outlined" label="No hand" sx={{ color: UI.textMain, borderColor: UI.border }} />
                  )}
                </Box>

                {!state ? (
                  <Box sx={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Typography sx={{ color: UI.textDim, fontWeight: 900 }}>
                      Set bet → <span style={{ color: UI.textMain }}>Deal</span>
                    </Typography>
                  </Box>
                ) : (
                  <Box sx={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
                    <Stack
                      direction={stackHands ? "column" : "row"}
                      spacing={1.0}
                      sx={{ height: "100%", alignItems: "stretch", justifyContent: "center" }}
                    >
                      {state.playerHands.map((hand, idx) => {
                        const isActiveHand = state.status === "ACTIVE" && idx === state.activeHand;
                        const handBoxW =
                          stackHands ? contentW - 30 : hasMultiHands ? Math.floor((contentW - 30 - 10) / 2) : contentW - 30;

                        return (
                          <Paper
                            key={idx}
                            variant="outlined"
                            sx={{
                              flex: stackHands ? "1 1 0" : hasMultiHands ? "0 1 50%" : "0 1 100%",
                              p: 0.9,
                              borderRadius: 3,
                              borderWidth: isActiveHand ? 2 : 1,
                              borderColor: isActiveHand ? UI.borderStrong : UI.border,
                              background: isActiveHand ? "rgba(255,200,0,0.08)" : "rgba(255,255,255,0.03)",
                              display: "flex",
                              flexDirection: "column",
                              justifyContent: "center",
                              overflow: "hidden",
                              minWidth: 0,
                            }}
                          >
                            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.6 }}>
                              {hasMultiHands ? (
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  label={`Hand ${idx + 1}${isActiveHand ? " • ACTIVE" : ""}`}
                                  sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 900 }}
                                />
                              ) : (
                                <Box />
                              )}
                              <Chip
                                size="small"
                                variant="outlined"
                                label={`${state.handTotals?.[idx] ?? computeHandTotal(hand)}`}
                                sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 900 }}
                              />
                            </Box>

                            <Box
                              sx={{
                                display: "flex",
                                justifyContent: "center",
                                alignItems: "center",
                                flex: "1 1 auto",
                                minHeight: 0,
                              }}
                            >
                              <Fan cards={hand} dims={playerDims} maxWidth={handBoxW} />
                            </Box>
                          </Paper>
                        );
                      })}
                    </Stack>
                  </Box>
                )}
              </Paper>
            </Paper>
          </Box>
        </Box>
      </Box>

      {/* Fixed Bottom Game Bar (ALWAYS SAME HEIGHT; no greyed buttons) */}
      <Box
        ref={dockM.ref}
        sx={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          pb: `calc(env(safe-area-inset-bottom) + 10px)`,
          pt: 1,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <Paper
          elevation={0}
          sx={{
            width: "100%",
            maxWidth,
            mx: `${sidePad}px`,
            p: isMobile ? 1.0 : 1.2,
            borderRadius: 3,
            border: `1px solid ${UI.border}`,
            background: "rgba(0,0,0,0.42)",
            backdropFilter: "blur(10px)",
            boxShadow: "0 16px 50px rgba(0,0,0,0.35)",
            pointerEvents: "auto",
          }}
        >
          <Stack spacing={1}>
            {/* Fixed “4-button” block (2 rows x 2 cols) */}
            <Box
              sx={{
                borderRadius: 3,
                border: `1px solid ${UI.border}`,
                background: "rgba(255,255,255,0.03)",
                p: isMobile ? 0.9 : 1.0,
              }}
            >
              {/* Row 1 */}
              <Stack direction="row" spacing={1} sx={{ width: "100%" }}>
                {/* ACTIVE => HIT ; END/IDLE => DEAL (Deal on top) */}
                <Slot show={mode === "ACTIVE" ? canShowHit : mode === "END" || mode === "IDLE" ? canDeal : false} h={BTN_H}>
                  <ActionBtn
                    h={BTN_H}
                    onClick={() => {
                      if (mode === "ACTIVE") void act(BJ_HIT);
                      else void start();
                    }}
                    variant="contained"
                    color={mode === "ACTIVE" ? "success" : undefined}
                  >
                    {mode === "ACTIVE" ? "👆 HIT" : "🎴 Deal"}
                  </ActionBtn>
                </Slot>

                {/* ACTIVE => STAND ; END/IDLE => BET */}
                <Slot show={mode === "ACTIVE" ? canShowStand : mode === "END" || mode === "IDLE" ? canShowBet : false} h={BTN_H}>
                  <ActionBtn
                    h={BTN_H}
                    onClick={() => {
                      if (mode === "ACTIVE") void act(BJ_STAND);
                      else setBetModalOpen(true);
                    }}
                    variant={mode === "ACTIVE" ? "contained" : "outlined"}
                    color={mode === "ACTIVE" ? "error" : undefined}
                    outlined={mode !== "ACTIVE"}
                  >
                    {mode === "ACTIVE" ? "✋ STAND" : "🪙 Bet"}
                  </ActionBtn>
                </Slot>
              </Stack>

              {/* Row 2 */}
              <Stack direction="row" spacing={1} sx={{ width: "100%", mt: 1 }}>
                {/* ACTIVE => DOUBLE ; END/IDLE => REBET (Rebet under Deal) */}
                <Slot show={mode === "ACTIVE" ? canShowDouble : mode === "END" || mode === "IDLE" ? canShowRebet : false} h={BTN_H}>
                  <ActionBtn
                    h={BTN_H}
                    onClick={() => {
                      if (mode === "ACTIVE") void act(BJ_DOUBLE);
                      else void startWithBet(lastBet);
                    }}
                    variant={mode === "ACTIVE" ? "outlined" : "contained"}
                    outlined={mode === "ACTIVE"}
                    disabled={mode !== "ACTIVE" ? rebetDisabled : false}
                  >
                    {mode === "ACTIVE" ? "⏫ Double" : "🔁 Rebet"}
                  </ActionBtn>
                </Slot>

                {/* ACTIVE => SPLIT ; END/IDLE => Cashier/Sign In */}
                <Slot show={mode === "ACTIVE" ? canShowSplit : mode === "END" || mode === "IDLE" ? canShowCashOrSign : false} h={BTN_H}>
                  <ActionBtn
                    h={BTN_H}
                    onClick={() => {
                      if (mode === "ACTIVE") void act(BJ_SPLIT);
                      else onCashOrSign();
                    }}
                    variant="outlined"
                    outlined
                  >
                    {mode === "ACTIVE" ? "✂️ Split" : signedIn ? "💰 Cashier" : "Sign In"}
                  </ActionBtn>
                </Slot>
              </Stack>
            </Box>

            {err ? <Typography sx={{ color: UI.bad, fontSize: 12, fontWeight: 900, mt: 0.2 }}>{err}</Typography> : null}

            {/* Rebet disabled hint (only when visible) */}
            {(mode === "END" || mode === "IDLE") && canShowRebet && rebetDisabled ? (
              <Typography sx={{ color: UI.textFaint, fontSize: 12, fontWeight: 900 }}>
                🔁 Rebet is locked — set bet back to {clampBetHuman(lastBet)} to rebet.
              </Typography>
            ) : null}
          </Stack>
        </Paper>
      </Box>

      {/* Bet Modal */}
      <ModalShell
        open={betModalOpen}
        title="Set your bet"
        onClose={() => setBetModalOpen(false)}
        actions={
          <>
            <Button onClick={() => setBetModalOpen(false)} sx={{ color: UI.textMain, fontWeight: 900 }}>
              Close
            </Button>
          </>
        }
      >
        <Typography sx={{ color: UI.textDim, mb: 1 }}>Choose chips (credits):</Typography>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {[10, 25, 50, 100, 250, 500, 1000, 2500, 5000].map((v) => (
            <Button
              key={v}
              variant="outlined"
              onClick={() => setBetHuman(v)}
              sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
            >
              {v} 🪙
            </Button>
          ))}
        </Stack>

        <Divider sx={{ my: 2, borderColor: UI.border, opacity: 0.6 }} />

        <Typography sx={{ color: UI.textDim, mb: 1 }}>Fine tune:</Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" onClick={() => setBetHuman(betVal - 10)} sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}>
            -10
          </Button>
          <Button variant="outlined" onClick={() => setBetHuman(betVal + 10)} sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}>
            +10
          </Button>
          <Button variant="outlined" onClick={() => setBetHuman(betVal + 50)} sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}>
            +50
          </Button>
          <Button variant="outlined" onClick={() => setBetHuman(betVal + 100)} sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}>
            +100
          </Button>
        </Stack>

        <Divider sx={{ my: 2, borderColor: UI.border, opacity: 0.6 }} />
        <Typography sx={{ color: UI.textMain, fontWeight: 990 }}>Current bet: {clampBetHuman(bet)}</Typography>
      </ModalShell>

      {/* Cashier Modal (updated: deposit link fetched from /deposit flow + sign in/out + friendlier copy) */}
      <ModalShell
        open={cashierOpen}
        title="Cashier"
        onClose={() => setCashierOpen(false)}
        actions={
          <Stack direction="row" spacing={1} sx={{ width: "100%", justifyContent: "space-between" }}>
            <Button onClick={() => setCashierOpen(false)} sx={{ color: UI.textMain, fontWeight: 900 }}>
              Close
            </Button>

            {/* Sign In / Sign Out inside modal */}
            {!signedIn ? (
              <Button
                onClick={() => void signIn()}
                variant="contained"
                disabled={actionBusy || !isTelegramWebApp()}
                sx={{ borderRadius: 2, fontWeight: 950 }}
              >
                Sign In
              </Button>
            ) : (
              <Button
                onClick={() => {
                  signOut();
                  setCashierOpen(false);
                }}
                variant="outlined"
                disabled={actionBusy}
                sx={{ borderRadius: 2, fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
              >
                Sign Out
              </Button>
            )}
          </Stack>
        }
      >
        {!signedIn ? (
          <Stack spacing={1.2}>
            <Typography sx={{ color: UI.textMain, fontWeight: 950 }}>Sign in to view your credits and wallet.</Typography>
            <Typography sx={{ color: UI.textDim, fontSize: 13 }}>
              Open this inside Telegram (Mini App) so we can verify your session securely.
            </Typography>

            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 2, borderColor: UI.border, background: "rgba(255,255,255,0.05)" }}>
              <Typography sx={{ color: UI.textDim, fontSize: 13 }}>Once signed in, you’ll get a Deposit button here.</Typography>
            </Paper>
          </Stack>
        ) : (
          <Stack spacing={1.2}>
            {/* Balance Card */}
            <Paper
              variant="outlined"
              sx={{
                p: 1.4,
                borderRadius: 2,
                borderColor: UI.border,
                background: "rgba(255,255,255,0.05)",
              }}
            >
              <Typography sx={{ fontWeight: 990, color: UI.textMain }}>🪙 YETI Credits</Typography>
              <Typography sx={{ color: UI.textDim, fontSize: 20, fontWeight: 950, mt: 0.2 }}>
                {formatCreditsZero(bal?.offchain?.human)}
              </Typography>

              <Divider sx={{ my: 1.1, borderColor: UI.border, opacity: 0.6 }} />

              <Typography sx={{ color: UI.textFaint, fontSize: 12 }}>Telegram ID: {bal?.telegramUserId || "—"}</Typography>

              <Typography sx={{ color: UI.textFaint, fontSize: 12, mt: 0.4 }}>
                Wallet: {bal?.wallet ? `${bal.wallet.slice(0, 6)}…${bal.wallet.slice(-4)}` : "—"}{" "}
                {bal?.walletVerified ? "✅ verified" : "❌ unverified"}
              </Typography>
            </Paper>

            {/* Deposit button (uses REAL link fetched from /deposit flow; no reconstruct-from-api-base nonsense) */}
            <Paper
              variant="outlined"
              sx={{
                p: 1.2,
                borderRadius: 2,
                borderColor: UI.border,
                background: "rgba(0,0,0,0.22)",
              }}
            >
              <Typography sx={{ fontWeight: 950, color: UI.textMain }}>Deposit</Typography>
              <Typography sx={{ color: UI.textDim, fontSize: 13, mt: 0.2 }}>
                This uses the same deposit link your <b>/deposit</b> flow returns (session-based), so it stays correct even if the
                deposit page lives somewhere else.
              </Typography>

              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1.1 }}>
                <Button
                  variant="contained"
                  onClick={() => {
                    let url = resolvedDepositUrl;

                    try {
                      const u = new URL(url);
                      const api = new URL(API_BASE);
                      if (u.origin === api.origin) {
                        // NEVER open API host in the browser
                        url = CASHIER_URL;
                      }
                    } catch {
                      url = CASHIER_URL;
                    }

                    // Telegram-friendly open
                    try {
                      window.Telegram?.WebApp?.openLink?.(url, { try_instant_view: false });
                      return;
                    } catch {}

                    // Fallback
                    window.open(url, "_blank", "noopener,noreferrer");
                  }}
                  sx={{ borderRadius: 2, fontWeight: 950 }}
                  disabled={actionBusy || depositBusy}
                  fullWidth
                >
                  {depositBusy ? "Loading link…" : "🌐 Open Deposit Page"}
                </Button>

                <Button
                  variant="outlined"
                  onClick={() => {
                    void (async () => {
                      try {
                        const s = await ensureAuth();
                        await loadBalances(s);
                        await loadDepositUrlFromApi(s);
                      } catch {}
                    })();
                  }}
                  sx={{ borderRadius: 2, fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
                  disabled={actionBusy || depositBusy}
                  fullWidth
                >
                  🔄 Refresh
                </Button>
              </Stack>

              <Typography sx={{ color: UI.textFaint, fontSize: 12, mt: 0.9 }}>
                Deposit link: {resolvedDepositUrl}
              </Typography>
            </Paper>

            {/* Rails paused warning */}
            {bal?.railsPaused ? (
              <Paper
                variant="outlined"
                sx={{
                  p: 1.2,
                  borderRadius: 2,
                  borderColor: "rgba(255,200,0,0.35)",
                  background: "rgba(255,200,0,0.10)",
                }}
              >
                <Typography sx={{ fontWeight: 990, color: UI.textMain }}>⚠️ Rails Paused</Typography>
                <Typography sx={{ color: UI.textDim, fontSize: 13 }}>Movement actions are temporarily disabled.</Typography>
              </Paper>
            ) : null}
          </Stack>
        )}
      </ModalShell>
    </Box>
  );
}
