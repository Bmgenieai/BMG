# PROMPT FOR BMGENIE MAIN SITE (copy everything below the line into the BMGenie agent chat)

---

## Role

You are implementing the **BMGenie main product** half of a user-tracking + sales-ops pipeline.

- **This repo:** BMGenie main site — NestJS backend (`Bmgenieai/backend`) + Next.js frontend (`Bmgenieai/bm-front`).
- **Sibling system (DO NOT edit CRM UI/code here):** BMGenie CRM at `crm.bmgenie.ai` / `crm-api.bmgenie.ai` (repos `Bmgenieai/BMG` + `Bmgenieai/BMG-CRM`). Another agent owns CRM changes. You own **event emission, local persistence, and webhook receivers on the main API** that CRM can consume.

Work on branch `main` (or a feature branch off current `main`). Frontend already has Tawk.to on `main` (`feat(chat): add Tawk.to widget` in `app/layout.tsx`).

---

## Goal (CEO CRM Analytics + lead queues)

CEO portal needs product-user tracking. Main site must **emit reliable signals** so CRM can show:

1. **Daily new users** (count + email list)
2. **Users who came today but created no listings**
3. **Users who created a free listing but did not convert to paid**
4. **Users who opened Stripe checkout / payment box then abandoned**
5. **Users who asked for revisions**
6. **Book-a-demo bookings** (from Calendly on marketing site) → timing, email, name
7. **Homepage chat queries** (Tawk.to) → CRM can list them; telesales reply happens in Tawk dashboard (API cannot inject replies)

---

## Architecture (locked decisions)

```
BMGenie product (Postgres)  --HTTP push-->  CRM ingest (SQLite)
Calendly                    --webhook-->    Main API or CRM (prefer CRM URL; if main receives, forward)
Tawk.to                     --webhook-->    CRM (or main forwards to CRM)
Stripe PaymentIntents       --local row-->  Main DB + CRM event on open / abandon / success
```

- **No shared database.** Product = Postgres. CRM = SQLite.
- **Primary pattern:** fire-and-forget HTTP push from main API → `POST {CRM_API_URL}/ingest/product-leads` with header `X-CRM-Ingest-Key: {CRM_INGEST_API_KEY}`.
- **Never block** signup, listing, payment, or revision flows if CRM is down (log warn, swallow errors).
- Env already present locally on main backend `.env`:
  - `CRM_SYNC_ENABLED=true`
  - `CRM_API_URL=http://localhost:4050/api` (prod: `https://crm-api.bmgenie.ai/api`)
  - `CRM_INGEST_API_KEY=...` (must match CRM server)

---

## CRITICAL: restore CrmSync (deleted code)

A working `CrmSyncService` existed and was deleted on branch `benchmark` in commit `51b4250` (“drop accidental crm-sync files”).

**Restore and wire it on `main`:**

Recover from parent of that commit:

```bash
# from backend repo
git show 51b4250^:src/crm-sync/crm-sync.service.ts
git show 51b4250^:src/crm-sync/crm-sync.module.ts
```

Put back under `backend/src/crm-sync/`, register `CrmSyncModule` in `AppModule`, inject `CrmSyncService` at call sites below.

### Original events (keep + extend)

| Event | When | CRM lead `source` (existing) |
|-------|------|------------------------------|
| `user.signup` | Owner account created after OTP verify (and legacy register if still used) | `signup_no_listing` |
| `user.free_credit_used` | Free listing credit consumed | `free_credit_no_purchase` |
| `user.purchased` | Package PaymentIntent succeeded / credits granted | marks lead `paid` |
| `user.credits_depleted` | Paid credits hit zero | `purchased_no_repurchase` |

**Owner-only:** skip sync when `accountType !== 'owner'` (same as deleted service).

### New events CRM will accept (you must emit these)

| Event | When | Suggested CRM source / purpose |
|-------|------|--------------------------------|
| `user.checkout_opened` | User opens Stripe payment box (`create-intent` succeeds) | `checkout_abandoned` queue (until paid or cleared) |
| `user.checkout_abandoned` | Intent incomplete after TTL **or** Stripe `payment_intent.canceled` / leftover `requires_payment_method` after N hours | keep/update `checkout_abandoned` |
| `user.revision_requested` | `POST /listings/:id/request-revision` succeeds | `revision_requested` |
| `demo.booked` | Calendly invitee created (webhook) | CRM Book-a-demo tab / status `demo_booked` |
| `chat.started` / `chat.transcript` | Tawk webhook (prefer CRM receives directly; if main receives, forward unchanged + map) | CRM Chat support tab |

If CRM ingest rejects unknown events until CRM agent ships, still implement emitters; coordinate event names exactly as in this table (do not invent alternate names).

### Payload contract (all product-lead events)

`POST {CRM_API_URL}/ingest/product-leads`

Headers:

```http
Content-Type: application/json
X-CRM-Ingest-Key: <CRM_INGEST_API_KEY>
```

Body (JSON):

```json
{
  "event": "user.signup",
  "bmgenieUserId": "uuid",
  "name": "Jane Doe",
  "email": "jane@agency.com",
  "phone": "+1...",
  "company": "Agency LLC",
  "country": null,
  "estimatedValue": 65,
  "notes": "human readable",
  "metadata": {}
}
```

`metadata` is optional but **required for new events** as specified below. CRM agent will store it.

#### metadata by event

**user.checkout_opened**

```json
{
  "stripePaymentIntentId": "pi_...",
  "packageType": "professional",
  "amountUsd": 149,
  "openedAt": "ISO-8601"
}
```

**user.checkout_abandoned**

```json
{
  "stripePaymentIntentId": "pi_...",
  "packageType": "professional",
  "amountUsd": 149,
  "openedAt": "ISO-8601",
  "abandonedAt": "ISO-8601",
  "reason": "timeout|canceled|user_closed"
}
```

**user.revision_requested**

```json
{
  "listingId": "uuid",
  "revisionId": "uuid",
  "paymentStatus": "free|paid",
  "amountPaidUsd": 0
}
```

**demo.booked**

```json
{
  "scheduledAt": "ISO-8601",
  "timezone": "America/New_York",
  "calendlyEventUri": "...",
  "calendlyInviteeUri": "...",
  "durationMinutes": 30,
  "questionsAndAnswers": []
}
```

**chat.started / chat.transcript**

```json
{
  "provider": "tawk",
  "chatId": "...",
  "message": "first or summary",
  "transcript": [],
  "pageUrl": "https://bmgenie.ai/...",
  "tawkPropertyId": "6aaf9e58d673343444374636"
}
```

---

## Workstream A — Wire existing lifecycle sync

### A1. Signup

- File: `backend/src/auth/auth.service.ts` (OTP verify path that creates `User`)
- After owner user is saved → `crmSync.syncUserSignup(user)`
- Do not sync team members / non-owners

### A2. Free credit used

- File: `backend/src/listing-package/listing-package.service.ts` (where `freeListingsUsed` increments / free reservation created)
- After successful free credit consume → `crmSync.syncFreeCreditUsed(owner)`

### A3. Purchased

- On successful package grant (`payment_intent.succeeded` path / `confirm-grant`) → `crmSync.syncPurchased(user, { amountUsd, packageType, listingsGranted })`
- Clear any open checkout-abandoned state for that PI (local row + emit nothing else needed; purchase event wins)

### A4. Credits depleted

- When remaining paid listing credits reach 0 after consume → `crmSync.syncCreditsDepleted(user)`

### A5. Module registration

- `CrmSyncModule` imported in `AppModule`
- Document env in `infra/production.env.example` and `.env.example`:

```env
CRM_SYNC_ENABLED=true
CRM_API_URL=https://crm-api.bmgenie.ai/api
CRM_INGEST_API_KEY=<same as CRM Windows server>
```

---

## Workstream B — Stripe “opened box then changed mind”

Today: `POST /api/packages/create-intent` creates a Stripe PaymentIntent; success is persisted; **abandon is not stored in BMGenie DB**.

### B1. Persist checkout attempts locally

Add entity e.g. `CheckoutAttempt` / `listing_package_checkout_attempts`:

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| userId | uuid | FK users |
| stripePaymentIntentId | string unique | |
| packageType | string | |
| amountUsd | decimal/int | |
| status | enum | `opened` \| `succeeded` \| `abandoned` \| `canceled` |
| openedAt | timestamptz | |
| resolvedAt | timestamptz nullable | |
| metadata | jsonb nullable | |

Migration required.

### B2. On create-intent

After Stripe PI created successfully:

1. Insert row `status=opened`
2. Emit `user.checkout_opened` to CRM

Hook: `listing-package.service.ts` → `createPaymentIntent` / controller `create-intent`.

Frontend: `CheckoutModal.tsx` / `StripePaymentSheet.tsx` already call create-intent when modal opens — backend hook is enough (no frontend CRM calls).

### B3. On success

In existing `payment_intent.succeeded` / grant path: set attempt `succeeded`, `resolvedAt=now`.

### B4. Mark abandoned

Implement **at least one** of:

1. **Cron / interval job** (preferred): every 15–30 min, find `opened` attempts older than **2 hours** (or env `CHECKOUT_ABANDON_AFTER_MINUTES=120`), verify Stripe PI still not succeeded, set `abandoned`, emit `user.checkout_abandoned`.
2. **Stripe webhook:** handle `payment_intent.canceled` (and optionally incomplete) → abandon.

Do **not** mark abandoned if user later paid.

---

## Workstream C — Revisions

- Hook: `listings.service.ts` → `requestRevision` success
- Emit `user.revision_requested` with listing/revision ids and payment fields
- No change to revision workflow itself

---

## Workstream D — Book a demo (Calendly)

Marketing site uses:

- `BOOK_DEMO_URL` / `NEXT_PUBLIC_BOOK_DEMO_URL` → `https://calendly.com/bmgenie-ai/30min`

### Preferred path (CRM owns inbox)

CRM agent will expose:

`POST https://crm-api.bmgenie.ai/api/ingest/calendly` (or `/ingest/demo-bookings`)

**Your job on main site:**

1. Keep Calendly CTA as-is (do not replace with a custom form).
2. Document in a short `docs/CRM-CALENDLY.md` (or comment in constants) that **Calendly webhook URL should point to CRM ingest**, not main API.
3. Optional fallback: if product prefers webhooks on `api.bmgenie.ai`, add `POST /webhooks/calendly` that verifies Calendly signing key and **forwards** as `demo.booked` to CRM ingest. Only build this if CRM webhook URL is hard to configure; otherwise skip and document CRM URL.

Calendly event to handle: `invitee.created` (and optionally `invitee.canceled`).

Map fields: name, email, scheduled start time, timezone, event URI, questions.

---

## Workstream E — Chat support (Tawk.to) — already on frontend

Frontend `app/layout.tsx` embeds:

`https://embed.tawk.to/6aaf9e58d673343444374636/1k2v052u3`

### Important product constraint

- Tawk **webhooks** can push chat start / end / transcript to our servers.
- Tawk **cannot** send agent replies into the widget via REST from CRM.
- Telesales reply = **Tawk dashboard** (CRM will deep-link). Your job is data ingress only.

### Preferred path

Point Tawk property webhooks at CRM:

`POST https://crm-api.bmgenie.ai/api/ingest/tawk`

### Your optional improvements on main frontend

1. Identify logged-in visitors so CRM can match users:

```js
// before/after widget load — use Tawk JS API
Tawk_API.visitor = { name: user.name, email: user.email };
// and/or Tawk_API.setAttributes({ bmgenieUserId: user.id }, cb)
```

Wire this in a small client component only when session exists (do not break anonymous homepage).

2. Document webhook target for ops: `docs/CRM-TAWK.md` with property id + CRM URL + that replies stay in Tawk.

3. Only add `POST /webhooks/tawk` on main API if you must forward; prefer CRM direct.

---

## Workstream F — Secure read APIs for CEO “today” analytics (required)

CRM Analytics page needs **accurate “today” lists**, not only lead queues. Event push can lag or miss; CRM will also call main API for live queries.

Add **service-to-service** analytics endpoints on main API (NestJS), auth via shared secret header (reuse pattern similar to ingest key — e.g. `X-CRM-Ingest-Key` or new `X-CRM-Analytics-Key` that equals `CRM_INGEST_API_KEY` for simplicity).

### Endpoints (all GET, timezone `America/New_York` or env `CRM_ANALYTICS_TZ`, date = calendar day in that TZ unless `?date=YYYY-MM-DD`)

Base prefix suggestion: `/api/crm-analytics/` (or `/analytics/crm/`)

| Endpoint | Returns |
|----------|---------|
| `GET .../daily-new-users` | `{ count, users: [{ id, email, name, phone, company, createdAt }] }` |
| `GET .../daily-no-listings` | Users created **or last-seen today** who have **zero listings** (define: `listings` count for owner workspace = 0). Prefer: signed up today AND listing count = 0. Document definition in response `definition` field. |
| `GET .../free-not-paid` | Owners with `freeListingsUsed > 0` (or free reservation) and **no** successful `ListingPackagePurchase` / paid entitlement. Include email, name, freeListingsUsed, firstFreeListingAt if available. Support `?since=` optional. |
| `GET .../checkout-abandoned` | From local `CheckoutAttempt` where `status=abandoned` (and optionally still-open older than TTL). Include email, PI id, package, openedAt. |
| `GET .../revisions-requested` | Recent revision requests (`listing_revisions`), filter `?from=&to=` default today. Include user email, listingId, revisionId, createdAt, paymentStatus. |

Response shape always:

```json
{
  "date": "2026-09-21",
  "timezone": "America/New_York",
  "count": 12,
  "definition": "short text",
  "users": [ { "id": "...", "email": "...", "name": "...", "...": "..." } ]
}
```

Pagination: `?limit=100&offset=0` if lists can be large.

**Do not** expose these without the shared secret. No JWT user token (CRM server calls these).

Document base URL for CRM: production `https://api.bmgenie.ai` + path.

Add env on CRM side later: `BMGENIE_API_URL`, `CRM_INGEST_API_KEY` (same key).

---

## Workstream G — Frontend (main site) — minimal

1. Keep Tawk widget.
2. Add visitor identify when logged in (Workstream E).
3. Do **not** build CRM UI, CEO analytics page, or telesales inbox in this repo.
4. Do **not** remove Calendly book-demo links.

---

## Out of scope for this BMGenie agent

- CRM React pages / SQLite schema / Brevo templates / CEO Analytics UI
- Changing CRM ingest auth scheme
- Replacing Tawk with Chatwoot/Intercom
- Replacing Calendly with custom scheduler

---

## Acceptance criteria (main site)

- [ ] `CrmSyncModule` + service restored and registered
- [ ] Signup / free credit / purchase / credits-depleted fire CRM ingest (owner only), non-blocking
- [ ] Checkout attempts persisted; `user.checkout_opened` on create-intent; abandon job or webhook emits `user.checkout_abandoned`; success resolves attempt
- [ ] Revision request emits `user.revision_requested`
- [ ] Calendly + Tawk documented; webhook preferred to CRM; optional forwarders only if needed
- [ ] Tawk visitor identify for logged-in users
- [ ] `/api/crm-analytics/*` (or agreed path) returns today lists secured by shared key
- [ ] Env examples updated; no secrets committed
- [ ] Unit/integration tests for sync fire-and-forget (mock fetch) and checkout abandon status transitions
- [ ] Short handoff note: `docs/CRM-SYNC.md` listing events, endpoints, env, webhook URLs for ops

---

## Coordination with CRM agent

CRM agent will:

1. Extend `POST /api/ingest/product-leads` for new events + `metadata`
2. Add `POST /api/ingest/calendly` and `POST /api/ingest/tawk`
3. Add lead sources: `checkout_abandoned`, `revision_requested`, plus Book-a-demo + Chat tabs
4. Build CEO **Analytics** page: cards 1–5 with count + modal emails (pulling from main `/crm-analytics` + CRM DB)
5. Book a demo tab + Chat support tab (chat = read-only + link to Tawk dashboard)
6. Keep existing product tabs: Signup · no purchase, Free credit · no purchase, Win-back

Match **event names and payload fields exactly** as above so both sides integrate without renegotiation.

---

## Suggested implementation order

1. Restore `crm-sync` + wire signup / free / purchase / depleted  
2. CheckoutAttempt entity + open/success/abandon + CRM events  
3. Revision emit  
4. CRM analytics read APIs  
5. Tawk visitor identify + docs for Calendly/Tawk webhooks  
6. Tests + `docs/CRM-SYNC.md`

---

## Local verify sketch

```bash
# CRM API running on :4050 with matching CRM_INGEST_API_KEY
# Main API .env CRM_* set

# After signup as owner — CRM leads table / ingest logs show user.signup
# Open packages checkout modal — CheckoutAttempt opened + CRM checkout_opened
# Complete payment — attempt succeeded + user.purchased
# Leave PI open > TTL — abandoned event

curl -H "X-CRM-Ingest-Key: $KEY" \
  "http://localhost:3000/api/crm-analytics/daily-new-users"
```

(Adjust main API port/path to this repo’s actual listen prefix.)

---

END OF PROMPT
