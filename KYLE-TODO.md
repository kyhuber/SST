# Kyle's to-do

The standing list of work that only a human can do — anything needing a login,
a DNS record, an approval, or a conversation with another person — **plus the
current build plan**, so the two stay visible against each other. Items marked
*(Claude)* are code; everything else is Kyle's.

**Read this first when starting a session.** Claude keeps it current; ask it to
tick items off and add new ones as decisions get made. Detailed click-by-click
steps live in `docs/runbook-migration.md`.

Ordered by what unblocks the most. Nothing here is urgent — this is a solo
project with no deadline.

---

## Start here — the prototype build

Ordered so each step produces something demonstrable. The governing idea, which
is Kyle's and worth stating because it shapes every choice under it: **ship the
product first and let it expose the data gaps, then use that evidence to
introduce the rules.** Volunteers do not adopt a data-entry standard for a
system whose output they have never seen. The dashboard's job is to make the
cost of a missing link visible in dollars.

That only works if the product never launders a gap into a clean number, which
is exactly what the existing invariants already enforce. Launching on imperfect
data is not a compromise of "an honest unavailable beats a clean number hiding
a caveat" — it is that rule doing its job.

- [ ] **P1. Render Received and Outstanding provisionally from LGL.** *(Claude)*
      Walk `parent_gift_id` from each payment up to its award — never filter
      payments by campaign, which drops $372,429 of the Commerce award (see the
      reference section). Label the figures **"per LGL, not reconciled to the
      books"** and never present them as cash confirmed.

      Live data gives Received $545,000 and Outstanding $926,000, so this is a
      real demo rather than an empty frame.

- [ ] **P2. Build the data-quality panel — the piece that makes the strategy
      work.** *(Claude)* Today Received says "Not shown", which is honest and inert. It
      needs to say *what is wrong and which records*:

      > **Received — provisional.** 3 payments totalling $10,500 are not linked
      > to an award: Office of Arts & Culture $7,500 (Jan 2025), Seattle Public
      > Utilities $1,500 (May 2025) and $1,500 (May 2026).

      That turns a report into a worklist, and the governance rules then write
      themselves from the exception list. It also means the board is looking at
      their own records rather than at Kyle's opinion of their processes.

      The panel should surface, at minimum: payments with no parent award,
      awards with no campaign, non-grant income sitting in category 6076,
      awards missing `reimbursable`, and — once P3 lands — QuickBooks
      transactions carrying no grant class.

- [ ] **P3. Add the QuickBooks grant dimension for Received and Spent.**
      *(Claude, once the classes exist)*
      Spec in item 0. Blocked on the bookkeeping practice existing, not on
      code. Until then these render unavailable with the reason, sitting beside
      the provisional LGL figures — **and that contrast is the argument for
      making the change.**

- [ ] **P4. Phase 3 stays blocked, deliberately.** "Spendable excludes
      unreceived reimbursable awards" needs authoritative Received *and* the
      `reimbursable` flag, which is unknown on all 10 awards. This is the one
      figure where being wrong costs real money, so it waits for both. The
      Dry-in target cost from the GC is still outstanding regardless.


## Answered — what had been blocking the cutover

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

- [x] **A2. Decide where Received comes from. — DECIDED 2026-08-19: QuickBooks
      is authoritative, LGL is provisional.** Reasoning below under item 0.

## Housekeeping, already done

- [x] **B. Re-set the LGL API key as a Worker secret. — DONE 2026-08-19.**
      The `wrangler secret put` failed first with "the latest version of your
      worker isn't currently deployed"; `npx wrangler deploy` from `worker/`
      cleared it. Worth remembering: a secret cannot be bound to a version that
      is not the deployed one. The key in `worker/.dev.vars` was never
      bracketed — every live read authenticated fine.
- [x] **C. Push the two local commits. — DONE.** `main` and `origin/main` are
      both at `3c5793b`; nothing is outstanding.

- [x] **D. Scope the funnel, flip to live, deploy once. — DONE 2026-08-19**
      (`a8d2903`). `LGL_MODE = "live"`, scoped to campaign 871 and category
      6031, deployed as version `7e381f25`. The bindings came back as expected
      and `/api/grants` still answers 401 without the passphrase, so the auth
      boundary survived.

      Flipping the config broke three tests, usefully: `liveEnv` and
      `fixtureEnv` spread the wrangler-derived env, so the tests asserting
      *unscoped* behaviour inherited the new scope and began asserting the
      opposite of what they were written for. Both helpers now clear the scope
      before applying overrides.

      **Still worth eyeballing on the dashboard:** Pledged should read
      $1,471,000 across 6 records, with Received and Outstanding showing "Not
      shown" and no unscoped banner.

## Phase 2 — the data structure, as recommended

- [ ] **0. Stand up one QuickBooks Class per grant award.**
      This replaces the old "decide what ties a class to an award" item. The
      recommendation below is Claude's; it is written as a spec rather than as
      options because Kyle asked for an opinion to build against.

      **Why QuickBooks for both Received and Spent, not just Spent.** Spent has
      no alternative — LGL has no concept of an expense, and invoicing a
      cost-reimbursement funder requires knowing what HPIC spent. Once a grant
      dimension exists in QuickBooks for expenses, the *same* dimension gives
      Received for free: a grant deposit coded to it. Sourcing Received from
      LGL instead means maintaining two parallel attribution systems and
      reconciling them forever. One dimension, one rule for whoever enters a
      transaction.

      **Why Class rather than Customer or Project.** Class is the one field
      that behaves identically on a deposit and on an expense, so the rule is
      symmetric and takes one sentence to teach: *every grant deposit and every
      grant-funded expense carries the grant's class.* Customer/Project is more
      powerful — QuickBooks Projects gives a per-grant P&L, and billable
      expenses model cost-reimbursement natively — but it asks a volunteer
      bookkeeper to put a "customer" on an expense, which reliably does not
      happen. **Revisit Projects if and when reimbursement invoicing moves into
      QuickBooks;** class-per-grant does not preclude adding it later.

      **How a class ties to an LGL award: an explicit map in Worker config,
      keyed by LGL gift id.** Not a naming convention. A convention is a string
      match, so renaming or mistyping a class in QuickBooks silently detaches
      the grant and a number quietly drops — the exact failure this tool
      exists to prevent. An explicit map fails loudly instead: a mapped grant
      whose class has vanished renders unavailable, and a class with no mapping
      is reported as unattributed. With ~10 grants the map is trivial, and
      needing a deploy to add one is a feature rather than a cost — it makes
      adding a grant a deliberate act.

      If the grant count ever outgrows that, move the key into the class name
      (`Grant 903691 — Commerce BFA`) and parse it, keeping the loud-failure
      property. Do not switch to matching on funder name.

      **The completeness rule, which is not optional:**

      - Per-grant Received and Spent render from that grant's class.
      - Deposits and expenses in the rebuild accounts carrying **no** grant
        class are an *unattributed pool*, surfaced with a count and a total.
        They are never absorbed into a grant and never silently dropped.
      - The roll-up "total grant cash received" renders **only when the
        unattributed pool is empty**, exactly as total cash renders only when
        every account reads successfully. An unattributed deposit might belong
        to any grant, so a roll-up computed over an incomplete attribution is a
        number hiding a caveat.

      **What Kyle needs to do before P3 can be built:** create the classes,
      apply them going forward, and decide whether to backfill history. The
      code cannot proceed without at least one grant coded end to end.

## The LGL rules to introduce — Claude's recommendation

Not a to-do so much as the standard to hold records to, and the thing P2's
panel should measure against. Ordered by how much breaks without it.

1. **Every payment links to its award** via `parent_gift_id`. This is the only
   genuinely load-bearing rule; 3 of 11 payments violate it today.
2. **Every award exists in LGL**, including historical ones. The $7,500 Arts &
   Culture payment references a 2025 CARE award that is not in the system at
   all — the only CARE record is a $3,400 pledge for 2026.
3. **Category 6076 holds grant payments only.** Two Seattle Public Utilities
   compost-event fee-for-service records sit there today. **Do not "fix" these
   unilaterally** — a note on one says it was coded that way deliberately to
   match the QuickBooks record, so changing it back would break an agreement
   someone made on purpose. That one is a conversation with Galen.
4. **Custom fields on Pledge: `reimbursable` and `contract_signed`.** Zero
   awards carry any custom field, so reimbursable is unknown on all 10 and
   Phase 3 is unbuildable. Purely additive to define, so this is the cheapest
   high-value change available.
5. **Award status lives in a field, not a note.** The Goal note on the $38,000
   OAC award still says a decision was anticipated April 2026, months after the
   award landed and was signed.
6. **Campaign on awards is required; on payments it is optional.** The
   dashboard reaches the campaign by walking to the award, so payments do not
   need it — but LGL's own campaign reports miss $372,429 of Commerce money
   without it, which is the honest reason to ask for it.

Worth investigating once: **LGL's `Installment` gift type (13) exists and is
unused.** If it enforces the payment-to-award link that hand-entered type-1
gifts do not, rule 1 becomes structural instead of a habit.

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
      like rather than whether anything works. **This is rule 4 of the LGL
      rules above, and the cheapest high-value change available** — defining a
      custom field is purely additive and unblocks Phase 3.
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

      **First concrete instance, found 2026-08-19:** the $7,500 Office of Arts
      & Culture payment (gift 906707) is noted as an "Addition to 2025 CARE
      grant award", but **no 2025 CARE award exists in LGL** — the only CARE
      record is a $3,400 pledge for 2026. So this is a missing award record
      rather than a missing link, and it is the kind of gap P2's panel is meant
      to surface automatically instead of by hand.
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
| Goal | 14 | 6051 "Grant Proposal" | the application; **no amount exposed** (`null`) |
| Pledge | 7 | **6031** "Grant" | the award; `received_amount` = face amount |
| Gift | 1 | **6076** "Grant" | actual cash, linked by `parent_gift_id` |

**Awards and payments sit in two different categories that share the display
name "Grant".** 6031 holds awards, 6076 holds payments. `categories=in|6031`
returns pledges only — correct for Pledged, and wrong for anything computing
Received, which must read 6076 too. Since the gift-categories endpoint returns
blank names, the two are indistinguishable from that list; they were told apart
only by reading `gift_category_id` off known records.

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

**Payment linkage is not reliable, either.** Of 11 records in category 6076,
3 have no `parent_gift_id` at all, totalling $10,500 — and two of those are
not grants: $1,500 twice for a 2025 compost event, recoded from
Fee-for-Service. So summing child gifts undercounts, and the category itself
contains non-grant activity. One of those notes reads *"This coding matches
Quickbooks record"* — somebody is already retrofitting LGL by hand to agree
with the books, which is worth weighing in A2.

**A Goal's note is not a status signal.** Pledge 906602 ($38,000) hangs off a
Goal noted "decision anticipated April 2026", yet the award landed 2025-12-04
and has a signed OAC Grant Agreement; the note was simply never updated after
the decision came in. Read the structure instead — a type-7 pledge means
awarded, a child type-1 gift means cash arrived. (Confirmed with Kyle in the
LGL UI, 2026-08-19.)

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
- **Ship the product first, then introduce the rules.** Governance-first fails
  with volunteers: nobody adopts a data-entry standard for a system whose
  output they have never seen. The dashboard makes the cost of a missing link
  visible in dollars, which is an argument no policy memo makes as well. This
  is safe only because the invariants refuse to launder a gap into a clean
  number — launching on imperfect data exercises that rule rather than bending
  it. (Kyle, with board backing, 2026-08-19.)
- **QuickBooks is authoritative for Received as well as Spent; LGL Received is
  provisional and labelled as such.** Spent has no alternative, and once a
  grant dimension exists in QuickBooks the same dimension answers Received.
  Sourcing Received from LGL instead would mean maintaining two attribution
  systems forever. Showing both — provisional beside unavailable — is itself
  the argument for the bookkeeping change. (2026-08-19, superseding the
  2026-08-19 note below, which was reasoning from a premise since disproved.)
- **One QuickBooks Class per grant award, mapped to LGL gift ids in Worker
  config.** Class because it is the one field that behaves the same on a
  deposit and an expense; explicit map because a naming convention detaches
  silently when someone renames a class, and silent is the one failure mode
  this tool exists to prevent.
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
