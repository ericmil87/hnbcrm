/** Which preview the conversation list row shows: typing > draft > last message (WhatsApp order). */
export type ListPreview = { kind: "typing" } | { kind: "draft"; text: string } | { kind: "message" };

interface ListPreviewInput {
  contactTyping: boolean;
  /** Stored composer draft of this device/member (may be empty or undefined). */
  draft: string | null | undefined;
  /** The conversation open beside the list: the person is typing in it, so no "Rascunho:". */
  isOpen: boolean;
}

export function resolveListPreview({ contactTyping, draft, isOpen }: ListPreviewInput): ListPreview {
  if (contactTyping) return { kind: "typing" };
  if (!isOpen && draft && draft.trim() !== "") return { kind: "draft", text: draft.replace(/\s+/g, " ").trim() };
  return { kind: "message" };
}
