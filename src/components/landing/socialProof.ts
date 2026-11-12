/**
 * Arquivo único da prova social da landing (S7b). Cada item diz se é real.
 * Em produção (`import.meta.env.PROD`) só aparece item com `real: true`; em
 * desenvolvimento aparecem também os exemplos, todos com o selo visível
 * "Exemplo ilustrativo". Item `illustrative: true` é uma cena declaradamente
 * ilustrativa: pode ir para produção, mas leva o selo sempre.
 *
 * Regra (CDC arts. 37 e 38): nada de depoimento, logo ou número de clientes
 * que não exista e não esteja autorizado por escrito. Para publicar um
 * depoimento real, acrescente um item `{ kind: "depoimento", real: true, ... }`.
 */
import { UI_THEMES } from "../../../convex/lib/uiTheme";

export type SocialProofKind = "depoimento" | "cena" | "numero" | "logo";

interface SocialProofBase {
  id: string;
  /** `true` só com fato verdadeiro (e autorizado, no caso de pessoa ou marca). */
  real: boolean;
  /** Cena ilustrativa: o selo "Exemplo ilustrativo" aparece também em produção. */
  illustrative?: boolean;
}

export interface TestimonialItem extends SocialProofBase {
  kind: "depoimento";
  quote: string;
  name: string;
  business: string;
  city?: string;
}

export interface SceneItem extends SocialProofBase {
  kind: "cena";
  title: string;
  text: string;
}

export interface NumberItem extends SocialProofBase {
  kind: "numero";
  value: string;
  text: string;
}

export interface LogoItem extends SocialProofBase {
  kind: "logo";
  name: string;
  /** Caminho do arquivo em `public/` (logo autorizado por escrito). */
  src: string;
}

export type SocialProofItem = TestimonialItem | SceneItem | NumberItem | LogoItem;

/** Canais da caixa de entrada citados na copy (a contagem sai desta lista). */
export const INBOX_CHANNELS = ["WhatsApp", "Instagram", "Messenger", "Telegram para a equipe"] as const;

/** Itens reais ou declaradamente ilustrativos: os únicos que vão para o bundle de produção. */
const REAL_ITEMS: readonly SocialProofItem[] = [
  // Cenas de uso: declaradamente ilustrativas (selo sempre).
  {
    kind: "cena",
    id: "cena-consultorio",
    real: true,
    illustrative: true,
    title: "Como um consultório usa",
    text: "À noite, o Atendente responde quem pergunta valor e horário. De manhã, a recepção abre o app e confirma os agendamentos que ficaram anotados.",
  },
  {
    kind: "cena",
    id: "cena-terapeuta",
    real: true,
    illustrative: true,
    title: "Como um terapeuta usa",
    text: "A IA escreve, ele aprova entre uma sessão e outra. O print do Pix chega lido, e ele só confirma o pagamento.",
  },
  {
    kind: "cena",
    id: "cena-comunidade",
    real: true,
    illustrative: true,
    title: "Como uma comunidade usa",
    text: "Todo dia sai a mensagem do dia nos grupos. Quem pergunta a data do encontro recebe a resposta e o flyer.",
  },
  // Números que são verdade.
  {
    kind: "numero",
    id: "num-canais",
    real: true,
    value: String(INBOX_CHANNELS.length),
    text: `canais na mesma caixa de entrada (${INBOX_CHANNELS.slice(0, -1).join(", ")} e ${INBOX_CHANNELS[INBOX_CHANNELS.length - 1]})`,
  },
  {
    kind: "numero",
    id: "num-temas",
    real: true,
    value: String(UI_THEMES.length),
    text: "temas, com o estilo WhatsApp como padrão",
  },
  { kind: "numero", id: "num-testes", real: true, value: "Milhares", text: "de testes automatizados a cada versão" },
  { kind: "numero", id: "num-aberto", real: true, value: "Código aberto", text: "e changelog público em português" },
];

/** Exemplos falsos para ver os cartões em DEV. Nunca entram no bundle de produção (ver `SOCIAL_PROOF`). */
const EXAMPLE_ITEMS: readonly SocialProofItem[] = [
  // Depoimentos: nenhum real até haver autorização. Os de exemplo só existem em DEV.
  {
    kind: "depoimento",
    id: "dep-exemplo-1",
    real: false,
    quote: "Texto de exemplo para ver o cartão de depoimento.",
    name: "Nome de exemplo",
    business: "Clínica",
    city: "Cidade",
  },
  {
    kind: "depoimento",
    id: "dep-exemplo-2",
    real: false,
    quote: "Outro texto de exemplo para ver o cartão de depoimento.",
    name: "Nome de exemplo",
    business: "Terapeuta",
  },
  {
    kind: "depoimento",
    id: "dep-exemplo-3",
    real: false,
    quote: "Mais um texto de exemplo para ver o cartão de depoimento.",
    name: "Nome de exemplo",
    business: "Corretor",
  },
  // Logos: nenhum autorizado por escrito.
  { kind: "logo", id: "logo-exemplo", real: false, name: "Marca de exemplo", src: "" },
];

/**
 * `import.meta.env.DEV` é trocado por `false` no build e o minificador descarta
 * `EXAMPLE_ITEMS`: "Nome de exemplo" não existe em `dist`. `visibleSocialProof`
 * continua como segunda barreira.
 */
export const SOCIAL_PROOF: readonly SocialProofItem[] = [...REAL_ITEMS, ...(import.meta.env.DEV ? EXAMPLE_ITEMS : [])];

/** Em produção só itens reais; fora dela, tudo (os não reais levam o selo). */
export function visibleSocialProof(items: readonly SocialProofItem[], prod: boolean): SocialProofItem[] {
  return prod ? items.filter((i) => i.real) : [...items];
}

/** O selo "Exemplo ilustrativo" aparece em item não real ou declaradamente ilustrativo. */
export function needsExampleBadge(item: SocialProofItem): boolean {
  return !item.real || item.illustrative === true;
}

/** Itens de um tipo, com o tipo estreitado. */
export function itemsOfKind<K extends SocialProofKind>(
  items: readonly SocialProofItem[],
  kind: K,
): Extract<SocialProofItem, { kind: K }>[] {
  return items.filter((i): i is Extract<SocialProofItem, { kind: K }> => i.kind === kind);
}

/** Título da seção: o dos depoimentos só com depoimento de verdade à mostra. */
export function socialProofTitle(items: readonly SocialProofItem[]): string {
  const realTestimonials = itemsOfKind(items, "depoimento").some((t) => t.real);
  return realTestimonials ? "O que dizem quem já usa" : "Como é usar no dia a dia";
}

export const EXAMPLE_BADGE_LABEL = "Exemplo ilustrativo";
