# Performances MES POCHES (backend)

Branche : `perf/load-tests`

Objectif : **trouver le goulot (code, Mongo, Railway, réseau, IA)** et optimiser **avant** d’augmenter le plan Railway.

## 1. Variables Expo ↔ Railway

| Mobile (`EXPO_PUBLIC_*`) | Backend Railway | Doit matcher |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `API_PUBLIC_URL` + suffixe `/api` | URL publique HTTPS de l’API |
| `EXPO_PUBLIC_WEB_URL` | `APP_URL` / `CORS_ORIGIN` | Origine du site |
| — | `JWT_SECRET` | Identique Vercel + Railway (12 h) |
| — | `MONGODB_URI` | Cluster Atlas, jamais côté Expo |

Expo ne parle **jamais** à Mongo : uniquement `https://….up.railway.app/api`.

## 2. Mesurer Railway

Dashboard service → **Metrics** :

- CPU % (si ~100 % pendant k6 → code/CPU bound)
- RAM (si OOM / restart → payloads trop gros, pool trop large, JSON 8 Mo)
- Network RX/TX
- Request volume / latence (si exposé)
- Restarts / crash loop

Pendant un test : `GET /api/metrics` avec header `X-Setup-Secret` (même secret que CinetPay setup). Réponse : RSS, heap, p95 par route, pool Mongo, requêtes lentes.

Les routes > 500 ms sont aussi loguées `[slow]`.

## 3. Surveiller MongoDB Atlas

Atlas → cluster → **Metrics** :

- CPU, RAM, Connections (doit rester << 100 ; pool app = 20)
- Opcounters (query / getmore / insert)
- Query Targeting (scanned / returned) : > 100 = index manquant
- Slow queries : Profiler `Profiling Level 1`, threshold 100 ms

Puis en local / one-shot :

```bash
npx tsx perf/explain-indexes.ts
```

On veut `IXSCAN` / `totalDocsExamined ≈ nReturned`, jamais `COLLSCAN` sur `user_id`.

## 4. k6 (charge)

Installer : `winget install Grafana.k6`

Toujours commencer **petit**, observer Railway + Atlas, puis monter.

```bash
# 10 VU — health (prod OK)
k6 run -e BASE_URL=https://mespochesbackend-production-9bfe.up.railway.app/api -e PROFILE=smoke perf/k6/health.js

# Parcours réel (login une fois puis dashboard) — local ou staging
k6 run -e BASE_URL=http://localhost:5000/api -e EMAIL=test@… -e PASSWORD=… -e PROFILE=smoke perf/k6/journey.js

# Montée 10 → 50 → 100
k6 run -e PROFILE=ramp … perf/k6/journey.js

# Uploads séparés (VU bas)
k6 run -e TOKEN=eyJ… -e VUS=5 perf/k6/upload.js
```

`PROFILE=full` (jusqu’à 1000 VU) **uniquement** sur un replica / hors heures, jamais en aveugle sur la prod.

## 5. Protections déjà en place

- 1 pool Mongo par process (`maxPoolSize` 20), `maxTimeMS` 12 s
- Timeout requête HTTP 20 s
- JSON 256 ko par défaut (8 Mo seulement sur scan IA / upload)
- Rate limit global + auth + AI + export
- Pagination `?page=&limit=` (transactions 50/200, pending 50/100, …)
- Projections : pas de `line_items` / `raw_text` / `loginHistory` dans les listes
- Analytics mois en **aggregations** (plus de `find()` de toutes les tx du mois)
- Cache 8 s sur `protect()` (évite 1 `findById` User par requête)
- Cache 30 s admin insights
- Timeout OpenRouter 20 s

## 6. Lire le goulot

| Symptôme | Goulot probable |
|---|---|
| Health p95 bas, journey p95 haut | Code / Mongo des routes métier |
| Health p95 haut, CPU Railway haut | Instance trop petite **après** opti |
| Connections Atlas saturées | Trop d’instances ou pool trop grand |
| Query Targeting élevé | Index manquant |
| 429 RATE_LIMITED | Normal, monter progressivement |
| 503 TIMEOUT sur `/ai-scan` | OpenRouter, tester **sans** IA |
| RAM en dents de scie + restart | Gros JSON / populate trop large |

## 7. Ensuite seulement : scale Railway

Si après opti + indexes, **CPU > 80 % à 100–250 VU** sur le parcours dashboard : passer au plan supérieur. Pas avant.
