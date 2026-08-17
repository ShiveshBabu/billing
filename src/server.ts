import 'dotenv/config';
import Fastify from 'fastify';
import path from 'path';
import fs from 'fs';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { AppError } from './lib/errors';
import { csrfProtection, generateCsrfToken } from './lib/csrf';
import { PgSessionStore, startSessionSweeper } from './lib/sessionStore';
import { closePool } from './lib/db';
import { validateEnv } from './lib/env';
import { ensureMigrated } from './lib/migrate';

import authRoutes from './routes/auth';
import customerRoutes from './routes/customers';
import supplierRoutes from './routes/suppliers';
import productRoutes from './routes/products';
import warehouseRoutes from './routes/warehouses';
import batchRoutes from './routes/batches';
import invoiceRoutes from './routes/invoices';
import paymentRoutes from './routes/payments';
import returnRoutes from './routes/returns';
import purchaseRoutes from './routes/purchases';
import manufacturingRoutes from './routes/manufacturing';
import expenseRoutes from './routes/expenses';
import reportRoutes from './routes/reports';
import auditRoutes from './routes/audit';
import userRoutes from './routes/users';

export function buildServer() {
  const app = Fastify({
    logger: {
      transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
      // Redact anything that could leak credentials into logs.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'body.password', 'body.currentPassword', 'body.newPassword']
    }
  });

  // SAME_ORIGIN mode (SERVE_FRONTEND=true, the recommended Railway setup):
  // this process serves both the frontend and the API on one origin/port, so
  // there is no cross-site cookie or CORS problem to configure at all — the
  // browser sees a single site. This is the default and the reason CORS_ORIGIN
  // becomes optional (see src/lib/env.ts). Set SERVE_FRONTEND=false only if
  // you deliberately deploy the frontend as a separate service, in which case
  // CORS_ORIGIN and cross-site cookie settings become mandatory (see README).
  const serveFrontend = process.env.SERVE_FRONTEND !== 'false';

  app.register(helmet, { contentSecurityPolicy: process.env.NODE_ENV === 'production' });
  if (!serveFrontend) {
    app.register(cors, { origin: process.env.CORS_ORIGIN ?? true, credentials: true });
  }
  // Tiered rate limiting (Phase 7): a single flat global limit either lets
  // brute-force login attempts through or throttles legitimate rapid ERP
  // usage (both observed as real problems in testing). This uses
  // @fastify/rate-limit's dynamic `max` (a function, not a fixed number) so
  // the effective limit depends on what's actually being hit, without
  // needing a per-route override on every single route file:
  //   - health check / CSRF token fetch: generous (polled often, harmless)
  //   - login: strict (brute-force target; account lockout is a second layer)
  //   - authenticated reads (GET): higher allowance (normal browsing/reports)
  //   - authenticated writes (POST/PUT/PATCH/DELETE): moderate
  // Login and password-reset routes additionally set their own even-stricter
  // per-route override below, which takes precedence over this global policy.
  app.register(rateLimit, {
    timeWindow: '1 minute',
    max: (req: any) => {
      if (req.url === '/health' || req.url === '/api/health' || req.url === '/api/v1/auth/csrf-token') return 300;
      if (req.url === '/api/v1/auth/login') return 10;
      if (req.method === 'GET') return 200;
      return 60; // authenticated writes
    }
  });

  app.register(cookie);
  app.register(session, {
    secret: process.env.SESSION_SECRET!,
    cookieName: process.env.SESSION_COOKIE_NAME ?? 'svp_sid',
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      // Same-origin deployment (the default) never needs SameSite=None —
      // 'lax' is the more secure choice and works fine since frontend and
      // API share one origin. Only a genuinely cross-site deployment
      // (SERVE_FRONTEND=false, separate frontend host) needs 'none' + secure.
      sameSite: serveFrontend ? 'lax' : 'none',
      maxAge: Number(process.env.SESSION_MAX_AGE_MS ?? 28_800_000)
    },
    store: new PgSessionStore() as any
  });

  // Consistent error contract for the whole API — never leak stack traces.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      req.log.warn({ code: err.code }, err.message);
      return reply.status(err.statusCode).send(err.toJSON());
    }
    if ((err as any).issues) {
      // zod validation error
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', details: (err as any).issues } });
    }
    // @fastify/rate-limit throws a plain Error with .statusCode = 429 (and
    // sets its own Retry-After header already) — map it to the same stable
    // contract as every other error instead of falling through to a generic
    // 500 (a real bug found during password-reset rate-limit testing: this
    // branch didn't exist before, so throttled requests looked like server
    // crashes rather than a deliberate, expected rate limit).
    if ((err as any).statusCode === 429) {
      req.log.warn({ code: 'RATE_LIMITED' }, err.message);
      return reply.status(429).send({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait before trying again.' } });
    }
    req.log.error(err);
    const isProd = process.env.NODE_ENV === 'production';
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: isProd ? 'Something went wrong.' : err.message }
    });
  });

  const healthHandler = async () => ({ success: true, data: { status: 'ok', time: new Date().toISOString() } });
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler); // Railway health checks and the deployment docs both reference this path

  // Any client (even not-yet-logged-in) fetches a token here before making
  // its first state-changing request. Safe methods never need this.
  app.get('/api/v1/auth/csrf-token', async (req, reply) => {
    const token = generateCsrfToken(req);
    return reply.send({ success: true, data: { csrfToken: token } });
  });
  app.addHook('onRequest', async (req, reply) => { await csrfProtection(req, reply); });

  app.register(authRoutes);
  app.register(customerRoutes);
  app.register(supplierRoutes);
  app.register(productRoutes);
  app.register(warehouseRoutes);
  app.register(batchRoutes);
  app.register(invoiceRoutes);
  app.register(paymentRoutes);
  app.register(returnRoutes);
  app.register(purchaseRoutes);
  app.register(manufacturingRoutes);
  app.register(expenseRoutes);
  app.register(reportRoutes);
  app.register(auditRoutes);
  app.register(userRoutes);

  // Same-origin frontend serving — registered LAST so it never shadows any
  // /api/* route above. wildcard: false + a manual SPA fallback below means
  // a request for an unknown path still serves index.html (client-side
  // routing), while a genuinely missing /api/* route still 404s correctly.
  if (serveFrontend) {
    const publicDir = path.join(__dirname, '../public');
    if (fs.existsSync(publicDir)) {
      app.register(fastifyStatic, { root: publicDir, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.url && req.raw.url.startsWith('/api/')) {
          return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
        }
        return reply.sendFile('index.html');
      });
    } else {
      app.log.warn('SERVE_FRONTEND is enabled but backend/public was not found — the frontend build step may not have run. See DEPLOYMENT.md.');
    }
  }

  return app;
}

async function main() {
  console.log('[startup] Validating environment configuration...');
  validateEnv();

  console.log('[startup] Building application...');
  const app = buildServer();
  const sweeper = startSessionSweeper();
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? '0.0.0.0';

  const shutdown = async () => {
    app.log.info('Shutting down gracefully...');
    clearInterval(sweeper);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // The HTTP listener binds FIRST, before database migration runs. This is
  // the actual fix for a real deployment defect: the previous order ran
  // `await ensureMigrated()` before `app.listen()`, so if the database was
  // briefly unreachable or slow (e.g. Railway's internal networking not
  // instantly ready right after a fresh deploy, or a misconfigured/SSL-
  // requiring connection string), the connection attempt could hang for a
  // long time with zero log output — and since the port was never bound,
  // Railway's healthcheck against /api/health had nothing to connect to at
  // all, so the deploy failed with "service unavailable" and no application
  // logs whatsoever. Reproduced locally: pointing DATABASE_URL at an
  // unreachable host caused exactly this — indefinite hang, zero output,
  // port never bound.
  //
  // /api/health only reports process liveness, not migration/DB readiness —
  // this is the standard, correct separation (liveness vs. one-time init).
  // Migration still runs automatically on every boot (same self-initializing
  // behavior as before, unchanged logic, just later in the sequence) and is
  // still idempotent/safe to re-run; a failure here is logged loudly but does
  // not kill an otherwise-healthy, already-listening process — any request
  // that actually needs a missing table will surface a clear database error
  // instead of the entire deploy being invisible to Railway.
  await app.listen({ port, host });
  app.log.info(`Server ready — environment=${process.env.NODE_ENV ?? 'development'}, port=${port}, frontend=${process.env.SERVE_FRONTEND !== 'false' ? 'served same-origin' : 'separate deployment'}`);

  console.log('[startup] Server is listening — running database migration check now (does not block health checks)...');
  try {
    await ensureMigrated();
    console.log('[startup] Migration check complete.');
  } catch (err) {
    console.error('[startup] Migration failed — server is still running and reachable, but database operations may fail until this is resolved:', err instanceof Error ? err.message : err);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start server:', err instanceof Error ? err.message : err);
    console.error('Check DATABASE_URL connectivity and required environment variables (see .env.example / DEPLOYMENT.md).');
    process.exit(1);
  });
}
