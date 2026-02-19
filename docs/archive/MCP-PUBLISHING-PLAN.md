# MCP Server Distribution & Publishing Strategy

## Context

O servidor MCP (`mcp-server/`) atualmente vive no monorepo do HNBCRM mas não está publicado no npm. O objetivo é preparar o servidor para **distribuição pública ampla** e **aceitar contribuições da comunidade**, mantendo-o no monorepo seguindo o padrão oficial da Anthropic.

### Current State
- **Location:** `mcp-server/` no monorepo principal
- **Package:** `hnbcrm-mcp` v0.1.0 (nome sem escopo)
- **Coupling:** ✅ Completamente independente (zero imports do código principal, apenas HTTP API)
- **Publishing:** ❌ Não publicado no npm ainda
- **30+ ferramentas MCP** para gerenciar leads, contatos, conversas, handoffs, tarefas e calendário

### User Requirements
- ✅ Distribuição ampla para desenvolvedores externos
- ✅ Aceitar contribuições da comunidade
- ✅ Nome com escopo: `@hnbcrm/mcp-server`
- ✅ Versionamento independente do CRM

### Research Findings

**Padrão Oficial da Anthropic:**
- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) usa **monorepo**
- Múltiplos servidores MCP publicados do mesmo repo
- Exemplos: `@modelcontextprotocol/server-filesystem`, `@modelcontextprotocol/server-github`

**Vantagens do Monorepo para MCP:**
1. **Sincronização automática** - Mudanças na API do CRM atualizam o MCP no mesmo PR
2. **Testes integrados** - CI/CD pode testar o MCP contra a API real
3. **Documentação centralizada** - Referências cruzadas entre MCP e API docs
4. **Versões atômicas** - Features novas (ex: calendário) incluem MCP tools no mesmo commit
5. **Comunidade pode contribuir** - Monorepo não impede pull requests focados no MCP

**Distribuição via npm + npx:**
- Usuários executam: `npx -y @hnbcrm/mcp-server`
- Instalação global opcional: `npm install -g @hnbcrm/mcp-server`
- Configuração no Claude Desktop/Cursor via `npx` (sem instalação manual)

---

## Recommended Approach: **Enhanced Monorepo**

Manter o MCP no monorepo, mas otimizar para distribuição externa e contribuições.

### Strategy Overview

1. **Renomear pacote** para `@hnbcrm/mcp-server` (escopo organizacional)
2. **Publicar no npm** com acesso público
3. **Configurar GitHub Actions** para publicação automatizada
4. **Documentação standalone** - README do MCP funciona independente do repo
5. **CONTRIBUTING.md específico** para o MCP (guidelines focadas)
6. **Versionamento semântico independente** do CRM principal
7. **Otimizar package.json** - apenas incluir `dist/` no pacote publicado

---

## Implementation Plan

### Phase 1: Package Configuration

#### 1.1 Update package.json

**File:** `mcp-server/package.json`

```json
{
  "name": "@hnbcrm/mcp-server",
  "version": "1.0.0",
  "description": "Model Context Protocol server for HNBCRM - AI agent integration with CRM operations",
  "type": "module",
  "bin": {
    "hnbcrm-mcp": "./dist/index.js"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "prepublishOnly": "npm run build",
    "test": "node --test"
  },
  "keywords": [
    "mcp",
    "model-context-protocol",
    "crm",
    "ai-agents",
    "hnbcrm",
    "claude",
    "openai"
  ],
  "author": "HNBCRM Team",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/ericmil87/clawcrm-repo.git",
    "directory": "mcp-server"
  },
  "homepage": "https://github.com/ericmil87/clawcrm-repo/tree/main/mcp-server",
  "bugs": {
    "url": "https://github.com/ericmil87/clawcrm-repo/issues"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.13.10",
    "typescript": "~5.7.2"
  }
}
```

**Key Changes:**
- ✅ Scoped package name: `@hnbcrm/mcp-server`
- ✅ Version bump to `1.0.0` (stable release)
- ✅ `files` field: only include `dist/`, README, LICENSE
- ✅ Repository metadata for npm page
- ✅ SEO keywords for npm search
- ✅ `directory` field for monorepo subpath

#### 1.2 Add .npmignore (Optional)

If you want extra control over what's excluded:

**File:** `mcp-server/.npmignore`

```
src/
tsconfig.json
*.test.ts
.DS_Store
node_modules/
```

**Note:** The `files` field in package.json is more explicit and recommended.

---

### Phase 2: Documentation Updates

#### 2.1 Enhance MCP Server README

**File:** `mcp-server/README.md`

Update to work as **standalone documentation** when viewed on npm:

```markdown
# @hnbcrm/mcp-server

Model Context Protocol (MCP) server for HNBCRM - integrate AI agents with your CRM operations.

[![npm version](https://img.shields.io/npm/v/@hnbcrm/mcp-server)](https://www.npmjs.com/package/@hnbcrm/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Quick Start

```bash
# Install globally
npm install -g @hnbcrm/mcp-server

# Or run with npx (no installation)
npx -y @hnbcrm/mcp-server
```

## What is HNBCRM?

HNBCRM is a multi-tenant CRM with human-AI team collaboration. This MCP server enables AI agents (Claude, ChatGPT, etc.) to interact with your CRM data through 30+ tools.

**Features:**
- 🎯 Lead & contact management
- 💬 Conversation handling
- 🤝 AI-to-human handoffs
- 📊 Pipeline analytics
- 📅 Calendar & task management
- 📝 Activity logging

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": [
        "-y",
        "@hnbcrm/mcp-server"
      ],
      "env": {
        "HNBCRM_API_URL": "https://your-deployment.vercel.app",
        "HNBCRM_API_KEY": "hnbcrm_..."
      }
    }
  }
}
```

### Cursor / VS Code

Similar setup in MCP settings.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HNBCRM_API_URL` | ✅ | Your HNBCRM deployment URL |
| `HNBCRM_API_KEY` | ✅ | API key from Settings → API Keys |

## Available Tools

### Leads (7 tools)
- `crm_create_lead` - Create new lead with contact
- `crm_update_lead` - Update lead details
- `crm_move_lead` - Move through pipeline stages
- `crm_assign_lead` - Assign to team member
- `crm_get_lead` - Get lead details
- `crm_list_leads` - List all leads with filters
- `crm_request_handoff` - Request human takeover

### Contacts (7 tools)
- `crm_create_contact` - Create contact
- `crm_update_contact` - Update contact info
- `crm_enrich_contact` - Add enrichment data
- `crm_get_contact` - Get contact details
- `crm_get_contact_gaps` - Find missing fields
- `crm_list_contacts` - List contacts
- `crm_search_contacts` - Full-text search

### Conversations (3 tools)
- `crm_list_conversations` - List all conversations
- `crm_get_messages` - Get conversation thread
- `crm_send_message` - Send message or internal note

### Handoffs (4 tools)
- `crm_list_handoffs` - List handoff requests
- `crm_accept_handoff` - Accept as human
- `crm_reject_handoff` - Reject handoff

### Pipeline (3 tools)
- `crm_list_boards` - Get pipeline configuration
- `crm_list_team` - Get team members
- `crm_get_dashboard` - Pipeline analytics

### Activities (2 tools)
- `crm_get_activities` - Get lead activity timeline
- `crm_create_activity` - Log note/call/email

### Tasks (12 tools)
- Full task CRUD, assignment, completion tracking

### Calendar (6 tools)
- Event CRUD, recurring events, rescheduling

## Resources

- `hnbcrm://boards` - Pipeline stages and boards
- `hnbcrm://team` - Team members with roles
- `hnbcrm://fields` - Custom field definitions

## Development

```bash
# Clone the repo
git clone https://github.com/ericmil87/clawcrm-repo.git
cd clawcrm-repo/mcp-server

# Install dependencies
npm install

# Build
npm run build

# Test locally
npx .
# (runs ./dist/index.js with your local changes)
```

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

**Areas for contribution:**
- Additional MCP tools for new HNBCRM features
- Improved error handling
- Documentation improvements
- Bug fixes

## API Compatibility

This MCP server works with any HNBCRM deployment that exposes the `/api/v1/*` REST API:

- ✅ Cloud deployments (Vercel, etc.)
- ✅ Self-hosted instances
- ✅ Local development servers

**Minimum HNBCRM version:** v0.7.0+

## License

MIT - See [LICENSE](../LICENSE) in the main repository.

## Links

- [HNBCRM Main Repository](https://github.com/ericmil87/clawcrm-repo)
- [API Documentation](https://github.com/ericmil87/clawcrm-repo/blob/main/.claude/skills/hnbcrm/references/API_REFERENCE.md)
- [Report Issues](https://github.com/ericmil87/clawcrm-repo/issues)
- [npm Package](https://www.npmjs.com/package/@hnbcrm/mcp-server)
```

**Key Improvements:**
- ✅ Badges (npm version, license)
- ✅ Standalone intro (explains what HNBCRM is)
- ✅ Clear quick start instructions
- ✅ Configuration examples for Claude Desktop/Cursor
- ✅ Complete tool catalog
- ✅ Contributing section
- ✅ Development instructions for contributors
- ✅ Links to main repo and docs

#### 2.2 Create MCP-Specific Contributing Guide

**File:** `mcp-server/CONTRIBUTING.md`

```markdown
# Contributing to @hnbcrm/mcp-server

Thank you for your interest in contributing to the HNBCRM MCP server!

## Development Setup

1. **Fork and clone** the main repository:
   ```bash
   git clone https://github.com/YOUR-USERNAME/clawcrm-repo.git
   cd clawcrm-repo/mcp-server
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build:**
   ```bash
   npm run build
   ```

4. **Test locally:**
   ```bash
   # Set environment variables
   export HNBCRM_API_URL=https://your-test-instance.vercel.app
   export HNBCRM_API_KEY=hnbcrm_test_key

   # Run the server
   npx .
   ```

## Project Structure

```
mcp-server/
├── src/
│   ├── index.ts          # Server entry point
│   ├── client.ts         # HTTP API client
│   ├── utils.ts          # Helper functions
│   ├── resources.ts      # MCP resources (boards, team, fields)
│   └── tools/
│       ├── leads.ts      # Lead management tools
│       ├── contacts.ts   # Contact management tools
│       ├── conversations.ts
│       ├── handoffs.ts
│       ├── pipeline.ts
│       ├── activities.ts
│       ├── tasks.ts
│       └── calendar.ts
└── dist/                 # Build output (git-ignored)
```

## Adding a New MCP Tool

1. **Choose the right file** in `src/tools/`
2. **Follow the pattern:**

```typescript
import { z } from "zod";
import type { HnbCrmClient } from "../client.js";

// Input validation schema
const MyToolArgsSchema = z.object({
  leadId: z.string(),
  someField: z.string(),
});

// Tool definition
export const myTool = {
  name: "crm_my_tool",
  description: "Clear description of what this tool does",
  inputSchema: {
    type: "object" as const,
    properties: {
      leadId: { type: "string", description: "Lead ID" },
      someField: { type: "string", description: "Field description" },
    },
    required: ["leadId"],
  },
};

// Tool handler
export async function handleMyTool(
  client: HnbCrmClient,
  args: unknown
) {
  const parsed = MyToolArgsSchema.parse(args);
  const result = await client.post("/api/v1/endpoint", parsed);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
```

3. **Register in `index.ts`:**

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    // ... existing cases
    case "crm_my_tool":
      return handleMyTool(client, request.params.arguments);
  }
});
```

4. **Update README.md** with the new tool in the appropriate category

## Code Style

- Use **TypeScript** with strict mode
- Follow **existing patterns** in the codebase
- Use **Zod** for input validation
- Return **structured error messages** on failure
- Include **JSDoc comments** for public functions

## Testing

Currently, testing is manual. Before submitting:

1. **Build successfully:**
   ```bash
   npm run build
   ```

2. **Test against a real HNBCRM instance:**
   - Create a test API key
   - Run your new tool via Claude Desktop or MCP Inspector
   - Verify the output is correct

3. **Test error cases:**
   - Missing required fields
   - Invalid IDs
   - Permission errors

## Pull Request Process

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/add-my-tool
   ```

2. **Make your changes** in `mcp-server/src/`

3. **Update documentation:**
   - Add tool to `README.md`
   - Update this CONTRIBUTING.md if needed

4. **Commit with a clear message:**
   ```bash
   git commit -m "feat(mcp): add crm_my_tool for X functionality"
   ```

5. **Push and create PR:**
   ```bash
   git push origin feature/add-my-tool
   ```

6. **PR title format:**
   - `feat(mcp): description` - New feature
   - `fix(mcp): description` - Bug fix
   - `docs(mcp): description` - Documentation only
   - `refactor(mcp): description` - Code refactoring

7. **In the PR description:**
   - Explain the purpose of the new tool/fix
   - Reference any related issues
   - Include example usage if applicable

## Questions?

- 📖 Check the [main HNBCRM docs](https://github.com/ericmil87/clawcrm-repo/blob/main/README.md)
- 🐛 [Open an issue](https://github.com/ericmil87/clawcrm-repo/issues) for bugs or questions
- 💬 Start a [discussion](https://github.com/ericmil87/clawcrm-repo/discussions) for ideas

Thank you for contributing! 🎉
```

---

### Phase 3: GitHub Actions for Publishing

#### 3.1 Create NPM Publishing Workflow

**File:** `.github/workflows/publish-mcp.yml`

```yaml
name: Publish MCP Server to npm

on:
  push:
    tags:
      - 'mcp-v*.*.*'  # Trigger on tags like mcp-v1.0.0

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        working-directory: mcp-server
        run: npm ci

      - name: Build
        working-directory: mcp-server
        run: npm run build

      - name: Publish to npm
        working-directory: mcp-server
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          generate_release_notes: true
          body: |
            MCP Server ${{ github.ref_name }}

            Install: `npm install -g @hnbcrm/mcp-server@${{ github.ref_name }}`
            Or use: `npx -y @hnbcrm/mcp-server`

            See [CHANGELOG](https://github.com/${{ github.repository }}/blob/main/mcp-server/CHANGELOG.md) for details.
```

**Setup Required:**
1. Create npm access token: https://www.npmjs.com/settings/YOUR-USERNAME/tokens
2. Add as GitHub secret: `NPM_TOKEN`
3. First publish must be manual (to create the package), subsequent ones automated

#### 3.2 Create MCP Server Changelog

**File:** `mcp-server/CHANGELOG.md`

```markdown
# Changelog - @hnbcrm/mcp-server

All notable changes to the HNBCRM MCP server will be documented in this file.

This package follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-02-17

### Initial Release 🎉

First public release of the HNBCRM MCP server.

**30+ MCP Tools:**
- ✅ 7 lead management tools
- ✅ 7 contact management tools
- ✅ 3 conversation tools
- ✅ 4 handoff tools
- ✅ 3 pipeline analytics tools
- ✅ 2 activity logging tools
- ✅ 12 task management tools (added v0.16.0)
- ✅ 6 calendar event tools (added v0.16.0)

**Resources:**
- `hnbcrm://boards` - Pipeline configuration
- `hnbcrm://team` - Team members
- `hnbcrm://fields` - Custom field definitions

**Requirements:**
- HNBCRM API v0.7.0+
- Node.js 18+
- `@modelcontextprotocol/sdk` ^1.26.0

**Distribution:**
- Published to npm as `@hnbcrm/mcp-server`
- Available via `npx -y @hnbcrm/mcp-server`
- Works with Claude Desktop, Cursor, VS Code, and other MCP clients
```

---

### Phase 4: First Publication

#### 4.1 Manual First Publish

Since this is the first time publishing a scoped package, it must be done manually:

```bash
# 1. Navigate to MCP directory
cd mcp-server

# 2. Login to npm (if not already)
npm login

# 3. Update version in package.json to 1.0.0 (already done in Phase 1)

# 4. Build
npm run build

# 5. Test the package locally
npm pack
# This creates @hnbcrm-mcp-server-1.0.0.tgz
# Test it: npm install -g ./hnbcrm-mcp-server-1.0.0.tgz

# 6. Publish (first time requires --access public for scoped packages)
npm publish --access public

# 7. Verify on npm
npm view @hnbcrm/mcp-server
```

#### 4.2 Create Git Tag for Future Automation

After successful first publish:

```bash
# Create annotated tag
git tag -a mcp-v1.0.0 -m "MCP Server v1.0.0 - Initial public release

- 30+ MCP tools for HNBCRM
- Published to npm as @hnbcrm/mcp-server
- Full Claude Desktop/Cursor integration"

# Push tag (triggers GitHub Actions on future releases)
git push origin mcp-v1.0.0
```

**Note:** The GitHub Actions workflow won't run on this first tag since the `NPM_TOKEN` secret needs to be set up first. Subsequent releases will be automated.

---

### Phase 5: Update Main Repository References

#### 5.1 Update Root README

**File:** `README.md` (root)

Add/update the MCP Server section:

```markdown
### MCP Server

The HNBCRM MCP server is available as an npm package:

```bash
# Install globally
npm install -g @hnbcrm/mcp-server

# Or run with npx
npx -y @hnbcrm/mcp-server
```

See [`mcp-server/README.md`](./mcp-server/README.md) for full documentation.

**npm:** [@hnbcrm/mcp-server](https://www.npmjs.com/package/@hnbcrm/mcp-server)
```

#### 5.2 Update Developer Portal

**File:** `src/pages/DevelopersPage.tsx`

Update the MCP Server card to reference the npm package:

```tsx
<div className="...">
  <Package className="h-8 w-8 text-brand-500" />
  <h3 className="text-lg font-semibold">Servidor MCP</h3>
  <p className="text-sm text-text-secondary">
    Integre agentes de IA (Claude, ChatGPT) com o HNBCRM via Model Context Protocol.
    30+ ferramentas MCP para operações de CRM.
  </p>
  <div className="mt-4 space-y-2">
    <code className="block bg-surface-sunken px-3 py-2 rounded text-sm">
      npx -y @hnbcrm/mcp-server
    </code>
    <a
      href="https://www.npmjs.com/package/@hnbcrm/mcp-server"
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand-500 hover:text-brand-400 text-sm"
    >
      Ver no npm →
    </a>
  </div>
</div>
```

#### 5.3 Update Landing Page

**File:** `src/components/LandingPage.tsx`

Update the MCP Server card in features:

```tsx
<div className="...">
  <Package className="h-8 w-8 text-brand-500" />
  <h3 className="text-lg font-semibold">Servidor MCP</h3>
  <p className="text-sm text-text-secondary">
    Integre Claude e outros agentes de IA via npm. 30+ ferramentas MCP prontas para uso.
  </p>
  <code className="text-xs bg-surface-sunken px-2 py-1 rounded">
    npx @hnbcrm/mcp-server
  </code>
</div>
```

#### 5.4 Update Agent Skill Reference

**File:** `.claude/skills/hnbcrm/references/SETUP.md`

Update installation instructions:

```markdown
## MCP Server Installation

### npm (Recommended)

```bash
npx -y @hnbcrm/mcp-server
```

Or install globally:

```bash
npm install -g @hnbcrm/mcp-server
```

### From Source (Development)

```bash
git clone https://github.com/ericmil87/clawcrm-repo.git
cd clawcrm-repo/mcp-server
npm install
npm run build
npx .
```
```

---

## Future Releases Workflow

After the initial setup, future releases are simple:

### Version Bump & Release

```bash
# 1. Navigate to mcp-server
cd mcp-server

# 2. Update CHANGELOG.md with new changes

# 3. Bump version (creates git tag automatically)
npm version patch   # 1.0.0 → 1.0.1
# or
npm version minor   # 1.0.0 → 1.1.0
# or
npm version major   # 1.0.0 → 2.0.0

# 4. The version bump updates package.json and creates a git commit

# 5. Manually create the mcp-v* tag for GitHub Actions
git tag -a mcp-v1.0.1 -m "Release v1.0.1 - Bug fixes"

# 6. Push changes and tag
git push && git push --tags

# 7. GitHub Actions automatically publishes to npm
```

### Independent Version Management

The MCP server version is **independent** from the main CRM version:

- **CRM at v0.18.0** → Frontend + Backend changes
- **MCP at v1.0.0** → Only changes when MCP tools are added/modified

**Example Timeline:**
```
CRM v0.18.0 → MCP v1.0.0 (initial release)
CRM v0.19.0 → MCP v1.0.0 (no MCP changes)
CRM v0.20.0 → MCP v1.1.0 (new tools added)
```

---

## Monorepo Benefits Summary

✅ **Atomic Updates** - New CRM features include MCP tools in same PR
✅ **Integrated Testing** - CI/CD tests MCP against real API
✅ **Shared Documentation** - Cross-references between API docs and MCP tools
✅ **Version Coherence** - API changes propagate to MCP immediately
✅ **Community Friendly** - Contributors can improve both API and MCP
✅ **Following Best Practices** - Same pattern as Anthropic's official servers

---

## Alternative Considered: Separate Repository

**Why we're NOT doing this:**

❌ **Sync overhead** - API changes require coordinated PRs in two repos
❌ **Version drift** - MCP could lag behind API updates
❌ **Duplicate CI/CD** - Need separate workflows for testing
❌ **Documentation fragmentation** - Harder to keep docs in sync
❌ **Against official pattern** - Anthropic uses monorepo for all MCP servers

**When to reconsider:**
- If the MCP server grows to 10k+ lines and needs dedicated team
- If external contributors significantly outnumber internal (rare for domain-specific tools)
- If MCP becomes a separate product with different roadmap

---

## Critical Files

### Files to Modify
1. `mcp-server/package.json` - Rename to @hnbcrm/mcp-server, bump to v1.0.0
2. `mcp-server/README.md` - Enhance for npm page, standalone docs
3. `mcp-server/CONTRIBUTING.md` - NEW - Contributing guidelines
4. `mcp-server/CHANGELOG.md` - NEW - Version history
5. `.github/workflows/publish-mcp.yml` - NEW - Automated publishing
6. `README.md` (root) - Add npm install instructions
7. `src/pages/DevelopersPage.tsx` - Update MCP card with npm link
8. `src/components/LandingPage.tsx` - Update MCP feature description
9. `.claude/skills/hnbcrm/references/SETUP.md` - Update installation instructions

### GitHub Secrets to Add
- `NPM_TOKEN` - Create at https://www.npmjs.com/settings/YOUR-USERNAME/tokens (Automation type, publish access)

---

## Verification Steps

### 1. Test Local Build
```bash
cd mcp-server
npm run build
npx .
# Should start MCP server successfully
```

### 2. Test Package Installation
```bash
npm pack
npm install -g ./hnbcrm-mcp-server-1.0.0.tgz
hnbcrm-mcp
# Should run the CLI
```

### 3. After First Publish
```bash
# Verify on npm
npm view @hnbcrm/mcp-server

# Test npx
npx -y @hnbcrm/mcp-server
```

### 4. Test in Claude Desktop
Add to `claude_desktop_config.json` and verify tools appear

### 5. Verify GitHub Actions
After setting up NPM_TOKEN secret, push a test tag:
```bash
git tag mcp-v1.0.1-test
git push origin mcp-v1.0.1-test
```
Check GitHub Actions tab for successful publish

---

## Timeline

**Phase 1-2 (Documentation):** 1 hour
**Phase 3 (GitHub Actions):** 30 minutes
**Phase 4 (First Publish):** 1 hour (includes npm account setup)
**Phase 5 (Repository Updates):** 30 minutes

**Total:** ~3 hours for complete setup

**After setup:** Version bumps take ~5 minutes (automated via GitHub Actions)

---

## Success Criteria

✅ Package published to npm as `@hnbcrm/mcp-server`
✅ Works with `npx -y @hnbcrm/mcp-server`
✅ GitHub Actions publishes on `mcp-v*` tags
✅ README works standalone on npm page
✅ CONTRIBUTING.md guides external contributors
✅ Independent versioning from main CRM
✅ All documentation updated with npm references
