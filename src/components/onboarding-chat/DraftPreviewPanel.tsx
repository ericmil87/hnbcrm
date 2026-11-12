import { useId } from "react";
import { Check, Circle } from "lucide-react";
import type { OnboardingDraft } from "../../../convex/lib/onboardingDraft";
import { buildBlock, type BlockRequest } from "../../../convex/lib/onboardingBlocks";
import type { ProgressView } from "@/lib/onboardingChat";
import { cn } from "@/lib/utils";
import { NextStepBar, type NextStepBarProps } from "./NextStepBar";
import { OnboardingBlockView } from "./blocks/registry";
import type { BlockContext } from "./blocks/types";

export interface DraftPreviewPanelProps {
  /** Rascunho gravado (`onboardingSessions.getSession().draft`); null = ainda sem rascunho. */
  draft: OnboardingDraft | null;
  /** Contexto da conversa (org, sessão, fatos vivos) para "Ajustar" e os selos; sem ele a prévia é só de leitura. */
  ctx?: Omit<BlockContext, "isLatest" | "compact">;
  /** As 6 etapas (checklist no topo). */
  progress?: ProgressView;
  /** O botão do próximo passo, fixo no rodapé do painel. */
  nextStep?: NextStepBarProps;
  /** Dentro da folha do celular (o título vira só para leitor de tela: a folha já tem o dela). */
  inSheet?: boolean;
}

/** Os cartões da prévia, na ordem da conversa (cada um só aparece se há dado). */
const PREVIEW_KINDS: BlockRequest["kind"][] = [
  "resumoNegocio",
  "funilPreview",
  "personaCard",
  "conhecimentoLista",
  "respostasRapidas",
  "traducaoCartao",
];

const NO_CTX: Omit<BlockContext, "isLatest" | "compact"> = {
  organizationId: null,
  sessionId: null,
  sendText: () => {},
  sendEvent: () => {},
  busy: false,
};

/** Checklist das 6 etapas: o que já foi, onde está e o que falta. */
export function ProgressChecklist({ progress }: { progress: ProgressView }) {
  return (
    <ol aria-label="Etapas da configuração" className="space-y-1">
      {progress.steps.map((s) => (
        <li
          key={s.id}
          aria-current={s.state === "current" ? "step" : undefined}
          className={cn(
            "flex items-center gap-2 text-sm",
            s.state === "current" ? "font-semibold text-text-primary" : s.state === "done" ? "text-text-secondary" : "text-text-muted"
          )}
        >
          {s.state === "done" ? (
            <Check className="size-4 shrink-0 text-semantic-success" aria-hidden="true" />
          ) : (
            <Circle className={cn("size-4 shrink-0", s.state === "current" && "text-brand-600")} aria-hidden="true" />
          )}
          <span>{s.label}</span>
          <span className="sr-only">{s.state === "done" ? " (feito)" : s.state === "current" ? " (etapa atual)" : " (a fazer)"}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Prévia viva da operação (desktop à direita; no celular, numa folha aberta
 * pelo botão "Sua operação"): checklist das 6 etapas no topo, os MESMOS cartões
 * da conversa em modo compacto (cada um com o selo "Aprovado"/"Falta conferir"
 * e o seu "Ajustar") e, no rodapé fixo, o botão do próximo passo. Todo texto do
 * rascunho é renderizado como texto puro.
 */
export function DraftPreviewPanel({ draft, ctx = NO_CTX, progress, nextStep, inSheet = false }: DraftPreviewPanelProps) {
  const titleId = useId();
  const approvals = ctx.facts?.approvals;
  const blocks = draft
    ? PREVIEW_KINDS.map((kind) =>
        buildBlock(
          { kind },
          { draft, draftHash: null, draftVersion: 0, appliedDraftHash: null, emailVerified: true, aiActive: false, ...(approvals ? { approvals } : {}) }
        )
      ).filter((b): b is NonNullable<typeof b> => b !== null)
    : [];
  const blockCtx: BlockContext = { ...ctx, isLatest: true, compact: true };
  return (
    <aside aria-labelledby={titleId} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <div>
          <h2 id={titleId} className={cn("text-base font-semibold text-text-primary", inSheet && "sr-only")}>
            Sua operação
          </h2>
          <p className="text-caption text-text-muted">Atualiza enquanto você conversa. Nada é criado antes do seu clique.</p>
        </div>
        {progress && <ProgressChecklist progress={progress} />}
        {!draft ? (
          <p className="rounded-card border border-dashed border-border p-4 text-sm text-text-muted">
            Conte sobre o seu negócio e a prévia aparece aqui: funil, atendente e o que ele sabe.
          </p>
        ) : (
          blocks.map((b) => <OnboardingBlockView key={b.kind} block={b} ctx={blockCtx} />)
        )}
      </div>
      {nextStep && (
        <div className="sticky bottom-0 shrink-0 border-t border-border-subtle bg-surface-sunken pb-safe">
          <NextStepBar {...nextStep} />
        </div>
      )}
    </aside>
  );
}
