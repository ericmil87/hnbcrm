import { Link } from "react-router";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { communityUrl } from "@/lib/communityLink";
import { LEGAL_ENTITY, legalIdentification } from "@/lib/legalEntity";
import { APP_BUILD } from "@/lib/pwa/appBuild";
import { versionFromBuild } from "@/lib/pwa/buildVersion";
import { LANDING_ANCHORS } from "./landingCopy";

const CHANGELOG_URL = "https://github.com/ericmil87/hnbcrm/blob/main/CHANGELOG.md";

const linkClass =
  "inline-flex min-h-11 items-center text-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 md:min-h-0";

interface LandingFooterProps {
  /** Versão a exibir (padrão: a do build). Só para teste. */
  version?: string | null;
}

/**
 * Rodapé da landing (copy aprovada): marca e frase, colunas Produto e Mais,
 * linha de código aberto e desenvolvedores, identificação legal (fonte única
 * `legalEntity.ts`), Termos, Privacidade e versão com link para o CHANGELOG.
 * "Comunidade" só aparece com `VITE_COMMUNITY_URL` válida.
 */
export function LandingFooter({ version }: LandingFooterProps) {
  const legal = legalIdentification();
  const appVersion = version === undefined ? versionFromBuild(APP_BUILD) : version;
  const hasCommunity = communityUrl() !== null;
  return (
    <footer className="border-t border-border bg-surface-base px-4 py-12">
      <div className="mx-auto max-w-6xl">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 space-y-3">
            <BrandLogo variant="wordmark" size="md" />
            <p className="max-w-xs text-sm text-text-secondary">Humanos e IAs no mesmo time, atendendo no WhatsApp.</p>
          </div>
          <nav aria-label="Produto" className="space-y-1">
            <h2 className="text-sm font-semibold text-text-primary">Produto</h2>
            <ul>
              <li>
                <a href={`#${LANDING_ANCHORS.machine}`} className={linkClass}>
                  Como funciona
                </a>
              </li>
              <li>
                <Link to="/precos" className={linkClass}>
                  Preços
                </Link>
              </li>
              <li>
                <a href={`#${LANDING_ANCHORS.services}`} className={linkClass}>
                  Feito com você
                </a>
              </li>
            </ul>
          </nav>
          <nav aria-label="Mais" className="space-y-1">
            <h2 className="text-sm font-semibold text-text-primary">Mais</h2>
            <ul>
              {hasCommunity && (
                <li>
                  <a href={`#${LANDING_ANCHORS.community}`} className={linkClass}>
                    Comunidade
                  </a>
                </li>
              )}
              <li>
                <a href={`#${LANDING_ANCHORS.faq}`} className={linkClass}>
                  Perguntas
                </a>
              </li>
              <li>
                <Link to="/developers" className={linkClass}>
                  Para desenvolvedores
                </Link>
              </li>
            </ul>
          </nav>
        </div>

        <p className="mt-8 text-sm text-text-secondary">
          Código aberto, com API, webhooks e servidor MCP.{" "}
          <Link to="/developers" className="underline underline-offset-2 hover:text-text-primary">
            Ver a documentação
          </Link>
        </p>

        <address className="mt-6 text-caption not-italic text-text-muted">
          Vendido por {legal.name}
          {" · "}
          {legal.incomplete ? (
            "CNPJ e endereço em atualização"
          ) : (
            <>
              {legal.document.replace(/\D/g, "").length === 14 ? "CNPJ" : "CPF"} {legal.document} · {legal.address}
            </>
          )}
          {" · "}
          <a href={`mailto:${LEGAL_ENTITY.email}`} className="underline underline-offset-2 hover:text-text-primary">
            {LEGAL_ENTITY.email}
          </a>
        </address>

        <div className="mt-6 flex flex-col gap-2 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-5">
            <Link to="/termos" className={linkClass}>
              Termos
            </Link>
            <Link to="/privacidade" className={linkClass}>
              Privacidade
            </Link>
          </div>
          {appVersion && (
            <a
              href={CHANGELOG_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center text-sm tabular-nums text-text-muted hover:text-text-primary md:min-h-0"
            >
              Versão {appVersion}
            </a>
          )}
        </div>
      </div>
    </footer>
  );
}
