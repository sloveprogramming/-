# AgentSDR Python backend

This directory is the Python replacement for AgentSDR's server-side business
logic. The Next.js frontend stays in place during the transition; the Python
service becomes the backend behind a server-side proxy once each slice is
verified.

## Current slice

The first production-shaped slice is the prospecting workflow:

```text
POST /api/prospect/run
  -> ProductIntentAgent
  -> SourcingAgent
  -> ScoringAgent
  -> contact enrichment
  -> finish
```

It uses LangGraph's Python runtime, Pydantic contracts, a DeepSeek-compatible
structured model adapter and the QCC search adapter. The deterministic scoring
formula remains deterministic; an LLM never returns the final total score.

## Run locally

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
```

Health check: `GET http://localhost:8000/health`.

Prospecting:

```http
POST http://localhost:8000/api/prospect/run
Authorization: Bearer <AGENT_BACKEND_TOKEN>
X-Organization-Id: <organization uuid>

{"product":"面包丝"}
```

The API expects `Authorization: Bearer <AGENT_BACKEND_TOKEN>` and
`X-Organization-Id` while the TypeScript and Python services run side by side.
This is an internal migration guard, not a replacement for the final
session-based authentication.

## LangSmith tracing (optional)

Tracing is disabled unless both `LANGSMITH_TRACING=true` and a valid
`LANGSMITH_API_KEY` are present. Create the key in the LangSmith workspace
under `Settings -> API Keys`; do not use the DeepSeek key here.

```powershell
$env:LANGSMITH_TRACING="true"
$env:LANGSMITH_API_KEY="<langsmith-key>"
$env:LANGSMITH_PROJECT="agentsdr-dev"
uvicorn app.main:app --reload --port 8000
```

Set `LANGSMITH_ENDPOINT` only when the workspace uses a non-default region.
If you keep these values in `backend/.env`, start Uvicorn with
`--env-file .env`; the file is ignored by Git.

One `POST /api/prospect/run` then appears in LangSmith as `prospect-run`. The
graph nodes, DeepSeek calls and QCC searches are separate spans. Phone numbers,
email addresses and common credential formats are masked client-side before
upload, and the raw organization UUID is replaced by a short fingerprint.

The dev tracer keeps prompts and company names so failures can be diagnosed.
For production, use sampling or set `LANGSMITH_HIDE_INPUTS=true` and
`LANGSMITH_HIDE_OUTPUTS=true`. Do not send real customer conversations, phone
lists or other lead data to a cloud project without an explicit data policy.

## Verify

```powershell
python -m pytest
python -m compileall -q app
```

The test suite covers the deterministic dictionary path, DeepSeek failure
fallback, QCC signature and field mapping, cooperation scoring, phone cleaning,
LangGraph routing, replan failure, bearer auth, tenant validation and the
frontend response contract.

## Scope

The first implemented production slice is prospecting. Authentication,
tenant/session integration, CRM reply classification and drafting, queues,
webhooks, grid, integrations and scheduling are still in TypeScript and must be
migrated in that order. Do not add new server-side business logic under
`src/lib` or `src/app/api`; put it in `backend/app` during the migration.

## Migration rule

Do not delete a TypeScript route until its Python replacement has the same
request/response contract, tenant/auth checks, idempotency rules and tests.
See `../docs/superpowers/specs/2026-11-01-python-backend-migration.md` for the
domain order, current inventory and cutover gates.
