// ─── Chat Route ─────────────────────────────────────────────────────────────
// POST /chat — conversational AI tutor for a specific question
// Accepts conversation history and question context.

import { GoogleGenerativeAI } from '@google/generative-ai';

function getApiKeys() {
  const keys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
  ].filter(Boolean);
  if (keys.length === 0) throw new Error('No GEMINI_API_KEY configured');
  return keys;
}

export default async function chatRoutes(app) {
  app.post('/chat', async (request, reply) => {
    const { messages, questionContext } = request.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'messages array is required and must not be empty' });
    }

    if (!questionContext) {
      return reply.status(400).send({ error: 'questionContext is required' });
    }

    const systemPrompt = `You are a helpful, expert AI tutor for GATE Computer Science exams.
A student is asking for help regarding this specific question they encountered in a mock test:

--- QUESTION DETAILS ---
Subject: ${questionContext.subject}
Question: ${questionContext.question_text}
Options: ${questionContext.options ? JSON.stringify(questionContext.options) : 'NAT (No options)'}
Correct Answer: ${questionContext.correct_answer}
Official Explanation: ${questionContext.explanation}
Student's Answer: ${questionContext.userAnswer || 'Skipped'}
------------------------

Your goal is to guide the student to understand the concept. 
Be encouraging, concise, and clear. 
Use markdown formatting for code and mathematical concepts.
Do not act like a robot reading a prompt; act like a friendly human professor tutoring a student.`;

    try {
      const keys = getApiKeys();
      let lastErr = null;

      // Map frontend messages { role: 'user'|'assistant', content: string } to Gemini format
      // Gemini requires history to start with a 'user' turn — strip any leading assistant messages
      // (the frontend sends an initial greeting like "Hello, how can I help you?" which would otherwise crash Gemini)
      const rawHistory = messages.slice(0, -1).map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
      }));

      // Drop leading 'model' messages so history starts with 'user'
      const firstUserIdx = rawHistory.findIndex(m => m.role === 'user');
      const geminiHistory = firstUserIdx >= 0 ? rawHistory.slice(firstUserIdx) : [];
      
      const lastMessage = messages[messages.length - 1].content;

      for (let k = 0; k < keys.length; k++) {
        const apiKey = keys[k];
        try {
          const ai = new GoogleGenerativeAI(apiKey);
          const model = ai.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 2048,
            }
          });

          const chat = model.startChat({ history: geminiHistory });
          const result = await chat.sendMessage(lastMessage);
          const text = result.response.text();

          return { reply: text };

        } catch (keyErr) {
          lastErr = keyErr;
          const isQuota = keyErr.message?.includes('quota') || keyErr.message?.includes('429');
          if (isQuota && k < keys.length - 1) {
            console.warn(`[Chat] Key ${k + 1} rate-limited. Trying key ${k + 2}...`);
            continue;
          }
          throw keyErr;
        }
      }
    } catch (err) {
      console.error('[Chat] Gemini AI failed:', err.message);
      console.error('[Chat] Error details:', err.status || 'no-status', err.statusText || 'no-statusText');
      return reply.status(500).send({ error: 'AI tutor temporarily unavailable.' });
    }
  });
}
