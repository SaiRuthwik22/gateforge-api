// ─── Redis Cache (API) ──────────────────────────────────────────────────────
// Reads question cache for serving. Handles cache miss → DB → re-seed.

import Redis from 'ioredis';
import prisma from '../db/prisma.js';

let redis = null;

/**
 * Get or create Redis connection
 */
export function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null; // Stop retrying after 3 attempts
        return 2000;
      },
      retryDelayOnFailover: 1000,
      lazyConnect: true,
      tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined
    });

    redis.on('error', (err) => {
      console.error('[Redis] Error:', err.message);
    });
  }
  return redis;
}

/**
 * Connect Redis
 */
export async function connectRedis() {
  const r = getRedis();
  if (r.status === 'wait') {
    await r.connect();
  }
  return r;
}

/**
 * Get questions for a set (without answers) — for GET /paper/:setNumber
 */
export async function getSetQuestions(setNumber) {
  const r = getRedis();

  try {
    // Try Redis cache first
    const cached = await r.get(`set:${setNumber}:questions`);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    console.warn('[Redis] Cache read failed, falling back to DB:', err.message);
  }

  // Cache miss: query DB
  const questions = await prisma.question.findMany({
    where: { set_number: setNumber, is_staged: false, is_active: true },
    select: {
      id: true,
      set_number: true,
      subject: true,
      topic: true,
      subtopic: true,
      difficulty: true,
      marks: true,
      question_type: true,
      question_text: true,
      options: true,
      diagram: true,
      negative_marks: true
      // NO correct_answer, NO explanation — never expose in GET
    },
    orderBy: [{ subject: 'asc' }, { marks: 'asc' }]
  });

  if (questions.length === 0) return null;

  // Re-seed Redis
  try {
    await r.set(`set:${setNumber}:questions`, JSON.stringify(questions), 'EX', 86400);
  } catch (err) {
    console.warn('[Redis] Cache write failed:', err.message);
  }

  return questions;
}

/**
 * Get full questions with answers — for scoring after POST /submit
 */
export async function getSetQuestionsWithAnswers(setNumber) {
  const r = getRedis();

  try {
    const cached = await r.get(`set:${setNumber}:answers`);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    console.warn('[Redis] Answers cache read failed:', err.message);
  }

  // Cache miss: full query
  const questions = await prisma.question.findMany({
    where: { set_number: setNumber, is_staged: false, is_active: true },
    orderBy: [{ subject: 'asc' }, { marks: 'asc' }]
  });

  if (questions.length === 0) return null;

  try {
    await r.set(`set:${setNumber}:answers`, JSON.stringify(questions), 'EX', 86400);
  } catch (err) {
    console.warn('[Redis] Answers cache write failed:', err.message);
  }

  return questions;
}

/**
 * Get set metadata
 */
export async function getSetMeta(setNumber) {
  const r = getRedis();

  try {
    const cached = await r.get(`set:${setNumber}:meta`);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    console.warn('[Redis] Meta cache read failed:', err.message);
  }

  const mockSet = await prisma.mockSet.findUnique({
    where: { set_number: setNumber }
  });

  if (mockSet) {
    try {
      await r.set(`set:${setNumber}:meta`, JSON.stringify(mockSet), 'EX', 86400);
    } catch (err) { /* ignore */ }
  }

  return mockSet;
}

/**
 * Set active browser session in Redis (3h TTL)
 */
export async function setActiveSession(browserId, data) {
  const r = getRedis();
  await r.set(`browser:${browserId}:active`, JSON.stringify(data), 'EX', 10800); // 3 hours
}

/**
 * Get active browser session
 */
export async function getActiveSession(browserId) {
  const r = getRedis();
  const data = await r.get(`browser:${browserId}:active`);
  return data ? JSON.parse(data) : null;
}

/**
 * Delete active browser session
 */
export async function deleteActiveSession(browserId) {
  const r = getRedis();
  await r.del(`browser:${browserId}:active`);
}
