# DCDV NEXT

DCDV NEXT is the fully isolated development edition of the Digital Circuit
Design Visualizer.

- New frontend: `https://miraitowa73.github.io/dcdv-next/`
- New repository: `miraitowa73/dcdv-next`
- New backend: Alibaba Cloud Function Compute service `dcdv-fc-next`, function
  `dcdv-next`
- New image: `registry.cn-hangzhou.aliyuncs.com/dcdv/dcdv-next:fc-next-1`

The competition deployment at
`https://miraitowa73.github.io/dcdv-online/DCDV.html` is a protected legacy
release. This repository must never deploy to its repository, image, or FC
function.

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
