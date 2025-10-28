import dotenv from 'dotenv';
dotenv.config();

type Env = {
  SERVICE_ACCOUNT_PATH: string;
  FRONTEND_URL: string;
  FRONTEND_BASE_DOMAIN: string;
  CORS_ORIGINS: string; // comma separated
  PORT: number;
  NODE_ENV: string;
  DEBUG_PROXY_ORDER: boolean;
};

const parsePort = (v?: string | number) => {
  if (!v) return 3002;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 3002;
};

export const env: Env = {
  SERVICE_ACCOUNT_PATH:
    process.env.SERVICE_ACCOUNT_PATH || './serviceAccount.json',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  FRONTEND_BASE_DOMAIN: process.env.FRONTEND_BASE_DOMAIN || '',
  CORS_ORIGINS: process.env.CORS_ORIGINS || '',
  PORT: parsePort(process.env.C_PORT),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DEBUG_PROXY_ORDER: process.env.DEBUG_PROXY_ORDER === '1' || false,
};

export const isDev = env.NODE_ENV !== 'production';

export function parseOrigins(orig?: string) {
  if (!orig) return [] as string[];
  return orig
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default env;
