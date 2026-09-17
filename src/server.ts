import './loadEnv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import authRoutes from './routes/authRoutes';
import walletRoutes from './routes/walletRoutes';
import transactionRoutes from './routes/transactionRoutes';
import categoryRoutes from './routes/categoryRoutes';
import analyticsRoutes from './routes/analyticsRoutes';
import adminRoutes from './routes/adminRoutes';
import budgetRoutes from './routes/budgetRoutes';
import savingsGoalRoutes from './routes/savingsGoalRoutes';
import recurringRoutes from './routes/recurringRoutes';
import exportRoutes from './routes/exportRoutes';
import subscriptionRoutes from './routes/subscriptionRoutes';
import webhookRoutes from './routes/webhookRoutes';
import plannedExpenseRoutes from './routes/plannedExpenseRoutes';
import pendingTransactionRoutes from './routes/pendingTransactionRoutes';
import uploadRoutes from './routes/uploadRoutes';
import telemetryRoutes from './routes/telemetryRoutes';
import { startPlannedExpenseScheduler } from './jobs/plannedExpenseScheduler';
import {
  getCinetPayEnvironment,
  getCinetPaySetupPayload,
  isCinetPayConfigured,
} from './utils/cinetpay';
import { assertSetupAccess } from './utils/setupAccess';
import { sanitizeMongoKeys } from './middleware/sanitize';
import { apiLimiter } from './utils/security';
import { connectMongo as openMongoPool, mongoPoolStats } from './db';
import { metricsSnapshot, requestMetrics, requestTimeout } from './middleware/requestMetrics';

const app = express();

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI manquant dans les variables d'environnement");
  process.exit(1);
}

if (!process.env.JWT_SECRET?.trim()) {
  console.error("❌ JWT_SECRET manquant dans les variables d'environnement");
  process.exit(1);
}

// Requis derrière Render / ngrok / reverse-proxy pour IP réelle + rate-limit
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    frameguard: { action: 'deny' },
  })
);

const configuredOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (isProduction && configuredOrigins.length === 0) {
  console.error(
    '❌ CORS_ORIGIN obligatoire en production (liste d’origines séparées par des virgules)'
  );
  process.exit(1);
}

/** Domaines que nous possédons. Tout le reste passe par CORS_ORIGIN. */
function isOwnedOrigin(host: string): boolean {
  if (host === 'mespoches.store' || host.endsWith('.mespoches.store')) return true;
  if (host === 'mespoches.vercel.app') return true;
  return false;
}

/** Hôtes de développement (jamais autorisés en production). */
function isDevOrigin(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return true;
  if (host.endsWith('.exp.direct') || host.endsWith('.expo.dev')) return true;
  if (host === 'auth.expo.io') return true;
  return false;
}

function isAllowedCorsOrigin(origin: string): boolean {
  if (configuredOrigins.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (isOwnedOrigin(host)) return true;
    if (!isProduction && isDevOrigin(host)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (!isProduction && configuredOrigins.length === 0) {
        callback(null, true);
        return;
      }
      if (isAllowedCorsOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  })
);
app.use(requestTimeout);
app.use(requestMetrics);

const jsonSmall = express.json({ limit: '256kb' });
const jsonLarge = express.json({ limit: '8mb' });
app.use((req, res, next) => {
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('multipart/form-data')) return next();
  const path = (req.originalUrl || req.url || '').split('?')[0];
  const large =
    path.endsWith('/ai-scan') ||
    path.endsWith('/voice-note') ||
    path.includes('/upload');
  return (large ? jsonLarge : jsonSmall)(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(sanitizeMongoKeys);
app.use(apiLimiter);

app.use(
  morgan(isProduction ? 'combined' : 'dev', {
    skip: (req) =>
      /[?&](notify_token|secret)=/i.test(req.originalUrl || req.url || ''),
  })
);

app.get('/api/health', async (req, res) => {
  const mongoState = mongoose.connection.readyState;
  const mongoStatus =
    mongoState === 1 ? 'connected' : mongoState === 2 ? 'connecting' : 'disconnected';

  const payload: Record<string, unknown> = {
    success: true,
    message: 'API MES POCHES opérationnelle',
    mongodb: mongoStatus,
  };
  if (!isProduction) {
    payload.env = NODE_ENV;
  }

  // Détails CinetPay uniquement avec secret ops
  if (req.query.cinetpay === '1' || req.query.cinetpay === 'true') {
    if (!assertSetupAccess(req, res)) return;
    payload.cinetpayEnv = getCinetPayEnvironment();
    payload.cinetpayConfigured = isCinetPayConfigured();
    payload.cinetpay = await getCinetPaySetupPayload();
  }

  res.json({ ...payload, process: { rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) } });
});

/** Métriques process + temps par route — protégé (même secret que CinetPay setup). */
app.get('/api/metrics', (req, res) => {
  if (!assertSetupAccess(req, res)) return;
  res.json({ success: true, data: { ...metricsSnapshot(), mongo: mongoPoolStats() } });
});

/** Alias racine — IP à whitelister (sandbox ou prod) — protégé */
app.get('/api/cinetpay-setup', async (req, res) => {
  if (!assertSetupAccess(req, res)) return;
  const data = await getCinetPaySetupPayload();
  res.json({ success: true, data });
});

app.use('/api/auth', authRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/savings-goals', savingsGoalRoutes);
app.use('/api/recurring', recurringRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/planned-expenses', plannedExpenseRoutes);
app.use('/api/pending-transactions', pendingTransactionRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/telemetry', telemetryRoutes);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('Erreur non gérée:', err instanceof Error ? err.message : err);
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      message: 'Erreur serveur',
    });
  }
);

function logStartupBanner(mongoOk: boolean): void {
  const line = '─'.repeat(42);

  console.log(`\n${line}`);
  console.log('  MES POCHES — Backend API');
  console.log(line);
  console.log(`  Mode          : ${NODE_ENV}${isProduction ? '' : ' (développement)'}`);
  console.log(`  Port          : ${PORT}`);
  if (configuredOrigins.length > 0) {
    console.log(`  CORS          : ${configuredOrigins.join(', ')}`);
  } else {
    console.log(`  CORS          : permissif (dev uniquement)`);
  }
  if (process.env.APP_URL) {
    console.log(`  Frontend URL  : ${process.env.APP_URL}`);
  }
  const googleOk = Boolean(process.env.GOOGLE_CLIENT_ID?.trim());
  console.log(
    `  Google OAuth  : ${googleOk ? '✅ configuré' : '⚠️  GOOGLE_CLIENT_ID manquant'}`
  );
  const uploadOk = Boolean(process.env.UPLOADTHING_TOKEN?.trim());
  console.log(
    `  UploadThing   : ${uploadOk ? '✅ configuré' : '⚠️  UPLOADTHING_TOKEN manquant'}`
  );
  const cinetpayOk = Boolean(
    (process.env.CINETPAY_ACCOUNT_KEY || process.env.CINETPAY_API_KEY)?.trim() &&
      (process.env.CINETPAY_ACCOUNT_PASSWORD || process.env.CINETPAY_API_PASSWORD)?.trim()
  );
  const cinetpayEnv =
    process.env.CINETPAY_ENV?.trim().toLowerCase() ||
    (isProduction ? 'production (auto)' : 'sandbox (auto)');
  console.log(
    `  CinetPay      : ${cinetpayOk ? `✅ configuré (${cinetpayEnv})` : '⚠️  non configuré'}`
  );
  if (cinetpayOk) {
    console.log(`  CinetPay API  : ${getCinetPayEnvironment() === 'production' ? 'api.cinetpay.co' : 'api.cinetpay.net (sandbox)'}`);
  }
  if (cinetpayOk && process.env.API_PUBLIC_URL) {
    console.log(`  Webhook IPN   : ${process.env.API_PUBLIC_URL.replace(/\/$/, '')}/api/webhooks/cinetpay`);
    console.log(`  IP whitelist  : GET …/api/cinetpay-setup (avec CINETPAY_SETUP_SECRET)`);
  }

  if (mongoOk) {
    const { host, name, port } = mongoose.connection;
    console.log(`  MongoDB       : ✅ connecté`);
    console.log(`    └─ Hôte     : ${host}${port ? `:${port}` : ''}`);
    console.log(`    └─ Base     : ${name || '(non spécifiée)'}`);
  } else {
    console.log(`  MongoDB       : ❌ non connecté`);
  }

  console.log(`  Serveur       : http://localhost:${PORT}`);
  console.log(`  Health check  : http://localhost:${PORT}/api/health`);
  console.log(`  Metrics (ops) : http://localhost:${PORT}/api/metrics`);
  console.log(`${line}\n`);
}

async function connectDatabase(): Promise<void> {
  console.log(`\n⏳ Connexion MongoDB (${NODE_ENV})...`);

  try {
    await openMongoPool(MONGODB_URI!);
    console.log('✅ MongoDB connecté avec succès');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Échec de connexion MongoDB:', message);
    process.exit(1);
  }
}

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB déconnecté');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnecté');
});

async function startServer(): Promise<void> {
  await connectDatabase();
  logStartupBanner(true);

  app.listen(PORT, () => {
    startPlannedExpenseScheduler();
    if (!isProduction) {
      console.log(`👀 Mode ${NODE_ENV} — logs détaillés activés (morgan)\n`);
    }
  });
}

startServer().catch((err) => {
  console.error('❌ Erreur au démarrage du serveur:', err);
  process.exit(1);
});
