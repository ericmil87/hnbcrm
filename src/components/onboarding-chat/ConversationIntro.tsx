import type { ReactNode } from "react";
import { Bubble } from "@/components/landing/kit";

/** Bolha fixa do Copiloto (texto do app, não do modelo). */
export function CopilotNote({ children }: { children: ReactNode }) {
  return (
    <Bubble variant="ai" side="start" label="Copiloto">
      <p className="whitespace-pre-wrap">{children}</p>
    </Bubble>
  );
}

/** Mensagem guardada do hero, mostrada como bolha da pessoa antes de ser enviada. */
export function IntentBubble({ message }: { message: string }) {
  return (
    <Bubble variant="out">
      <p className="whitespace-pre-wrap break-words">{message}</p>
    </Bubble>
  );
}

/** Cartão dentro da conversa (conta, criação da org). */
export function ConversationCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="ml-2 w-full max-w-md rounded-card border border-border-subtle bg-surface-raised p-4 shadow-card"
    >
      {children}
    </section>
  );
}

export interface SignedOutIntroProps {
  /** Mensagem guardada do hero (`readOnboardingIntent`), se houver. */
  intentMessage?: string | null;
  /** Cartão de entrada (o container passa `<EmailEntryCard compact />`). */
  accountCard: ReactNode;
}

/** Etapa 1 sem login: a mensagem do hero, o convite do Copiloto e o cartão de conta na conversa. */
export function SignedOutIntro({ intentMessage, accountCard }: SignedOutIntroProps) {
  return (
    <>
      {intentMessage && <IntentBubble message={intentMessage} />}
      <CopilotNote>
        {intentMessage
          ? "Ótimo, já anotei. Para eu continuar montando e não perder o que você já contou, entre ou crie a sua conta."
          : "Oi! Eu sou o Copiloto do HNBCRM e vou montar o seu CRM com você, conversando. Para eu não perder nada do que você contar, entre ou crie a sua conta."}
      </CopilotNote>
      <ConversationCard title="Entrar ou criar conta">{accountCard}</ConversationCard>
    </>
  );
}
