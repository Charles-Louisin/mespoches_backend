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
