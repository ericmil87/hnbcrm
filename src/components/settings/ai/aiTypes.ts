

export const PERSONAS = [
  { id: "geral", label: "Atendimento geral" },
  { id: "imobiliaria", label: "Imobiliária" },
  { id: "clinica", label: "Clínica e saúde" },
  { id: "ecommerce", label: "E-commerce" },
  { id: "servicos_b2b", label: "Serviços B2B" },
];

export type AiStatus = {
  enabled: boolean;
  lgpdAckDone: boolean;
  active: boolean;
  copilotEnabled: boolean;
  attendantEnabled: boolean;
  visionEnabled: boolean;
  groupAgentEnabled: boolean;
  bridgeAiAckDone: boolean;
  hasAttendant: boolean;
  hasBridgeChannel: boolean;
  models: { copilot: string; attendant: string; classify: string; complex?: string };
  strictZdr: boolean;
  monthlyConversationBudget: number | null;
  providerMode: "platform" | "byo";
  platformOrder: string;
  // Override por produto. order "inherit" = herda o platformOrder da org;
  // model "" (só na visão) = Automático, a cadeia inteira com fallover.
  products: Record<
    "copilot" | "attendant" | "vision" | "groupPosts" | "groupAgent" | "telegramCopilot" | "translation",
    { order: string; model: string }
  >;
  byo: { provider: string; baseUrl: string | null; keyLast4: string | null } | null;
};

// ── Wizard de ativação em 1 fluxo (v4.2): liga IA + LGPD + atendente + bridge
// numa única mutation (activateOneFlow). Some assim que a IA fica ativa E com
// atendente — a partir daí a seção volta aos cards individuais de sempre. ──
