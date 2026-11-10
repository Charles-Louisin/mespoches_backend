/**
 * Nettoyage unique : retire les champs de l'ancien prestataire de paiement des documents
 * SubscriptionPayment et marque leur provider comme « legacy ».
 * Usage : npx tsx src/scripts/purge-legacy-payment-fields.ts            (simulation)
 *         npx tsx src/scripts/purge-legacy-payment-fields.ts --apply    (écrit en base)
 */
import '../loadEnv';
import mongoose from 'mongoose';

const LEGACY_FIELDS = ['cinetpay_transaction_id', 'cinetpay_notify_token', 'cinetpay_status', 'cinetpay_payment_token'];

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI!);
  const col = mongoose.connection.collection('subscriptionpayments');
  const filter = { $or: LEGACY_FIELDS.map((f) => ({ [f]: { $exists: true } })) };
  const count = await col.countDocuments(filter);
  console.log(`Base « ${mongoose.connection.name} » : ${count} paiement(s) avec des champs hérités.`);
  if (apply && count > 0) {
    const unset = Object.fromEntries(LEGACY_FIELDS.map((f) => [f, '']));
    const r = await col.updateMany(filter, { $unset: unset });
    console.log(`Nettoyés : ${r.modifiedCount}`);
  } else if (!apply) {
    console.log('Simulation uniquement — relancez avec --apply pour écrire.');
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
