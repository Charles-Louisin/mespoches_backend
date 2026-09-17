import '../src/loadEnv';
import mongoose from 'mongoose';
import { connectMongo } from '../src/db';
import Transaction from '../src/models/Transaction';
import User from '../src/models/User';
import PendingTransaction from '../src/models/PendingTransaction';
import Wallet from '../src/models/Wallet';

async function explain(label: string, query: { explain: (mode: string) => Promise<unknown> }): Promise<void> {
  const stats = await query.explain('executionStats');
  const exec = (stats as { executionStats?: Record<string, unknown> }).executionStats || stats;
  const winning = (exec as { executionStages?: { stage?: string } }).executionStages;
  console.log(`\n=== ${label} ===`);
  console.log(
    JSON.stringify(
      {
        nReturned: (exec as { nReturned?: number }).nReturned,
        totalDocsExamined: (exec as { totalDocsExamined?: number }).totalDocsExamined,
        totalKeysExamined: (exec as { totalKeysExamined?: number }).totalKeysExamined,
        executionTimeMillis: (exec as { executionTimeMillis?: number }).executionTimeMillis,
        stage: winning?.stage,
      },
      null,
      2
    )
  );
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant');
  await connectMongo(uri);

  const user = await User.findOne().select('_id').lean();
  if (!user) {
    console.log('Aucun utilisateur — explain limité aux indexes.');
  } else {
    const uid = user._id;
    await explain(
      'transactions user+date',
      Transaction.find({ user_id: uid }).sort({ date: -1 }).limit(50)
    );
    await explain(
      'transactions user+type+date',
      Transaction.find({ user_id: uid, type: 'expense' }).sort({ date: -1 }).limit(50)
    );
    await explain(
      'wallets user+not deleted',
      Wallet.find({ user_id: uid, is_deleted: { $ne: true } })
    );
    await explain(
      'pending user+status',
      PendingTransaction.find({ user_id: uid, status: 'pending' }).sort({ created_at: -1 })
    );
    await explain(
      'users lastLogin',
      User.find({ lastLoginAt: { $ne: null } }).sort({ lastLoginAt: -1 }).limit(20)
    );
  }

  const collections = await mongoose.connection.db!.listCollections().toArray();
  console.log('\n=== collections ===');
  console.log(collections.map((c) => c.name).join(', '));

  for (const name of ['users', 'transactions', 'wallets', 'pendingtransactions', 'analyticevents']) {
    try {
      const idx = await mongoose.connection.db!.collection(name).indexes();
      console.log(`\nindexes ${name}:`, idx.map((i) => i.name).join(', '));
    } catch {
      /* collection absente */
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
