# DCDV NEXT deployment guardrails

This repository is the isolated development line for DCDV NEXT.

## Protected legacy deployment

- Repository: `miraitowa73/dcdv-online`
- Frontend: `https://miraitowa73.github.io/dcdv-online/DCDV.html`
- Backend: `https://dcdv-online-beydonrfai.cn-hangzhou.fcapp.run`
- Baseline commit: `f74a13609c2394a81fd4037945ba779180146a09`

Do not push to the legacy repository, rebuild its image tag, or update its FC
function. The local `legacy-source` remote is fetch-only and has its push URL
disabled.

## DCDV NEXT resources

- Repository: `miraitowa73/dcdv-next`
- GitHub Pages: `https://miraitowa73.github.io/dcdv-next/`
- ACR repository: `dcdv/dcdv-next`
- Image tag: `fc-next-1`
- FC service: `dcdv-fc-next`
- FC function: `dcdv-next`
- Runtime port: `7860`

Before running the manual `Build isolated backend image` workflow, add the
repository secrets `ALIYUN_ACR_USERNAME` and `ALIYUN_ACR_PASSWORD`. These must
belong to the new `dcdv-next` ACR workflow and must never be committed.

The frontend API base in `DCDV.html` must contain only the new FC default
domain. Never use the legacy backend URL in a DCDV NEXT release.

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

## Release verification

1. Confirm `/api/health` returns `deployment: dcdv-next-fc-next-1`.
2. Confirm the Pages root redirects to `DCDV.html` and shows the `DCDV NEXT`
   badge.
3. Run AI generation/review and Verilog compile/simulation on the new URL.
4. Recheck the legacy URL and verify it does not show the `DCDV NEXT` badge.
5. Record the deployed commit, image tag, and FC domain in
   `deployment-record.json`.
