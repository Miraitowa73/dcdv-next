# DCDV NEXT deployment guardrails

This repository is the separate frontend development line for DCDV NEXT.

## Active backend as of 2026-09-20

The user explicitly approved sharing the existing `dcdv-online` API to restore
Verilog compilation, simulation and AI requests. `DCDV.html` therefore uses
`https://dcdv-online-beydonrfai.cn-hangzhou.fcapp.run` on GitHub Pages. Both
frontends share backend capacity, rate limits and AI usage. Local development
continues to use same-origin `/api/` requests.

This is an exception to the previous backend isolation requirement only.
Do not modify or redeploy the legacy frontend, container or FC function.
The independent resources described below remain a future deployment plan;
the Hangzhou console currently contains only `dcdv-online`.

## Protected legacy deployment

- Repository: `miraitowa73/dcdv-online`
- Frontend: `https://miraitowa73.github.io/dcdv-online/DCDV.html`
- Backend: `https://dcdv-online-beydonrfai.cn-hangzhou.fcapp.run`
- Baseline commit: `f74a13609c2394a81fd4037945ba779180146a09`

Do not push to the legacy repository, rebuild its image tag, or update its FC
function. The local `legacy-source` remote is fetch-only and has its push URL
disabled.

## Planned independent DCDV NEXT resources

- Repository: `miraitowa73/dcdv-next`
- GitHub Pages: `https://miraitowa73.github.io/dcdv-next/`
- ACR repository: `dcdv/dcdv-next`
- Image: `crpi-a6e6wn4ngz2b118w.cn-hangzhou.personal.cr.aliyuncs.com/dcdv/dcdv-next:fc-next-1`
- FC service: `dcdv-fc-next`
- FC function: `dcdv-next`
- Runtime port: `7860`

Before running the manual `Build isolated backend image` workflow, add the
repository secrets `ALIYUN_ACR_USERNAME` and `ALIYUN_ACR_PASSWORD`. These must
belong to the new `dcdv-next` ACR workflow and must never be committed.

When an independent backend is deployed, verify its health and CORS support,
then update `DCDV.html`, `deployment-record.json` and the API routing tests
together. Until then, retain the explicitly approved shared backend above.

## Local accounts and progress

- Accounts and per-user learning progress live only in IndexedDB database
  `dcdvNextLocalAccountsV1`; no auth or progress data is sent to FC.
- Passwords are verified with PBKDF2-SHA256 (310,000 iterations), a unique
  16-byte salt, and a 32-byte derived value. Plaintext passwords are never
  stored or exported.
- The active user id is stored in `sessionStorage`, so refresh keeps the
  session while a new browser session requires login again.
- Progress exports use format `dcdv-next-progress`, version `1`, and contain
  no credential data. Clearing browser data removes local accounts and
  progress unless a backup was exported first.

## Required FC environment variables

```text
HOST=0.0.0.0
PORT=7860
NODE_ENV=production
DCDV_DEPLOYMENT_ID=dcdv-next-fc-next-1
DCDV_CORS_ORIGINS=https://miraitowa73.github.io
DEEPSEEK_API_KEY=<configure in FC console; never commit>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_THINKING=disabled
DCDV_AI_RATE_LIMIT=10
DCDV_VERILOG_RATE_LIMIT=60
DCDV_MAX_VERILOG_JOBS=1
```

## Current shared-backend release verification

1. Confirm the recorded backend `/api/health` returns `ok: true` and
   `toolchain.ok: true` (its service name is `dcdv-local-backend`).
2. Confirm health and POST preflight responses allow the origin
   `https://miraitowa73.github.io`.
3. Check Verilog compilation and simulation using the NEXT frontend.
4. Keep the legacy deployment unchanged.

## Future independent-backend release verification

1. Confirm `/api/health` returns `deployment: dcdv-next-fc-next-1`.
2. Confirm the Pages root redirects to `DCDV.html` and shows the `DCDV NEXT`
   badge.
3. Run AI generation/review and Verilog compile/simulation on the new URL.
4. Recheck the legacy URL and verify it does not show the `DCDV NEXT` badge.
5. Record the deployed commit, image tag, and FC domain in
   `deployment-record.json`.
