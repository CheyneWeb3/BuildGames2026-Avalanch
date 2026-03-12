import fs from 'node:fs';
import path from 'node:path';
import { SystemConfigSchema, type SystemConfig } from '@hauscashier/common';

export function loadSystemConfig(): SystemConfig {
  const cfgPath = process.env.CONFIG_PATH
    ? path.resolve(process.env.CONFIG_PATH)
    : path.resolve(__dirname, '../../config/system.json');

  const raw = fs.readFileSync(cfgPath, 'utf8');
  const json = JSON.parse(raw);
  const parsed = SystemConfigSchema.safeParse(json);
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid config at ${cfgPath}: ${msg}`);
  }
  return parsed.data;
}
