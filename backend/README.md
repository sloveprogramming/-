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

The slice now matches the TypeScript prospect contract for the observable
parts of the run:

- `excludeTerms` filters both search terms and returned companies;
- search fallback and per-term failures are returned in `warnings` instead of
  silently looking like "no companies found";
- `plan`, `sourcing`, `qualification` and `contact` artifacts are written to the
  shared `agent_artifacts` table when `DATABASE_URL` is configured, with a
  per-trace `seq`;
- gray-zone deep checks are optional, read-only and stored beside the
  deterministic score (`deepCheck`), never merged into it.

## Run locally

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
```

Optional agent switches and QCC MCP settings (defaults are deliberately safe):

```text
AGENT_REPLAN_SEARCH=false
AGENT_QUALIFY_GRAY_ZONE=false
QCC_MCP_TOKEN=
QCC_MCP_BASE_URL=https://agent.qcc.com/mcp
```

`AGENT_REPLAN_SEARCH` enables one bounded term-replanning pass when fewer than
five companies are found. `AGENT_QUALIFY_GRAY_ZONE` enables evidence lookups for
at most two companies scoring 45–65. The latter requires a valid QCC MCP token;
without it the run continues with the original score and returns a warning. Keep
both switches off until the QCC account, tool permissions and response fields
have been verified against a real tenant.

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
python -m ruff check app tests
python -m compileall -q app
```

The test suite covers the deterministic dictionary path, DeepSeek failure
fallback, QCC signature and field mapping, cooperation scoring, phone cleaning,
LangGraph routing, replan failure, exclusion terms, warning propagation, artifact
ordering and persistence, gray-zone deep-check degradation, bearer auth, tenant
validation and the frontend response contract.

## Scope

The first implemented production slice is prospecting. Authentication,
tenant/session integration, CRM reply classification and drafting, queues,
webhooks, grid, integrations and scheduling are still in TypeScript and must be
migrated in that order. Do not add new server-side business logic under
`src/lib` or `src/app/api`; put it in `backend/app` during the migration.

The Next.js `/api/prospect/run` route still serves production traffic while the
Python slice is being reviewed. Do not cut traffic over until the local company
library, QCC search and (when enabled) QCC MCP paths have been exercised with a
real tenant and real credentials. Local tests use fakes for the external
providers and do not prove provider authorization or production data quality.

## Migration rule

Do not delete a TypeScript route until its Python replacement has the same
request/response contract, tenant/auth checks, idempotency rules and tests.
See `../docs/superpowers/specs/2026-11-01-python-backend-migration.md` for the
domain order, current inventory and cutover gates.
