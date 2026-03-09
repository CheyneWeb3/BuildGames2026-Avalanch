import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Contract, JsonRpcProvider, isAddress } from "ethers";

type ApiSource = "cache" | "onchain" | "unknown";
type ApiStatus = "init" | "ok" | "degraded" | "down";

export type ApiBaseState = {
  apiBase: string; // origin only, e.g. https://abc.trycloudflare.com
  source: ApiSource;
  status: ApiStatus;
  lastResolvedAt: number | null;
  lastCheckedAt: number | null;
};

const ApiBaseContext = createContext<ApiBaseState | undefined>(undefined);

// Your deployed TunnelUrlRegistry10 ABI surface (read-only)
// - getTunnel(uint256) -> (string currentUrl, uint256 lastUpdatedAt, uint256 currentVersion, address currentOperator)
const TUNNEL_REGISTRY_ABI = [
  "function getTunnel(uint256 tunnelId) view returns (string currentUrl, uint256 lastUpdatedAt, uint256 currentVersion, address currentOperator)",
  "function url(uint256 tunnelId) view returns (string)",
] as const;

function normalizeOrigin(input: string): string {
  let s = (input || "").trim();
  if (!s) return "";

  // If it's a plain slug (your contract stores 4-word prefixes), assume trycloudflare.
  if (/^[a-z0-9-]+$/i.test(s)) s = `https://${s}.trycloudflare.com`;

  // If it's missing scheme, assume https
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;

  // Strip trailing slashes
  s = s.replace(/\/+$/, "");
  return s;
}

async function pingHealth(
  origin: string,
  healthPath: string,
  timeoutMs: number
): Promise<boolean> {
  if (!origin) return false;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${origin}${healthPath}`, {
      method: "GET",
      cache: "no-store",
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function readOnchainOrigin(opts: {
  rpcUrl: string;
  registryAddress: string;
  tunnelId: number;
}): Promise<string> {
  const provider = new JsonRpcProvider(opts.rpcUrl);
  const c = new Contract(opts.registryAddress, TUNNEL_REGISTRY_ABI, provider);

  // Primary read: getTunnel(tunnelId)
  try {
    const ret = await c.getTunnel(opts.tunnelId);
    const url = Array.isArray(ret) ? ret[0] : ret?.currentUrl;
    if (typeof url === "string") return normalizeOrigin(url);
  } catch {
    // ignore
  }

  // Backup read: url(tunnelId)
  try {
    const url = await c.url(opts.tunnelId);
    if (typeof url === "string") return normalizeOrigin(url);
  } catch {
    // ignore
  }

  return "";
}

function nowMs(): number {
  return Date.now();
}

export function ApiBaseProvider({ children }: { children: React.ReactNode }) {
  const registryAddress = (import.meta.env.VITE_TUNNEL_REGISTRY_ADDRESS || "").trim();
  const tunnelId = Number(import.meta.env.VITE_TUNNEL_ID || "10");
  const readRpcUrl = (import.meta.env.VITE_READ_RPC_URL || "").trim();

  // Default to /openapi.json because Core API always serves it (whereas /health may not exist).
const healthPath = (import.meta.env.VITE_API_HEALTH_PATH || "/config/public").trim();
  const checkIntervalMs = Math.max(5000, Number(import.meta.env.VITE_API_CHECK_INTERVAL_MS || "15000"));
  const checkTimeoutMs = Math.max(500, Number(import.meta.env.VITE_API_CHECK_TIMEOUT_MS || "2500"));

  const cacheKey = useMemo(() => {
    // v4 cache key (tunnelId-based registry, no appId)
    return `haus:apiBase:v4:${registryAddress}:${tunnelId}`;
  }, [registryAddress, tunnelId]);

  const [state, setState] = useState<ApiBaseState>(() => {
    const cached = normalizeOrigin(localStorage.getItem(cacheKey) || "");
    if (cached) {
      return {
        apiBase: cached,
        source: "cache",
        status: "init",
        lastResolvedAt: null,
        lastCheckedAt: null,
      };
    }
    return {
      apiBase: "",
      source: "unknown",
      status: "init",
      lastResolvedAt: null,
      lastCheckedAt: null,
    };
  });

  const resolvingRef = useRef(false);
  const failCountRef = useRef(0);

  const setApiBase = (apiBase: string, source: ApiSource, status: ApiStatus) => {
    const origin = normalizeOrigin(apiBase);
    if (!origin) return;

    // Only persist on-chain derived origins (prevents poisoning cache).
    if (source === "onchain") {
      try {
        localStorage.setItem(cacheKey, origin);
      } catch {
        // ignore storage failures
      }
    }

    setState((prev) => ({
      ...prev,
      apiBase: origin,
      source,
      status,
      lastResolvedAt: nowMs(),
    }));
  };

  const resolveFromChain = async (): Promise<void> => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;

    try {
      if (!readRpcUrl) {
        setState((p) => ({ ...p, apiBase: "", source: "unknown", status: "down" }));
        return;
      }
      if (!registryAddress || !isAddress(registryAddress)) {
        setState((p) => ({ ...p, apiBase: "", source: "unknown", status: "down" }));
        return;
      }
      if (!Number.isFinite(tunnelId) || tunnelId <= 0) {
        setState((p) => ({ ...p, apiBase: "", source: "unknown", status: "down" }));
        return;
      }

      const chosen = await readOnchainOrigin({
        rpcUrl: readRpcUrl,
        registryAddress,
        tunnelId,
      });

      if (!chosen) {
        // Strict: on-chain resolution failed -> no API base.
        setState((p) => ({ ...p, apiBase: "", source: "unknown", status: "down" }));
        return;
      }

      // IMPORTANT: health check must NEVER block resolution.
      setApiBase(chosen, "onchain", "ok");
      setState((p) => ({ ...p, lastCheckedAt: nowMs() }));

      // Optional: mark degraded if health fails, but do not clear apiBase.
      const ok = await pingHealth(chosen, healthPath, checkTimeoutMs);
      setState((p) => ({
        ...p,
        status: ok ? "ok" : "degraded",
        lastCheckedAt: nowMs(),
      }));
      failCountRef.current = ok ? 0 : 1;
    } finally {
      resolvingRef.current = false;
    }
  };

  // Initial resolve (even if we have cache)
  useEffect(() => {
    void resolveFromChain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryAddress, tunnelId, readRpcUrl]);

  // Health monitor + auto re-resolve
  useEffect(() => {
    if (!state.apiBase) return;

    const id = window.setInterval(async () => {
      const ok = await pingHealth(state.apiBase, healthPath, checkTimeoutMs);
      setState((p) => ({
        ...p,
        status: ok ? "ok" : (p.status === "down" ? "down" : "degraded"),
        lastCheckedAt: nowMs(),
      }));

      if (ok) {
        failCountRef.current = 0;
        return;
      }

      failCountRef.current += 1;

      // After 2 consecutive fails, re-resolve from chain.
      if (failCountRef.current >= 2) {
        await resolveFromChain();
      }
    }, checkIntervalMs);

    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.apiBase, healthPath, checkTimeoutMs, checkIntervalMs]);

  // Dev helper so you can quickly inspect resolver state in the console.
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as any).__yetiApiBaseState = state;
    }
  }, [state]);

  const value = useMemo(() => state, [state]);

  return <ApiBaseContext.Provider value={value}>{children}</ApiBaseContext.Provider>;
}

export function useApiBaseState(): ApiBaseState {
  const v = useContext(ApiBaseContext);
  if (!v) throw new Error("useApiBaseState must be used inside <ApiBaseProvider>");
  return v;
}

export function useApiBase(): string {
  return useApiBaseState().apiBase;
}
