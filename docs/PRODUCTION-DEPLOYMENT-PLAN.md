# Plan: Production Deployment Setup (Dev + Prod Separation)

## Context

HNBCRM (hnbcrm.com) is already deployed on Vercel with a custom domain, but currently only has a Convex **dev** deployment (`dev:tacit-chicken-195`). No production Convex backend exists yet, and Vercel just runs `vite build` without deploying Convex functions. Need to set up proper dev/prod separation with CI.

**Current state:**
- Vercel: Connected, deploys from `main`, domain `hnbcrm.com` configured
- Convex: Only dev deployment exists, no production deployment
- CI: None — no GitHub Actions workflows
- Frontend reads `VITE_CONVEX_URL` from `import.meta.env` (`src/main.tsx:37`)

---

## Step 1: Convex Production Deployment (manual — Convex Dashboard)

> These are manual steps the user performs in the Convex Dashboard.

1. Go to [Convex Dashboard](https://dashboard.convex.dev) → project settings
2. Copy the **Production Deploy Key** (format: `prod:xxx|yyy`)
3. First-time deploy to create the production backend:
   ```bash
   CONVEX_DEPLOY_KEY="prod:xxx|yyy" npx convex deploy
   ```
4. Set production environment variables in Convex Dashboard (Production deployment):
   - `SITE_URL` = `https://hnbcrm.com` (currently `http://127.0.0.1:5173` in dev)
   - `JWKS` — same RSA public key as dev (or generate new prod keypair)
   - `JWT_PRIVATE_KEY` — matching RSA private key
   - `CONVEX_OPENAI_API_KEY` — production OpenAI key (or same as dev)
   - `CONVEX_OPENAI_BASE_URL` — production proxy URL (or same as dev)

---

## Step 2: Vercel Configuration (manual — Vercel Dashboard)

> These are manual steps the user performs in Vercel Project Settings.

1. **Build Command** — Change from `npm run build` to:
   ```
   npx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'npm run build'
   ```
   This deploys Convex functions to production AND builds the frontend with the production `VITE_CONVEX_URL` injected automatically.

2. **Environment Variables** — Add in Vercel Project Settings > Environment Variables:

   | Variable | Value | Environments |
   |----------|-------|-------------|
   | `CONVEX_DEPLOY_KEY` | Production deploy key from Step 1 | Production only |
   | `VITE_SITE_URL` | `https://hnbcrm.com` | Production only |

   Note: `VITE_CONVEX_URL` does NOT need to be set manually — `convex deploy --cmd-url-env-var-name` injects it during build.

3. **Install Command** — Keep default (`npm install` or `npm ci`)

---

## Step 3: GitHub Actions CI (code change)

Create `.github/workflows/ci.yml` — runs typecheck + build on every PR to `main`.

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  typecheck:
    name: Typecheck & Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - name: Typecheck Convex functions
        run: npx tsc -p convex --noEmit
      - name: Typecheck frontend
        run: npx tsc -p . --noEmit
      - name: Build frontend
        run: npm run build
        env:
          VITE_CONVEX_URL: "https://placeholder.convex.cloud"
          VITE_SITE_URL: "https://hnbcrm.com"
```

Uses a placeholder `VITE_CONVEX_URL` since CI only validates code compiles — real URL is injected by Vercel during actual deployment.

---

## Step 4: Update `.env.example` (code change)

Rewrite with clearer dev vs prod documentation:

```
# ============================================
# Development (local — used by `npm run dev`)
# ============================================

# Your personal dev deployment name (auto-set by `npx convex dev`)
CONVEX_DEPLOYMENT=dev:your-deployment-name

# Dev Convex URL (auto-set by `npx convex dev`)
VITE_CONVEX_URL=https://your-deployment.convex.cloud

# ============================================
# Production (set in Vercel, NOT locally)
# ============================================
# CONVEX_DEPLOY_KEY=prod:xxx|yyy  (Vercel env var, Production only)

# ============================================
# Shared
# ============================================
VITE_SITE_URL=https://hnbcrm.com
```

Remove `CONVEX_DEPLOY_KEY` from the local template (it belongs in Vercel/CI only).

---

## Step 5: Add `deploy` script to `package.json` (code change)

```json
"deploy": "npx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'npm run build'"
```

For manual production deploys from CLI when needed (requires `CONVEX_DEPLOY_KEY` env var).

---

## Files Changed

| File | Action |
|------|--------|
| `.github/workflows/ci.yml` | **Create** — PR typecheck + build workflow |
| `.env.example` | **Edit** — clearer dev vs prod docs |
| `package.json` | **Edit** — add `deploy` script |

---

## Deployment Flow (after setup)

```
Developer machine          GitHub                    Vercel + Convex
---                        ---                       ---
npm run dev
  -> vite + convex dev
  -> uses dev:tacit-chicken-195

git push (feature branch)  PR created ->
                           CI: typecheck + build

merge to main ->           push to main ->          Vercel auto-deploys:
                                                      1. npx convex deploy (prod)
                                                      2. npm run build (+ prod URL)
                                                      3. Publish to hnbcrm.com
```

---

## Verification

1. **Local dev still works:** `npm run dev` uses dev Convex deployment as before
2. **CI works:** Create a test PR, GitHub Actions runs typecheck + build
3. **Production deploys:** Merge to main, Vercel deploys Convex + frontend to hnbcrm.com
4. **Separation confirmed:** Dev and prod have different Convex URLs, different data, different env vars
