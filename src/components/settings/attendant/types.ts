import { Id } from "../../../../convex/_generated/dataModel";

export type Attendant = {
  _id: Id<"teamMembers">;
  name: string;
  status: string;
  agentProfile: {
    kind: string;
    mode: "suggest" | "autopilot";
    // Persona/conhecimento NÃO vêm em `listAttendants` (perf): o editor carrega
    // `getAttendantTexts` só quando abre.
    schedule?: { timezone: string; startHour: number; endHour: number };
    handoffKeywords?: string[];
    disclosure?: string;
    disclosureMode?: "first_reply" | "on_demand";
    maxRepliesPerConversation?: number;
    maxRepliesPerHour?: number;
    messageDebounceSeconds?: number;
    includeCurrentDateTime?: boolean;
    // Guardrail anti-bot (v0.65) — ausente = LIGADO; só `enabled:false` desliga.
    botGuard?: { enabled?: boolean; tag?: string };
    // Follow-ups que o próprio atendente executa (v0.60) — ausente = "draft".
    followUps?: {
      mode: "off" | "draft" | "send";
      maxChain?: number;
      quietStartHour?: number;
      quietEndHour?: number;
      dailyCap?: number;
      eventDateField?: string;
    };
    autopilotEarlyAck?: { acceptedAt: number; acceptedBy: string };
    pipelineConfig?: {
      boardId?: Id<"boards">;
      initialStageId?: Id<"stages">;
      advanceRules?: string;
      qualifiedStageId?: Id<"stages">;
      qualifyThreshold?: number;
      allowMoveStages?: boolean;
      captureFields?: string[];
    };
  };
};
