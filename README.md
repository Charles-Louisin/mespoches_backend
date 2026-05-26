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

## Paiement Premium (CinetPay)

1. Renseignez `CINETPAY_API_KEY` et `CINETPAY_SITE_ID` dans `backend/.env`
2. `APP_URL` = URL du frontend (ex. `http://localhost:3000`)
3. `API_PUBLIC_URL` = URL publique de cette API (webhook : `{API_PUBLIC_URL}/api/webhooks/cinetpay`)
4. En local, le webhook CinetPay nécessite une URL accessible depuis Internet (ex. [ngrok](https://ngrok.com) sur le port 5000)

Routes : `GET /api/subscription/plans`, `POST /api/subscription/checkout`, `GET /api/subscription/verify`, `POST /api/webhooks/cinetpay`
