import mongoose from 'mongoose';

const QUERY_MAX_MS = Number(process.env.MONGO_QUERY_MAX_MS || 12_000);
const POOL_MAX = Number(process.env.MONGO_POOL_SIZE || 20);
const POOL_MIN = Number(process.env.MONGO_MIN_POOL_SIZE || 2);

/** Une seule connexion partagée (pool) pour tout le process — jamais de connect() par requête. */
export async function connectMongo(uri: string): Promise<void> {
  mongoose.set('strictQuery', true);
  mongoose.set('maxTimeMS', QUERY_MAX_MS);
  mongoose.set('bufferTimeoutMS', 10_000);

  await mongoose.connect(uri, {
    maxPoolSize: POOL_MAX,
    minPoolSize: POOL_MIN,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 8_000,
    socketTimeoutMS: 20_000,
    connectTimeoutMS: 10_000,
    family: 4,
    retryWrites: true,
  });
}

export function mongoPoolStats(): Record<string, unknown> {
  const conn = mongoose.connection;
  const client = conn.getClient?.();
  const pool = (
    client as unknown as {
      topology?: { s?: { pool?: { totalConnectionCount?: number; availableConnectionCount?: number; waitQueueSize?: number } } };
    }
  )?.topology?.s?.pool;

  return {
    readyState: conn.readyState,
    host: conn.host,
    name: conn.name,
    poolMax: POOL_MAX,
    poolMin: POOL_MIN,
    queryMaxMs: QUERY_MAX_MS,
    totalConnections: pool?.totalConnectionCount ?? null,
    availableConnections: pool?.availableConnectionCount ?? null,
    waitQueue: pool?.waitQueueSize ?? null,
  };
}
