import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Crown, Search, Send, ShieldCheck, UserPlus, UserRound, Users } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { usePermissions } from "@/hooks/usePermissions";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { TAB_ROUTES } from "@/lib/routes";
import {
  formatGroupPhone,
  groupSenderColor,
  initialsOf,
  maskPhone,
  participantDisplayName,
  participantKeyOf,
} from "@/lib/groupDisplay";
import type { GroupChatDoc, GroupParticipant } from "./types";

interface GroupMembersPanelProps {
  open: boolean;
  groupChatId: Id<"groupChats">;
  organizationId: Id<"organizations">;
  onClose: () => void;
  /** Abre o contato de um membro já conhecido, sobreposto a este painel. */
  onOpenContact?: (contactId: Id<"contacts">) => void;
  /**
   * Disparo 1 a 1 para os membros selecionados (F5). Ausente = sem permissão de
   * campanhas, e o botão fica desabilitado. Recebe os telefones já filtrados
   * (só quem expõe número) e o grupo de origem, que a campanha guarda como
   * `sourceGroupChatId` para o relatório por grupo.
   */
  onDispatchSelected?: (phones: string[], groupChatId: Id<"groupChats">) => void;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Slide-over com os membros de um grupo.
 *
 * Duas regras do plano moldam esta tela:
 *  - **D3:** membro NÃO é contato. O chip "Contato" só aparece quando o
 *    telefone já era conhecido, e virar lead é um clique explícito.
 *  - **LGPD:** são terceiros. O telefone aparece mascarado; inteiro só para
 *    quem tem `inbox:view_all`.
 */
export function GroupMembersPanel({
  open,
  groupChatId,
  organizationId,
  onClose,
  onOpenContact,
  onDispatchSelected,
}: GroupMembersPanelProps) {
  const navigate = useNavigate();
  const { can } = usePermissions(organizationId);
  const canSeeFullPhone = can("inbox", "view_all");
  const canCreateLead = can("leads", "edit_own") && can("contacts", "edit");

  const group = useQuery(
    api.groupChats.getGroup,
    open ? { groupChatId } : "skip"
  ) as (GroupChatDoc & { selfKey?: string | null }) | null | undefined;

  const createLeadFromMember = useMutation(api.groupChats.createLeadFromMember);

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  const participants: GroupParticipant[] = useMemo(
    () => (group?.participants ?? []).filter((p) => p.leftAt === undefined),
    [group]
  );

  const filtered = useMemo(() => {
    const term = normalize(search.trim());
    const rows = participants.map((p) => ({
      participant: p,
      key: participantKeyOf(p),
      label: participantDisplayName(p, canSeeFullPhone),
    }));
    if (!term) return rows;
    return rows.filter(
      ({ participant, label }) =>
        normalize(label).includes(term) || (participant.phone ?? "").includes(term)
    );
  }, [participants, search, canSeeFullPhone]);

  const selectedRows = useMemo(
    () => participants.filter((p) => selected.has(participantKeyOf(p))),
    [participants, selected]
  );
  const selectedPhones = useMemo(
    () => selectedRows.map((p) => p.phone).filter((p): p is string => !!p),
    [selectedRows]
  );
  const selectedWithoutLead = useMemo(
    () => selectedRows.filter((p) => !p.contactId && p.phone),
    [selectedRows]
  );

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleCreateLead = async (participant: GroupParticipant) => {
    const key = participantKeyOf(participant);
    setBusyKey(key);
    try {
      const result = await createLeadFromMember({ groupChatId, participantKey: key });
      toast.success(
        result.created
          ? `Lead criado para ${participantDisplayName(participant)}`
          : `${participantDisplayName(participant)} já era contato — lead vinculado`
      );
      navigate(`${TAB_ROUTES.board}?lead=${result.leadId}`);
      onClose();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao criar o lead"));
    } finally {
      setBusyKey(null);
    }
  };

  const handleBulkCreateLeads = async () => {
    const targets = selectedWithoutLead;
    if (targets.length === 0) return;
    setBulkProgress({ done: 0, total: targets.length });
    let created = 0;
    let failed = 0;
    // Sequencial de propósito: cada chamada faz find-or-create de contato E de
    // lead, e disparar N em paralelo criaria corrida entre duas chamadas para
    // o mesmo telefone (dois membros podem compartilhar número).
    for (const participant of targets) {
      try {
        await createLeadFromMember({
          groupChatId,
          participantKey: participantKeyOf(participant),
        });
        created += 1;
      } catch {
        failed += 1;
      }
      setBulkProgress({ done: created + failed, total: targets.length });
    }
    setBulkProgress(null);
    setSelected(new Set());
    if (failed === 0) toast.success(`${created} lead(s) criado(s)`);
    else toast.warning(`${created} lead(s) criado(s), ${failed} falharam`);
  };

  // Quem é "você" na sala é decidido no SERVIDOR (`isSelf` por participante):
  // a chave crua do nosso número não desce mais para o cliente sob o gate de
  // inbox (review de segurança nº 9).
  const withoutPhone = participants.filter((p) => !p.phone).length;

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title={group ? `Membros · ${group.subject}` : "Membros"}
      titleIcon={<Users size={18} className="text-brand-500 shrink-0" />}
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
    >
      {group === undefined ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size="lg" />
        </div>
      ) : group === null ? (
        <p className="p-6 text-sm text-text-muted">Grupo não encontrado.</p>
      ) : (
        <>
          <div className="shrink-0 border-b border-border px-4 md:px-6 py-3 space-y-2">
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <span className="tabular-nums">
                {participants.length} membro{participants.length === 1 ? "" : "s"}
              </span>
              {withoutPhone > 0 && (
                <span className="tabular-nums">· {withoutPhone} sem telefone visível</span>
              )}
            </div>
            <div className="relative">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar membro..."
                aria-label="Buscar membro"
                className="h-9 w-full rounded-full border border-border-strong bg-surface-sunken pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="p-6 text-center text-sm text-text-muted">
                {participants.length === 0
                  ? "Nenhum participante conhecido ainda — atualize a lista de grupos."
                  : "Nenhum membro com esse termo."}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map(({ participant, key, label }) => {
                  const isSelf = participant.isSelf === true;
                  const color = groupSenderColor(key);
                  const phoneText = participant.phone
                    ? canSeeFullPhone
                      ? formatGroupPhone(participant.phone)
                      : maskPhone(participant.phone)
                    : "sem telefone visível";
                  return (
                    <li key={key} className="flex items-start gap-3 px-4 md:px-6 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(key)}
                        onChange={() => toggle(key)}
                        aria-label={`Selecionar ${label}`}
                        className="mt-1.5 h-4 w-4 shrink-0 rounded border-border-strong bg-surface-sunken accent-brand-600"
                      />
                      <span
                        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                        style={{ backgroundColor: color }}
                        aria-hidden
                      >
                        {initialsOf(label)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-text-primary">
                            {label}
                          </span>
                          {isSelf && <Badge variant="brand">você</Badge>}
                          {participant.isSuperAdmin ? (
                            <Badge variant="warning">
                              <span className="inline-flex items-center gap-1">
                                <Crown size={10} /> Dono
                              </span>
                            </Badge>
                          ) : participant.isAdmin ? (
                            <Badge variant="info">
                              <span className="inline-flex items-center gap-1">
                                <ShieldCheck size={10} /> Admin
                              </span>
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-text-muted tabular-nums">
                          {phoneText}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          {participant.contactId ? (
                            <button
                              type="button"
                              onClick={() =>
                                onOpenContact?.(participant.contactId as Id<"contacts">)
                              }
                              disabled={!onOpenContact}
                              className="inline-flex items-center gap-1 rounded-full bg-brand-500/15 px-2 py-0.5 text-[11px] font-medium text-brand-400 transition-colors hover:bg-brand-500/25 disabled:opacity-60"
                            >
                              <UserRound size={11} />
                              Abrir contato
                            </button>
                          ) : canCreateLead && participant.phone && !isSelf ? (
                            <button
                              type="button"
                              onClick={() => void handleCreateLead(participant)}
                              disabled={busyKey === key || bulkProgress !== null}
                              className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] font-medium text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400 disabled:opacity-50"
                            >
                              {busyKey === key ? <Spinner size="sm" /> : <UserPlus size={11} />}
                              Criar lead deste membro
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {selected.size > 0 && (
            <div className="shrink-0 border-t border-border bg-surface-raised px-4 md:px-6 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-auto text-xs text-text-secondary tabular-nums">
                  {selected.size} selecionado{selected.size === 1 ? "" : "s"}
                  {bulkProgress && ` · ${bulkProgress.done}/${bulkProgress.total}`}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Limpar
                </Button>
                {canCreateLead && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={selectedWithoutLead.length === 0 || bulkProgress !== null}
                    onClick={() => void handleBulkCreateLeads()}
                    title={
                      selectedWithoutLead.length === 0
                        ? "Os selecionados já são contatos (ou não expõem telefone)"
                        : undefined
                    }
                  >
                    {bulkProgress ? <Spinner size="sm" /> : <UserPlus size={14} />}
                    Criar leads dos selecionados ({selectedWithoutLead.length})
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!onDispatchSelected || selectedPhones.length === 0}
                  onClick={() => onDispatchSelected?.(selectedPhones, groupChatId)}
                  title={
                    onDispatchSelected
                      ? "Abre uma campanha com os números selecionados"
                      : "Precisa de permissão para gerenciar campanhas"
                  }
                >
                  <Send size={14} />
                  Disparar para selecionados
                </Button>
              </div>
              {!onDispatchSelected && (
                <p className="mt-1.5 text-[11px] text-text-muted">
                  Disparar para membros exige permissão de campanhas.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </SlideOver>
  );
}

/** Botão compacto "N membros" do header da conversa de grupo. */
export function GroupMembersButton({
  participantsCount,
  onClick,
  className,
}: {
  participantsCount: number;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full text-xs text-text-muted transition-colors hover:text-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500",
        className
      )}
      aria-label="Ver membros do grupo"
    >
      <Users size={13} className="shrink-0" />
      <span className="tabular-nums">
        {participantsCount} membro{participantsCount === 1 ? "" : "s"}
      </span>
    </button>
  );
}
