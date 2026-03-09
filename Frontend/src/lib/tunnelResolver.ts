// src/lib/tunnelResolver.ts
import { ethers } from "ethers";

const TUNNEL_REGISTRY_ABI = [
  // matches your node one-liner:
  // abi=['function url(uint256) view returns(string)']
  "function url(uint256) view returns (string)",
];

type ResolveOptions = {
  registryAddress: string;
  slots: number[];
  readRpcUrls: string[];
  healthPath?: string; // default "/health"
  timeoutMs?: number;  // default 3000
};

function normalizeBaseUrl(u: string): string {
  const s = String(u || "").trim();
  if (!s) return "";
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

export async function healthCheckBase(
  baseUrl: string,
  healthPath = "/health",
  timeoutMs = 3000
): Promise<boolean> {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return false;

  try {
    const res = await fetchWithTimeout(`${base}${healthPath}`, timeoutMs);

    // Treat "Cloudflare Tunnel error" (530) as dead.
    if (res.status === 530) return false;

    // For health endpoints: ideally 200.
    // But if your health ever returns 401/403, you can relax this.
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

async function readRegistryUrlOnce(
  provider: ethers.JsonRpcProvider,
  registryAddress: string,
  slot: number
): Promise<string> {
  const c = new ethers.Contract(registryAddress, TUNNEL_REGISTRY_ABI, provider);
  const u: string = await c.url(slot);
  return normalizeBaseUrl(u);
}

async function makeProvider(readRpcUrls: string[]): Promise<ethers.JsonRpcProvider> {
  // Just pick first working RPC. If one fails, caller will try next.
  return new ethers.JsonRpcProvider(readRpcUrls[0]);
}

export async function resolveApiBaseFromOnchain(opts: ResolveOptions): Promise<{
  baseUrl: string;
  slot: number;
} | null> {
  const {
    registryAddress,
    slots,
    readRpcUrls,
    healthPath = "/health",
    timeoutMs = 3000,
  } = opts;

  if (!registryAddress || !ethers.isAddress(registryAddress)) return null;
  if (!slots?.length) return null;
  if (!readRpcUrls?.length) return null;

  // Try RPCs in order
  for (const rpc of readRpcUrls) {
    const provider = new ethers.JsonRpcProvider(rpc);

    // Try slots in order
    for (const slot of slots) {
      try {
        const u = await readRegistryUrlOnce(provider, registryAddress, slot);
        if (!u) continue;

        // Health check before returning
        const ok = await healthCheckBase(u, healthPath, timeoutMs);
        if (ok) return { baseUrl: u, slot };
      } catch {
        // try next slot / rpc
      }
    }
  }

  return null;
}
