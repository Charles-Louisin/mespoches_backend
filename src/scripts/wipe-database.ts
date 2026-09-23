import '../loadEnv';
import { connectMongo } from '../db';
import mongoose from 'mongoose';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI manquant dans backend/.env');
    process.exit(1);
  }
  if (!process.argv.includes('--yes')) {
    console.error('Cette commande efface TOUTES les collections. Relance avec --yes pour confirmer.');
    process.exit(1);
  }

  await connectMongo(uri);
  const name = mongoose.connection.name;
  const db = mongoose.connection.db;
  if (!db) {
    console.error('Connexion Mongo incomplète.');
    process.exit(1);
  }

  const collections = await db.listCollections().toArray();
  console.log(`Vidage de la base « ${name} » (${collections.length} collections)…`);
  await db.dropDatabase();
  console.log(`Base « ${name} » vide. Les prochains inscrits partiront de zéro.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
