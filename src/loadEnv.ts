import path from 'path';
import dotenv from 'dotenv';

/** Charge backend/.env avant tout le reste (override pour éviter les valeurs vides en mémoire). */
dotenv.config({
  path: path.join(__dirname, '..', '.env'),
  override: true,
});
