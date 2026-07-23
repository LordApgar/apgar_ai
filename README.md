# The Athenaeum

A shared room where you, ChatGPT, Claude, and Gemini sit at one table. Ask one
question and all three answer independently, then (optionally) react to each
other's answers. A shared memory folder holds handoff notes imported from your
past conversations with each assistant, so every seat at the table can draw on
the same background about you.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and add whichever API keys you have:

```
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...
```

You don't need all three — a seat with no key configured just shows up empty
in the room instead of erroring out. Override the model in each seat with
`OPENAI_MODEL` / `ANTHROPIC_MODEL` / `GOOGLE_MODEL` in `.env` if you want a
different one than the defaults.

Run it:

```bash
npm start
```

Then open `http://localhost:3000`.

## Importing shared memory

Click **Memory** in the top right to open the panel. Upload `.md` or `.txt`
files there — for example, ask each assistant in its own app to write a
handoff note summarizing what it knows about you and what you've built
together, then drop that file in here. Every question you ask at the table
includes the contents of these files as background context for all three
models, so nobody's starting from zero.

Files live in `memory/imports/` on disk if you'd rather manage them by hand.

## How it works

- `POST /api/ask` fans your message out to ChatGPT, Claude, and Gemini in
  parallel and returns all three answers.
- `POST /api/discuss` sends each model the other two's answers and asks for a
  brief reaction — this is the "have them discuss it" round.
- Every round is appended to `memory/session-log.json` as a running transcript.
