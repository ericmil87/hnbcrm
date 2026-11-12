import { Link } from "react-router";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import { startHref } from "@/lib/onboardingEntry";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS, PRIMARY_CTA_LABEL } from "./landingCopy";

export const HOW_STEPS = [
  {
    title: "Conte o seu negócio.",
    body: "Escreva, fale ou mande o link do site. O Copiloto monta o Funil e o Atendente.",
    badge: "Cerca de 2 minutos",
  },
  {
    title: "Teste a sua IA.",
    body: "Converse com ela como se fosse um cliente, ali mesmo, antes de ligar qualquer coisa.",
    badge: "Sem conectar número",
  },
  {
    title: "Conecte o WhatsApp.",
    body: "Leia o QR code com o celular do negócio e ligue. Você escolhe quando liberar o automático.",
    badge: "QR code ou API oficial",
  },
] as const;

export const QR_WARNING =
  "A conexão por QR code não é oficial do WhatsApp e existe risco de o número ser banido. Antes de ligar, a gente explica o risco e pede o seu aceite. Se o seu atendimento não pode parar, use a API oficial da Meta, que também funciona aqui (a Meta cobra as mensagens direto de você).";

/** S5: três passos, aviso honesto sobre o QR code (sempre visível) e o botão "Testar grátis". */
export function S5HowItStarts() {
  return (
    <LandingSection id={LANDING_ANCHORS.howItStarts} eyebrow="Em 3 passos" title="Como começa">
      <ol className="grid gap-4 md:grid-cols-3">
        {HOW_STEPS.map((step, i) => (
          <li key={step.title} className="flex min-w-0 gap-4 rounded-card border border-border bg-surface-raised p-4 shadow-card md:flex-col">
            <span
              aria-hidden="true"
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-600 font-display text-lg font-bold tabular-nums text-white"
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-lg font-bold text-text-primary">
                <span className="sr-only">Passo {i + 1}: </span>
                {step.title}
              </h3>
              <p className="mt-1 text-base text-text-secondary">{step.body}</p>
              <Badge variant="brand" className="mt-3">
                {step.badge}
              </Badge>
            </div>
          </li>
        ))}
      </ol>

      <div role="note" className="mt-6 flex items-start gap-3 rounded-card border border-border bg-surface-sunken p-4">
        <Info className="mt-0.5 size-5 shrink-0 text-semantic-info" aria-hidden="true" />
        <div className="text-sm text-text-secondary md:text-base">
          <p>{QR_WARNING}</p>
          <p className="mt-2 text-text-muted">
            Se o número cair, os administradores recebem aviso na hora e as campanhas daquele número param sozinhas.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <Link to={startHref()} className={buttonClassName("primary", "lg")}>
          {PRIMARY_CTA_LABEL}
        </Link>
      </div>
    </LandingSection>
  );
}
