/**
 * Health uniquement — utile pour isoler Railway vs Mongo vs auth.
 *   k6 run -e BASE_URL=https://mespochesbackend-production-9bfe.up.railway.app/api -e PROFILE=ramp perf/k6/health.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = (__ENV.BASE_URL || 'http://localhost:5000/api').replace(/\/$/, '');
const PROFILE = __ENV.PROFILE || 'smoke';

const profiles = {
  smoke: { vus: 10, duration: '20s' },
  ramp: {
    stages: [
      { duration: '20s', target: 10 },
      { duration: '20s', target: 50 },
      { duration: '20s', target: 100 },
      { duration: '20s', target: 250 },
    ],
  },
  full: {
    stages: [
      { duration: '20s', target: 10 },
      { duration: '20s', target: 50 },
      { duration: '20s', target: 100 },
      { duration: '20s', target: 250 },
      { duration: '30s', target: 500 },
      { duration: '30s', target: 1000 },
      { duration: '20s', target: 0 },
    ],
  },
};

export const options = {
  ...(profiles[PROFILE] || profiles.smoke),
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<800'],
  },
};

export default function () {
  const res = http.get(`${BASE}/health`, { timeout: '10s' });
  check(res, {
    'health 200': (r) => r.status === 200,
    'mongo connected': (r) => String(r.body).includes('"mongodb":"connected"'),
  });
  sleep(0.2);
}
