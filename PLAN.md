# PLAN — AWS Cloud Foundations Reviewer (Modules 6–10)

**Status:** Approved. Step 1+ in progress. §10 answers and amendments A–E locked in below.

**Constraints reminder:** Local-only (Windows + WSL2, Node.js). No cloud APIs, no paid services, no telemetry. Free/OSS only; ask before adding any dependency beyond the stack below. Prefer the project on the **WSL filesystem**.

---

## 1. Findings from `./notes/` (inspected, not modified)

### 1.1 Inventory

| Path | Role | Use? |
|------|------|------|
| `Module 6 Notes.md` … `Module 10 Notes.md` | Primary sources | **Yes** |
| `AWS Cloud Practitioner - Anki Deck.apkg` (~31 KB) | Secondary | **Yes** (tag-mapped; see §1.5) |
| `Module 1–5 Notes.md`, `README.md`, `LICENSE`, `Notes Template.md` | Out of scope | Ignore |

Template pattern (all modules follow it):

1. `# Module N - <Title>` + slides link  
2. `## Objectives / Topics`  
3. `## Labs / Activities` (links only — Knowledge Check + Vocareum labs)  
4. `## Section …` content chunks with `###` / `####` subsections  
5. Footer: Knowledge Check + occasional Zoom/YouTube walkthrough links  

There are **no separate lab-writeup or video-transcript Markdown files**. Labs and videos appear only as **links** under Labs/Activities or at the file footer. Question grounding will use **section content**, not those external lab PDFs/videos (links may be dead).

### 1.2 Per-module size & structure

| Module | Topic | Size | Lines | Words | H2 | H3 | H4 | Tables | Code fences |
|--------|-------|------|-------|-------|----|----|----|--------|-------------|
| 6 | Compute | 15.6 KB | 332 | ~2129 | 8 | 9 | 0 | 0 | 0 |
| 7 | Storage | 7.9 KB | 183 | ~1096 | 6 | 4 | 1 | 0 | 0 |
| 8 | Databases | 6.7 KB | 132 | ~932 | 6 | 3 | 2 | 0 | 0 |
| 9 | Cloud Architecture | 9.1 KB | 287 | ~1266 | 5 | 7 | 18 | 0 | 0 |
| 10 | Auto Scaling & Monitoring | 5.8 KB | 82 | ~584 | 5 | 1 | 0 | **1** (ELB types) | 0 |

**Heading style:** Consistent `## Section N: …` then `### **Subsection**` (bold inside H3). Module 9 goes deep with many `####` (pillar Key Topics / Design Principles / Questions). Content is mostly bullet lists; Module 6 has a strong **numbered 9-step EC2 launch** sequence; Module 7 has a short **EFS implementation** numbered list.

**Video mentions:** Almost none as notes. Module 10 links one YouTube autoscaling video; Modules 7/9 link old Lambda School Zoom recordings (not usable as sources).

**Lab mentions:** Link lists only (EC2, Lambda, Beanstalk, Storage, RDS, Scale/LB). No step-by-step lab notes in-repo.

### 1.3 Topic map (chunking plan)

Chunks = each `## Section …` (and meaningful `###` under dense sections). Skip `Objectives / Topics` and `Labs / Activities` as question sources (metadata only).

**Module 6 — Compute**

- Compute Services Overview  
- EC2 (Overview, Launching an EC2 Instance, Miscellaneous)  
- EC2 Cost Optimization (Pricing Models, Four Pillars, Wrap-up)  
- Container Services (Basics, ECS, EKS)  
- Lambda  
- Elastic Beanstalk  

**Module 7 — Storage**

- EBS (+ Features and Charges)  
- S3 (+ Pricing / Estimating)  
- EFS (+ Features, Implementation)  
- Amazon S3 Glacier  

**Module 8 — Databases**

- RDS (Managed vs Unmanaged, Features, Cost/Usage)  
- DynamoDB  
- Redshift  
- Aurora  

**Module 9 — Cloud Architecture**

- Well-Architected Framework (5 pillars × Key Topics / Design Principles / Questions)  
- Reliability and Availability  
- AWS Trusted Advisor  

**Module 10 — Automatic Scaling and Monitoring**

- Elastic Load Balancing (+ Types table)  
- Amazon CloudWatch  
- Amazon EC2 Auto Scaling  

### 1.4 Likely outdated content → keep, flag `needsReview: true`

Notes are ~2020-era (Lambda School / AWS Academy Cloud Foundations). Do **not** drop; flag when generating or importing:

| Item | Why flag |
|------|----------|
| Well-Architected “**5 pillars**” (Module 9) | Framework later added **Sustainability** (6th pillar) |
| **Classic Load Balancer** (Module 10 + Anki) | Previous generation; still exam-relevant historically |
| **Amazon S3 Glacier** naming / vault model (Module 7) | Naming & S3 storage-class story evolved (Glacier Instant/Flexible/Deep Archive, etc.) |
| **Scheduled Reserved Instances** (Module 6) | Service retired; notes still teach it |
| Spot “**bid**” language (Module 6) | Spot pricing model changed |
| EBS **Magnetic** / older volume framing (Module 7) | Volume types renamed/evolved |
| **CloudWatch Events** wording if generated from “Events” bullets (Module 10) | EventBridge rebrand |
| **VMware Cloud on AWS**, **Serverless Application Repository** in compute list (Module 6) | Niche / less CLF-focused today |
| Module 8 slides URL points at an AES blog (broken metadata) | Ignore link; content OK |

Rule: every generated/imported question keeps a `sourceRef` (file + heading). When unsure vs current AWS naming, set `needsReview: true` and still ship the question grounded in the notes.

### 1.5 Anki deck assessment — **import is reliable**

Peeked inside the `.apkg` (zip → `collection.anki2`):

- Deck: `AWS Cloud Practitioner`  
- **130 notes / 172 cards**  
- Tags like `Module-1` … `Module-10` (every sampled note tagged)  
- Modules **6–10 note counts:** 14 + 9 + 8 + 2 + 2 = **35 notes**  

**Decision:** Import Anki cards tagged `Module-6` … `Module-10` only. Map type heuristically (T/F → multiple_choice; short definition → identification; lists → multiple_choice or identification). Strip HTML from fields. Set `source: "anki"`. Skip Modules 1–5 entirely.

If a card’s answer cannot be mapped cleanly to a supported type, skip that card (log it); do not invent answers.

---

## 2. Product goal

A local study app for **Modules 6–10 only** with:

1. A validated question bank (notes + Anki + local-LLM fill-in)  
2. Adaptive weighted-random practice  
3. Situational grading via **Ollama** (offline keyword fallback)  
4. Dashboard, bookmarks, export/import, dark/light UI  

---

## 3. Tech stack (ask before adding anything else)

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 20+ |
| Backend | Express (`/server`) |
| Frontend | Vite + React + Tailwind (`/client`) |
| DB | SQLite via `better-sqlite3` |
| Validation | `zod` |
| Tests | Vitest |
| Anki unzip | `adm-zip` |
| Fuzzy ID answers | `fastest-levenshtein` |
| Local AI | Ollama HTTP on localhost (`qwen2.5:7b-instruct` default; `llama3.1:8b` supported) |

**Planned deps to confirm before install:**  
`express`, `better-sqlite3`, `zod`, `cors`, `dotenv`, `adm-zip`, `fastest-levenshtein`, Vite/React/Tailwind toolchain, Vitest, `concurrently` (or similar) for `npm run dev`.

**§10 decisions (locked):** Deps above approved. Ollama not required for `npm run dev` (sample questions + keyword fallback). Native HTML5 DnD + up/down buttons (no DnD lib). Handmade SVG/CSS charts (no chart lib). Do not add UI kits or extra parsers without asking.

Monorepo layout:

```
/
  PLAN.md
  README.md
  package.json          # workspaces or root scripts
  .env.example
  /client               # Vite React
  /server               # Express + selection + grading
  /scripts              # build:questions, parse notes, anki import
  /data
    questions.json      # built bank
    sample-questions.json
    /cache              # LLM generation cache (gitignored)
    app.db              # runtime SQLite (gitignored)
  /notes                # READ-ONLY clone (do not modify)
```

One-command start: `npm install && npm run dev` (API + Vite).

---

## 4. Question model

Shared fields: `id`, `module` (6–10), `topic`, `conceptTags[]`, `type`, `difficulty` (1–3), `prompt`, `explanation`, `source` (`notes` \| `anki` \| `generated`), `sourceRef` `{ file, heading }`, `needsReview`, optional `outdatedNote`, optional `evidenceQuote` (required for `generated`).

**Stable IDs (amendment A):** `id = hash(source + sourceRef.file + sourceRef.heading + normalizedPrompt)`. Rebuilding the bank never orphans attempt history. DB seed **upserts by id** and **never deletes** attempt rows.

**Outdated notes (amendment D):** When `needsReview: true`, set `outdatedNote` (e.g. `"Notes predate the Sustainability pillar"`). UI badge must show that reason.

| Type | Extra fields | Scoring |
|------|--------------|---------|
| `multiple_choice` | `options[]`, `correctIndices[]` (single or multi) | Multi: partial = correct picks / required, penalize extras |
| `procedural` | `steps[]` (correct order) | Partial by position match; native HTML5 DnD + up/down buttons |
| `identification` | `acceptedAnswers[]`, `aliases[]` | Normalize case/whitespace/punct; alias map (`Amazon S3` ↔ `S3`); small Levenshtein tolerance |
| `situational` | `scenario`, `rubric { keyPoints[], mustMention[], commonMistakes[] }`, `modelAnswer` | Ollama JSON grade 0–100 → score 0–1; offline keyword fallback |

---

## 5. Question bank build (`npm run build:questions`)

Pipeline:

1. **Parse notes** → topic chunks (`path.join` / quoted paths for spaces).  
2. **Derive `conceptTags`** from headings + key terms (e.g. `ec2`, `ami`, `s3`, `ebs`, `efs`, `glacier`, `rds`, `dynamodb`, `aurora`, `redshift`, `well-architected`, `trusted-advisor`, `elb`, `cloudwatch`, `auto-scaling`, `security-groups`, `iam`, `lambda`, `ecs`, `eks`).  
3. **Import Anki** Module-6..10 → convert → merge.  
4. **Generate** remaining questions via Ollama, **chunk-by-chunk**, grounded in that section only. Cache under `data/cache/` keyed by `(module, heading hash, type, model)`. Resumable.  
5. **Counts (amendment C):** scale by notes size — about **1 question per 40–60 words** of module notes (not a flat 15–30). Small modules (8, 10) must not be padded with near-duplicates. Dedupe by normalized prompt similarity across Anki + generated. Prefer procedural only where notes have real sequences (EC2 launch, EFS mount steps).  
6. **Grounding (amendment B):** each generated question must include `evidenceQuote` copied from its chunk. Reject if the quote is not a **literal substring** of the chunk. Second pass: LLM answers the question using **only** the chunk; drop if it disagrees with the stored answer. Log all rejects.  
7. **Zod-validate** entire bank; fail loud on bad items.  
8. Write `./data/questions.json` + print per-module / per-type counts.  

Ship `./data/sample-questions.json` (**20 hand-written**, covering all types & modules) so the app runs before `build:questions`.

Generation rules:

- Never invent AWS facts beyond the chunk.  
- Distractors = related services from the **same module**.  
- Unsure / possibly stale naming → `needsReview: true` + `outdatedNote` reason.  

---

## 6. Local AI grading (Ollama)

- `POST /api/grade/situational` → Ollama `POST {OLLAMA_BASE_URL}/api/chat`  
- **`OLLAMA_BASE_URL`** in `.env` (default `http://127.0.0.1:11434`). Document Windows-host vs in-WSL Ollama reachability in README (amendment E).  
- Strict system prompt: grade **only** against supplied rubric.  
- Response JSON: `{ score, keyPointsHit[], keyPointsMissed[], incorrectClaims[], feedback }`  
- Temp 0–0.2, JSON/structured mode, zod validate, **one retry** on malformed.  
- Fallback: keyword + fuzzy vs rubric → label **"Basic grading (AI offline)"**. App must work with sample questions when Ollama is down.  
- `GET /api/health` + UI badge + copyable `ollama pull <model>`.  
- Model from `.env` (`OLLAMA_MODEL=qwen2.5:7b-instruct`). No non-localhost traffic.

---

## 7. Adaptive selection (`/server/selection`)

Pure functions + seedable RNG; config in `/server/selection/config.ts`.

**Tracking (SQLite):** every attempt → `questionId`, module, topic, conceptTags, type, score 0–1, `timeSpentMs`, timestamp, mode.

**Mastery:** per question / concept tag / topic-module; exponentially decayed accuracy + Beta(1,1) or 0.5 prior; slight penalty for slow-correct.

**Weighted random sampling** factors: weakness (strongest), miss history, spaced-repetition due-ness (Leitner / SM-2-lite), novelty, exploration floor, anti-repeat. Guarantees: no session duplicates; ≤2 same `conceptTag` in a row; respect selected type mix.

**Modes:** Smart practice · Weak areas only (~bottom 30% tags) · Timed exam (mild weakness, end feedback) · Free random.

**UI:** session builder (modules, types, count, mode); “why” chips (`Weak: …`, `New topic`, `Review due`); dashboard (heatmap, weakest 10, accuracy trend, per-type accuracy, study-next, reset progress — **handmade SVG/CSS charts**); bookmarks; `needsReview` badge **showing `outdatedNote`**; results + retry missed; dark/light; keyboard shortcuts; export/import JSON backup.

---

## 8. Implementation steps (after go-ahead)

Each step = small commit + “what works / how to test”.

| Step | Deliverable |
|------|-------------|
| **0** | This `PLAN.md` (done) — wait for approval |
| **1** | Scaffold monorepo: Express + Vite React + Tailwind + scripts + `.env.example` + `npm run dev` health ping (defer native deps `better-sqlite3` / `adm-zip` / `fastest-levenshtein` to Step 2 so install works without a C++ toolchain) |
| **2** | Zod question schemas + `sample-questions.json` (20) + upsert-by-id into SQLite via `server/src/db.ts` (`better-sqlite3@13` prebuild works on Node 24 Windows) |
| **3** | Notes parser + Anki importer (no LLM yet); write partial bank / dry-run summary |
| **4** | `build:questions` LLM generation + disk cache + zod gate + count summary |
| **5** | Scoring utilities (MC partial, procedural, identification) + Vitest |
| **6** | Selection engine + mastery + config + Vitest (seeded 1000 draws) |
| **7** | API: sessions, attempts, health, grade/situational (+ fallback), export/import, reset |
| **8** | Client: session builder, quiz UIs (incl. drag reorder), explanations, badges |
| **9** | Dashboard, results, bookmarks, theme, shortcuts |
| **10** | README (Node, Ollama pull, build:questions, dev, troubleshooting) + polish |

---

## 9. Tests & docs (acceptance)

Vitest coverage for: identification normalization, procedural scoring, multi-select partial credit, rubric JSON validation, mastery math, selection engine (weak tags oversampled; no duplicates; no 3× same tag in a row; mastered still appear). Seedable RNG.

README: install Node 20+, install Ollama, `ollama pull qwen2.5:7b-instruct`, `npm install`, `npm run build:questions` (optional if using samples), `npm run dev`, troubleshooting (WSL paths, better-sqlite3 build tools, Ollama not running).

---

## 10. Decisions (answered)

1. §3 deps approved, no vetoes.  
2. Ollama **not** required for first `npm run dev`.  
3. Native HTML5 DnD + up/down buttons.  
4. Handmade SVG/CSS charts.  

**Amendments locked:** A stable hashed IDs + upsert-only seed; B evidenceQuote + LLM verify pass; C size-scaled counts + dedupe; D `outdatedNote` on badge; E `OLLAMA_BASE_URL` + WSL docs.

---

## 11. Step 0 complete

Plan approved. Implementation proceeds from Step 1.
