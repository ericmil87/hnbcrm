import { Bot, CalendarCheck, CheckCheck, MessageSquare, TriangleAlert, UserX } from "lucide-react";
import { OriginMark as AppointmentOriginBadge } from "./OriginMark";
import { AppointmentStatusChip } from "@/components/agenda/AppointmentStatusChip";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { fillVocab } from "@/lib/agendaCopy";
import {
  pendingRowInfo,
  proposalExpired,
  visibleSections,
  type PendingCapped,
  type PendingSectionKey,
} from "@/lib/agendaPending";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { zonedWhenPhrase } from "@/lib/agendaZone";
import { VOCAB } from "@/lib/vocab";
import type { GridAppointment } from "@/lib/agendaGrid";
import type { SchedAppointmentView } from "@/lib/agendaTypes";
import { conflictKindText, mustResolveBeforeApprove } from "@/lib/agendaConflict";

const t = VIEWS_COPY.pendingQueue;

export type PendingAppointment = GridAppointment & Partial<Pick<SchedAppointmentView, "serviceId" | "variantKey" | "contactId" | "leadId">>;

export interface PendingConflict {
  _id: string;
  appointment: PendingAppointment | null;
  kind?: string;
  /** Recurso que saiu (fechado, removido ou sem vaga). */
  resourceId?: string;
  /** Sala e profissional que saíram, quando são mais de um. */
  resourceIds?: readonly string[];
  /** Horários alternativos do servidor (até 3). */
  suggestions?: ReadonlyArray<{ startTime: number; resourceIds: readonly string[] }>;
}

export interface PendingSuggestion {
  _id: string;
  conversationId: string;
  act: string;
  parsed: { localDate?: string; timeMin?: number };
  createdAt: number;
}

export interface PendingData {
  approvals: readonly PendingAppointment[];
  conflicts: readonly PendingConflict[];
  noOutcome: readonly PendingAppointment[];
  suggestions: readonly PendingSuggestion[];
  capped: PendingCapped;
}

export interface PendingQueueViewProps {
  /** `undefined` enquanto carrega. */
  data: PendingData | undefined;
  tz: string;
  now: number;
  /** `agenda:edit`: sem ele só leitura (abrir). */
  canEdit: boolean;
  /** Id de quem está com ação em andamento (desabilita os botões da linha). */
  busyId: string | null;
  onOpen: (appointmentId: string) => void;
  onApprove: (appointmentId: string) => void;
  onDecline: (appointmentId: string) => void;
  /** "Marcar de novo" (proposta vencida): abre o fluxo de marcar para o mesmo cliente e serviço. */
  onRebook: (appointment: PendingAppointment) => void;
  onOutcome: (appointmentId: string, outcome: "attended" | "noShow") => void;
  onResolve: (conflictId: string, appointmentId: string | null) => void;
  onOpenConversation: (conversationId: string) => void;
}

function Row({ appointment, tz, children, onOpen, note, expired = false }: { appointment: PendingAppointment; tz: string; children?: React.ReactNode; onOpen: () => void; note?: string; expired?: boolean }) {
  const info = pendingRowInfo(appointment, tz);
  return (
    <li className="rounded-card border border-border-subtle bg-surface-raised p-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-11 w-full flex-col items-start gap-0.5 rounded-field text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        aria-label={`${t.open}: ${info.who}, ${info.when}`}
      >
        <span className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{info.who}</span>
          {expired && <AppointmentStatusChip status={appointment.status} expired />}
          <AppointmentOriginBadge origin={appointment.origin} />
        </span>
        <span className="text-caption tabular-nums text-text-secondary">{info.when}</span>
        <span className="text-caption text-text-secondary">
          {info.service}
          {info.place ? ` · ${info.place}` : ""}
        </span>
        {note && <span className="text-caption font-medium text-semantic-warning">{note}</span>}
      </button>
      {children && <div className="mt-2 flex flex-wrap gap-2">{children}</div>}
    </li>
  );
}

const SECTION_ICON = { approvals: Bot, conflicts: TriangleAlert, noOutcome: CalendarCheck, suggestions: MessageSquare } as const;

/**
 * Fila de pendências: Aguardando aprovação (Aprovar, Recusar), Sem lugar (Resolver), Sem desfecho (Atendido,
 * Faltou) e Sugestões (só se vier algo). Seção cortada pelo servidor avisa; vazio é mensagem positiva.
 * Apresentacional: o contêiner (`PendingQueuePanel`) faz as mutations e o "Desfazer" do toast.
 */
export function PendingQueueView(p: PendingQueueViewProps) {
  if (!p.data) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size="md" />
      </div>
    );
  }
  const { data } = p;
  const counts = { approvals: data.approvals.length, conflicts: data.conflicts.length, noOutcome: data.noOutcome.length, suggestions: data.suggestions.length };
  const sections = visibleSections(counts, data.capped);
  if (sections.length === 0) {
    return <EmptyState icon={CheckCheck} size="sm" title={VOCAB.scheduling.empty.pending.title} description={VOCAB.scheduling.empty.pending.hint} />;
  }

  const render = (key: PendingSectionKey) => {
    switch (key) {
      case "approvals":
        return data.approvals.map((a) => {
          const expired = proposalExpired(a.status, a.startTime, p.now, a.needsAttention?.code);
          const busy = p.busyId === a._id;
          return (
            <Row key={`approval:${a._id}`} appointment={a} tz={p.tz} expired={expired} onOpen={() => p.onOpen(a._id)}>
              {p.canEdit && (
                <>
                  {!expired && !mustResolveBeforeApprove(a) && (
                    <Button size="sm" loading={busy} onClick={() => p.onApprove(a._id)}>
                      {t.approve}
                    </Button>
                  )}
                  {expired && <p className="basis-full text-caption text-text-secondary">{t.expired}</p>}
                  {!expired && mustResolveBeforeApprove(a) && <p className="self-center text-caption text-semantic-warning">{VIEWS_COPY.conflict.needsFirst}</p>}
                  <Button size="sm" variant={expired ? "primary" : "secondary"} disabled={busy} onClick={() => p.onDecline(a._id)}>
                    {expired ? t.declineProposal : t.decline}
                  </Button>
                  {expired && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => p.onRebook(a)}>
                      {t.rebook}
                    </Button>
                  )}
                </>
              )}
            </Row>
          );
        });
      case "conflicts":
        return data.conflicts.map((c) =>
          c.appointment ? (
            <Row key={`conflict:${c._id}`} appointment={c.appointment} tz={p.tz} onOpen={() => p.onOpen(c.appointment!._id)} note={conflictKindText(c.kind)}>
              {p.canEdit && (
                <Button size="sm" onClick={() => p.onResolve(c._id, c.appointment!._id)}>
                  {t.resolve}
                </Button>
              )}
            </Row>
          ) : (
            <li key={`conflict:${c._id}`} className="flex items-center justify-between gap-2 rounded-card border border-border-subtle bg-surface-raised p-3">
              <span className="text-sm text-text-secondary">{t.noConflictAppt}</span>
            </li>
          )
        );
      case "noOutcome":
        return data.noOutcome.map((a) => {
          const busy = p.busyId === a._id;
          return (
            <Row key={`outcome:${a._id}`} appointment={a} tz={p.tz} onOpen={() => p.onOpen(a._id)}>
              {p.canEdit && (
                <>
                  <Button size="sm" loading={busy} onClick={() => p.onOutcome(a._id, "attended")}>
                    <CheckCheck size={16} aria-hidden="true" />
                    {t.attended}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => p.onOutcome(a._id, "noShow")}>
                    <UserX size={16} aria-hidden="true" />
                    {t.noShow}
                  </Button>
                </>
              )}
            </Row>
          );
        });
      case "suggestions":
        return data.suggestions.map((s) => (
          <li key={`suggestion:${s._id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border-subtle bg-surface-raised p-3">
            <span className="min-w-0 text-sm text-text-primary">
              {t.suggestionRow}
              <span className="block text-caption text-text-secondary">{zonedWhenPhrase(s.createdAt, p.tz)}</span>
            </span>
            <Button size="sm" variant="secondary" onClick={() => p.onOpenConversation(s.conversationId)}>
              {t.openConversation}
            </Button>
          </li>
        ));
    }
  };

  return (
    <div className="space-y-5">
      {sections.map((key) => {
        const Icon = SECTION_ICON[key];
        return (
          <section key={`section:${key}`} aria-labelledby={`pending-${key}`} className="space-y-2">
            <div>
              <h2 id={`pending-${key}`} className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <Icon size={16} className="text-text-muted" aria-hidden="true" />
                {t.sections[key]}
                <span className="rounded-full bg-surface-overlay px-2 text-xs font-medium tabular-nums text-text-secondary">
                  {counts[key]}
                  {data.capped[key] ? "+" : ""}
                </span>
              </h2>
              <p className="text-caption text-text-muted">{t.hints[key]}</p>
            </div>
            <ul className="space-y-2">{render(key)}</ul>
            {data.capped[key] && (
              <p role="status" className="text-caption text-text-secondary">
                {fillVocab(t.capped, { n: counts[key] })}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

