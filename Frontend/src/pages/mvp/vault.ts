// src/pages/vault.ts

export const BSC = {
  name: "BSC",
  chainId: 56,
  rpcUrl: "https://bsc-rpc.publicnode.com",

  // hardcoded vault
  vaultAddress: "0xbC84C26d2b1d65b768e50322a14C2CbB5c759BE8",

  /**
   * IMPORTANT:
   * Set this to the vault deployment block for faster + reliable log scanning.
   * If left 0, UI will fall back to scanning "recent window" only.
   */
  vaultDeployBlock: 78747939,

  /**
   * Optional: known token labels to display nicer names.
   * This is NOT the enabled token source-of-truth (enabled comes from logs).
   */
  tokenLabels: [
    { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", label: "USDC" },
    { address: "0x55d398326f99059ff775485246999027b3197955", label: "USDT" },
    { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", label: "WBNB" },
    { address: "0xA2936abe3341B326f8F9BafFBd9988B2b7384229", label: "YETI" }
  ],
} as const;

export const BASE = {
  name: "Base",
  chainId: 8453,
  rpcUrl: "https://base-rpc.publicnode.com",

  // hardcoded vault
  vaultAddress: "0xB9881aCab977780613BF0EE8033C4a00EC04D859",

  /**
   * If unknown, leave 0 (recent scan window only).
   */
  vaultDeployBlock: 42640877,

  tokenLabels: [
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", label: "USDC" },
    // On Base, the canonical WETH address is also the wrapped native address.
    { address: "0x4200000000000000000000000000000000000006", label: "WETH" }
  ],
} as const;

export const AVALANCHE = {
  name: "Avalanche",
  chainId: 43114,
  rpcUrl: "https://avalanche-c-chain-rpc.publicnode.com",

  // hardcoded vault
  vaultAddress: "0x01aCeaB580776785083c5E8823CF0aAb37874d1B",

  /**
   * If unknown, leave 0 (recent scan window only).
   */
  vaultDeployBlock: 58957818,

  tokenLabels: [
    { address: "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664", label: "USDC" },
    { address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", label: "WAVAX" }
  ],
} as const;

/**
 * Optional convenience export if your UI needs to iterate supported chains.
 * If you already have your own array/map elsewhere, you can ignore this.
 */
export const CHAINS = [BSC, BASE, AVALANCHE] as const;
export type SupportedChain = typeof CHAINS[number];
