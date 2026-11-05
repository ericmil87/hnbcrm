import { useEffect, useState } from "react";
import { Id } from "../../../convex/_generated/dataModel";
import { ContactDetailPanel } from "@/components/ContactDetailPanel";
import { LeadDetailPanel } from "@/components/LeadDetailPanel";
import { GroupConversationPanels, useGroupPanels } from "@/components/inbox/GroupConversationPanels";
import type { GroupChatDoc } from "@/components/inbox/types";

/**
 * Estado dos painéis sobrepostos à conversa (lead, contato, e os do grupo:
 * membros, resumo, contato de um membro, confirmações). Trocar de conversa
 * fecha todos.
 */
export function useInboxOverlays(selectedConversation: string | null) {
  const [showLeadPanel, setShowLeadPanel] = useState(false);
  const [showContactPanel, setShowContactPanel] = useState(false);
  useEffect(() => {
    setShowLeadPanel(false);
    setShowContactPanel(false);
  }, [selectedConversation]);
  const groupPanels = useGroupPanels(selectedConversation);
  return { showLeadPanel, setShowLeadPanel, showContactPanel, setShowContactPanel, groupPanels };
}

export type InboxOverlaysState = ReturnType<typeof useInboxOverlays>;

interface InboxOverlaysProps {
  organizationId: Id<"organizations">;
  overlays: InboxOverlaysState;
  openLeadId?: Id<"leads">;
  openContactId?: Id<"contacts">;
  /** Presente só em conversa de grupo com sala conhecida. */
  group?: {
    groupChatId: Id<"groupChats">;
    groupSubject: string;
    groupChat: GroupChatDoc | null | undefined;
    onDispatchSelected?: (phones: string[]) => void;
    onLeft: () => void;
  };
}

/** Painéis sobrepostos à conversa: lead, contato e os do grupo. */
export function InboxOverlays({ organizationId, overlays, openLeadId, openContactId, group }: InboxOverlaysProps) {
  return (
    <>
      {overlays.showLeadPanel && openLeadId && (
        <LeadDetailPanel
          leadId={openLeadId}
          organizationId={organizationId}
          onClose={() => overlays.setShowLeadPanel(false)}
          initialTab="details"
        />
      )}
      {overlays.showContactPanel && openContactId && (
        <ContactDetailPanel contactId={openContactId} onClose={() => overlays.setShowContactPanel(false)} />
      )}
      {/* Grupo: resumo por IA, membros (e o contato de um membro) e confirmações */}
      {group && (
        <GroupConversationPanels
          organizationId={organizationId}
          groupChatId={group.groupChatId}
          groupSubject={group.groupSubject}
          groupChat={group.groupChat}
          panels={overlays.groupPanels}
          onDispatchSelected={group.onDispatchSelected}
          onLeft={group.onLeft}
        />
      )}
    </>
  );
}
