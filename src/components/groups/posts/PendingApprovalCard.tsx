/**
 * Texto gerado pela IA esperando decisão humana. A contagem regressiva é o
 * ponto: passado o `dueAt` sem aprovação, o worker aplica o que a publicação
 * configurou (pular o horário ou publicar assim mesmo), e quem está olhando a
 * tela precisa saber qual dos dois vai acontecer.
 */
import { useEffect, useState } from "react";
import { Bot, Check, Clock, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { WhatsAppPreview } from "@/components/campaigns/WhatsAppPreview";
import { countdown, formatDateTime, previewVars } from "./postUtils";
import type { GroupPostDetailDoc } from "./types";

const TEXTAREA_CLASS =
  "w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2.5 text-base md:text-sm text-text-primary focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

interface PendingApprovalCardProps {
  post: GroupPostDetailDoc;
  canManage: boolean;
  busy: boolean;
  onApprove: (editedText?: string) => void;
  onReject: (reason?: string) => void;
}

export function PendingApprovalCard({ post, canManage, busy, onApprove, onReject }: PendingApprovalCardProps) {
  const pending = post.pending;
  const [text, setText] = useState(pending?.text ?? "");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setText(pending?.text ?? "");
  }, [pending?.slotKey, pending?.text]);

  if (!pending || pending.status !== "pendingApproval") return null;

  const edited = text.trim() !== pending.text.trim();
  const late = now >= pending.dueAt;
  /** Além de 1 h (o `SLOT_GRACE_MS` do worker) o slot é PULADO, não publicado. */
  const veryLate = now - pending.dueAt > 60 * 60 * 1000;
  const onMissed = post.content.ai?.onMissedApproval ?? "skip";
  const firstGroup = post.targets[0]?.subject ?? "Seu grupo";
  const vars = previewVars(firstGroup, pending.dueAt, post.schedule.timezone);

  return (
    <section className="rounded-card border border-semantic-warning/50 bg-semantic-warning/5 p-3.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Bot size={16} className="text-semantic-warning" />
        <h3 className="text-sm font-semibold text-text-primary">Texto aguardando aprovação</h3>
        <Badge variant="warning">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock size={10} />
            {late ? "prazo vencido" : countdown(pending.dueAt, now)}
          </span>
        </Badge>
      </div>

      <p className="mb-2 text-xs text-text-muted">
        Publica em {formatDateTime(pending.dueAt, post.schedule.timezone)} ·{" "}
        {late
          ? onMissed === "send"
            ? // Passada 1 h do horário, o worker PULA o slot em vez de publicar
              // fora de hora (SLOT_GRACE). Prometer "publica no próximo tique"
              // era mentira justo quando a pessoa está decidindo se aprova.
              veryLate
              ? "o prazo passou de 1 h: este horário será pulado — aprove para usar o texto no próximo horário"
              : "o prazo passou: o worker ainda publica este texto se o tique chegar em até 1 h do horário"
            : "o prazo passou: este horário será pulado"
          : onMissed === "send"
            ? "sem aprovação até lá, publica mesmo assim"
            : "sem aprovação até lá, o horário é pulado"}
        {pending.model ? ` · ${pending.model}` : ""}
        {pending.provider ? ` (${pending.provider})` : ""}
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <textarea
          rows={8}
          className={TEXTAREA_CLASS}
          value={text}
          disabled={!canManage || busy}
          onChange={(e) => setText(e.target.value)}
        />
        <WhatsAppPreview text={text} vars={vars} compact showMeta />
      </div>

      {canManage ? (
        <div className="mt-3 space-y-2">
          {rejecting ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                placeholder="Motivo (opcional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface-raised px-3 text-sm text-text-primary"
              />
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => {
                  onReject(reason.trim() || undefined);
                  setRejecting(false);
                  setReason("");
                }}
              >
                Confirmar rejeição
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRejecting(false)}>
                Cancelar
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={busy || text.trim().length === 0}
                onClick={() => onApprove(edited ? text.trim() : undefined)}
              >
                <Check size={15} />
                {edited ? "Aprovar com a edição" : "Aprovar"}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRejecting(true)}>
                <X size={15} />
                Rejeitar
              </Button>
              {edited && (
                <span className="text-[11px] text-text-muted">
                  O texto editado substitui o da IA neste horário.
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-text-muted">
          Você não tem permissão para aprovar. Peça a quem gerencia campanhas.
        </p>
      )}
    </section>
  );
}
