# HPIC single source of truth — working notes

Read `hpic-sst-build-spec-v2.md` for the full specification. `README.md` covers
setup, credential rotation, and redeploy. This file is the short orientation.

## What this is

A read-only board dashboard for the Highland Park Improvement Club, a
volunteer-run Seattle nonprofit rebuilding its clubhouse after a 2021 fire.
It answers: how much cash do we have, how much grant money is owed to us, and
can we afford the next construction phase.

**Never write to QuickBooks or Little Green Light.** Every call to a data API is
a GET. The only POSTs in the codebase go to Intuit's OAuth token endpoint.

The governing principle from the spec: **every number traces to a system of
record, and an honest "unavailable" always beats a clean number hiding a
caveat.** Several design choices only make sense in that light — see "Invariants".

## Layout

```
worker/   Cloudflare Worker. The security boundary. Holds every credential.
web/      React + Vite static build → GitHub Pages. Holds nothing sensitive.
```

## Deployed

| | |
| --- | --- |
| Worker | https://hpic-sst.kyhuber-ft.workers.dev |
| Dashboard | https://kyhuber.github.io/SST/ |
| Account mapping tool | `/admin/accounts?k=<passphrase>` |
| QuickBooks | Sandbox company, `QBO_ENV = "sandbox"` |

Frontend deploys via GitHub Actions on pushes to `web/**`. The Worker deploys
only via `npx wrangler deploy` — deliberately manual, since it holds the
credentials.

## Invariants — do not quietly break these

- **Total cash renders only when every configured account reads successfully.**
  A total that silently drops a failed account overstates available cash. This
  is the specific failure the tool exists to prevent, not a nicety.
- **`retrievedAt` is QuickBooks' own `time` field**, never the browser or Worker
  clock. A dashboard always showing today's date is worse than showing none.
- **Connection state is never reported as `ok` when QuickBooks is unreachable.**
  `not_connected` and `needs_reauth` are distinct and both surface to the UI.
- **Balances are the QuickBooks *book* balance**, labeled as such. The bank-feed
  balance is not exposed by the API at all.
- Coming in Phase 2: never sum reimbursable and non-reimbursable awards into one
  "available" figure, and render unknown reimbursable status as unknown.

## Shell

Windows, **Git Bash** (MINGW64), run from the repository root. Commands must be
POSIX: forward-slash paths (`/c/Users/...` or `~/...`), no `cd` to an absolute
Windows path, no `python` (not installed — use `node`). PowerShell 5.1 exists
but lacks `&&`, `||`, and much else; prefer Git Bash.

## Gotchas that cost real time

- **Never pipe secrets into `wrangler secret put` from PowerShell.** Its
  native-command pipe appends a carriage return that becomes part of the secret;
  every comparison then fails while looking correct. Use Git Bash:
  `printf '%s' "$VALUE" | npx wrangler secret put NAME`.
- **A name cannot be both a `[vars]` entry and a secret.** Cloudflare rejects it
  with `code: 10053`. Delete the var, `wrangler deploy`, *then* `secret put`.
- **Intuit development keys only reach sandbox companies; production keys only
  reach production companies.** They are strictly paired. Production keys
  require a self-assessment questionnaire and Intuit approval, even for private
  apps.
- **Intuit redirect URIs must be `https`**, so OAuth cannot be seeded against
  localhost. Local dev runs in `QBO_MODE = "fixture"`; tokens live in the
  deployed Worker.
- Redirect URIs registered under the Development tab do **not** carry over to
  Production. Register again.
- `Intl.DateTimeFormat` rejects combining `dateStyle`/`timeStyle` with
  `timeZoneName`. Use explicit component options.

## Verified vs. not

Verified against live infrastructure: OAuth seeding, live account reads, the
snapshot cache round-trip, per-account degradation with total suppression, the
401 boundary, CORS from the real Pages origin, the disconnect/revoke path
(Intuit confirmed the revocation), the hourly cron firing unattended, and — as
of 2026-08-14 — the token refresh itself:

```
"kind":"refreshed","detail":"new access token valid 3600s; refresh token unchanged"
```

**One sub-case is still test-only: a rotated refresh token.** Intuit returned
the same refresh token on that first live refresh, which is normal — it rotates
roughly every 24 hours, not every hour. So the property that matters most, that
a *rotated* value is re-stored, has been proven by `worker/test/tokens.test.ts`
but not yet observed live. Confirm it by checking `/admin/status` for a
`refreshed` event whose detail says `rotated` rather than `unchanged`; there
should be one within a day of the connection being seeded.

The tests also cover `invalid_grant`, an unreachable Intuit, and the
single-flight guard. None of those three can be reached against live Intuit at
all — forcing `invalid_grant` means revoking the real grant, Intuit cannot be
made unreachable on demand, and nothing in normal operation issues two
concurrent refreshes.

If the dashboard ever reports "needs to be reconnected" unexpectedly, look at
that event log first, then at `worker/src/tokens.ts`.

Two properties there are load-bearing and easy to break by accident, so the
tests were checked by deliberately breaking each one and confirming they caught
it:

- **The refresh token must be re-stored on every refresh.** Intuit rotates it
  and expires the old value immediately. Persisting only the access token leaves
  the connection working until the next refresh, then breaks it permanently.
- **The single-flight guard is not defensive decoration.** Removing it produces
  two concurrent refreshes, which is the case Intuit answers with
  `invalid_grant` — turning a page load into a revoked connection.

## Running the tests

```
cd worker && npm test          # vitest run, inside workerd
cd worker && npm run typecheck  # src and test both
```

Tests use `@cloudflare/vitest-pool-workers`, which needs the `nodejs_compat`
compatibility flag. It is set in `vitest.config.ts` only — the deployed Worker
does not need it, and `wrangler.toml` is deliberately left alone.

## Phase status

- **Phase 1 — funds snapshot: done**, against sandbox data.
- **Phase 2 — LGL grant funnel: not started.** Independent of QuickBooks
  production keys, so it can proceed in parallel with that approval.
- **Phase 3 — phase readiness: not started.** Needs the Dry-in target cost from
  the general contractor.

## Context

Solo project, no deadline, no other board member depends on it. Favor the
shortest path to something working over staging fidelity or process ceremony.
Commits go straight to `main`; no PRs.
