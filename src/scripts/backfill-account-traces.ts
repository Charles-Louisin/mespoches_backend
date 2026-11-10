/**
 * Une seule fois après déploiement : enregistre les empreintes (email normalisé, Google ID)
 * de tous les comptes vérifiés existants, pour que leur suppression/recréation n'ouvre pas
 * un nouvel essai. Idempotent.
 * Usage : npx tsx src/scripts/backfill-account-traces.ts            (simulation)
 *         npx tsx src/scripts/backfill-account-traces.ts --apply
 */
import '../loadEnv';
import mongoose from 'mongoose';
import User from '../models/User';
import { touchIdentity } from '../utils/accountTrace';

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI!);
  const total = await User.countDocuments({ emailVerified: true });
  console.log(`Base « ${mongoose.connection.name} » : ${total} compte(s) vérifié(s).`);
  if (!apply) {
    console.log('Simulation uniquement — relancez avec --apply pour écrire.');
  } else {
    let done = 0;
    for await (const u of User.find({ emailVerified: true }).select('email googleId').cursor()) {
      await touchIdentity({ email: u.email, googleId: u.googleId ?? null }, true);
      done += 1;
    }
    console.log(`Traces enregistrées : ${done}`);
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
