import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowRightLeft,
  Building2,
  ChevronDown,
  CircleCheck,
  CircleX,
  Layers,
  Tag,
  Undo2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { OrgModules } from "@/hooks/useOrgModules";
import {
  CONTACT_KINDS,
  formatBRL,
  formatStayRange,
  hexAlpha,
  type ContactKind,
} from "./centralMeta";
import { AttributionStrip } from "./CentralChips";
import { TransferModal, type DepartmentOption } from "./TransferModal";
import { OutcomeModal, type OutcomeKind } from "./OutcomeModal";

interface PillSelectOption {
  value: string;
  label: string;
}

interface PillSelectProps {
  label: string;
  value: string;
  display: string;
  options: PillSelectOption[];
  onChange: (value: string) => void;
  icon?: React.ReactNode;
  color?: string;
  disabled?: boolean;
  muted?: boolean;
}

/**
 * Pílula com a aparência do design system e um `<select>` nativo invisível
 * por cima: seletor acessível, picker nativo no celular e fonte de 16 px no
 * campo real (o iOS não dá zoom).
 */
function PillSelect({ label, value, display, options, onChange, icon, color, disabled, muted }: PillSelectProps) {
  return (
    <span
      className={cn(
        "relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
        "focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 focus-within:ring-offset-surface-base",
        disabled ? "opacity-60" : "hover:bg-surface-overlay",
        color ? "text-text-primary" : "border-border-strong",
        muted ? "text-text-muted" : "text-text-primary"
      )}
      style={color ? { borderColor: hexAlpha(color, 0.55), backgroundColor: hexAlpha(color, 0.12) } : undefined}
    >
      {color ? (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      ) : (
        icon
      )}
      <span className="max-w-[9rem] truncate font-medium">{display}</span>
      <ChevronDown size={12} className="shrink-0 text-text-muted" aria-hidden />
      <select
        aria-label={label}
        title={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0 text-base disabled:cursor-not-allowed"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

interface LeadSummary {
  _id: Id<"leads">;
  boardId: Id<"boards">;
  value?: number;
  customFields?: Record<string, unknown>;
}

interface ConversationRoutingBarProps {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  modules: OrgModules;
  lead: LeadSummary | null;
  canReply: boolean;
  canEditLead: boolean;
  /** Membros atribuíveis da org (fallback do responsável sem setor). */
  teamMembers: { _id: Id<"teamMembers">; name: string; type: "human" | "ai"; removed?: boolean }[];
}

/**
 * Barra "CRM dentro do chat" da Central, logo abaixo do header da conversa:
 * unidade, setor, responsável, tipo de contato, Transferir e o desfecho
 * (Convertido / Não convertido). Cada peça aparece só com o módulo dela; a
 * faixa de origem do anúncio vem logo abaixo (módulo attribution).
 */
export function ConversationRoutingBar({
  organizationId,
  conversationId,
  modules,
  lead,
  canReply,
  canEditLead,
  teamMembers,
}: ConversationRoutingBarProps) {
  const routing = useQuery(api.conversationRouting.getConversationRouting, { conversationId });
  const units = useQuery(api.units.listUnits, modules.units ? { organizationId } : "skip");
  const departments = useQuery(
    api.departments.listDepartments,
    modules.departments ? { organizationId } : "skip"
  ) as DepartmentOption[] | undefined;
  const stages = useQuery(
    api.boards.getStages,
    lead && canEditLead ? { boardId: lead.boardId } : "skip"
  ) as { _id: Id<"stages">; name: string; order: number; isClosedWon?: boolean; isClosedLost?: boolean }[] | undefined;

  const setUnit = useMutation(api.conversationRouting.setConversationUnit);
  const assign = useMutation(api.conversationRouting.assignConversation);
  const setKind = useMutation(api.conversationRouting.setConversationKind);
  const transfer = useMutation(api.conversationRouting.transferConversation);
  const moveLeadToStage = useMutation(api.leads.moveLeadToStage);

  const [transferOpen, setTransferOpen] = useState(false);
  const [outcomeKind, setOutcomeKind] = useState<OutcomeKind | null>(null);
  const [confirmReopen, setConfirmReopen] = useState(false);

  // null = nenhum módulo da Central ligado (a query devolve null) → nada aparece.
  if (!routing) return null;

  const run = (p: Promise<unknown>, success: string, fallback: string) => {
    p.then(() => toast.success(success)).catch((e) => toast.error(mutationErrorMessage(e, fallback)));
  };

  const dept = routing.department;
  const deptList = departments ?? [];
  const deptMembers = dept ? deptList.find((d) => d._id === dept._id)?.members : undefined;
  const memberPool = (
    deptMembers && deptMembers.length > 0
      ? deptMembers
      : teamMembers.filter((m) => !m.removed || m._id === routing.assignee?._id)
  ).slice();
  if (routing.assignee && !memberPool.some((m) => m._id === routing.assignee!._id)) {
    memberPool.unshift(routing.assignee);
  }

  const kind = routing.contactKind as ContactKind;
  const kindMeta = CONTACT_KINDS.find((k) => k.id === kind) ?? CONTACT_KINDS[0];
  const KindIcon = kindMeta.icon;
  const isSalesLead = kind === "lead";
  const outcome = routing.outcome;
  const stay = formatStayRange(lead?.customFields?.checkin, lead?.customFields?.checkout);
  const reopenStage = (stages ?? [])
    .filter((s) => !s.isClosedWon && !s.isClosedLost)
    .sort((a, b) => a.order - b.order)
    .at(-1);

  const handleReopen = () => {
    if (!lead || !reopenStage) return;
    run(
      moveLeadToStage({ leadId: lead._id, stageId: reopenStage._id }),
      `Desfecho desfeito — lead voltou para "${reopenStage.name}"`,
      "Falha ao desfazer o desfecho"
    );
  };

  return (
    <>
      <div className="shrink-0 border-b border-border bg-surface-raised/60 px-4 py-2">
        <div
          role="toolbar"
          aria-label="Roteamento e desfecho da conversa"
          className="flex w-full items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] md:flex-wrap md:overflow-visible [&::-webkit-scrollbar]:hidden"
        >
          {modules.units && (
            <PillSelect
              label="Unidade da conversa"
              value={routing.unit?._id ?? ""}
              display={routing.unit?.name ?? "Sem unidade"}
              color={routing.unit?.color}
              muted={!routing.unit}
              icon={<Building2 size={13} className="text-text-muted" aria-hidden />}
              disabled={!canReply || units === undefined}
              options={[
                { value: "", label: "Sem unidade" },
                ...(units ?? []).map((u) => ({ value: u._id, label: u.name })),
              ]}
              onChange={(v) =>
                run(
                  setUnit({ conversationId, unitId: v ? (v as Id<"units">) : null }),
                  v ? "Unidade definida" : "Unidade removida",
                  "Falha ao definir a unidade"
                )
              }
            />
          )}

          {modules.departments && (
            <>
              <PillSelect
                label="Setor da conversa"
                value={dept?._id ?? ""}
                display={dept?.name ?? "Sem setor"}
                color={dept?.color}
                muted={!dept}
                icon={<Layers size={13} className="text-text-muted" aria-hidden />}
                disabled={!canReply || departments === undefined}
                options={[
                  ...(dept ? [] : [{ value: "", label: "Sem setor" }]),
                  ...deptList.map((d) => ({ value: d._id, label: d.name })),
                ]}
                onChange={(v) => {
                  if (!v || v === dept?._id) return;
                  const name = deptList.find((d) => d._id === v)?.name ?? "setor";
                  run(
                    transfer({ conversationId, toDepartmentId: v as Id<"departments"> }),
                    `Conversa movida para ${name}`,
                    "Falha ao mudar o setor"
                  );
                }}
              />
              <PillSelect
                label="Responsável pela conversa"
                value={routing.assignee?._id ?? ""}
                display={routing.assignee?.name ?? "Sem responsável"}
                muted={!routing.assignee}
                icon={<UserRound size={13} className="text-text-muted" aria-hidden />}
                disabled={!canReply}
                options={[
                  { value: "", label: dept ? `Fila de ${dept.name}` : "Sem responsável" },
                  ...memberPool.map((m) => ({
                    value: m._id,
                    label: m.type === "ai" ? `${m.name} (IA)` : m.name,
                  })),
                ]}
                onChange={(v) =>
                  run(
                    assign({ conversationId, memberId: v ? (v as Id<"teamMembers">) : null }),
                    v ? "Responsável definido" : "Conversa voltou para a fila",
                    "Falha ao definir o responsável"
                  )
                }
              />
            </>
          )}

          <PillSelect
            label="Tipo de contato"
            value={kind}
            display={kindMeta.label}
            icon={<KindIcon size={13} className="text-text-muted" aria-hidden />}
            disabled={!canReply}
            options={CONTACT_KINDS.map((k) => ({ value: k.id, label: k.label }))}
            onChange={(v) =>
              run(
                setKind({ conversationId, contactKind: v as ContactKind }),
                "Tipo de contato atualizado",
                "Falha ao classificar o contato"
              )
            }
          />

          {modules.departments && canReply && (
            <button
              type="button"
              onClick={() => setTransferOpen(true)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border-strong px-2.5 text-xs font-medium text-text-primary transition-colors hover:border-brand-500 hover:text-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
            >
              <ArrowRightLeft size={13} aria-hidden />
              Transferir
            </button>
          )}

          {lead && isSalesLead && (
            <div className="flex shrink-0 items-center gap-1.5 md:ml-auto">
              {outcome ? (
                <span
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium tabular-nums",
                    outcome.status === "converted"
                      ? "bg-semantic-success/10 text-semantic-success"
                      : "bg-semantic-error/10 text-semantic-error"
                  )}
                  role="status"
                >
                  {outcome.status === "converted" ? (
                    <CircleCheck size={14} aria-hidden />
                  ) : (
                    <CircleX size={14} aria-hidden />
                  )}
                  {outcome.status === "converted"
                    ? ["Reserva confirmada", outcome.value > 0 ? formatBRL(outcome.value) : null, stay]
                        .filter(Boolean)
                        .join(" · ")
                    : ["Não convertido", outcome.reason].filter(Boolean).join(" · ")}
                  {canEditLead && reopenStage && (
                    <button
                      type="button"
                      onClick={() => setConfirmReopen(true)}
                      className="-mr-1.5 ml-0.5 inline-flex h-7 items-center gap-1 rounded-full px-2 text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-500"
                      aria-label="Desfazer desfecho"
                      title="Desfazer desfecho"
                    >
                      <Undo2 size={13} aria-hidden />
                      <span className="hidden sm:inline">Desfazer</span>
                    </button>
                  )}
                </span>
              ) : (
                canEditLead && (
                  <>
                    <button
                      type="button"
                      onClick={() => setOutcomeKind("converted")}
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-semantic-success/10 px-2.5 text-xs font-semibold text-semantic-success transition-colors hover:bg-semantic-success/20 focus:outline-none focus:ring-2 focus:ring-semantic-success focus:ring-offset-2 focus:ring-offset-surface-base"
                    >
                      <CircleCheck size={14} aria-hidden />
                      Convertido
                    </button>
                    <button
                      type="button"
                      onClick={() => setOutcomeKind("not_converted")}
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border-strong px-2.5 text-xs font-medium text-text-secondary transition-colors hover:border-semantic-error hover:text-semantic-error focus:outline-none focus:ring-2 focus:ring-semantic-error focus:ring-offset-2 focus:ring-offset-surface-base"
                    >
                      <CircleX size={14} aria-hidden />
                      Não convertido
                    </button>
                  </>
                )
              )}
            </div>
          )}
          {!isSalesLead && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-text-muted md:ml-auto">
              <Tag size={11} aria-hidden />
              fora das métricas de venda
            </span>
          )}
        </div>
      </div>

      {modules.attribution && routing.attribution && <AttributionStrip attribution={routing.attribution} />}

      {modules.departments && (
        <TransferModal
          open={transferOpen}
          onClose={() => setTransferOpen(false)}
          conversationId={conversationId}
          departments={deptList}
          currentDepartment={dept}
          currentAssigneeId={routing.assignee?._id ?? null}
        />
      )}
      {lead && (
        <OutcomeModal
          open={outcomeKind !== null}
          kind={outcomeKind ?? "converted"}
          onClose={() => setOutcomeKind(null)}
          conversationId={conversationId}
          currentValue={lead.value}
          customFields={lead.customFields}
        />
      )}
      <ConfirmDialog
        open={confirmReopen}
        onClose={() => setConfirmReopen(false)}
        onConfirm={() => {
          setConfirmReopen(false);
          handleReopen();
        }}
        title="Desfazer desfecho?"
        description={
          reopenStage
            ? `O lead volta para o estágio "${reopenStage.name}" e deixa de contar como ${
                outcome?.status === "converted" ? "convertido" : "perdido"
              } no painel.`
            : undefined
        }
        confirmLabel="Desfazer"
      />
    </>
  );
}
