import { Link } from "react-router";
import { ExternalLink } from "lucide-react";

const GITHUB_URL = "https://github.com/ericmil87/hnbcrm";
const NPM_URL = "https://www.npmjs.com/package/hnbcrm-mcp";

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm text-text-secondary hover:text-text-primary transition-colors inline-flex items-center gap-1"
    >
      {children}
      <ExternalLink size={10} className="opacity-50" />
    </a>
  );
}

function InternalLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="text-sm text-text-secondary hover:text-text-primary transition-colors"
    >
      {children}
    </Link>
  );
}

export function Footer() {
  return (
    <footer className="py-12 border-t border-border">
      <div className="max-w-6xl mx-auto px-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
          {/* Col 1 — Brand */}
          <div className="col-span-2 md:col-span-1 space-y-3">
            <div className="flex items-center gap-2">
              <img
                src="/orange_icon_logo_transparent-bg-528x488.png"
                alt="HNBCRM Logo"
                className="h-8 w-8 object-contain"
              />
              <span className="text-xl font-bold text-text-primary">HNBCRM</span>
            </div>
            <p className="text-sm text-text-secondary">
              O CRM onde humanos e IA trabalham juntos.
            </p>
            <ExtLink href={GITHUB_URL}>GitHub</ExtLink>
          </div>

          {/* Col 2 — Produto */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-text-primary">Produto</h4>
            <div className="flex flex-col gap-2">
              <InternalLink to="/#funcionalidades">Funcionalidades</InternalLink>
              <InternalLink to="/#precos">Precos</InternalLink>
              <ExtLink href={`${GITHUB_URL}/blob/main/ROADMAP.md`}>Roadmap</ExtLink>
              <InternalLink to="/entrar">Entrar</InternalLink>
            </div>
          </div>

          {/* Col 3 — Desenvolvedores */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-text-primary">Desenvolvedores</h4>
            <div className="flex flex-col gap-2">
              <InternalLink to="/developers">Documentacao</InternalLink>
              <InternalLink to="/developers/playground">Playground</InternalLink>
              <InternalLink to="/developers#mcp">Servidor MCP</InternalLink>
              <InternalLink to="/developers#agent-skills">Agent Skills</InternalLink>
            </div>
          </div>

          {/* Col 4 — Comunidade */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-text-primary">Comunidade</h4>
            <div className="flex flex-col gap-2">
              <ExtLink href={GITHUB_URL}>GitHub</ExtLink>
              <ExtLink href={NPM_URL}>npm</ExtLink>
              <ExtLink href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`}>Contribuir</ExtLink>
              <ExtLink href={`${GITHUB_URL}/security`}>Seguranca</ExtLink>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-sm text-text-muted">
            &copy; 2026 HNBCRM. Todos os direitos reservados.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <InternalLink to="/termos">Termos</InternalLink>
            <InternalLink to="/privacidade">Privacidade</InternalLink>
            <ExtLink href={`${GITHUB_URL}/blob/main/LICENSE`}>MIT License</ExtLink>
          </div>
        </div>
      </div>
    </footer>
  );
}
