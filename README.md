# IHateAWS — Local AWS Cloud Foundations Reviewer (Modules 6–10)

Local-only study app. No cloud services, no paid APIs, no telemetry.

## Quick start (Step 1 scaffold)

Requires **Node.js 20+** (Node 20/22 LTS recommended). Prefer the project on the **WSL filesystem**.

```bash
cp .env.example .env   # optional; defaults work offline
npm install
npm run dev
```

**SQLite:** `better-sqlite3@13` installs a prebuilt binary on Node 24 / Windows without Visual Studio (verified). The app talks to SQLite only through `server/src/db.ts`. If a future Node version lacks prebuilds, we can switch that wrapper to Node’s built-in `node:sqlite` without changing call sites.

- App (Vite): http://localhost:5173  
- API health: http://localhost:3001/api/health  

Ollama is **not** required yet. The health endpoint reports whether Ollama is reachable.

## Ollama later (Windows vs WSL)

Set `OLLAMA_BASE_URL` in `.env` (default `http://127.0.0.1:11434`).

| Where the app runs | Where Ollama runs | Typical `OLLAMA_BASE_URL` |
|--------------------|-------------------|---------------------------|
| WSL | WSL | `http://127.0.0.1:11434` |
| WSL | Windows host | Windows host IP from `/etc/resolv.conf` nameserver, port `11434` |
| Windows | Windows | `http://127.0.0.1:11434` |

```bash
ollama pull qwen2.5:7b-instruct
```

Full question-bank build and feature docs land in later steps. Source notes live in `./notes/` (read-only — do not modify).
