import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { ArrowLeft, ChevronDown, ChevronUp, FileText, Image as ImageIcon, Mic, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { useConversationInteraction } from "@/components/inbox/conversationInteraction";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatDateTime } from "@/lib/format";
import { SEARCH_MESSAGES_CAP, jumpableMatches, matchCounterLabel, readingMatchInfo, snippetWindow, stepMatch } from "@/lib/inboxSearch";
import { cn } from "@/lib/utils";

const iconButton =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 md:h-9 md:w-9";

export interface ConversationSearchMatch {
  _id: string;
  createdAt: number;
  snippetText: string;
  matchedTranscript?: boolean;
  matchedImage?: boolean;
  contentType?: string;
}

export interface ConversationSearchBarViewProps {
  text: string;
  onTextChange: (text: string) => void;
  /** Termo com 2+ letras (com debounce): só então há contador e setas. */
  active: boolean;
  /** Só as que o thread consegue mostrar; `undefined` enquanto carrega. */
  matches: readonly ConversationSearchMatch[] | undefined;
  /** O servidor devolveu o lote cheio: o contador vira "N de 50+". */
  capped?: boolean;
  index: number;
  term: string;
  onOlder: () => void;
  onNewer: () => void;
  onClose: () => void;
}

/**
 * Barra de pesquisa da conversa (estilo WhatsApp), apresentacional: voltar,
 * campo, "3 de 12", ▲ (mais antiga) ▼ (mais recente), fechar; abaixo, o trecho
 * do resultado atual com o termo destacado (vale também quando a mensagem é
 * antiga demais para o thread rolar até ela).
 */
export function ConversationSearchBarView({
  text,
  onTextChange,
  active,
  matches,
  capped = false,
  index,
  term,
  onOlder,
  onNewer,
  onClose,
}: ConversationSearchBarViewProps) {
  const total = matches?.length ?? 0;
  const current = active && matches && total > 0 ? matches[Math.min(index, total - 1)] : null;
  const counter = !active ? null : matches === undefined ? "…" : total === 0 ? "Nenhum resultado" : matchCounterLabel(index, total, capped);
  const snippet = current ? snippetWindow(current.snippetText, term) : null;
  return (
    <div role="search" aria-label="Pesquisar na conversa">
      <div className="flex min-h-14 items-center gap-1 px-1 pt-[env(safe-area-inset-top)] md:min-h-16 md:gap-2 md:px-4 md:pt-0">
        <button type="button" onClick={onClose} aria-label="Fechar pesquisa" className={cn(iconButton, "text-text-primary md:hidden")}>
          <ArrowLeft size={22} aria-hidden />
        </button>
        <input
          type="search"
          autoFocus
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) onNewer();
              else onOlder();
            }
          }}
          enterKeyHint="search"
          autoComplete="off"
          placeholder="Pesquisar na conversa…"
          aria-label="Pesquisar na conversa"
          className="h-10 min-w-0 flex-1 rounded-full border border-border-strong bg-surface-sunken px-4 text-base text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 md:h-9 md:text-sm"
        />
        {counter !== null && (
          <span className="shrink-0 px-1 text-xs text-text-muted tabular-nums" aria-live="polite">
            {counter}
          </span>
        )}
        <button type="button" onClick={onOlder} disabled={total === 0 || !active} aria-label="Resultado mais antigo" className={iconButton}>
          <ChevronUp size={20} aria-hidden />
        </button>
        <button type="button" onClick={onNewer} disabled={total === 0 || !active} aria-label="Resultado mais recente" className={iconButton}>
          <ChevronDown size={20} aria-hidden />
        </button>
        <button type="button" onClick={onClose} aria-label="Fechar pesquisa" className={cn(iconButton, "hidden md:flex")}>
          <X size={18} aria-hidden />
        </button>
      </div>
      {current && snippet && (
        <p className="flex items-center gap-1.5 px-4 pb-1.5 text-xs text-text-secondary">
          <span className="shrink-0 text-text-muted tabular-nums">{formatDateTime(current.createdAt)}</span>
          {current.matchedTranscript && <Mic size={12} className="shrink-0 text-text-muted" aria-label="Encontrado na transcrição" />}
          {current.matchedImage &&
            (readingMatchInfo(current.contentType).kind === "file" ? (
              <FileText size={12} className="shrink-0 text-text-muted" aria-label={readingMatchInfo(current.contentType).label} />
            ) : (
              <ImageIcon size={12} className="shrink-0 text-text-muted" aria-label={readingMatchInfo(current.contentType).label} />
            ))}
          <span className="min-w-0 truncate">
            {snippet.ellipsis ? "…" : ""}
            {snippet.before}
            {snippet.match && <mark className="rounded bg-brand-500/30 px-0.5 text-text-primary">{snippet.match}</mark>}
            {snippet.after}
          </span>
        </p>
      )}
    </div>
  );
}

interface ConversationSearchBarProps {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  onClose: () => void;
}

/**
 * Container: `searchMessages` com `conversationId` e salto do thread até o
 * resultado (`requestJump`: o thread sobe o histórico até 500 mensagens e pisca
 * a bolha; além disso avisa por toast e o trecho fica à vista na barra).
 */
export function ConversationSearchBar({ organizationId, conversationId, onClose }: ConversationSearchBarProps) {
  const { requestJump } = useConversationInteraction();
  const [text, setText] = useState("");
  const term = useDebouncedValue(text.trim(), 300);
  const active = term.length >= 2;
  const raw = useQuery(
    api.conversations.searchMessages,
    active ? { organizationId, conversationId, searchQuery: term } : "skip"
  );
  // Rascunho da IA e transferência não são bolha: o thread não tem para onde saltar.
  const matches = useMemo(() => (raw ? jumpableMatches(raw) : undefined), [raw]);
  const capped = (raw?.length ?? 0) >= SEARCH_MESSAGES_CAP;
  // O resultado atual é guardado pelo id: uma mensagem nova que case não muda o alvo.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const foundIndex = matches && currentId ? matches.findIndex((m) => m._id === currentId) : -1;
  const index = foundIndex >= 0 ? foundIndex : 0;

  // Termo novo: vai direto para a ocorrência mais recente.
  const jumpedTermRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active) {
      jumpedTermRef.current = null;
      return;
    }
    if (!matches || matches.length === 0) return;
    if (jumpedTermRef.current === term) return;
    jumpedTermRef.current = term;
    setCurrentId(matches[0]._id);
    requestJump(matches[0]._id);
  }, [active, matches, term, requestJump]);

  const go = (direction: "older" | "newer") => {
    if (!matches || matches.length === 0) return;
    const next = matches[stepMatch(index, matches.length, direction)];
    setCurrentId(next._id);
    requestJump(next._id);
  };

  return (
    <ConversationSearchBarView
      text={text}
      onTextChange={setText}
      active={active}
      matches={matches}
      capped={capped}
      index={index}
      term={term}
      onOlder={() => go("older")}
      onNewer={() => go("newer")}
      onClose={onClose}
    />
  );
}
