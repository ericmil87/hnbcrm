import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface FunnelRailStage {
  id: string;
  title: string;
}

export interface FunnelRailCard {
  id: string;
  title: string;
  subtitle?: string;
  stageId: string;
}

export interface FunnelRailMovingCard {
  title: string;
  subtitle?: string;
  /** Etapa atual; trocar o valor faz o cartão deslizar até a nova etapa. */
  stageId: string;
  /** `false` esconde o cartão com um fade (o lead ainda não chegou). Padrão: `true`. */
  visible?: boolean;
}

export type FunnelRailOrientation = "horizontal" | "vertical" | "responsive";

export interface FunnelRailProps {
  stages: readonly FunnelRailStage[];
  /** Cartões parados. Só aparecem na vertical (na faixa horizontal não há espaço). */
  cards?: readonly FunnelRailCard[];
  /** Cartão em destaque que desliza de etapa em etapa. */
  moving?: FunnelRailMovingCard | null;
  /** Acende um anel, uma vez, na etapa em que o cartão chega. */
  highlight?: boolean;
  /**
   * `horizontal`: faixa fina de etapas lado a lado. `vertical`: etapas
   * empilhadas, dividindo por igual a altura que o pai der. `responsive`
   * (padrão): faixa horizontal no celular, vertical a partir de `md`.
   */
  orientation?: FunnelRailOrientation;
  /** Nome acessível. Padrão: "Funil". */
  label?: string;
  className?: string;
}

// Classes literais por orientação. `--rail-n` = nº de etapas, `--rail-i` = etapa do cartão.
const TRACK: Record<FunnelRailOrientation, string> = {
  horizontal: "grid-cols-[repeat(var(--rail-n),minmax(0,1fr))]",
  vertical: "h-full grid-rows-[repeat(var(--rail-n),minmax(0,1fr))]",
  responsive:
    "grid-cols-[repeat(var(--rail-n),minmax(0,1fr))] md:h-full md:grid-cols-1 md:grid-rows-[repeat(var(--rail-n),minmax(0,1fr))]",
};

const SLIDER: Record<FunnelRailOrientation, string> = {
  horizontal: "h-full w-[calc(100%/var(--rail-n))] translate-x-[calc(var(--rail-i)*100%)]",
  vertical: "h-[calc(100%/var(--rail-n))] w-full translate-y-[calc(var(--rail-i)*100%)]",
  responsive:
    "h-full w-[calc(100%/var(--rail-n))] translate-x-[calc(var(--rail-i)*100%)] md:h-[calc(100%/var(--rail-n))] md:w-full md:translate-x-0 md:translate-y-[calc(var(--rail-i)*100%)]",
};

const VERTICAL_ONLY: Record<FunnelRailOrientation, string> = {
  horizontal: "hidden",
  vertical: "",
  responsive: "hidden md:block",
};

const HORIZONTAL_ONLY: Record<FunnelRailOrientation, string> = {
  horizontal: "",
  vertical: "hidden",
  responsive: "md:hidden",
};

// O contador soma os cartões parados só onde eles aparecem.
const COUNT_WITH_CARDS: Record<FunnelRailOrientation, string> = {
  horizontal: "hidden",
  vertical: "",
  responsive: "hidden md:inline",
};

function CardBody({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <span className="block truncate text-caption font-semibold leading-tight text-text-primary">{title}</span>
      {subtitle && <span className="block truncate text-caption leading-tight text-text-muted">{subtitle}</span>}
    </>
  );
}

/**
 * Trilho de etapas do Funil para cenas, de altura fixa: cada etapa tem um
 * encaixe reservado e o cartão em destaque desliza de um encaixe ao outro
 * (um cartão absoluto sobre o trilho, movido só com `transform`, sem medir o
 * DOM). O contador de cada etapa acompanha. Com movimento reduzido o cartão
 * aparece parado na etapa atual, sem anel.
 */
export function FunnelRail({
  stages,
  cards = [],
  moving,
  highlight = false,
  orientation = "responsive",
  label = "Funil",
  className,
}: FunnelRailProps) {
  const count = Math.max(1, stages.length);
  const movingIndex = moving ? Math.max(0, stages.findIndex((s) => s.id === moving.stageId)) : 0;
  const movingStage = moving ? stages[movingIndex] : undefined;
  const shown = Boolean(moving) && moving?.visible !== false;
  const vars = { "--rail-n": count, "--rail-i": movingIndex } as CSSProperties;

  return (
    <div
      role="group"
      aria-label={label}
      data-funnel-rail={orientation}
      data-stage={shown ? movingStage?.id : undefined}
      className={cn("relative", className)}
      style={vars}
    >
      <div className={cn("grid", TRACK[orientation])}>
        {stages.map((stage, si) => {
          const stageCards = cards.filter((c) => c.stageId === stage.id);
          const own = shown && movingIndex === si ? 1 : 0;
          return (
            <div key={stage.id} data-rail-stage={stage.id} className="relative min-w-0 p-1">
              <div className="h-full rounded-card bg-surface-sunken p-2">
                <p className="flex h-6 items-center justify-between gap-1 text-caption font-semibold text-text-secondary">
                  <span className="truncate">{stage.title}</span>
                  <span className="tabular-nums text-text-muted">
                    <span className={HORIZONTAL_ONLY[orientation]}>{own}</span>
                    <span className={COUNT_WITH_CARDS[orientation]}>
                      {stageCards.length + own}
                    </span>
                  </span>
                </p>
                {/* Encaixe reservado do cartão em destaque. */}
                <div aria-hidden="true" className="mt-1 h-11 rounded-field border border-dashed border-border" />
                {stageCards.length > 0 && (
                  <ul className={cn("mt-1.5 space-y-1.5", VERTICAL_ONLY[orientation])}>
                    {stageCards.map((card) => (
                      <li
                        key={card.id}
                        className="flex h-11 flex-col justify-center rounded-field border border-border-subtle bg-surface-raised px-2 shadow-card"
                      >
                        <CardBody title={card.title} subtitle={card.subtitle} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {highlight && own === 1 && (
                <span
                  key={`flash:${stage.id}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-1 rounded-card opacity-0 ring-2 ring-brand-500 motion-safe:animate-stage-flash motion-safe:[animation-delay:350ms]"
                />
              )}
            </div>
          );
        })}
      </div>
      {moving && movingStage && (
        <div
          data-rail-card=""
          className={cn(
            "pointer-events-none absolute left-0 top-0 p-1",
            "motion-safe:transition-transform motion-safe:delay-200 motion-safe:duration-700 motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)]",
            SLIDER[orientation]
          )}
        >
          {/* Mesma moldura da etapa: 0.5rem de respiro + título (1.5rem) + 0.25rem até o encaixe. */}
          <div className="px-2 pt-9">
            <div
              className={cn(
                "flex h-11 flex-col justify-center rounded-field border border-brand-500 bg-surface-raised px-2 shadow-elevated",
                "motion-safe:transition-[opacity,transform] motion-safe:duration-200 motion-safe:ease-out",
                shown ? "scale-100 opacity-100" : "scale-95 opacity-0"
              )}
            >
              <CardBody title={moving.title} subtitle={moving.subtitle} />
              <span className="sr-only">, na etapa {movingStage.title}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
