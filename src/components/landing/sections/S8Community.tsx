import { lazy, Suspense } from "react";
import { Check } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { communityUrl } from "@/lib/communityLink";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

const CommunityQr = lazy(() => import("./CommunityQr"));

/** Três linhas da copy (a linha "Tem IA no grupo" não entra; vale a alternativa). */
const COMMUNITY_LINES = ["Dicas da semana e novidades", "Ajuda de quem já usa", "Regras simples, fixadas na descrição"];

/**
 * S8: comunidade. Sem `VITE_COMMUNITY_URL` válida (https) a seção não aparece.
 * No computador mostra também o QR code do link (SVG, carregado sob demanda,
 * sem script de build nem biblioteca nova: `qrcode.react` já é usada no app).
 */
export function S8Community() {
  const url = communityUrl();
  const desktop = useMediaQuery("(min-width: 768px) and (pointer: fine)");
  if (!url) return null;
  return (
    <LandingSection
      id={LANDING_ANCHORS.community}
      eyebrow="Comunidade"
      title="Entre no grupo de quem está colocando IA no atendimento"
      subtitle="Troque ideias, tire dúvidas e receba as novidades do HNBCRM no WhatsApp."
    >
      <div className="flex flex-col gap-8 md:flex-row md:items-center md:gap-12">
        <div>
          <ul className="space-y-2">
            {COMMUNITY_LINES.map((line) => (
              <li key={line} className="flex items-start gap-2 text-text-primary">
                <Check className="mt-1 size-4 shrink-0 text-semantic-success" aria-hidden="true" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClassName("primary", "lg", "mt-6 w-full sm:w-auto")}
          >
            Entrar no grupo do WhatsApp
          </a>
        </div>
        {desktop && (
          <figure className="flex flex-col items-center gap-2">
            <Suspense fallback={<div className="size-36" aria-hidden="true" />}>
              <CommunityQr url={url} />
            </Suspense>
            <figcaption className="text-sm text-text-secondary">Aponte a câmera do celular para entrar.</figcaption>
          </figure>
        )}
      </div>
    </LandingSection>
  );
}
