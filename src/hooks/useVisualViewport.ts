import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useChatModeActive } from "@/components/layout/chatMode";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { lockDocumentScroll } from "@/lib/scrollLock";
import {
  chatViewportStyle,
  computeChatViewport,
  createBaselineStore,
  sameChatViewport,
  shouldResetWindowScroll,
  type ChatViewport,
  type ViewportSample,
} from "@/lib/chatViewport";
import { createLayerStack } from "@/lib/keyboardSheet";

function sample(): ViewportSample {
  if (typeof window === "undefined") return { width: 0, innerHeight: 0 };
  const vv = window.visualViewport;
  return {
    width: window.innerWidth,
    innerHeight: window.innerHeight,
    vvHeight: vv?.height ?? null,
    vvOffsetTop: vv?.offsetTop ?? null,
    scrollY: window.scrollY,
  };
}

/**
 * Linha de base comum a todas as leituras (`lib/chatViewport`
 * `createBaselineStore`). Primeira leitura ao carregar o módulo (o app abre com
 * o teclado fechado) e a cada resize da janela, mesmo sem nenhuma camada
 * rastreando: uma folha que monta com o teclado já aberto encontra a altura
 * "fechada" daqui.
 */
export const viewportBaseline = createBaselineStore();

/**
 * Camadas (folhas, Modais, SlideOvers) que seguram a rolagem da janela agora;
 * só a do topo segura. A regra da conversa é o fundo: só zera com ela vazia.
 */
export const scrollHolders = createLayerStack();

if (typeof window !== "undefined") {
  viewportBaseline.record(sample());
  window.addEventListener("resize", () => viewportBaseline.record(sample()), { passive: true });
}

/** Marca o container da conversa (`useChatFrame`); o foco fora dele é de uma camada por cima. */
export const CHAT_FRAME_ATTR = "data-chat-frame";

/**
 * Foco numa camada por cima da conversa: fora do container (Modal, Popover e
 * Copiloto em portal) ou num diálogo aninhado nele (painéis de lead/contato/grupo
 * do `InboxOverlays` são `SlideOver` sem portal, renderizados dentro do container).
 */
function focusOutsideFrame(): boolean {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return false;
  const nearest = active.closest(`[role="dialog"], [${CHAT_FRAME_ATTR}]`);
  return !nearest || !nearest.hasAttribute(CHAT_FRAME_ATTR);
}

/** Janela rolada (foco no iOS) volta ao topo; devolve se precisou. */
function resetWindowScroll(): boolean {
  if (scrollHolders.size() > 0) return false;
  if (!shouldResetWindowScroll({ scrollY: window.scrollY, focusOutsideFrame: focusOutsideFrame() })) return false;
  window.scrollTo(0, 0);
  return true;
}

/**
 * Assinatura comum da área visível (`visualViewport`): resize/scroll da
 * visualViewport e resize/scroll/orientationchange da janela, com uma leitura
 * por quadro (rAF). `holdScroll` é chamado no próprio evento de rolagem da
 * janela (sem esperar o quadro, para não piscar a camada fora do lugar) e a
 * cada leitura: é onde cada uso desfaz a rolagem que o Safari faz ao focar um
 * campo. A linha de base é a comum (`viewportBaseline`), então uma camada que
 * monta com o teclado já aberto sabe que ele está aberto. Sem `visualViewport` (jsdom, navegador antigo) cai para `innerHeight`.
 * `enabled=false` não assina nada.
 */
export function useViewportTracking(enabled: boolean, holdScroll: () => void): ChatViewport {
  const hold = useRef(holdScroll);
  useLayoutEffect(() => {
    hold.current = holdScroll;
  }, [holdScroll]);
  const [vp, setVp] = useState<ChatViewport>(() => {
    const s = sample();
    return computeChatViewport(s, viewportBaseline.record(s));
  });

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let frame: number | null = null;
    const read = () => {
      frame = null;
      hold.current();
      const s = sample();
      const next = computeChatViewport(s, viewportBaseline.record(s));
      setVp((prev) => (sameChatViewport(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(read) : null;
      if (frame === null) read();
    };
    const onWindowScroll = () => {
      hold.current();
      schedule();
    };
    read();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", onWindowScroll, { passive: true });
    window.addEventListener("orientationchange", schedule);
    return () => {
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onWindowScroll);
      window.removeEventListener("orientationchange", schedule);
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    };
  }, [enabled]);

  return vp;
}

/**
 * Área visível da tela no modo conversa: topo, altura e teclado aberto.
 * Enquanto ligado, mantém a janela em `scrollY = 0`: o Safari do iOS rola a
 * janela ao focar o campo (mesmo com o documento travado) e aí o container
 * `fixed` em `offsetTop` sai da área visível (ver `lib/chatViewport`). Com o
 * foco num campo fora do container (`[data-chat-frame]`), como Copiloto, Modais
 * e folhas em portal, ou num diálogo aninhado nele (SlideOver do lead/contato),
 * esta regra não mexe; com qualquer camada segurando a rolagem
 * (`scrollHolders`), também não: elas seguem a área visível sozinhas
 * (`useKeyboardViewportBox`) e seguram a janela no `scrollY` de quando abriram
 * (0 no modo conversa, então as regras concordam).
 */
export function useVisualViewport(enabled = true): ChatViewport {
  return useViewportTracking(enabled, resetWindowScroll);
}

/**
 * Trava a rolagem do documento (html + body) enquanto `locked`: a página atrás
 * da conversa em tela cheia não rola nem "puxa" (overscroll) no iOS. Usa o
 * contador de `lib/scrollLock` (o mesmo de Modal/SlideOver/Popover).
 */
export function useDocumentScrollLock(locked: boolean) {
  useEffect(() => (locked ? lockDocumentScroll() : undefined), [locked]);
}

const MOBILE_QUERY = "(max-width: 767px)";

/**
 * Props do container da tela de Conversas (Inbox). Com a conversa aberta liga o
 * modo conversa (AppShell esconde cabeçalho, abas e FAB abaixo de `md`) e, no
 * celular, o container fica `fixed` em `top: --chat-top` com `height: --chat-vh`
 * (visualViewport), então o composer encosta no teclado. Sem conversa aberta
 * (lista) fica entre o cabeçalho global e a barra de abas. `md+` não muda.
 * `data-keyboard="open|closed"` + `group/chatframe` permitem aos filhos variar
 * (`group-data-[keyboard=open]/chatframe:...`).
 */
export function useChatFrame(chatOpen: boolean): {
  [CHAT_FRAME_ATTR]: "";
  className: string;
  style: CSSProperties | undefined;
  "data-keyboard": "open" | "closed";
} {
  useChatModeActive(chatOpen);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const tracking = chatOpen && isMobile;
  const vp = useVisualViewport(tracking);
  return {
    [CHAT_FRAME_ATTR]: "",
    "data-keyboard": tracking && vp.keyboardOpen ? "open" : "closed",
    style: tracking ? (chatViewportStyle(vp) as CSSProperties) : undefined,
    className: cn(
      "group/chatframe fixed left-0 right-0 flex flex-col bg-surface-base overscroll-contain",
      "md:top-16 md:left-16 lg:left-56 md:h-[calc(100dvh-4rem)]",
      chatOpen
        ? "top-[var(--chat-top,0px)] h-[var(--chat-vh,100dvh)]"
        : "top-14 h-[calc(100dvh-3.5rem-64px-env(safe-area-inset-bottom,0px))]"
    ),
  };
}
