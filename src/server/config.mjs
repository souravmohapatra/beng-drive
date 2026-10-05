import { isIP } from 'node:net';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const integerDefaults = {
  FILE_MAX_BYTES: 10000000000,
  DEFAULT_ALLOWANCE_BYTES: 10000000000,
  FREE_SPACE_FLOOR_BYTES: 10000000000,
  COLLECTION_MAX_FILES: 1000,
  COLLECTION_DEFAULT_TTL_SECONDS: 604800,
  UPLOAD_CHUNK_MAX_BYTES: 10485760,
  SESSION_ACTIVE_TRANSFERS: 2,
  CLEANUP_INTERVAL_SECONDS: 3600,
  PARTIAL_IDLE_SECONDS: 172800,
};

function invalid(name) {
  const error = new Error(`Invalid configuration: ${name}`);
  error.setting = name;
  throw error;
}
function origin(value, name) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid(name);
    return url.origin;
  } catch { invalid(name); }
}
function number(value, name, fallback) {
  const raw = value === undefined ? String(fallback) : value;
  if (!/^(0|[1-9]\d*)$/.test(raw)) invalid(name);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) invalid(name);
  return parsed;
}
export function normalizeIP(value = '') {
  return value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}
export function configFrom(env = process.env) {
  const fixture = env.APP_MODE === 'fixture';
  if (env.APP_MODE && env.APP_MODE !== 'fixture' && env.APP_MODE !== 'production') invalid('APP_MODE');
  if (fixture && env.NODE_ENV === 'production') invalid('APP_MODE');
  const owner = env.ADMIN_OWNER_LOGIN || '';
  if (!fixture && !owner) invalid('ADMIN_OWNER_LOGIN');
  if (owner && (owner.trim() !== owner || /[\s\x00-\x1f]/.test(owner))) invalid('ADMIN_OWNER_LOGIN');
  const peer = normalizeIP(env.TRUSTED_ADMIN_PROXY_IP || '');
  if (peer && !isIP(peer)) invalid('TRUSTED_ADMIN_PROXY_IP');
  const dbPath = env.DB_PATH || '';
  if (!isAbsolute(dbPath) || dbPath === '/data' || dbPath.startsWith(`/data${sep}`) || resolve(dbPath) !== dbPath) invalid('DB_PATH');
  const adminSocketPath = env.ADMIN_SOCKET_PATH || '';
  if (!fixture && (peer || !adminSocketPath)) invalid('ADMIN_SOCKET_PATH');
  if (adminSocketPath && (!isAbsolute(adminSocketPath) || resolve(adminSocketPath) !== adminSocketPath || dirname(adminSocketPath) !== dirname(dbPath) || adminSocketPath === dbPath)) invalid('ADMIN_SOCKET_PATH');
  const host = env.HOST_BIND || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') invalid('HOST_BIND');
  if (host === '0.0.0.0' && env.CONTAINER_BIND !== '1') invalid('HOST_BIND');
  const limits = Object.fromEntries(Object.entries(integerDefaults).map(([key, fallback]) => [key, number(env[key], key, fallback)]));
  if (limits.DEFAULT_ALLOWANCE_BYTES < limits.FILE_MAX_BYTES || limits.UPLOAD_CHUNK_MAX_BYTES > 10485760 || limits.UPLOAD_CHUNK_MAX_BYTES > limits.FILE_MAX_BYTES || limits.SESSION_ACTIVE_TRANSFERS > 10 || limits.CLEANUP_INTERVAL_SECONDS > 3600) invalid('limits');
  if (Date.now() + limits.COLLECTION_DEFAULT_TTL_SECONDS * 1000 > 8640000000000000) invalid('COLLECTION_DEFAULT_TTL_SECONDS');
  const publicOrigin = origin(env.PUBLIC_ORIGIN || '', 'PUBLIC_ORIGIN');
  const adminOrigin = origin(env.ADMIN_ORIGIN || '', 'ADMIN_ORIGIN');
  if (publicOrigin === adminOrigin) invalid('ADMIN_ORIGIN');
  return {
    fixture, owner, peer, dbPath, adminSocketPath, host, limits,
    publicOrigin, adminOrigin,
    guestPort: number(env.GUEST_PORT, 'GUEST_PORT', 4310),
    adminPort: number(env.ADMIN_PORT, 'ADMIN_PORT', 4311),
  };
}
