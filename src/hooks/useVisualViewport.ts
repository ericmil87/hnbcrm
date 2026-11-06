import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useChatModeActive } from "@/components/layout/chatMode";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { lockDocumentScroll } from "@/lib/scrollLock";
import {
  chatViewportStyle,
  computeChatViewport,
  nextBaseline,
  sameChatViewport,
  type ChatViewport,
  type ViewportBaseline,
  type ViewportSample,
} from "@/lib/chatViewport";

function sample(): ViewportSample {
  if (typeof window === "undefined") return { width: 0, innerHeight: 0 };
  const vv = window.visualViewport;
  return {
    width: window.innerWidth,
    innerHeight: window.innerHeight,
    vvHeight: vv?.height ?? null,
    vvOffsetTop: vv?.offsetTop ?? null,
  };
}

/**
 * Área visível da tela (`visualViewport`): topo, altura e teclado aberto.
 * Assina resize/scroll da visualViewport e resize/orientationchange da janela,
 * com uma leitura por quadro (rAF). Sem `visualViewport` (jsdom, navegador
 * antigo) cai para `innerHeight`. `enabled=false` não assina nada.
 */
export function useVisualViewport(enabled = true): ChatViewport {
  const baseline = useRef<ViewportBaseline | null>(null);
  const [vp, setVp] = useState<ChatViewport>(() => {
    const s = sample();
    baseline.current = nextBaseline(null, s);
    return computeChatViewport(s, baseline.current);
  });

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let frame: number | null = null;
    const read = () => {
      frame = null;
      const s = sample();
      baseline.current = nextBaseline(baseline.current, s);
      const next = computeChatViewport(s, baseline.current);
      setVp((prev) => (sameChatViewport(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(read) : null;
      if (frame === null) read();
    };
    read();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    };
  }, [enabled]);

  return vp;
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
  className: string;
  style: CSSProperties | undefined;
  "data-keyboard": "open" | "closed";
} {
  useChatModeActive(chatOpen);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const tracking = chatOpen && isMobile;
  const vp = useVisualViewport(tracking);
  return {
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
