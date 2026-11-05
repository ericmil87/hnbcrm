/**
 * Modelos por segmento da configuração inicial: funil, campos, sementes de
 * Atendente IA (persona, perguntas frequentes, repasse) e perguntas de teste.
 * Módulo puro: só dados e funções puras, sem `_generated`. O front importa
 * daqui (src/lib/onboardingTemplates.ts reexporta), como em permissions.ts.
 */

export type SegmentKey =
  | "imobiliaria"
  | "saas"
  | "servicos"
  | "saude"
  | "ecommerce"
  | "educacao"
  | "outro";

export interface StageSeed {
  name: string;
  color: string;
  isClosedWon?: boolean;
  isClosedLost?: boolean;
}

export interface FieldSeed {
  key: string;
  label: string;
  type: "text" | "select";
  options?: string[];
}

export interface SegmentTemplate {
  key: SegmentKey;
  label: string;
  icon: string;
  funnel: { boardName: string; boardColor: string; stages: StageSeed[] };
  fields: FieldSeed[];
  personaId: string;
  personaSeed: string;
  faqSeed: { q: string; a: string }[];
  /**
   * Semente de palavras de falar com a equipe. O consumidor deve unir esta
   * lista a DEFAULT_HANDOFF_KEYWORDS (convex/lib/handoffKeywords.ts), porque
   * uma lista configurada substitui a padrão.
   */
  handoffKeywords: string[];
  simulatorPrompts: string[];
  advanceRules: string;
}

export interface BusinessInfo {
  negocio?: string;
  oferta?: string;
  tom?: string;
}

const C = {
  blue: "#3B82F6",
  purple: "#8B5CF6",
  amber: "#F59E0B",
  cyan: "#06B6D4",
  pink: "#EC4899",
  green: "#10B981",
  gray: "#6B7280",
};

const SEGMENT_LIST: SegmentTemplate[] = [
  {
    key: "imobiliaria",
    label: "Imobiliária / corretor",
    icon: "Building2",
    funnel: {
      boardName: "Funil imobiliário",
      boardColor: C.blue,
      stages: [
        { name: "Novo contato", color: C.blue },
        { name: "Qualificado", color: C.purple },
        { name: "Visita agendada", color: C.amber },
        { name: "Proposta", color: C.pink },
        { name: "Documentação", color: C.cyan },
        { name: "Fechado (ganho)", color: C.green, isClosedWon: true },
        { name: "Desistiu", color: C.gray, isClosedLost: true },
      ],
    },
    fields: [
      { key: "tipo_imovel", label: "Tipo de imóvel", type: "select", options: ["Apartamento", "Casa", "Terreno", "Sala comercial"] },
      { key: "compra_ou_aluguel", label: "Compra ou aluguel", type: "select", options: ["Compra", "Aluguel"] },
      { key: "bairros_interesse", label: "Bairros de interesse", type: "text" },
      { key: "orcamento", label: "Orçamento", type: "text" },
      { key: "prazo_mudanca", label: "Prazo para mudar", type: "text" },
    ],
    personaId: "imobiliaria",
    personaSeed:
      "Você é o assistente de {negocio} no WhatsApp, apoiando o corretor no primeiro atendimento. Trabalhamos com {oferta}. Fale em tom {tom}.\n\n" +
      "Descubra se o cliente quer comprar ou alugar, em qual região, a faixa de preço e o prazo para se mudar. Faça uma pergunta por vez e registre o que o cliente disser.\n\n" +
      "Quando houver interesse claro, ofereça agendar uma visita. Se o cliente quiser visitar, negociar valor ou falar de financiamento, chame o corretor e avise que a equipe continuará a conversa.",
    faqSeed: [
      { q: "Quais documentos preciso para alugar?", a: "Em geral pedimos documento com foto, comprovante de renda e comprovante de residência. [preencha] com a lista e a garantia aceita." },
      { q: "Vocês ajudam com financiamento?", a: "Podemos orientar sobre o processo e encaminhar para o corretor. [preencha] com bancos parceiros e condições." },
      { q: "Como funciona a visita?", a: "Agendamos o horário e o corretor acompanha você no imóvel. [preencha] com dias e horários de visita." },
      { q: "Qual o valor do condomínio e do IPTU?", a: "Depende do imóvel. [preencha] com a forma de consultar os valores de cada anúncio." },
    ],
    handoffKeywords: ["falar com atendente", "agendar visita", "quero visitar", "proposta", "negociar", "financiamento aprovado", "falar com corretor"],
    simulatorPrompts: [
      "Queria alugar um apartamento de dois quartos perto do centro. Como funciona?",
      "Quais documentos preciso para alugar?",
      "Quero negociar o valor desse imóvel com o corretor.",
    ],
    advanceRules:
      "Quando o cliente aceitar agendar uma visita, mova o lead para a etapa Visita agendada. Quando pedir proposta ou falar de financiamento aprovado, avance para Proposta.",
  },
  {
    key: "saas",
    label: "Startup / SaaS",
    icon: "Cloud",
    funnel: {
      boardName: "Funil de vendas SaaS",
      boardColor: C.purple,
      stages: [
        { name: "Lead", color: C.cyan },
        { name: "Conversa inicial", color: C.blue },
        { name: "Demonstração", color: C.purple },
        { name: "Teste grátis", color: C.amber },
        { name: "Proposta", color: C.pink },
        { name: "Cliente (ganho)", color: C.green, isClosedWon: true },
        { name: "Perdido", color: C.gray, isClosedLost: true },
      ],
    },
    fields: [
      { key: "tamanho_empresa", label: "Tamanho da empresa", type: "select", options: ["1 a 10", "11 a 50", "51 a 200", "Mais de 200"] },
      { key: "cargo", label: "Cargo", type: "text" },
      { key: "ferramenta_atual", label: "Ferramenta atual", type: "text" },
      { key: "plano_interesse", label: "Plano de interesse", type: "text" },
    ],
    personaId: "saas",
    personaSeed:
      "Você é o assistente comercial de {negocio} no WhatsApp. Nosso produto: {oferta}. Fale em tom {tom}, de forma educada e objetiva.\n\n" +
      "Entenda o problema do lead, o porte da empresa e a urgência. Faça uma pergunta por vez e, com o lead qualificado, proponha uma demonstração.\n\n" +
      "Nunca prometa funcionalidade, preço ou prazo que não estejam no conhecimento. Se pedirem contrato, desconto, integração específica ou suporte técnico, chame a equipe.",
    faqSeed: [
      { q: "Quanto custa e quais são os planos?", a: "Temos planos para cada porte. [preencha] com planos, valores e o que cada um inclui." },
      { q: "Existe período de teste?", a: "[preencha] com a duração do teste grátis e se exige cartão." },
      { q: "Integra com outras ferramentas?", a: "[preencha] com as integrações disponíveis. Para integração específica, a equipe avalia o caso." },
      { q: "Meus dados estão seguros? Vocês seguem a LGPD?", a: "[preencha] com as práticas de segurança e de proteção de dados." },
    ],
    handoffKeywords: ["falar com atendente", "contrato", "desconto", "integração específica", "cancelar", "suporte técnico"],
    simulatorPrompts: [
      "Como o produto funciona e para quem ele é indicado?",
      "Tem teste grátis? Quanto custa depois?",
      "Preciso integrar com o meu sistema atual. É possível?",
    ],
    advanceRules:
      "Quando o lead descrever o problema e o porte, mova para Conversa inicial. Quando aceitar uma demonstração, mova para Demonstração. Quando pedir proposta ou preço fechado, avance para Proposta.",
  },
  {
    key: "servicos",
    label: "Serviços locais",
    icon: "Wrench",
    funnel: {
      boardName: "Funil de serviços",
      boardColor: C.amber,
      stages: [
        { name: "Pedido de orçamento", color: C.blue },
        { name: "Visita ou diagnóstico", color: C.purple },
        { name: "Orçamento enviado", color: C.amber },
        { name: "Agendado", color: C.cyan },
        { name: "Concluído (ganho)", color: C.green, isClosedWon: true },
        { name: "Não fechou", color: C.gray, isClosedLost: true },
      ],
    },
    fields: [
      { key: "servico_desejado", label: "Serviço desejado", type: "text" },
      { key: "endereco_bairro", label: "Endereço ou bairro", type: "text" },
      { key: "urgencia", label: "Urgência", type: "select", options: ["Hoje", "Esta semana", "Sem pressa"] },
      { key: "melhor_horario", label: "Melhor horário", type: "text" },
    ],
    personaId: "servicos_b2b",
    personaSeed:
      "Você é a recepção virtual de {negocio} no WhatsApp. Oferecemos {oferta}. Fale em tom {tom}.\n\n" +
      "Descubra qual serviço o cliente precisa, onde fica e se há urgência. Informe a faixa de preço apenas se ela estiver no conhecimento e ofereça agendar uma visita ou horário.\n\n" +
      "Orçamento fechado, reclamação e urgência vão para o responsável: avise o cliente que a equipe vai assumir.",
    faqSeed: [
      { q: "Qual a área atendida?", a: "[preencha] com bairros e cidades atendidos." },
      { q: "Quais as formas de pagamento?", a: "[preencha] com Pix, cartão, parcelamento e condições." },
      { q: "O serviço tem garantia?", a: "[preencha] com prazo e condições da garantia." },
      { q: "Qual o horário de atendimento?", a: "[preencha] com dias e horários de funcionamento." },
    ],
    handoffKeywords: ["falar com atendente", "orçamento fechado", "reclamação", "urgência", "falar com o responsável"],
    simulatorPrompts: [
      "Preciso de um orçamento para um serviço na minha casa.",
      "Vocês atendem no meu bairro? Quais as formas de pagamento?",
      "Tenho uma reclamação sobre o último serviço.",
    ],
    advanceRules:
      "Quando o cliente aceitar uma visita ou diagnóstico, mova para Visita ou diagnóstico. Quando confirmar dia e horário, mova para Agendado.",
  },
  {
    key: "saude",
    label: "Clínica / saúde",
    icon: "HeartPulse",
    funnel: {
      boardName: "Funil da clínica",
      boardColor: "#EF4444",
      stages: [
        { name: "Contato", color: C.blue },
        { name: "Triagem", color: C.purple },
        { name: "Consulta agendada", color: C.amber },
        { name: "Compareceu", color: C.cyan },
        { name: "Em tratamento (ganho)", color: C.green, isClosedWon: true },
        { name: "Não agendou", color: C.gray, isClosedLost: true },
      ],
    },
    fields: [
      { key: "especialidade", label: "Especialidade", type: "text" },
      { key: "convenio", label: "Convênio", type: "text" },
      { key: "primeira_consulta", label: "Primeira consulta?", type: "select", options: ["Sim", "Não"] },
      { key: "preferencia_horario", label: "Preferência de horário", type: "text" },
    ],
    personaId: "clinica",
    personaSeed:
      "Você é a recepcionista virtual de {negocio} no WhatsApp. Atendemos {oferta}. Fale em tom {tom}, de forma acolhedora.\n\n" +
      "Agende consultas, informe convênios aceitos, valores particulares e preparo de exames conforme o conhecimento. Pergunte a especialidade, se é a primeira consulta e a preferência de horário.\n\n" +
      "Nunca dê orientação clínica, diagnóstico ou conselho sobre medicamentos. Se o paciente relatar dor, sintoma, emergência ou perguntar sobre resultado de exame, encaminhe para a equipe e, em urgência, oriente a procurar atendimento imediato.",
    faqSeed: [
      { q: "Quais convênios vocês aceitam?", a: "[preencha] com a lista de convênios aceitos." },
      { q: "Qual o valor da consulta particular?", a: "[preencha] com os valores por especialidade." },
      { q: "Como me preparo para o exame?", a: "O preparo depende do exame. [preencha] com as orientações de cada um." },
      { q: "Onde fica a clínica e qual o horário?", a: "[preencha] com endereço, estacionamento e horários." },
      { q: "Posso remarcar minha consulta?", a: "Sim, a equipe confirma um novo horário. [preencha] com a antecedência necessária." },
    ],
    handoffKeywords: ["falar com atendente", "dor", "sintoma", "emergência", "resultado de exame", "falar com o doutor"],
    simulatorPrompts: [
      "Quero marcar uma consulta. Vocês atendem meu convênio?",
      "Quanto custa a consulta particular?",
      "Estou com dor no peito há dois dias, o que devo fazer?",
    ],
    advanceRules:
      "Quando o paciente aceitar agendar consulta ou avaliação, mova o lead para Consulta agendada. Nunca avance o lead com base em informação clínica.",
  },
  {
    key: "ecommerce",
    label: "Loja / e-commerce",
    icon: "ShoppingCart",
    funnel: {
      boardName: "Funil da loja",
      boardColor: C.pink,
      stages: [
        { name: "Interessado", color: C.blue },
        { name: "Dúvida respondida", color: C.purple },
        { name: "Carrinho ou pedido", color: C.amber },
        { name: "Pago (ganho)", color: C.green, isClosedWon: true },
        { name: "Desistiu", color: C.gray, isClosedLost: true },
      ],
    },
    fields: [
      { key: "produto_interesse", label: "Produto de interesse", type: "text" },
      { key: "tamanho_variacao", label: "Tamanho ou variação", type: "text" },
      { key: "cidade_frete", label: "Cidade (frete)", type: "text" },
    ],
    personaId: "ecommerce",
    personaSeed:
      "Você é o vendedor virtual de {negocio} no WhatsApp. Vendemos {oferta}. Fale em tom {tom}, de forma simpática.\n\n" +
      "Tire dúvidas de produto, disponibilidade, prazo e frete conforme o conhecimento e envie o link de compra quando o cliente decidir.\n\n" +
      "Trocas, devoluções, defeito, pedido atrasado e reembolso vão para a equipe: avise o cliente que um atendente vai assumir.",
    faqSeed: [
      { q: "Qual o prazo de entrega?", a: "[preencha] com prazos por região." },
      { q: "Como é calculado o frete?", a: "[preencha] com regras de frete e frete grátis." },
      { q: "Como funcionam trocas e devoluções?", a: "[preencha] com prazo e condições de troca e devolução." },
      { q: "Quais as formas de pagamento?", a: "[preencha] com Pix, cartão e parcelamento." },
    ],
    handoffKeywords: ["falar com atendente", "troca", "devolução", "pedido atrasado", "defeito", "reembolso"],
    simulatorPrompts: [
      "Esse produto tem em outro tamanho? Quanto fica o frete para a minha cidade?",
      "Quais as formas de pagamento?",
      "Meu pedido está atrasado e quero reembolso.",
    ],
    advanceRules:
      "Quando o cliente escolher o produto e pedir link ou forma de pagamento, mova o lead para Carrinho ou pedido.",
  },
  {
    key: "educacao",
    label: "Educação / cursos",
    icon: "GraduationCap",
    funnel: {
      boardName: "Funil de matrículas",
      boardColor: C.cyan,
      stages: [
        { name: "Interessado", color: C.blue },
        { name: "Informações enviadas", color: C.purple },
        { name: "Aula experimental", color: C.amber },
        { name: "Matrícula (ganho)", color: C.green, isClosedWon: true },
        { name: "Não matriculou", color: C.gray, isClosedLost: true },
      ],
    },
    fields: [
      { key: "curso_interesse", label: "Curso de interesse", type: "text" },
      { key: "modalidade", label: "Modalidade", type: "select", options: ["Online", "Presencial"] },
      { key: "turno", label: "Turno", type: "select", options: ["Manhã", "Tarde", "Noite"] },
      { key: "para_quem", label: "Para quem é", type: "text" },
    ],
    personaId: "educacao",
    personaSeed:
      "Você é o consultor de matrículas virtual de {negocio} no WhatsApp. Oferecemos {oferta}. Fale em tom {tom}.\n\n" +
      "Entenda o objetivo do aluno, recomende o curso mais adequado e informe datas, valores e modalidades conforme o conhecimento. Convide para uma aula experimental quando houver interesse.\n\n" +
      "Bolsa, desconto, matrícula e cancelamento vão para a coordenação: avise que a equipe continuará o atendimento.",
    faqSeed: [
      { q: "Quando começam as próximas turmas?", a: "[preencha] com as datas de início por curso." },
      { q: "Quais os valores e o parcelamento?", a: "[preencha] com mensalidade, matrícula e formas de pagamento." },
      { q: "O curso dá certificado?", a: "[preencha] com tipo de certificado e carga horária." },
      { q: "O curso é online ou presencial?", a: "[preencha] com as modalidades de cada curso." },
    ],
    handoffKeywords: ["falar com atendente", "bolsa", "desconto", "fazer matrícula", "quero me matricular", "cancelar", "falar com coordenação"],
    simulatorPrompts: [
      "Quero saber mais sobre os cursos. Qual é indicado para quem está começando?",
      "Quanto custa e quando começa a próxima turma?",
      "Existe bolsa ou desconto para matrícula?",
    ],
    advanceRules:
      "Quando o aluno pedir informações de um curso, mova para Informações enviadas. Quando aceitar uma aula experimental, mova para Aula experimental.",
  },
  {
    key: "outro",
    label: "Outro",
    icon: "MoreHorizontal",
    funnel: {
      boardName: "Funil de vendas",
      boardColor: C.blue,
      stages: [
        { name: "Novo lead", color: C.blue },
        { name: "Em conversa", color: C.purple },
        { name: "Proposta", color: C.amber },
        { name: "Ganho", color: C.green, isClosedWon: true },
        { name: "Perdido", color: C.gray, isClosedLost: true },
      ],
    },
    fields: [],
    personaId: "geral",
    personaSeed:
      "Você é o atendente virtual de {negocio} no WhatsApp. Oferecemos {oferta}. Fale em tom {tom}.\n\n" +
      "Entenda a necessidade do cliente e responda apenas com o que está no conhecimento. Quando não souber, diga que vai chamar a equipe.\n\n" +
      "Se o cliente pedir para falar com uma pessoa ou fizer uma reclamação, passe a conversa para a equipe.",
    faqSeed: [
      { q: "Qual o horário de atendimento?", a: "[preencha] com dias e horários de funcionamento." },
      { q: "Como posso entrar em contato?", a: "[preencha] com telefone, e-mail e endereço." },
      { q: "Como faço para comprar?", a: "[preencha] com o passo a passo da compra ou contratação." },
      { q: "Quais as formas de pagamento?", a: "[preencha] com as formas aceitas." },
    ],
    handoffKeywords: ["falar com atendente", "falar com humano", "reclamação"],
    simulatorPrompts: [
      "Olá, quero saber mais sobre o que vocês oferecem.",
      "Qual o horário de funcionamento?",
      "Quero falar com uma pessoa da equipe.",
    ],
    advanceRules:
      "Quando o cliente demonstrar interesse claro, mova para Em conversa. Quando pedir preço ou orçamento, mova para Proposta.",
  },
];

/** Segmentos na ordem da tela (sem `financeiro`, que é legado). */
export const SEGMENT_TEMPLATES: readonly SegmentTemplate[] = SEGMENT_LIST;

const LEGACY_SEGMENT_MAP: Record<string, SegmentKey> = {
  financeiro: "servicos",
};

/** Modelo do segmento; chave desconhecida cai em `outro`, legado é mapeado. */
export function segmentTemplate(key: string | undefined | null): SegmentTemplate {
  const k = (key ?? "").toLowerCase();
  const mapped = LEGACY_SEGMENT_MAP[k] ?? k;
  return (
    SEGMENT_LIST.find((t) => t.key === mapped) ??
    SEGMENT_LIST[SEGMENT_LIST.length - 1]
  );
}

/**
 * Substitui {negocio}, {oferta}, {tom}. Negócio ausente vira "nossa empresa";
 * oferta ou tom ausentes removem a frase inteira que os contém.
 */
export function renderPersonaSeed(
  template: SegmentTemplate,
  business: BusinessInfo,
): string {
  const values: Record<string, string> = {
    negocio: (business.negocio ?? "").trim() || "nossa empresa",
    oferta: (business.oferta ?? "").trim(),
    tom: (business.tom ?? "").trim(),
  };
  return template.personaSeed
    .split("\n")
    .map((line) => {
      const sentences = line.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [];
      return sentences
        .map((sentence) => {
          let missing = false;
          const out = sentence.replace(
            /\{(negocio|oferta|tom)\}/g,
            (_m, name: string) => {
              if (!values[name]) missing = true;
              return values[name];
            },
          );
          return missing ? "" : out;
        })
        .join("")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    })
    .filter((line) => line.length > 0)
    .join("\n\n");
}
