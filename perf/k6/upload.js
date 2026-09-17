/**
 * Uploads image — à lancer SEUL, VU bas (coût UploadThing + RAM).
 *   k6 run -e BASE_URL=http://localhost:5000/api -e TOKEN=eyJ... perf/k6/upload.js
 */
import http from 'k6/http';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';

const BASE = (__ENV.BASE_URL || 'http://localhost:5000/api').replace(/\/$/, '');
const TOKEN = __ENV.TOKEN || '';

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.2'],
  },
};

export function setup() {
  if (!TOKEN) throw new Error('TOKEN Bearer requis');
  return { token: TOKEN };
}

export default function (data) {
  const png = encoding.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  );
  const res = http.post(
    `${BASE}/upload/image`,
    { file: http.file(png, 'pixel.png', 'image/png') },
    {
      headers: { Authorization: `Bearer ${data.token}` },
      timeout: '30s',
    }
  );
  check(res, { 'upload not 5xx': (r) => r.status < 500 });
  sleep(1);
}
