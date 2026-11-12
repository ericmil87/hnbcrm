import type { OnboardingDraft } from "../../../convex/lib/onboardingDraft";
import { buildBlock, type BlockRequest } from "../../../convex/lib/onboardingBlocks";
import { OnboardingBlockView } from "./blocks/registry";
import type { BlockContext } from "./blocks/types";

export interface DraftPreviewPanelProps {
  /** Rascunho gravado (`onboardingSessions.getSession().draft`); null = ainda sem rascunho. */
  draft: OnboardingDraft | null;
  /** Contexto da conversa (org e sessão) para "Ajustar" nos cartões; sem ele a prévia é só de leitura. */
  ctx?: Omit<BlockContext, "isLatest" | "compact">;
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
  busy: false,
};

/**
 * Prévia viva da operação (desktop, à direita da conversa): os MESMOS cartões
 * da conversa, em modo compacto, montados do rascunho gravado (`buildBlock`,
 * a mesma regra do servidor). Cada cartão tem o seu "Ajustar". Todo texto do
 * rascunho é renderizado como texto puro.
 */
export function DraftPreviewPanel({ draft, ctx = NO_CTX }: DraftPreviewPanelProps) {
  const blocks = draft
    ? PREVIEW_KINDS.map((kind) =>
        buildBlock(
          { kind },
          { draft, draftHash: null, draftVersion: 0, appliedDraftHash: null, emailVerified: true, aiActive: false }
        )
      ).filter((b): b is NonNullable<typeof b> => b !== null)
    : [];
  const blockCtx: BlockContext = { ...ctx, isLatest: true, compact: true };
  return (
    <aside aria-labelledby="previa-operacao-titulo" className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div>
        <h2 id="previa-operacao-titulo" className="text-base font-semibold text-text-primary">
          Sua operação
        </h2>
        <p className="text-caption text-text-muted">Atualiza enquanto você conversa. Nada é criado antes do seu clique.</p>
      </div>
      {!draft ? (
        <p className="rounded-card border border-dashed border-border p-4 text-sm text-text-muted">
          Conte sobre o seu negócio e a prévia aparece aqui: funil, atendente e o que ele sabe.
        </p>
      ) : (
        blocks.map((b) => <OnboardingBlockView key={b.kind} block={b} ctx={blockCtx} />)
      )}
    </aside>
  );
}
