# Cloudflare DNS for CRM API (you create this)

Suggested hostname: **crm-api.bmgenie.ai** → Windows CRM backend.

## Typical record (direct to server IP)

| Type | Name | Content | Proxy |
|------|------|---------|--------|
| A | `crm-api` | `<Windows public IPv4>` | DNS only first, then Proxied if desired |

If the machine is only reachable via Cloudflare Tunnel / another host, use the CNAME/A that tunnel docs give you instead.

## After DNS is live

1. Office box: API listening on `PORT=4050` (PM2 `bmg-crm-api`)
2. Open firewall / reverse proxy so `https://crm-api.bmgenie.ai/api/health` works
3. Vercel **bmg-crm** env: `VITE_API_URL=https://crm-api.bmgenie.ai` → Redeploy
4. Optional: main BMGenie Cloud Run env later:
   - `CRM_SYNC_ENABLED=true`
   - `CRM_API_URL=https://crm-api.bmgenie.ai/api`
   - `CRM_INGEST_API_KEY=` same as Windows `.env`
