# IHateAWS — Local AWS Cloud Foundations Reviewer (Modules 6–10)

Local-only study app. No cloud services, no paid APIs, no telemetry.

## Quick start (Step 1 scaffold)

Requires **Node.js 20+** (Node 20/22 LTS recommended). Prefer the project on the **WSL filesystem**.

```bash
cp .env.example .env   # optional; defaults work offline
npm install
npm run dev
```

Step 1 does **not** install native modules yet. From Step 2 onward, `better-sqlite3` (and later `adm-zip`) need either a prebuilt binary for your Node version or build tools (`build-essential` in WSL, or VS “Desktop development with C++” on Windows). If `npm install` fails on native addons, use Node 22 LTS inside WSL.

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
