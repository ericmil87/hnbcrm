import { Moon, MessageCircle, Quote, Receipt, Sparkles, Sun, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { ACTOR_LABEL, DAY_IN_THE_LIFE, type DayMoment, type MomentActor, type MomentIcon } from "../dayInTheLife";
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
  /** Momentos do dia (padrão: `DAY_IN_THE_LIFE`). Só para teste. */
  moments?: readonly DayMoment[];
}

const ICONS: Record<MomentIcon, LucideIcon> = {
  sun: Sun,
  message: MessageCircle,
  receipt: Receipt,
  copilot: Sparkles,
  moon: Moon,
};

const ACTOR_VARIANT: Record<MomentActor, "brand" | "default" | "info"> = {
  ia: "info",
  equipe: "default",
  "ia-equipe": "brand",
};

function ExampleBadge() {
  return <Badge variant="warning">{EXAMPLE_BADGE_LABEL}</Badge>;
}

/**
 * Linha do tempo: vertical no celular, cinco colunas com um trilho no desktop.
 * O trilho é um segmento por momento (do ícone até o próximo), sem o último.
 */
function DayTimeline({ moments }: { moments: readonly DayMoment[] }) {
  return (
    <ol aria-label="Um dia de exemplo" className="grid grid-cols-1 gap-6 lg:grid-cols-5 lg:gap-4">
      {moments.map((m, i) => {
        const Icon = ICONS[m.icon];
        const last = i === moments.length - 1;
        return (
          <li key={m.id} className="relative pl-14 lg:pl-0 lg:pt-14">
            <span
              className="absolute left-0 top-0 flex size-11 items-center justify-center rounded-full border border-border bg-surface-base text-brand-500"
              aria-hidden="true"
            >
              <Icon className="size-5" />
            </span>
            {!last && (
              <span
                className="absolute -bottom-6 left-5 top-11 w-px bg-border lg:-right-4 lg:bottom-auto lg:left-11 lg:top-5 lg:h-px lg:w-auto"
                aria-hidden="true"
              />
            )}
            <p className="font-display text-xl font-bold tabular-nums text-text-primary">{m.time}</p>
            <h3 className="mt-1 text-base font-semibold text-text-primary">{m.title}</h3>
            <p className="mt-1 text-sm text-text-secondary">{m.text}</p>
            <Badge variant={ACTOR_VARIANT[m.actor]} className="mt-2">
              {ACTOR_LABEL[m.actor]}
            </Badge>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * S7b: "Um dia com o HNBCRM" (cenas de exemplo assumidas, uma nota discreta no
 * fim), faixa de fatos verificáveis e, só com item real autorizado, depoimentos
 * e logos (regra de produção em `socialProof.ts`).
 */
export function S7bSocialProof({
  items = SOCIAL_PROOF,
  prod = import.meta.env.PROD,
  moments = DAY_IN_THE_LIFE,
}: S7bSocialProofProps) {
  const visible = visibleSocialProof(items, prod);
  const testimonials = itemsOfKind(visible, "depoimento");
  const facts = itemsOfKind(visible, "fato");
  const logos = itemsOfKind(visible, "logo");
  const title = socialProofTitle(visible);
  const isDefaultTitle = testimonials.every((t) => !t.real);

  return (
    <LandingSection
      id={LANDING_ANCHORS.socialProof}
      title={title}
      subtitle={
        isDefaultTitle ? "Da primeira mensagem da manhã ao último áudio da noite, a IA e a equipe trabalham juntas." : undefined
      }
      tone="raised"
    >
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

        <div>
          <DayTimeline moments={moments} />
          <p className="mt-6 text-caption text-text-muted">Cenas de exemplo.</p>
        </div>

        {facts.length > 0 && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border pt-6 sm:grid-cols-2 lg:grid-cols-4">
            {facts.map((f) => (
              <div key={f.id}>
                <dt className="font-display text-lg font-bold text-text-primary">{f.title}</dt>
                <dd className="mt-1 text-sm text-text-secondary">{f.text}</dd>
              </div>
            ))}
          </dl>
        )}

        {logos.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-text-secondary">Quem usa</h3>
            <ul className={cn("mt-3 flex flex-wrap items-center gap-6")}>
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
