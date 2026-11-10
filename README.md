# MES POCHES — Backend API

API Express déployée séparément du frontend Next.js.

## Scripts

- `npm run dev` — développement (nodemon)
- `npm run build` — compile TypeScript vers `dist/`
- `npm start` — production (`node dist/server.js`)

## Render

| Paramètre | Valeur |
|-----------|--------|
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Health Check | `/api/health` |

Copiez `.env.example` dans les variables d'environnement Render.

## Paiement Premium (SasPay)

1. Renseignez `SASPAY_SECRET_KEY` (`sk_test_…` en recette, `sk_live_…` en production) et `SASPAY_WEBHOOK_SECRET` dans `backend/.env`
2. `APP_URL` = URL du site (page de retour `/paiement/retour`, ex. `https://www.mespoches.store`)
3. Webhook à déclarer dans app.saspay.me : `{API}/webhooks/saspay` (événements `transaction.success`, `transaction.failed`)
4. Frais : `fee_charge_mode=ADD_ON` — le client paie les frais, le marchand reçoit le prix affiché
5. IP sortante (whitelist SasPay) : affichée au démarrage, ou `GET /api/saspay-setup` avec le header `X-Setup-Secret: $OPS_SETUP_SECRET`

Routes : `GET /api/subscription/plans`, `POST /api/subscription/checkout`, `GET /api/subscription/verify`, `GET /api/subscription/return-status`, `POST /webhooks/saspay`
