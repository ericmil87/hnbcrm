import { createContext, useContext, useEffect, type ReactNode } from "react";

/**
 * Modo conversa no celular: com uma conversa aberta, o AppShell esconde o
 * cabeçalho global, a barra de abas e o FAB do Copiloto (tela cheia como o
 * WhatsApp). O Inbox liga o modo; o cabeçalho da conversa oferece o Copiloto no ⋮.
 */
export interface ChatModeValue {
  /** Conversa aberta em tela cheia (só tem efeito abaixo de `md`). */
  active: boolean;
  setActive: (active: boolean) => void;
  /** Abre o Copiloto (ausente quando a org não tem o Copiloto ligado). */
  openCopilot?: () => void;
}

const ChatModeContext = createContext<ChatModeValue | null>(null);

export function ChatModeProvider({ value, children }: { value: ChatModeValue; children: ReactNode }) {
  return <ChatModeContext.Provider value={value}>{children}</ChatModeContext.Provider>;
}

/** Fora do AppShell (testes, painel do lead) devolve um modo inerte. */
export function useChatMode(): ChatModeValue {
  return useContext(ChatModeContext) ?? { active: false, setActive: () => {} };
}

/** Liga o modo conversa enquanto `on` for verdadeiro; desliga ao desmontar. */
export function useChatModeActive(on: boolean) {
  const { setActive } = useChatMode();
  useEffect(() => {
    setActive(on);
    return () => setActive(false);
  }, [on, setActive]);
}
