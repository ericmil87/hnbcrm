/**
 * Prova social da landing (S7b): depoimentos, logos e fatos verificáveis. Cada
 * item diz se é real. Em produção (`import.meta.env.PROD`) só aparece item com
 * `real: true`; em desenvolvimento aparecem também os exemplos, com o selo
 * "Exemplo ilustrativo". As cenas de "Um dia com o HNBCRM" moram em
 * `dayInTheLife.ts` (exemplo assumido na própria seção, sem selo por item).
 *
 * Regra (CDC arts. 37 e 38): nada de depoimento, logo ou número de clientes
 * que não exista e não esteja autorizado por escrito. Para publicar um
 * depoimento real, acrescente um item `{ kind: "depoimento", real: true, ... }`.
 */
import { TRIAL } from "../../../convex/lib/plans";

export type SocialProofKind = "depoimento" | "fato" | "logo";

interface SocialProofBase {
  id: string;
  /** `true` só com fato verdadeiro (e autorizado, no caso de pessoa ou marca). */
  real: boolean;
}

export interface TestimonialItem extends SocialProofBase {
  kind: "depoimento";
  quote: string;
  name: string;
  business: string;
  city?: string;
}

/** Fato verificável no código ou no catálogo de planos (nunca métrica de clientes). */
export interface FactItem extends SocialProofBase {
  kind: "fato";
  title: string;
  text: string;
}

export interface LogoItem extends SocialProofBase {
  kind: "logo";
  name: string;
  /** Caminho do arquivo em `public/` (logo autorizado por escrito). */
  src: string;
}

export type SocialProofItem = TestimonialItem | FactItem | LogoItem;

/** Itens reais: os únicos que vão para o bundle de produção. */
const REAL_ITEMS: readonly SocialProofItem[] = [
  { kind: "fato", id: "fato-usuarios", real: true, title: "Usuários ilimitados", text: "em todos os planos: a equipe inteira entra, sem preço por pessoa" },
  { kind: "fato", id: "fato-teste", real: true, title: `${TRIAL.days} dias grátis`, text: "de teste, sem cartão de crédito" },
  { kind: "fato", id: "fato-aberto", real: true, title: "Código aberto", text: "com histórico público de mudanças, em português" },
  { kind: "fato", id: "fato-dados", real: true, title: "Seus dados são seus", text: "e podem ser exportados a qualquer momento" },
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

/** O selo "Exemplo ilustrativo" aparece só em item não real (exemplos de DEV). */
export function needsExampleBadge(item: SocialProofItem): boolean {
  return !item.real;
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
  return realTestimonials ? "O que dizem quem já usa" : "Um dia com o HNBCRM";
}

export const EXAMPLE_BADGE_LABEL = "Exemplo ilustrativo";
