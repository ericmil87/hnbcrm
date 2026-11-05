import type { Id } from "../../../convex/_generated/dataModel";

export interface Lead {
  _id: Id<"leads">;
  title: string;
  value: number;
  priority: string;
  temperature: string;
  stageId: Id<"stages">;
  lastActivityAt: number;
  contact?: {
    _id: Id<"contacts">;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    company?: string;
  } | null;
  assignee?: {
    _id: Id<"teamMembers">;
    name: string;
    type: "human" | "ai";
  } | null;
  tags?: string[];
}

export interface Stage {
  _id: Id<"stages">;
  name: string;
  color: string;
  isClosedWon?: boolean;
  isClosedLost?: boolean;
}
