/**
 * Textos do hero (S1), literais da copy aprovada (`copy/landing.md`, versão final).
 * Dias de teste e reembolso vêm do catálogo via `trustLine()`, nunca digitados.
 */
import type { Chip } from "../kit";
import type { OnboardingNiche } from "@/lib/onboardingEntry";

export const HERO_EYEBROW = "Humanos e IAs no mesmo time";
export const HERO_TITLE = "Conte como é o seu negócio. Em minutos, sua IA já atende no WhatsApp.";
export const HERO_SUBTITLE = "Converse com o Copiloto, veja a sua operação nascer e teste a sua IA antes de conectar um número.";

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
export const HERO_HINT = "O que você escrever aqui fica só no seu navegador até você criar a conta.";
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
