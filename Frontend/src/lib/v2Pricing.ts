import { Contract, JsonRpcProvider } from "ethers";

const V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)"
] as const;

const V2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
] as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function pow10(dec: number): bigint {
  let x = 1n;
  for (let i = 0; i < dec; i++) x *= 10n;
  return x;
}

function addrEq(a: string, b: string) {
  return (a || "").toLowerCase() === (b || "").toLowerCase();
}

// returns price(tokenA) in units of tokenB (human)
function priceAinB_fromReserves(
  token0: string,
  token1: string,
  r0: bigint,
  r1: bigint,
  tokenA: string,
  tokenB: string,
  decA: number,
  decB: number
): number | null {
  if (r0 <= 0n || r1 <= 0n) return null;

  // price(token0) in token1 = (r1/10^d1) / (r0/10^d0) = r1*10^d0 / (r0*10^d1)
  // We compute scaled by 1e18 for precision.
  const SCALE = 10n ** 18n;

  // token0 -> token1
  const price0in1_scaled =
    (r1 * pow10(decA) * SCALE) / (r0 * pow10(decB)); // NOTE: decA/decB are for A/B mapping below; we’ll re-map per branch

  // But we need mapping based on which side A/B actually is.
  // So instead compute both directions explicitly using correct decimals per side.

  // Helper to compute price(X) in Y given reserves aligned to token0/token1
  const price0in1 = (d0: number, d1: number) =>
    Number((r1 * pow10(d0) * SCALE) / (r0 * pow10(d1))) / 1e18;
  const price1in0 = (d1: number, d0: number) =>
    Number((r0 * pow10(d1) * SCALE) / (r1 * pow10(d0))) / 1e18;

  // If tokenA is token0 and tokenB is token1:
  if (addrEq(tokenA, token0) && addrEq(tokenB, token1)) return price0in1(decA, decB);

  // If tokenA is token1 and tokenB is token0:
  if (addrEq(tokenA, token1) && addrEq(tokenB, token0)) return price1in0(decA, decB);

  return null;
}

async function getPairAddress(factoryAddr: string, provider: JsonRpcProvider, a: string, b: string): Promise<string> {
  if (!factoryAddr || addrEq(factoryAddr, ZERO_ADDR)) return "";
  const f = new Contract(factoryAddr, V2_FACTORY_ABI, provider);
  const pair = String(await f.getPair(a, b));
  if (!pair || addrEq(pair, ZERO_ADDR)) return "";
  return pair;
}

async function getV2Price(
  factoryAddr: string,
  provider: JsonRpcProvider,
  tokenA: string,
  tokenB: string,
  decA: number,
  decB: number
): Promise<number | null> {
  const pairAddr = await getPairAddress(factoryAddr, provider, tokenA, tokenB);
  if (!pairAddr) return null;

  const p = new Contract(pairAddr, V2_PAIR_ABI, provider);
  const [t0, t1, reserves] = await Promise.all([p.token0(), p.token1(), p.getReserves()]);
  const r0 = BigInt(reserves.reserve0.toString());
  const r1 = BigInt(reserves.reserve1.toString());

  const out = priceAinB_fromReserves(String(t0), String(t1), r0, r1, tokenA, tokenB, decA, decB);
  return out;
}

/**
 * Price token in USD (USDC assumed $1).
 * Tries:
 *  - token/USDC
 *  - token/WNATIVE * WNATIVE/USDC
 */
export async function getTokenUsdPriceV2(opts: {
  provider: JsonRpcProvider;
  factory: string;
  token: string;
  usdc: string;
  wNative: string;
  tokenDecimals: number;
  usdcDecimals: number;
  wNativeDecimals: number;
}): Promise<number | null> {
  const { provider, factory, token, usdc, wNative, tokenDecimals, usdcDecimals, wNativeDecimals } = opts;

  if (addrEq(token, usdc)) return 1;

  // direct token/usdc
  const direct = await getV2Price(factory, provider, token, usdc, tokenDecimals, usdcDecimals);
  if (direct != null && Number.isFinite(direct) && direct > 0) return direct;

  // via wNative
  const tInW = await getV2Price(factory, provider, token, wNative, tokenDecimals, wNativeDecimals);
  if (tInW == null || !Number.isFinite(tInW) || tInW <= 0) return null;

  const wInU = await getV2Price(factory, provider, wNative, usdc, wNativeDecimals, usdcDecimals);
  if (wInU == null || !Number.isFinite(wInU) || wInU <= 0) return null;

  return tInW * wInU;
}
