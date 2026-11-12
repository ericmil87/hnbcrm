import { Badge } from "@/components/ui/Badge";
import { SceneLoop } from "@/components/landing/kit";
import { leadPositions, sceneLeads, sceneSteps } from "@/lib/onboardingFunnelScene";
import { plainModelText } from "@/lib/onboardingChat";
import { cn } from "@/lib/utils";

const ROW_PX = 52;
const ROW_GAP_PX = 6;

const OUTCOME_CLASS: Record<string, string> = {
  won: "border-semantic-success/60 bg-semantic-success/10",
  lost: "border-semantic-error/40 bg-semantic-error/5",
  open: "border-border bg-surface-sunken",
};
const OUTCOME_LABEL: Record<string, string> = { won: "Ganho", lost: "Perdido" };

export interface FunnelAnimationProps {
  stages: ReadonlyArray<{ name: string; outcome: string }>;
  /** Leads fictícios (`block.examples`); ausentes (mensagem antiga) = padrão seguro. */
  examples?: unknown;
  /** Força o movimento reduzido (testes, vitrine). */
  reducedMotion?: boolean;
}

/**
 * Funil em trilho VERTICAL com todas as etapas legíveis (nome inteiro, sem
 * truncar, sem rolagem horizontal em 375 px) e leads de exemplo entrando e
 * andando de etapa em etapa. Selo "Exemplo" sempre visível, botão de pausar e
 * continuar, movimento reduzido = estado final parado.
 */
export function FunnelAnimation({ stages, examples, reducedMotion }: FunnelAnimationProps) {
  const rows = stages.slice(0, 12).map((s) => ({ name: plainModelText(s.name), outcome: s.outcome }));
  const n = rows.length;
  const leads = sceneLeads(examples, n);
  const steps = sceneSteps(n);
  if (n === 0) return null;
  const height = n * ROW_PX;
  const description = `Exemplo: leads fictícios andando pelas etapas do funil: ${rows.map((r) => r.name).join(", ")}.`;

  return (
    <SceneLoop
      steps={steps}
      loop={n > 1}
      label="Exemplo do funil"
      description={description}
      reducedMotion={reducedMotion}
      renderControl={false}
      header={(scene) => (
        <div className="mb-2 flex items-center justify-between gap-2">
          <Badge variant="info">Exemplo</Badge>
          {scene.control}
        </div>
      )}
    >
      {(scene) => {
        const positions = leadPositions(n, leads.length, scene.index);
        return (
          <div className="relative" style={{ height }}>
            <ol aria-label="Etapas do funil" className="absolute inset-0 m-0 list-none p-0">
              {rows.map((r, i) => (
                <li
                  key={`${i}:${r.name}`}
                  className={cn("flex items-center gap-2 rounded-field border px-2", OUTCOME_CLASS[r.outcome] ?? OUTCOME_CLASS.open)}
                  style={{ height: ROW_PX - ROW_GAP_PX, marginBottom: ROW_GAP_PX }}
                >
                  <span className="w-4 shrink-0 text-caption font-semibold tabular-nums text-text-muted">{i + 1}</span>
                  <span className="min-w-0 basis-[36%] break-words text-caption font-medium leading-tight text-text-primary">
                    {r.name}
                    {OUTCOME_LABEL[r.outcome] && <span className="block text-micro font-normal text-text-muted">{OUTCOME_LABEL[r.outcome]}</span>}
                  </span>
                </li>
              ))}
            </ol>
            <div key={`ciclo:${scene.cycle}`} aria-hidden="true" className="pointer-events-none absolute inset-0">
              {leads.map((lead, j) => (
                <div
                  key={`${j}:${lead.name}`}
                  data-example-lead=""
                  className={cn(
                    "absolute left-[46%] right-1.5 flex flex-col justify-center overflow-hidden rounded-field border border-brand-500 bg-surface-raised px-2 shadow-elevated",
                    "motion-safe:transition-[transform,opacity] motion-safe:duration-700 motion-safe:ease-out",
                    positions[j].visible ? "opacity-100" : "opacity-0"
                  )}
                  style={{
                    top: 4,
                    height: ROW_PX - ROW_GAP_PX - 8,
                    transform: `translateY(${positions[j].stage * ROW_PX}px)`,
                  }}
                >
                  <span className="block truncate text-caption font-semibold leading-tight text-text-primary">{plainModelText(lead.name)}</span>
                  <span className="block truncate text-caption leading-tight text-text-muted">{plainModelText(lead.note)}</span>
                </div>
              ))}
            </div>
          </div>
        );
      }}
    </SceneLoop>
  );
}
