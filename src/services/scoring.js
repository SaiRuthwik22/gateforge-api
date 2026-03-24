// ─── Server-Side Scoring ────────────────────────────────────────────────────
// NEVER trust client scoring. All calculation happens here.

/**
 * Calculate score from submitted answers
 *
 * @param {Object[]} questions - Full question objects with correct_answer
 * @param {Object} answers - { questionId: selectedAnswer }
 * @returns {{ score, correctCount, wrongCount, skippedCount, subjectBreakdown, questionsWithResults }}
 */
export function calculateScore(questions, answers) {
  let totalScore = 0;
  let correctCount = 0;
  let wrongCount = 0;
  let skippedCount = 0;

  const subjectBreakdown = {};
  const questionsWithResults = [];

  for (const question of questions) {
    const userAnswer = answers[question.id];
    const isSkipped = !userAnswer || userAnswer === '' || userAnswer === null || userAnswer === undefined;

    // Initialize subject breakdown
    if (!subjectBreakdown[question.subject]) {
      subjectBreakdown[question.subject] = {
        subject: question.subject,
        attempted: 0,
        correct: 0,
        wrong: 0,
        skipped: 0,
        marksScored: 0,
        totalMarks: 0
      };
    }
    subjectBreakdown[question.subject].totalMarks += question.marks;

    let questionResult = {
      id: question.id,
      subject: question.subject,
      question_text: question.question_text,
      question_type: question.question_type,
      marks: question.marks,
      options: question.options,
      diagram: question.diagram,
      userAnswer: userAnswer || null,
      correct_answer: question.correct_answer,
      explanation: question.explanation,
      key_refs: question.key_refs || [],
      youtube_queries: question.youtube_queries || [],
      isCorrect: false,
      isSkipped,
      marksAwarded: 0
    };

    if (isSkipped) {
      // Skipped — no marks, no penalty
      skippedCount++;
      subjectBreakdown[question.subject].skipped++;
    } else {
      subjectBreakdown[question.subject].attempted++;

      // Check correctness based on question type
      let isCorrect = false;

      if (question.question_type === 'MCQ') {
        isCorrect = userAnswer.toUpperCase() === question.correct_answer.toUpperCase();
      } else if (question.question_type === 'MSQ') {
        // MSQ: user answer could be "A,C" — order doesn't matter
        const userOpts = userAnswer.split(',').map(a => a.trim().toUpperCase()).sort();
        const correctOpts = question.correct_answer.split(',').map(a => a.trim().toUpperCase()).sort();
        isCorrect = userOpts.length === correctOpts.length &&
          userOpts.every((v, i) => v === correctOpts[i]);
      } else if (question.question_type === 'NAT') {
        // NAT: numerical comparison with tolerance
        const userNum = parseFloat(userAnswer);
        const correctNum = parseFloat(question.correct_answer);
        if (!isNaN(userNum) && !isNaN(correctNum)) {
          // Allow 1% tolerance or exact match for integers
          const tolerance = Number.isInteger(correctNum) ? 0 : Math.abs(correctNum * 0.01);
          isCorrect = Math.abs(userNum - correctNum) <= tolerance;
        }
      }

      if (isCorrect) {
        correctCount++;
        totalScore += question.marks;
        subjectBreakdown[question.subject].correct++;
        subjectBreakdown[question.subject].marksScored += question.marks;
        questionResult.isCorrect = true;
        questionResult.marksAwarded = question.marks;
      } else {
        wrongCount++;
        // Apply negative marking only for MCQ
        if (question.question_type === 'MCQ') {
          const penalty = question.negative_marks || (question.marks === 1 ? 0.33 : 0.67);
          totalScore -= penalty;
          subjectBreakdown[question.subject].marksScored -= penalty;
          questionResult.marksAwarded = -penalty;
        } else {
          // MSQ and NAT: no negative marking
          questionResult.marksAwarded = 0;
        }
        subjectBreakdown[question.subject].wrong++;
      }
    }

    questionsWithResults.push(questionResult);
  }

  // Floor at 0
  totalScore = Math.max(0, parseFloat(totalScore.toFixed(2)));

  // Round subject scores
  for (const key of Object.keys(subjectBreakdown)) {
    subjectBreakdown[key].marksScored = parseFloat(subjectBreakdown[key].marksScored.toFixed(2));
  }

  return {
    score: totalScore,
    totalMarks: 100,
    correctCount,
    wrongCount,
    skippedCount,
    totalQuestions: questions.length,
    subjectBreakdown: Object.values(subjectBreakdown),
    questionsWithResults
  };
}
