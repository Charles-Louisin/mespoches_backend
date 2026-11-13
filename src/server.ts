import './loadEnv';
import express from 'express';
import cluster from 'cluster';
import os from 'os';
import compression from 'compression';
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
import feedbackRoutes from './routes/feedbackRoutes';
import appVersionRoutes from './routes/appVersionRoutes';
import adminReleaseRoutes from './routes/adminReleaseRoutes';
import { startPlannedExpenseScheduler } from './jobs/plannedExpenseScheduler';
import { startGoalTipsScheduler } from './jobs/goalTipsScheduler';
import { fundingWatchMiddleware } from './services/fundingWatch';
import { assertSetupAccess } from './utils/setupAccess';
import { sanitizeMongoKeys } from './middleware/sanitize';
import { apiLimiter } from './utils/security';
import { detectServerPublicIp, isSasPayConfigured, isSasPayLive } from './utils/saspay';
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

if ((process.env.NODE_ENV || "development") === "production" && (process.env.JWT_SECRET || "").trim().length < 32) {
  console.error("❌ JWT_SECRET trop court en production (32 caractères minimum)");
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
// Réponses JSON compressées (listes de transactions, analyses) : beaucoup moins de données sur le réseau mobile.
app.use(compression({ threshold: 1024 }));

// Corps brut conservé pour les webhooks signés (HMAC calculé sur les octets reçus, jamais re-sérialisés).
const jsonSmall = express.json({
  limit: '256kb',
  verify: (req, _res, buf) => {
    const url = ((req as express.Request).originalUrl || req.url || '').split('?')[0];
    if (url.includes('/webhooks/')) (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  },
});
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
// Après chaque écriture : dépenses futures devenues réglables, objectifs devenus réalisables (push).
app.use(fundingWatchMiddleware);

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

  res.json({ ...payload, process: { rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) } });
});

/** Métriques process + temps par route — protégé (secret ops OPS_SETUP_SECRET). */
app.get('/api/metrics', (req, res) => {
  if (!assertSetupAccess(req, res)) return;
  res.json({ success: true, data: { ...metricsSnapshot(), mongo: mongoPoolStats() } });
});

/** IP sortante à whitelister chez SasPay — protégé (secret ops OPS_SETUP_SECRET) */
app.get('/api/saspay-setup', async (req, res) => {
  if (!assertSetupAccess(req, res)) return;
  const ip = await detectServerPublicIp();
  res.json({
    success: true,
    data: {
      ...ip,
      whitelist: 'app.saspay.me → Développeur → IP Whitelist',
      saspayConfigured: isSasPayConfigured(),
      saspayMode: isSasPayConfigured() ? (isSasPayLive() ? 'live' : 'test') : null,
      webhookSecretConfigured: Boolean(process.env.SASPAY_WEBHOOK_SECRET?.trim()),
    },
  });
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
// Alias sans /api : URL configurée dans le tableau de bord SasPay (…/webhooks/saspay)
app.use('/webhooks', webhookRoutes);
app.use('/api/planned-expenses', plannedExpenseRoutes);
app.use('/api/pending-transactions', pendingTransactionRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/app', appVersionRoutes);
app.use('/api/admin/app-release', adminReleaseRoutes);

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
  console.log(
    `  SasPay        : ${isSasPayConfigured() ? `✅ configuré (${isSasPayLive() ? 'live' : 'test'})` : '⚠️  SASPAY_SECRET_KEY manquant'}`
  );
  if (process.env.API_PUBLIC_URL) {
    console.log(`  Webhook       : ${process.env.API_PUBLIC_URL.replace(/\/$/, '').replace(/\/api$/, '')}/webhooks/saspay`);
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

  const server = app.listen(PORT, () => {
    startPlannedExpenseScheduler();
    startGoalTipsScheduler();
    void logPublicIp();
    if (!isProduction) {
      console.log(`👀 Mode ${NODE_ENV} — logs détaillés activés (morgan)\n`);
    }
  });
  // Connexions keep-alive gardées plus longtemps que celles du proxy (évite les 502 sous charge).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.maxConnections = Number(process.env.MAX_CONNECTIONS || 0) || server.maxConnections;
}

/** Affiche l'IP publique sortante au démarrage (local comme Railway) pour la whitelist SasPay. */
async function logPublicIp(): Promise<void> {
  const { ipv4, ipv6, source } = await detectServerPublicIp();
  const mode = isSasPayConfigured() ? (isSasPayLive() ? 'live' : 'test') : 'non configuré';
  console.log('──────────────────────────────────────────');
  console.log('  🌍 IP PUBLIQUE SORTANTE (whitelist SasPay)');
  if (ipv4 || ipv6) {
    if (ipv4) console.log(`     IPv4 : ${ipv4}`);
    if (ipv6) console.log(`     IPv6 : ${ipv6}`);
    console.log(`     source : ${source ?? 'api64.ipify.org'}`);
    console.log('     → app.saspay.me › Développeur › IP Whitelist');
  } else {
    console.log('     ⚠️  introuvable (pas d’accès Internet sortant ?)');
  }
  console.log(`  SasPay        : ${mode}${process.env.SASPAY_WEBHOOK_SECRET?.trim() ? ' · webhook signé ✅' : ' · ⚠️ SASPAY_WEBHOOK_SECRET manquant'}`);
  console.log('──────────────────────────────────────────\n');
}

/**
 * WEB_CONCURRENCY=n (ou « auto ») : un processus par cœur, le port partagé par le module cluster.
 * Les tâches planifiées sont protégées par des verrous Mongo : aucune ne tourne en double.
 */
const workers =
  process.env.WEB_CONCURRENCY === 'auto'
    ? os.availableParallelism()
    : Math.max(1, Number(process.env.WEB_CONCURRENCY) || 1);

if (workers > 1 && cluster.isPrimary) {
  console.log(`🧵 ${workers} processus (WEB_CONCURRENCY)`);
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    console.warn(`⚠️  Processus ${worker.process.pid} arrêté (code ${code}), redémarrage`);
    cluster.fork();
  });
} else {
  startServer().catch((err) => {
    console.error('❌ Erreur au démarrage du serveur:', err);
    process.exit(1);
  });
}
