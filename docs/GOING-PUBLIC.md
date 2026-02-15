# Going Public — Checklist

Steps to make the HNBCRM repository public on GitHub.

## Before Making Public

### 1. Secrets Audit

Scan the entire git history for leaked secrets — not just the current files, but every commit.

```bash
# Search current files
grep -ri "convex_deploy_key\|api_key\|secret\|password" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.env" .

# Search git history (install trufflehog or gitleaks)
npx trufflehog git file://. --only-verified
# or
gitleaks detect --source .
```

**Known sensitive files to verify are gitignored:**

| File | Contains | Status |
|------|----------|--------|
| `.env.local` | `CONVEX_DEPLOY_KEY`, `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL` | Must be in `.gitignore` |
| `.env` | Any env vars | Must be in `.gitignore` |

If secrets were ever committed, you need to either:
- Rotate the secrets (always do this regardless), **and**
- Rewrite git history with `git filter-repo` or start with a fresh initial commit

### 2. Rotate All Secrets

Even if nothing was leaked, rotate before going public:

- [ ] Convex deploy key (`CONVEX_DEPLOY_KEY`)
- [ ] Any API keys created in HNBCRM Settings
- [ ] Any webhook secrets configured by users

### 3. Verify .gitignore

Confirm these are listed in `.gitignore`:

```
.env
.env.local
.env.production
node_modules/
dist/
```

### 4. Review Sensitive Content

- [ ] No hardcoded URLs pointing to your production Convex deployment
- [ ] No internal email addresses or names (check `convex/seed.ts` — uses `@hnbcrm.io` which is fine)
- [ ] No customer data in seed files
- [ ] No internal Slack/Discord links in docs

### 5. Documentation Readiness

Already done:

- [x] `README.md` — Professional with features, tech stack, quick start, deploy guide
- [x] `LICENSE` — MIT
- [x] `CONTRIBUTING.md` — Setup, code style, PR process
- [x] `CHANGELOG.md` — Full version history
- [x] `mcp-server/README.md` — MCP server docs
- [x] `convex/README.md` — Backend overview

Still recommended:

- [ ] Add `CODE_OF_CONDUCT.md` (use [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/))
- [ ] Add `SECURITY.md` with vulnerability reporting instructions
- [ ] Add `.github/ISSUE_TEMPLATE/bug_report.md`
- [ ] Add `.github/ISSUE_TEMPLATE/feature_request.md`
- [ ] Add `.github/PULL_REQUEST_TEMPLATE.md`

### 6. CI/CD (Optional but Recommended)

Add GitHub Actions workflow at `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: npm
      - run: npm ci
      - run: npx tsc -p convex --noEmit
      - run: npx tsc -p . --noEmit
      - run: npx vite build
```

## Rename Repository

1. Go to **github.com/ericmil87/clawcrm-repo** > Settings > General
2. Change **Repository name** to `hnbcrm`
3. Click **Rename** (GitHub auto-redirects old URLs)
4. Update local remote:
   ```bash
   git remote set-url origin https://github.com/ericmil87/hnbcrm.git
   ```
5. Rename local folders:
   ```bash
   cd /home/eric/projects
   mv ClawCRM/clawcrm-repo hnbcrm
   rm -rf ClawCRM  # remove old parent if empty
   ```

## Make Public

1. Go to **github.com/ericmil87/hnbcrm** > Settings > General
2. Scroll to **Danger Zone**
3. Click **Change repository visibility**
4. Select **Public**
5. Type the repository name to confirm

## After Making Public

- [ ] Verify README renders correctly on GitHub (logo, badges, tables)
- [ ] Check that `.env.local` is NOT visible in the repo
- [ ] Test `git clone` from a different machine / incognito
- [ ] Add repository topics on GitHub: `crm`, `ai`, `convex`, `react`, `typescript`, `mcp`
- [ ] Pin the repository to your GitHub profile
- [ ] Update `README.md` badges if using GitHub-hosted shields (stars, issues, etc.)
