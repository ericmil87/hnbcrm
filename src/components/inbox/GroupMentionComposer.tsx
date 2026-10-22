import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { AtSign } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { filterMentionCandidates, mentionResultsPending } from "@/lib/groupMentionFilter";
import {
  groupSenderColor,
  initialsOf,
  maskPhone,
  participantDisplayName,
  participantKeyOf,
} from "@/lib/groupDisplay";
import type { GroupParticipant } from "./types";

/**
 * Menção a membro no composer do grupo.
 *
 * Diferente do `@` de nota interna (que grava o token `@[Nome](memberId)` e
 * resolve depois): aqui o texto que vai para o WhatsApp é literal, então o
 * que entra no corpo é só `@<nome>` e o que faz o WhatsApp destacar e
 * notificar é a lista de JIDs em `mentions[]`, paralela ao texto.
 *
 * A consequência prática é que apagar o "@Fulano" do texto precisa apagar o
 * JID junto — `syncMentions` faz essa reconciliação a cada envio, comparando
 * o que sobrou no texto com o que foi escolhido no dropdown.
 *
 * Perf (Convex I/O, onda 2): a lista de candidatos NÃO vem mais da sala
 * inteira (até 1.024 membros via `getGroup`). Depois do "@" + 1 caractere, o
 * hook busca no servidor (`groupChats.listGroupMembers` com `search`, página de
 * 20). A menção continua saindo pelo `lid`/`phone` da linha, e o servidor
 * revalida contra a tabela no envio (`lib/groupGuard.ts resolveGroupMentions`).
 */

/** Quantos candidatos a busca do "@" pede ao servidor (mostra 8). */
const MENTION_SEARCH_PAGE = 20;

export interface GroupMentionChoice {
  /** JID que vai em `ContextInfo.MentionedJID` (LID ou telefone@s.whatsapp.net). */
  jid: string;
  /** O rótulo digitado no texto, sem o "@". */
  label: string;
}

interface UseGroupMentionsArgs {
  /** Sala da conversa; ausente = sem busca (conversa 1 a 1). */
  groupChatId?: Id<"groupChats">;
  value: string;
  /** Aplica o texto novo (com a menção inserida) e reposiciona o cursor. */
  onChange: (value: string, cursorPosition: number) => void;
  enabled?: boolean;
}

/**
 * JID de envio de um participante. O LID é a chave estável no modo `lid`; sem
 * ele, o telefone vira JID de usuário. Membro sem nenhum dos dois não é
 * mencionável.
 */
export function participantJid(p: GroupParticipant): string | null {
  if (p.lid) return p.lid;
  if (p.phone) return `${p.phone.replace(/\D/g, "")}@s.whatsapp.net`;
  return null;
}

export function useGroupMentions({
  groupChatId,
  value,
  onChange,
  enabled = true,
}: UseGroupMentionsArgs) {
  const [chosen, setChosen] = useState<GroupMentionChoice[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);

  // Gatilho: "@" no início ou depois de espaço, seguido do que já foi digitado
  // (sem espaço — nome composto se resolve escolhendo no dropdown).
  const trigger = useMemo(() => {
    if (!enabled) return null;
    const pos = cursor ?? value.length;
    const before = value.slice(0, pos);
    const at = before.lastIndexOf("@");
    if (at === -1) return null;
    if (at > 0 && !/\s/.test(before[at - 1])) return null;
    const query = before.slice(at + 1);
    if (/[\s@]/.test(query)) return null;
    return { at, query, pos };
  }, [enabled, value, cursor]);

  // Busca sob demanda: só com "@" + ≥ 1 caractere (debounce curto para não
  // disparar uma query por tecla).
  const searchTerm = useDebouncedValue(trigger?.query ?? "", 200);
  const searchArgs =
    groupChatId && trigger && trigger.query.length >= 1 && searchTerm.length >= 1
      ? {
          groupChatId,
          search: searchTerm,
          paginationOpts: { numItems: MENTION_SEARCH_PAGE, cursor: null },
        }
      : "skip";
  const found = useQuery(api.groupChats.listGroupMembers, searchArgs);
  // Enquanto a próxima busca carrega, mantém os candidatos da anterior (sem
  // piscar o dropdown a cada tecla) — mas REFILTRADOS pelo termo atual: o
  // resultado de "@Ma" não pode deixar "@Mari"+Enter mencionar o "Marcos".
  const lastFound = useRef<GroupParticipant[]>([]);
  if (found !== undefined) lastFound.current = found.page as GroupParticipant[];
  const candidates: GroupParticipant[] =
    searchArgs === "skip" ? [] : ((found?.page as GroupParticipant[] | undefined) ?? lastFound.current);
  // A lista exibida ainda não é a do termo digitado agora (debounce ou servidor).
  const pending =
    searchArgs !== "skip" &&
    mentionResultsPending({
      query: trigger?.query ?? "",
      searchedTerm: searchTerm,
      loaded: found !== undefined,
    });

  const items = useMemo(() => {
    if (!trigger) return [];
    return filterMentionCandidates(
      candidates.filter((p) => p.leftAt === undefined && participantJid(p) !== null),
      trigger.query
    )
      .map((p) => ({
        participant: p,
        key: participantKeyOf(p),
        label: participantDisplayName(p),
      }))
      .slice(0, 8);
  }, [trigger, candidates]);

  const open = trigger !== null && (items.length > 0 || pending);

  useEffect(() => setActiveIndex(0), [trigger?.query, open]);

  const pick = useCallback(
    (row: { participant: GroupParticipant; label: string }) => {
      if (!trigger) return;
      const jid = participantJid(row.participant);
      if (!jid) return;
      // Sem espaço no rótulo: o WhatsApp corta a menção no espaço e "@João
      // Silva" destacaria só "@João". Nome composto vira o primeiro nome.
      //
      // Duas correções do review:
      //  - membro SEM PushName tinha o telefone MASCARADO como rótulo, e o
      //    texto enviado saía literalmente "@••••5729". Agora vai o número,
      //    que é o formato nativo da menção no WhatsApp.
      //  - dois "João" na sala produziam o MESMO rótulo, e `mentionsFor`
      //    notificava os dois com uma menção só. O segundo ganha os 4 últimos
      //    dígitos como desempate.
      const digits = (row.participant.phone ?? "").replace(/\D/g, "");
      const named = !!(row.participant.name && row.participant.name.trim());
      const base = named ? row.label.split(" ")[0] || row.label : digits || "membro";
      const taken = chosen.some((c) => c.label === base && c.jid !== jid);
      const label = taken && digits ? `${base}-${digits.slice(-4)}` : base;
      const token = `@${label} `;
      const next = value.slice(0, trigger.at) + token + value.slice(trigger.pos);
      const nextCursor = trigger.at + token.length;
      setChosen((prev) =>
        prev.some((c) => c.jid === jid) ? prev : [...prev, { jid, label }]
      );
      setCursor(nextCursor);
      onChange(next, nextCursor);
    },
    [trigger, value, onChange, chosen]
  );

  /** Trata a navegação do dropdown; true quando consumiu a tecla. */
  const handleKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) setActiveIndex((i) => (i + 1) % items.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) setActiveIndex((i) => (i - 1 + items.length) % items.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      // Lista ainda do termo anterior: não escolhe ninguém (o dropdown mostra
      // "buscando…"); a tecla é consumida para não enviar a mensagem no meio.
      if (pending || !items[activeIndex]) return true;
      pick(items[activeIndex]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setCursor(null);
      setChosen((prev) => prev);
      return true;
    }
    return false;
  };

  /**
   * JIDs que ainda estão no texto na hora do envio. Quem apagou o "@Fulano"
   * não quer mais mencionar o Fulano.
   */
  const mentionsFor = useCallback(
    (text: string): string[] => {
      const lower = text.toLowerCase();
      // Rótulos são únicos por JID (ver `pick`), então cada um casa uma pessoa
      // só. Dedupe por JID mesmo assim: escolher o mesmo membro duas vezes não
      // pode mandar o JID repetido ao gateway.
      const jids = chosen
        .filter((c) => lower.includes(`@${c.label.toLowerCase()}`))
        .map((c) => c.jid);
      return Array.from(new Set(jids));
    },
    [chosen]
  );

  const reset = useCallback(() => {
    setChosen([]);
    setCursor(null);
  }, []);

  return {
    open,
    items,
    /** A lista exibida ainda não corresponde ao termo atual (Enter bloqueado). */
    pending,
    activeIndex,
    pick,
    handleKeyDown,
    mentionsFor,
    reset,
    /** Sincroniza a posição do cursor a cada digitação/clique no textarea. */
    setCursor,
  };
}

interface GroupMentionDropdownProps {
  open: boolean;
  items: { participant: GroupParticipant; key: string; label: string }[];
  activeIndex: number;
  onPick: (row: { participant: GroupParticipant; key: string; label: string }) => void;
  /** Busca do termo atual em andamento: mostra "buscando…" no rodapé. */
  pending?: boolean;
}

/** Dropdown ancorado acima do composer — o pai precisa de um container relative. */
export function GroupMentionDropdown({
  open,
  items,
  activeIndex,
  onPick,
  pending = false,
}: GroupMentionDropdownProps) {
  if (!open) return null;
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-40 max-h-56 overflow-y-auto rounded-xl border border-border bg-surface-overlay shadow-elevated">
      {items.map((row, index) => (
        <button
          key={row.key}
          type="button"
          // onMouseDown para ganhar do blur do textarea
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(row);
          }}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
            index === activeIndex ? "bg-brand-500/10" : "hover:bg-surface-raised"
          )}
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
            style={{ backgroundColor: groupSenderColor(row.key) }}
            aria-hidden
          >
            {initialsOf(row.label)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-text-primary">{row.label}</span>
            {row.participant.phone && (
              <span className="block text-[11px] text-text-muted tabular-nums">
                {maskPhone(row.participant.phone)}
              </span>
            )}
          </span>
          <AtSign size={13} className="shrink-0 text-text-muted" />
        </button>
      ))}
      {pending && (
        <div className="px-3 py-2 text-xs text-text-muted" role="status">
          Buscando…
        </div>
      )}
    </div>
  );
}
