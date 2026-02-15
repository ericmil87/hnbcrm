export interface IndustryTemplate {
  key: string;
  label: string;
  icon: string;
  boardName: string;
  boardColor: string;
  stages: {
    name: string;
    color: string;
    isClosedWon?: boolean;
    isClosedLost?: boolean;
  }[];
}

export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [
  {
    key: "imobiliaria",
    label: "Imobiliaria",
    icon: "Building2",
    boardName: "Pipeline Imobiliario",
    boardColor: "#3B82F6",
    stages: [
      { name: "Novo Contato", color: "#3B82F6" },
      { name: "Visita Agendada", color: "#8B5CF6" },
      { name: "Proposta Enviada", color: "#F59E0B" },
      { name: "Documentacao", color: "#06B6D4" },
      { name: "Escritura", color: "#10B981", isClosedWon: true },
      { name: "Desistencia", color: "#6B7280", isClosedLost: true },
    ],
  },
  {
    key: "ecommerce",
    label: "E-commerce",
    icon: "ShoppingCart",
    boardName: "Pipeline E-commerce",
    boardColor: "#EC4899",
    stages: [
      { name: "Lead Captado", color: "#3B82F6" },
      { name: "Primeiro Contato", color: "#8B5CF6" },
      { name: "Demonstracao", color: "#F59E0B" },
      { name: "Negociacao", color: "#EC4899" },
      { name: "Fechado Ganho", color: "#10B981", isClosedWon: true },
      { name: "Fechado Perdido", color: "#6B7280", isClosedLost: true },
    ],
  },
  {
    key: "saas",
    label: "SaaS",
    icon: "Cloud",
    boardName: "Pipeline SaaS",
    boardColor: "#8B5CF6",
    stages: [
      { name: "MQL", color: "#06B6D4" },
      { name: "SQL", color: "#3B82F6" },
      { name: "Demo Agendada", color: "#8B5CF6" },
      { name: "Proposta", color: "#F59E0B" },
      { name: "Negociacao", color: "#EC4899" },
      { name: "Ganho", color: "#10B981", isClosedWon: true },
      { name: "Perdido", color: "#6B7280", isClosedLost: true },
    ],
  },
  {
    key: "servicos",
    label: "Servicos",
    icon: "Wrench",
    boardName: "Pipeline de Servicos",
    boardColor: "#F59E0B",
    stages: [
      { name: "Prospeccao", color: "#3B82F6" },
      { name: "Qualificacao", color: "#8B5CF6" },
      { name: "Orcamento", color: "#F59E0B" },
      { name: "Aprovacao", color: "#06B6D4" },
      { name: "Contrato Assinado", color: "#10B981", isClosedWon: true },
      { name: "Nao Fechou", color: "#6B7280", isClosedLost: true },
    ],
  },
  {
    key: "educacao",
    label: "Educacao",
    icon: "GraduationCap",
    boardName: "Pipeline Educacional",
    boardColor: "#06B6D4",
    stages: [
      { name: "Interessado", color: "#3B82F6" },
      { name: "Matricula em Andamento", color: "#8B5CF6" },
      { name: "Documentos Enviados", color: "#F59E0B" },
      { name: "Aprovado", color: "#06B6D4" },
      { name: "Matriculado", color: "#10B981", isClosedWon: true },
      { name: "Desistiu", color: "#6B7280", isClosedLost: true },
    ],
  },
  {
    key: "saude",
    label: "Saude",
    icon: "HeartPulse",
    boardName: "Pipeline de Saude",
    boardColor: "#EF4444",
    stages: [
      { name: "Primeiro Contato", color: "#3B82F6" },
      { name: "Avaliacao", color: "#8B5CF6" },
      { name: "Orcamento", color: "#F59E0B" },
      { name: "Tratamento", color: "#EC4899" },
      { name: "Concluido", color: "#10B981", isClosedWon: true },
      { name: "Cancelado", color: "#6B7280", isClosedLost: true },
    ],
  },
  {
    key: "financeiro",
    label: "Financeiro",
    icon: "Landmark",
    boardName: "Pipeline Financeiro",
    boardColor: "#10B981",
    stages: [
      { name: "Lead Qualificado", color: "#3B82F6" },
      { name: "Analise de Perfil", color: "#8B5CF6" },
      { name: "Proposta", color: "#F59E0B" },
      { name: "Aprovacao", color: "#06B6D4" },
      { name: "Contrato", color: "#10B981", isClosedWon: true },
      { name: "Recusado", color: "#EF4444", isClosedLost: true },
    ],
  },
  {
    key: "outro",
    label: "Outro",
    icon: "MoreHorizontal",
    boardName: "Pipeline de Vendas",
    boardColor: "#3B82F6",
    stages: [
      { name: "Novo Lead", color: "#3B82F6" },
      { name: "Qualificado", color: "#8B5CF6" },
      { name: "Proposta", color: "#F59E0B" },
      { name: "Negociacao", color: "#EC4899" },
      { name: "Fechado Ganho", color: "#10B981", isClosedWon: true },
      { name: "Fechado Perdido", color: "#6B7280", isClosedLost: true },
    ],
  },
];

export const COMPANY_SIZES = [
  { key: "solo", label: "Solo" },
  { key: "2-5", label: "2-5" },
  { key: "6-20", label: "6-20" },
  { key: "21-50", label: "21-50" },
  { key: "50+", label: "50+" },
];

export const MAIN_GOALS = [
  { key: "vendas", label: "Gerenciar vendas", icon: "TrendingUp" },
  { key: "contatos", label: "Organizar contatos", icon: "Contact2" },
  { key: "atendimento", label: "Automatizar atendimento", icon: "Bot" },
  { key: "tudo", label: "Tudo isso!", icon: "Sparkles" },
];

export const STAGE_COLORS = [
  "#EF4444",
  "#F59E0B",
  "#10B981",
  "#3B82F6",
  "#8B5CF6",
  "#06B6D4",
  "#EC4899",
  "#6B7280",
];

export function getTemplateByIndustry(industry: string): IndustryTemplate {
  return (
    INDUSTRY_TEMPLATES.find((t) => t.key === industry) ||
    INDUSTRY_TEMPLATES[INDUSTRY_TEMPLATES.length - 1]
  );
}
