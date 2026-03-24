// ─── Analyze Route ──────────────────────────────────────────────────────────
// POST /analyze — send wrong/skipped questions to Gemini for deep analysis
// Returns concept explanations, why wrong, references, and YouTube queries.

import { GoogleGenerativeAI } from '@google/generative-ai';

// ─── Multi-key pool (same 3 keys as worker) ──────────────────────────────────

function getApiKeys() {
  const keys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
  ].filter(Boolean);
  if (keys.length === 0) throw new Error('No GEMINI_API_KEY configured');
  return keys;
}

/**
 * Build a prompt to analyze a batch of wrong/skipped questions
 */
function buildAnalysisPrompt(questions) {
  const questionsList = questions.map((q, i) => {
    const answerInfo = q.isSkipped
      ? 'Student did not attempt this question (skipped).'
      : `Student answered: ${q.userAnswer}. Correct answer: ${q.correct_answer}.`;

    const options = q.options
      ? Object.entries(q.options).map(([k, v]) => `  ${k}) ${v}`).join('\n')
      : 'No options (NAT question)';

    return `--- Question ${i + 1} (ID: ${q.id}) ---
Subject: ${q.subject} | Topic: ${q.topic || 'N/A'}
Type: ${q.question_type} | Marks: ${q.marks}
Question: ${q.question_text}
Options:
${options}
${answerInfo}
Official Explanation: ${q.explanation}`;
  }).join('\n\n');

  return `You are an expert GATE CS tutor. Analyze the following questions that a student got wrong or skipped.
For each question, provide a thorough analysis to help the student understand and learn.

${questionsList}

Return a JSON array (one object per question, in the same order) with this exact structure:
[
  {
    "id": "<same question ID as above>",
    "concept": "<the core CS concept being tested, 1-2 sentences>",
    "why_wrong": "<if skipped: explain why this topic is tricky and common misconceptions; if wrong: explain exactly why the student's answer is incorrect and what the trap/pitfall was>",
    "correct_explanation": "<step-by-step solution walkthrough, clearly explaining the correct approach and answer>",
    "key_refs": ["<reference 1, e.g. CLRS Chapter 6: Heapsort>", "<reference 2, e.g. Cormen Algorithm Design>", "<textbook or website reference>"],
    "youtube_queries": ["<specific YouTube search query to find a great tutorial on this topic>", "<alternative query focusing on the specific subtopic>"]
  }
]

Rules:
- Output ONLY the JSON array. No markdown. No explanation. Raw JSON only.
- Each "youtube_queries" must be 2 specific, searchable queries (e.g., "GATE CS master theorem recurrence examples", "Binary search tree deletion algorithm explained")
- Each "key_refs" must have 2-4 references (textbooks, NPTEL, GFG articles, etc.)
- "why_wrong" should be empathetic and educational, not just say "wrong answer"
- "correct_explanation" should be detailed enough to solve similar problems`;
}

export default async function analyzeRoutes(app) {

  // ─── POST /analyze ──────────────────────────────────────────────────────────
  app.post('/analyze', async (request, reply) => {
    const { questions } = request.body || {};

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return reply.status(400).send({ error: 'questions array is required and must not be empty' });
    }

    if (questions.length > 65) {
      return reply.status(400).send({ error: 'Cannot analyze more than 65 questions at once' });
    }

    try {
      const keys = getApiKeys();
      let lastErr = null;
      let analyses = null;

      // Try each key in order — rotate on quota/rate-limit
      for (let k = 0; k < keys.length; k++) {
        const apiKey = keys[k];
        try {
          const ai = new GoogleGenerativeAI(apiKey);
          const model = ai.getGenerativeModel({
            model: 'gemini-2.5-flash',
            generationConfig: {
              temperature: 0.4,
              topP: 0.95,
              maxOutputTokens: 16384,
              responseMimeType: 'application/json'
            }
          });

          const prompt = buildAnalysisPrompt(questions);
          const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: {
              parts: [{
                text: 'You are an expert GATE CS tutor. Analyze questions and output only valid JSON. No markdown, no explanation, just raw JSON array.'
              }]
            }
          });

          const text = result.response.text();
          let raw = text.trim().replace(/^```(?:json|JSON)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim();

          try {
            analyses = JSON.parse(raw);
          } catch (_) {
            const match = raw.match(/\[[\s\S]*\]/);
            if (match) analyses = JSON.parse(match[0]);
            else throw new Error('JSON parse failed');
          }

          console.log(`[Analyze] ✓ Key ${k + 1}/...${apiKey.slice(-6)} succeeded`);
          break; // Success — stop key rotation

        } catch (keyErr) {
          lastErr = keyErr;
          const isQuota = keyErr.message?.includes('quota') || keyErr.message?.includes('429') || keyErr.message?.includes('RESOURCE_EXHAUSTED');
          if (isQuota && k < keys.length - 1) {
            console.warn(`[Analyze] Key ${k + 1} rate-limited. Trying key ${k + 2}...`);
            continue;
          }
          throw keyErr; // Non-quota error or last key — propagate
        }
      }

      if (!Array.isArray(analyses)) {
        return reply.status(500).send({ error: 'Gemini returned invalid analysis format' });
      }

      return { analyses };


    } catch (err) {
      console.error('[Analyze] Gemini analysis failed:', err.message);

      // Graceful fallback — return empty analyses with error note
      if (err.message?.includes('GEMINI_API_KEY')) {
        return reply.status(500).send({ error: 'AI analysis service not configured' });
      }

      // Rate limit or other transient error — let client retry
      if (err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) {
        return reply.status(429).send({ error: 'AI service rate limited. Please wait 30 seconds and try again.' });
      }

      return reply.status(500).send({ error: 'AI analysis temporarily unavailable. Please try again.' });
    }
  });
}
