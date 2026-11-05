import { useEffect, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { ContactDetailPanel } from "@/components/ContactDetailPanel";
import { GroupMembersPanel } from "@/components/inbox/GroupMembersPanel";
import { GroupSummaryModal } from "@/components/inbox/GroupSummaryModal";
import type { GroupChatDoc } from "@/components/inbox/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { mutationErrorMessage } from "@/lib/errors";

/**
 * Estado dos painéis sobrepostos de uma sala (membros, resumo, contato de um
 * membro e confirmações). Trocar de conversa fecha tudo — faltava fechar o
 * modal de resumo, que ficava aberto mostrando o resumo da sala ANTERIOR.
 */
export function useGroupPanels(conversationKey: string | null) {
  const [showMembersPanel, setShowMembersPanel] = useState(false);
  const [showGroupSummary, setShowGroupSummary] = useState(false);
  const [memberContactId, setMemberContactId] = useState<Id<"contacts"> | null>(null);
  const [confirmGroupAction, setConfirmGroupAction] = useState<null | "unmonitor" | "leave">(null);
  useEffect(() => {
    setShowMembersPanel(false);
    setShowGroupSummary(false);
    setMemberContactId(null);
    setConfirmGroupAction(null);
  }, [conversationKey]);
  return {
    showMembersPanel,
    setShowMembersPanel,
    showGroupSummary,
    setShowGroupSummary,
    memberContactId,
    setMemberContactId,
    confirmGroupAction,
    setConfirmGroupAction,
  };
}

export type GroupPanelsState = ReturnType<typeof useGroupPanels>;

interface GroupConversationPanelsProps {
  organizationId: Id<"organizations">;
  groupChatId: Id<"groupChats">;
  groupSubject: string;
  groupChat: (GroupChatDoc & { selfKey?: string | null }) | null | undefined;
  panels: GroupPanelsState;
  /** Presente quando a pessoa pode criar campanha: dispara 1 a 1 para os membros marcados. */
  onDispatchSelected?: (phones: string[]) => void;
  /** Parou de acompanhar ou saiu da sala: volta para a lista. */
  onLeft: () => void;
}

/** Sala aberta: resumo por IA, membros, contato de um membro e confirmações de parar/sair. */
export function GroupConversationPanels({
  organizationId,
  groupChatId,
  groupSubject,
  groupChat,
  panels,
  onDispatchSelected,
  onLeft,
}: GroupConversationPanelsProps) {
  const setGroupMonitored = useMutation(api.groupChats.setMonitored);
  const leaveGroup = useAction(api.groupChats.leaveGroup);
  const {
    showMembersPanel,
    setShowMembersPanel,
    showGroupSummary,
    setShowGroupSummary,
    memberContactId,
    setMemberContactId,
    confirmGroupAction,
    setConfirmGroupAction,
  } = panels;

  // Sem `toast.promise` aqui: o formatador de sucesso dele roda durante a
  // renderização do toast, e voltar para a lista é `setState` — o efeito
  // colateral fica no `then`, não no render.
  const handleStopMonitoring = async () => {
    try {
      await setGroupMonitored({ groupChatId, monitored: false });
      onLeft();
      toast.success("Parou de acompanhar o grupo — a conversa foi arquivada");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível parar de acompanhar."));
    }
  };

  const handleLeaveGroup = async () => {
    try {
      const result = await leaveGroup({ groupChatId });
      onLeft();
      toast.success(result.detail);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível sair do grupo."));
    }
  };

  return (
    <>
      {/* Grupo: resumo por IA (F4) */}
      {showGroupSummary && (
        <GroupSummaryModal
          open
          groupChatId={groupChatId}
          groupSubject={groupSubject}
          initial={groupChat?.summary ?? null}
          onClose={() => setShowGroupSummary(false)}
        />
      )}

      {/* Grupo: membros da sala + o contato de um membro, sobrepostos */}
      <GroupMembersPanel
        // `key` por sala: sem ela a busca e a seleção vazavam de um grupo
        // para outro ("3 selecionado(s)" sem nada marcado).
        key={groupChatId}
        open={showMembersPanel}
        groupChatId={groupChatId}
        organizationId={organizationId}
        onClose={() => setShowMembersPanel(false)}
        onOpenContact={(contactId) => setMemberContactId(contactId)}
        {...(onDispatchSelected ? { onDispatchSelected } : {})}
      />
      {/* Montado DEPOIS do painel de membros para ficar por cima (v0.48). */}
      {memberContactId && (
        <ContactDetailPanel contactId={memberContactId} onClose={() => setMemberContactId(null)} />
      )}

      <ConfirmDialog
        open={confirmGroupAction === "unmonitor"}
        onClose={() => setConfirmGroupAction(null)}
        onConfirm={() => {
          setConfirmGroupAction(null);
          void handleStopMonitoring();
        }}
        title={`Parar de acompanhar '${groupSubject}'?`}
        description="O CRM deixa de receber as mensagens desta sala e a conversa é arquivada. O histórico já ingerido continua aqui, e dá para voltar a acompanhar depois."
        confirmLabel="Parar de acompanhar"
      />
      <ConfirmDialog
        open={confirmGroupAction === "leave"}
        onClose={() => setConfirmGroupAction(null)}
        onConfirm={() => {
          setConfirmGroupAction(null);
          void handleLeaveGroup();
        }}
        title={`Sair de '${groupSubject}'?`}
        description="O número sai do grupo de verdade, no WhatsApp — os membros veem a saída. Voltar exige um convite novo. Esta ação é registrada na auditoria."
        confirmLabel="Sair do grupo"
        variant="danger"
      />
    </>
  );
}
