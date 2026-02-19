import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowLeft,
  Bot,
  Check,
  Key,
  Server,
  Table2,
  Globe,
  Webhook,
  Code2,
  Rocket,
  Play,
  Search as SearchIcon,
  Download,
  BookOpen,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/developers/CodeBlock";
import { ALL_ENDPOINTS, API_CATEGORIES, getEndpointsByCategory } from "@/lib/apiRegistry";
import { SEO } from "@/components/SEO";

const sections = [
  { id: "quick-start", label: "Quick Start", icon: Rocket },
  { id: "playground", label: "Playground", icon: Play },
  { id: "auth", label: "Autenticacao", icon: Key },
  { id: "mcp", label: "Servidor MCP", icon: Server },
  { id: "mcp-tools", label: "Tools MCP", icon: Table2 },
  { id: "openclaw", label: "OpenClaw", icon: Bot },
  { id: "agent-skills", label: "Agent Skills", icon: BookOpen },
  { id: "rest-api", label: "API REST", icon: Globe },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
  { id: "examples", label: "Exemplos", icon: Code2 },
];

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
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState("quick-start");
  const [searchQuery, setSearchQuery] = useState("");
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
    <>
      <SEO
        title="Developer Documentation"
        description="API REST, servidor MCP, webhooks e agent skills para integrar IA no HNBCRM. 44 endpoints documentados com playground interativo."
        keywords="api, rest, mcp, webhooks, developer, integration, ai agents"
      />
      <div className="min-h-screen bg-surface-base text-text-primary">
        {/* Header */}
      <header className="sticky top-0 z-30 bg-surface-base/80 backdrop-blur-md border-b border-border">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-shrink-0">
            <Link to="/" className="flex items-center gap-2">
              <img
                src="/orange_icon_logo_transparent-bg-528x488.png"
                alt="HNBCRM Logo"
                className="h-7 w-7 object-contain"
              />
              <span className="text-lg font-bold text-text-primary">HNBCRM</span>
            </Link>
            <span className="text-text-muted">/</span>
            <span className="text-sm font-medium text-text-secondary">Developers</span>
          </div>

          <div className="flex items-center gap-2 flex-1 max-w-sm mx-4">
            <div className="relative flex-1">
              <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                placeholder="Buscar endpoints..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 bg-surface-overlay border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand-500"
              />
            </div>
          </div>

          <Link to="/" className="flex-shrink-0">
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
          {sections.map((s) =>
            s.id === "playground" ? (
              <Link
                key={s.id}
                to="/developers/playground"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors text-text-muted hover:text-text-secondary"
              >
                <s.icon size={14} />
                {s.label}
                <ExternalLink size={10} />
              </Link>
            ) : (
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
            )
          )}
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 flex gap-8">
        {/* Desktop Sidebar ToC */}
        <nav className="hidden md:block w-52 flex-shrink-0">
          <div className="sticky top-[73px] py-8 space-y-1">
            {sections.map((s) =>
              s.id === "playground" ? (
                <Link
                  key={s.id}
                  to="/developers/playground"
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left text-text-muted hover:text-text-secondary hover:bg-surface-raised"
                >
                  <s.icon size={16} />
                  {s.label}
                  <ExternalLink size={12} className="ml-auto opacity-50" />
                </Link>
              ) : (
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
              )
            )}
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

          {/* Quick Start */}
          <section id="quick-start" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Rocket className="text-brand-400" size={24} />
              Quick Start
            </h2>
            <p className="text-text-secondary">
              Comece a usar a API em 3 passos simples.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Step 1 */}
              <Card className="p-6 space-y-3">
                <div className="w-8 h-8 rounded-full bg-brand-500/10 border border-brand-500 flex items-center justify-center">
                  <span className="text-sm font-bold text-brand-500">1</span>
                </div>
                <h3 className="font-semibold text-text-primary">Gere sua API Key</h3>
                <p className="text-sm text-text-secondary">
                  Acesse <span className="text-brand-400">Configuracoes &gt; API Keys</span> no app e crie uma nova chave.
                </p>
              </Card>

              {/* Step 2 */}
              <Card className="p-6 space-y-3">
                <div className="w-8 h-8 rounded-full bg-brand-500/10 border border-brand-500 flex items-center justify-center">
                  <span className="text-sm font-bold text-brand-500">2</span>
                </div>
                <h3 className="font-semibold text-text-primary">Faca sua primeira chamada</h3>
                <p className="text-sm text-text-secondary">
                  Use cURL ou qualquer HTTP client:
                </p>
                <CodeBlock language="bash">{`curl -X GET "https://SEU-DEPLOYMENT.convex.site/api/v1/boards" \\
  -H "X-API-Key: sua_chave_aqui"`}</CodeBlock>
              </Card>

              {/* Step 3 */}
              <Card className="p-6 space-y-3">
                <div className="w-8 h-8 rounded-full bg-brand-500/10 border border-brand-500 flex items-center justify-center">
                  <span className="text-sm font-bold text-brand-500">3</span>
                </div>
                <h3 className="font-semibold text-text-primary">Explore o Playground</h3>
                <p className="text-sm text-text-secondary">
                  Teste todos os endpoints direto do navegador em tela cheia.
                </p>
                <Link to="/developers/playground">
                  <Button variant="primary" size="sm">
                    <Play size={14} />
                    Abrir Playground
                  </Button>
                </Link>
              </Card>
            </div>
          </section>

          {/* Playground CTA */}
          <section id="playground" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Play className="text-brand-400" size={24} />
              API Playground
            </h2>
            <Card className="p-8 flex flex-col md:flex-row items-center gap-6">
              <div className="w-14 h-14 rounded-2xl bg-brand-500/10 border border-brand-500/30 flex items-center justify-center flex-shrink-0">
                <Play size={28} className="text-brand-500" />
              </div>
              <div className="flex-1 text-center md:text-left">
                <h3 className="text-lg font-semibold text-text-primary mb-1">
                  Teste endpoints em tempo real
                </h3>
                <p className="text-sm text-text-secondary">
                  Configure sua Base URL e API Key, selecione um endpoint e envie requisicoes — tudo direto do navegador.
                </p>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer">
                  <Button variant="ghost" size="sm">
                    <Download size={14} />
                    OpenAPI Spec
                  </Button>
                </a>
                <Link to="/developers/playground">
                  <Button variant="primary">
                    <Play size={16} />
                    Abrir Playground
                  </Button>
                </Link>
              </div>
            </Card>
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
              <p className="text-sm text-text-muted">
                Tambem disponivel no{" "}
                <a href="https://smithery.ai/servers/hnbcrm-mcp" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline">
                  Smithery.ai
                </a>
                {" "}e via{" "}
                <a href="https://www.npmjs.com/package/hnbcrm-mcp" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline">
                  npm
                </a>.
              </p>
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
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_KEY": "sua_chave_aqui",
        "HNBCRM_API_URL": "https://SEU-DEPLOYMENT.convex.site"
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
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_KEY": "sua_chave_aqui",
        "HNBCRM_API_URL": "https://SEU-DEPLOYMENT.convex.site"
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
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_KEY": "sua_chave_aqui",
        "HNBCRM_API_URL": "https://SEU-DEPLOYMENT.convex.site"
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
              O servidor MCP expoe 44 ferramentas organizadas por categoria. Cada
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
                    <ToolRow name="crm_create_lead" description="Cria um novo lead no pipeline" params="title, contact?, value?" />
                    <ToolRow name="crm_list_leads" description="Lista leads com filtros" params="boardId?, stageId?, assignedTo?" />
                    <ToolRow name="crm_get_lead" description="Retorna detalhes de um lead" params="id" />
                    <ToolRow name="crm_update_lead" description="Atualiza campos de um lead" params="leadId, title?, value?, priority?" />
                    <ToolRow name="crm_delete_lead" description="Remove um lead permanentemente" params="leadId" />
                    <ToolRow name="crm_move_lead" description="Move lead para outra etapa" params="leadId, stageId" />
                    <ToolRow name="crm_assign_lead" description="Atribui lead a um membro" params="leadId, assignedTo?" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Contacts */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Contatos
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
                    <ToolRow name="crm_list_contacts" description="Lista todos os contatos" params="—" />
                    <ToolRow name="crm_get_contact" description="Retorna detalhes do contato" params="id" />
                    <ToolRow name="crm_create_contact" description="Cria um novo contato" params="firstName?, email?, phone?, company?" />
                    <ToolRow name="crm_update_contact" description="Atualiza dados do contato" params="contactId, fields..." />
                    <ToolRow name="crm_enrich_contact" description="Adiciona dados de enriquecimento" params="contactId, fields, source" />
                    <ToolRow name="crm_get_contact_gaps" description="Identifica campos vazios" params="id" />
                    <ToolRow name="crm_search_contacts" description="Busca contatos por texto" params="query, limit?" />
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
                    <ToolRow name="crm_list_conversations" description="Lista conversas de um lead" params="leadId?" />
                    <ToolRow name="crm_get_messages" description="Retorna mensagens de uma conversa" params="conversationId" />
                    <ToolRow name="crm_send_message" description="Envia mensagem em uma conversa" params="conversationId, content" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Handoffs */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Handoffs
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
                    <ToolRow name="crm_request_handoff" description="Solicita repasse IA para humano" params="leadId, reason" />
                    <ToolRow name="crm_list_handoffs" description="Lista handoffs por status" params="status?" />
                    <ToolRow name="crm_accept_handoff" description="Aceita um handoff pendente" params="handoffId, notes?" />
                    <ToolRow name="crm_reject_handoff" description="Rejeita um handoff pendente" params="handoffId, notes?" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Pipeline */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Pipeline
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
                    <ToolRow name="crm_list_boards" description="Lista boards com suas etapas" params="—" />
                    <ToolRow name="crm_list_team" description="Lista membros da equipe" params="—" />
                    <ToolRow name="crm_get_dashboard" description="Retorna analytics do pipeline" params="—" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Activities */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Atividades
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
                    <ToolRow name="crm_get_activities" description="Timeline de atividades do lead" params="leadId, limit?" />
                    <ToolRow name="crm_create_activity" description="Registra nota, ligacao ou email" params="leadId, type, content?" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Tasks */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Tarefas
                  <Badge variant="brand">12 tools</Badge>
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
                    <ToolRow name="crm_list_tasks" description="Lista tarefas com filtros" params="status?, priority?, assignedTo?" />
                    <ToolRow name="crm_get_task" description="Retorna detalhes de uma tarefa" params="taskId" />
                    <ToolRow name="crm_create_task" description="Cria nova tarefa ou lembrete" params="title, type?, dueDate?" />
                    <ToolRow name="crm_update_task" description="Atualiza campos da tarefa" params="taskId, title?, priority?" />
                    <ToolRow name="crm_delete_task" description="Remove tarefa permanentemente" params="taskId" />
                    <ToolRow name="crm_complete_task" description="Marca tarefa como concluida" params="taskId" />
                    <ToolRow name="crm_snooze_task" description="Adia tarefa ate data futura" params="taskId, snoozedUntil" />
                    <ToolRow name="crm_archive_task" description="Arquiva tarefa completada" params="taskId" />
                    <ToolRow name="crm_unarchive_task" description="Restaura tarefa arquivada" params="taskId" />
                    <ToolRow name="crm_add_task_comment" description="Adiciona comentario a tarefa" params="taskId, content" />
                    <ToolRow name="crm_list_task_comments" description="Lista comentarios de uma tarefa" params="taskId" />
                    <ToolRow name="crm_search_tasks" description="Busca tarefas por texto" params="query, limit?" />
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Calendar */}
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                <h3 className="font-semibold text-text-primary flex items-center gap-2">
                  Calendario
                  <Badge variant="brand">6 tools</Badge>
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
                    <ToolRow name="calendar_list_events" description="Lista eventos em periodo" params="startDate, endDate, assignedTo?" />
                    <ToolRow name="calendar_get_event" description="Retorna detalhes do evento" params="eventId" />
                    <ToolRow name="calendar_create_event" description="Cria novo evento no calendario" params="title, eventType, startTime, endTime" />
                    <ToolRow name="calendar_update_event" description="Atualiza campos do evento" params="eventId, title?, startTime?" />
                    <ToolRow name="calendar_delete_event" description="Remove evento permanentemente" params="eventId" />
                    <ToolRow name="calendar_reschedule_event" description="Reagenda evento para novo horario" params="eventId, newStartTime" />
                  </tbody>
                </table>
              </div>
            </Card>
          </section>

          {/* OpenClaw Integration */}
          <section id="openclaw" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Bot className="text-brand-400" size={24} />
              OpenClaw
            </h2>
            <p className="text-text-secondary">
              O HNBCRM e compativel nativamente com{" "}
              <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline">
                OpenClaw
              </a>
              {" "}&mdash; o agente de IA open-source com 100k+ estrelas no GitHub.
              Conecte seu CRM ao OpenClaw via MCP em minutos.
            </p>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">Setup Rapido</h3>
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-text-secondary mb-2">
                    <span className="text-brand-400 font-semibold">1.</span> Instale o servidor MCP via npm:
                  </p>
                  <CodeBlock language="bash">{`npm install -g hnbcrm-mcp`}</CodeBlock>
                </div>
                <div>
                  <p className="text-sm text-text-secondary mb-2">
                    <span className="text-brand-400 font-semibold">2.</span> Configure no OpenClaw (MCP bridge):
                  </p>
                  <CodeBlock language="json">{`{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://seu-deployment.convex.site",
        "HNBCRM_API_KEY": "sua_chave_aqui"
      }
    }
  }
}`}</CodeBlock>
                </div>
                <div>
                  <p className="text-sm text-text-secondary mb-2">
                    <span className="text-brand-400 font-semibold">3.</span> Copie o Agent Skill (opcional, melhora o contexto do agente):
                  </p>
                  <CodeBlock language="bash">{`cp -r .claude/skills/hnbcrm/ ~/.openclaw/workspace/skills/hnbcrm/`}</CodeBlock>
                </div>
              </div>
            </Card>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">O que o OpenClaw pode fazer com HNBCRM</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  "Gerenciar leads no pipeline automaticamente",
                  "Enriquecer contatos com dados de pesquisa web",
                  "Responder conversas e enviar mensagens",
                  "Solicitar handoffs para vendedores humanos",
                  "Criar tarefas e agendar eventos no calendario",
                  "Gerar relatorios de analytics do pipeline",
                ].map((capability) => (
                  <div key={capability} className="flex items-start gap-2 text-sm text-text-secondary">
                    <Check className="text-brand-500 flex-shrink-0 mt-0.5" size={16} />
                    <span>{capability}</span>
                  </div>
                ))}
              </div>
            </Card>
          </section>

          {/* Agent Skills */}
          <section id="agent-skills" className="space-y-6 scroll-mt-24">
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <BookOpen className="text-brand-400" size={24} />
              Agent Skills
            </h2>
            <p className="text-text-secondary">
              Skill portavel open-standard que ensina qualquer agente de IA a operar como membro
              da equipe no CRM — gerenciar leads, enriquecer contatos, responder conversas e
              executar handoffs para humanos.
            </p>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">Conteudo do Skill</h3>
              <p className="text-sm text-text-secondary">
                O skill vive em <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">.claude/skills/hnbcrm/</code> e
                segue o padrao <span className="text-brand-400">AgentSkills.io</span>. Pode ser copiado para qualquer plataforma.
              </p>
              <div className="space-y-2">
                {[
                  { file: "SKILL.md", desc: "Skill principal — papel do agente, bootstrap, workflows, boas praticas" },
                  { file: "references/WORKFLOWS.md", desc: "Playbooks passo a passo: intake, qualificacao, enrichment, handoffs" },
                  { file: "references/API_REFERENCE.md", desc: "Mapeamento completo MCP tools <> REST endpoints" },
                  { file: "references/DATA_MODEL.md", desc: "Tabelas, campos e valores de enum" },
                  { file: "references/SETUP.md", desc: "Configuracao por plataforma (Claude, Cursor, VS Code, Gemini, OpenClaw)" },
                ].map((item) => (
                  <div key={item.file} className="flex items-start gap-3 p-3 rounded-lg bg-surface-overlay border border-border">
                    <code className="text-xs font-mono text-brand-400 whitespace-nowrap mt-0.5">{item.file}</code>
                    <span className="text-sm text-text-secondary">{item.desc}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">Quick Setup</h3>
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-text-secondary mb-2">
                    <span className="text-brand-400 font-semibold">1.</span> Configure o servidor MCP (necessario para as tools):
                  </p>
                  <CodeBlock language="bash">{`# Defina as variaveis de ambiente
export HNBCRM_API_URL="https://seu-deployment.convex.site"
export HNBCRM_API_KEY="sua_chave_aqui"

# Teste a conexao
npx hnbcrm-mcp`}</CodeBlock>
                </div>
                <div>
                  <p className="text-sm text-text-secondary mb-2">
                    <span className="text-brand-400 font-semibold">2.</span> Copie o skill para seu agente:
                  </p>
                  <CodeBlock language="bash">{`# Claude Code (ja detecta automaticamente)
# Para outras plataformas:
cp -r .claude/skills/hnbcrm/ ~/.sua-plataforma/skills/hnbcrm/`}</CodeBlock>
                </div>
                <div>
                  <p className="text-sm text-text-secondary mb-2">
                    <span className="text-brand-400 font-semibold">3.</span> O agente le o SKILL.md e inicia o bootstrap:
                  </p>
                  <CodeBlock language="text">{`1. crm_list_team → descobre sua identidade e equipe
2. crm_list_boards → aprende as etapas do pipeline
3. crm_list_handoffs → verifica trabalho pendente
4. crm_list_leads → revisa leads atribuidos`}</CodeBlock>
                </div>
              </div>
            </Card>

            <Card className="p-6 space-y-4">
              <h3 className="font-semibold text-text-primary">Plataformas Compativeis</h3>
              <div className="flex flex-wrap gap-2">
                {[
                  "Claude Code",
                  "Claude Desktop",
                  "Cursor",
                  "VS Code",
                  "Gemini CLI",
                  "OpenClaw",
                  "REST API (qualquer agente)",
                ].map((platform) => (
                  <span
                    key={platform}
                    className="px-3 py-1.5 rounded-full text-xs font-medium bg-surface-overlay border border-border text-text-secondary"
                  >
                    {platform}
                  </span>
                ))}
              </div>
              <p className="text-sm text-text-muted">
                O skill funciona com qualquer plataforma que suporte MCP ou REST API. Veja{" "}
                <code className="text-brand-400 bg-surface-overlay px-1.5 py-0.5 rounded text-xs">references/SETUP.md</code>{" "}
                para instrucoes detalhadas.
              </p>
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
              Respostas em JSON. Total: {ALL_ENDPOINTS.length} endpoints.
            </p>

            {API_CATEGORIES.map((category) => {
              const endpoints = getEndpointsByCategory(category);
              // Apply search filter
              const filtered = searchQuery
                ? endpoints.filter((ep) =>
                    ep.path.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    ep.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    ep.description.toLowerCase().includes(searchQuery.toLowerCase())
                  )
                : endpoints;
              if (filtered.length === 0) return null;

              return (
                <Card key={category} className="p-0 overflow-hidden">
                  <div className="px-4 py-3 bg-surface-overlay border-b border-border">
                    <h3 className="font-semibold text-text-primary flex items-center gap-2">
                      {category}
                      <Badge variant="brand">{filtered.length}</Badge>
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
                        {filtered.map((ep) => (
                          <tr
                            key={ep.id}
                            className="border-b border-border last:border-b-0 hover:bg-surface-overlay/50 cursor-pointer transition-colors"
                            onClick={() => navigate(`/developers/playground?endpoint=${ep.id}`)}
                          >
                            <td className="py-2.5 px-3">
                              <span className={cn(
                                "font-mono text-xs font-semibold",
                                ep.method === "GET" ? "text-semantic-success" : "text-semantic-info"
                              )}>
                                {ep.method}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 font-mono text-xs text-brand-400">{ep.path}</td>
                            <td className="py-2.5 px-3 text-sm text-text-secondary">{ep.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              );
            })}
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
              className="h-8 w-8 object-contain"
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
    </>
  );
}
