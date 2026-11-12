import { Quote } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import {
  EXAMPLE_BADGE_LABEL,
  SOCIAL_PROOF,
  itemsOfKind,
  needsExampleBadge,
  socialProofTitle,
  visibleSocialProof,
  type SocialProofItem,
} from "../socialProof";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

interface S7bSocialProofProps {
  /** Itens (padrão: `SOCIAL_PROOF`). Só para teste. */
  items?: readonly SocialProofItem[];
  /** Modo de produção (padrão: `import.meta.env.PROD`). Só para teste. */
  prod?: boolean;
}

function ExampleBadge() {
  return <Badge variant="warning">{EXAMPLE_BADGE_LABEL}</Badge>;
}

/**
 * S7b: prova social. Lê tudo de `socialProof.ts`; em produção só itens reais
 * (hoje: cenas ilustrativas com selo e números verdadeiros). Depoimentos e a
 * faixa de logos só existem com item real autorizado.
 */
export function S7bSocialProof({ items = SOCIAL_PROOF, prod = import.meta.env.PROD }: S7bSocialProofProps) {
  const visible = visibleSocialProof(items, prod);
  const testimonials = itemsOfKind(visible, "depoimento");
  const scenes = itemsOfKind(visible, "cena");
  const numbers = itemsOfKind(visible, "numero");
  const logos = itemsOfKind(visible, "logo");
  if (visible.length === 0) return null;

  return (
    <LandingSection id={LANDING_ANCHORS.socialProof} title={socialProofTitle(visible)} tone="raised">
      <div className="space-y-10">
        {testimonials.length > 0 && (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-3" aria-label="Depoimentos">
            {testimonials.map((t) => (
              <li key={t.id} className="flex flex-col gap-3 rounded-card border border-border bg-surface-base p-4">
                <Quote className="size-5 text-brand-500" aria-hidden="true" />
                <blockquote className="flex-1 text-sm text-text-primary">{t.quote}</blockquote>
                <p className="text-sm text-text-secondary">
                  <span className="font-semibold text-text-primary">{t.name}</span>
                  {" · "}
                  {t.business}
                  {t.city ? ` · ${t.city}` : ""}
                </p>
                {needsExampleBadge(t) && <ExampleBadge />}
              </li>
            ))}
          </ul>
        )}

        {scenes.length > 0 && (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-3" aria-label="Cenas de uso">
            {scenes.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 rounded-card border border-border bg-surface-base p-4">
                <h3 className="font-display text-lg font-bold text-text-primary">{s.title}</h3>
                <p className="flex-1 text-sm text-text-secondary">{s.text}</p>
                {needsExampleBadge(s) && (
                  <div>
                    <ExampleBadge />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {numbers.length > 0 && (
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {numbers.map((n) => (
              <div key={n.id} className="rounded-card border border-border bg-surface-base p-4">
                <dt className="font-display text-2xl font-bold tabular-nums text-text-primary">{n.value}</dt>
                <dd className="mt-1 text-sm text-text-secondary">{n.text}</dd>
              </div>
            ))}
          </dl>
        )}

        {logos.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-text-secondary">Quem usa</h3>
            <ul className="mt-3 flex flex-wrap items-center gap-6">
              {logos.map((l) => (
                <li key={l.id} className="flex flex-col items-start gap-1">
                  {l.src ? (
                    <img src={l.src} alt={l.name} className="h-8 w-auto" loading="lazy" />
                  ) : (
                    <span className="text-sm font-semibold text-text-muted">{l.name}</span>
                  )}
                  {needsExampleBadge(l) && <ExampleBadge />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </LandingSection>
  );
}
