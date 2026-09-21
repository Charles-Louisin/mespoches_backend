import { Request, Response, NextFunction } from 'express';
import os from 'os';
import mongoose from 'mongoose';
import { mongoPoolStats } from '../db';

type RouteStat = {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
};

const MAX_SAMPLES = 80;
const MAX_SLOW = 40;
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS || 500);

const byRoute = new Map<string, RouteStat>();
const slow: { at: string; method: string; path: string; status: number; ms: number }[] = [];
const startedAt = Date.now();

function routeKey(req: Request): string {
  const base = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
  return `${req.method} ${base}`;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function requestMetrics(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/api/metrics' || req.path === '/api/health') {
    next();
    return;
  }

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const key = routeKey(req);
    const stat = byRoute.get(key) || {
      count: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      samples: [],
    };
    stat.count += 1;
    stat.totalMs += ms;
    if (ms > stat.maxMs) stat.maxMs = ms;
    if (res.statusCode >= 400) stat.errors += 1;
    stat.samples.push(ms);
    if (stat.samples.length > MAX_SAMPLES) stat.samples.shift();
    byRoute.set(key, stat);

    if (ms >= SLOW_MS) {
      slow.push({
        at: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(ms),
      });
      if (slow.length > MAX_SLOW) slow.shift();
      console.warn(
        `[slow] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Math.round(ms)}ms`
      );
    }
  });
  next();
}

/** Coupe les requêtes trop longues côté client (la query Mongo a aussi maxTimeMS). */
export function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  const path = (req.originalUrl || req.url || '').split('?')[0]
  const longAi = /\/ai-scan$|\/voice-note$/.test(path)
  const ms = longAi
    ? Number(process.env.AI_REQUEST_TIMEOUT_MS || 90_000)
    : Number(process.env.REQUEST_TIMEOUT_MS || 20_000)
  req.setTimeout(ms);
  res.setTimeout(ms, () => {
    if (res.headersSent) return;
    res.status(503).json({
      success: false,
      code: 'TIMEOUT',
      message: 'La requête a pris trop de temps. Réessayez.',
    });
  });
  next();
}

export function metricsSnapshot(): Record<string, unknown> {
  const mem = process.memoryUsage();
  const routes = [...byRoute.entries()]
    .map(([route, s]) => {
      const samples = [...s.samples].sort((a, b) => a - b);
      return {
        route,
        count: s.count,
        errors: s.errors,
        avgMs: s.count ? Math.round(s.totalMs / s.count) : 0,
        maxMs: Math.round(s.maxMs),
        p50Ms: Math.round(percentile(samples, 50)),
        p95Ms: Math.round(percentile(samples, 95)),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);

  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    cpuLoad: os.loadavg(),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      externalMb: Math.round(mem.external / 1024 / 1024),
    },
    mongo: mongoPoolStats(),
    mongooseModels: mongoose.modelNames().length,
    slowRequests: [...slow].reverse(),
    routes,
  };
}
