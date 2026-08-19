# Kyle's to-do

The standing list of work that only a human can do — anything needing a login,
a DNS record, an approval, or a conversation with another person.

**Read this first when starting a session.** Claude keeps it current; ask it to
tick items off and add new ones as decisions get made. Detailed click-by-click
steps live in `docs/runbook-migration.md`.

Ordered by what unblocks the most. Nothing here is urgent — this is a solo
project with no deadline.

---

## Next up

- [ ] **1. Create the HPIC GitHub organization and transfer this repo.**
      Gives the org a home for this and the other tools you have built, so they
      outlast any one person's involvement.
      → `docs/runbook-migration.md` §1

- [ ] **2. Point `sst.hpic1919.org` at the dashboard.**
      Do this *after* the transfer, so the DNS record is only set once. Gives
      the board a URL that can be said out loud, and one that survives any
      future hosting change.
      → `docs/runbook-migration.md` §2

- [ ] **3. Update `ALLOWED_ORIGIN` and redeploy the Worker.**
      The dashboard's origin changes with the custom domain, and CORS will
      block it until the Worker is told. One line, one deploy.
      → `docs/runbook-migration.md` §3

## Phase 2 — the open decision

- [ ] **0. Decide what ties a QuickBooks class to an LGL award.**
      This replaces the old "ask LGL support about a pledge balance" item, which
      was dropped on 2026-08-19 as the wrong question. Received and Outstanding
      are cash facts and QuickBooks is the system of record for cash, so they
      are reconciled from QuickBooks rather than read from LGL. The reimbursement
      case settles it: invoicing a funder on a cost-reimbursement award requires
      knowing what HPIC **spent**, and spending exists only in QuickBooks.

      What is needed is a bookkeeping practice — QuickBooks carrying a class,
      customer, or project that identifies the grant, applied consistently at
      entry time. The decision to make first is which of those, and how it maps
      to an LGL award: a naming convention, one customer or project per grant,
      or an explicit mapping in Worker config.

      This is yours because it is a process change, not code. Everything
      downstream depends on the key being applied the same way every time, and a
      deposit coded to no class is invisible to the reconciliation — which by
      this project's own rule must render as unavailable, not as a low number.

## Phase 2 prerequisites

Neither blocks the current fixture build, but both are needed before it reads
live data.

- [ ] **4. Issue a fresh Little Green Light API key, scoped to this tool.**
      Do not reuse the membership lookup tool's key. `worker/wrangler.toml`
      says so explicitly, and sharing one key means rotating it breaks two
      tools at once.
      → `docs/runbook-migration.md` §4

- [ ] **5. Confirm in LGL admin whether Pledge supports custom fields.**
      If it does, define `reimbursable` and `contract_signed`. If it does not,
      say so — the build renders "unknown" either way, but the answer changes
      what go-live looks like.
      → `docs/runbook-migration.md` §5

## Before QuickBooks production keys

- [ ] **6. Confirm the Intuit developer account is recoverable without you.**
      It is registered to `kyle.huber@hpic1919.org`, which is already on the
      org's Google Workspace — good. Check that a Workspace admin can recover
      the mailbox, or move the Intuit login to a role address.
      → `docs/runbook-migration.md` §6

- [ ] **7. Apply for QuickBooks production keys.**
      Requires Intuit's self-assessment questionnaire and their approval, even
      for a private app. Do item 6 first: redoing this under a different
      developer account is the one genuinely painful step in the whole
      migration.

## Waiting on other people

Not yours to do, but worth tracking so the wait is visible.

- [ ] **Development committee** — reconcile manually tracked grants into LGL.
      Until this happens, grant figures reflect what is in LGL, not a complete
      grant history, and the UI must say so.
- [ ] **General contractor** — the Dry-in target cost. Phase 3 cannot start
      without it.

## One-off check

- [ ] **Confirm a rotated refresh token.** Open `/admin/status` and look for a
      `refreshed` event whose detail says `rotated` rather than `unchanged`.
      Intuit rotates roughly every 24 hours. This closes the last open item in
      Phase 1's verification; tell Claude when you see it and it will update
      CLAUDE.md.

---

## Recently done

- Phase 2 thin slice: LGL client, `/api/grants`, fixtures, tests, UI panel
  (2026-08-14). Fixture-only — no live LGL read yet.
- Rotated `ACCESS_PASSPHRASE` after it was exposed in a screenshot (2026-08-14)
- Verified the token refresh against live Intuit (2026-08-14)
- Added the Worker test suite; `cd worker && npm test`
- Narrowed the grant funnel to start at pledges, per Alex. The spec changed
  first; the `appeal_request` reads and the `/appeals` enumeration came out of
  the Worker, tests, fixtures, and UI on 2026-08-18.

## Decisions on record

Kept here so they are not re-litigated from memory.

- **Grant applications are out of scope.** This tool starts at money awarded or
  promised. LGL goals still track applications; that is simply not this tool's
  job. (Alex, 2026-08-14)
- **Received and Outstanding come from QuickBooks, not LGL.** LGL is
  authoritative for what was awarded; QuickBooks is authoritative for cash
  received and money spent. Asking LGL for an amount-due field was the wrong
  question, so that item is closed rather than deferred. The work this creates
  is a QuickBooks class discipline, tracked as item 0. (Kyle, 2026-08-19)
- **Cloudflare stays on the personal account for now**, and transfers when Kyle
  steps back from the organization. GitHub moves to the org immediately because
  it hosts several tools other members should be able to reach.
- **No D1 database.** The hourly cron and the Durable Object snapshot cache
  already provide serve-from-cache behaviour. A database earns its place when
  historical trends come into scope, and trends are explicitly out of scope.
