'use strict';
// We intentionally avoid the external dependency "express-async-errors".
// Instead we patch Express Router methods to forward async errors to `next(err)`.
import './patchAsyncErrors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import pino from 'pino';
import type { Db } from 'mongodb';
import type { MongoCollections } from '../db/mongo';
import type { SystemConfig } from '@hauscashier/common';
import { buildRoutes } from './routes';

export function createApp(db: Db, cols: MongoCollections, cfg: SystemConfig) {
  const app = express();

  const log = pino({ level: process.env.LOG_LEVEL || 'info' });
  app.use(pinoHttp({ logger: log }));

  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  const allowOrigins = cfg.security.cors.allowOrigins;
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowOrigins.includes('*')) return cb(null, true);
      if (allowOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS_BLOCKED'));
    },
    credentials: false
  }));

  app.use(rateLimit({
    windowMs: cfg.security.rateLimit.windowMs,
    max: cfg.security.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false
  }));

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: cfg.system.serviceName, env: cfg.system.environment });
  });

  app.use(buildRoutes(db, cols, cfg));

  // last handler
  app.use((err: any, req: any, res: any, next: any) => {
    try { req.log?.error({ err }, "request_error"); } catch {}
    const msg = String(err?.message || "SERVER_ERROR");
    const status = err?.statusCode || err?.status || (msg === "CORS_BLOCKED" ? 403 : 500);
    res.status(status).json({ ok: false, error: msg });
  });

  return app;
}
