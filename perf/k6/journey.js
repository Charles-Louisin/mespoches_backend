/**
 * Scénario smoke : health + login + parcours dashboard.
 * Usage :
 *   k6 run -e BASE_URL=http://localhost:5000/api -e EMAIL=... -e PASSWORD=... perf/k6/journey.js
 *   k6 run -e PROFILE=ramp perf/k6/journey.js
 *
 * Ne pas lancer PROFILE=full contre la production : ça peut saturer Railway.
 */
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:5000/api').replace(/\/$/, '');
const PROFILE = __ENV.PROFILE || 'smoke';

const failRate = new Rate('journey_fail');
const dashMs = new Trend('dashboard_ms');

const profiles = {
  smoke: { stages: [{ duration: '20s', target: 10 }], thresholds: { http_req_failed: ['rate<0.05'] } },
  ramp: {
    stages: [
      { duration: '30s', target: 10 },
      { duration: '30s', target: 50 },
      { duration: '30s', target: 100 },
    ],
    thresholds: { http_req_failed: ['rate<0.1'], http_req_duration: ['p(95)<2000'] },
  },
  full: {
    stages: [
      { duration: '30s', target: 10 },
      { duration: '30s', target: 50 },
      { duration: '45s', target: 100 },
      { duration: '45s', target: 250 },
      { duration: '45s', target: 500 },
      { duration: '60s', target: 1000 },
      { duration: '30s', target: 0 },
    ],
    thresholds: { http_req_failed: ['rate<0.15'] },
  },
};

export const options = profiles[PROFILE] || profiles.smoke;

function authHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

export function setup() {
  const email = __ENV.EMAIL;
  const password = __ENV.PASSWORD;
  if (!email || !password) {
    throw new Error('EMAIL et PASSWORD requis (compte de test, pas un admin prod)');
  }
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '15s' }
  );
  const body = res.json();
  if (!body || !body.success || !body.data || !body.data.token) {
    throw new Error(`Login setup failed HTTP ${res.status}: ${res.body}`);
  }
  return { token: body.data.token };
}

export default function (data) {
  const p = authHeaders(data.token);
  p.timeout = '15s';

  group('session', () => {
    const me = http.get(`${BASE}/auth/me`, p);
    failRate.add(me.status !== 200);
    check(me, { 'me 200': (r) => r.status === 200 });
  });

  group('dashboard', () => {
    const started = Date.now();
    const res = http.batch([
      ['GET', `${BASE}/wallets`, null, p],
      ['GET', `${BASE}/wallets/total-balance`, null, p],
      ['GET', `${BASE}/transactions?limit=40`, null, p],
      ['GET', `${BASE}/analytics/current-month`, null, p],
      ['GET', `${BASE}/pending-transactions/count`, null, p],
      ['GET', `${BASE}/categories`, null, p],
      ['GET', `${BASE}/planned-expenses?limit=40`, null, p],
    ]);
    dashMs.add(Date.now() - started);
    for (const r of res) {
      failRate.add(r.status >= 400);
      check(r, { 'dash <400': (x) => x.status < 400 });
    }
  });

  group('historique', () => {
    const hist = http.get(`${BASE}/transactions?limit=50&page=1`, p);
    failRate.add(hist.status !== 200);
    check(hist, { 'tx list 200': (r) => r.status === 200 });
  });

  sleep(1);
}
