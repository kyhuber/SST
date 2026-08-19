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

- [x] **A. Settle what "deposited" means on a grant pledge in LGL. — ANSWERED
      2026-08-19, and the answer was the dangerous one.**
      `received_amount` on a Pledge is the **award amount, not cash**. The
      `deposited_amount` and `deposit_date` fields are stamped when the pledge is
      entered and do **not** mean money arrived. Trusting them would have
      overstated cash by $926,000.

      Cash lives in separate child records — type-1 `Gift`s whose
      `parent_gift_id` points at the pledge. Alex's formula reproduces exactly:
      amount due = pledge amount − sum of child gifts. Three levels, and only
      the middle one is read today:

      | Level | Type | Category | Holds |
      | --- | --- | --- | --- |
      | Goal | 14 | Grant Proposal | the application; **no amount exposed** (`null`) |
      | Pledge | 7 | Grant | the award; `received_amount` = face amount |
      | Gift | 1 | Grant | actual cash, linked by `parent_gift_id` |

      Against live data: **Pledged $1,471,000 · Received $545,000 · Outstanding
      $926,000.** The $388,000 reimbursable award has zero payments against it;
      the $485,000 one was drawn in three installments over a year. **The spec's
      premise is intact, not stale.**

      **Nothing shipped was wrong.** `giftAmount()` sums type-7 records and
      labels the total Pledged, which is correct; Received and Outstanding
      render "Not shown". The $1,471,000 was never presented as cash.

- [ ] **A2. Ask Alex whether Received should come from LGL or QuickBooks.**
      The factual question in A is closed, but it overturns a premise. CLAUDE.md
      and item 0 both say Received and Outstanding must come from QuickBooks
      *because LGL has no amount-due field*. LGL does have the answer after all,
      via child gifts. So the choice is now a judgment call about which system
      the board treats as authoritative for cash:

      - **LGL** — works today, no new bookkeeping. Correct only if whoever
        enters grants records every payment as it arrives.
      - **QuickBooks** — genuinely authoritative for cash, but needs the class
        or customer discipline in item 0, which does not exist today.

      Note the reasoning still holds unchanged for **Spent**: invoicing a
      cost-reimbursement funder requires knowing what HPIC spent, and spending
      exists only in QuickBooks. This decision is about Received only.

      Also worth asking in the same breath: pledge 906602 ($38,000) is entered
      as an award, but its Goal note reads "Application Year 2025, decision
      anticipated April 2026." Awarded, or still pending?

- [x] **B. Re-set the LGL API key as a Worker secret. — DONE 2026-08-19.**
      The `wrangler secret put` failed first with "the latest version of your
      worker isn't currently deployed"; `npx wrangler deploy` from `worker/`
      cleared it. Worth remembering: a secret cannot be bound to a version that
      is not the deployed one. The key in `worker/.dev.vars` was never
      bracketed — every live read authenticated fine.
- [x] **C. Push the two local commits. — DONE.** `main` and `origin/main` are
      both at `3c5793b`; nothing is outstanding.

## Then — the live LGL cutover

- [ ] **D. Scope the funnel, flip to live, deploy once.**
      **No longer blocked by A.** The fear was publishing $1,471,000 as cash in
      hand; the code labels it Pledged, which is correct, and leaves Received
      and Outstanding unavailable. Going live now is honest whatever Alex says
      about A2 — his answer changes what gets *added*, not whether Pledged is
      right. All the values are verified and recorded below. In `worker/wrangler.toml`:
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
| Scoped to 871 + 6031 | 6 pledges, **$1,471,000 awarded** (not received — see below) |
| Category 6031 alone | 10 pledges, $1,528,372 — adds ~$57k of Programs grants |
| Pledges carrying a custom field | 0 of 13, so reimbursable is "unknown" for every award |
| `auto_sync_to_qbo` | `false` on every record |

### The three-level gift structure — verified 2026-08-19

This is the part that was misread the first time. `node lgl-inspect.mjs`
regenerates the scope IDs; the payment tree below came from following
`parent_gift_id` on each scoped pledge.

| Level | Type | Category | Holds |
| --- | --- | --- | --- |
| Goal | 14 | Grant Proposal | the application; **no amount exposed** (`null`) |
| Pledge | 7 | Grant | the award; `received_amount` = face amount |
| Gift | 1 | Grant | actual cash, linked by `parent_gift_id` |

```
pledge 903691   $485,000   <- $279,573.79 + $92,855.92 + $112,570.29   due $0
pledge 909194    $50,000   <- $50,000                                  due $0
pledge 904066    $10,000   <- $10,000                                  due $0
pledge 905997   $500,000   <- (none)                            due $500,000
pledge 905452   $388,000   <- (none)                            due $388,000
pledge 906602    $38,000   <- (none)                             due $38,000
                                                         ────────────────────
Pledged $1,471,000     Received $545,000     Outstanding $926,000
```

**Do not trust `deposited_amount` or `deposit_date` on a pledge.** They are
stamped at entry and equal `received_amount` on every record, including awards
with no payment against them at all. Reading them as cash overstates by
$926,000.

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

- Established what LGL actually exposes for grant cash (2026-08-19): pledges
  carry the award amount, child type-1 gifts carry the payments. Closes item A
  and reopens the Received/Outstanding source question as item A2.
- Committed `lgl-inspect.mjs` so the reference table is reproducible from a
  fresh clone rather than only on Kyle's machine (2026-08-19).
- Re-set `LGL_API_KEY` as a Worker secret after a `wrangler deploy` cleared the
  version mismatch (2026-08-19).
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
