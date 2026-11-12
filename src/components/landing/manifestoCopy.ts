/**
 * Manifesto do HNBCRM (`/manifesto` e o trecho da landing) e a apresentação do autor.
 * Texto em primeira pessoa, assinado pelo autor. Dado puro: as telas só leem daqui.
 * Nenhum número de clientes, depoimento ou métrica entra aqui.
 */

export const MANIFESTO_TITLE = "Gente e IA no mesmo time";
export const MANIFESTO_EYEBROW = "Manifesto";
export const MANIFESTO_LEAD =
  "HNB quer dizer Humans and Bots. O nome é a ideia inteira: atendimento bom, daqui para a frente, é feito por pessoas e por IA trabalhando juntas. Este texto explica por que eu acredito nisso, e por que o HNBCRM é do jeito que é.";

export interface ManifestoChapter {
  id: string;
  title: string;
  paragraphs: readonly string[];
}

export const MANIFESTO_CHAPTERS: readonly ManifestoChapter[] = [
  {
    id: "resposta",
    title: "Quem chama quer resposta",
    paragraphs: [
      "No Brasil, o WhatsApp virou o balcão de quase todo negócio. É por ali que o cliente pergunta o preço, marca o horário, manda o comprovante e reclama.",
      "Só que ninguém consegue ficar no balcão o dia inteiro. Quem está atendendo uma pessoa não responde a outra. Quem fechou às seis não responde às dez da noite. E cliente que fica esperando não reclama: só compra de quem respondeu primeiro.",
      "O HNBCRM existe para que ninguém fique sem resposta, sem que o dono do negócio precise viver com o celular na mão.",
    ],
  },
  {
    id: "humanos-e-bots",
    title: "Nem robô sozinho, nem gente sozinha",
    paragraphs: [
      "Todo mundo já foi atendido por um robô de menu e saiu irritado. E todo mundo já ficou horas esperando uma pessoa ocupada. Os dois extremos falham.",
      "A IA é boa no que cansa gente: responder a mesma pergunta pela vigésima vez, de madrugada, com a mesma paciência. Gente é boa no que a IA não deve decidir: negociar, acolher, abrir uma exceção, perceber que hoje aquele cliente precisa de outra conversa.",
      "Por isso, aqui a IA é um membro do time. Tem nome, tem função, tem permissões e deixa registrado tudo o que faz, como qualquer colega. E a parte em que mais trabalhamos é a passagem: a IA chama uma pessoa com o resumo pronto, e a pessoa devolve a conversa com uma instrução. Ninguém começa do zero.",
    ],
  },
  {
    id: "controle",
    title: "Você no comando",
    paragraphs: [
      "Uma IA falando em nome do seu negócio é coisa séria. Então ela começa sugerindo: escreve a resposta e você aprova. O automático só liga quando você decide que confia.",
      "Ela só existe na sua conta depois que o administrador aceita. Tudo o que ela manda passa por um filtro antes de sair. Ela nunca confirma um pagamento sozinha. E quando não sabe, chama alguém.",
      "Também não tratamos você como criança. Quando uma escolha tem risco, nós explicamos o risco e deixamos a decisão com você. Somos uma ferramenta. O negócio é seu.",
    ],
  },
  {
    id: "codigo-aberto",
    title: "Por que código aberto",
    paragraphs: [
      "Um CRM guarda o que um negócio tem de mais valioso: a relação com os clientes. Agora some a isso uma IA que conversa com eles. Você tem o direito de saber como isso funciona por dentro.",
      "O código do HNBCRM é aberto, com licença MIT. Qualquer pessoa pode ler, auditar, rodar no próprio servidor e adaptar. Cada mudança fica num histórico público, escrito em português.",
      "Isso também é uma garantia. Se um dia você quiser sair, exporta tudo. Se um dia nós sairmos do ar, o software continua existindo. Confiança não se pede: se mostra.",
    ],
  },
  {
    id: "tempo-real",
    title: "Por que tudo em tempo real",
    paragraphs: [
      "Conversa acontece ao vivo. Quando várias mãos atendem o mesmo WhatsApp, um segundo de atraso vira duas pessoas respondendo o mesmo cliente, ou a IA respondendo quem já foi atendido.",
      "Por isso o HNBCRM foi construído sobre um banco de dados reativo, o Convex: o que muda aparece na tela de todo mundo na hora, sem ninguém apertar atualizar. O mesmo código, em TypeScript, vai do servidor à tela, e o sistema instala no celular como aplicativo e avisa mesmo fechado.",
      "E ele conversa com outras máquinas. Tem API, tem webhooks e tem um servidor MCP, para que os seus próprios agentes de IA trabalhem dentro do CRM com as mesmas regras de permissão da equipe. Humanos e bots no mesmo time vale também para os bots que você trouxer.",
    ],
  },
  {
    id: "equipe-inteira",
    title: "Equipe não se cobra por cabeça",
    paragraphs: [
      "Cobrar por usuário faz as empresas deixarem gente de fora para economizar. É o contrário do que um atendimento precisa.",
      "No HNBCRM a equipe é ilimitada. O preço acompanha o quanto a IA trabalhou por você no mês, e não quantas pessoas têm acesso.",
    ],
  },
  {
    id: "brasil",
    title: "Feito aqui, para quem vende conversando",
    paragraphs: [
      "O HNBCRM nasceu no Recife, em português, pensando em clínica, consultório, loja, corretor, produtor de evento. Gente que vende conversando, pelo WhatsApp, com Pix, e que leva a sério a privacidade de quem atende.",
      "Não é um sistema estrangeiro traduzido. É o sistema que eu queria ter.",
    ],
  },
];

export const MANIFESTO_CLOSING = "Um time só, de gente e de IA. E ninguém esperando resposta.";
export const MANIFESTO_SIGNATURE = "Eric Milfont, Recife";

/** Trecho que aparece na landing, com link para o texto completo. */
export const MANIFESTO_TEASER = {
  quote: "A IA é boa no que cansa gente. Gente é boa no que a IA não deve decidir. O HNBCRM existe para os dois trabalharem no mesmo time.",
  cta: "Ler o manifesto",
} as const;

export const MANIFESTO_SEO = {
  title: "Manifesto: gente e IA no mesmo time | HNBCRM",
  description:
    "Por que o HNBCRM existe, por que é código aberto, por que junta pessoas e IA no mesmo atendimento e por que tudo acontece em tempo real.",
} as const;

/** Apresentação do autor (landing e fim do manifesto). */
export const AUTHOR = {
  name: "Eric Milfont",
  role: "Criador do HNBCRM e fundador da Inovaway",
  photo: "/brand/eric-milfont.webp",
  photoAlt: "Retrato de Eric Milfont",
  sectionEyebrow: "Quem faz",
  sectionTitle: "Tem uma pessoa por trás do HNBCRM",
  paragraphs: [
    "Sou Eric Milfont, do Recife. Programo desde os dez anos e trabalho com tecnologia há mais de vinte, um mundo onde nada vai para o ar sem ser testado, medido e testado de novo.",
    "Fiz o HNBCRM porque eu não queria um robô de menu. Queria um colega que respondesse rápido, soubesse a hora de chamar uma pessoa e deixasse tudo anotado.",
    "Fora do código, também atendo gente, como terapeuta. É o HNBCRM que responde o meu WhatsApp enquanto estou em sessão. Uso todo dia o que ofereço a você.",
  ],
  company:
    "A Inovaway é a empresa por trás do HNBCRM: tecnologia e times de IA para pequenos e médios negócios, com sede no Recife.",
  links: [
    { label: "Site do Eric", href: "https://eric.milfont.net/" },
    { label: "GitHub", href: "https://github.com/ericmil87" },
    { label: "Inovaway", href: "https://inovaway.org" },
  ],
} as const;

/** Comunidade e newsletter (S8). */
export const COMMUNITY_COPY = {
  eyebrow: "Comunidade",
  title: "Ninguém aprende a atender com IA sozinho",
  subtitle: "Entre no grupo de quem está fazendo isso agora, ou receba as novidades por e-mail. Os dois são de graça.",
  group: {
    title: "Grupo no WhatsApp",
    tagline: "Para trocar ideia",
    lines: [
      "Dúvida respondida por quem já passou por ela",
      "Novidades do HNBCRM em primeira mão",
      "Regras simples, fixadas na descrição",
    ],
    cta: "Entrar no grupo do WhatsApp",
    qrCaption: "Aponte a câmera do celular para entrar.",
  },
  newsletter: {
    title: "Novidades por e-mail",
    tagline: "Para acompanhar sem barulho",
    text: "Um e-mail quando sair coisa nova: o que mudou, por que mudou e como usar. Só quando valer o seu tempo.",
    nameLabel: "Seu nome (opcional)",
    emailLabel: "Seu e-mail",
    emailPlaceholder: "voce@empresa.com.br",
    cta: "Quero receber",
    consent: "Ao se inscrever, você aceita receber e-mails do HNBCRM. Para sair, é só responder qualquer e-mail pedindo.",
    success: "Pronto, você está na lista. A próxima novidade chega no seu e-mail.",
  },
  openSource: {
    title: "Código aberto",
    tagline: "Para quem quer ver por dentro",
    text: "Acompanhe o desenvolvimento, sugira melhorias ou contribua com código.",
    repoLabel: "Ver no GitHub",
    repoHref: "https://github.com/ericmil87/hnbcrm",
    changelogLabel: "O que mudou em cada versão",
    changelogHref: "https://github.com/ericmil87/hnbcrm/blob/main/CHANGELOG.md",
  },
} as const;
