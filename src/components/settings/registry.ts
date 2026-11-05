import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  Bell,
  Bot,
  CalendarClock,
  Gauge,
  LifeBuoy,
  MessageSquareText,
  ShieldCheck,
  UserRound,
  Wand2,
  Building2,
  KeyRound,
  ListChecks,
  Megaphone,
  Network,
  Palette,
  Smartphone,
  Users,
  Database,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { PermissionCategory } from "../../../convex/lib/permissions";
import { computeAnyEnabled, type OrgModules } from "@/hooks/useOrgModules";
import { VOCAB } from "@/lib/vocab";
import type { Id } from "../../../convex/_generated/dataModel";

export type SettingsGroupId = "conta" | "whatsapp" | "atendente" | "equipe" | "dados" | "avancado";

export interface SettingsPanelProps {
  organizationId: Id<"organizations">;
}

export interface SettingsPanelDef {
  /** Valor de `?secao=`. Ids existentes são estáveis (links do backend e de e-mails). */
  id: string;
  group: SettingsGroupId;
  /** Sentence case; da `VOCAB` quando o termo existe lá. */
  label: string;
  /** Uma linha. */
  description: string;
  icon: LucideIcon;
  /** Busca: sinônimos e o que o usuário digitaria ("transcrição", "QR code"). */
  keywords?: string[];
  permission?: { category: PermissionCategory; level: string };
  visible?: (ctx: {
    can: (category: PermissionCategory, level: string) => boolean;
    modules: OrgModules;
  }) => boolean;
  /** Painel renderizado; lazy para não carregar o que não foi aberto. */
  Component?: LazyExoticComponent<ComponentType<SettingsPanelProps>>;
  /** Alternativa a `Component`: o painel é um atalho para outra rota. */
  href?: string;
}

export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; label: string }> = [
  { id: "conta", label: "Conta" },
  { id: "whatsapp", label: "WhatsApp e canais" },
  { id: "atendente", label: VOCAB.attendant.name },
  { id: "equipe", label: "Equipe" },
  { id: "dados", label: "Dados" },
  { id: "avancado", label: "Avançado" },
];

/** Painel aberto por padrão no desktop quando `?secao=` falta ou é desconhecido. */
export const DEFAULT_SETTINGS_PANEL_ID = "general";

/**
 * Painéis previstos que ainda não existem (viram entradas em PRs seguintes).
 * Reservados para a busca e para links futuros; não registrar sem componente.
 * - instagram (fv2-21): hoje `MetaMessagingCard` mora dentro de `ChannelsSection`.
 */
export const PLANNED_PANEL_IDS = ["instagram"] as const;

const view = { category: "settings", level: "view" } as const;

/** Painel novo = uma entrada aqui (mais o componente). */
export const SETTINGS_PANELS: ReadonlyArray<SettingsPanelDef> = [
  {
    id: "general",
    group: "conta",
    label: "Dados da empresa",
    description: "Nome, fuso horário, moeda e país padrão",
    icon: Building2,
    keywords: ["organização", "empresa", "nome", "fuso", "moeda", "país", "telefone", "ddi"],
    permission: view,
    Component: lazy(() => import("./OrgProfilePanel").then((m) => ({ default: m.OrgProfilePanel }))),
  },
  {
    // Reservado para a seção de temas (fv2-15): some até lá.
    id: "appearance",
    group: "conta",
    label: "Aparência",
    description: "Tema e cores da interface",
    icon: Palette,
    keywords: ["tema", "escuro", "claro", "cores"],
    visible: () => false,
    Component: lazy(() => import("./AppearancePanelPlaceholder")),
  },
  {
    id: "notifications",
    group: "conta",
    label: "Notificações",
    description: "Avisos no sino e no Telegram",
    icon: Bell,
    keywords: ["avisos", "sino", "telegram", "copiloto", "alertas"],
    permission: view,
    Component: lazy(() =>
      import("@/components/notifications/NotificationPreferences").then((m) => ({ default: m.NotificationsSection }))
    ),
  },
  {
    id: "channels",
    group: "whatsapp",
    label: "Números conectados",
    description: "WhatsApp, Instagram e Messenger conectados",
    icon: Smartphone,
    keywords: ["transcrição", "áudio", "QR code", "número", "whatsapp", "canal", "conectar", "instagram", "messenger", "meta"],
    permission: view,
    Component: lazy(() => import("./ChannelsSection").then((m) => ({ default: m.ChannelsSection }))),
  },
  {
    id: "ai",
    group: "atendente",
    label: "Visão geral",
    description: "Ligar a IA, modo de atendimento e ajustes do atendente",
    icon: Bot,
    keywords: ["ia", "atendente", "inteligência artificial", "modo", "lgpd", "testar"],
    permission: view,
    Component: lazy(() => import("./ai/AiOverviewPanel").then((m) => ({ default: m.AiOverviewPanel }))),
  },
  {
    id: "ai-attendant",
    group: "atendente",
    label: "Jeito de atender",
    description: "Como a IA conversa, o que ela sabe do seu negócio e o horário de atendimento",
    icon: UserRound,
    keywords: ["persona", "tom", "conhecimento", "horário", "atendimento", "apresentação", "preços"],
    permission: view,
    Component: lazy(() => import("./attendant/AttendantProfilePanel").then((m) => ({ default: m.AttendantProfilePanel }))),
  },
  {
    id: "ai-conversation",
    group: "atendente",
    label: "Comportamento na conversa",
    description: "Agrupar mensagens, limite de respostas seguidas e funil dos leads",
    icon: MessageSquareText,
    keywords: ["agrupar", "limite", "robô", "funil", "etapa", "qualificar", "data e hora"],
    permission: view,
    Component: lazy(() => import("./attendant/ConversationPanel").then((m) => ({ default: m.ConversationPanel }))),
  },
  {
    id: "ai-handoff",
    group: "atendente",
    label: "Quando chamar a equipe",
    description: "Palavras que fazem a IA parar e chamar alguém do time",
    icon: LifeBuoy,
    keywords: ["palavras", "humano", "pedido de ajuda", "equipe"],
    permission: view,
    Component: lazy(() => import("./attendant/HandoffPanel").then((m) => ({ default: m.HandoffPanel }))),
  },
  {
    id: "ai-followup",
    group: "atendente",
    label: VOCAB.followUp.many,
    description: "O que a IA faz quando chega a hora de um follow-up que ela marcou",
    icon: CalendarClock,
    keywords: ["retorno", "lembrete", "janela de envio", "encadeamento"],
    permission: view,
    Component: lazy(() => import("./attendant/FollowUpPanel").then((m) => ({ default: m.FollowUpPanel }))),
  },
  {
    id: "ai-features",
    group: "atendente",
    label: "Recursos da IA",
    description: "Ouvir áudios, ler imagens, grupos, Copiloto e agenda externa",
    icon: Wand2,
    keywords: ["transcrição", "áudio", "imagem", "visão", "grupos", "telegram", "copiloto", "qr code", "agenda"],
    permission: view,
    Component: lazy(() => import("./ai/AiFeaturesPanel").then((m) => ({ default: m.AiFeaturesPanel }))),
  },
  {
    id: "ai-usage",
    group: "atendente",
    label: "Uso e limites de gasto",
    description: "Quanto a IA usou no mês e o teto de gastos",
    icon: Gauge,
    keywords: ["custo", "gasto", "teto", "orçamento", "consumo", "dólar", "reais"],
    permission: view,
    Component: lazy(() => import("./ai/UsagePanel").then((m) => ({ default: m.UsagePanel }))),
  },
  {
    id: "team",
    group: "equipe",
    label: "Membros e permissões",
    description: "Quem usa o sistema e o que cada pessoa pode fazer",
    icon: Users,
    keywords: ["equipe", "membros", "convidar", "papéis", "permissões", "usuários"],
    permission: { category: "team", level: "view" },
    href: "/app/equipe",
  },
  {
    id: "data",
    group: "dados",
    label: "Importar e exportar",
    description: "Trazer contatos e leads ou baixar seus dados",
    icon: Database,
    keywords: ["importar", "exportar", "planilha", "csv", "backup", "baixar"],
    permission: view,
    Component: lazy(() => import("./DataSection").then((m) => ({ default: m.DataSection }))),
  },
  {
    id: "fields",
    group: "dados",
    label: "Campos personalizados",
    description: "Campos extras em leads e contatos",
    icon: ListChecks,
    keywords: ["campo", "lead", "contato", "formulário"],
    permission: view,
    Component: lazy(() => import("./CustomFieldsPanel").then((m) => ({ default: m.CustomFieldsPanel }))),
  },
  {
    id: "sources",
    group: "dados",
    label: VOCAB.origin.leadSources,
    description: "De onde vêm seus leads",
    icon: Megaphone,
    keywords: ["origem", "fonte", "anúncio", "site", "indicação"],
    permission: view,
    Component: lazy(() => import("./LeadSourcesPanel").then((m) => ({ default: m.LeadSourcesPanel }))),
  },
  {
    // Mesma regra de antes: quem pode ligar vê sempre; os demais só com algum módulo ligado.
    id: "central",
    group: "avancado",
    label: VOCAB.unitsAndDepartments,
    description: "Módulos opcionais, unidades, departamentos e anúncios",
    icon: Network,
    keywords: ["módulos", "unidade", "departamento", "investimento", "anúncios", "central"],
    permission: view,
    visible: ({ can, modules }) => can("settings", "manage") || computeAnyEnabled(modules),
    Component: lazy(() => import("./CentralSection").then((m) => ({ default: m.CentralSection }))),
  },
  {
    id: "ai-models",
    group: "avancado",
    label: "Modelo de IA e privacidade",
    description: "Modelo e rota de cada produto, zero-retention e chave própria",
    icon: ShieldCheck,
    keywords: ["modelo", "privacidade", "zdr", "zero-retention", "byo", "openrouter", "rota", "provedor", "lgpd"],
    permission: { category: "settings", level: "manage" },
    Component: lazy(() => import("./advanced/AiModelsPanel").then((m) => ({ default: m.AiModelsPanel }))),
  },
  {
    id: "apikeys",
    group: "avancado",
    label: VOCAB.apiKeys,
    description: "Chaves para outros sistemas falarem com o seu",
    icon: KeyRound,
    keywords: ["api", "token", "integração", "chave"],
    permission: view,
    Component: lazy(() => import("./advanced/ApiKeysPanel").then((m) => ({ default: m.ApiKeysPanel }))),
  },
  {
    id: "webhooks",
    group: "avancado",
    label: VOCAB.webhooks.name,
    description: "Avisos automáticos para outros sistemas",
    icon: Webhook,
    keywords: ["webhook", "evento", "integração", "url"],
    permission: view,
    Component: lazy(() => import("./advanced/WebhooksPanel").then((m) => ({ default: m.WebhooksPanel }))),
  },
];
