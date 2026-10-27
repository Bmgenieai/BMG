# Website AI chat → CRM

Visitors chat on **bmgenie.ai** (AI first). If they click **Talk to a human**, staff reply in CRM **Chat support** and the visitor sees it in the **same** website chat.

## Windows CRM API env (no PC visit needed)

Set GitHub **Actions secrets** on repo **Bmgenieai/BMG** (CRM backend). Deploy upserts Windows `.env` automatically:

| Secret | Value |
|--------|--------|
| `BMGENIE_API_URL` | `https://api.bmgenie.ai` (optional — deploy defaults to this if empty) |
| `CRM_INGEST_API_KEY` | Same shared key as main BMGenie backend `CRM_INGEST_API_KEY` |

Then push to `main` or re-run workflow **Deploy CRM API to Windows**.

Local Ubuntu CRM API:
```
BMGENIE_API_URL=http://localhost:4000
CRM_INGEST_API_KEY=<same as main>
```

## Staff steps
1. Admin → create employee as CEO (or BD).
2. Open **Chat support**.
3. Use status filter **Needs human**.
4. Open thread → **Send to visitor**.

## Deploy note
Ship CRM backend (`BMG`) to Windows + CRM frontend (`BMG-CRM`) to Vercel, and main site backend + frontend, so live delivery works.
