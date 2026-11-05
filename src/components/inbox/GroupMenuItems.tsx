import { useMutation } from "convex/react";
import { EyeOff, LogOut, Send, Sparkles, Users } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Tooltip } from "@/components/ui/Tooltip";
import { mutationErrorMessage } from "@/lib/errors";
import { VOCAB } from "@/lib/vocab";

export interface GroupMenuActions {
  /** Mexer na sala (acompanhar, entrar, sair) é `settings:manage` (D11). */
  canManageGroups: boolean;
  /** Disparar para os membros é campanha (F5), não configuração de canal. */
  canManageCampaigns: boolean;
  /** `inbox:reply`: devolver a sala à IA. */
  canReply: boolean;
  groupAiEnabled: boolean;
  /** A sala está com a IA em silêncio? (aceitar repasse pausa por 24 h) */
  groupAiPaused: boolean;
  onOpenMembers: () => void;
  onOpenSummary: () => void;
  onUnmonitor: () => void;
  onLeave: () => void;
  onDispatch: () => void;
}

const itemClass =
  "w-full flex items-center gap-2.5 px-3 py-2 coarse:min-h-11 text-left text-sm text-text-primary hover:bg-surface-raised transition-colors";

/**
 * Itens de grupo no menu "⋮" da conversa. Parar de acompanhar e sair pedem
 * confirmação (sair é irreversível pelo CRM — voltar exige convite novo) e
 * exigem `settings:manage`, o mesmo gate do backend.
 */
export function GroupMenuItems({
  close,
  conversationId,
  actions,
}: {
  close: () => void;
  conversationId: Id<"conversations">;
  actions: GroupMenuActions;
}) {
  const returnToAi = useMutation(api.attendant.returnToAi);
  const { groupAiEnabled, canManageCampaigns, canManageGroups, canReply, groupAiPaused } = actions;

  const handleReturnGroupToAi = async () => {
    try {
      await returnToAi({ conversationId });
      toast.success("A IA volta a responder quando for mencionada na sala");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível devolver à IA. Tente de novo."));
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          close();
          actions.onOpenMembers();
        }}
        className={itemClass}
      >
        <Users size={15} />
        Ver membros
      </button>
      {/*
        Resumo por IA (F4). Fica visível mesmo com a IA de grupos desligada,
        mas desabilitado com o motivo — esconder o item faria a pessoa procurar
        um recurso que existe e ela não sabe como ligar.
      */}
      {groupAiEnabled ? (
        <button
          type="button"
          onClick={() => {
            close();
            actions.onOpenSummary();
          }}
          className={itemClass}
        >
          <Sparkles size={15} />
          Resumo por IA
        </button>
      ) : (
        <Tooltip
          content="Ative a IA em grupos em Configurações → IA para usar o resumo"
          wrapperClassName="flex w-full"
          asInfo
        >
          <button
            type="button"
            disabled
            className="w-full flex items-center gap-2.5 px-3 py-2 coarse:min-h-11 text-left text-sm text-text-muted opacity-60 cursor-not-allowed"
          >
            <Sparkles size={15} />
            Resumo por IA
            <span className="ml-auto text-micro uppercase tracking-wide">IA desligada</span>
          </button>
        </Tooltip>
      )}
      {canManageCampaigns && (
        <button
          type="button"
          onClick={() => {
            close();
            actions.onDispatch();
          }}
          className={itemClass}
        >
          <Send size={15} />
          Disparar 1 a 1 para os membros
        </button>
      )}
      {/*
        "Devolver à IA" numa sala (review de correção nº 6). Aceitar um repasse
        de grupo silencia a IA por 24 h; sem este item, não havia como devolver
        antes disso — o único caminho era esperar. Só aparece quando a sala está
        de fato pausada.
      */}
      {canReply && groupAiPaused && (
        <button
          type="button"
          onClick={() => {
            close();
            void handleReturnGroupToAi();
          }}
          className={itemClass}
        >
          <Sparkles size={15} />
          {VOCAB.attention.giveBack}
        </button>
      )}
      {canManageGroups && (
        <>
          <button
            type="button"
            onClick={() => {
              close();
              actions.onUnmonitor();
            }}
            className={itemClass}
          >
            <EyeOff size={15} />
            Parar de acompanhar
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              actions.onLeave();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 coarse:min-h-11 text-left text-sm text-semantic-error hover:bg-semantic-error/10 transition-colors"
          >
            <LogOut size={15} />
            Sair do grupo
          </button>
        </>
      )}
    </>
  );
}
