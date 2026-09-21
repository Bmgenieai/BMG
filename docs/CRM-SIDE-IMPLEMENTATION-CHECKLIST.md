# CRM-side work (this agent) — paired with BMGenie main-site prompt

Companion to [`PROMPT-FOR-BMGENIE-MAIN-SITE.md`](./PROMPT-FOR-BMGENIE-MAIN-SITE.md).

User pastes the main-site prompt into the **BMGenie** agent. **This CRM agent** implements the CRM half against the same contracts.

## Do not wait for BMGenie to finish everything

Ship CRM pieces that do not depend on live events first (UI shells, ingest extensions, tables), then verify end-to-end when main emits.

## CRM deliverables

### 1. Extend ingest

File: `backend/src/routes/ingest.js`

Keep existing:

- `user.signup` → `signup_no_listing`
- `user.free_credit_used` → `free_credit_no_purchase`
- `user.purchased` → status `paid`
- `user.credits_depleted` → `purchased_no_repurchase`

Add:

- `user.checkout_opened` / `user.checkout_abandoned` → source `checkout_abandoned`
- `user.revision_requested` → source `revision_requested`
- `demo.booked` → create/update lead, status `demo_booked`, store schedule in notes/metadata
- `chat.started` / `chat.transcript` → chat_support store (not necessarily classic lead)

Store `metadata` JSON on lead or side tables.

New routes:

- `POST /api/ingest/calendly` — verify Calendly signature if configured; map `invitee.created` → `demo.booked` logic
- `POST /api/ingest/tawk` — verify Tawk signature; upsert chat threads

### 2. New lead sources + sidebar tabs

In `permissions.js` / `AppLayout.jsx`:

- Product tabs add: Checkout abandoned, Revisions requested (or keep under Analytics only + lists)
- New nav section or tabs: **Book a demo**, **Chat support**

### 3. CEO Analytics page

Route e.g. `/analytics` (ceo/manager).

Six cards (counts clickable → modal emails):

1. Daily new users — prefer `GET {BMGENIE_API_URL}/crm-analytics/daily-new-users` with `X-CRM-Ingest-Key`
2. Came today, no listings — main analytics API
3. Free listing, not paid — main analytics API +/or CRM `free_credit_no_purchase`
4. Stripe opened, abandoned — main analytics API +/or CRM source
5. Asked for revisions — main analytics API +/or CRM source
6. (Optional summary) Demo booked today / Open chats

Env:

```env
BMGENIE_API_URL=https://api.bmgenie.ai
# or http://localhost:<main-api-port>
CRM_INGEST_API_KEY=<same as ingest>
```

Fallback if main analytics unavailable: show CRM-ingest-based counts with banner.

### 4. Book a demo tab

List demo bookings: email, name, scheduledAt, timezone, Calendly links, assigned telesales optional.

### 5. Chat support tab

List Tawk chats: visitor, email, preview, time, link **Open in Tawk** (dashboard URL).

**Do not** build in-CRM reply composer (Tawk API cannot inject replies). Document that telesales reply in Tawk.

### 6. Docs

Update `backend/docs/DEPLOY-PRODUCTION.md` with Calendly + Tawk webhook URLs and new env vars.

## Event name lock (must match BMGenie prompt)

`user.signup` | `user.free_credit_used` | `user.purchased` | `user.credits_depleted` | `user.checkout_opened` | `user.checkout_abandoned` | `user.revision_requested` | `demo.booked` | `chat.started` | `chat.transcript`
