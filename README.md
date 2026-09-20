# DCDV NEXT

DCDV NEXT is the development edition of the Digital Circuit Design Visualizer,
with a separate frontend, repository and browser-local accounts.

- New frontend: `https://miraitowa73.github.io/dcdv-next/`
- New repository: `miraitowa73/dcdv-next`
- Active backend (shared with user approval on 2026-09-20):
  `https://dcdv-online-beydonrfai.cn-hangzhou.fcapp.run`
- Independent backend `dcdv-next` remains planned, not deployed.

The competition deployment at
`https://miraitowa73.github.io/dcdv-online/DCDV.html` is a protected legacy
release. This repository must never deploy to its repository, image, or FC
function. The approved shared API uses its existing deployment unchanged;
both frontends share backend capacity, rate limits and AI usage.

## Local development

```powershell
npm ci
npm test
npm start
```

Open `http://127.0.0.1:3030/`. DeepSeek credentials are read from environment
variables or an ignored local configuration file; they must never be committed.

## Deployment

GitHub Pages publishes `main` from the repository root. The backend runs as a
custom-container HTTP function on port `7860`. See `DEPLOYMENT.md` for exact
resource names, environment variables, verification steps, and legacy safety
rules.
