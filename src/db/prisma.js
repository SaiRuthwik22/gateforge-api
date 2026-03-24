// ─── Prisma Client Singleton (API) ──────────────────────────────────────────
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['warn', 'error'],
});

process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

// ─── Retry wrapper for Neon cold-start P1001 errors ─────────────────────────
const RETRYABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export async function withRetry(fn, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = RETRYABLE_CODES.has(err?.code);
      if (!isRetryable || attempt === retries) throw err;
      const delay = BASE_DELAY_MS * attempt;
      console.warn(`[prisma] Retryable error ${err.code} on attempt ${attempt}/${retries}. Retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export default prisma;
