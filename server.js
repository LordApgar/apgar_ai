require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PORT = process.env.PORT || 3000;
const MEMORY_DIR = path.join(__dirname, 'memory');
const IMPORTS_DIR = path.join(MEMORY_DIR, 'imports');
const SESSION_LOG_PATH = path.join(MEMORY_DIR, 'session-log.json');
const MEMORY_CHAR_LIMIT = 12000;

fs.mkdirSync(IMPORTS_DIR, { recursive: true });
if (!fs.existsSync(SESSION_LOG_PATH)) fs.writeFileSync(SESSION_LOG_PATH, '[]');

const SEATS = {
  chatgpt: { label: 'ChatGPT', model: process.env.OPENAI_MODEL || 'gpt-4o' },
  claude: { label: 'Claude', model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8' },
  gemini: { label: 'Gemini', model: process.env.GOOGLE_MODEL || 'gemini-2.0-flash' },
};

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const googleAI = process.env.GOOGLE_API_KEY
  ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY)
  : null;

const ASK_FNS_CONFIGURED = { chatgpt: !!openai, claude: !!anthropic, gemini: !!googleAI };

function loadMemoryContext() {
  const files = fs.readdirSync(IMPORTS_DIR).filter((f) => /\.(md|txt)$/i.test(f));
  if (files.length === 0) return '';
  let context = '';
  for (const file of files) {
    const content = fs.readFileSync(path.join(IMPORTS_DIR, file), 'utf8');
    context += `\n\n--- ${file} ---\n${content}`;
    if (context.length > MEMORY_CHAR_LIMIT) break;
  }
  return context.slice(0, MEMORY_CHAR_LIMIT);
}

function buildSystemPrompt(seatKey) {
  const memory = loadMemoryContext();
  const others = Object.entries(SEATS)
    .filter(([key]) => key !== seatKey)
    .map(([, seat]) => seat.label)
    .join(' and ');

  let prompt = `You are ${SEATS[seatKey].label}, sitting at a shared table called The Athenaeum along with the user and two other AI collaborators (${others}). The user brings one question or problem to the table at a time, and all three of you weigh in. Give your own honest, direct answer — don't just defer to the others. Keep your response focused; you'll get a chance to react to the others' answers afterward. If shared background about the user is provided below, use it naturally.`;

  if (memory) {
    prompt += `\n\nShared background on the user, imported from past conversations:\n${memory}`;
  }
  return prompt;
}

function extractError(err) {
  return err && err.message ? err.message : String(err);
}

async function askChatGPT(message, systemPrompt) {
  if (!openai) return { available: false };
  const completion = await openai.chat.completions.create({
    model: SEATS.chatgpt.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
  });
  return { available: true, text: completion.choices[0].message.content };
}

async function askClaude(message, systemPrompt) {
  if (!anthropic) return { available: false };
  const response = await anthropic.messages.create({
    model: SEATS.claude.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  });
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return { available: true, text };
}

async function askGemini(message, systemPrompt) {
  if (!googleAI) return { available: false };
  const model = googleAI.getGenerativeModel({
    model: SEATS.gemini.model,
    systemInstruction: systemPrompt,
  });
  const result = await model.generateContent(message);
  return { available: true, text: result.response.text() };
}

const ASK_FNS = { chatgpt: askChatGPT, claude: askClaude, gemini: askGemini };

async function askSeat(seatKey, message, systemPrompt) {
  try {
    const result = await ASK_FNS[seatKey](message, systemPrompt);
    if (!result.available) {
      return { seat: seatKey, label: SEATS[seatKey].label, available: false };
    }
    return { seat: seatKey, label: SEATS[seatKey].label, available: true, text: result.text };
  } catch (err) {
    return {
      seat: seatKey,
      label: SEATS[seatKey].label,
      available: true,
      error: extractError(err),
    };
  }
}

function appendSessionLog(entry) {
  const log = JSON.parse(fs.readFileSync(SESSION_LOG_PATH, 'utf8'));
  log.push({ ...entry, timestamp: new Date().toISOString() });
  fs.writeFileSync(SESSION_LOG_PATH, JSON.stringify(log, null, 2));
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/ask', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  const seatKeys = Object.keys(SEATS);
  const answers = await Promise.all(
    seatKeys.map((seatKey) => askSeat(seatKey, message, buildSystemPrompt(seatKey))),
  );

  appendSessionLog({ type: 'ask', message, answers });
  res.json({ answers });
});

app.post('/api/discuss', async (req, res) => {
  const { message, answers } = req.body;
  if (!message || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'message and answers are required' });
  }

  const seatKeys = Object.keys(SEATS);
  const discussion = await Promise.all(
    seatKeys.map(async (seatKey) => {
      const others = answers.filter((a) => a.seat !== seatKey && a.text);
      if (others.length === 0) {
        return askSeat(seatKey, message, buildSystemPrompt(seatKey));
      }
      const othersSummary = others
        .map((a) => `${a.label} said:\n${a.text}`)
        .join('\n\n');
      const followUp = `The original question was: "${message}"\n\nHere is what the others at the table said:\n\n${othersSummary}\n\nGiving your honest reaction: do you agree, disagree, or want to add anything? Keep it brief — a few sentences.`;
      return askSeat(seatKey, followUp, buildSystemPrompt(seatKey));
    }),
  );

  appendSessionLog({ type: 'discuss', message, discussion });
  res.json({ discussion });
});

app.get('/api/memory', (req, res) => {
  const files = fs.readdirSync(IMPORTS_DIR).filter((f) => /\.(md|txt)$/i.test(f));
  const details = files.map((f) => {
    const stat = fs.statSync(path.join(IMPORTS_DIR, f));
    return { name: f, size: stat.size };
  });
  res.json({ files: details });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.post('/api/memory/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  if (!/\.(md|txt)$/i.test(req.file.originalname)) {
    return res.status(400).json({ error: 'only .md and .txt files are accepted' });
  }
  const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.writeFileSync(path.join(IMPORTS_DIR, safeName), req.file.buffer);
  res.json({ ok: true, name: safeName });
});

app.delete('/api/memory/:name', (req, res) => {
  const safeName = path.basename(req.params.name);
  const filePath = path.join(IMPORTS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({
    seats: Object.fromEntries(
      Object.entries(SEATS).map(([key, seat]) => [
        key,
        { label: seat.label, model: seat.model, configured: !!ASK_FNS_CONFIGURED[key] },
      ]),
    ),
  });
});

app.listen(PORT, () => {
  console.log(`The Athenaeum is open at http://localhost:${PORT}`);
});
