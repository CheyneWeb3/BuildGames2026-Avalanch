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
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useApiBase } from "../../ApiBaseContext";

declare global {
  interface Window {
    Telegram?: any;
  }
}

const AUTH_TG_PATH = "/auth/tg";
const ME_BALANCES_PATH = "/mini/me/balances";

// Whack endpoints (adjust if your API uses different names)
const WH_STATUS = "/mini/whack/status";
const WH_START = "/mini/whack/start";     // { betHuman, hole }
const WH_PICK = "/mini/whack/pick";       // { gameId, hole } (optional; if your start also picks, you can ignore)
const WH_COLLECT = "/mini/whack/collect"; // { gameId }
const WH_TRY5X = "/mini/whack/try5x";     // { gameId }
const WH_CANCEL = "/mini/whack/cancel";   // { gameId } (optional)

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

// Keep this flexible. Your server can return more fields; we’ll render what exists.
type WhackState = {
  ok?: boolean;

  gameId?: string | null;

  // Phase/state machine (you can rename server-side; these are typical)
  phase?: "IDLE" | "PICKING" | "STAGE1_RESULT" | "STAGE2_PROMPT" | "RESOLVED" | "CANCELLED";

  // UI config
  quickBets?: number[];
  minBetHuman?: string;
  maxBetHuman?: string;

  // Content
  imageUrl?: string;
  caption?: string;
  message?: string;

  // Last action/result (optional)
  lastHole?: number;
  lastOutcome?: "WIN" | "LOSE" | "MISS" | "HIT_NORMAL" | "HIT_GOLD" | "HIT_BOTH" | string;
  stage1WinHuman?: string;
  stage2WinHuman?: string;
  profitHuman?: string;

  // server can include “canCollect/canTry5x” flags too
  canCollect?: boolean;
  canTry5x?: boolean;

  updatedAtMs?: number;
};

function getTelegramInitData(): string {
  const tg = window.Telegram?.WebApp;
  return String(tg?.initData || "").trim();
}

function isTelegramWebApp(): boolean {
  return !!window.Telegram?.WebApp;
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

// ---------- UI ----------
const UI = {
  textMain: "rgba(240,247,255,0.94)",
  textDim: "rgba(240,247,255,0.72)",
  textFaint: "rgba(240,247,255,0.52)",
  border: "rgba(255,255,255,0.14)",
  borderStrong: "rgba(255,200,0,0.62)",
  panelBg: "rgba(0,0,0,0.22)",
  panelBg2: "rgba(255,255,255,0.04)",
  feltBg:
    "radial-gradient(1200px 700px at 20% 0%, rgba(255,200,0,0.12), transparent 55%), radial-gradient(900px 600px at 80% 0%, rgba(0,255,200,0.10), transparent 55%), rgba(10,12,18,0.62)",
};

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

type Hole = { id: number; x: number; y: number; r: number };

export default function WhackCanvasPage() {
  const API_BASE = useApiBase();
  const isWide = useMediaQuery("(min-width:900px)");
  const isMobile = useMediaQuery("(max-width:600px)");

  // IMPORTANT: actionBusy disables actions; polling should not flicker the UI.
  const [actionBusy, setActionBusy] = React.useState(false);
  const [pollBusy, setPollBusy] = React.useState(false);

  const [err, setErr] = React.useState<string>("");
  const [tgLabel, setTgLabel] = React.useState<string>("");

  const [signedIn, setSignedIn] = React.useState<boolean>(() => !!getSession());
  const [bal, setBal] = React.useState<MiniBalances | null>(null);

  const [bet, setBet] = React.useState("10");
  const [lastBet, setLastBet] = React.useState("10");

  const [state, setState] = React.useState<WhackState | null>(null);
  const stateRef = React.useRef<WhackState | null>(null);

  const [betModalOpen, setBetModalOpen] = React.useState(false);
  const [cashierOpen, setCashierOpen] = React.useState(false);

  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const holesRef = React.useRef<Hole[]>([]);
  const [selectedHole, setSelectedHole] = React.useState<number | null>(null);

  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Telegram UX (same idea as blackjack page)
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
      setErr(msg);
      throw new Error("Missing Telegram initData");
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

  async function loadBalances(sess?: string) {
    const s = sess || getSession();
    if (!s) return;

    const out = await apiJson<MiniBalances>(API_BASE, ME_BALANCES_PATH, {
      method: "GET",
      headers: { "x-session": s },
    });

    if (!out?.ok) throw new Error(out?.error || "Bad balances response");
    setBal(out);
  }

  async function signIn() {
    setErr("");
    setActionBusy(true);
    try {
      const s = await ensureAuth();
      await loadBalances(s);
      await refreshStatusSilent(s);
    } catch (e: any) {
      setErr(String(e?.message || e));
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
  }

  // auto sign in if in Telegram and already has session / can auth
  React.useEffect(() => {
    if (!isTelegramWebApp()) return;
    (async () => {
      try {
        if (getSession()) {
          setSignedIn(true);
          await loadBalances();
          await refreshStatusSilent();
          return;
        }
        const s = await ensureAuth();
        await loadBalances(s);
        await refreshStatusSilent(s);
      } catch {
        // show Sign In button
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshStatusSilent(sess?: string) {
    try {
      const s = sess || (signedIn ? await ensureAuth() : "");
      if (!s) return;

      const out = await apiJson<WhackState>(API_BASE, WH_STATUS, {
        method: "GET",
        headers: { "x-session": s },
      });

      setState(out);
    } catch {
      // silent
    }
  }

  async function refreshManual() {
    setPollBusy(true);
    try {
      await refreshStatusSilent();
    } finally {
      window.setTimeout(() => setPollBusy(false), 180);
    }
  }

  // polling while game is active-ish
  React.useEffect(() => {
    const cur = stateRef.current;
    const phase = cur?.phase;
    if (!cur) return;

    const shouldPoll =
      phase === "PICKING" ||
      phase === "STAGE1_RESULT" ||
      phase === "STAGE2_PROMPT";

    if (!shouldPoll) return;

    const t = window.setInterval(() => {
      if (actionBusy) return;
      void refreshStatusSilent();
    }, 1200);

    return () => window.clearInterval(t);
  }, [actionBusy, state?.phase, state?.gameId]);

  const canPlay = signedIn && !bal?.railsPaused;

  // ---------- Actions ----------
  async function startOrPick(hole: number) {
    setErr("");
    setActionBusy(true);
    try {
      const s = await ensureAuth();
      if (bal?.railsPaused) throw new Error("Rails are paused. Movement actions are disabled.");

      const betHuman = clampBetHuman(bet);
      if (safeNumFromString(betHuman) <= 0) throw new Error("Bet must be > 0");

      const cur = stateRef.current;
      // If there is a gameId and your server wants /pick, use it; otherwise /start is enough.
      const hasGame = !!cur?.gameId;

      const out = hasGame
        ? await apiJson<WhackState>(API_BASE, WH_PICK, {
            method: "POST",
            headers: { "x-session": s },
            body: JSON.stringify({ gameId: cur?.gameId, hole }),
          })
        : await apiJson<WhackState>(API_BASE, WH_START, {
            method: "POST",
            headers: { "x-session": s },
            body: JSON.stringify({ betHuman, hole }),
          });

      setState(out);
      setLastBet(betHuman);

      // balance likely changed on start/pick
      await loadBalances(s);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setActionBusy(false);
    }
  }

  async function collect() {
    const cur = stateRef.current;
    if (!cur?.gameId) return;

    setErr("");
    setActionBusy(true);
    try {
      const s = await ensureAuth();
      const out = await apiJson<WhackState>(API_BASE, WH_COLLECT, {
        method: "POST",
        headers: { "x-session": s },
        body: JSON.stringify({ gameId: cur.gameId }),
      });
      setState(out);
      await loadBalances(s);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setActionBusy(false);
    }
  }

  async function try5x() {
    const cur = stateRef.current;
    if (!cur?.gameId) return;

    setErr("");
    setActionBusy(true);
    try {
      const s = await ensureAuth();
      const out = await apiJson<WhackState>(API_BASE, WH_TRY5X, {
        method: "POST",
        headers: { "x-session": s },
        body: JSON.stringify({ gameId: cur.gameId }),
      });
      setState(out);
      await loadBalances(s);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setActionBusy(false);
    }
  }

  async function cancel() {
    const cur = stateRef.current;
    if (!cur?.gameId) return;

    setErr("");
    setActionBusy(true);
    try {
      const s = await ensureAuth();
      const out = await apiJson<WhackState>(API_BASE, WH_CANCEL, {
        method: "POST",
        headers: { "x-session": s },
        body: JSON.stringify({ gameId: cur.gameId }),
      });
      setState(out);
      await loadBalances(s);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setActionBusy(false);
    }
  }

  // ---------- Canvas render ----------
  function computeHoles(w: number, h: number): Hole[] {
    const pad = 18;
    const topHudH = isMobile ? 96 : 104;
    const bottomDockH = isMobile ? 152 : 150;

    const usableH = h - topHudH - bottomDockH;
    const gridH = Math.min(360, Math.max(240, usableH));
    const gridW = w - pad * 2;

    const cols = 3;
    const rows = 2;
    const cellW = gridW / cols;
    const cellH = gridH / rows;
    const r = Math.min(cellW, cellH) * (isMobile ? 0.26 : 0.28);

    const startY = topHudH + Math.max(12, (usableH - gridH) * 0.25);

    const holes: Hole[] = [];
    let id = 1;
    for (let ry = 0; ry < rows; ry++) {
      for (let cx = 0; cx < cols; cx++) {
        holes.push({
          id,
          x: pad + cx * cellW + cellW / 2,
          y: startY + ry * cellH + cellH / 2,
          r,
        });
        id++;
      }
    }
    return holes;
  }

  function drawCanvas() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const cssW = c.clientWidth;
    const cssH = c.clientHeight;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const pxW = Math.floor(cssW * dpr);
    const pxH = Math.floor(cssH * dpr);

    if (c.width !== pxW || c.height !== pxH) {
      c.width = pxW;
      c.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // background
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#0b0b0f";
    ctx.fillRect(0, 0, cssW, cssH);

    // subtle glow
    const grad = ctx.createRadialGradient(cssW * 0.5, 0, 0, cssW * 0.5, 0, cssW * 0.9);
    grad.addColorStop(0, "rgba(255,200,0,0.08)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cssW, cssH);

    // holes
    const holes = computeHoles(cssW, cssH);
    holesRef.current = holes;

    const lastHole = state?.lastHole ?? null;

    for (const h of holes) {
      // ring
      ctx.beginPath();
      ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fill();

      const isSel = selectedHole === h.id;
      const isLast = lastHole === h.id;

      ctx.strokeStyle = isSel
        ? "rgba(255,215,120,0.95)"
        : isLast
          ? "rgba(120,255,160,0.75)"
          : "rgba(255,255,255,0.16)";
      ctx.lineWidth = isSel || isLast ? 2.6 : 2;
      ctx.stroke();

      // label
      ctx.fillStyle = "rgba(240,247,255,0.92)";
      ctx.font = `${isMobile ? 20 : 22}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(h.id), h.x, h.y);
    }

    // message overlay inside canvas
    const msg = err ? `Error: ${err}` : (state?.message || "Tap a hole to play");
    ctx.fillStyle = err ? "rgba(255,120,120,0.95)" : "rgba(240,247,255,0.72)";
    ctx.font = `600 ${isMobile ? 12 : 13}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(msg, cssW / 2, 12);
  }

  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      drawCanvas();
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, isWide, err, state?.message, state?.lastHole, selectedHole]);

  // click/tap handling
  function onCanvasPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (actionBusy) return;
    if (!canPlay) return;

    const c = canvasRef.current;
    if (!c) return;

    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const holes = holesRef.current;
    for (const h of holes) {
      const dx = x - h.x;
      const dy = y - h.y;
      if (dx * dx + dy * dy <= h.r * h.r) {
        setSelectedHole(h.id);
        void startOrPick(h.id);
        return;
      }
    }
  }

  // derived
  const phase = state?.phase || (state?.gameId ? "PICKING" : "IDLE");
  const showStage2 = phase === "STAGE2_PROMPT";
  const canCollect = !!state?.gameId && (state?.canCollect ?? showStage2) && !actionBusy;
  const canTry5x = !!state?.gameId && (state?.canTry5x ?? showStage2) && !actionBusy;

  const quickBets = Array.isArray(state?.quickBets) && state!.quickBets!.length ? state!.quickBets! : [1, 3, 5];
  const betVal = safeNumFromString(clampBetHuman(bet));
  const setBetHuman = (v: number) => setBet(String(Math.max(0, Math.floor(v))));

  return (
    <Box sx={{ p: isMobile ? 1.25 : 2, maxWidth: 980, mx: "auto", color: UI.textMain }}>
      <Box
        sx={{
          borderRadius: 4,
          overflow: "hidden",
          border: `1px solid ${UI.border}`,
          background: UI.feltBg,
          backdropFilter: "blur(10px)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
        }}
      >
        {/* Header */}
        <Box
          sx={{
            p: isMobile ? 1.5 : 2,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 1,
            flexWrap: "wrap",
          }}
        >
          <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
            {tgLabel ? (
              <Chip size="small" variant="outlined" label={tgLabel} sx={{ color: UI.textMain, borderColor: UI.border }} />
            ) : null}

            {bal?.railsPaused ? <Chip size="small" color="warning" label="Paused" /> : null}

            {bal?.offchain?.human ? (
              <Chip
                size="small"
                variant="outlined"
                label={`🪙 ${bal.offchain.human}`}
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

            {actionBusy ? <CircularProgress size={22} /> : null}
          </Box>
        </Box>

        {/* Canvas Panel */}
        <Box sx={{ px: isMobile ? 1.25 : 2, pb: isMobile ? 1.25 : 2 }}>
          <Paper
            variant="outlined"
            sx={{
              p: isMobile ? 1.0 : 1.25,
              borderRadius: 4,
              background:
                "radial-gradient(900px 520px at 50% 0%, rgba(0,255,160,0.09), transparent 60%), rgba(0,0,0,0.22)",
              borderColor: UI.border,
              color: UI.textMain,
            }}
          >
            {/* Optional banner image (from server config) */}
            {state?.imageUrl ? (
              <Box
                sx={{
                  borderRadius: 3,
                  overflow: "hidden",
                  border: `1px solid ${UI.border}`,
                  mb: 1.25,
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                <Box
                  component="img"
                  src={state.imageUrl}
                  alt="whack"
                  sx={{ width: "100%", display: "block", maxHeight: isMobile ? 160 : 220, objectFit: "cover" }}
                />
                {state.caption ? (
                  <Box sx={{ p: 1 }}>
                    <Typography sx={{ color: UI.textDim, fontWeight: 900, fontSize: 13 }}>{state.caption}</Typography>
                  </Box>
                ) : null}
              </Box>
            ) : null}

            <Box
              sx={{
                borderRadius: 3,
                overflow: "hidden",
                border: `1px solid ${UI.border}`,
                background: "rgba(0,0,0,0.22)",
              }}
            >
              <Box
                component="canvas"
                ref={canvasRef}
                onPointerDown={onCanvasPointerDown}
                sx={{
                  width: "100%",
                  height: isMobile ? 420 : 460,
                  display: "block",
                  touchAction: "none",
                }}
              />
            </Box>

            {err ? (
              <Box sx={{ mt: 1.2 }}>
                <Typography sx={{ whiteSpace: "pre-wrap", color: "rgba(255,120,120,0.95)", fontWeight: 900 }}>
                  {err}
                </Typography>
              </Box>
            ) : null}

            <Divider sx={{ my: 2, opacity: 0.35, borderColor: UI.border }} />

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap justifyContent="center">
              <Button
                variant="outlined"
                onClick={() => setBetModalOpen(true)}
                disabled={!canPlay}
                sx={{ fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
              >
                🪙 Bet
              </Button>

              <Button
                onClick={() => void refreshManual()}
                variant="outlined"
                disabled={!signedIn || pollBusy}
                sx={{ fontWeight: 950, color: UI.textMain, borderColor: UI.border }}
              >
                🔄 Refresh
              </Button>

              {showStage2 ? (
                <>
                  <Button
                    onClick={() => void collect()}
                    variant="contained"
                    disabled={!canCollect}
                    sx={{ borderRadius: 2.5, fontWeight: 990, px: 2.4 }}
                  >
                    ✅ Collect
                  </Button>
                  <Button
                    onClick={() => void try5x()}
                    variant="contained"
                    disabled={!canTry5x}
                    sx={{ borderRadius: 2.5, fontWeight: 990, px: 2.4 }}
                  >
                    💥 Go 5×
                  </Button>
                </>
              ) : null}

              {!!state?.gameId ? (
                <Button onClick={() => void cancel()} color="error" variant="outlined" disabled={actionBusy} sx={{ fontWeight: 990 }}>
                  🛑 Cancel
                </Button>
              ) : null}
            </Stack>
          </Paper>
        </Box>
      </Box>

      {/* Sticky Bottom Dock (bet + quick bets) */}
      <Paper
        elevation={0}
        sx={{
          position: "sticky",
          bottom: 10,
          mt: 2,
          p: 1.35,
          borderRadius: 3,
          border: `1px solid ${UI.border}`,
          background: "rgba(0,0,0,0.42)",
          backdropFilter: "blur(10px)",
          boxShadow: "0 16px 50px rgba(0,0,0,0.35)",
        }}
      >
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
            <Typography sx={{ color: UI.textMain, fontWeight: 990 }}>🎯 Bet: {clampBetHuman(bet)} credits</Typography>

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button
                variant="contained"
                onClick={() => {
                  // “rebet” just resets bet amount; user still taps a hole to play
                  setBet(lastBet);
                }}
                disabled={actionBusy || !canPlay}
                sx={{ borderRadius: 2.5, fontWeight: 990, px: 2.4 }}
              >
                🔁 Rebet
              </Button>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap justifyContent="center">
            {quickBets.map((v) => (
              <Button
                key={v}
                variant={String(v) === clampBetHuman(bet) ? "contained" : "outlined"}
                onClick={() => setBetHuman(v)}
                disabled={!canPlay}
                sx={{
                  fontWeight: 950,
                  color: UI.textMain,
                  borderColor: UI.border,
                }}
              >
                {v} 🪙
              </Button>
            ))}
          </Stack>
        </Stack>
      </Paper>

      {/* Bet Modal */}
      <ModalShell
        open={betModalOpen}
        title="Set your bet"
        onClose={() => setBetModalOpen(false)}
        actions={
          <>
            <Button onClick={() => setBetModalOpen(false)} sx={{ color: UI.textMain, fontWeight: 900 }}>
              Cancel
            </Button>
            <Button onClick={() => setBetModalOpen(false)} variant="contained" sx={{ fontWeight: 990 }}>
              Confirm
            </Button>
          </>
        }
      >
        <Typography sx={{ color: UI.textDim, mb: 1 }}>Choose chips (credits):</Typography>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {[1, 3, 5, 10, 25, 50, 100, 250, 500, 1000].map((v) => (
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
          <Button variant="outlined" onClick={() => setBetHuman(betVal - 1)} sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}>
            -1
          </Button>
          <Button variant="outlined" onClick={() => setBetHuman(betVal + 1)} sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}>
            +1
          </Button>
          <Button variant="outlined" onClick={() => setBetHuman(betVal + 10)} sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}>
            +10
          </Button>
          <Button variant="outlined" onClick={() => setBetHuman(betVal + 50)} sx={{ color: UI.textMain, borderColor: UI.border, fontWeight: 950 }}>
            +50
          </Button>
        </Stack>

        <Divider sx={{ my: 2, borderColor: UI.border, opacity: 0.6 }} />

        <Typography sx={{ color: UI.textMain, fontWeight: 990 }}>Current bet: {clampBetHuman(bet)}</Typography>
        <Typography sx={{ color: UI.textFaint, fontSize: 12, mt: 0.5 }}>
          (Bet is credits. Must be &gt; 0. Tap a hole on the canvas to play.)
        </Typography>
      </ModalShell>

      {/* Cashier Modal */}
      <ModalShell
        open={cashierOpen}
        title="Cashier"
        onClose={() => setCashierOpen(false)}
        actions={
          <Button onClick={() => setCashierOpen(false)} sx={{ color: UI.textMain, fontWeight: 900 }}>
            Close
          </Button>
        }
      >
        {!signedIn ? (
          <Typography sx={{ color: UI.textDim }}>Sign in from Telegram to view balances.</Typography>
        ) : (
          <Stack spacing={1.2}>
            <Paper
              variant="outlined"
              sx={{ p: 1.4, borderRadius: 2, borderColor: UI.border, background: "rgba(255,255,255,0.05)" }}
            >
              <Typography sx={{ fontWeight: 990, color: UI.textMain }}>🪙 YETI Credits</Typography>
              <Typography sx={{ color: UI.textDim }}>{bal?.offchain?.human ? bal.offchain.human : "—"}</Typography>
              <Typography sx={{ color: UI.textFaint, fontSize: 12, mt: 0.5 }}>
                TelegramUserId: {bal?.telegramUserId || "—"}
              </Typography>
              <Typography sx={{ color: UI.textFaint, fontSize: 12 }}>
                Wallet: {bal?.wallet ? `${bal.wallet.slice(0, 6)}…${bal.wallet.slice(-4)}` : "—"}{" "}
                {bal?.walletVerified ? "✅" : "❌"}
              </Typography>
            </Paper>

            {bal?.railsPaused ? (
              <Paper
                variant="outlined"
                sx={{ p: 1.2, borderRadius: 2, borderColor: UI.border, background: "rgba(255,200,0,0.10)" }}
              >
                <Typography sx={{ fontWeight: 990, color: UI.textMain }}>⚠️ Rails Paused</Typography>
                <Typography sx={{ color: UI.textDim, fontSize: 13 }}>
                  Movement actions disabled. Deposits may still be allowed depending on server rules.
                </Typography>
              </Paper>
            ) : null}

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap justifyContent="center">
              <Button variant="contained" sx={{ fontWeight: 990 }}>
                Deposit
              </Button>
              <Button variant="outlined" sx={{ fontWeight: 990, color: UI.textMain, borderColor: UI.border }}>
                Withdraw
              </Button>
            </Stack>
          </Stack>
        )}
      </ModalShell>
    </Box>
  );
}
