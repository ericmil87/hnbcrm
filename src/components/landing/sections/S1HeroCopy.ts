/**
 * Textos do hero (S1). Título e subtítulo reescritos em 12/11/2026 (benefício primeiro, depois o como);
 * o restante segue a copy aprovada (`copy/landing.md`).
 * Dias de teste e reembolso vêm do catálogo via `trustLine()`, nunca digitados.
 */
import type { Chip } from "../kit";
import type { OnboardingNiche } from "@/lib/onboardingEntry";
import { AI_PROCESSING_NOTICE } from "@/lib/onboardingChat";

export const HERO_EYEBROW = "Humanos e IAs no mesmo time";
export const HERO_TITLE = "Seu WhatsApp atende na hora. Até quando você não pode.";
export const HERO_SUBTITLE =
  "Conte como é o seu negócio, do jeito que contaria a um amigo. Em minutos nasce uma IA que atende como você atenderia e chama a equipe quando a conversa pede gente. Você testa tudo antes de conectar o seu número.";

export const HERO_PLACEHOLDERS = [
  "Tenho uma clínica de estética em Recife…",
  "instagram.com/minhaloja",
  "Sou corretor e perco lead fora do horário…",
  "Vou mandar o flyer do meu evento",
] as const;

export const HERO_STATIC_PLACEHOLDER = "Conte sobre o seu negócio";
export const HERO_FIELD_LABEL = "Mensagem para o Copiloto";
export const HERO_ATTACH_LABEL = "Anexar arquivo (site, PDF ou imagem)";
export const HERO_MIC_LABEL = "Gravar áudio";
export const HERO_SEND_LABEL = "Enviar";
export const HERO_HINT = `O que você escrever aqui fica só no seu navegador até você criar a conta. ${AI_PROCESSING_NOTICE}`;
export const HERO_UPLOAD_NOTICE = "Envio de arquivo e de áudio acontece depois de criar a conta.";

export const HERO_CHIPS_LABEL = "Escolha o seu tipo de negócio";
export const HERO_CHIPS: readonly (Chip & { id: OnboardingNiche })[] = [
  { id: "clinica", label: "Clínica" },
  { id: "terapeuta", label: "Terapeuta" },
  { id: "corretor", label: "Corretor" },
  { id: "loja", label: "Loja" },
  { id: "eventos", label: "Eventos" },
  { id: "outro", label: "Outro" },
];

/** Mensagem que cada chip leva ao onboarding. "Outro" só foca o campo. */
export const HERO_CHIP_MESSAGES: Record<OnboardingNiche, string> = {
  clinica: "Tenho uma clínica e quero atender os pacientes no WhatsApp",
  terapeuta: "Sou terapeuta e atendo online e presencial",
  corretor: "Sou corretor e perco lead fora do horário",
  loja: "Tenho uma loja e vendo pelo WhatsApp e pelo Instagram",
  eventos: "Organizo eventos e quero atender o público",
  outro: "",
};

export const HERO_SECONDARY_CTA = "Ver como funciona";
export const HERO_PAUSE_LABEL = "Pausar animação";
export const HERO_RESUME_LABEL = "Retomar animação";

export type HeroChatVariant = "hero" | "final";

/**
 * Rótulos acessíveis por instância: o hero e o CTA final ficam na mesma página, então
 * cada controle precisa de um nome distinto (leitor de tela, `getByRole`).
 */
export const HERO_CHAT_LABELS: Record<
  HeroChatVariant,
  { region: string; field: string; send: string; attach: string; mic: string; chips: string; pause: string; resume: string }
> = {
  hero: {
    region: "Conversa com Copiloto HNBCRM",
    field: HERO_FIELD_LABEL,
    send: HERO_SEND_LABEL,
    attach: HERO_ATTACH_LABEL,
    mic: HERO_MIC_LABEL,
    chips: HERO_CHIPS_LABEL,
    pause: HERO_PAUSE_LABEL,
    resume: HERO_RESUME_LABEL,
  },
  final: {
    region: "Conversa com Copiloto HNBCRM, para começar agora",
    field: "Mensagem para o Copiloto, para começar agora",
    send: "Enviar e começar",
    attach: "Anexar arquivo e começar (site, PDF ou imagem)",
    mic: "Gravar áudio e começar",
    chips: "Escolha o seu tipo de negócio para começar",
    pause: "Pausar animação do final da página",
    resume: "Retomar animação do final da página",
  },
};

export const HERO_CHAT_TITLE = "Copiloto HNBCRM";
export const HERO_CHAT_STATUS = "online agora";
export const HERO_BUBBLES = [
  "Oi! Me conta: o que você vende e como atende hoje?",
  "Pode escrever, mandar um áudio, o link do site ou o flyer.",
] as const;
