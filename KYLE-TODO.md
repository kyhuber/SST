# Kyle's to-do

The standing list of work that only a human can do — anything needing a login,
a DNS record, an approval, or a conversation with another person.

**Read this first when starting a session.** Claude keeps it current; ask it to
tick items off and add new ones as decisions get made. Detailed click-by-click
steps live in `docs/runbook-migration.md`.

Ordered by what unblocks the most. Nothing here is urgent — this is a solo
project with no deadline.

---

## Start here tomorrow

- [ ] **A. Settle what "deposited" means on a grant pledge in LGL.**
      **This is the one thing blocking a live cutover.** Every grant pledge read
      on 2026-08-19 had `deposited_amount` exactly equal to `received_amount`
      with a real `deposit_date`. Read literally, that says the full $1,471,000
      is already in the bank — including the two largest Rebuild awards,
      $485,000 and $388,000, which the spec describes as cost-reimbursement with
      no signed contract.

      Either those funds really have arrived and the spec's premise is stale, or
      LGL populates the deposit fields as bookkeeping when a pledge is entered
      and they do not mean cash. **Nobody should publish a figure until it is
      clear which.** Presenting unreceived reimbursable awards as money in hand
      is precisely the failure this dashboard exists to prevent.

      Probably two minutes: open one of the Rebuild pledges in the LGL UI, or
      ask whoever on the development committee enters grants. Tell Claude the
      answer and it will label the funnel accordingly.

- [ ] **B. Re-set the LGL API key as a Worker secret.**
      The value stored on 2026-08-18 was almost certainly wrapped in angle
      brackets. The `<key>` in the README is a fill-in marker, not literal text,
      and exactly that mistake was found and fixed in `worker/.dev.vars`.
      Secrets are write-only so it cannot be inspected — just set it again. A
      bracketed key fails identically to a revoked one, which is a genuinely
      confusing thing to debug later.

      From `worker/`, in Git Bash, with no angle brackets around the key:
      `printf '%s' 'the-key' | npx wrangler secret put LGL_API_KEY`

- [ ] **C. Push the two local commits.**
      `edf4815` and `b12c7d6` are committed locally and not on `origin/main`.
      Work reaches that branch from other sessions, so the gap is worth closing
      early. Ask Claude to push, or `git push`.

## Then — the live LGL cutover, once A is answered

- [ ] **D. Scope the funnel, flip to live, deploy once.**
      All the values are verified and recorded below. In `worker/wrangler.toml`:
      uncomment `LGL_GRANT_CAMPAIGN_IDS = "871"` and
      `LGL_GRANT_GIFT_CATEGORY_IDS = "6031"`, change `LGL_MODE` to `"live"`,
      commit, then `npx wrangler deploy` from `worker/`.

      Deliberately one deploy rather than two: going live unscoped would count
      individual donor pledges alongside grants. It says so in a banner, but the
      banner is avoidable.

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

      **Check LGL's own QuickBooks sync before designing a convention by hand.**
      Every record carries `auto_sync_to_qbo`, and it is `false` everywhere. If
      turning it on establishes a native link between an LGL gift and a
      QuickBooks entry, that is a better key than anything maintained manually.
      Worth an hour of investigation before committing to an approach.

      This is yours because it is a process change, not code. Everything
      downstream depends on the key being applied the same way every time, and a
      deposit coded to no class is invisible to the reconciliation — which by
      this project's own rule must render as unavailable, not as a low number.

## Next up — hosting and the org

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

## Phase 2 prerequisites

- [ ] **5. Confirm in LGL admin whether Pledge supports custom fields.**
      Partly answered by live data: **0 of 13 pledges carry any custom field**,
      so every award reads "unknown" today, as designed. That confirms none are
      *populated* — it does not say whether Pledge *supports* them. If it does,
      define `reimbursable` and `contract_signed`; if it does not, say so. The
      build renders "unknown" either way, so this changes what go-live looks
      like rather than whether anything works.
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

## Reference — verified against live LGL, 2026-08-19

Recorded so tomorrow does not begin by rediscovering it. `lgl-inspect.mjs` at
the repo root regenerates all of it: `node lgl-inspect.mjs`, reading the key
from `worker/.dev.vars`. Every request it makes is a GET.

| | |
| --- | --- |
| Pledge gift type | **7** (resolved by name, as the code expects) |
| Rebuild Project campaign | **871** |
| "Grant" gift category | **6031** |
| Scoped to 871 + 6031 | 6 pledges, **$1,471,000** |
| Category 6031 alone | 10 pledges, $1,528,372 — adds ~$57k of Programs grants |
| Pledges carrying a custom field | 0 of 13, so reimbursable is "unknown" for every award |
| `auto_sync_to_qbo` | `false` on every record |

Note the gift-categories endpoint returns **blank names**, so `6031` was
identified from the `gift_category_name` on real pledges rather than from that
list. Anyone re-deriving it should do the same.

### On Goals and applications — settling the 2026-08-19 confusion

Three separate things got tangled during that session. All now verified:

- **There is no `/goals` endpoint.** It returns 404. The original note in
  CLAUDE.md was correct; a mid-session claim that it was wrong was itself wrong.
- **Goal *is* a gift type** (id 14), and each grant pledge hangs off a Goal
  parent via `parent_gift_id`. But Goals are **dereferenceable, not
  discoverable**: absent from `/gift_types`, zero results from `gifts/search`,
  and absent from a constituent's own gift list. You can follow a pointer to
  one; you cannot enumerate them. They are not a usable data source.
- **`appeal_requests` are real and populated** — 8 appeals, 210+ requests. The
  `appeal_request` reads that were deleted worked fine. They were removed
  because applications are out of scope, **not** because they were unavailable.

None of this changes the code. `readAwards` queries `gift_types=in|7`, so the
funnel sees pledges only and Goals cannot reach it whatever the scope config.

## Recently done

- Removed Applied from the funnel; it is now Pledged → Received → Outstanding
  (`edf4815`, 2026-08-18). Alex confirmed the tool starts at money awarded, not
  requested, after the slice was already built.
- Redefined Received and Outstanding as QuickBooks figures rather than LGL ones
  (`b12c7d6`, 2026-08-19), including the note the board reads — it no longer
  blames LGL for a missing field.
- Issued the LGL API key and ran the first live read (2026-08-19). See the
  reference table above. Item B remains because the stored Worker secret is
  probably malformed.
- Phase 2 thin slice: LGL client, `/api/grants`, fixtures, tests, UI panel
  (2026-08-14).
- Rotated `ACCESS_PASSPHRASE` after it was exposed in a screenshot (2026-08-14)
- Verified the token refresh against live Intuit (2026-08-14)
- Added the Worker test suite; `cd worker && npm test`

## Decisions on record

Kept here so they are not re-litigated from memory.

- **Grant applications are out of scope.** This tool starts at money awarded or
  promised. LGL tracks applications as Goal-type gifts and as appeal_requests;
  neither is this tool's job. (Alex, 2026-08-14)
- **The funnel starts at Pledged structurally, not by convention.** `readAwards`
  filters `gift_types=in|7`, so nothing else can enter it.
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
