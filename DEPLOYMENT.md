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
The independent compile/AI resources described below remain a future deployment
plan. A separate test account function `dcdv-next-account` was added on 2026-10-10.

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

The cloud account implementation is deployed for testing. Its production endpoint
in `account-config.js` stays empty until the new service passes production
verification. With an empty endpoint, the existing local release remains active.
Never silently fall back to local accounts when a configured cloud service fails.

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

## Cloud accounts (test deployed; production domain pending)

### Independent browser test entry (2026-11-09)

The user authorized a new test URL:
`https://miraitowa73.github.io/dcdv-next/cloud-test/`.
`cloud-test/index.html` is the cloud-enabled app, with a visible test badge,
noindex metadata and a link back to the original. Its `account-config.js`
selects the existing FC test origin; it never silently falls back to local login.
`DCDV.html` and the root `auth-local.js` retain the original release contents.
The cloud preparation changes now live in this separate test app. The test
app shares circuit/image assets, the existing compile backend, and its own
cloud account database; it does not create another paid cloud resource.

The separate `cloud-test/auth-local.js` supplies explicit migration from the
existing browser database. Migration defaults to retaining the local account
and progress, so the original release remains usable. Removal is optional and
only happens when explicitly selected. Registration never imports local data.
Because both URLs use the same GitHub Pages origin, migration can read that
origin's local account database after the old password is verified. This is a
separate test entry, not an origin-level security boundary.

Verification: 78 local tests passed, including test routing, original local-only
login, cloud-only initialization, migration defaults and real HDL compilation.
Use `node scripts/preview-cloud-account.js` at `/cloud-test/` for a volatile
local preview; use the published URL for real cloud persistence verification.

The account service is separate from the protected `dcdv-online` compile/AI
function. Deployment settings are in `cloud-account/resources.json`.
On 2026-10-10 the user subsequently approved activation ("没事你开吧，最好不要超过10元")
after the pay-as-you-go costs and limited table permissions were explained.
This supersedes the earlier instruction to hold paid activation. RMB 10/month
is now a cost target, not a guaranteed cap. Use the low-usage configuration and
verify the cloud service before enabling the frontend endpoint.

Current result (2026-10-10): Tablestore `dcdv-accounts`, all three tables, the
minimal RAM role/policy and FC `dcdv-next-account` are created. The verified test
origin is `https://dcdv-ne-account-mswdnmdfrd.cn-hangzhou.fcapp.run`.
The user has no domain and chose test deployment, then authorized the independent
browser test entry above on 2026-11-09.
[Aliyun restricts default FC domains to testing](https://help.aliyun.com/document_detail/2868393.html).
Do not use that test origin as the production website's account service. Keep
`account-config.js` empty until a suitable custom HTTPS domain is available.
No existing local accounts have been automatically migrated or deleted.

The deployed role is `dcdv-next-account-role`, with custom policy
`DCDVNextAccountTables` granting GetRow/PutRow on only the three account tables
and DeleteRow on only the ephemeral table. FC uses temporary STS credentials.
There are no reserved instances, database reserved CU, indexes, SLS log storage,
or tracing. FC has concurrency 1 and a verified total elastic instance quota 1.

1. After approval of service terms/usage charges, create a CU capacity-mode
   Tablestore instance `dcdv-accounts` in Hangzhou. Use a wide-column table
   for each entry in `resources.json`: a single STRING primary key named `key`,
   one version, zero reserved read/write CU, no index. Users and progress have
   TTL -1 (permanent); ephemeral sessions/rate counters have TTL 604800 seconds.
   Leave updates enabled. Use the instance's actual HTTPS endpoint. If using
   its public endpoint, explicitly enable public network access after approval;
   every database request still requires RAM authentication. Never grant public
   or anonymous table access. The browser only accesses the FC account API.
2. Create a RAM role trusted by `fc.aliyuncs.com`, specifically for this account
   function. Replace `<ACCOUNT_ID>` in `ram-policy.template.json` with the current
   account ID and grant only that policy. Do not grant TablestoreFullAccess,
   create AccessKeys, or change the legacy function role. Role creation and
   permission assignment require action-time approval.
3. Run `npm ci --prefix cloud-account --ignore-scripts`, then
   `python scripts/package-cloud-account.py`. The resulting
   `runtime/dcdv-next-account.zip` has `index.handler` at its root and includes
   production dependencies. It excludes local test servers and credentials.
4. Create FC 3.0 function `dcdv-next-account` using the built-in Node.js 20
   runtime, 0.35 vCPU, 512 MB memory, 30 s timeout, concurrency 1, minimum 0 and
   maximum 1 instance. Upload the zip and bind the new role. Configure the
   non-secret variables from `resources.json` using the actual instance endpoint.
   Each invocation uses fresh `context.credentials` (STS); no long-term cloud
   credential is stored locally, in the frontend, or in the function package.
5. Add an HTTP trigger for GET/POST/PUT/OPTIONS. Platform authentication is
   anonymous to allow registration/login; the application requires its own
   bearer credential for identity/progress/logout endpoints. Enforce HTTPS in
   the frontend. Enable OPTIONS forwarding so the code's exact CORS allowlist
   applies. Do not log request bodies, Authorization headers or credentials.
6. Verify `/api/account/health`, create a disposable test account, sign in from
   two independent sessions, save/load progress, reject a stale save, and revoke
   a session by logging out. Confirm all three tables are reachable with the
   minimal policy and restart the function to verify persistence. If any check
   fails, do not switch the frontend.
7. After binding a production custom domain, set `account-config.js` to its verified HTTPS origin, update
   `resources.json` / `deployment-record.json`, run CI, publish NEXT, and verify
   the live login/migration flow in the original browser. The compiler URL stays
   the same. Keep the local database until each user explicitly migrates it.

Passwords use per-user random salt and scrypt N=32768/r=8/p=1. Sessions use
256-bit random tokens; the database stores only SHA-256 token digests. Sessions
expire after 24 hours (table TTL removes old records later). The browser stores
only the opaque token in sessionStorage; identity and loaded progress are held
in memory. The application's pre-existing local UI preferences are not account
data. Logout revokes the server session before removing the browser credential.

Users with old local accounts choose **迁移到云端** in the original browser,
enter the old password, and can pick another cloud username if necessary. The
server hashes that password itself. Initial progress is stored atomically with
the user record, so an interrupted migration cannot create a user without its
progress. After the first successful cloud load, the selected legacy account
and its progress are removed only if the removal checkbox was selected. Other
local users are preserved. No local password hash is uploaded. Existing cloud
accounts are never claimed or overwritten via migration. Use progress export/
import to transfer an old draft into an already-registered cloud account.
After the first committed progress update, the service also clears the duplicate
migration snapshot from the user row to reduce future read traffic and storage.
Cleanup failure preserves the already-saved progress and retries on a later save.

Progress writes use a conditional revision to reject concurrent overwrites.
Cloud read errors block activation/saving rather than constructing an empty
draft. Sync failures remain visible and retain the current draft in memory;
export before closing if offline or conflicted. Closing a dirty page prompts
the browser's unsaved-change warning. Account recovery is not email-based in
this release; users must retain their password.

Cost references checked on 2026-10-10:
- [Tablestore CU billing](https://help.aliyun.com/zh/tablestore/product-overview/what-are-billing-methods-and-items-of-tablestore): actual storage, reads/writes and outbound traffic; no instance purchase fee. Do not pre-purchase packages or enable indexes for this workload.
- [FC pay-as-you-go](https://help.aliyun.com/zh/functioncompute/pay-as-you-go-billing-methods): active hours have a minimum charge of RMB 0.01 per function; resource usage/traffic can cost more. At low usage across every hour in a 30-day month that minimum alone is RMB 7.20, not a monthly cap.
- Budget alerts do not stop billing. A monetary cap/usage budget must be agreed
  before activating chargeable resources; the application and FC limits reduce
  abuse but do not guarantee a hard monthly spending cap.
- The user approved activation on 2026-10-10 with a preference to keep the new
  account service under RMB 10/month, superseding the earlier hold. Keep zero
  minimum instances/reserved CU, no indexes/packages, and at most one function
  instance. Planned budget alerts at RMB 5 and 8 are not configured: the budget
  console remained on a loading skeleton after navigation and reload on
  2026-10-10. No budget or alert was saved. Alerts do not stop charges.
  Do not represent this pay-as-you-go service as a capped
  RMB 10 package. No additional unrelated cloud permissions are authorized.
- [FC HTTP event contract](https://help.aliyun.com/zh/functioncompute/http-trigger-invoking-function), [RAM table policy format](https://help.aliyun.com/zh/tablestore/authorization-policy-syntax-and-elements).

Validation: `npm ci`, `npm ci --prefix cloud-account --ignore-scripts`,
`npm test`. The Tablestore SDK uses a pinned protobufjs override to remove known
dependency advisories; wire encode/decode compatibility is covered by tests.
`node scripts/preview-cloud-account.js` runs a loopback-only UI preview with
volatile test storage; `/legacy.html` exercises migration. It must never be
deployed or used as a production database.

Local verification on 2026-10-10: all 76 regression tests passed, including
real Icarus compilation/simulation and 21 cloud account/storage tests. Browser
preview verified registration, logout, progress synchronization, migration
with local account removal, and restoration of migrated progress in another
login session. That browser preview used volatile test storage.

Actual FC/Tablestore verification completed at 2026-10-10T13:02:46.973Z:
`node scripts/smoke-cloud-account.js <test-origin>` passed all 11 checks,
including real DB health, CORS, denied unauthorized access, registration with
migration progress, independent login tokens, cross-session progress, rejected
stale writes, wrong passwords, device-scoped logout, and progress after a fresh
login. The script creates one synthetic account and never saves or prints its
password/token. Test rows remain in the test database; ephemeral rows expire.
The deployed ZIP hash is recorded in `cloud-account/resources.json`.

Cloud testing uncovered SDK 5.6.5's error parser losing protobuf service codes.
The adapter decodes its protobuf Error envelope on its own client, preserving
CAS conflicts without treating permission/gateway errors as conflicts. Wire
regression and real cloud stale-write verification both pass.

## Classroom test release (2026-11-09)

The cloud test account service now supports admin/teacher/student roles, forced
first password changes, roster imports and per-class progress views. See
[cloud-account/CLASSROOM.md](cloud-account/CLASSROOM.md) for usage, schema,
one-time RAM-protected administrator setup and rollback. The existing compiler
and original `DCDV.html` remain unchanged. Backend ZIP and table details are
recorded in `cloud-account/resources.json`; frontend/admin rollout status is
recorded in `deployment-record.json`.

Validation: 92 regression tests passed with Node 24 and Icarus, and 13 checks
passed against the deployed FC/Tablestore service on 2026-11-09. Local browser
verification completed the admin → teacher → imported student → progress view
workflow. This release keeps the existing zero-minimum-instance and zero-reserved
CU settings; it adds two tables within the existing instance.

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
