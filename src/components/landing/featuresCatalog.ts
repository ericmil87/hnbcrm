/**
 * Catálogo público de funcionalidades (`/funcionalidades` e a seção resumida da landing).
 * Dado puro: a página e a seção só leem daqui.
 *
 * Regra de verdade: `status: "pronto"` só para o que está no CHANGELOG; "opcional" é recurso
 * pronto que vem desligado e o administrador liga; "em-liberacao" depende de terceiro;
 * "em-breve" tem plano escrito; "no-radar" está em estudo, sem data. Nunca promova um item
 * a "pronto" sem entrada no CHANGELOG.
 */
import {
  Bell,
  Bot,
  Building2,
  Code,
  Database,
  Kanban,
  ListChecks,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Send,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

export type FeatureStatus = "pronto" | "opcional" | "em-liberacao" | "em-breve" | "no-radar";

export const FEATURE_STATUS_LABEL: Record<FeatureStatus, string> = {
  pronto: "Pronto",
  opcional: "Você liga se quiser",
  "em-liberacao": "Em liberação",
  "em-breve": "Em breve",
  "no-radar": "No radar",
};

export interface FeatureItem {
  name: string;
  /** Benefício em uma frase, na língua de quem atende. */
  text: string;
  /** Ausente = "pronto". */
  status?: FeatureStatus;
}

export interface FeatureArea {
  id: string;
  title: string;
  icon: LucideIcon;
  /** Uma linha que resume a área. */
  summary: string;
  items: readonly FeatureItem[];
}

export const FEATURE_AREAS: readonly FeatureArea[] = [
  {
    id: "conversas",
    title: "Conversas",
    icon: MessagesSquare,
    summary: "Todas as conversas num lugar só, com cara de WhatsApp e memória de CRM.",
    items: [
      { name: "Caixa de entrada única", text: "WhatsApp, Instagram e Messenger na mesma lista, com notas internas, reações, respostas e encaminhamento." },
      { name: "Busca que acha de verdade", text: "Procura em mensagens, em áudios transcritos e até no texto das imagens, sem ligar para acento." },
      { name: "Respostas rápidas", text: "Digite / e mande em um toque o que você responde vinte vezes por dia." },
      { name: "Mensagens agendadas", text: "Escreva agora e deixe sair na hora certa." },
      { name: "Não lidas em destaque", text: "O que está esperando resposta sobe e aparece no menu." },
      { name: "Nova conversa", text: "Comece a conversa pelo CRM. O número é conferido no WhatsApp antes de virar contato." },
      { name: "Rascunho guardado", text: "O que você estava digitando continua lá quando você volta." },
    ],
  },
  {
    id: "whatsapp",
    title: "WhatsApp",
    icon: MessageCircle,
    summary: "O balcão do seu negócio, ligado ao CRM do jeito que você preferir.",
    items: [
      { name: "Dois jeitos de conectar", text: "Pela API oficial da Meta ou por QR code, como no WhatsApp Web. Você escolhe, e nós avisamos os riscos de cada um." },
      { name: "Áudio, foto, vídeo e arquivo", text: "Envia e recebe tudo, com os tiques de entregue e lido e o \"digitando…\"." },
      { name: "Transcrição de áudio", text: "O áudio do cliente vira texto para ler, buscar e para a IA entender.", status: "opcional" },
      { name: "O que você manda do celular também entra", text: "Respondeu pelo aparelho? A conversa fica completa no CRM." },
      { name: "Saúde do número", text: "Se o número cair ou for bloqueado, você fica sabendo na hora e os envios automáticos param sozinhos." },
      { name: "Ritmo seguro de envio", text: "Fila com pausas e simulação de digitação para não tratar o seu número como robô." },
      { name: "Números de qualquer país", text: "Atende clientes do Brasil e de fora, com o país padrão da sua empresa." },
    ],
  },
  {
    id: "atendente",
    title: "Atendente IA",
    icon: Bot,
    summary: "Uma IA que fala com o seu cliente do seu jeito, e sabe a hora de chamar gente.",
    items: [
      { name: "Sugere antes de responder sozinha", text: "Começa escrevendo rascunhos para você aprovar. O automático é você quem libera, quando confiar." },
      { name: "Entende áudio, foto e PDF", text: "O cliente manda do jeito que quiser: comprovante, cardápio, exame, voz." },
      { name: "Responde em áudio", text: "Quando o cliente fala por áudio, a IA pode responder por áudio.", status: "opcional" },
      { name: "Preenche o CRM enquanto conversa", text: "Nome, interesse, orçamento: o que o cliente conta vai para o lugar certo." },
      { name: "Anda com o lead no funil", text: "Avança a etapa quando a conversa mostra que o cliente avançou." },
      { name: "Consulta a sua agenda", text: "Lê a agenda de eventos e horários que você publicar e responde com a informação atual." },
      { name: "Follow-up que ela mesma faz", text: "Combinou de voltar a falar na sexta? Ela agenda e manda a mensagem na sexta." },
      { name: "Filtro antes de sair", text: "Tudo o que a IA manda passa por uma checagem. Ela nunca confirma pagamento sozinha." },
      { name: "Não conversa com robô", text: "Percebe quando do outro lado é um bot e para, em vez de entrar em loop." },
      { name: "Teto de gasto em reais", text: "Você define o máximo do mês e é avisado antes de chegar lá." },
      { name: "Simulador", text: "Converse com a sua IA como se fosse cliente antes de conectar um número." },
    ],
  },
  {
    id: "equipe",
    title: "IA e equipe no mesmo time",
    icon: UserCheck,
    summary: "A passagem entre a IA e as pessoas é a parte mais cuidada do produto.",
    items: [
      { name: "Pedido de ajuda com resumo", text: "Quando a conversa pede gente, a IA chama a equipe e entrega o resumo pronto." },
      { name: "Espiar antes de assumir", text: "Veja a conversa e o que já foi levantado antes de entrar." },
      { name: "Assumir em um toque", text: "Você entra, a IA para naquela conversa e o lead fica com você." },
      { name: "Devolver com instrução", text: "Diga \"o Pix é este\" e devolva. Ela segue de onde parou, sabendo o que você ensinou." },
      { name: "Avisos onde você estiver", text: "Sino, push no celular, e-mail e Telegram." },
    ],
  },
  {
    id: "copiloto",
    title: "Copiloto",
    icon: Sparkles,
    summary: "A IA que fala com você, não com o cliente.",
    items: [
      { name: "Pergunte ao seu CRM", text: "\"Quem pediu preço hoje?\" Ele responde e já oferece o próximo passo." },
      { name: "Faz por você, com as suas permissões", text: "Cria tarefa, move lead, agenda mensagem. Ação sensível pede confirmação." },
      { name: "Configuração por conversa", text: "Conte como é o seu negócio e ele monta atendente, funil e respostas rápidas para você ajustar." },
      { name: "Lê o seu material", text: "Site, PDF, flyer ou áudio: ele aproveita o que você já tem escrito." },
      { name: "No Telegram", text: "Resumo do dia, pedidos de ajuda com botões e conversa por texto ou voz, direto no celular.", status: "opcional" },
    ],
  },
  {
    id: "funil",
    title: "Funil e contatos",
    icon: Kanban,
    summary: "Saber em que pé está cada cliente, sem planilha.",
    items: [
      { name: "Funil de arrastar e soltar", text: "Etapas do seu jeito, em quadro ou em lista, com quanto tempo cada negócio está parado." },
      { name: "Ações em massa", text: "Mova, atribua, etiquete ou arquive vários leads de uma vez." },
      { name: "Ganhou, perdeu e por quê", text: "Fechamento com motivo e valor, venha de quem vier: pessoa, IA ou integração." },
      { name: "Ficha completa do contato", text: "Mais de 20 campos, campos personalizados e idioma preferido." },
      { name: "De onde veio o lead", text: "Anúncio, campanha e origem ficam gravados no lead." },
      { name: "Formulários", text: "Monte um formulário, publique o link ou embuta no site, e cada envio vira lead." },
    ],
  },
  {
    id: "tarefas",
    title: "Tarefas e agenda",
    icon: ListChecks,
    summary: "O que foi combinado com o cliente não fica na memória de ninguém.",
    items: [
      { name: "Projetos e quadro de tarefas", text: "Colunas, etiquetas, subtarefas e mais de um responsável, que pode ser gente ou IA." },
      { name: "Lembretes", text: "Aviso antes e na hora do vencimento." },
      { name: "Tarefa ligada ao lead", text: "Da tarefa para a conversa em um toque, e de volta." },
      { name: "Agenda", text: "Dia, semana e mês, com arrastar para remarcar." },
    ],
  },
  {
    id: "campanhas",
    title: "Campanhas e grupos",
    icon: Megaphone,
    summary: "Falar com muita gente sem perder o tom de conversa.",
    items: [
      { name: "Campanhas de WhatsApp", text: "Envio para um segmento, uma lista ou uma planilha, com variações de texto e relatório." },
      { name: "Horário e ritmo", text: "Sai só nos dias e horas que você definir, na velocidade segura para o seu número." },
      { name: "Quem pediu para sair, sai", text: "Lista de descadastro respeitada em todo envio." },
      { name: "Grupos de WhatsApp", text: "Acompanhe os grupos que escolher, sem transformar cada participante em lead." },
      { name: "Publicações programadas", text: "Texto fixo ou escrito pela IA, com aprovação antes de sair, se você quiser." },
      { name: "IA no grupo", text: "Responde quando é chamada e faz o resumo do que rolou." },
    ],
  },
  {
    id: "canais",
    title: "Outros canais",
    icon: Send,
    summary: "A mesma caixa de entrada para onde o seu cliente estiver.",
    items: [
      { name: "Instagram Direct", text: "Mensagens, respostas a story e a post na mesma caixa, com o Atendente IA.", status: "em-liberacao" },
      { name: "Facebook Messenger", text: "As conversas da sua página, junto com as outras.", status: "em-liberacao" },
      { name: "Tradução automática", text: "O cliente escreve em outra língua, você lê em português e a resposta sai na língua dele.", status: "opcional" },
      { name: "E-mail na caixa de entrada", text: "Receber e responder e-mail como mais uma conversa do cliente.", status: "em-breve" },
      { name: "Atendimento por Telegram", text: "Atender o seu cliente também pelo Telegram.", status: "no-radar" },
    ],
  },
  {
    id: "avisos",
    title: "Avisos e aplicativo",
    icon: Bell,
    summary: "Fica no seu celular como um aplicativo, e avisa só o que importa.",
    items: [
      { name: "Aplicativo instalável", text: "No Android, no iPhone e no computador, sem loja de aplicativos." },
      { name: "Notificações no celular", text: "Mensagem nova e pedido de ajuda chegam mesmo com o app fechado." },
      { name: "Silêncio quando você quer", text: "Pausa de uma hora, até amanhã ou horário de descanso. Só o urgente passa." },
      { name: "Resumo por e-mail", text: "O que ficou sem ler chega no e-mail, e o resumo do dia sai de manhã." },
      { name: "Quatro temas", text: "Estilo WhatsApp, WhatsApp escuro, Escuro e Claro." },
    ],
  },
  {
    id: "empresa",
    title: "Para empresas com mais gente",
    icon: Building2,
    summary: "Cresce com a operação, sem cobrar por cabeça.",
    items: [
      { name: "Usuários ilimitados", text: "Ninguém fica de fora do atendimento para economizar licença." },
      { name: "Papéis e permissões", text: "Cada pessoa vê e faz só o que o papel dela permite." },
      { name: "Várias empresas, um login", text: "Quem trabalha em mais de uma empresa troca de uma para outra sem sair." },
      { name: "Unidades e setores", text: "Transfira conversas entre setores e acompanhe cada unidade.", status: "opcional" },
      { name: "Retorno dos anúncios", text: "Quanto custou e quanto vendeu cada origem de anúncio.", status: "opcional" },
    ],
  },
  {
    id: "dados",
    title: "Seus dados",
    icon: Database,
    summary: "O que é seu continua seu, e sai com você quando quiser.",
    items: [
      { name: "Exportar tudo", text: "Planilha por tipo de dado ou uma cópia completa da conta." },
      { name: "Importar planilha", text: "Traga contatos e leads, com simulação antes e desfazer depois." },
      { name: "Histórico de alterações", text: "Quem mudou o quê e quando, pessoa ou IA." },
      { name: "Cada empresa isolada", text: "Os dados de uma empresa nunca aparecem para outra." },
      { name: "IA só com o seu aceite", text: "A IA fica desligada até o administrador ligar e aceitar o aviso de privacidade." },
    ],
  },
  {
    id: "desenvolvedores",
    title: "Para quem programa",
    icon: Code,
    summary: "Código aberto e portas abertas para as suas integrações e os seus agentes.",
    items: [
      { name: "Código aberto", text: "Licença MIT. Leia, audite, rode no seu servidor, adapte." },
      { name: "API REST", text: "Tudo o que a tela faz, com chave e permissão por rota." },
      { name: "Webhooks", text: "Seu sistema é avisado quando algo acontece no CRM, com assinatura para conferir a origem." },
      { name: "Servidor MCP", text: "Seus agentes de IA trabalham dentro do CRM com as mesmas regras da equipe." },
      { name: "Documentação e área de testes", text: "Experimente as chamadas no navegador antes de escrever código." },
    ],
  },
];

/** O que vem depois. "em-breve" tem plano escrito; "no-radar" está em estudo, sem data. */
export const FEATURE_ROADMAP: readonly (FeatureItem & { status: "em-liberacao" | "em-breve" | "no-radar" })[] = [
  { name: "Instagram e Messenger para todas as contas", text: "Já funcionam. Falta a Meta concluir a revisão do aplicativo para liberarmos a qualquer cliente.", status: "em-liberacao" },
  { name: "E-mail na caixa de entrada", text: "Receber e responder e-mail como mais uma conversa do cliente, ao lado do WhatsApp.", status: "em-breve" },
  { name: "Por que a IA respondeu isso", text: "A trilha de cada resposta: o que ela leu, o que decidiu e por quê.", status: "em-breve" },
  { name: "Perguntas que ficaram sem resposta", text: "A lista do que os clientes perguntaram e a IA não sabia, para você ensinar de uma vez.", status: "em-breve" },
  { name: "Motivos de perda e radar de risco", text: "Onde as vendas estão escapando e quais conversas estão esfriando.", status: "em-breve" },
  { name: "Página de novidades", text: "O que mudou em cada versão, em linguagem de gente, dentro do site.", status: "em-breve" },
  { name: "Programa de parceiros", text: "Para quem indica, implanta ou revende o HNBCRM.", status: "em-breve" },
  { name: "Automações", text: "Regras do tipo \"quando isso acontecer, faça aquilo\", sem programar.", status: "no-radar" },
  { name: "Distribuição automática de leads", text: "Cada lead novo vai para a próxima pessoa da vez.", status: "no-radar" },
  { name: "Leads de anúncios e portais", text: "Formulários de anúncio da Meta e portais de imóveis entrando direto no funil.", status: "no-radar" },
  { name: "Base de conhecimento com busca", text: "A IA consultando documentos longos, como tabelas e manuais.", status: "no-radar" },
  { name: "Previsão de vendas", text: "Quanto deve fechar no mês, pela chance de cada etapa.", status: "no-radar" },
  { name: "Entrar com Google e verificação em duas etapas", text: "Mais jeitos de entrar, e mais proteção na conta.", status: "no-radar" },
  { name: "Atendimento por Telegram", text: "Atender o seu cliente também pelo Telegram.", status: "no-radar" },
  { name: "Interface em inglês", text: "O HNBCRM para equipes que não trabalham em português.", status: "no-radar" },
];

export interface FeatureHighlight {
  icon: LucideIcon;
  title: string;
  text: string;
}

/** Resumo da landing: oito destaques, todos prontos hoje. */
export const FEATURE_HIGHLIGHTS: readonly FeatureHighlight[] = [
  { icon: MessagesSquare, title: "Caixa de entrada única", text: "Todas as conversas num lugar, com busca até dentro de áudio e imagem." },
  { icon: Bot, title: "Atendente IA", text: "Entende texto, áudio, foto e PDF. Sugere primeiro; o automático é você quem libera." },
  { icon: UserCheck, title: "Passagem para a equipe", text: "A IA chama gente com o resumo pronto. Você devolve com uma instrução." },
  { icon: Kanban, title: "Funil e tarefas", text: "Cada cliente na etapa certa, e o combinado virando tarefa com lembrete." },
  { icon: Megaphone, title: "Campanhas e grupos", text: "Envios em horário e ritmo seguros, e grupos com publicações programadas." },
  { icon: Bell, title: "Aplicativo no celular", text: "Instala sem loja e avisa na hora, com silêncio quando você quiser." },
  { icon: Users, title: "Equipe ilimitada", text: "Papéis, permissões e histórico de quem fez o quê, pessoa ou IA." },
  { icon: ShieldCheck, title: "Seus dados são seus", text: "Exporte tudo quando quiser. Código aberto, com API, webhooks e MCP." },
];

export function featureStatus(item: FeatureItem): FeatureStatus {
  return item.status ?? "pronto";
}

/** Contagem por situação, para o resumo no topo da página. */
export function countFeatures(areas: readonly FeatureArea[] = FEATURE_AREAS): Record<FeatureStatus, number> {
  const out: Record<FeatureStatus, number> = { pronto: 0, opcional: 0, "em-liberacao": 0, "em-breve": 0, "no-radar": 0 };
  for (const area of areas) for (const item of area.items) out[featureStatus(item)] += 1;
  return out;
}
