# Deployment guide

The app ships as one Docker image: the API serves the built SPA, so a single
free web service plus a free MongoDB Atlas cluster is the whole footprint.

## Recommended: Render (free) + MongoDB Atlas (free M0)

### 1. Database - MongoDB Atlas
1. Create a free **M0** cluster at https://cloud.mongodb.com.
2. Database Access -> add a user (password auth).
3. Network Access -> allow `0.0.0.0/0` (Render's egress IPs vary on the free tier).
4. Copy the connection string and append a database name:
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/verso?retryWrites=true&w=majority`

### 2. Web service - Render
1. Push this repo to GitHub.
2. Render -> **New -> Blueprint** -> point it at the repo. `render.yaml` defines
   the service (Docker runtime, free plan, health check on `/api/health`,
   auto-generated `JWT_SECRET`).
3. In the service's Environment tab set:
 - `MONGODB_URI` - the Atlas string from step 1
 - `GEMINI_API_KEY` - optional; without it the AI runs in labeled heuristic mode

   `TRUST_PROXY_HOPS=1` is already in `render.yaml`. It matters: Express reads
   the client address from `X-Forwarded-For` only when it is told how many
   proxies to trust, and without it every visitor shares one rate-limit bucket.
   Set it to the real hop count for your platform and never to `true`, which
   would let clients spoof the header.
4. Deploy. First build takes a few minutes.

### 3. Seed demo data (once)
From your machine, against the production database:

```bash
MONGODB_URI="<atlas uri>" npm run seed
```

This creates `ada@demo.verso.app` / `grace@demo.verso.app`
(password `VersoDemo1!`) and sample documents including a pre-shared one.

### Notes
- **Cold starts:** Render's free tier sleeps after ~15 min idle and takes about
  a minute to wake. The client shows a "waking the server" notice instead of an
  error while that happens, and retries reads with backoff for ~30 s.
- **Attachments** live in GridFS inside Atlas, so they survive instance
  restarts despite the ephemeral disk.

## Alternative: any Docker host

```bash
docker build -t verso .
docker run -p 4000:4000 \
  -e MONGODB_URI="mongodb+srv://..." \
  -e JWT_SECRET="a-long-random-string-of-24-plus-chars" \
  -e GEMINI_API_KEY="..." \
  verso
```

`NODE_ENV=production` is set in the image; the server refuses to boot in
production without a real `JWT_SECRET`.

## Verifying a deployment

    ./scripts/smoke.sh https://<your-service>.onrender.com

Runs 17 live checks with the seeded demo accounts: health, auth (incl. a
wrong-password 401), document create/save/round-trip, the 409 conflict
path, sharing enforcement (403 for outsiders and for viewer writes),
Markdown export, AI streaming, cleanup, and security headers. It was run
green against the production Docker image locally before the first
deploy, so a failure on Render points at environment (Atlas network
access, env vars) rather than code.
