import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Home, PencilLine, Sparkles, UserCheck, UserRoundCheck, Undo2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { AiStatusChip } from "@/components/inbox/AiStatusChip";
import type { ConversationAiControls } from "@/components/inbox/useConversationAiControls";
import { Popover } from "@/components/ui/Popover";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { formatFollowUpDueAt } from "@/lib/followUp";
import { aiStateChipInfo, rowAiMode, type AiConvState } from "@/lib/inboxState";
import {
  aiMenuModel,
  aiQuiet,
  aiStateLine,
  aiTriggerLabel,
  offBusinessRelation,
  type AiMenuItem,
  type ContactRelation,
} from "@/lib/contactRelationUi";
import { cn } from "@/lib/utils";

interface AiControlMenuProps {
  conversationId: Id<"conversations">;
  aiPausedUntil?: number;
  /** `aiMode` da conversa (`getConversationById`): "off" sem pausa = a IA não atende (não é "IA ativa"). */
  aiMode?: string | null;
  hasPendingDraft: boolean;
  aiState: AiConvState;
  /** Sem `inbox:reply` o menu só informa o estado. */
  canReply: boolean;
  /** `contacts:edit`: "Não é cliente…", "Virar lead", "Trocar tipo…". */
  canEditContact: boolean;
  /** Tipo do contato (Pessoal, Equipe… desligam a IA). */
  relation?: ContactRelation;
  /** Ações compartilhadas com o menu ⋮ (`useConversationAiControls`). */
  controls: ConversationAiControls;
}

const rowClass =
  "flex w-full min-h-11 items-center gap-2.5 px-4 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500";

/**
 * Controle da IA no cabeçalho da conversa: botão com texto ("IA ativa", "IA
 * pausada", "IA desligada · Pessoal") no celular e no computador, que abre o
 * estado, as ações (assumir, devolver, pedir sugestão), "Não é cliente…" e,
 * num contato marcado, "Virar lead" e "Trocar tipo…".
 */
export function AiControlMenu({
  conversationId,
  aiPausedUntil,
  aiMode,
  hasPendingDraft,
  aiState,
  canReply,
  canEditContact,
  relation,
  controls,
}: AiControlMenuProps) {
  const now = Date.now();
  const paused = aiPausedUntil !== undefined && aiPausedUntil > now;
  // Mesma regra da lista (`rowAiMode`); só muda o RÓTULO, as ações seguem as de `paused`.
  const off = !paused && !!aiMode && rowAiMode({ aiMode, aiPausedUntil }, now) === "off";
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const followUps = useQuery(api.attendantFollowUp.listForConversation, { conversationId });

  const processing = aiState?.status === "pending" || aiState?.status === "processing";
  // Contato que não é cliente: vale "IA desligada · <Tipo>", nunca "IA em espera".
  const waiting =
    !offBusinessRelation(relation) &&
    aiStateChipInfo(aiState)?.tone === "waiting" &&
    !(paused && aiState?.reason === "ia_pausada");
  const state = { paused, off, waiting, relation };
  const quiet = aiQuiet(state);
  const triggerLabel = aiTriggerLabel(state);
  const [labelMain, labelType] = triggerLabel.split(" · ");
  const model = aiMenuModel({ ...state, hasPendingDraft, canReply, canEditContact });

  const select = (item: AiMenuItem) => {
    setOpen(false);
    if (item === "assume") controls.assume();
    else if (item === "return") controls.openReturn(anchor);
    else if (item === "ask") controls.openAsk(anchor);
    else if (item === "turnLead") controls.turnLead();
    else controls.openRelationSheet();
  };

  const followUpText =
    followUps && followUps.length > 0
      ? followUps.length === 1
        ? `Follow-up da IA: ${formatFollowUpDueAt(followUps[0].dueAt)}`
        : `${followUps.length} follow-ups da IA`
      : null;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${triggerLabel}. Abrir controles da IA`}
        className={cn(
          "relative inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium transition-colors hover:bg-surface-overlay md:h-9 md:px-3 md:bg-surface-overlay/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          quiet ? "text-text-muted" : "text-ai-400",
          processing && "motion-safe:animate-pulse",
          open && "bg-surface-overlay"
        )}
      >
        <Sparkles size={14} aria-hidden className="shrink-0" />
        {/* Celular: "IA desligada" sobre o tipo, em duas linhas curtas; computador: uma linha. */}
        <span className="flex flex-col items-start leading-tight md:flex-row md:items-center md:gap-1">
          <span className="whitespace-nowrap">{labelMain}</span>
          {labelType && (
            <>
              <span aria-hidden className="hidden md:inline">
                ·
              </span>
              <span className="whitespace-nowrap text-micro md:text-xs">{labelType}</span>
            </>
          )}
        </span>
        {waiting && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-semantic-warning" />}
      </button>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
        align="end"
        sheet={isMobile}
        role="dialog"
        aria-label="Controles da IA"
        className={cn("py-2", !isMobile && "w-72")}
      >
        <div className="flex flex-col">
          <div className="flex items-center gap-2 px-4 pb-2 pt-1 text-sm font-medium text-text-primary">
            <Sparkles size={16} aria-hidden className={quiet ? "text-text-muted" : "text-ai-400"} />
            {aiStateLine(state)}
          </div>
          {!offBusinessRelation(relation) && (
            <div className="px-4 pb-2 empty:hidden">
              <AiStatusChip state={aiState} paused={paused} />
            </div>
          )}
          {model.primary.length > 0 && (
            <div className="border-t border-border pt-1">
              {model.primary.map((item) => (
                <AiMenuRow key={item} item={item} onSelect={select} />
              ))}
            </div>
          )}
          {model.secondary.length > 0 && (
            <div className="mt-1 border-t border-border pt-1">
              {model.secondary.map((item) => (
                <AiMenuRow key={item} item={item} onSelect={select} />
              ))}
            </div>
          )}
          {followUpText && (
            <p className="border-t border-border px-4 pt-2 text-xs text-text-muted">{followUpText}</p>
          )}
        </div>
      </Popover>
    </>
  );
}

const ITEM_META: Record<AiMenuItem, { label: string; Icon: typeof Sparkles }> = {
  assume: { label: "Assumir conversa", Icon: UserRoundCheck },
  return: { label: "Devolver à IA", Icon: Undo2 },
  ask: { label: "Pedir resposta sugerida", Icon: Sparkles },
  turnLead: { label: "Virar lead", Icon: UserCheck },
  changeType: { label: "Trocar tipo…", Icon: PencilLine },
  notCustomer: { label: "Não é cliente…", Icon: Home },
};

/** Rótulo e ícone de um item dos menus da IA (botão da IA e ⋮). */
export function aiMenuItemMeta(item: AiMenuItem) {
  return ITEM_META[item];
}

function AiMenuRow({ item, onSelect }: { item: AiMenuItem; onSelect: (item: AiMenuItem) => void }) {
  const { label, Icon } = ITEM_META[item];
  return (
    <button
      type="button"
      className={cn(rowClass, item === "turnLead" && "font-medium text-brand-500")}
      onClick={() => onSelect(item)}
    >
      <Icon size={16} aria-hidden />
      {label}
    </button>
  );
}
