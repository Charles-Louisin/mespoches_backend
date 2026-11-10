import path from 'path';
import dns from 'node:dns';
import dotenv from 'dotenv';

/** Charge backend/.env avant tout le reste (override pour éviter les valeurs vides en mémoire). */
dotenv.config({
  path: path.join(__dirname, '..', '.env'),
  override: true,
});

/** Tests locaux : un fichier optionnel (ex. .env.e2e) peut surcharger .env — base isolée, port, etc. */
if (process.env.ENV_OVERRIDE_FILE?.trim()) {
  dotenv.config({ path: path.resolve(process.env.ENV_OVERRIDE_FILE.trim()), override: true });
}

/**
 * Windows / certains FAI refusent querySrv (mongodb+srv) via le DNS système.
 * 8.8.8.8 / 1.1.1.1 résolvent les enregistrements Atlas.
 */
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
