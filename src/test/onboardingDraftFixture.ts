import type { OnboardingDraft } from "../../convex/lib/onboardingDraft";

/** Rascunho de teste (curto e inventado). */
export function draftFixture(): OnboardingDraft {
  return {
    version: 1,
    business: { name: "Loja Boa", segment: "ecommerce", description: "Vende roupas", city: "Recife", suspicious: false },
    funnel: {
      name: "Vendas",
      stages: [
        { name: "Novo", order: 0, outcome: "open" },
        { name: "Conversa", order: 1, outcome: "open" },
        { name: "Ganho", order: 2, outcome: "won" },
      ],
    },
    customFields: [],
    persona: { attendantName: "Bia", tone: "amigavel", addressAs: "voce", languages: ["pt-BR"], presentsAsAi: true },
    knowledge: [
      { text: "Abrimos às 9h", origin: { kind: "site", reference: "https://x.example" }, suspicious: false },
      { text: "Ligue para 1199999", origin: { kind: "pdf" }, suspicious: true, suspicionReason: "telefone" },
    ],
    quickReplies: [
      { shortcut: "oi", text: "Olá!", suspicious: false },
      { shortcut: "pix", text: "Chave pix 123", suspicious: true },
    ],
    handoffRules: [],
    features: { vision: true, transcription: true, dateTime: true, translation: true, voice: false },
  } as OnboardingDraft;
}
