import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { usePermissions } from "@/hooks/usePermissions";
import type { GroupChatDoc } from "@/components/inbox/types";

type Mode = "off" | "mention";
type ReplyMode = "inherit" | "suggest" | "autopilot";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "off", label: "Desligada", hint: "A IA não participa desta sala." },
  {
    id: "mention",
    label: "Quando mencionada",
    hint: "Responde só quando alguém @menciona o número ou responde a uma mensagem nossa.",
  },
];

const REPLY_MODES: { id: ReplyMode; label: string; hint: string }[] = [
  { id: "inherit", label: "Herdar do atendente", hint: "Usa o modo configurado em Configurações → IA." },
  { id: "suggest", label: "Sugestão", hint: "Escreve um rascunho para alguém revisar no inbox." },
  { id: "autopilot", label: "Autopilot", hint: "Envia direto, sem revisão humana." },
];

/**
 * Política da IA num grupo (D6).
 *
 * A F2 só GRAVA — quem lê é o agente de grupo da F4. Gravar antes é
 * deliberado: configurar 30 grupos de novo no dia em que a IA for ligada seria
 * o pior momento para pedir isso.
 */
export function GroupAiPolicyModal({
  open,
  group,
  onClose,
}: {
  open: boolean;
  group: GroupChatDoc;
  onClose: () => void;
}) {
  const setAiPolicy = useMutation(api.groupChats.setAiPolicy);
  const setGroupAutopilotAck = useMutation(api.aiSettings.setGroupAutopilotAck);
  const organizationId = group.organizationId as Id<"organizations">;
  const { can } = usePermissions(organizationId);
  const aiStatus = useQuery(api.aiSettings.getAiStatus, open ? { organizationId } : "skip");
  const [ackBusy, setAckBusy] = useState(false);
  const [mode, setMode] = useState<Mode>(group.ai?.mode ?? "off");
  const [replyMode, setReplyMode] = useState<ReplyMode>(group.ai?.replyMode ?? "inherit");
  const [maxPerHour, setMaxPerHour] = useState(
    group.ai?.maxPerHour != null ? String(group.ai.maxPerHour) : ""
  );
  const [maxPerDay, setMaxPerDay] = useState(
    group.ai?.maxPerDay != null ? String(group.ai.maxPerDay) : ""
  );
  const [extraInstructions, setExtraInstructions] = useState(group.ai?.extraInstructions ?? "");
  // F4 — gatilho por palavra, alerta sem LLM, radar e digest.
  const [keywords, setKeywords] = useState((group.ai?.keywords ?? []).join(", "));
  const [alertKeywords, setAlertKeywords] = useState((group.ai?.alertKeywords ?? []).join(", "));
  const [opportunityRadar, setOpportunityRadar] = useState(group.ai?.opportunityRadar === true);
  const [dailyDigestAt, setDailyDigestAt] = useState(group.ai?.dailyDigestAt ?? "");
  const [saving, setSaving] = useState(false);

  // Reabrir num grupo diferente tem de recarregar os campos. As dependências
  // param no `_id` de propósito: `group.ai` é um objeto novo a cada resposta da
  // query reativa, e depender dele apagaria o que a pessoa está digitando.
  useEffect(() => {
    if (!open) return;
    setMode(group.ai?.mode ?? "off");
    setReplyMode(group.ai?.replyMode ?? "inherit");
    setMaxPerHour(group.ai?.maxPerHour != null ? String(group.ai.maxPerHour) : "");
    setMaxPerDay(group.ai?.maxPerDay != null ? String(group.ai.maxPerDay) : "");
    setExtraInstructions(group.ai?.extraInstructions ?? "");
    setKeywords((group.ai?.keywords ?? []).join(", "));
    setAlertKeywords((group.ai?.alertKeywords ?? []).join(", "));
    setOpportunityRadar(group.ai?.opportunityRadar === true);
    setDailyDigestAt(group.ai?.dailyDigestAt ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group._id]);

  const parseCap = (value: string): number | undefined => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  // "orçamento, preço" → ["orçamento","preço"]. Lista vazia limpa o campo.
  const parseWords = (value: string): string[] =>
    value
      .split(",")
      .map((w) => w.trim())
      .filter((w) => w.length > 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      await setAiPolicy({
        groupChatId: group._id as Id<"groupChats">,
        mode,
        replyMode,
        maxPerHour: parseCap(maxPerHour),
        maxPerDay: parseCap(maxPerDay),
        extraInstructions: extraInstructions.trim() || undefined,
        keywords: parseWords(keywords),
        alertKeywords: parseWords(alertKeywords),
        opportunityRadar,
        dailyDigestAt: dailyDigestAt.trim() || undefined,
      });
      toast.success("Política de IA salva");
      onClose();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao salvar a política"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`IA no grupo '${group.subject}'`}>
      <div className="space-y-4">
        <p className="rounded-lg bg-surface-sunken p-2.5 text-xs text-text-muted leading-relaxed">
          Vale só para esta sala. Nada acontece enquanto a IA em grupos estiver
          desligada em Configurações → IA.
        </p>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-text-primary mb-1.5">Quando responder</legend>
          {MODES.map((m) => (
            <label
              key={m.id}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors",
                mode === m.id
                  ? "border-brand-500 bg-brand-500/5"
                  : "border-border hover:border-border-strong"
              )}
            >
              <input
                type="radio"
                name="group-ai-mode"
                checked={mode === m.id}
                onChange={() => setMode(m.id)}
                className="mt-0.5 h-4 w-4 accent-brand-600"
              />
              <span className="min-w-0">
                <span className="block text-sm text-text-primary">{m.label}</span>
                <span className="block text-xs text-text-muted">{m.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-1.5" disabled={mode === "off"}>
          <legend
            className={cn(
              "text-sm font-medium mb-1.5",
              mode === "off" ? "text-text-muted" : "text-text-primary"
            )}
          >
            Como responder
          </legend>
          {REPLY_MODES.map((r) => (
            <label
              key={r.id}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors",
                mode === "off"
                  ? "cursor-not-allowed border-border opacity-50"
                  : replyMode === r.id
                    ? "cursor-pointer border-brand-500 bg-brand-500/5"
                    : "cursor-pointer border-border hover:border-border-strong"
              )}
            >
              <input
                type="radio"
                name="group-ai-reply-mode"
                checked={replyMode === r.id}
                onChange={() => setReplyMode(r.id)}
                className="mt-0.5 h-4 w-4 accent-brand-600"
              />
              <span className="min-w-0">
                <span className="block text-sm text-text-primary">{r.label}</span>
                <span className="block text-xs text-text-muted">{r.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {/*
          Autopilot NA SALA exige aceite PRÓPRIO (`aiConfig.groupAutopilotAck`).
          O servidor recusa sem ele; sem este bloco a pessoa escolheria
          "Autopilot", clicaria em Salvar e levaria um erro seco.
        */}
        {replyMode === "autopilot" && mode !== "off" && aiStatus?.groupAutopilotAckDone === false && (
          <div className="space-y-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3">
            <p className="text-xs text-semantic-warning">
              No autopilot a IA publica direto na sala, sem ninguém revisar — para todos os
              participantes, inclusive gente que nunca falou com a empresa. O aceite vale para a
              organização inteira e fica registrado na auditoria.
            </p>
            <p className="text-[11px] text-text-muted">
              Com o atendente 1 a 1 já em autopilot esta sala salva sem o aceite — ele existe para
              quando o atendente está em sugestão e só a sala vai sozinha.
            </p>
            {can("settings", "manage") ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={ackBusy || saving}
                onClick={async () => {
                  setAckBusy(true);
                  try {
                    await setGroupAutopilotAck({ organizationId, accept: true, riskAck: true });
                    toast.success("Risco aceito — a IA pode publicar sozinha nas salas");
                    // Aceitar e SALVAR num clique: quem chegou aqui já escolheu
                    // "Autopilot" e clicar em Salvar de novo só serviria para
                    // deixar a sala em sugestão por esquecimento.
                    await handleSave();
                  } catch (error) {
                    toast.error(mutationErrorMessage(error, "Falha ao registrar o aceite"));
                  } finally {
                    setAckBusy(false);
                  }
                }}
              >
                Entendo o risco — ativar
              </Button>
            ) : (
              <p className="text-xs text-text-muted">
                Peça a um administrador para aceitar o risco em Configurações → IA.
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">Máx. por hora</span>
              <Input
                type="number"
                min={0}
                placeholder="10"
                value={maxPerHour}
                disabled={mode === "off"}
                onChange={(e) => setMaxPerHour(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">Máx. por dia</span>
              <Input
                type="number"
                min={0}
                placeholder="30"
                value={maxPerDay}
                disabled={mode === "off"}
                onChange={(e) => setMaxPerDay(e.target.value)}
              />
            </label>
          </div>
          {/*
            `0` desliga o TETO, não a IA — mesma semântica do editor do
            atendente 1:1. Sem a legenda, quem quer calar a IA digita 0 nos dois
            campos e libera resposta ilimitada num grupo de terceiros.
          */}
          <p className="text-[11px] text-text-muted">
            Vazio usa o padrão (10/hora e 30/dia). <strong>0 = sem limite</strong> — para calar a
            IA nesta sala, use o modo “Desligada” acima.
          </p>
          {(parseCap(maxPerHour) === 0 || parseCap(maxPerDay) === 0) && mode !== "off" && (
            <p className="rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 px-2.5 py-1.5 text-[11px] text-semantic-warning">
              Com 0 a IA responde sem teto nesta sala. Se a intenção é parar de responder, escolha
              “Desligada” no modo.
            </p>
          )}
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-text-muted">
            Instruções extras para esta sala (opcional, até 2000 caracteres)
          </span>
          <textarea
            rows={3}
            value={extraInstructions}
            disabled={mode === "off"}
            maxLength={2000}
            onChange={(e) => setExtraInstructions(e.target.value)}
            placeholder="Ex.: neste grupo só responda sobre horários de aula."
            className="w-full rounded-field border border-border-strong bg-surface-sunken px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:opacity-50"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-text-muted">
            Palavras que também chamam a IA (opcional, separadas por vírgula)
          </span>
          <Input
            placeholder="preço, horário, agendar"
            value={keywords}
            disabled={mode === "off"}
            onChange={(e) => setKeywords(e.target.value)}
          />
          <span className="mt-1 block text-[11px] text-text-muted">
            Sem isto a IA só responde quando alguém a menciona ou responde a uma
            mensagem nossa.
          </span>
        </label>

        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-sm font-medium text-text-primary">Monitoramento</p>

          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">
              Palavras que avisam a equipe (opcional, separadas por vírgula)
            </span>
            <Input
              placeholder="reclamação, cancelar, processo"
              value={alertKeywords}
              onChange={(e) => setAlertKeywords(e.target.value)}
            />
            <span className="mt-1 block text-[11px] text-text-muted">
              Gera uma notificação no sino. Não usa IA e não faz a IA responder.
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-2.5">
            <input
              type="checkbox"
              checked={opportunityRadar}
              onChange={(e) => setOpportunityRadar(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-brand-600"
            />
            <span className="min-w-0">
              <span className="block text-sm text-text-primary">Radar de oportunidade</span>
              <span className="block text-xs text-text-muted">
                A cada 15 minutos a IA lê as mensagens novas e avisa quando
                alguém demonstra intenção de compra. Ela nunca manda mensagem
                privada — quem decide é você.
              </span>
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">
              Resumo diário no sino (opcional, HH:MM)
            </span>
            <Input
              placeholder="18:00"
              value={dailyDigestAt}
              onChange={(e) => setDailyDigestAt(e.target.value)}
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            Salvar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
