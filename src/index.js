// ─── API Entry Point ────────────────────────────────────────────────────────
// Fastify server with cookie support, CORS, and all routes.

import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import healthRoutes from './routes/health.js';
import setsRoutes from './routes/sets.js';
import attemptsRoutes from './routes/attempts.js';
import chatRoutes from './routes/chat.js';
import { connectRedis } from './cache/redis.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       GATEForge API — Starting...        ║');
  console.log('╚══════════════════════════════════════════╝');

  const app = Fastify({ logger: true });

  // ─── Plugins ───────────────────────────────────────────────
  await app.register(cors, {
    origin: true,  // Allow all origins in dev; restrict in production
    credentials: true
  });

  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET || 'gateforge-default-secret',
    parseOptions: {}
  });

  // ─── Routes ────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(setsRoutes);
  await app.register(attemptsRoutes);
  await app.register(chatRoutes);

  // ─── Connect Redis ─────────────────────────────────────────
  try {
    await connectRedis();
    console.log('[Boot] Redis connected');
  } catch (err) {
    console.warn('[Boot] Redis connection failed (will use DB fallback):', err.message);
  }

  // ─── Start Server ──────────────────────────────────────────
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`\n[Boot] ✓ GATEForge API listening on port ${PORT}\n`);

    // ─── Render Keep-Alive Self-Ping ─────────────────────────
    const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
    if (externalUrl) {
      console.log(`[Boot] Setup keep-alive ping to ${externalUrl}/health every 14 mins`);
      setInterval(() => {
        fetch(`${externalUrl}/health`)
          .then(res => console.log(`[Keep-Alive] Pinged ${externalUrl}/health. Status: ${res.status}`))
          .catch(err => console.error('[Keep-Alive] Self-ping failed:', err.message));
      }, 14 * 60 * 1000);
    } else {
      console.log('[Boot] No RENDER_EXTERNAL_URL or KEEP_ALIVE_URL set. Self-ping disabled.');
    }
    
  } catch (err) {
    console.error('[Boot] Fatal error:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main();
