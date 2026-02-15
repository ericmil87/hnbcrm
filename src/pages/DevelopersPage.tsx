import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import {
  ArrowLeft,
  Key,
  Server,
  Table2,
  Globe,
  Webhook,
  Code2,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

const sections = [
  { id: "auth", label: "Autenticacao", icon: Key },
  { id: "mcp", label: "Servidor MCP", icon: Server },
  { id: "mcp-tools", label: "Tools MCP", icon: Table2 },
  { id: "rest-api", label: "API REST", icon: Globe },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
  { id: "examples", label: "Exemplos", icon: Code2 },
];

function CodeBlock({ children, language = "bash" }: { children: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group rounded-lg overflow-hidden border border-border">
      <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-border">
        <span className="text-xs text-text-muted font-mono">{language}</span>
        <button
          onClick={handleCopy}
          className="text-text-muted hover:text-text-secondary transition-colors p-1"
          aria-label="Copiar codigo"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="bg-[#0d1117] p-4 overflow-x-auto">
        <code className="text-sm font-mono text-text-secondary whitespace-pre">
          {children.trim()}
        </code>
      </pre>
    </div>
  );
}

function EndpointRow({ method, path, description }: { method: string; path: string; description: string }) {
  const methodColors: Record<string, string> = {
    GET: "text-semantic-success",
    POST: "text-semantic-info",
  };

  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="py-2.5 px-3">
        <span className={cn("font-mono text-xs font-semibold", methodColors[method] ?? "text-text-secondary")}>
          {method}
        </span>
      </td>
      <td className="py-2.5 px-3 font-mono text-xs text-brand-400">{path}</td>
      <td className="py-2.5 px-3 text-sm text-text-secondary">{description}</td>
    </tr>
  );
}

function ToolRow({ name, description, params }: { name: string; description: string; params: string }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="py-2.5 px-3 font-mono text-xs text-brand-400">{name}</td>
      <td className="py-2.5 px-3 text-sm text-text-secondary">{description}</td>
      <td className="py-2.5 px-3 font-mono text-xs text-text-muted">{params}</td>
    </tr>
  );
}

export function DevelopersPage() {
  const [activeSection, setActiveSection] = useState("auth");
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: "-20% 0px -60% 0px" }
    );

    for (const section of sections) {
      const el = document.getElementById(section.id);
      if (el) {
        sectionRefs.current[section.id] = el;
        observer.observe(el);
      }
    }

    return () => observer.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <div className="min-h-screen bg-surface-base text-text-primary">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-surface-base/80 backdrop-blur-md border-b border-border">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2">
              <img
                src="/orange_icon_logo_transparent-bg-528x488.png"
                alt="HNBCRM Logo"
                className="h-7 w-7"
              />
              <span className="text-lg font-bold text-text-primary">HNBCRM</span>
            </Link>
            <span className="text-text-muted">/</span>
            <span className="text-sm font-medium text-text-secondary">Developers</span>
          </div>
          <Link to="/">
            <Button variant="ghost" size="sm">
              <ArrowLeft size={16} />
              Voltar
            </Button>
          </Link>
        </div>
      </header>

      {/* Mobile ToC */}
      <nav className="md:hidden sticky top-[57px] z-20 bg-surface-base/80 backdrop-blur-md border-b border-border overflow-x-auto">
        <div className="flex gap-1 px-4 py-2">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => scrollTo(s.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                activeSection === s.id
                  ? "bg-brand-500/10 text-brand-400"
                  : "text-text-muted hover:text-text-secondary"
              )}
            >
              <s.icon size={14} />
              {s.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 flex gap-8">
        {/* Desktop Sidebar ToC */}
        <nav className="hidden md:block w-52 flex-shrink-0">
          <div className="sticky top-[73px] py-8 space-y-1">
            {sections.map((s) => (
              <button
                key={s.id}
                onClick={() => scrollTo(s.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left",
                  activeSection === s.id
                    ? "bg-brand-500/10 text-brand-400"
                    : "text-text-muted hover:text-text-secondary hover:bg-surface-raised"
                )}
              >
                <s.icon size={16} />
                {s.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Main Content */}
        <main className="flex-1 min-w-0 py-8 md:py-12 space-y-16 md:space-y-24">
          {/* Hero */}
          <section className="space-y-4">
            <Badge variant="brand">Developer Docs</Badge>
            <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold">
              Developers
            </h1>
            <p className="text-lg text-text-secondary max-w-2xl">
              Build on HNBCRM — integre agentes de IA, automatize workflows e
              estenda seu CRM.
            </p>
          </section>

          {/* Authentication */}
          <section id="auth" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Key className="text-brand-400" size={24} />
              Autenticacao
            </h2>
            <p className="text-text-secondary">
              Todas as chamadas a API REST e ao servidor MCP sao autenticadas via
              chave de API. Gere suas chaves em{" "}
              <span className="text-brand-400 font-medium">
                Configuracoes &gt; API Keys
              </span>{" "}
              dentro do app.
            </p>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">Como usar</h3>
              <p className="text-sm text-text-secondary">
                Envie o header <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">X-API-Key</code> em
                todas as requisicoes:
              </p>
              <CodeBlock language="bash">{`curl -X GET "https://SEU-DEPLOYMENT.convex.site/api/v1/leads" \\
  -H "X-API-Key: sua_chave_aqui"`}</CodeBlock>
            </Card>

            <Card className="p-6 space-y-3">
              <h3 className="font-semibold text-text-primary">Respostas de erro</h3>
              <div className="text-sm text-text-secondary space-y-2">
                <p>
                  <code className="text-semantic-error bg-surface-overlay px-1.5 py-0.5 rounded text-xs">401</code>{" "}
                  — Chave invalida ou ausente
                </p>
                <p>
                  <code className="text-semantic-error bg-surface-overlay px-1.5 py-0.5 rounded text-xs">403</code>{" "}
                  — Sem permissao para o recurso
                </p>
                <p>
                  <code className="text-semantic-error bg-surface-overlay px-1.5 py-0.5 rounded text-xs">429</code>{" "}
                  — Rate limit excedido
                </p>
              </div>
            </Card>
          </section>

          {/* MCP Server */}
          <section id="mcp" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Server className="text-brand-400" size={24} />
              Servidor MCP
            </h2>
            <p className="text-text-secondary">
              O Model Context Protocol (MCP) permite que agentes de IA interajam
              diretamente com seu CRM de forma estruturada e segura.
            </p>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">Instalacao</h3>
              <CodeBlock language="bash">{`npx hnbcrm-mcp`}</CodeBlock>
            </Card>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">
                Configuracao — Claude Desktop
              </h3>
              <p className="text-sm text-text-secondary">
                Adicione ao seu <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">claude_desktop_config.json</code>:
              </p>
              <CodeBlock language="json">{`{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_KEY": "sua_chave_aqui",
        "HNBCRM_BASE_URL": "https://SEU-DEPLOYMENT.convex.site"
      }
    }
  }
}`}</CodeBlock>
            </Card>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">
                Configuracao — Claude Code
              </h3>
              <p className="text-sm text-text-secondary">
                No seu <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">.mcp.json</code> do projeto:
              </p>
              <CodeBlock language="json">{`{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_KEY": "sua_chave_aqui",
        "HNBCRM_BASE_URL": "https://SEU-DEPLOYMENT.convex.site"
      }
    }
  }
}`}</CodeBlock>
            </Card>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">
                Configuracao — Cursor / VS Code
              </h3>
              <p className="text-sm text-text-secondary">
                Adicione ao <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">.cursor/mcp.json</code> ou <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">.vscode/mcp.json</code>:
              </p>
              <CodeBlock language="json">{`{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_KEY": "sua_chave_aqui",
        "HNBCRM_BASE_URL": "https://SEU-DEPLOYMENT.convex.site"
      }
    }
  }
}`}</CodeBlock>
            </Card>
          </section>

          {/* MCP Tools Reference */}
          <section id="mcp-tools" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Table2 className="text-brand-400" size={24} />
              Tools MCP — Referencia
            </h2>
            <p className="text-text-secondary">
              O servidor MCP expoe 19 ferramentas organizadas por categoria. Cada
              ferramenta corresponde a uma acao no CRM.
            </p>

            {/* Leads */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Leads
                  <Badge variant="brand">7 tools</Badge>
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-40">Tool</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-48">Parametros chave</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ToolRow name="create_lead" description="Cria um novo lead no pipeline" params="title, boardId, contactId?" />
                    <ToolRow name="list_leads" description="Lista leads com filtros" params="boardId?, stageId?, assignedTo?" />
                    <ToolRow name="get_lead" description="Retorna detalhes de um lead" params="id" />
                    <ToolRow name="update_lead" description="Atualiza campos de um lead" params="id, fields" />
                    <ToolRow name="delete_lead" description="Remove um lead" params="id" />
                    <ToolRow name="move_lead_stage" description="Move lead para outra etapa" params="id, stageId" />
                    <ToolRow name="assign_lead" description="Atribui lead a um membro" params="id, assignedTo" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Contacts */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Contatos
                  <Badge variant="brand">4 tools</Badge>
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-40">Tool</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-48">Parametros chave</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ToolRow name="create_contact" description="Cria um novo contato" params="name, email?, phone?" />
                    <ToolRow name="list_contacts" description="Lista todos os contatos" params="—" />
                    <ToolRow name="get_contact" description="Retorna detalhes do contato" params="id" />
                    <ToolRow name="update_contact" description="Atualiza dados do contato" params="id, fields" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Conversations */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Conversas
                  <Badge variant="brand">3 tools</Badge>
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-40">Tool</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-48">Parametros chave</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ToolRow name="list_conversations" description="Lista conversas de um lead" params="leadId" />
                    <ToolRow name="get_messages" description="Retorna mensagens de uma conversa" params="conversationId" />
                    <ToolRow name="send_message" description="Envia mensagem em uma conversa" params="conversationId, body, role" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Handoffs */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Handoffs
                  <Badge variant="brand">3 tools</Badge>
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-40">Tool</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-48">Parametros chave</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ToolRow name="request_handoff" description="Solicita repasse IA para humano" params="leadId, reason" />
                    <ToolRow name="list_handoffs" description="Lista handoffs por status" params="status?" />
                    <ToolRow name="resolve_handoff" description="Aceita ou rejeita um handoff" params="id, action" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Pipeline */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Pipeline
                  <Badge variant="brand">2 tools</Badge>
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-40">Tool</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-48">Parametros chave</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ToolRow name="list_boards" description="Lista boards com suas etapas" params="—" />
                    <ToolRow name="list_team_members" description="Lista membros da equipe" params="—" />
                  </tbody>
                </table>
              </div>
            </Card>
          </section>

          {/* REST API */}
          <section id="rest-api" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Globe className="text-brand-400" size={24} />
              API REST
            </h2>
            <p className="text-text-secondary">
              Base URL: <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">https://SEU-DEPLOYMENT.convex.site/api/v1</code>
            </p>
            <p className="text-sm text-text-secondary">
              Todos os endpoints requerem o header{" "}
              <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">X-API-Key</code>.
              Respostas em JSON.
            </p>

            {/* Leads endpoints */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary">Leads</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-16">Metodo</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-56">Path</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                    </tr>
                  </thead>
                  <tbody>
                    <EndpointRow method="POST" path="/api/v1/inbound/lead" description="Criar lead (com contato e mensagem opcionais)" />
                    <EndpointRow method="GET" path="/api/v1/leads" description="Listar leads (filtros: boardId, stageId, assignedTo)" />
                    <EndpointRow method="GET" path="/api/v1/leads/get" description="Detalhes do lead (param: id)" />
                    <EndpointRow method="POST" path="/api/v1/leads/update" description="Atualizar campos do lead" />
                    <EndpointRow method="POST" path="/api/v1/leads/delete" description="Remover lead" />
                    <EndpointRow method="POST" path="/api/v1/leads/move-stage" description="Mover lead para outra etapa" />
                    <EndpointRow method="POST" path="/api/v1/leads/assign" description="Atribuir lead a membro da equipe" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Contacts endpoints */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary">Contatos</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-16">Metodo</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-56">Path</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                    </tr>
                  </thead>
                  <tbody>
                    <EndpointRow method="GET" path="/api/v1/contacts" description="Listar contatos" />
                    <EndpointRow method="POST" path="/api/v1/contacts/create" description="Criar contato" />
                    <EndpointRow method="GET" path="/api/v1/contacts/get" description="Detalhes do contato (param: id)" />
                    <EndpointRow method="POST" path="/api/v1/contacts/update" description="Atualizar contato" />
                    <EndpointRow method="POST" path="/api/v1/contacts/enrich" description="Enriquecer dados do contato (IA)" />
                    <EndpointRow method="GET" path="/api/v1/contacts/gaps" description="Gaps de enriquecimento (param: id)" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Conversations endpoints */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary">Conversas</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-16">Metodo</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-56">Path</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                    </tr>
                  </thead>
                  <tbody>
                    <EndpointRow method="GET" path="/api/v1/conversations" description="Listar conversas (filtro: leadId)" />
                    <EndpointRow method="GET" path="/api/v1/conversations/messages" description="Mensagens de uma conversa (param: conversationId)" />
                    <EndpointRow method="POST" path="/api/v1/conversations/send" description="Enviar mensagem" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Handoffs endpoints */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary">Handoffs</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-16">Metodo</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-56">Path</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                    </tr>
                  </thead>
                  <tbody>
                    <EndpointRow method="POST" path="/api/v1/leads/handoff" description="Solicitar repasse" />
                    <EndpointRow method="GET" path="/api/v1/handoffs" description="Listar handoffs (filtro: status)" />
                    <EndpointRow method="GET" path="/api/v1/handoffs/pending" description="Listar handoffs pendentes" />
                    <EndpointRow method="POST" path="/api/v1/handoffs/accept" description="Aceitar handoff" />
                    <EndpointRow method="POST" path="/api/v1/handoffs/reject" description="Rejeitar handoff" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Pipeline endpoints */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Pipeline
                  <Badge variant="success">Novo</Badge>
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken/50">
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-16">Metodo</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted w-56">Path</th>
                      <th className="py-2 px-3 text-xs font-semibold text-text-muted">Descricao</th>
                    </tr>
                  </thead>
                  <tbody>
                    <EndpointRow method="GET" path="/api/v1/boards" description="Listar boards com etapas" />
                    <EndpointRow method="GET" path="/api/v1/team-members" description="Listar membros da equipe" />
                    <EndpointRow method="GET" path="/api/v1/field-definitions" description="Listar definicoes de campos" />
                  </tbody>
                </table>
              </div>
            </Card>
          </section>

          {/* Webhooks */}
          <section id="webhooks" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Webhook className="text-brand-400" size={24} />
              Webhooks
            </h2>
            <p className="text-text-secondary">
              Receba notificacoes em tempo real quando eventos acontecem no CRM.
              Configure webhooks em{" "}
              <span className="text-brand-400 font-medium">
                Configuracoes &gt; Webhooks
              </span>.
            </p>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">Eventos disponiveis</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[
                  "lead.created",
                  "lead.updated",
                  "lead.deleted",
                  "lead.stage_changed",
                  "lead.assigned",
                  "contact.created",
                  "contact.updated",
                  "conversation.message_sent",
                  "handoff.requested",
                  "handoff.accepted",
                  "handoff.rejected",
                ].map((event) => (
                  <code
                    key={event}
                    className="text-xs font-mono text-brand-400 bg-surface-overlay px-2 py-1.5 rounded border border-border"
                  >
                    {event}
                  </code>
                ))}
              </div>
            </Card>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">
                Verificacao de assinatura — HMAC-SHA256
              </h3>
              <p className="text-sm text-text-secondary">
                Cada request de webhook inclui o header{" "}
                <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">
                  X-Webhook-Signature
                </code>{" "}
                com a assinatura HMAC-SHA256 do body usando seu webhook secret.
              </p>
              <CodeBlock language="javascript">{`const crypto = require("crypto");

function verifyWebhook(body, signature, secret) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}`}</CodeBlock>
            </Card>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">Exemplo de payload</h3>
              <CodeBlock language="json">{`{
  "event": "lead.created",
  "timestamp": "2026-02-15T12:00:00.000Z",
  "data": {
    "id": "jd7x...",
    "title": "Novo lead via formulario",
    "boardId": "kn8y...",
    "stageId": "m2a4...",
    "contactId": "p5b7...",
    "assignedTo": null,
    "customFields": {},
    "createdAt": 1739620800000
  }
}`}</CodeBlock>
            </Card>
          </section>

          {/* Code Examples */}
          <section id="examples" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Code2 className="text-brand-400" size={24} />
              Exemplos de Codigo
            </h2>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">
                Criar lead a partir de formulario web
              </h3>
              <p className="text-sm text-text-secondary">
                Envie dados de um formulario de contato direto para o CRM:
              </p>
              <CodeBlock language="javascript">{`async function createLeadFromForm(formData) {
  const response = await fetch(
    "https://SEU-DEPLOYMENT.convex.site/api/v1/inbound/lead",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.HNBCRM_API_KEY,
      },
      body: JSON.stringify({
        title: \`Lead: \${formData.name}\`,
        contact: {
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
        },
        message: formData.message,
      }),
    }
  );

  const data = await response.json();
  console.log("Lead criado:", data.leadId);
  return data;
}`}</CodeBlock>
            </Card>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">
                Integracao com agente de IA
              </h3>
              <p className="text-sm text-text-secondary">
                Exemplo de um agente que monitora leads e solicita handoff quando
                necessario:
              </p>
              <CodeBlock language="javascript">{`async function aiAgentCheckLeads(apiKey, baseUrl) {
  // 1. Listar leads nao atribuidos
  const res = await fetch(\`\${baseUrl}/api/v1/leads\`, {
    headers: { "X-API-Key": apiKey },
  });
  const { leads } = await res.json();

  for (const lead of leads) {
    if (!lead.assignedTo) {
      // 2. Verificar conversas do lead
      const convRes = await fetch(
        \`\${baseUrl}/api/v1/conversations?leadId=\${lead._id}\`,
        { headers: { "X-API-Key": apiKey } }
      );
      const { conversations } = await convRes.json();

      if (conversations.length > 0) {
        // 3. Solicitar handoff para humano
        await fetch(\`\${baseUrl}/api/v1/leads/handoff\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          body: JSON.stringify({
            leadId: lead._id,
            reason: "Lead com conversas ativas sem atribuicao",
          }),
        });
        console.log(\`Handoff solicitado para lead: \${lead.title}\`);
      }
    }
  }
}`}</CodeBlock>
            </Card>
          </section>

          {/* Bottom spacer */}
          <div className="h-16" />
        </main>
      </div>

      {/* Footer */}
      <footer className="py-8 border-t border-border">
        <div className="max-w-6xl mx-auto px-4 text-center">
          <div className="flex items-center justify-center gap-2 mb-4">
            <img
              src="/orange_icon_logo_transparent-bg-528x488.png"
              alt="HNBCRM Logo"
              className="h-8 w-8"
            />
            <span className="text-xl font-bold text-text-primary">HNBCRM</span>
          </div>
          <div className="flex items-center justify-center gap-6 mb-4">
            <Link
              to="/"
              className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              Home
            </Link>
            <Link
              to="/entrar"
              className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              Entrar
            </Link>
          </div>
          <p className="text-sm text-text-muted">
            &copy; 2025 HNBCRM. Todos os direitos reservados.
          </p>
        </div>
      </footer>
    </div>
  );
}
