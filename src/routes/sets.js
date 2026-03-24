// ─── Sets / Paper Routes ────────────────────────────────────────────────────
// GET /sets — list all ready sets
// GET /paper/:setNumber — get questions for a set (no answers)

import prisma from '../db/prisma.js';
import { getSetQuestions, getSetMeta } from '../cache/redis.js';

export default async function setsRoutes(app) {

  // ─── GET /sets ─── list all ready mock sets
  app.get('/sets', async (request, reply) => {
    const sets = await prisma.mockSet.findMany({
      where: { is_ready: true },
      select: {
        id: true,
        set_number: true,
        title: true,
        total_questions: true,
        total_marks: true,
        generated_date: true,
        subject_breakdown: true
      },
      orderBy: { set_number: 'asc' }
    });

    return { sets };
  });

  // ─── GET /paper/:setNumber ─── get questions (no answers, no explanations)
  app.get('/paper/:setNumber', async (request, reply) => {
    const setNumber = parseInt(request.params.setNumber, 10);

    const totalSets = parseInt(process.env.TOTAL_SETS || '2', 10);
    if (isNaN(setNumber) || setNumber < 1 || setNumber > totalSets) {
      return reply.status(400).send({ error: `Invalid set number. Must be 1-${totalSets}.` });
    }

    // Check if set is ready
    const meta = await getSetMeta(setNumber);
    if (!meta || !meta.is_ready) {
      return reply.status(404).send({ error: `Set ${setNumber} is not available yet.` });
    }

    // Get questions from Redis (cache miss → DB → re-seed)
    const questions = await getSetQuestions(setNumber);
    if (!questions || questions.length === 0) {
      return reply.status(404).send({ error: `No questions found for set ${setNumber}.` });
    }

    // Shuffle options for MCQ/MSQ to make each request unique
    const shuffledQuestions = questions.map(q => {
      if (q.options && (q.question_type === 'MCQ' || q.question_type === 'MSQ')) {
        // Don't actually shuffle here since answers are keyed by letter.
        // Just return as-is for consistency.
        return q;
      }
      return q;
    });

    return {
      setNumber,
      totalQuestions: questions.length,
      totalMarks: meta.total_marks || 100,
      timeLimit: 180, // minutes
      questions: shuffledQuestions
    };
  });
}
