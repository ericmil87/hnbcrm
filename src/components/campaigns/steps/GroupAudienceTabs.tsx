import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { AlertTriangle, Crown, MessagesSquare, Search, UserRound, Users } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { formatGroupPhone } from "@/lib/groupDisplay";
import type { AudiencePreview, MemberFilters, MonitoredGroup, PreviewMemberRow } from "../types";
import type { WizardDraft } from "../wizardState";

/**
 * Passo "Público" dos dois públicos de grupo (v0.57 / F5).
 *
 * "Grupos": a mensagem vai NA sala. "Membros de grupos": mensagem privada,
 * 1 a 1, para os participantes — o disparo mais vigiado do WhatsApp, por isso
 * a prévia mostra o funil inteiro e a estimativa de dias antes de qualquer
 * aceite.
 */

interface GroupAudienceProps {
  organizationId: Id<"organizations">;
  draft: WizardDraft;
  setDraft: (updater: (prev: WizardDraft) => WizardDraft) => void;
  isDraft: boolean;
  now: number;
}

const MEMBER_EXCLUSION_LABELS: Record<string, string> = {
  self: "seu próprio número",
  left: "saíram do grupo",
  no_phone: "sem telefone visível",
  invalid_phone: "telefone inválido",
  duplicate: "repetidos entre grupos",
  opted_out: "em supressão (opt-out)",
  admin: "administradores",
  existing_contact: "já são contatos",
  campaigned_recently: "receberam campanha há pouco",
  inactive_in_group: "sem falar no grupo na janela",
  in_excluded_group: "estão no grupo excluído",
  not_selected: "não selecionados",
};

/** O mesmo motivo, curto, para caber ao lado do nome na lista de membros. */
const MEMBER_REASON_SHORT: Record<string, string> = {
  self: "é o nosso número",
  left: "saiu do grupo",
  no_phone: "sem telefone visível",
  invalid_phone: "telefone inválido",
  duplicate: "já entra por outro grupo",
  opted_out: "pediu para não receber",
  admin: "administrador do grupo",
  existing_contact: "já é contato",
  campaigned_recently: "recebeu campanha há pouco",
  inactive_in_group: "não falou no grupo",
  in_excluded_group: "está no grupo excluído",
  not_selected: "não selecionado",
};

/** Elegível = entra, ou entraria se fosse marcado. */
function isEligibleRow(m: PreviewMemberRow): boolean {
  return m.excludedReason === undefined || m.excludedReason === "not_selected";
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function memberLabel(m: PreviewMemberRow): string {
  if (m.name) return m.name;
  if (m.phone) return formatGroupPhone(m.phone);
  return m.phoneMasked || "sem telefone";
}

const GROUP_EXCLUSION_LABELS: Record<string, string> = {
  not_monitored: "não acompanhados",
  no_conversation: "sem conversa no inbox",
  duplicate: "repetidos",
  other_channel: "de outro número",
};

/** Grupos monitorados do canal escolhido. */
export function useMonitoredGroups(
  organizationId: Id<"organizations">,
  channelConfigId: Id<"channelConfigs"> | null
): MonitoredGroup[] | undefined {
  const groups = useQuery(
    api.groupChats.listGroups,
    channelConfigId ? { organizationId, channelConfigId } : "skip"
  ) as MonitoredGroup[] | undefined;
  return useMemo(
    () => groups?.filter((g) => g.monitored && !g.removedAt && !g.leftAt),
    [groups]
  );
}

/**
 * Só os ids que EXISTEM entre os grupos carregados. O rascunho pode vir com um
 * grupo de outro número (deep-link colado, canal trocado) ou que deixou de ser
 * acompanhado, e `previewAudience` LANÇA nesse caso — derrubando o passo
 * inteiro em vez de mostrar a prévia dos que valem.
 */
function useValidSelection(
  groups: MonitoredGroup[] | undefined,
  selected: Id<"groupChats">[]
): Id<"groupChats">[] {
  return useMemo(() => {
    if (groups === undefined) return [];
    const known = new Set(groups.map((g) => String(g._id)));
    return selected.filter((id) => known.has(String(id)));
  }, [groups, selected]);
}

function GroupPicker({
  groups,
  selected,
  onToggle,
  disabled,
  emptyHint,
}: {
  groups: MonitoredGroup[];
  selected: Id<"groupChats">[];
  onToggle: (id: Id<"groupChats">) => void;
  disabled: boolean;
  emptyHint: string;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((g) => g.subject.toLowerCase().includes(needle));
  }, [groups, search]);

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-sunken p-4 text-sm text-text-secondary">
        {emptyHint}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {groups.length > 6 && (
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar grupo"
          icon={<Search size={15} />}
        />
      )}
      <ul className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-surface-sunken p-2">
        {filtered.map((g) => {
          const checked = selected.includes(g._id);
          return (
            <li key={g._id}>
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors",
                  checked ? "bg-brand-500/10" : "hover:bg-surface-overlay",
                  disabled && "cursor-not-allowed opacity-60"
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-brand-600"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(g._id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">{g.subject}</span>
                  <span className="block text-[11px] text-text-muted tabular-nums">
                    {g.participantsCount} membro{g.participantsCount === 1 ? "" : "s"}
                    {g.conversationId ? "" : " · sem conversa no inbox"}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ExclusionList({ excluded, labels }: { excluded: Record<string, number>; labels: Record<string, string> }) {
  const entries = Object.entries(excluded ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-[11px] text-text-muted">
      {entries.map(([reason, n]) => (
        <li key={reason} className="flex justify-between gap-2">
          <span>{labels[reason] ?? reason}</span>
          <span className="tabular-nums">{n}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Público "grupos" (a sala é o destinatário) ──

export function GroupsTab({ organizationId, draft, setDraft, isDraft, now }: GroupAudienceProps) {
  const groups = useMonitoredGroups(organizationId, draft.channelConfigId);
  const selected = draft.audience.groupChatIds;
  const toggle = (id: Id<"groupChats">) =>
    setDraft((d) => ({
      ...d,
      audience: {
        ...d.audience,
        groupChatIds: d.audience.groupChatIds.includes(id)
          ? d.audience.groupChatIds.filter((x) => x !== id)
          : [...d.audience.groupChatIds, id],
      },
    }));

  const validSelected = useValidSelection(groups, selected);
  const preview = useQuery(
    api.campaigns.previewAudience,
    validSelected.length > 0 && draft.channelConfigId
      ? {
          organizationId,
          filters: {},
          now,
          source: "groups" as const,
          groupChatIds: validSelected,
          channelConfigId: draft.channelConfigId,
        }
      : "skip"
  ) as AudiencePreview | undefined;

  if (groups === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <GroupPicker
          groups={groups}
          selected={selected}
          onToggle={toggle}
          disabled={!isDraft}
          emptyHint='Nenhum grupo acompanhado neste número. Ligue "Acompanhar" em Configurações → Canais → Grupos.'
        />
        <p className="flex items-start gap-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3 text-xs text-text-secondary">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-semantic-warning" />
          A mesma mensagem em várias salas é o padrão clássico de spam. Use 2 ou mais variantes,
          escolha poucos grupos por dia e escreva algo que faça sentido para aquela sala.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-surface-sunken p-4">
        <p className="text-xs text-text-muted">Grupos selecionados</p>
        <p className="text-2xl font-semibold text-text-primary tabular-nums">
          {preview?.count ?? selected.length}
        </p>
        {preview?.reach !== undefined && (
          <p className="mt-1 text-xs text-text-secondary">
            Alcance estimado: {preview.reach.toLocaleString("pt-BR")} membros
          </p>
        )}
        <ExclusionList excluded={preview?.excluded ?? {}} labels={GROUP_EXCLUSION_LABELS} />
        {(preview?.perGroup ?? []).length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-text-secondary">
            {(preview?.perGroup ?? []).map((g) => (
              <li key={String(g.groupChatId)} className="truncate">
                {g.subject}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Público "membros de grupos" (DM 1 a 1) ──

export function GroupMembersTab({ organizationId, draft, setDraft, isDraft, now }: GroupAudienceProps) {
  const groups = useMonitoredGroups(organizationId, draft.channelConfigId);
  const selected = draft.audience.groupChatIds;
  const filters = draft.audience.memberFilters;

  const toggle = (id: Id<"groupChats">) =>
    setDraft((d) => ({
      ...d,
      audience: {
        ...d.audience,
        groupChatIds: d.audience.groupChatIds.includes(id)
          ? d.audience.groupChatIds.filter((x) => x !== id)
          : [...d.audience.groupChatIds, id],
        // Um grupo não pode ser fonte e exclusão ao mesmo tempo.
        memberFilters: {
          ...d.audience.memberFilters,
          excludeGroupChatIds: (d.audience.memberFilters.excludeGroupChatIds ?? []).filter((x) => x !== id),
        },
      },
    }));
  const updateFilters = (patch: Partial<typeof filters>) =>
    setDraft((d) => ({
      ...d,
      audience: { ...d.audience, memberFilters: { ...d.audience.memberFilters, ...patch } },
    }));

  // Debounce: cada tecla nos filtros não pode virar uma varredura no servidor.
  const [debounced, setDebounced] = useState(filters);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(filters), 400);
    return () => clearTimeout(t);
  }, [filters]);

  const cleanFilters = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(debounced)) {
      if (v === undefined || v === null || v === false || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  }, [debounced]);

  const validSelected = useValidSelection(groups, selected);
  const preview = useQuery(
    api.campaigns.previewAudience,
    validSelected.length > 0 && draft.channelConfigId
      ? {
          organizationId,
          filters: {},
          now,
          source: "group_members" as const,
          groupChatIds: validSelected,
          memberFilters: cleanFilters,
          channelConfigId: draft.channelConfigId,
        }
      : "skip"
  ) as AudiencePreview | undefined;

  if (groups === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  const excludeOptions = groups.filter((g) => !selected.includes(g._id));
  const funnel = preview?.funnel ?? null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-text-secondary">Grupos de origem</p>
          <GroupPicker
            groups={groups}
            selected={selected}
            onToggle={toggle}
            disabled={!isDraft}
            emptyHint='Nenhum grupo acompanhado neste número. Ligue "Acompanhar" em Configurações → Canais → Grupos.'
          />
          <p className="mt-1 text-[11px] text-text-muted">
            Quem estiver em mais de um grupo recebe uma vez só, pelo primeiro grupo da lista.
          </p>
        </div>

        <div className="space-y-2.5 rounded-lg border border-border bg-surface-sunken p-4">
          <p className="text-[13px] font-medium text-text-secondary">Filtros</p>
          <Checkbox
            checked={filters.excludeAdmins === true}
            disabled={!isDraft}
            onChange={(e) => updateFilters({ excludeAdmins: e.target.checked || undefined })}
            label="Não mandar para administradores do grupo"
          />
          <Checkbox
            checked={filters.excludeExistingContacts === true}
            disabled={!isDraft}
            onChange={(e) => updateFilters({ excludeExistingContacts: e.target.checked || undefined })}
            label="Só quem ainda não é contato"
            description="Evita reabordar quem sua equipe já atende."
          />
          <label className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-600"
              disabled={!isDraft}
              checked={filters.excludeCampaignedWithinDays !== undefined}
              onChange={(e) => updateFilters({ excludeCampaignedWithinDays: e.target.checked ? 30 : undefined })}
            />
            Excluir quem recebeu campanha nos últimos
            <input
              type="number"
              min={1}
              max={365}
              disabled={!isDraft || filters.excludeCampaignedWithinDays === undefined}
              value={filters.excludeCampaignedWithinDays ?? 30}
              onChange={(e) => updateFilters({ excludeCampaignedWithinDays: Math.max(1, Number(e.target.value) || 1) })}
              className="h-9 w-20 rounded-lg border border-border bg-surface-raised px-2 text-sm text-text-primary disabled:opacity-50"
            />
            dias
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-600"
              disabled={!isDraft}
              checked={filters.activeInGroupWithinDays !== undefined}
              onChange={(e) => updateFilters({ activeInGroupWithinDays: e.target.checked ? 30 : undefined })}
            />
            Só quem falou no grupo nos últimos
            <input
              type="number"
              min={1}
              max={365}
              disabled={!isDraft || filters.activeInGroupWithinDays === undefined}
              value={filters.activeInGroupWithinDays ?? 30}
              onChange={(e) => updateFilters({ activeInGroupWithinDays: Math.max(1, Number(e.target.value) || 1) })}
              className="h-9 w-20 rounded-lg border border-border bg-surface-raised px-2 text-sm text-text-primary disabled:opacity-50"
            />
            dias
          </label>
          {excludeOptions.length > 0 && (
            <div>
              <p className="mb-1 text-[13px] text-text-secondary">Excluir quem também está em</p>
              <div className="flex flex-wrap gap-1.5">
                {excludeOptions.map((g) => {
                  const on = (filters.excludeGroupChatIds ?? []).includes(g._id);
                  return (
                    <button
                      key={g._id}
                      type="button"
                      disabled={!isDraft}
                      onClick={() =>
                        updateFilters({
                          excludeGroupChatIds: on
                            ? (filters.excludeGroupChatIds ?? []).filter((x) => x !== g._id)
                            : [...(filters.excludeGroupChatIds ?? []), g._id],
                        })
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                        on
                          ? "border-brand-500 bg-brand-500/10 text-brand-400"
                          : "border-border text-text-secondary hover:border-border-strong",
                        !isDraft && "cursor-not-allowed opacity-60"
                      )}
                    >
                      {g.subject}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {validSelected.length > 0 && !preview?.blockedReason && (
          <MemberSelection
            preview={preview}
            filters={filters}
            updateFilters={updateFilters}
            disabled={!isDraft}
            multipleGroups={validSelected.length > 1}
          />
        )}

        <p className="flex items-start gap-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3 text-xs text-text-secondary">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-semantic-warning" />
          Mensagem privada para quem não iniciou conversa com a empresa é o disparo mais bloqueado
          pelo WhatsApp. O envio é espalhado em dias, respeitando o teto por grupo, e o lançamento
          pede um aceite específico.
        </p>
      </div>

      <div className="space-y-3">
        {preview?.blockedReason && (
          <p className="flex items-start gap-2 rounded-lg border border-semantic-error/40 bg-semantic-error/10 p-3 text-xs text-text-secondary">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-semantic-error" />
            {preview.blockedReason}
          </p>
        )}

        <div className="rounded-lg border border-border bg-surface-sunken p-4">
          <p className="text-xs text-text-muted">Destinatários finais</p>
          <p className="text-2xl font-semibold text-text-primary tabular-nums">
            {preview?.count ?? 0}
          </p>
          {preview && (preview.estimatedDays ?? 0) > 0 && (
            <p className="mt-1 text-xs text-text-secondary">
              {preview.count.toLocaleString("pt-BR")} destinatários → ~{preview.estimatedDays} dia
              {preview.estimatedDays === 1 ? "" : "s"} no modo seguro ({preview.perGroupPerDay ?? 10} por grupo/dia)
            </p>
          )}
          {preview?.truncated && (
            <p className="mt-1 text-[11px] text-semantic-warning">
              Público maior que o teto de {(preview.limit ?? 0).toLocaleString("pt-BR")} por
              campanha: {(preview.overLimit ?? 0).toLocaleString("pt-BR")} pessoa(s) ficam de fora.
              Aperte os filtros ou divida em campanhas por grupo.
            </p>
          )}
        </div>

        {funnel && (
          <div className="rounded-lg border border-border bg-surface-sunken p-4">
            <p className="mb-2 text-xs font-medium text-text-secondary">Funil</p>
            <ul className="space-y-1 text-xs">
              <FunnelRow label="Membros" value={funnel.total} />
              <FunnelRow label="Com telefone" value={funnel.withPhone} />
              <FunnelRow label="Sem duplicata" value={funnel.deduped} />
              <FunnelRow label="Fora da supressão" value={funnel.afterOptOut} />
              <FunnelRow label="Depois dos filtros" value={funnel.final} strong />
            </ul>
            <ExclusionList excluded={preview?.excluded ?? {}} labels={MEMBER_EXCLUSION_LABELS} />
          </div>
        )}

        {(preview?.sample ?? []).length > 0 && (
          <div className="rounded-lg border border-border bg-surface-sunken p-4">
            <p className="mb-2 text-xs font-medium text-text-secondary">Amostra</p>
            <ul className="space-y-1 text-xs text-text-secondary">
              {(preview?.sample ?? []).map((m, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="truncate">{m.name ?? "sem nome"}</span>
                  <span className="shrink-0 tabular-nums text-text-muted">{m.phone}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-text-muted">
              Telefones mascarados: são terceiros que ainda não falaram com a empresa.
            </p>
          </div>
        )}

        {(preview?.perGroup ?? []).length > 1 && (
          <div className="rounded-lg border border-border bg-surface-sunken p-4">
            <p className="mb-2 text-xs font-medium text-text-secondary">Por grupo</p>
            <ul className="space-y-1 text-xs text-text-secondary">
              {(preview?.perGroup ?? []).map((g) => (
                <li key={String(g.groupChatId)} className="flex items-center justify-between gap-2">
                  <span className="truncate">{g.subject}</span>
                  <span className="shrink-0 tabular-nums">{g.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Quem vai receber": a lista de gente por trás do número do funil.
 *
 * O funil responde "quantos"; esta lista responde "quem" e, para quem ficou de
 * fora, "por quê" — é o que permite conferir antes de mandar mensagem privada
 * para dezenas de pessoas que nunca falaram com a empresa.
 *
 * A seleção mora em `memberFilters.includeKeys`. NINGUÉM marcado = todos os
 * elegíveis (o comportamento de sempre), e é por isso que marcar todo mundo
 * grava `undefined` em vez da lista inteira: o rascunho não fica com uma
 * fotografia da sala que envelhece a cada pessoa que entra no grupo.
 */
function MemberSelection({
  preview,
  filters,
  updateFilters,
  disabled,
  multipleGroups,
}: {
  preview: AudiencePreview | undefined;
  filters: MemberFilters;
  updateFilters: (patch: Partial<MemberFilters>) => void;
  disabled: boolean;
  multipleGroups: boolean;
}) {
  const [search, setSearch] = useState("");
  // Cada clique num checkbox reescreve os filtros e o `useQuery` volta a
  // `undefined` enquanto recarrega. Sem segurar a última resposta, a lista
  // inteira piscava a cada marcação — segurando, ela só atualiza os motivos.
  const [sticky, setSticky] = useState(preview);
  useEffect(() => {
    if (preview !== undefined) setSticky(preview);
  }, [preview]);
  const shown = preview ?? sticky;
  const refreshing = preview === undefined && sticky !== undefined;
  const members = shown?.members ?? [];
  const truncated = shown?.membersTruncated === true;

  const eligibleKeys = useMemo(
    () => members.filter(isEligibleRow).map((m) => m.key),
    [members]
  );
  const selectedKeys = filters.includeKeys;
  const hasSelection = selectedKeys !== undefined && selectedKeys.length > 0;
  const selectedSet = useMemo(
    () => (hasSelection ? new Set(selectedKeys) : null),
    [hasSelection, selectedKeys]
  );
  const isChecked = (key: string) => (selectedSet ? selectedSet.has(key) : true);
  const selectedCount = selectedSet
    ? eligibleKeys.filter((k) => selectedSet.has(k)).length
    : eligibleKeys.length;

  const visible = useMemo(() => {
    const term = normalizeText(search.trim());
    if (!term) return members;
    // Os dígitos só entram na busca quando o usuário DIGITOU dígitos: um termo
    // sem número viraria "" e `includes("")` casa com todo mundo.
    const digits = term.replace(/\D/g, "");
    return members.filter((m) => {
      if (normalizeText(memberLabel(m)).includes(term)) return true;
      if (!digits) return false;
      return (m.phone ?? "").includes(digits) || m.phoneMasked.replace(/\D/g, "").includes(digits);
    });
  }, [members, search]);

  // Marcar/desmarcar parte de uma lista TRUNCADA gravaria só as 500 primeiras
  // pessoas e cortaria o resto do público em silêncio — por isso a seleção
  // individual desliga e a saída é apertar os filtros.
  const canSelect = !disabled && !truncated;

  const write = (keys: string[]) => {
    const everyone = eligibleKeys.length > 0 && keys.length >= eligibleKeys.length;
    updateFilters({ includeKeys: everyone || keys.length === 0 ? undefined : keys });
  };

  const toggle = (key: string) => {
    const base = new Set(selectedSet ?? eligibleKeys);
    if (base.has(key)) base.delete(key);
    else base.add(key);
    write(eligibleKeys.filter((k) => base.has(k)));
  };

  if (shown === undefined) {
    return (
      <div className="rounded-lg border border-border bg-surface-sunken p-4">
        <p className="text-[13px] font-medium text-text-secondary">Quem vai receber</p>
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      </div>
    );
  }
  if (members.length === 0) return null;

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-surface-sunken p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-2 text-[13px] font-medium text-text-secondary">
          Quem vai receber
          {refreshing && <Spinner size="sm" />}
        </p>
        <p className="text-[11px] text-text-muted tabular-nums">
          {selectedCount.toLocaleString("pt-BR")} selecionado{selectedCount === 1 ? "" : "s"} de{" "}
          {eligibleKeys.length.toLocaleString("pt-BR")} elegíve{eligibleKeys.length === 1 ? "l" : "is"}
        </p>
      </div>

      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar por nome ou telefone"
        icon={<Search size={15} />}
      />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!canSelect}
          onClick={() => write(eligibleKeys)}
          className="rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          Selecionar todos os elegíveis
        </button>
        <button
          type="button"
          disabled={!canSelect || !hasSelection}
          onClick={() => updateFilters({ includeKeys: undefined })}
          className="rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          Limpar seleção
        </button>
      </div>

      {truncated && (
        <p className="flex items-start gap-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-2.5 text-[11px] text-text-secondary">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-semantic-warning" />
          Mostrando as primeiras {(shown.membersLimit ?? members.length).toLocaleString("pt-BR")} de{" "}
          {(shown.membersTotal ?? members.length).toLocaleString("pt-BR")} pessoas. Escolher uma a
          uma cortaria em silêncio quem não aparece aqui — aperte os filtros ou divida em campanhas
          por grupo.
        </p>
      )}

      <ul className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-border bg-surface-base p-1.5">
        {visible.length === 0 && (
          <li className="px-2 py-3 text-center text-xs text-text-muted">Ninguém com esse nome ou número.</li>
        )}
        {visible.map((m) => {
          const eligible = isEligibleRow(m);
          const checked = eligible && isChecked(m.key);
          const reason = m.excludedReason ? MEMBER_REASON_SHORT[m.excludedReason] ?? m.excludedReason : null;
          // O nome já é o título da linha; o telefone só volta na segunda linha
          // quando não foi ele que virou título.
          const subtitle = [
            m.name ? (m.phone ? formatGroupPhone(m.phone) : m.phoneMasked) : "",
            multipleGroups ? m.groupSubject : "",
            reason ?? "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={`${m.groupChatId}:${m.key}`}>
              <label
                title={reason ?? undefined}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors",
                  eligible ? "hover:bg-surface-overlay" : "opacity-55",
                  checked && "bg-brand-500/10",
                  eligible && canSelect ? "cursor-pointer" : "cursor-default"
                )}
              >
                {eligible ? (
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-brand-600"
                    checked={checked}
                    disabled={!canSelect}
                    onChange={() => toggle(m.key)}
                  />
                ) : (
                  <span className="mt-1 h-4 w-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm text-text-primary">{memberLabel(m)}</span>
                    {m.isAdmin && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-semantic-warning/15 px-1.5 py-0.5 text-[10px] text-semantic-warning">
                        <Crown size={9} />
                        admin
                      </span>
                    )}
                    {m.isContact && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[10px] text-brand-400">
                        <UserRound size={9} />
                        contato
                      </span>
                    )}
                  </span>
                  {subtitle && (
                    <span className="mt-0.5 block truncate text-[11px] text-text-muted">{subtitle}</span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] text-text-muted">
        Sem ninguém marcado a campanha vai para todos os elegíveis. Quem está esmaecido não recebe —
        o motivo aparece ao lado do nome.
      </p>
    </div>
  );
}

function FunnelRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <li className={cn("flex items-center justify-between gap-2", strong && "font-medium text-text-primary")}>
      <span className={strong ? undefined : "text-text-secondary"}>{label}</span>
      <span className="tabular-nums">{value.toLocaleString("pt-BR")}</span>
    </li>
  );
}

/** Ícones dos cartões novos do passo Público. */
export const GROUP_SOURCE_ICONS = { groups: MessagesSquare, group_members: Users };
