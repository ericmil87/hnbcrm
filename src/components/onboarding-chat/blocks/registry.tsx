import { Component, createContext, useContext, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import type { BlockContext, BlockProps, OnboardingBlock, OnboardingBlockKind } from "./types";
import { ChipsBlock } from "./ChipsBlock";
import { ResumoNegocioBlock } from "./ResumoNegocioBlock";
import { FunilPreviewBlock } from "./FunilPreviewBlock";
import { CartaoContaBlock } from "./CartaoContaBlock";
import { CartaoAceiteBlock } from "./CartaoAceiteBlock";
import { AvisoMateriaisBlock } from "./AvisoMateriaisBlock";
import { UploadProgressoBlock } from "./UploadProgressoBlock";
import { PersonaCardBlock } from "./PersonaCardBlock";
import { ConhecimentoListaBlock } from "./ConhecimentoListaBlock";
import { RespostasRapidasBlock } from "./RespostasRapidasBlock";
import { AplicarOperacaoBlock } from "./AplicarOperacaoBlock";
import { SimuladorBlock } from "./SimuladorBlock";
import { ConectarCanalBlock } from "./ConectarCanalBlock";
import { ProximosPassosBlock } from "./ProximosPassosBlock";
import { TraducaoCartaoBlock } from "./TraducaoCartaoBlock";
import { AtivarIaBlock } from "./AtivarIaBlock";
import { OperacaoProntaBlock } from "./OperacaoProntaBlock";
import { UnknownBlock } from "./UnknownBlock";

/**
 * Registro de blocos ricos do onboarding: um componente por `kind` do union
 * `OnboardingBlock` (`convex/lib/onboardingBlocks.ts`). O tipo mapeado obriga
 * uma entrada para cada `kind` (um tipo novo no servidor quebra o `tsc` aqui).
 *
 * Divisão de trabalho: P3.1 implementou `chips`, `resumoNegocio`,
 * `funilPreview` e o `UnknownBlock`; os demais são stubs, um arquivo por bloco,
 * para P3.2 (conta, aceite, aviso de materiais, upload) e P3.3 (rascunho,
 * aplicar, simulador, canal, próximos passos, tradução) trocarem só o próprio
 * arquivo. O mesmo registro poderá servir o painel do Copiloto depois.
 */
export type BlockRegistry = { [K in OnboardingBlockKind]: ComponentType<BlockProps<K>> };

export const BLOCK_REGISTRY: BlockRegistry = {
  chips: ChipsBlock,
  cartaoConta: CartaoContaBlock,
  cartaoAceite: CartaoAceiteBlock,
  resumoNegocio: ResumoNegocioBlock,
  funilPreview: FunilPreviewBlock,
  personaCard: PersonaCardBlock,
  conhecimentoLista: ConhecimentoListaBlock,
  respostasRapidas: RespostasRapidasBlock,
  uploadProgresso: UploadProgressoBlock,
  aplicarOperacao: AplicarOperacaoBlock,
  simulador: SimuladorBlock,
  conectarCanal: ConectarCanalBlock,
  proximosPassos: ProximosPassosBlock,
  traducaoCartao: TraducaoCartaoBlock,
  avisoMateriais: AvisoMateriaisBlock,
  ativarIa: AtivarIaBlock,
  operacaoPronta: OperacaoProntaBlock,
};

/**
 * Troca de componentes por `kind` (só a vitrine de DEV, `dev/OnboardingShowcase`, usa: ela alimenta as Views
 * apresentacionais com dados fixos, sem Convex). Sem provedor, vale o `BLOCK_REGISTRY`.
 */
export type BlockOverrides = Partial<{ [K in OnboardingBlockKind]: ComponentType<BlockProps<K>> }>;
export const BlockOverridesContext = createContext<BlockOverrides | null>(null);

/** `kind` conhecido por este cliente (o payload vem da rede: nunca confiar no formato). */
export function knownBlock(raw: unknown): OnboardingBlock | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(BLOCK_REGISTRY, kind)) return null;
  return raw as OnboardingBlock;
}

interface BoundaryProps {
  children: ReactNode;
}

/** Um bloco com payload inesperado não derruba a conversa: vira `UnknownBlock`. */
class BlockBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Sem log do payload (pode ter texto do negócio).
  }
  render() {
    return this.state.failed ? <UnknownBlock /> : this.props.children;
  }
}

export interface OnboardingBlockViewProps {
  /** Bloco cru (do stream ou do histórico). */
  block: unknown;
  ctx: BlockContext;
}

/** Renderiza um bloco pelo registro; tipo desconhecido ou erro de render = `UnknownBlock`. */
export function OnboardingBlockView({ block, ctx }: OnboardingBlockViewProps) {
  const overrides = useContext(BlockOverridesContext);
  const known = knownBlock(block);
  if (!known) return <UnknownBlock />;
  // O registro é indexado pelo próprio `kind` do bloco: o par (componente, bloco) é coerente.
  const View = (overrides?.[known.kind] ?? BLOCK_REGISTRY[known.kind]) as ComponentType<{ block: OnboardingBlock; ctx: BlockContext }>;
  return (
    <BlockBoundary>
      <View block={known} ctx={ctx} />
    </BlockBoundary>
  );
}
