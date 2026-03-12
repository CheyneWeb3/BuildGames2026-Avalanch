import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import type { MongoCollections, ModuleDoc } from '../db/mongo';
import type { SystemConfig } from '@hauscashier/common';

export type AuthedRequest = Request & {
  user?: { address: string; roles: string[] };
  tg?: { sub: string; roles: string[] };
  moduleDoc?: ModuleDoc;
};

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

export function requireJwt(req: AuthedRequest, res: Response, next: NextFunction) {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET_NOT_SET' });

  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'MISSING_BEARER' });

  try {
    const decoded = jwt.verify(m[1], secret) as any;
    const address = String(decoded?.sub || '').toLowerCase();
    const roles = Array.isArray(decoded?.roles) ? decoded.roles.map(String) : [];
    if (!address || !address.startsWith('0x') || address.length !== 42) {
      return res.status(401).json({ error: 'BAD_TOKEN' });
    }
    req.user = { address, roles };
    return next();
  } catch {
    return res.status(401).json({ error: 'BAD_TOKEN' });
  }
}



export function requireTgJwt(req: AuthedRequest, res: Response, next: NextFunction) {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET_NOT_SET' });

  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'MISSING_BEARER' });

  try {
    const decoded = jwt.verify(m[1], secret) as any;
    const sub = String(decoded?.sub || '').trim();
    const roles = Array.isArray(decoded?.roles) ? decoded.roles.map(String) : [];
    if (!sub.startsWith('tg:')) return res.status(401).json({ error: 'BAD_TOKEN' });
    req.tg = { sub, roles };
    return next();
  } catch {
    return res.status(401).json({ error: 'BAD_TOKEN' });
  }
}
export function requireAdmin(cfg: SystemConfig) {
  const admins = new Set((cfg.security?.adminAddresses || []).map(a => a.toLowerCase()));
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const addr = req.user?.address;
    if (!addr) return res.status(401).json({ error: 'MISSING_AUTH' });
    if (admins.has(addr) || (req.user?.roles || []).includes('admin')) return next();
    return res.status(403).json({ error: 'FORBIDDEN' });
  };
}

/**
 * Verifies module headers and loads module doc.
 * Header: x-module-id, x-module-key (plain key), compared against stored sha256(apiKey).
 */
export function requireModule(col: MongoCollections) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const moduleId = (req.header('x-module-id') || '').trim();
    const moduleKey = (req.header('x-module-key') || '').trim();
    if (!moduleId || !moduleKey) return res.status(401).json({ error: 'MISSING_MODULE_AUTH' });

    const doc = await col.modules.findOne({ _id: moduleId });
    if (!doc || !doc.enabled) return res.status(401).json({ error: 'MODULE_DISABLED' });

    const gotHash = sha256Hex(moduleKey);
    if (gotHash !== doc.apiKeyHash) return res.status(401).json({ error: 'BAD_MODULE_KEY' });

    req.moduleDoc = doc;
    return next();
  };
}

export function requireRelayer(req: Request, res: Response, next: NextFunction) {
  const shared = process.env.RELAYER_SHARED_KEY || '';
  if (!shared) return res.status(500).json({ error: 'RELAYER_SHARED_KEY_NOT_SET' });
  const hdr = (req.header('x-relayer-key') || '').trim();
  if (!hdr || hdr !== shared) return res.status(401).json({ error: 'RELAYER_UNAUTHORIZED' });
  next();
}

export function requireIndexer(req: Request, res: Response, next: NextFunction) {
  const shared = process.env.INDEXER_SHARED_KEY || '';
  if (!shared) return res.status(500).json({ error: 'INDEXER_SHARED_KEY_NOT_SET' });
  const got = String(req.headers['x-indexer-key'] || '');
  if (got !== shared) return res.status(401).json({ error: 'UNAUTHORIZED' });
  return next();
}
