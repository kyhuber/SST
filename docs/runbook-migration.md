# Runbook — moving to the organization, and Phase 2 prerequisites

Click-by-click steps for the items in `KYLE-TODO.md`. Written to be followed
without remembering any of the surrounding context.

Every section ends with a verification step. Do it — several of these fail
silently, and the failure only shows up later as a broken dashboard.

**What is *not* changing:** the Worker URL stays
`hpic-sst.kyhuber-ft.workers.dev`. That URL is the Intuit OAuth redirect URI, so
leaving it alone means none of this touches the QuickBooks connection. The
Cloudflare account stays personal for now by decision.

---

## §1 — Create the GitHub organization and transfer the repo

Do this before §2, so the DNS record in §2 only has to be set once.

1. Go to https://github.com/organizations/plan and choose **Free**.
2. Name it something durable and organizational — `hpic1919` matches the
   domain. Avoid anything with a person's name in it.
3. Set the billing email to an address on the org's Workspace, not a personal
   one.
4. In the **existing** repo (`kyhuber/SST`): **Settings → General**, scroll to
   **Danger Zone**, choose **Transfer ownership**.
5. Enter the new organization as the destination and confirm.

GitHub leaves a redirect behind, so existing clone URLs and links keep working.
Your local clone keeps pushing to the old remote through that redirect, but
update it anyway so nothing depends on a redirect:

```bash
git remote set-url origin https://github.com/<neworg>/SST.git
git remote -v
```

### Re-enable what the transfer turns off

A transfer disables Actions and can reset Pages. Both need turning back on.

6. **Settings → Actions → General** — allow Actions to run.
7. **Settings → Pages** — set **Source** to **GitHub Actions**. The workflow in
   `.github/workflows/deploy-pages.yml` publishes through the Actions Pages
   flow, not the legacy branch-based one.
8. **Actions** tab → *Deploy dashboard to Pages* → **Run workflow** to publish
   once without waiting for a push.

### Verify

Load `https://<neworg>.github.io/SST/`. You should get the passphrase prompt.
It will *not* show balances yet — `ALLOWED_ORIGIN` still names the old origin,
so the browser blocks the Worker call. That is expected and §3 fixes it.

---

## §2 — Point `sst.hpic1919.org` at the dashboard

No nameserver change. The domain stays on Squarespace; you are adding one
record.

1. In the transferred repo: **Settings → Pages → Custom domain**, enter
   `sst.hpic1919.org`, and **Save**. GitHub commits a `CNAME` file to the repo.
2. In Squarespace: **Settings → Domains → hpic1919.org → DNS Settings**.
3. Add a record:
   - Type: `CNAME`
   - Host: `sst`
   - Data: `<neworg>.github.io`  ← the organization, not `kyhuber`
4. Save, then wait. Propagation is usually minutes but can take up to an hour.
5. Back in **Settings → Pages**, wait for the DNS check to go green, then tick
   **Enforce HTTPS**. The certificate is issued automatically; the tickbox stays
   greyed out until DNS resolves, which is the usual reason this looks broken.

### Verify

```bash
nslookup sst.hpic1919.org
```

Should resolve to GitHub. Then load `https://sst.hpic1919.org` — passphrase
prompt, still no balances until §3.

---

## §3 — Update `ALLOWED_ORIGIN` and redeploy the Worker

The Worker only answers browsers from an origin it recognises. Until this
lands, the dashboard loads but every data call fails CORS.

1. Edit `worker/wrangler.toml`:

```toml
ALLOWED_ORIGIN = "https://sst.hpic1919.org"
```

2. Deploy — from `worker/`, and note this is deliberately manual because the
   Worker holds every credential:

```bash
cd worker
npx wrangler deploy
```

3. Commit the change.

### Verify

Open `https://sst.hpic1919.org`, enter the passphrase, and confirm balances
render. That single check exercises the whole chain: Pages → DNS → CORS →
Worker → QuickBooks. If the page loads but the panel shows an error, open the
browser console — a CORS message means `ALLOWED_ORIGIN` and the address bar do
not match exactly, including the `https://` and any trailing slash.

---

## §4 — Issue a Little Green Light API key

1. In LGL, open **Settings → Integration Settings** and find the API section.
   (Verify the exact path in LGL's current UI; it moves between releases.)
2. Generate a **new** key for this tool. Do not reuse the membership lookup
   tool's key — `worker/wrangler.toml` says so explicitly, and one shared key
   means rotating it breaks both tools at once.
3. Store it in the Worker, from `worker/`, in Git Bash and never PowerShell:

```bash
printf '%s' 'THE-KEY' | npx wrangler secret put LGL_API_KEY
```

PowerShell's pipe appends a carriage return that becomes part of the secret.
Every comparison then fails while looking correct.

### Verify

```bash
npx wrangler secret list
```

`LGL_API_KEY` should appear. Values are never shown — secrets are write-only,
so record the key in your password manager before you set it.

---

## §5 — Check whether LGL Pledge supports custom fields

The spec calls this a verification step before building the reimbursable
display, because the answer changes what go-live requires.

1. In LGL admin, open the custom fields settings.
2. Look at the list of item types custom fields can be attached to.
3. If **Pledge** is there, define two fields:
   - `reimbursable`
   - `contract_signed`
4. If Pledge is **not** there, note that and tell Claude.

Either answer is workable. The dashboard renders unknown reimbursable status as
unknown by construction, so populating the fields later lights up the feature
with no code change. What matters is knowing which situation you are in — this
is the split that keeps roughly $900,000 of cost-reimbursement awards from
being presented as spendable cash.

---

## §6 — Confirm the Intuit developer account survives you

The account is registered to `kyle.huber@hpic1919.org`, already on the
organization's Google Workspace. That is the right side of the line. The
remaining risk is that it is a personal mailbox: if the account is deleted when
you step back, recovery could be awkward.

Pick whichever is easier:

- **Confirm a Workspace admin can recover the mailbox** (or that you are the
  admin and someone else also has admin rights), or
- **Move the Intuit login to a role address** such as `tech@hpic1919.org`, with
  the mailbox delegated to whoever holds the role.

Do this before applying for production keys. Re-registering a redirect URI on an
existing app takes two minutes; moving an *approved* app to a different
developer account, and redoing Intuit's self-assessment questionnaire, does not.

### Verify

Sign in to the Intuit developer portal with the account and confirm the app
`hpic-sst` is listed, along with its Development keys.
