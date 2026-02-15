# HNBCRM MCP Server

MCP (Model Context Protocol) server for [HNBCRM](https://github.com/your-org/hnbcrm) — the CRM where humans and AI agents work together to manage leads, contacts, and sales pipelines.

## Prerequisites

- Node.js 18 or later
- A HNBCRM instance with a valid API key (generate one from Settings > API Keys)

## Installation

Run directly with npx:

```bash
npx hnbcrm-mcp
```

Or install globally:

```bash
npm install -g hnbcrm-mcp
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HNBCRM_API_URL` | Yes | Your Convex deployment URL (e.g. `https://your-app.convex.site`) |
| `HNBCRM_API_KEY` | Yes | API key generated from HNBCRM Settings |

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://your-app.convex.site",
        "HNBCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://your-app.convex.site",
        "HNBCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://your-app.convex.site",
        "HNBCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### VS Code

Add to your VS Code settings or workspace `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://your-app.convex.site",
        "HNBCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools Reference

### Leads (7 tools)

| Tool | Description |
|------|-------------|
| `crm_create_lead` | Create a new lead with optional contact and initial message |
| `crm_list_leads` | List leads, filtered by board, stage, or assignee |
| `crm_get_lead` | Get full details of a specific lead |
| `crm_update_lead` | Update lead properties (title, value, priority, tags, etc.) |
| `crm_delete_lead` | Permanently delete a lead |
| `crm_move_lead` | Move a lead to a different pipeline stage |
| `crm_assign_lead` | Assign a lead to a team member or unassign |

### Contacts (4 tools)

| Tool | Description |
|------|-------------|
| `crm_list_contacts` | List all contacts in the organization |
| `crm_get_contact` | Get full contact details including enrichment data |
| `crm_create_contact` | Create a new contact |
| `crm_update_contact` | Update contact information |

### Conversations (3 tools)

| Tool | Description |
|------|-------------|
| `crm_list_conversations` | List conversations, optionally filtered by lead |
| `crm_get_messages` | Get all messages in a conversation thread |
| `crm_send_message` | Send a message or internal note in a conversation |

### Handoffs (3 tools)

| Tool | Description |
|------|-------------|
| `crm_request_handoff` | Request AI-to-human handoff for a lead |
| `crm_list_handoffs` | List handoff requests by status |
| `crm_accept_handoff` | Accept a pending handoff |

### Pipeline (2 tools)

| Tool | Description |
|------|-------------|
| `crm_list_boards` | List pipeline boards and their stages |
| `crm_list_team` | List team members (humans and AI agents) |

## Resources

| URI | Description |
|-----|-------------|
| `hnbcrm://boards` | Pipeline boards and stages (JSON) |
| `hnbcrm://team` | Team members in the organization (JSON) |
| `hnbcrm://fields` | Custom field definitions (JSON) |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev
```

---

# HNBCRM MCP Server (PT-BR)

Servidor MCP (Model Context Protocol) para o [HNBCRM](https://github.com/your-org/hnbcrm) — o CRM onde humanos e agentes de IA trabalham juntos para gerenciar leads, contatos e pipelines de vendas.

## Requisitos

- Node.js 18 ou superior
- Uma instancia do HNBCRM com uma chave de API valida (gere em Configuracoes > Chaves de API)

## Instalacao

Execute diretamente com npx:

```bash
npx hnbcrm-mcp
```

Ou instale globalmente:

```bash
npm install -g hnbcrm-mcp
```

## Variaveis de Ambiente

| Variavel | Obrigatoria | Descricao |
|----------|-------------|-----------|
| `HNBCRM_API_URL` | Sim | URL do seu deploy Convex (ex: `https://seu-app.convex.site`) |
| `HNBCRM_API_KEY` | Sim | Chave de API gerada nas Configuracoes do HNBCRM |

## Configuracao

### Claude Desktop

Adicione ao `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ou `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://seu-app.convex.site",
        "HNBCRM_API_KEY": "sua-chave-de-api"
      }
    }
  }
}
```

## Referencia de Ferramentas

### Leads (7 ferramentas)

| Ferramenta | Descricao |
|------------|-----------|
| `crm_create_lead` | Criar um novo lead com contato e mensagem inicial opcionais |
| `crm_list_leads` | Listar leads, filtrados por board, estagio ou responsavel |
| `crm_get_lead` | Obter detalhes completos de um lead |
| `crm_update_lead` | Atualizar propriedades do lead |
| `crm_delete_lead` | Excluir um lead permanentemente |
| `crm_move_lead` | Mover lead para outro estagio do pipeline |
| `crm_assign_lead` | Atribuir lead a um membro da equipe |

### Contatos (4 ferramentas)

| Ferramenta | Descricao |
|------------|-----------|
| `crm_list_contacts` | Listar todos os contatos |
| `crm_get_contact` | Obter detalhes completos de um contato |
| `crm_create_contact` | Criar novo contato |
| `crm_update_contact` | Atualizar informacoes do contato |

### Conversas (3 ferramentas)

| Ferramenta | Descricao |
|------------|-----------|
| `crm_list_conversations` | Listar conversas, opcionalmente filtradas por lead |
| `crm_get_messages` | Obter todas as mensagens de uma conversa |
| `crm_send_message` | Enviar mensagem ou nota interna |

### Handoffs (3 ferramentas)

| Ferramenta | Descricao |
|------------|-----------|
| `crm_request_handoff` | Solicitar transferencia de IA para humano |
| `crm_list_handoffs` | Listar solicitacoes de handoff por status |
| `crm_accept_handoff` | Aceitar um handoff pendente |

### Pipeline (2 ferramentas)

| Ferramenta | Descricao |
|------------|-----------|
| `crm_list_boards` | Listar boards do pipeline e seus estagios |
| `crm_list_team` | Listar membros da equipe (humanos e IAs) |

## Recursos

| URI | Descricao |
|-----|-----------|
| `hnbcrm://boards` | Boards e estagios do pipeline (JSON) |
| `hnbcrm://team` | Membros da equipe (JSON) |
| `hnbcrm://fields` | Definicoes de campos personalizados (JSON) |
