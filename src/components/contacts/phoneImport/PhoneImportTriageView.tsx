import { useMemo, useState } from "react";
import { Ban, Briefcase, Handshake, Heart, Truck, UserPlus, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FilterChips } from "@/components/ui/FilterChips";
import { SearchInput } from "@/components/ui/SearchInput";
import { Switch } from "@/components/ui/Switch";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RELATION_TONE, asContactRelation, relationLabel } from "@/lib/contactRelationUi";
import {
  TRIAGE_CHOICE_LABEL,
  countChoices,
  filterTriageRows,
  type TriageChoice,
  type TriageRow,
} from "@/lib/phoneContactsTriage";
import { formatPhoneForDisplay } from "../../../../convex/lib/phone";

/** Quem da lista já está no CRM (chave da linha → contato encontrado). */
export interface ExistingMatch {
  contactId: string;
  name: string | null;
  relation: string | null;
  /** O contato tem lead aberto (mudar o tipo exige editar todos os leads). */
  hasOpenLead: boolean;
}

export type TriageFilter = "all" | "pending" | "family" | "existing" | "chosen" | "skip";

const PAGE = 50;

const ACTIONS: Array<{ choice: TriageChoice; icon: LucideIcon; variant: "primary" | "secondary" | "ghost" }> = [
  { choice: "lead", icon: UserPlus, variant: "primary" },
  { choice: "personal", icon: Heart, variant: "secondary" },
  { choice: "team", icon: Users, variant: "secondary" },
  { choice: "supplier", icon: Truck, variant: "secondary" },
  { choice: "partner", icon: Handshake, variant: "secondary" },
  { choice: "skip", icon: Ban, variant: "ghost" },
];

const CHOICE_TONE: Record<TriageChoice, "brand" | "info" | "success" | "warning" | "default"> = {
  lead: "brand",
  personal: "info",
  team: "brand",
  supplier: "warning",
  partner: "success",
  skip: "default",
};

/** Linhas que passam pelo chip ativo. */
export function rowsForFilter(
  rows: readonly TriageRow[],
  filter: TriageFilter,
  choices: Readonly<Record<string, TriageChoice | undefined>>,
  existing: ReadonlyMap<string, ExistingMatch>,
): TriageRow[] {
  switch (filter) {
    case "pending":
      return rows.filter((r) => !choices[r.key]);
    case "family":
      return rows.filter((r) => r.familyHint);
    case "existing":
      return rows.filter((r) => existing.has(r.key));
    case "chosen":
      return rows.filter((r) => choices[r.key] && choices[r.key] !== "skip");
    case "skip":
      return rows.filter((r) => choices[r.key] === "skip");
    default:
      return [...rows];
  }
}

export interface PhoneImportTriageViewProps {
  rows: readonly TriageRow[];
  choices: Readonly<Record<string, TriageChoice | undefined>>;
  onChoose: (keys: string[], choice: TriageChoice) => void;
  existing: ReadonlyMap<string, ExistingMatch>;
  /** Consulta "já está no CRM" ainda rodando (processados/total). */
  matching: { done: number; total: number } | null;
  createLeads: boolean;
  onCreateLeadsChange: (value: boolean) => void;
  /** `leads: edit_all` ou `contacts: full`: cria leads e muda o tipo de quem tem lead aberto. */
  canChangeLeads: boolean;
  useAgendaNames: boolean;
  onUseAgendaNamesChange: (value: boolean) => void;
  maxRows: number;
  submitting: boolean;
  onSubmit: () => void;
  onRestart: () => void;
}

/**
 * Triagem dos contatos do celular: busca, chips, seleção em massa e as ações
 * Lead/Pessoal/Equipe/Fornecedor/Parceiro/Não importar. Sem Convex (o
 * container cuida das consultas e do envio).
 */
export function PhoneImportTriageView({
  rows,
  choices,
  onChoose,
  existing,
  matching,
  createLeads,
  onCreateLeadsChange,
  canChangeLeads,
  useAgendaNames,
  onUseAgendaNamesChange,
  maxRows,
  submitting,
  onSubmit,
  onRestart,
}: PhoneImportTriageViewProps) {
  const [filter, setFilter] = useState<TriageFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [visible, setVisible] = useState(PAGE);

  const counts = useMemo(() => countChoices(rows, choices), [rows, choices]);
  const familyCount = useMemo(() => rows.filter((r) => r.familyHint).length, [rows]);
  const filtered = useMemo(
    () => filterTriageRows(rowsForFilter(rows, filter, choices, existing), query),
    [rows, filter, choices, existing, query],
  );
  const shown = filtered.slice(0, visible);
  const selectedInView = filtered.filter((r) => selected.has(r.key)).length;
  const allInViewSelected = filtered.length > 0 && selectedInView === filtered.length;
  const toImport = rows.length - counts.pending - counts.skip;

  const changeFilter = (id: string) => {
    setFilter((current) => (current === id ? "all" : (id as TriageFilter)));
    setVisible(PAGE);
  };

  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const selectAllInView = () => setSelected(new Set(filtered.map((r) => r.key)));
  const selectNone = () => setSelected(new Set());

  const apply = (choice: TriageChoice) => {
    const keys = filtered.filter((r) => selected.has(r.key)).map((r) => r.key);
    if (keys.length === 0) return;
    onChoose(keys, choice);
    setSelected(new Set());
  };

  const chips = [
    { id: "all", label: "Todos", pressed: filter === "all", count: rows.length },
    { id: "pending", label: "A decidir", pressed: filter === "pending", count: counts.pending },
    ...(familyCount > 0
      ? [{ id: "family", label: "Parecem família", pressed: filter === "family", count: familyCount }]
      : []),
    { id: "existing", label: "Já no CRM", pressed: filter === "existing", count: existing.size },
    { id: "chosen", label: "Vão entrar", pressed: filter === "chosen", count: toImport },
    { id: "skip", label: "Não importar", pressed: filter === "skip", count: counts.skip },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <SearchInput
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setVisible(PAGE);
          }}
          placeholder="Buscar por nome, telefone ou e-mail…"
          ariaLabel="Buscar nos contatos do celular"
        />
        <FilterChips chips={chips} onToggle={changeFilter} ariaLabel="Filtrar contatos do celular" />
        {matching && (
          <p className="text-caption text-text-muted tabular-nums" role="status">
            Procurando quem já está no CRM… {formatCount(matching.done)} de {formatCount(matching.total)}
          </p>
        )}
      </div>

      {/* Seleção e ações em massa */}
      <div className="rounded-card border border-border bg-surface-raised p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={allInViewSelected ? selectNone : selectAllInView}
            disabled={filtered.length === 0}
          >
            {allInViewSelected ? "Selecionar nenhum" : `Selecionar todos (${formatCount(filtered.length)})`}
          </Button>
          {selectedInView > 0 && !allInViewSelected && (
            <Button variant="ghost" size="sm" onClick={selectNone}>
              Selecionar nenhum
            </Button>
          )}
          <span className="text-caption text-text-muted tabular-nums" aria-live="polite">
            {selectedInView > 0 ? `${formatCount(selectedInView)} selecionado(s)` : "Toque nos contatos para selecionar"}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {ACTIONS.map(({ choice, icon: Icon, variant }) => (
            <Button
              key={choice}
              variant={variant}
              size="lg"
              className="w-full justify-center"
              disabled={selectedInView === 0}
              onClick={() => apply(choice)}
            >
              <Icon size={18} aria-hidden="true" />
              {choice === "skip" ? TRIAGE_CHOICE_LABEL.skip : `Como ${TRIAGE_CHOICE_LABEL[choice]}`}
            </Button>
          ))}
        </div>
      </div>

      {/* Lista */}
      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-secondary">Nenhum contato neste filtro.</p>
      ) : (
        <ul className="divide-y divide-border-subtle overflow-hidden rounded-card border border-border bg-surface-raised">
          {shown.map((row) => (
            <TriageRowItem
              key={row.key}
              row={row}
              choice={choices[row.key]}
              match={existing.get(row.key)}
              selected={selected.has(row.key)}
              onToggle={() => toggle(row.key)}
            />
          ))}
        </ul>
      )}
      {filtered.length > shown.length && (
        <Button variant="secondary" size="lg" onClick={() => setVisible((v) => v + PAGE)}>
          Mostrar mais ({formatCount(filtered.length - shown.length)} restantes)
        </Button>
      )}

      {/* Opções e envio */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-raised p-4">
        <Switch
          checked={createLeads && canChangeLeads}
          onCheckedChange={onCreateLeadsChange}
          disabled={!canChangeLeads}
          label="Criar lead no funil para quem for Lead"
          description={
            canChangeLeads
              ? "Desligado: quem for Lead entra só como contato, sem negócio no funil."
              : "Precisa da permissão de editar todos os leads. Quem for Lead entra só como contato."
          }
        />
        {!canChangeLeads && (
          <p className="text-caption text-text-muted">
            Contatos que já têm lead aberto ganham os dados que faltam, mas mantêm o tipo atual: mudar isso precisa da
            permissão de editar todos os leads.
          </p>
        )}
        <Switch
          checked={useAgendaNames}
          onCheckedChange={onUseAgendaNamesChange}
          label="Usar os nomes da agenda nos contatos que já existem"
          description="Desligado: o nome só é preenchido quando o contato está sem nome."
        />
        <p className="text-caption text-text-muted">
          Nenhuma mensagem é enviada. Todos ganham a etiqueta "importado-celular" e a importação pode ser desfeita.
        </p>
        <p className="text-sm text-text-secondary tabular-nums">
          {formatCount(toImport)} vão entrar
          {toImport > 0 && (
            <>
              {" "}
              ({(["lead", "personal", "team", "supplier", "partner"] as const)
                .filter((c) => counts[c] > 0)
                .map((c) => `${formatCount(counts[c])} ${TRIAGE_CHOICE_LABEL[c]}`)
                .join(" · ")}
              )
            </>
          )}
          {counts.pending > 0 && ` · ${formatCount(counts.pending)} a decidir ficam de fora`}
        </p>
        {toImport > maxRows && (
          <p className="text-sm text-semantic-warning" role="alert">
            Escolha no máximo {formatCount(maxRows)} por vez. Importe uma parte e depois o resto.
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="lg" onClick={onRestart} disabled={submitting}>
            Escolher outro arquivo
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={onSubmit}
            loading={submitting}
            disabled={toImport === 0 || toImport > maxRows}
          >
            <Briefcase size={18} aria-hidden="true" />
            Importar {formatCount(toImport)} contato(s)
          </Button>
        </div>
      </div>
    </div>
  );
}

interface TriageRowItemProps {
  row: TriageRow;
  choice: TriageChoice | undefined;
  match: ExistingMatch | undefined;
  selected: boolean;
  onToggle: () => void;
}

function TriageRowItem({ row, choice, match, selected, onToggle }: TriageRowItemProps) {
  const matchRelation = asContactRelation(match?.relation);
  const contactLine = [
    row.phones[0] ? formatPhoneForDisplay(row.phones[0]) : row.emails[0],
    row.phones.length + row.emails.length > 1 ? `+${row.phones.length + row.emails.length - 1}` : null,
    row.company,
  ]
    .filter(Boolean)
    .join(" · ");
  const inputId = `triage-${row.key}`;

  return (
    <li className={cn("transition-colors", selected && "bg-brand-500/10")}>
      <label htmlFor={inputId} className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2.5">
        {/* Input nativo: a linha inteira é o rótulo (o `Checkbox` traz o seu próprio <label>). */}
        <input
          id={inputId}
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="h-5 w-5 shrink-0 cursor-pointer rounded accent-brand-600"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary" title={row.displayName}>
            {row.displayName}
          </span>
          <span className="block truncate text-caption text-text-muted tabular-nums">{contactLine}</span>
          {(match || (row.familyHint && choice === "personal")) && (
            <span className="mt-1 flex flex-wrap gap-1">
              {match && (
                <Badge variant={matchRelation ? RELATION_TONE[matchRelation] : "default"}>
                  Já no CRM · {relationLabel(matchRelation)}
                </Badge>
              )}
              {match?.hasOpenLead && <Badge variant="default">Tem lead aberto</Badge>}
              {row.familyHint && choice === "personal" && <Badge variant="default">Sugestão</Badge>}
            </span>
          )}
        </span>
        {choice ? (
          <Badge variant={CHOICE_TONE[choice]} className="shrink-0">
            {TRIAGE_CHOICE_LABEL[choice]}
          </Badge>
        ) : (
          <span className="shrink-0 text-caption text-text-muted">A decidir</span>
        )}
      </label>
    </li>
  );
}
