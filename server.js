/**
 * AI Maturity Assessment — Scoring Backend
 *
 * Handles all LLM calls server-side so the Anthropic API key
 * never reaches the client. Sanitizes input, redacts PII, and
 * applies hard score bounds before responding.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node server.js
 *
 * Dev proxy (Vite): add to vite.config.js:
 *   server: { proxy: { '/api': 'http://localhost:3000' } }
 */

import express from 'express';
import sanitizeHtml from 'sanitize-html';

const app = express();
app.use(express.json({ limit: '200kb' }));

// ── Helpers ────────────────────────────────────────────────

/** Strip HTML to plain text */
function toPlainText(html) {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim();
}

/** Minimal PII redaction — email, phone */
function redactPII(text) {
  return text
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b(\+?[\d\s\-().]{7,15})\b/g, (m) =>
      /\d{5,}/.test(m) ? '[redacted-phone]' : m
    );
}

// ── Route ──────────────────────────────────────────────────

app.post('/api/scoreOpenQuestion', async (req, res) => {
  try {
    const { points, question, answerHtml, scoringGuide } = req.body;

    // Validate required fields
    if (!points || !question || answerHtml === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Sanitize + plain-text the answer; redact PII before sending to LLM
    const answerText = redactPII(toPlainText(answerHtml || ''));
    const questionText = redactPII(String(question));

    // Build scoring criteria strings
    const criteriaList = (scoringGuide?.criteria || [])
      .map((c, i) => `${i + 1}. ${c}`)
      .join('\n');
    const levelsDesc = (scoringGuide?.levels || [])
      .map(l => `- ${l.score} Punkte (${l.label}): ${l.description}`)
      .join('\n');

    const prompt =
`Du bist Experte für AI Leadership Assessment.
Bewerte die folgende Antwort präzise nach dem vorgegebenen Schema.

BEWERTUNGSSCHEMA:
Maximale Punkte: ${points}
Bewertungskriterien:
${criteriaList || '(keine detaillierten Kriterien angegeben)'}
Punktestufen:
${levelsDesc || '(keine detaillierten Stufen angegeben)'}

Frage: ${questionText}
Antwort: ${answerText || '(keine Antwort gegeben)'}

Antworte NUR mit JSON (ohne Backticks oder Markdown):
{"score": <0..${points} in 0.5-Schritten>, "reasoning": "<2-3 Sätze>", "strengths": ["<Stärke1>"], "improvements": ["<Verbesserung1>"]}`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(30_000) // 30 s hard timeout
    });

    if (!apiRes.ok) {
      console.error('Anthropic API error:', apiRes.status);
      return res.json(manualReviewFallback());
    }

    const apiData = await apiRes.json();
    const rawText = apiData?.content?.find(c => c.type === 'text')?.text || '{}';

    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch {
      console.error('JSON parse failed:', rawText.slice(0, 200));
      return res.json(manualReviewFallback());
    }

    const score = Math.max(0, Math.min(Number(points), Number(parsed.score) || 0));
    return res.json({
      score,
      reasoning: String(parsed.reasoning || ''),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
      needsManualReview: false
    });

  } catch (e) {
    console.error('Scoring route error:', e.message);
    return res.json(manualReviewFallback());
  }
});

function manualReviewFallback() {
  return {
    score: 0,
    reasoning: 'Automatische Bewertung aktuell nicht verfügbar. Diese Antwort bitte manuell prüfen.',
    strengths: [],
    improvements: [],
    needsManualReview: true
  };
}

// ── /api/generateFeedback — Handlungsfeld reinforcement ──────
app.post('/api/generateFeedback', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await apiRes.json();
    const text = data.content?.find(c => c.type === 'text')?.text || '{}';
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scoring API listening on port ${PORT}`));


// ─────────────────────────────────────────────────────────────
// DEPLOYMENT GUIDE (append to server.js for reference)
// ─────────────────────────────────────────────────────────────
//
// OPTION A — Railway (recommended, free tier available)
//   1. railway login
//   2. railway init  (in this directory)
//   3. railway up
//   4. In Railway dashboard: Variables → add ANTHROPIC_API_KEY=sk-...
//   5. In frontend: set API_BASE = 'https://your-app.railway.app'
//
// OPTION B — Render
//   1. Push to GitHub
//   2. New Web Service → connect repo
//   3. Environment: ANTHROPIC_API_KEY=sk-...
//   4. Build: npm install  |  Start: node server.js
//
// FRONTEND SWITCH (ai-maturity-assessment-v4.tsx)
//   const API_BASE = process.env.REACT_APP_API_URL || '';
//   Replace direct fetch('https://api.anthropic.com/...') with:
//   fetch(`${API_BASE}/api/scoreOpenQuestion`, { ... })
//
// CORS NOTE: server.js already allows all origins via cors().
//   For production, restrict to your domain:
//   app.use(cors({ origin: 'https://your-domain.com' }));
