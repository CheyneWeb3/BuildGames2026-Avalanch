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
import { formatUnits } from "ethers";
import { useApiBase } from "../../ApiBaseContext";


declare global {
  interface Window {
    google?: any;
    visualViewport?: VisualViewport;
  }
}


import UnregisteredGooglePrompt from "../../components/google/UnregisteredGooglePrompt";
import UnregisteredGoogleRegisterButton from "../../components/google/UnregisteredGoogleRegisterButton";



const LS_JWT = "haus_user_jwt";
const TARGET_CHAIN_ID = 43113;
const DEFAULT_CASHIER_URL = "https://thehaus-fuji-mvp.netlify.app/#/home";

const AUTH_GOOGLE_VERIFY_PATH = "/auth/google/verify";
const ME_BALANCES_PATH = "/me/balances";

const BJ_INFO = "/me/blackjack/info";
const BJ_CURRENT = "/me/blackjack/current";
const BJ_START = "/me/blackjack/start";
const BJ_HIT = "/me/blackjack/hit";
const BJ_STAND = "/me/blackjack/stand";
const BJ_DOUBLE = "/me/blackjack/double";
const BJ_HISTORY = "/me/blackjack/history";

function getCashierUrl() {
  try {
    const u = new URL(window.location.href);
    const qp = u.searchParams.get("cashier");
    if (qp && qp.startsWith("http")) return qp;
  } catch {}

  const envUrl = (import.meta as any).env?.VITE_CASHIER_URL;
  if (envUrl && String(envUrl).startsWith("http")) return String(envUrl);

  return DEFAULT_CASHIER_URL;
}

type GoogleVerifyResponse = {
  ok?: boolean;
  linked?: boolean;
  address?: string;
  token?: string;
  jwt?: string;
  authProvider?: string;
  googleLinkToken?: string;
  googleSub?: string;
  email?: string | null;
  name?: string | null;
  error?: string;
};

type BalanceItem = {
  chainId: number;
  token: string;
  symbol?: string;
  decimals?: number;
  balanceRaw?: string;
  availableRaw?: string;
  heldRaw?: string;
  totalRaw?: string;
  balanceHuman?: string;
  updatedAt?: string;
};

type TokenOption = {
  key: string;
  token: string;
  symbol: string;
  decimals: number;
  availableRaw: string;
  heldRaw: string;
  availableHuman: string;
};

type TokenListToken = {
  chainId: number;
  address: string;
  symbol?: string;
  decimals?: number;
};

type BlackjackInfoResponse = {
  ok?: boolean;
  chainId: number;
  token: string;
  symbol: string;
  decimals: number;
  vaultId?: string;
  treasuryId?: string;
  treasuryAccountId?: string;
  feeTreasuryAccountId?: string;
  lossFeeBps?: number;
  usdcOnly?: boolean;
  blackjackPayout?: string;
  dealerHitsSoft17?: boolean;
  actions?: string[];
};

type RoundCard = {
  rank: string;
  suit: string;
  value: number;
  label: string;
};

type BlackjackRoundView = {
  id: string;
  chainId: number;
  token: string;
  symbol: string;
  decimals: number;
  betRaw: string;
  doubled: boolean;
  status: string;
  payoutRaw: string;
  playerCards: RoundCard[];
  playerTotal: number;
  dealerCards: RoundCard[];
  dealerTotal: number;
  dealerResolvedCards?: RoundCard[];
  dealerResolvedTotal?: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  clientRequestId?: string | null;
};

type BlackjackCurrentResponse = {
  ok?: boolean;
  round: BlackjackRoundView | null;
};

type BlackjackStartResponse = {
  ok?: boolean;
  treasuryId?: string;
  treasuryAccountId?: string;
  round: BlackjackRoundView;
};

type BlackjackHistoryResponse = {
  ok?: boolean;
  items: BlackjackRoundView[];
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

function getJwt(): string {
  return localStorage.getItem(LS_JWT) || "";
}
function setJwt(jwt: string) {
  localStorage.setItem(LS_JWT, jwt);
}
function clearJwt() {
  localStorage.removeItem(LS_JWT);
}

async function apiRequest<T>(apiBase: string, path: string, jwt: string, init?: RequestInit): Promise<T> {
  const cleanBase = String(apiBase || "").replace(/\/+$/, "");
  const url = `${cleanBase}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      ...(init?.headers || {}),
    },
  });

  const txt = await res.text().catch(() => "");
  let data: any = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { raw: txt };
  }

  if (!res.ok) {
    throw new Error(String(data?.error || data?.message || data?.raw || `${res.status} ${res.statusText}`));
  }

  return data as T;
}

function safeBigInt(v?: string | number | bigint | null) {
  try {
    if (typeof v === "bigint") return v;
    const s = String(v ?? "0").trim();
    return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
  } catch {
    return 0n;
  }
}

function formatAmount(raw: string | undefined, decimals: number, maxFrac = 6) {
  try {
    const full = formatUnits(safeBigInt(raw), decimals);
    if (!full.includes(".")) return full;
    const [a, b] = full.split(".");
    const trimmed = (b || "").slice(0, maxFrac).replace(/0+$/g, "");
    return trimmed ? `${a}.${trimmed}` : a;
  } catch {
    return "0";
  }
}

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

function multiplyHumanAmount(v: string, mult: number): string {
  const n = Number(String(v || "0"));
  if (!Number.isFinite(n) || n <= 0) return "0";
  const out = n * mult;
  const s = String(out);
  return s.includes(".")
    ? s.replace(/(\.\d*?[1-9])0+$/g, "$1").replace(/\.0+$/g, "")
    : s;
}

function msToShort(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function normalizeBalances(raw: any): BalanceItem[] {
  const items = Array.isArray(raw?.items)
    ? raw.items
    : Array.isArray(raw?.balances)
      ? raw.balances
      : Array.isArray(raw)
        ? raw
        : [];

  return items.map((x: any) => ({
    chainId: Number(x.chainId || 0),
    token: String(x.token || "").toLowerCase(),
    symbol: String(x.symbol || ""),
    decimals: Number(x.decimals ?? 18),
    balanceRaw: String(x.balanceRaw ?? x.balance ?? x.totalRaw ?? "0"),
    availableRaw: String(x.availableRaw ?? x.balanceRaw ?? x.balance ?? x.totalRaw ?? "0"),
    heldRaw: String(x.heldRaw ?? "0"),
    totalRaw: String(x.totalRaw ?? x.balanceRaw ?? x.balance ?? "0"),
    balanceHuman: typeof x.balanceHuman === "string" ? x.balanceHuman : undefined,
    updatedAt: String(x.updatedAt || ""),
  }));
}

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
    case "BLACKJACK":
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

function mapRoundCard(c: RoundCard): BJCard {
  return {
    r: String(c?.rank || "?"),
    s: normalizeSuit(String(c?.suit || "")),
  };
}

function isResolvedRoundStatus(status?: string) {
  return [
    "PLAYER_BUST",
    "DEALER_BUST",
    "PLAYER_WIN",
    "DEALER_WIN",
    "BLACKJACK",
    "DEALER_BLACKJACK",
    "PUSH",
    "CANCELLED",
  ].includes(String(status || ""));
}

function roundToBjState(round: BlackjackRoundView | null): BJState | null {
  if (!round) return null;

  const statusRaw = String(round.status || "");
  const resolved = isResolvedRoundStatus(statusRaw);

  const playerCards = Array.isArray(round.playerCards) ? round.playerCards.map(mapRoundCard) : [];
  const dealerCards = Array.isArray(round.dealerCards) ? round.dealerCards.map(mapRoundCard) : [];
  const dealerResolvedCards = Array.isArray(round.dealerResolvedCards)
    ? round.dealerResolvedCards.map(mapRoundCard)
    : [];

  const betHuman = formatAmount(round.betRaw, Number(round.decimals || 6), 6);
  const totalBetHuman = round.doubled ? multiplyHumanAmount(betHuman, 2) : betHuman;
  const payoutHuman = formatAmount(round.payoutRaw || "0", Number(round.decimals || 6), 6);

  const totalBetRaw = safeBigInt(round.betRaw) * (round.doubled ? 2n : 1n);
  const payoutRaw = safeBigInt(round.payoutRaw || "0");
  const profitRaw = payoutRaw - totalBetRaw;
  const profitHuman = formatAmount(String(profitRaw), Number(round.decimals || 6), 6);

  let status: BJState["status"] = "ACTIVE";
  if (statusRaw === "DEALER_TURN") status = "DEALER_TURN";
  else if (statusRaw === "CANCELLED") status = "CANCELLED";
  else if (resolved) status = "RESOLVED";

  const canHit = status === "ACTIVE";
  const canStand = status === "ACTIVE";
  const canDouble = status === "ACTIVE" && !round.doubled && playerCards.length === 2;

  const dealerVisible =
    status === "RESOLVED" || status === "CANCELLED"
      ? dealerResolvedCards.length
        ? dealerResolvedCards
        : dealerCards
      : dealerCards;

  const dealerVisibleTotal =
    status === "RESOLVED" || status === "CANCELLED"
      ? Number(round.dealerResolvedTotal ?? round.dealerTotal ?? computeHandTotal(dealerVisible))
      : Number(round.dealerTotal ?? computeHandTotal(dealerCards));

  return {
    ok: true,
    gameId: String(round.id || ""),
    status,
    outcome: resolved || status === "CANCELLED" ? statusRaw : null,
    outcomeHands: [resolved || status === "CANCELLED" ? statusRaw : null],
    betHuman,
    betHandsHuman: [betHuman],
    totalBetHuman,
    payoutHuman,
    profitHuman,
    playerHands: [playerCards],
    activeHand: 0,
    doubledHands: round.doubled ? [0] : [],
    handTotals: [Number(round.playerTotal || computeHandTotal(playerCards))],
    dealerUp: dealerCards,
    dealerUpTotal: Number(round.dealerTotal || computeHandTotal(dealerCards)),
    dealer: dealerVisible,
    dealerShown: dealerVisible.length,
    dealerVisibleTotal,
    dealerTotal: dealerVisibleTotal,
    dealerNextAtMs: status === "DEALER_TURN" ? Date.now() + 1200 : null,
    canHit,
    canStand,
    canDouble,
    canSplit: false,
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    updatedAtMs: Date.parse(round.updatedAt || round.createdAt || new Date().toISOString()),
  };
}

function useStableViewportHeight() {
  const [vh, setVh] = React.useState<number>(() => {
    const vv = window.visualViewport?.height;
    if (vv && vv > 0) return vv;
    return window.innerHeight || 700;
  });

  React.useEffect(() => {
    const read = () => {
      const vv = window.visualViewport?.height;
      const next = vv && vv > 0 ? vv : window.innerHeight || 700;
      setVh((prev) => (Math.abs(prev - next) > 1 ? next : prev));
      document.documentElement.style.setProperty("--app-vh", `${next}px`);
    };

    read();
    const onResize = () => read();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
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

type ResultToastState = {
  open: boolean;
  tone: "good" | "bad" | "mid";
  title: string;
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

export default function BlackjackPage() {
  const API_BASE = useApiBase();
  const isWide = useMediaQuery("(min-width:900px)");
  const isMobile = useMediaQuery("(max-width:600px)");

  const vh = useStableViewportHeight();
  const headerM = useBoxMeasure();
  const dockM = useBoxMeasure();
  const CASHIER_URL = React.useMemo(() => getCashierUrl(), []);

  const [tokenList, setTokenList] = React.useState<TokenListToken[]>([]);

  React.useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch("/tokenlist.json", { cache: "no-cache" });
        if (!r.ok) return;
        const j = await r.json();
        if (!dead) setTokenList((Array.isArray(j?.tokens) ? j.tokens : []) as TokenListToken[]);
      } catch {
        if (!dead) setTokenList([]);
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

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

  const tokenMetaByChainAddr = React.useMemo(() => {
    const m = new Map<string, { symbol: string; decimals: number }>();
    for (const t of tokenList) {
      const cid = Number(t?.chainId || 0);
      const addr = String(t?.address || "").trim().toLowerCase();
      if (cid && addr) {
        m.set(`${cid}:${addr}`, {
          symbol: String(t?.symbol || "").toUpperCase(),
          decimals: Number(t?.decimals ?? 18),
        });
      }
    }
    return m;
  }, [tokenList]);

  const [actionBusy, setActionBusy] = React.useState(false);
  const [googleBusy, setGoogleBusy] = React.useState(false);
  const [err, setErr] = React.useState("");

  const [needsRegistration, setNeedsRegistration] = React.useState(false);
  const [googleLinkEmail, setGoogleLinkEmail] = React.useState("");
  const [googleLinkName, setGoogleLinkName] = React.useState("");
  const [googleLinkSub, setGoogleLinkSub] = React.useState("");

  const [signedIn, setSignedIn] = React.useState<boolean>(() => !!getJwt());
  const [walletLabel, setWalletLabel] = React.useState("");

  const [balances, setBalances] = React.useState<BalanceItem[]>([]);
  const [info, setInfo] = React.useState<BlackjackInfoResponse | null>(null);

  const [bet, setBet] = React.useState("0.25");
  const [lastBet, setLastBet] = React.useState("0.25");
  const [state, setState] = React.useState<BJState | null>(null);
  const [rawRound, setRawRound] = React.useState<BlackjackRoundView | null>(null);
  const [history, setHistory] = React.useState<BlackjackRoundView[]>([]);

  const [betModalOpen, setBetModalOpen] = React.useState(false);
  const [cashierOpen, setCashierOpen] = React.useState(false);

  const [turnToast, setTurnToast] = React.useState<ToastState>({ open: false, title: "" });
  const turnTimer = React.useRef<number | null>(null);

  const [overlay, setOverlay] = React.useState<CenterOverlayState>({ open: false, text: "", tone: "mid" });
  const overlayTimer = React.useRef<number | null>(null);

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

  const googleDesktopBtnRef = React.useRef<HTMLDivElement | null>(null);
  const googleMobileBtnRef = React.useRef<HTMLDivElement | null>(null);
  const googleClientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();

  const [dealReveal, setDealReveal] = React.useState<{
    active: boolean;
    playerCards: BJCard[];
    dealerCards: BJCard[];
    step: number;
    roundId: string;
  }>({
    active: false,
    playerCards: [],
    dealerCards: [],
    step: 0,
    roundId: "",
  });

  const dealTimersRef = React.useRef<number[]>([]);

  function clearDealTimers() {
    for (const t of dealTimersRef.current) window.clearTimeout(t);
    dealTimersRef.current = [];
  }

  React.useEffect(() => {
    return () => {
      clearDealTimers();
      if (turnTimer.current) window.clearTimeout(turnTimer.current);
      if (overlayTimer.current) window.clearTimeout(overlayTimer.current);
      if (resultTimer.current) window.clearTimeout(resultTimer.current);
    };
  }, []);

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

  function showCenterOverlay(next: Omit<CenterOverlayState, "open">, autoMs = 2000) {
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

  function decodeJwtSubLabel(token: string): string {
    try {
      const payload = token.split(".")[1];
      if (!payload) return "";
      const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      return String(json?.sub || "").trim();
    } catch {
      return "";
    }
  }

  function announceResolvedRound(round: BlackjackRoundView) {
    const mapped = roundToBjState(round);
    if (!mapped) return;

    const meta = outcomeMeta(mapped.outcome ?? round.status ?? null);

    if (meta.label === "CANCELLED") {
      showCenterOverlay({ text: "CANCELLED", tone: "mid" }, 2000);
    } else if (meta.tone === "good") {
      showCenterOverlay({ text: "YOU WIN", tone: "good" }, 2000);
    } else if (meta.tone === "bad") {
      showCenterOverlay({ text: "YOU LOSE", tone: "bad" }, 2000);
    } else {
      showCenterOverlay({ text: "PUSH", tone: "mid" }, 2000);
    }

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
        net: profitTone(mapped.profitHuman).text || "0",
        bet: mapped.totalBetHuman || mapped.betHuman || "",
      },
      2600
    );
  }

  function startDealReveal(round: BlackjackRoundView, onDone?: () => void) {
    clearDealTimers();

    const player = Array.isArray(round.playerCards) ? round.playerCards.map(mapRoundCard) : [];
    const dealer = Array.isArray(round.dealerCards) ? round.dealerCards.map(mapRoundCard) : [];

    setDealReveal({
      active: true,
      playerCards: [],
      dealerCards: [],
      step: 0,
      roundId: String(round.id || ""),
    });

    const t1 = window.setTimeout(() => {
      setDealReveal({
        active: true,
        playerCards: player[0] ? [player[0]] : [],
        dealerCards: [],
        step: 1,
        roundId: String(round.id || ""),
      });
    }, 120);

    const t2 = window.setTimeout(() => {
      setDealReveal({
        active: true,
        playerCards: player[0] ? [player[0]] : [],
        dealerCards: dealer[0] ? [dealer[0]] : [],
        step: 2,
        roundId: String(round.id || ""),
      });
    }, 300);

    const t3 = window.setTimeout(() => {
      setDealReveal({
        active: true,
        playerCards: player.slice(0, 2),
        dealerCards: dealer[0] ? [dealer[0], { r: "🂠", s: "" }] : [],
        step: 3,
        roundId: String(round.id || ""),
      });
    }, 500);

    const t4 = window.setTimeout(() => {
      setDealReveal({
        active: false,
        playerCards: [],
        dealerCards: [],
        step: 4,
        roundId: String(round.id || ""),
      });
      onDone?.();
    }, 760);

    dealTimersRef.current = [t1, t2, t3, t4];
  }

  async function loadBalancesAndInfo(activeJwt?: string) {
    const token = activeJwt || getJwt();
    if (!token) {
      setBalances([]);
      setInfo(null);
      return;
    }

    const [balRes, infoRes] = await Promise.all([
      apiRequest<any>(API_BASE, ME_BALANCES_PATH, token, { method: "GET" }),
      apiRequest<BlackjackInfoResponse>(API_BASE, BJ_INFO, token, {
        method: "POST",
        body: JSON.stringify({ chainId: TARGET_CHAIN_ID }),
      }),
    ]);

    setBalances(normalizeBalances(balRes));
    setInfo(infoRes || null);
  }

  async function loadCurrentAndHistory(activeJwt?: string) {
    const token = activeJwt || getJwt();
    if (!token) {
      setHistory([]);
      return;
    }

    const [cur, hist] = await Promise.all([
      apiRequest<BlackjackCurrentResponse>(API_BASE, `${BJ_CURRENT}?chainId=${TARGET_CHAIN_ID}`, token, {
        method: "GET",
      }),
      apiRequest<BlackjackHistoryResponse>(API_BASE, `${BJ_HISTORY}?chainId=${TARGET_CHAIN_ID}&limit=10`, token, {
        method: "GET",
      }),
    ]);

    const round = cur?.round || null;
    if (round) {
      setRawRound(round);
      setState(roundToBjState(round));
    }

    setHistory(Array.isArray(hist?.items) ? hist.items : []);
  }

  async function loadAll(activeJwt?: string) {
    const token = activeJwt || getJwt();
    if (!token) return;
    await Promise.all([loadBalancesAndInfo(token), loadCurrentAndHistory(token)]);
  }

  const renderGoogleButton = React.useCallback(
    (targetEl: HTMLDivElement | null) => {
      if (!API_BASE || !googleClientId || !window.google?.accounts?.id || signedIn || !targetEl) return;

      targetEl.innerHTML = "";

      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response: any) => {
          try {
            setGoogleBusy(true);
            setErr("");

            const out = await apiRequest<GoogleVerifyResponse>(API_BASE, AUTH_GOOGLE_VERIFY_PATH, "", {
              method: "POST",
              body: JSON.stringify({ idToken: response?.credential || "" }),
            });

            const tokenJwt = String(out?.token || out?.jwt || "").trim();

            if (!tokenJwt) {
              if (out?.linked === false) {
                setNeedsRegistration(true);
                setGoogleLinkEmail(String(out?.email || ""));
                setGoogleLinkName(String(out?.name || ""));
                setGoogleLinkSub(String(out?.googleSub || ""));
                setErr("No wallet is linked to this Google account yet.");
                showTurnToast(
                  {
                    open: true,
                    title: "Registration needed",
                    sub: "Open setup and link your wallet first.",
                  },
                  1800
                );
                return;
              }

              throw new Error("Missing JWT from Google verify");
            }

            setNeedsRegistration(false);
            setGoogleLinkEmail("");
            setGoogleLinkName("");
            setGoogleLinkSub("");

            setJwt(tokenJwt);
            setSignedIn(true);
            setWalletLabel(decodeJwtSubLabel(tokenJwt));
            await loadAll(tokenJwt);
            showTurnToast({ open: true, title: "✅ Signed in" }, 900);


          } catch (e: any) {
            const msg = String(e?.message || "Google sign-in failed.");
            setErr(msg);
            showTurnToast({ open: true, title: "❌ Sign in failed", sub: msg }, 1400);
          } finally {
            setGoogleBusy(false);
          }
        },
      });

      window.google.accounts.id.renderButton(targetEl, {
        theme: "outline",
        size: "large",
        shape: "pill",
        text: "continue_with",
        width: isMobile ? 260 : 300,
      });
    },
    [API_BASE, googleClientId, isMobile, signedIn]
  );

  React.useEffect(() => {
    if (signedIn || !googleClientId) return;

    const doRender = () => {
      if (googleDesktopBtnRef.current) renderGoogleButton(googleDesktopBtnRef.current);
      if (googleMobileBtnRef.current) renderGoogleButton(googleMobileBtnRef.current);
    };

    const existing = document.querySelector(
      'script[src="https://accounts.google.com/gsi/client"]'
    ) as HTMLScriptElement | null;

    if (existing) {
      const onLoad = () => setTimeout(doRender, 30);
      existing.addEventListener("load", onLoad);
      if (window.google?.accounts?.id) onLoad();
      return () => existing.removeEventListener("load", onLoad);
    }

    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => setTimeout(doRender, 30);
    document.head.appendChild(s);

    return () => {
      s.onload = null;
    };
  }, [signedIn, googleClientId, renderGoogleButton]);

  React.useEffect(() => {
    const token = getJwt();
    if (!token) return;
    setSignedIn(true);
    setWalletLabel(decodeJwtSubLabel(token));
    void loadAll(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function signOut() {
    clearJwt();
    setSignedIn(false);
    setWalletLabel("");
    setBalances([]);
    setInfo(null);
    setState(null);
    setRawRound(null);
    setHistory([]);
    setErr("");
    setNeedsRegistration(false);
    setGoogleLinkEmail("");
    setGoogleLinkName("");
    setGoogleLinkSub("");
    setCashierOpen(false);

    setCashierOpen(false);
    setOverlay((o) => ({ ...o, open: false }));
    setResultToast((t) => ({ ...t, open: false }));
    clearDealTimers();
    setDealReveal({
      active: false,
      playerCards: [],
      dealerCards: [],
      step: 0,
      roundId: "",
    });
    showTurnToast({ open: true, title: "Signed out" }, 800);
  }

  function openCashier() {
    try {
      window.open(CASHIER_URL, "_blank", "noopener,noreferrer");
    } catch {
      window.location.href = CASHIER_URL;
    }
  }

  async function startWithBet(betHuman: string) {
    setErr("");
    setActionBusy(true);
    try {
      const token = getJwt();
      if (!token) throw new Error("Sign in with Google first.");

      const b = clampBetHuman(betHuman);
      if (safeNumFromString(b) <= 0) throw new Error("Bet must be > 0");

      try {
        const out = await apiRequest<BlackjackStartResponse>(API_BASE, BJ_START, token, {
          method: "POST",
          body: JSON.stringify({
            chainId: TARGET_CHAIN_ID,
            betHuman: b,
            clientRequestId: `web-bj:${Date.now()}`,
          }),
        });

        const nextRound = out?.round || null;
        if (nextRound) {
          setLastBet(b);
          setRawRound(nextRound);

          startDealReveal(nextRound, () => {
            setState(roundToBjState(nextRound));

            if (isResolvedRoundStatus(nextRound.status)) {
              announceResolvedRound(nextRound);
            } else {
              showTurnToast({ open: true, title: "🎴 Dealt", sub: "Your turn" }, 800);
            }
          });
        }
      } catch (e: any) {
        const msg = String(e?.message || e || "");
        if (msg === "ROUND_ALREADY_ACTIVE") {
          await loadCurrentAndHistory(token);
          showTurnToast({ open: true, title: "🃏 Active hand loaded" }, 1000);
          return;
        }
        throw e;
      }

      await loadBalancesAndInfo(token);
      await loadCurrentAndHistory(token);
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
    if (!rawRound) return;

    setErr("");
    setActionBusy(true);
    try {
      const token = getJwt();
      if (!token) throw new Error("Sign in with Google first.");

      const out = await apiRequest<{ ok?: boolean; round: BlackjackRoundView }>(API_BASE, path, token, {
        method: "POST",
        body: JSON.stringify({ chainId: TARGET_CHAIN_ID }),
      });

      const nextRound = out?.round || null;
      if (nextRound) {
        setRawRound(nextRound);
        setState(roundToBjState(nextRound));
      }

      if (nextRound && isResolvedRoundStatus(nextRound.status)) {
        await loadBalancesAndInfo(token);
      }
      await loadCurrentAndHistory(token);
    } catch (e: any) {
      const msg = String(e?.message || e);
      setErr(msg);
      showTurnToast({ open: true, title: "❌ Action failed", sub: msg }, 1400);
    } finally {
      setActionBusy(false);
    }
  }

  async function refreshSilent() {
    if (!rawRound) return;

    try {
      const token = getJwt();
      if (!token) return;

      const out = await apiRequest<BlackjackCurrentResponse>(API_BASE, `${BJ_CURRENT}?chainId=${TARGET_CHAIN_ID}`, token, {
        method: "GET",
      });

      const round = out?.round || null;
      if (round) {
        setRawRound(round);
        setState(roundToBjState(round));
        if (isResolvedRoundStatus(round.status)) {
          await loadBalancesAndInfo(token);
        }
      }

      const hist = await apiRequest<BlackjackHistoryResponse>(API_BASE, `${BJ_HISTORY}?chainId=${TARGET_CHAIN_ID}&limit=10`, token, {
        method: "GET",
      });
      setHistory(Array.isArray(hist?.items) ? hist.items : []);
    } catch {
      // silent
    }
  }

  React.useEffect(() => {
    const cur = stateRef.current;
    if (!cur) return;
    if (cur.status !== "ACTIVE" && cur.status !== "DEALER_TURN") return;

    const tick = () => {
      if (actionBusy) return;
      void refreshSilent();
    };

    const t = window.setInterval(tick, cur.status === "DEALER_TURN" ? 800 : 1400);
    return () => window.clearInterval(t);
  }, [actionBusy, state?.status, state?.gameId]);

  const prevStatusRef = React.useRef<BJState["status"] | null>(null);
  const prevGameIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const st = state;
    if (!st) return;
    if (dealReveal.active) return;

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

      if (meta.label === "CANCELLED") {
        showCenterOverlay({ text: "CANCELLED", tone: "mid" }, 2000);
      } else if (meta.tone === "good") {
        showCenterOverlay({ text: "YOU WIN", tone: "good" }, 2000);
      } else if (meta.tone === "bad") {
        showCenterOverlay({ text: "YOU LOSE", tone: "bad" }, 2000);
      } else {
        showCenterOverlay({ text: "PUSH", tone: "mid" }, 2000);
      }

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
  }, [state, dealReveal.active]);

  /** ===== Critical fix: enrich balances with tokenlist names/decimals and then force USDC selection ===== */
  const balanceRows = React.useMemo<TokenOption[]>(() => {
    return balances
      .filter((b) => Number(b.chainId) === TARGET_CHAIN_ID)
      .map((b) => {
        const token = String(b.token || "").toLowerCase();
        const meta = tokenMetaByChainAddr.get(`${Number(b.chainId)}:${token}`);
        const rawSymbol = String(b.symbol || meta?.symbol || "").toUpperCase();
        const symbol = rawSymbol || "TOKEN";

        const decimals =
          symbol === "USDC"
            ? 6
            : Number.isFinite(Number(meta?.decimals))
              ? Number(meta?.decimals)
              : Number.isFinite(Number(b.decimals))
                ? Number(b.decimals)
                : 18;

        const avail = String(b.availableRaw ?? b.balanceRaw ?? b.totalRaw ?? "0");

        return {
          key: `${b.chainId}:${token}`,
          token,
          symbol,
          decimals,
          availableRaw: avail,
          heldRaw: String(b.heldRaw ?? "0"),
          availableHuman:
            typeof b.balanceHuman === "string" && b.balanceHuman.trim() && symbol !== "USDC"
              ? b.balanceHuman.trim()
              : formatAmount(avail, decimals, 6),
        };
      })
      .sort((a, b) => {
        if (a.symbol === "USDC" && b.symbol !== "USDC") return -1;
        if (b.symbol === "USDC" && a.symbol !== "USDC") return 1;
        if (safeBigInt(b.availableRaw) > safeBigInt(a.availableRaw)) return 1;
        if (safeBigInt(b.availableRaw) < safeBigInt(a.availableRaw)) return -1;
        return 0;
      });
  }, [balances, tokenMetaByChainAddr]);

  const selectedBalance = React.useMemo<TokenOption | null>(() => {
    if (!balanceRows.length) return null;

    const infoToken = String(info?.token || "").toLowerCase();
    const infoSymbol = String(info?.symbol || "").toUpperCase();

    return (
      balanceRows.find((x) => x.token === infoToken) ||
      balanceRows.find((x) => x.symbol === "USDC") ||
      balanceRows.find((x) => x.symbol === infoSymbol) ||
      null
    );
  }, [balanceRows, info]);

  const visibleCreditRows = React.useMemo(() => {
    if (!selectedBalance) return [];
    return [selectedBalance];
  }, [selectedBalance]);

  const creditsLabel = selectedBalance?.availableHuman || "0";
  const creditsSymbol = selectedBalance?.symbol || "USDC";

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
  const dealerCardW = clamp(Math.round(dealerCardH * 0.7), isMobile ? 52 : 58, isWide ? 84 : 72);

  const playerCardH = clamp(
    Math.round(playerH * (hasMultiHands ? 0.42 : 0.52)),
    isMobile ? 68 : 78,
    isWide ? 116 : 100
  );
  const playerCardW = clamp(Math.round(playerCardH * 0.7), isMobile ? 50 : 58, isWide ? 82 : 70);

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

  const dealerCards: BJCard[] = dealReveal.active
    ? dealReveal.dealerCards
    : state?.dealer && state.dealer.length
      ? state.dealer
      : state?.dealerUp?.length
        ? state.dealerUp
        : [];

  const dealerTotal = dealReveal.active
    ? computeHandTotal(dealReveal.dealerCards.filter((c) => c.r !== "🂠"))
    : isActive
      ? state?.dealerUpTotal ?? computeHandTotal(state?.dealerUp || [])
      : isDealerTurn
        ? typeof state?.dealerVisibleTotal === "number"
          ? state.dealerVisibleTotal
          : computeHandTotal(dealerCards)
        : typeof state?.dealerTotal === "number"
          ? state.dealerTotal
          : computeHandTotal(dealerCards);

  const activeHandTotal = dealReveal.active
    ? computeHandTotal(dealReveal.playerCards)
    : state && state.playerHands?.length
      ? state.handTotals?.[state.activeHand] ?? computeHandTotal(state.playerHands[state.activeHand] || [])
      : 0;

  const betVal = safeNumFromString(clampBetHuman(bet));
  const canPlay = signedIn && !!selectedBalance;
  const canDeal = !actionBusy && canPlay && !(state?.status === "ACTIVE" || state?.status === "DEALER_TURN");
  const betLocked = !!state && (state.status === "ACTIVE" || state.status === "DEALER_TURN");

  const headerBetLabel = `Bet ${state?.totalBetHuman ? state.totalBetHuman : clampBetHuman(bet)}`;
  const BTN_H = isMobile ? 44 : 46;

  const mode: "ACTIVE" | "DEALER" | "END" | "IDLE" =
    state?.status === "ACTIVE"
      ? "ACTIVE"
      : state?.status === "DEALER_TURN"
        ? "DEALER"
        : state?.status === "RESOLVED" || state?.status === "CANCELLED"
          ? "END"
          : "IDLE";

  const canShowHit = mode === "ACTIVE" && !!state?.canHit && !actionBusy;
  const canShowStand = mode === "ACTIVE" && !!state?.canStand && !actionBusy;
  const canShowDouble = mode === "ACTIVE" && !!state?.canDouble && !actionBusy;
  const canShowSplit = false;

  const canShowBet = (mode === "IDLE" || mode === "END") && signedIn && !betLocked && !actionBusy;
  const canShowDeal = (mode === "IDLE" || mode === "END") && canDeal;

  const betNow = clampBetHuman(bet);
  const rebetDisabled = betNow !== clampBetHuman(lastBet);
  const canShowRebet = (mode === "IDLE" || mode === "END") && signedIn && !actionBusy;

  const toastW = clamp(Math.floor(contentW - 18), 220, 360);
  const toastTop = clamp((headerH || 54) + 8, 56, 92);

  const resultToastW = clamp(Math.floor(contentW - 18), 260, 520);
  const resultToastBottom = Math.floor(dockH + 18 + 10);

  const dealerGlow = isDealerTurn
    ? {
        borderColor: UI.borderStrong,
        boxShadow: "0 0 0 2px rgba(255,200,0,0.22), 0 18px 40px rgba(0,0,0,0.30)",
        background: "rgba(255,200,0,0.06)",
      }
    : {};

  const playerGlow = isActive || dealReveal.active
    ? {
        borderColor: UI.borderStrong,
        boxShadow: "0 0 0 2px rgba(255,200,0,0.22), 0 18px 40px rgba(0,0,0,0.30)",
        background: "rgba(255,200,0,0.06)",
      }
    : {};

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
      <TurnToast
        toast={turnToast}
        onClose={() => setTurnToast((t) => ({ ...t, open: false }))}
        widthPx={toastW}
        topPx={toastTop}
      />

      <CenterResultOverlay overlay={overlay} />

      <ResultToastOverlay
        toast={resultToast}
        onClose={() => setResultToast((t) => ({ ...t, open: false }))}
        widthPx={resultToastW}
        bottomPx={resultToastBottom}
      />

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
              {walletLabel ? (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${walletLabel.slice(0, 6)}…${walletLabel.slice(-4)}`}
                  sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 900 }}
                />
              ) : null}

              <Chip
                size="small"
                variant="outlined"
                label={`🪙 ${creditsLabel} ${creditsSymbol}`}
                sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
              />

              <Chip
                size="small"
                variant="outlined"
                label={`Fuji ${TARGET_CHAIN_ID}`}
                sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 900 }}
              />

              {actionBusy || googleBusy ? <CircularProgress size={20} /> : null}
            </Box>

            <Box sx={{ display: "flex", gap: 1, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Chip
                size="small"
                variant="outlined"
                label={
                  dealReveal.active
                    ? "Dealing"
                    : state?.status
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

          <Box
            sx={{
              flex: "1 1 auto",
              overflow: "hidden",
              px: isMobile ? 1.0 : 1.4,
              pb: isMobile ? 1.0 : 1.4,
              minHeight: 0,
            }}
          >
            {!signedIn ? (
              <Paper
                variant="outlined"
                sx={{
                  height: `${tableH}px`,
                  p: isMobile ? 1.0 : 1.4,
                  borderRadius: 4,
                  background:
                    "radial-gradient(900px 520px at 50% 0%, rgba(0,255,160,0.09), transparent 60%), rgba(0,0,0,0.22)",
                  borderColor: UI.border,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "auto",
                }}
              >
                <Stack
                  spacing={1.5}
                  sx={{
                    width: "100%",
                    maxWidth: 420,
                    alignItems: "center",
                    textAlign: "center",
                  }}
                >
                  <Typography sx={{ color: UI.textMain, fontSize: 26, fontWeight: 1100 }}>
                    🃏 The Haus Blackjack
                  </Typography>

                  <Typography sx={{ color: UI.textDim, fontWeight: 900 }}>
                    Sign in with the Google account linked to your cashier wallet.
                  </Typography>

                  <Box
                    sx={{
                      minHeight: 48,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div ref={googleDesktopBtnRef} />
                  </Box>

                  {googleBusy ? <CircularProgress size={22} /> : null}

                  {err ? (
                    <Typography sx={{ color: UI.bad, fontSize: 13, fontWeight: 900 }}>
                      {err}
                    </Typography>
                  ) : null}

                  {needsRegistration ? (
                    <Stack spacing={1} sx={{ width: "100%", maxWidth: 420, mt: 1 }}>
                      <Typography sx={{ color: UI.textDim, fontSize: 13, fontWeight: 900, textAlign: "center" }}>
                        No wallet is linked to this Google account yet.
                      </Typography>

                      <UnregisteredGoogleRegisterButton
                        label="Register Wallet"
                        fullWidth
                        googleEmail={googleLinkEmail}
                        googleName={googleLinkName}
                        googleSub={googleLinkSub}
                        onCopied={() => showTurnToast({ open: true, title: "Link copied" }, 900)}
                      />
                    </Stack>
                  ) : null}
                </Stack>
              </Paper>
            ) : (
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
                    <Fan
                      cards={dealReveal.active ? dealReveal.dealerCards : dealerCards}
                      forceHoleCard={dealReveal.active ? dealReveal.step >= 3 : !!isActive}
                      dims={dealerDims}
                      maxWidth={contentW - 28}
                    />
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
                      Player {isActive || dealReveal.active ? "• TURN" : ""}
                    </Typography>
                    {(state || dealReveal.active) ? (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`TOTAL ${dealReveal.active ? computeHandTotal(dealReveal.playerCards) : activeHandTotal}`}
                        sx={{ fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
                      />
                    ) : (
                      <Chip size="small" variant="outlined" label="No hand" sx={{ color: UI.textMain, borderColor: UI.border }} />
                    )}
                  </Box>

                  {!state && !dealReveal.active ? (
                    <Box sx={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Typography sx={{ color: UI.textDim, fontWeight: 900 }}>
                        Set bet → <span style={{ color: UI.textMain }}>Deal</span>
                      </Typography>
                    </Box>
                  ) : dealReveal.active ? (
                    <Box sx={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
                      <Paper
                        variant="outlined"
                        sx={{
                          flex: "0 1 100%",
                          p: 0.9,
                          borderRadius: 3,
                          borderWidth: 2,
                          borderColor: UI.borderStrong,
                          background: "rgba(255,200,0,0.08)",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "center",
                          overflow: "hidden",
                          minWidth: 0,
                          height: "100%",
                        }}
                      >
                        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.6 }}>
                          <Box />
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`${computeHandTotal(dealReveal.playerCards)}`}
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
                          <Fan cards={dealReveal.playerCards} dims={playerDims} maxWidth={contentW - 30} />
                        </Box>
                      </Paper>
                    </Box>
                  ) : (
                    <Box sx={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
                      <Stack
                        direction={stackHands ? "column" : "row"}
                        spacing={1.0}
                        sx={{ height: "100%", alignItems: "stretch", justifyContent: "center" }}
                      >
                        {state!.playerHands.map((hand, idx) => {
                          const isActiveHand = state!.status === "ACTIVE" && idx === state!.activeHand;
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
                                  label={`${state!.handTotals?.[idx] ?? computeHandTotal(hand)}`}
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
            )}
          </Box>
        </Box>
      </Box>

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
            <Box
              sx={{
                borderRadius: 3,
                border: `1px solid ${UI.border}`,
                background: "rgba(255,255,255,0.03)",
                p: isMobile ? 0.9 : 1.0,
              }}
            >
              <Stack direction="row" spacing={1} sx={{ width: "100%" }}>
                <Slot show={mode === "ACTIVE" ? canShowHit : mode === "END" || mode === "IDLE" ? canShowDeal : false} h={46}>
                  <ActionBtn
                    h={46}
                    onClick={() => {
                      if (mode === "ACTIVE") void act(BJ_HIT);
                      else void start();
                    }}
                    variant="contained"
                    color={mode === "ACTIVE" ? "success" : undefined}
                    disabled={!signedIn || googleBusy || !selectedBalance || dealReveal.active}
                  >
                    {mode === "ACTIVE" ? "👆 HIT" : "🎴 Deal"}
                  </ActionBtn>
                </Slot>

                <Slot show={mode === "ACTIVE" ? canShowStand : mode === "END" || mode === "IDLE" ? canShowBet : false} h={46}>
                  <ActionBtn
                    h={46}
                    onClick={() => {
                      if (mode === "ACTIVE") void act(BJ_STAND);
                      else setBetModalOpen(true);
                    }}
                    variant={mode === "ACTIVE" ? "contained" : "outlined"}
                    color={mode === "ACTIVE" ? "error" : undefined}
                    outlined={mode !== "ACTIVE"}
                    disabled={mode !== "ACTIVE" ? !signedIn || googleBusy : dealReveal.active}
                  >
                    {mode === "ACTIVE" ? "✋ STAND" : "🪙 Bet"}
                  </ActionBtn>
                </Slot>
              </Stack>

              <Stack direction="row" spacing={1} sx={{ width: "100%", mt: 1 }}>
                <Slot show={mode === "ACTIVE" ? canShowDouble : mode === "END" || mode === "IDLE" ? canShowRebet : false} h={46}>
                  <ActionBtn
                    h={46}
                    onClick={() => {
                      if (mode === "ACTIVE") void act(BJ_DOUBLE);
                      else void startWithBet(lastBet);
                    }}
                    variant={mode === "ACTIVE" ? "outlined" : "contained"}
                    outlined={mode === "ACTIVE"}
                    disabled={mode !== "ACTIVE" ? rebetDisabled || !signedIn || googleBusy || !selectedBalance : dealReveal.active}
                  >
                    {mode === "ACTIVE" ? "⏫ Double" : "🔁 Rebet"}
                  </ActionBtn>
                </Slot>

                <Slot show={mode === "ACTIVE" ? canShowSplit : true} h={46}>
                  {!signedIn ? (
                    <ActionBtn
                      h={46}
                      onClick={() => {
                        const target =
                          (isMobile ? googleMobileBtnRef.current : googleDesktopBtnRef.current) ||
                          googleDesktopBtnRef.current ||
                          googleMobileBtnRef.current;
                        const clickable = target?.querySelector("div[role='button'], iframe") as HTMLElement | null;
                        clickable?.click?.();
                      }}
                      variant="contained"
                      disabled={googleBusy}
                    >
                      Sign In
                    </ActionBtn>
                  ) : (
                    <ActionBtn
                      h={46}
                      onClick={() => setCashierOpen(true)}
                      variant="outlined"
                      outlined
                    >
                      💰 Cashier
                    </ActionBtn>
                  )}
                </Slot>
              </Stack>
            </Box>

            {err ? <Typography sx={{ color: UI.bad, fontSize: 12, fontWeight: 900, mt: 0.2 }}>{err}</Typography> : null}

            {(mode === "END" || mode === "IDLE") && canShowRebet && rebetDisabled ? (
              <Typography sx={{ color: UI.textFaint, fontSize: 12, fontWeight: 900 }}>
                🔁 Rebet is locked — set bet back to {clampBetHuman(lastBet)} to rebet.
              </Typography>
            ) : null}
          </Stack>
        </Paper>
      </Box>

      <ModalShell
        open={betModalOpen}
        title="Set your bet"
        onClose={() => setBetModalOpen(false)}
        actions={
          <Button onClick={() => setBetModalOpen(false)} sx={{ color: UI.textMain, fontWeight: 900 }}>
            Close
          </Button>
        }
      >
        <Typography sx={{ color: UI.textDim, mb: 1 }}>Choose chips ({creditsSymbol}):</Typography>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {[0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50].map((v) => (
            <Button
              key={v}
              variant="outlined"
              onClick={() => setBet(clampBetHuman(String(v)))}
              sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
            >
              {v} {creditsSymbol}
            </Button>
          ))}
        </Stack>

        <Divider sx={{ my: 2, borderColor: UI.border, opacity: 0.6 }} />

        <Typography sx={{ color: UI.textDim, mb: 1 }}>Fine tune:</Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            variant="outlined"
            onClick={() => setBet(clampBetHuman(String(Math.max(0, betVal - 0.1))))}
            sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
          >
            -0.1
          </Button>
          <Button
            variant="outlined"
            onClick={() => setBet(clampBetHuman(String(betVal + 0.1)))}
            sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
          >
            +0.1
          </Button>
          <Button
            variant="outlined"
            onClick={() => setBet(clampBetHuman(String(betVal + 0.5)))}
            sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
          >
            +0.5
          </Button>
          <Button
            variant="outlined"
            onClick={() => setBet(clampBetHuman(String(betVal + 1)))}
            sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
          >
            +1
          </Button>
          <Button
            variant="outlined"
            onClick={() => setBet(selectedBalance?.availableHuman || "0")}
            sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}
            disabled={!selectedBalance}
          >
            MAX
          </Button>
        </Stack>

        <Divider sx={{ my: 2, borderColor: UI.border, opacity: 0.6 }} />
        <Typography sx={{ color: UI.textMain, fontWeight: 990 }}>
          Current bet: {clampBetHuman(bet)} {creditsSymbol}
        </Typography>
        <Typography sx={{ color: UI.textFaint, fontSize: 12, mt: 0.7 }}>
          Available: {creditsLabel} {creditsSymbol}
        </Typography>
      </ModalShell>

      <ModalShell
        open={cashierOpen}
        title="Cashier"
        onClose={() => setCashierOpen(false)}
        actions={
          <Stack direction="row" spacing={1} sx={{ width: "100%", justifyContent: "space-between" }}>
            <Button onClick={() => setCashierOpen(false)} sx={{ color: UI.textMain, fontWeight: 900 }}>
              Close
            </Button>

            {!signedIn ? (
              <Button
                variant="contained"
                onClick={() => {
                  const target = googleDesktopBtnRef.current || googleMobileBtnRef.current;
                  const clickable = target?.querySelector("div[role='button'], iframe") as HTMLElement | null;
                  clickable?.click?.();
                }}
                sx={{ fontWeight: 950 }}
              >
                Sign In
              </Button>
            ) : (
              <Stack direction="row" spacing={1}>
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
                <Button
                  onClick={openCashier}
                  variant="contained"
                  disabled={actionBusy}
                  sx={{ borderRadius: 2, fontWeight: 950 }}
                >
                  Open Cashier
                </Button>
              </Stack>
            )}
          </Stack>
        }
      >
        {!signedIn ? (
          <Stack spacing={1.2}>
            <Typography sx={{ color: UI.textMain, fontWeight: 950 }}>
              Sign in with Google to view your cashier balance and play blackjack.
            </Typography>
            <Typography sx={{ color: UI.textDim, fontSize: 13 }}>
              Use the same Google account already linked to your wallet-backed cashier account.
            </Typography>
          </Stack>
        ) : (
          <Stack spacing={1.2}>
            <Paper
              variant="outlined"
              sx={{
                p: 1.4,
                borderRadius: 2,
                borderColor: UI.border,
                background: "rgba(255,255,255,0.05)",
              }}
            >
              <Typography sx={{ fontWeight: 990, color: UI.textMain }}>💰 Haus Cashier Balance</Typography>
              <Typography sx={{ color: UI.textDim, fontSize: 20, fontWeight: 950, mt: 0.2 }}>
                {creditsLabel} {creditsSymbol}
              </Typography>

              <Divider sx={{ my: 1.1, borderColor: UI.border, opacity: 0.6 }} />

              <Typography sx={{ color: UI.textFaint, fontSize: 12 }}>
                Wallet: {walletLabel ? `${walletLabel.slice(0, 6)}…${walletLabel.slice(-4)}` : "—"}
              </Typography>

              <Typography sx={{ color: UI.textFaint, fontSize: 12, mt: 0.4 }}>
                Treasury: {info?.treasuryId || "blackjack-43113-usdc"}
              </Typography>
            </Paper>

            {visibleCreditRows.length ? (
              <Paper
                variant="outlined"
                sx={{
                  p: 1.2,
                  borderRadius: 2,
                  borderColor: UI.border,
                  background: "rgba(255,255,255,0.04)",
                }}
              >
                <Typography sx={{ fontWeight: 950, color: UI.textMain, mb: 0.8 }}>Linked cashier credits</Typography>
                <Stack spacing={0.8}>
                  {visibleCreditRows.map((b) => (
                    <Box
                      key={b.key}
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        border: `1px solid ${UI.border}`,
                        borderRadius: 2,
                        px: 1.2,
                        py: 0.9,
                        background: "rgba(255,255,255,0.08)",
                      }}
                    >
                      <Typography sx={{ color: UI.textMain, fontWeight: 900 }}>
                        {b.symbol}
                      </Typography>
                      <Typography sx={{ color: UI.textDim, fontWeight: 900 }}>
                        {b.availableHuman}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </Paper>
            ) : null}

            <Paper
              variant="outlined"
              sx={{
                p: 1.2,
                borderRadius: 2,
                borderColor: UI.border,
                background: "rgba(0,0,0,0.22)",
              }}
            >
              <Typography sx={{ fontWeight: 950, color: UI.textMain }}>Open cashier</Typography>
              <Typography sx={{ color: UI.textDim, fontSize: 13, mt: 0.2 }}>
                Deposit, manage balances, and use the rest of the Haus cashier app.
              </Typography>

              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1.1 }}>
                <Button
                  variant="contained"
                  onClick={openCashier}
                  sx={{ borderRadius: 2, fontWeight: 950 }}
                  disabled={actionBusy}
                  fullWidth
                >
                  🌐 Open Cashier
                </Button>

                <Button
                  variant="outlined"
                  onClick={() => {
                    void loadAll();
                  }}
                  sx={{ borderRadius: 2, fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
                  disabled={actionBusy}
                  fullWidth
                >
                  🔄 Refresh
                </Button>
              </Stack>

              <Typography sx={{ color: UI.textFaint, fontSize: 12, mt: 0.9 }}>
                Cashier: {CASHIER_URL}
              </Typography>
            </Paper>
          </Stack>
        )}
      </ModalShell>
      <UnregisteredGooglePrompt
        open={needsRegistration}
        onClose={() => setNeedsRegistration(false)}
        googleEmail={googleLinkEmail}
        googleName={googleLinkName}
        googleSub={googleLinkSub}
        onCopied={() => showTurnToast({ open: true, title: "Link copied" }, 900)}
      />      
    </Box>
  );
}
