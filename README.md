# HPIC single source of truth

A read-only, board-facing financial dashboard for the Highland Park Improvement
Club. It answers three questions: how much cash do we have, how much grant money
is applied for and owed to us, and can we afford the next construction phase.

**Phase 1: cash on hand from QuickBooks Online — done.**
**Phase 2: the Little Green Light grant funnel — a working slice, on fixture
data.** Phase readiness follows in Phase 3.

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

The Worker starts in **fixture mode**, serving recorded data. The full dashboard
works with no Intuit account, no credentials, and no network calls to
QuickBooks.

Fixture mode comes from `QBO_MODE=fixture` in `.dev.vars`, which overrides the
`live` setting in `wrangler.toml` for local runs only. Keep it that way: local
`wrangler dev` has its own Durable Object storage and therefore no QuickBooks
tokens, and it cannot be seeded, because Intuit requires an https redirect URI
and the OAuth flow will not complete against localhost. If you find the local
dashboard insisting QuickBooks is not connected, this line is missing from your
`.dev.vars`.

Point the frontend at the Worker with `web/.env.local`:

```
VITE_WORKER_URL=http://127.0.0.1:8787
```

Then open http://localhost:5173 and enter the passphrase from `.dev.vars`.

To reset local state — stored tokens and the cached snapshot — delete
`worker/.wrangler/state`.

## Tests

```bash
cd worker && npm test
```

They run inside workerd — the same runtime that serves the deployed Worker —
rather than against a stand-in for the Durable Object storage API. They need no
credentials and make no network calls; outbound `fetch` is stubbed, so nothing
reaches Intuit.

`test/tokens.test.ts` covers the OAuth refresh path in `worker/src/tokens.ts`,
because it is the only code here that can disconnect the dashboard in a way that
requires a human to sign in to QuickBooks and re-consent. Three of those cases
cannot be reached by running against the real Intuit at all: you cannot force
`invalid_grant` without revoking the live grant, you cannot make Intuit
unreachable on demand, and nothing in normal operation puts two refreshes in
flight at the same time.

`test/lgl.test.ts` covers the grant funnel. Most of what it pins down is where
the code must *refuse* to show a number: the amount-due gap, an absent
reimbursable field reading as unknown rather than as spendable, a page walk that
did not reach the end, and a rejected API key. It also checks that every request
to LGL is a GET.

`npm run typecheck` checks `src/` and `test/` both.

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

## Checking the connection

The Worker keeps a diagnostic endpoint behind the same passphrase:

```
https://<your-worker>.workers.dev/admin/status?k=<passphrase>
```

It also accepts the passphrase as a header, which keeps it out of shell history
and proxy logs — prefer this from a terminal:

```bash
curl -s -H "X-HPIC-Auth: <passphrase>" https://<your-worker>.workers.dev/admin/status
```

It returns JSON:

| Field | What it tells you |
| --- | --- |
| `seeded` | Whether a token pair exists at all. `false` means OAuth was never completed. |
| `needsReauth` | `true` means the refresh token is dead and a human must redo consent at `/oauth/start`. |
| `accessTokenExpiresAt` | When the current access token dies. The refresh happens on the first cron **after** this time. |
| `lastRefreshAt` | When a token pair was last written. |
| `lastScheduledRun` | When the hourly keep-alive last ran, and what it saw. Absent means the cron has never fired. |
| `events` | The last 20 things the token machinery did. This is the useful part. |

In `events`, `kind` is one of `seeded`, `refreshed`, `refresh_failed`,
`revoked`, or `discovery_fallback`. A healthy unattended connection shows
`refreshed` entries whose detail says the refresh token was `rotated` or
`unchanged` — either is fine, that is Intuit's choice, not ours.

`refresh_failed` with `invalid_grant` is the one that matters: the connection is
gone and no amount of waiting fixes it. Reconnect at `/oauth/start`.

An earlier cron run that shows no `refreshed` event is **not** a failure. If the
access token was still valid, the keep-alive correctly returned it from storage
without calling Intuit.

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

## Connecting Little Green Light

The grant funnel runs on recorded fixture data until a key is configured, so it
can be reviewed before anyone issues one:

```bash
printf '%s' "<key>" | npx wrangler secret put LGL_API_KEY
```

Issue a **fresh key scoped to this tool** rather than reusing the membership
lookup tool's key, so either can be revoked without breaking the other. Then set
`LGL_MODE = "live"` in `worker/wrangler.toml` and redeploy.

### Scoping the funnel to grants

LGL holds every appeal ask and every pledge, most of which are individual donor
activity rather than grants. Two optional `[vars]` narrow the reads:

| Variable | Meaning |
| --- | --- |
| `LGL_GRANT_CAMPAIGN_IDS` | Comma-separated campaign IDs holding grant activity |
| `LGL_GRANT_GIFT_CATEGORY_IDS` | Comma-separated gift category IDs identifying grant awards (LGL ships a stock "Grant" category) |

Leaving both unset is a valid state, but the figures then cover all LGL activity.
The dashboard says so in a banner rather than implying they are grants-only.
Find the IDs at `/api/v1/campaigns` and `/api/v1/gift_categories`.

## Why "Received" and "Outstanding" say "Not shown"

This is deliberate, and it is the most important thing to understand about the
grant panel.

The build spec defines the funnel as Applied → Pledged → Received → Outstanding,
with Received and Outstanding both derived from a pledge's **amount due**, read
directly from LGL rather than recomputed. Checked against
[LGL's API documentation](https://api.littlegreenlight.com/api-docs/static.html)
on 2026-08-14, **the REST API exposes no amount-due or balance field on any
object** — the strings `amount_due` and `balance` do not appear in the docs at
all. There is also no `/goals` or `/pledges` endpoint: an application is an
`appeal_request`, and an award is a gift whose gift type is "Pledge".

So Applied and Pledged come from the system of record, and the other two report
that they cannot. Deriving amount due by summing the payment gifts linked to a
pledge is technically possible, but the spec rules it out — LGL maintains the
real figure internally and recomputing it invites drift.

Closing this needs a decision, not more code:

1. Ask LGL support whether a pledge balance is reachable through the API,
   perhaps through a field the public docs omit; or
2. Accept a derived figure, clearly labeled as derived rather than read.

Until then the panel says what it does not know, which is the same rule that
suppresses total cash when one account fails to read.

## Not yet built

The rest of Phase 2 — the restricted/unrestricted breakdown by campaign and
fund, and the detail list of individual applications and awards — and Phase 3
(phase readiness against the Dry-in target cost). See
`hpic-sst-build-spec-v2.md` for the full specification and the go-live
checklist.
