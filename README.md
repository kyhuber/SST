# HPIC single source of truth

A read-only, board-facing financial dashboard for the Highland Park Improvement
Club. It answers three questions: how much cash do we have, how much grant money
is applied for and owed to us, and can we afford the next construction phase.

**Phase 1 (this build): cash on hand from QuickBooks Online.** Grant funnel
(Little Green Light) and phase readiness follow in Phases 2 and 3.

This tool never writes to QuickBooks, Little Green Light, or any bank. Every
call it makes is a GET.

## How it fits together

```
web/     React static build → GitHub Pages. Holds no credentials, no account
         IDs, no financial data. A shell that asks the Worker for numbers.
worker/  Cloudflare Worker. The security boundary. Holds every credential,
         talks to QuickBooks, and returns labels and amounts only.
```

Someone who finds the dashboard URL without the passphrase sees nothing.

## Running it locally

Copy `worker/.dev.vars.example` to `worker/.dev.vars` first — it holds the local
passphrase and lets the Vite dev server's origin through CORS. It is
git-ignored.

```bash
cd worker && npm install && npm run dev
```

```bash
cd web && npm install && npm run dev
```

The Worker starts in **fixture mode** (`QBO_MODE = "fixture"` in
`worker/wrangler.toml`), serving recorded data. The full dashboard works with no
Intuit account, no credentials, and no network calls to QuickBooks.

Point the frontend at the Worker with `web/.env.local`:

```
VITE_WORKER_URL=http://127.0.0.1:8787
```

Then open http://localhost:5173 and enter the passphrase from `.dev.vars`.

To reset local state — stored tokens and the cached snapshot — delete
`worker/.wrangler/state`.

## Connecting QuickBooks for real

### 1. Create the Intuit app

1. Sign in at [developer.intuit.com](https://developer.intuit.com) with the
   Intuit account that administers HPIC's QuickBooks.
2. Create an app with the **QuickBooks Online Accounting** scope
   (`com.intuit.quickbooks.accounting`).
3. Under **Development → Keys & OAuth**, copy the Client ID and Client secret.
   A sandbox company is normally created for you; if not, create one from the
   sandbox section of the dashboard, and note its **company ID (realm ID)**.
4. Register the redirect URI:
   `https://<your-worker>.workers.dev/oauth/callback`
   It must match `QBO_REDIRECT_URI` **exactly** — scheme, casing, trailing
   slash. A mismatch here is the usual cause of `invalid_grant` during setup.

### 2. Configure the Worker

Secrets (never in `wrangler.toml`, never in the repo):

```bash
cd worker
npx wrangler secret put QBO_CLIENT_ID
npx wrangler secret put QBO_CLIENT_SECRET
npx wrangler secret put ACCESS_PASSPHRASE
```

**On Windows, do not pipe values into `wrangler secret put` from PowerShell.**
Its native-command pipe appends a carriage return that is stored as part of the
secret, and every comparison then fails with no visible clue — the passphrase
looks correct and returns 401 anyway. Type the value at the prompt, or pipe from
Git Bash with `printf '%s' "$VALUE" | npx wrangler secret put NAME`.

Three more values are secrets rather than `[vars]`, because this repository is
public and they name HPIC's actual QuickBooks company and accounts:

```bash
printf '%s' "<value>" | npx wrangler secret put QBO_REALM_ID
printf '%s' "<value>" | npx wrangler secret put QBO_OPERATING_ACCOUNT_ID
printf '%s' "<value>" | npx wrangler secret put QBO_REBUILD_FUND_ACCOUNT_ID
```

**A name cannot be both a `[vars]` entry and a secret.** Cloudflare rejects the
binding collision with `code: 10053`. To convert a var into a secret, delete it
from `wrangler.toml`, run `wrangler deploy`, and only then run `secret put`.

Plain values that remain in `worker/wrangler.toml` under `[vars]`:

| Variable | Meaning |
| --- | --- |
| `QBO_ENV` | `sandbox` or `production` — picks the QuickBooks base URL |
| `QBO_MODE` | `fixture` or `live` |
| `QBO_REDIRECT_URI` | Must match the Intuit app registration exactly |
| `ALLOWED_ORIGIN` | Origin of the GitHub Pages site, for CORS |

Then `npx wrangler deploy`.

### 3. Authorize once

Open `https://<your-worker>.workers.dev/oauth/start?k=<passphrase>` in a
browser, sign in, and consent. The callback page confirms the connection and
prints the company ID.

**This is the only interactive step, ever.** After it, the Worker refreshes its
own tokens. You only repeat it if the connection goes 100 days without use or
someone disconnects the app inside QuickBooks. When that happens, the dashboard
says so in plain words rather than showing a generic error.

## Account mapping

The two account IDs are configuration, not data — there is no system of record
for "which account is the rebuild fund."

QuickBooks does not show chart-of-accounts IDs anywhere in its UI, so the Worker
exposes a setup endpoint that lists them:

```
https://<your-worker>.workers.dev/admin/accounts?k=<passphrase>
```

It renders every asset account with its ID, name, type, and balance, and
highlights the two that are currently mapped. Read-only, behind the same
passphrase, and not part of the board-facing dashboard — but it is the fastest
way to find the real IDs when you connect the production company.

Leaving an ID unset is a valid state: that panel reads **Not configured** and
the total is suppressed. **The total cash figure only appears when every
configured account reports successfully.** A total that silently drops a failed
account would overstate available cash, which is the specific error this
dashboard exists to prevent.

If an account rolls up sub-accounts, the panel says so and shows the parent's
own balance in a note, so the mapping gets reviewed rather than misread.

## What the balance figure actually is

QuickBooks' API returns the **book balance** — the "In QuickBooks" figure. The
bank-feed "Bank balance" shown in the QuickBooks web UI is
[not available through the API](https://help.developer.intuit.com/s/question/0D5G000004Dk6KDKAZ/getting-the-bank-balance-from-a-bank-account-via-the-quickbooks-online-api)
at all. The dashboard labels this explicitly rather than implying it is a live
bank balance.

The timestamp shown is QuickBooks' own response time, not the browser clock. If
the data is stale, the dashboard says so honestly.

## Credential rotation

| Credential | Where it lives | How to rotate |
| --- | --- | --- |
| Shared passphrase | Worker secret `ACCESS_PASSPHRASE` | `wrangler secret put ACCESS_PASSPHRASE`, then tell the board. Open tabs get a 401 and re-prompt. |
| QBO client secret | Worker secret `QBO_CLIENT_SECRET` | Regenerate on the Intuit developer portal, `wrangler secret put`, then re-run `/oauth/start` — rotating the secret invalidates existing tokens. |
| QBO access + refresh tokens | Durable Object storage, managed automatically | Nothing to do. If the connection breaks, re-run `/oauth/start`. |

### Why the tokens are not environment variables

Intuit rotates the refresh token value roughly every 24 hours, and the previous
value expires the moment a new one is issued. Worker environment variables are
immutable at runtime, so they cannot hold a value that must be rewritten daily.
Intuit also documents that two concurrent refreshes with the same token succeed
once and fail the second time, which can revoke the connection outright.

A Durable Object (`worker/src/tokens.ts`) gives exactly one writer: every
request for a token funnels through one instance, so a refresh happens once and
everyone else waits for it. This is why a busy board meeting cannot accidentally
break the QuickBooks connection.

## Redeploying

```bash
cd worker && npx wrangler deploy
```

```bash
cd web && npm run build   # publish web/dist to GitHub Pages
```

Changing anything under `[vars]` in `wrangler.toml` requires a Worker redeploy.
Changing a secret does not.

## Access control

The prototype uses one shared passphrase, checked in `worker/src/auth.ts` and
nowhere else. The plan is to replace it with Cloudflare Access and a board email
allowlist, which gives per-person access. When that happens, delete
`worker/src/auth.ts`, remove its two call sites, and drop
`web/src/PassphraseGate.tsx`. Nothing else changes.

## Not yet built

Phase 2 (Little Green Light grant funnel, restricted/unrestricted breakdown,
reimbursable split) and Phase 3 (phase readiness against the Dry-in target
cost). See `hpic-sst-build-spec-v2.md` for the full specification and the
go-live checklist.
