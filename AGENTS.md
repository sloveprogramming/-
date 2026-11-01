# Agent instructions

## Backend language

- All new server-side business logic belongs in `backend/` and must be written
  in Python. This includes API routes, Agent workflows, database access, queues,
  webhooks and external integrations.
- Existing TypeScript server code under `src/app/api` and `src/lib` is legacy
  during the migration. Do not add business logic there; only make the minimum
  change needed to connect the existing frontend to the Python backend or to
  remove a fully migrated slice.
- Frontend pages, layouts, client components and styles remain TypeScript /
  TSX. The target architecture is a Next.js frontend backed by FastAPI.

## Git workflow

- `origin` is the owner's repository at `https://github.com/sloveprogramming/-.git`; `upstream` is the original open-source repository.
- After completing and validating a code change, commit that cohesive change and push the current branch to `origin`. Keep unrelated changes in separate commits.
- Before committing, run `npm run typecheck`, `npm run lint`, and the relevant tests. Do not commit with failing checks.
- Never commit secrets, cookies, logs, generated reports, credentials, or lead data. Review `git status` and the staged diff before every commit.
- Do not rewrite or force-push shared history. Leave `upstream` unchanged unless the user explicitly asks to sync it.

## UI implementation and verification

- For UI change requests, implement the requested change first and hand off concise manual verification guidance.
- Do not run Playwright, browser automation, screenshots, or lengthy interactive verification unless the user explicitly requests it.
- Prefer lightweight static checks only when they are necessary for the change.
- If browser verification would materially reduce uncertainty, ask the user to verify the behavior or request permission before running it.
