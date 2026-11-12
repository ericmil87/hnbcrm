import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AlertTriangle, CheckCircle2, Hammer, ShieldCheck } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { ApplyResult } from "../../../../convex/lib/onboardingApply";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import { Button } from "@/components/ui/Button";
import { mutationErrorMessage } from "@/lib/errors";
import { applyBlockedReason, describeApplyResult } from "@/lib/onboardingApplyView";
import { liveBlockContext, useDraftEditor } from "../useDraftEditor";
import { BlockCard } from "./BlockCard";
import type { BlockOf, BlockProps } from "./types";

export type ApplyAttempt = { ok: true; result: ApplyResult } | { ok: false; message: string };

export interface AplicarOperacaoViewProps {
  state: Pick<BlockOf<"aplicarOperacao">, "canApply" | "blockedCount" | "flaggedCount" | "aiActive" | "alreadyApplied">;
  note?: string;
  compact?: boolean;
  /** Chamado SÓ por clique da pessoa. `overwrite` só vira `true` depois da confirmação. */
  onApply: (overwrite: boolean) => Promise<ApplyAttempt>;
  /** "Dar o aceite de IA": leva ao bloco de aceite (nunca aceita sozinho). */
  onAskAccept?: () => void;
  acceptDisabled?: boolean;
  /** Motivo de o botão estar travado (ex.: mensagem que não é a mais recente). */
  lockedReason?: string | null;
  /** O rascunho gravado agora difere do que esta mensagem trazia. */
  changedSinceMessage?: boolean;
}

function ResultList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-caption font-medium text-text-secondary">{title}</p>
      <ul className="mt-0.5 list-inside list-disc text-text-primary">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `aplicarOperacao`: "Montar minha operação" (clique explícito). Desabilitado
 * com explicação se há nome bloqueado; mostra o que fica de fora; atendente
 * que já existia só é sobrescrito depois de uma confirmação clara.
 */
export function AplicarOperacaoView({
  state,
  note,
  compact,
  onApply,
  onAskAccept,
  acceptDisabled,
  lockedReason = null,
  changedSinceMessage = false,
}: AplicarOperacaoViewProps) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const blockedReason = applyBlockedReason(state);
  const view = result ? describeApplyResult(result) : null;

  const run = async (overwrite: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const attempt = await onApply(overwrite);
      if (attempt.ok && overwrite && attempt.result.alreadyApplied) {
        // Pediu a troca e o servidor respondeu "já montado": nada foi sobrescrito.
        setError("Não foi possível sobrescrever o atendente que já existe. Ele continua como estava; tente de novo.");
      } else if (attempt.ok) {
        setResult(attempt.result);
        setConfirming(false);
      } else {
        setError(attempt.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const applied = Boolean(view) || state.alreadyApplied;
  const waitingAccept = (view?.needsConsent ?? false) || (view?.waitingConsent.length ?? 0) > 0 || (!state.aiActive && applied);

  return (
    <BlockCard title="Montar minha operação" icon={Hammer} note={compact || applied ? undefined : note}>
      {!applied && (
        <p className="text-text-secondary">
          Só depois do seu clique eu crio o funil, os campos, as respostas rápidas e o atendente. Nada acontece antes.
        </p>
      )}
      {state.flaggedCount > 0 && !applied && (
        <p className="mt-2 flex items-start gap-1.5 rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-semantic-warning" aria-hidden="true" />
          <span>
            <span className="tabular-nums">{state.flaggedCount}</span>{" "}
            {state.flaggedCount === 1 ? "item marcado fica de fora" : "itens marcados ficam de fora"}. Use mesmo assim nos cartões acima
            para incluir.
          </span>
        </p>
      )}
      {changedSinceMessage && !applied && (
        <p role="status" className="mt-2 text-caption text-text-secondary">
          O rascunho mudou desde esta mensagem. Os cartões acima mostram a versão mais nova.
        </p>
      )}
      {lockedReason && !applied && (
        <p role="status" className="mt-2 text-caption text-text-secondary">
          {lockedReason}
        </p>
      )}
      {blockedReason && (
        <p role="status" className="mt-2 flex items-start gap-1.5 rounded-field bg-semantic-error/10 px-2 py-1.5 text-caption text-text-primary">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-semantic-error" aria-hidden="true" />
          {blockedReason}
        </p>
      )}

      {view && (
        <div className="mt-2 space-y-2 rounded-field bg-surface-sunken p-2" role="status" aria-label="Resultado">
          <p className="flex items-center gap-1.5 font-medium text-text-primary">
            <CheckCircle2 className="size-4 text-semantic-success" aria-hidden="true" />
            {view.alreadyApplied ? "Esta versão já estava montada." : "Operação montada."}
          </p>
          <ResultList title="O que foi criado" items={view.created} />
          <ResultList title="Já ligado" items={view.featuresOn} />
          {view.attendantNote && <p className="text-text-secondary">{view.attendantNote}</p>}
          {(view.needsConsent || view.waitingConsent.length > 0) && (
            <div className="space-y-1.5">
              <p className="text-text-primary">
                {view.needsConsent ? "O atendente só nasce depois do aceite de IA." : "Espera o aceite de IA:"}{" "}
                {view.waitingConsent.length > 0 && view.waitingConsent.join(", ") + "."}
              </p>
            </div>
          )}
          <ResultList
            title="Liga quando você conectar o WhatsApp"
            items={view.waitingChannel}
          />
          <ResultList title="Ficou de fora (marcado para revisão)" items={view.leftOut} />
          {view.keptExistingAttendant && (
            <div className="space-y-1.5 rounded-field border border-semantic-warning/40 p-2">
              <p className="text-text-primary">
                Você já tinha um atendente, e eu mantive o dele. O jeito de atender e o conhecimento deste rascunho não foram aplicados.
              </p>
              {confirming ? (
                <div className="space-y-2">
                  <p className="font-medium text-text-primary">
                    Sobrescrever troca o jeito de atender e o conhecimento do atendente atual pelos deste rascunho. O texto anterior fica
                    guardado no histórico de alterações.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="danger" loading={busy} onClick={() => void run(true)}>
                      Sim, sobrescrever
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                      Manter o atual
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
                  Sobrescrever o atendente que já existe
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {!view && state.alreadyApplied && (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-text-primary">
          <CheckCircle2 className="size-4 text-semantic-success" aria-hidden="true" />
          Esta versão do rascunho já foi montada. Se ajustar algo, dá para montar de novo.
        </p>
      )}

      {waitingAccept && onAskAccept && (
        <div className="mt-2">
          <Button size="sm" variant="secondary" disabled={acceptDisabled} onClick={onAskAccept}>
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Ir para o aceite de IA
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-caption text-semantic-error">
          {error}
        </p>
      )}

      {!state.alreadyApplied && !view && (
        <div className="mt-2">
          <Button loading={busy} disabled={busy || blockedReason !== null || lockedReason !== null} onClick={() => void run(false)}>
            Montar minha operação
          </Button>
        </div>
      )}
      {view && !compact && state.blockedCount === 0 && (
        <p className="mt-2 text-caption text-text-muted">Tudo isso pode ser mudado depois em Configurações.</p>
      )}
    </BlockCard>
  );
}

export function AplicarOperacaoBlock({ block, ctx }: BlockProps<"aplicarOperacao">) {
  const organizationId = ctx.organizationId as Id<"organizations"> | null;
  const ed = useDraftEditor(ctx);
  const aiStatus = useQuery(api.aiSettings.getAiStatus, organizationId ? { organizationId } : "skip");
  const apply = useMutation(api.onboardingSessions.applyOnboardingDraft);
  const aiActive = aiStatus?.active ?? block.aiActive;
  const live = ed.draft
    ? (buildBlock({ kind: "aplicarOperacao" }, liveBlockContext(ed, aiActive)) as BlockOf<"aplicarOperacao"> | null)
    : null;
  const state = live ?? block;

  const onApply = async (overwrite: boolean): Promise<ApplyAttempt> => {
    if (!organizationId || !ctx.sessionId) return { ok: false, message: "A conversa ainda não está pronta. Tente em instantes." };
    try {
      const result = await apply({
        organizationId,
        sessionId: ctx.sessionId as Id<"onboardingSessions">,
        expectedDraftHash: state.draftHash,
        ...(overwrite ? { overwriteExistingAttendant: true } : {}),
      });
      return { ok: true, result: result as ApplyResult };
    } catch (e) {
      const message = mutationErrorMessage(e, "Não foi possível montar a operação.");
      return { ok: false, message };
    }
  };

  return (
    <AplicarOperacaoView
      state={{ ...state, aiActive }}
      note={block.note}
      compact={ctx.compact}
      onApply={onApply}
      onAskAccept={() => ctx.sendText("Quero dar o aceite de IA para ligar o atendente.")}
      acceptDisabled={ctx.busy}
      lockedReason={ctx.isLatest ? null : "Esta é uma mensagem antiga. Use o botão da mensagem mais recente."}
      changedSinceMessage={ed.hash !== null && ed.hash !== block.draftHash}
    />
  );
}
