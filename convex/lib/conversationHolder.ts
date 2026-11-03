/**
 * Who holds a 1:1 conversation besides the actor (review F1 #1 and F3 #10):
 * the human who accepted the referenced handoff, or the live human the lead is
 * assigned to while the AI is paused. Used by the Telegram stale-card guard
 * (`lib/telegramActions.takenOverCopy`) and by the Copilot's `instructAttendant`
 * (two-phase when someone else holds the conversation; a suggestion applied
 * after a takeover is refused).
 */
import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

type Db = QueryCtx["db"];

export async function otherHumanHolder(
  db: Db,
  args: {
    organizationId: Id<"organizations">;
    actorId: Id<"teamMembers">;
    conversation: Doc<"conversations">;
    handoffId?: string;
    now: number;
  },
): Promise<{ member: Doc<"teamMembers">; at?: number } | null> {
  let ownerId: Id<"teamMembers"> | undefined;
  let at: number | undefined;
  const normalized = args.handoffId ? db.normalizeId("handoffs", args.handoffId) : null;
  const handoff = normalized ? await db.get(normalized) : null;
  if (handoff && handoff.organizationId === args.organizationId && handoff.status === "accepted" && handoff.acceptedBy) {
    ownerId = handoff.acceptedBy;
    at = handoff.resolvedAt;
  } else {
    const paused = args.conversation.aiPausedUntil !== undefined && args.conversation.aiPausedUntil > args.now;
    const lead = args.conversation.leadId ? await db.get(args.conversation.leadId) : null;
    if (paused && lead?.assignedTo) {
      ownerId = lead.assignedTo;
      at = lead.handoffState?.toMemberId === lead.assignedTo ? lead.handoffState.completedAt : undefined;
    }
  }
  if (!ownerId || ownerId === args.actorId) return null;
  const owner = await db.get(ownerId);
  if (!owner || owner.type !== "human" || owner.organizationId !== args.organizationId || owner.removedAt !== undefined) return null;
  return { member: owner, ...(at !== undefined ? { at } : {}) };
}
