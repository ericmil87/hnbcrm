/**
 * Glossário da interface (PT-BR). Fonte única para rótulos de menu, títulos de
 * página e estados vazios. Só rótulos: rotas, ids, enums e nomes de função não
 * mudam. Detalhes e justificativas: `.claude/plans/frontend-v2/03-reorganizacao-vocabulario.md` § 1.2.
 */
export const VOCAB = {
  conversations: { one: "conversa", many: "conversas", nav: "Conversas", title: "Conversas", empty: { title: "Nenhuma conversa ainda", hint: "As conversas aparecem aqui quando um cliente manda mensagem para o seu WhatsApp." } },
  attention: {
    nav: "Requer atenção",
    title: "Requer atenção",
    subtitle: "Conversas em que a IA pediu ajuda a alguém da equipe",
    item: "pedido de ajuda",
    accept: "Assumir conversa",
    giveBack: "Devolver à IA",
    view: "Ver conversa",
    emptyTitle: "Tudo em dia",
    emptyHint: "Quando a IA precisar de alguém da equipe, a conversa aparece aqui.",
  },
  funnel: { one: "funil", many: "funis", nav: "Funil", title: "Funil de vendas", new: "Novo funil", empty: { title: "Nenhum funil ainda", hint: "Crie o primeiro funil para acompanhar cada lead da primeira conversa até a venda." } },
  stage: { one: "etapa", many: "etapas", new: "Nova etapa" },
  lead: { one: "lead", many: "leads", new: "Novo lead", article: "o" },
  contact: { one: "contato", many: "contatos", nav: "Contatos", new: "Novo contato", empty: { title: "Nenhum contato ainda", hint: "Os contatos surgem quando alguém escreve para você, ou adicione o primeiro." } },
  attendant: {
    name: "Atendente IA",
    short: "a IA",
    modeSuggest: "Sugerir respostas",
    modeSuggestHint: "Você revisa antes de enviar",
    modeAuto: "Responder sozinha",
    draft: "Resposta sugerida",
  },
  copilot: { name: "Copiloto", hint: "Assistente da sua equipe" },
  translation: { name: "Tradução automática", hint: "Ler e responder em outros idiomas sem sair da conversa" },
  whatsappQr: "WhatsApp por QR code",
  whatsappOfficial: "WhatsApp oficial (Meta)",
  connectNumber: "Conectar número",
  connectionCode: "código de conexão",
  channel: { one: "canal", many: "canais" },
  origin: { one: "origem", many: "origens", title: "Origem", leadSources: "Origens dos leads" },
  label: { one: "etiqueta", many: "Etiquetas" },
  followUp: { name: "Follow-up", many: "Follow-ups" },
  draft: { name: "Rascunho" },
  persona: "Jeito de atender",
  knowledge: "O que a IA sabe do seu negócio",
  qualification: {
    name: "Qualificação",
    budget: "Orçamento",
    authority: "Quem decide",
    need: "Necessidade",
    timeline: "Prazo",
  },
  viewMode: { board: "Modo quadro", list: "Modo lista", saved: "Filtros salvos" },
  audit: { nav: "Histórico de alterações", title: "Histórico de alterações", empty: { title: "Nenhuma alteração registrada", hint: "As alterações aparecem aqui conforme a equipe e a IA trabalham." } },
  reports: { nav: "Relatórios", title: "Relatórios", empty: { title: "Sem movimento neste período", hint: "Quando chegarem conversas no WhatsApp, os relatórios se preenchem sozinhos." } },
  unitsAndDepartments: "Unidades e departamentos",
  department: { one: "departamento", many: "departamentos", title: "Departamento" },
  industry: "Ramo de atividade",
  optOuts: { tab: "Descadastrados", hint: "Pediu para não receber mensagens" },
  aiAgent: "Agente de IA",
  roles: { agent: "Atendente", admin: "Administrador", manager: "Gerente" },
  guardrails: "Limite de respostas seguidas",
  modelAi: "Modelo de IA",
  apiKeys: "Chaves de integração",
  billing: { name: "Uso e fatura" },
  webhooks: { name: "Webhooks", hint: "avisos automáticos para outros sistemas" },
  agenda: { nav: "Agenda", title: "Agenda", empty: { title: "Nada na agenda", hint: "Crie um evento ou uma tarefa com data para ver tudo aqui." } },
  dashboard: { nav: "Painel", title: "Painel", empty: { title: "Seu painel ainda está vazio", hint: "Quando chegarem conversas e leads, os números aparecem aqui." } },
  tasks: { nav: "Tarefas", title: "Tarefas", empty: { title: "Nenhuma tarefa ainda", hint: "Crie a primeira tarefa para organizar o trabalho da equipe." } },
  groups: { nav: "Grupos", title: "Grupos", empty: { title: "Nenhum grupo acompanhado", hint: "Escolha os grupos do WhatsApp que a equipe vai acompanhar." } },
  forms: { nav: "Formulários", title: "Formulários", empty: { title: "Nenhum formulário ainda", hint: "Crie um formulário para captar leads direto do seu site ou de um link." } },
  campaigns: { nav: "Campanhas", title: "Campanhas", empty: { title: "Nenhuma campanha ainda", hint: "Dispare mensagens para uma lista de contatos, com limites de envio e relatório por destinatário." } },
  team: { nav: "Equipe", title: "Equipe", empty: { title: "Nenhum membro na equipe ainda", hint: "Convide pessoas para trabalhar com você no HNBCRM." } },
  settings: { nav: "Configurações", title: "Configurações", empty: { title: "Nada encontrado", hint: "Tente outra palavra, como “número” ou “chave”." } },
} as const;

/** Termos que não podem aparecer em texto visível fora da allowlist. */
export const BANNED_UI_TERMS: ReadonlyArray<{ pattern: RegExp; use: string }> = [
  { pattern: /\bRepasses?\b/, use: "Requer atenção / pedido de ajuda" },
  { pattern: /\bHandoffs?\b/, use: "pedido de ajuda" },
  { pattern: /\bPipelines?\b/, use: "Funil" },
  { pattern: /\bBoards?\b/, use: "Funil" },
  { pattern: /\b[Aa]utopilot\b/, use: "Responder sozinha" },
  { pattern: /\bbridge\b/i, use: "WhatsApp por QR code" },
  { pattern: /\bgateway\b/i, use: "(omitir)" },
  { pattern: /\b[Pp]rovision/, use: "Conectar número" },
  { pattern: /\binst[âa]ncia\b/i, use: "(omitir)" },
  { pattern: /\bCaixa de Entrada\b/, use: "Conversas" },
  { pattern: /\b[Ee]st[áa]gios?\b/, use: "Etapa" },
  { pattern: /\bTags?\b/, use: "Etiqueta" },
  { pattern: /\bOpt-?outs?\b/i, use: "Descadastrados" },
  { pattern: /\bLogs? de Auditoria\b/, use: "Histórico de alterações" },
  { pattern: /\bEmail\b/, use: "E-mail" },
  { pattern: /\bVis[ãa]o (Kanban|Lista)\b/, use: "Modo quadro / Modo lista" },
  { pattern: /\bguarda-corpos?\b/i, use: "Limite de respostas seguidas" },
  { pattern: /\bc[óo]digo de pareamento\b/i, use: "código de conexão" },
  { pattern: /\bCloud API\b/, use: "WhatsApp oficial (Meta)" },
  { pattern: /\bAtendente (virtual|com IA)\b/, use: "Atendente IA" },
  { pattern: /\bPersona\b/, use: "Jeito de atender" },
  { pattern: /\bSetor(es)?\b/, use: "Ramo de atividade (ramo do negócio) / Departamento" },
];

/** Todos os rótulos de `VOCAB` (strings folha), para testes. */
export function vocabLabels(node: unknown = VOCAB): string[] {
  if (typeof node === "string") return [node];
  if (node && typeof node === "object") return Object.values(node).flatMap((v) => vocabLabels(v));
  return [];
}

/** Primeiro termo banido encontrado em `text`, ou `null`. */
export function findBannedTerm(text: string): { match: string; use: string } | null {
  for (const { pattern, use } of BANNED_UI_TERMS) {
    const m = pattern.exec(text);
    if (m) return { match: m[0], use };
  }
  return null;
}
