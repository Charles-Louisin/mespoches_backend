import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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

const app = express();

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : true;

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI manquant dans les variables d'environnement");
  process.exit(1);
}

app.get('/api/health', (_req, res) => {
  const mongoState = mongoose.connection.readyState;
  const mongoStatus =
    mongoState === 1 ? 'connected' : mongoState === 2 ? 'connecting' : 'disconnected';

  res.json({
    success: true,
    message: 'API MES POCHES opérationnelle',
    env: NODE_ENV,
    mongodb: mongoStatus,
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

function logStartupBanner(mongoOk: boolean): void {
  const line = '─'.repeat(42);

  console.log(`\n${line}`);
  console.log('  MES POCHES — Backend API');
  console.log(line);
  console.log(`  Mode          : ${NODE_ENV}${isProduction ? '' : ' (développement)'}`);
  console.log(`  Port          : ${PORT}`);
  if (process.env.CORS_ORIGIN) {
    console.log(`  CORS          : ${process.env.CORS_ORIGIN}`);
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
  console.log(`${line}\n`);
}

async function connectMongo(): Promise<void> {
  console.log(`\n⏳ Connexion MongoDB (${NODE_ENV})...`);

  try {
    await mongoose.connect(MONGODB_URI!);
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
  await connectMongo();
  logStartupBanner(true);

  app.listen(PORT, () => {
    if (!isProduction) {
      console.log(`👀 Mode ${NODE_ENV} — logs détaillés activés (morgan)\n`);
    }
  });
}

startServer().catch((err) => {
  console.error('❌ Erreur au démarrage du serveur:', err);
  process.exit(1);
});
