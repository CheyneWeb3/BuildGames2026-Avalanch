import { z } from 'zod';

// ============================
// System config (services/*/config/system.json)
// ============================

export const SystemBlockSchema = z.object({
  serviceName: z.string().min(1),
  environment: z.enum(['dev', 'prod']).default('dev'),
  publicBaseUrl: z.string().url().optional()
});
export type SystemBlock = z.infer<typeof SystemBlockSchema>;

export const SecurityCorsSchema = z.object({
  allowOrigins: z.array(z.string()).default(['*'])
});

export const SecurityRateLimitSchema = z.object({
  windowMs: z.number().int().positive().default(60_000),
  max: z.number().int().positive().default(240)
});

export const SecurityBlockSchema = z.object({
  adminAddresses: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).default([]),
  cors: SecurityCorsSchema.default({ allowOrigins: ['*'] }),
  rateLimit: SecurityRateLimitSchema.default({ windowMs: 60_000, max: 240 })
});
export type SecurityBlock = z.infer<typeof SecurityBlockSchema>;

export const VaultConfigSchema = z.object({
  id: z.string().min(1),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  usdc: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  wNative: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  enabled: z.boolean().default(true)
});
export type VaultConfig = z.infer<typeof VaultConfigSchema>;

export const TokenConfigSchema = z.object({
  symbol: z.string().min(1),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  decimals: z.number().int().min(0).max(36),
  enabled: z.boolean().default(true)
});
export type TokenConfig = z.infer<typeof TokenConfigSchema>;

export const ChainConfigSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string().min(1),
  rpcHttp: z.string().url(),
  enabled: z.boolean().default(true),
  explorer: z.string().url().optional(),
  ccip: z
    .object({
      router: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
      selector: z.string().optional() // keep as string to avoid JS uint64 issues
    })
    .optional(),
  vaults: z.array(VaultConfigSchema).default([]),
  tokens: z.array(TokenConfigSchema).default([])
});
export type ChainConfig = z.infer<typeof ChainConfigSchema>;

export const ModulesBlockSchema = z.object({
  scanDir: z.string().default('../../modules'),
  enabled: z.boolean().default(true),
  allowed: z.array(z.string()).default([])
});
export type ModulesBlock = z.infer<typeof ModulesBlockSchema>;

export const SystemConfigSchema = z.object({
  system: SystemBlockSchema,
  security: SecurityBlockSchema,
  chains: z.array(ChainConfigSchema).default([]),
  modules: ModulesBlockSchema.default({ scanDir: '../../modules', enabled: true, allowed: [] })
});
export type SystemConfig = z.infer<typeof SystemConfigSchema>;

// ============================
// Shared helpers
// ============================

export type Address = `0x${string}`;

export function normalizeAddress(a: string): string {
  return String(a || '').trim().toLowerCase();
}

export function userAccountId(address: string): string {
  return `user:${normalizeAddress(address)}`;
}

export function treasuryAccountId(treasuryId: string): string {
  return `treasury:${String(treasuryId || '').trim()}`;
}

export function sha256Hex(input: string): string {
  // Node-only helper (all current services run on Node)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto') as typeof import('node:crypto');
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}
