// ─── Attempts Routes ────────────────────────────────────────────────────────
// POST /submit — submit answers, score server-side, save attempt
// GET /attempts — get attempt history for a browser

import prisma, { withRetry } from '../db/prisma.js';
import { getSetQuestionsWithAnswers, setActiveSession, deleteActiveSession } from '../cache/redis.js';
import { calculateScore } from '../services/scoring.js';
import {
  readBrowserCookie, ensureBrowserCookie,
  readDailyCookie, setDailyCookie, getISTDateString
} from '../services/cookies.js';

export default async function attemptsRoutes(app) {

  // ─── POST /submit ─── submit answers and get scored result
  app.post('/submit', async (request, reply) => {
    const { setNumber, answers, timeTakenSeconds } = request.body || {};

    if (!setNumber || !answers) {
      return reply.status(400).send({ error: 'setNumber and answers are required' });
    }

    // Get browserId
    const browserData = ensureBrowserCookie(request, reply);
    const browserId = browserData.browserId;
    const attemptDate = getISTDateString();

    // Check for duplicate attempt
    const existingAttempt = await withRetry(() => prisma.browserAttempt.findUnique({
      where: {
        browser_id_set_number_attempt_date: {
          browser_id: browserId,
          set_number: setNumber,
          attempt_date: attemptDate
        }
      }
    }));

    if (existingAttempt && existingAttempt.status === 'completed') {
      return reply.status(409).send({
        error: 'You have already completed this set today.',
        existingScore: existingAttempt.score
      });
    }

    // Get full questions with answers for scoring
    const questions = await getSetQuestionsWithAnswers(setNumber);
    if (!questions || questions.length === 0) {
      return reply.status(404).send({ error: `Set ${setNumber} not found or not ready.` });
    }

    // Calculate score server-side (NEVER trust client)
    const result = calculateScore(questions, answers);

    // Upsert attempt (update if in_progress, create if new)
    const attempt = await withRetry(() => prisma.browserAttempt.upsert({
      where: {
        browser_id_set_number_attempt_date: {
          browser_id: browserId,
          set_number: setNumber,
          attempt_date: attemptDate
        }
      },
      update: {
        status: 'completed',
        completed_at: new Date(),
        time_taken_secs: timeTakenSeconds || null,
        score: result.score,
        correct_count: result.correctCount,
        wrong_count: result.wrongCount,
        skipped_count: result.skippedCount,
        answers: answers
      },
      create: {
        browser_id: browserId,
        set_number: setNumber,
        attempt_date: attemptDate,
        status: 'completed',
        started_at: new Date(),
        completed_at: new Date(),
        time_taken_secs: timeTakenSeconds || null,
        score: result.score,
        correct_count: result.correctCount,
        wrong_count: result.wrongCount,
        skipped_count: result.skippedCount,
        answers: answers
      }
    }));

    // Update daily cookie
    setDailyCookie(reply, {
      date: attemptDate,
      setAttempted: setNumber,
      status: 'completed',
      score: result.score,
      startedAt: attempt.started_at?.toISOString(),
      completedAt: new Date().toISOString(),
      timeTakenSeconds: timeTakenSeconds || 0
    });

    // Clean up active session
    await deleteActiveSession(browserId);

    return {
      attemptId: attempt.id,
      score: result.score,
      totalMarks: result.totalMarks,
      correctCount: result.correctCount,
      wrongCount: result.wrongCount,
      skippedCount: result.skippedCount,
      totalQuestions: result.totalQuestions,
      subjectBreakdown: result.subjectBreakdown,
      questionsWithAnswers: result.questionsWithResults
    };
  });

  // ─── POST /attempts/start ─── start a new attempt
  app.post('/attempts/start', async (request, reply) => {
    const { setNumber } = request.body || {};

    if (!setNumber) {
      return reply.status(400).send({ error: 'setNumber is required' });
    }

    const browserData = ensureBrowserCookie(request, reply);
    const browserId = browserData.browserId;
    const attemptDate = getISTDateString();

    // Check for existing attempt today
    const existing = await withRetry(() => prisma.browserAttempt.findUnique({
      where: {
        browser_id_set_number_attempt_date: {
          browser_id: browserId,
          set_number: setNumber,
          attempt_date: attemptDate
        }
      }
    }));

    if (existing) {
      if (existing.status === 'completed') {
        return reply.status(409).send({ error: 'Already completed this set today.', attemptId: existing.id });
      }
      // Resume in_progress attempt
      return {
        attemptId: existing.id,
        startedAt: existing.started_at,
        expiresAt: new Date(existing.started_at.getTime() + 180 * 60 * 1000),
        resumed: true
      };
    }

    // Create new attempt
    const attempt = await withRetry(() => prisma.browserAttempt.create({
      data: {
        browser_id: browserId,
        set_number: setNumber,
        attempt_date: attemptDate,
        status: 'in_progress',
        started_at: new Date()
      }
    }));

    // Store active session in Redis (3h TTL)
    await setActiveSession(browserId, {
      attemptId: attempt.id,
      setNumber,
      startedAt: attempt.started_at.toISOString()
    });

    // Update daily cookie
    setDailyCookie(reply, {
      date: attemptDate,
      setAttempted: setNumber,
      status: 'in_progress',
      startedAt: attempt.started_at.toISOString()
    });

    return {
      attemptId: attempt.id,
      startedAt: attempt.started_at,
      expiresAt: new Date(attempt.started_at.getTime() + 180 * 60 * 1000),
      resumed: false
    };
  });

  // ─── PATCH /attempts/:attemptId/progress ─── autosave answers
  app.patch('/attempts/:attemptId/progress', async (request, reply) => {
    const { attemptId } = request.params;
    const { answers, lastQuestionIndex, timeTakenSeconds } = request.body || {};

    const browserData = readBrowserCookie(request);
    if (!browserData) {
      return reply.status(401).send({ error: 'No browser identity found' });
    }

    // Verify attempt belongs to this browser
    const attempt = await withRetry(() => prisma.browserAttempt.findUnique({
      where: { id: attemptId }
    }));

    if (!attempt || attempt.browser_id !== browserData.browserId) {
      return reply.status(404).send({ error: 'Attempt not found' });
    }

    if (attempt.status === 'completed') {
      return reply.status(400).send({ error: 'Attempt already completed' });
    }

    // Update progress
    await withRetry(() => prisma.browserAttempt.update({
      where: { id: attemptId },
      data: {
        answers: answers || attempt.answers,
        time_taken_secs: timeTakenSeconds || attempt.time_taken_secs
      }
    }));

    // Update active session in Redis
    await setActiveSession(browserData.browserId, {
      attemptId,
      setNumber: attempt.set_number,
      startedAt: attempt.started_at.toISOString(),
      lastQuestionIndex,
      timeTakenSeconds
    });

    return { saved: true };
  });

  // ─── GET /attempts ─── get attempt history for a browser
  app.get('/attempts', async (request, reply) => {
    const { browserId } = request.query;

    if (!browserId) {
      const browserData = readBrowserCookie(request);
      if (!browserData) {
        return reply.status(400).send({ error: 'browserId required (query param or cookie)' });
      }
      const attempts = await withRetry(() => prisma.browserAttempt.findMany({
        where: { browser_id: browserData.browserId },
        orderBy: { created_at: 'desc' },
        take: 50
      }));
      return { attempts };
    }

    const attempts = await withRetry(() => prisma.browserAttempt.findMany({
      where: { browser_id: browserId },
      orderBy: { created_at: 'desc' },
      take: 50
    }));

    return { attempts };
  });
}
