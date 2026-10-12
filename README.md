# aws-ate-my-semester

Local quiz app for AWS Cloud Foundations Modules 6–10, because “Elastic Block Something” and “Elastic File Something Else” are not a personality.

## What it does

- Practice multiple choice, drag-order procedural, fill-in-the-blank, and situational questions
- Runs offline with the shipped sample bank and keyword grading (Ollama optional)
- Optional local AI for typo-tolerant ID checks, situational grading, and generating more questions
- Flags ~2020 note leftovers (Classic LB, five pillars, Spot “bid” talk, etc.)
- “Report bad question” in the UI so we can stop memorizing wrong acronyms

## Run it

Needs **Node.js 20+**.

```bash
git clone https://github.com/DAKSie/aws-ate-my-semester.git
cd aws-ate-my-semester
npm install
npm run dev
```

Open **http://127.0.0.1:5173** (API is on port **3001**). No `.env` required for a first run.

Ollama is optional. Without it you still get the sample bank. With it (for nicer grading / Bank → Generate):

```bash
# install Ollama from https://ollama.com , then:
ollama pull qwen2.5:7b-instruct
```

## Configure

`.env` is optional — copy from `.env.example` only if you need to change defaults.

| Variable | Default | What it does |
|----------|---------|--------------|
| `PORT` | `3001` | Express API port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | CORS origin for the Vite UI |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama HTTP API |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Model for grade / generate / audit |

Practice currently picks randomly from the modules you select (there’s no separate selection-weights file yet). Progress is local SQLite at `data/app.db` — delete that file to reset. No export UI yet.

## Question bank

Ship includes `data/sample-questions.json` (~20 items) so classmates can skip the rebuild. For the full bank, clone [bundickm/AWS_Cloud_Foundations_Study_Materials](https://github.com/bundickm/AWS_Cloud_Foundations_Study_Materials) into `./notes/` (read-only; gitignored), then run `npm run build:questions -- --modules 6,7,8,9,10` with Ollama up, then `npm run merge:questions` and `npm run seed`.

## When it breaks

- **Ollama offline** — fine for practice; Bank → Generate stays disabled until `ollama pull qwen2.5:7b-instruct`
- **`better-sqlite3` / Node** — use Node 20+; on Windows you may need the C++ build tools if the prebuild misses your Node version
- **Port in use** — change `PORT` / free 5173, or Vite will hop to 5174

## Heads up

Notes are ~2020-era and some facts aged poorly — the app badges those. Generated questions can be wrong; use **Report**. Not affiliated with Amazon (they have enough money) and not a substitute for official AWS material.

## Contributing

Report a bad question in the app (that’s the useful path). Notes credit: [bundickm/AWS_Cloud_Foundations_Study_Materials](https://github.com/bundickm/AWS_Cloud_Foundations_Study_Materials). **No LICENSE file in this repo yet** — add one before you publish.
