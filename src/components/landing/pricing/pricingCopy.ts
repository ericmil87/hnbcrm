/**
 * Textos PT-BR da página de preços (copy aprovada em copy/precos.md). Números
 * do catálogo (planos, canal extra, add-on, pacote, teste, serviços) entram do
 * catálogo: nada de valor digitado aqui, exceto o que não existe lá (reembolso,
 * reativação do bridge, atraso). Trechos entre `**` saem em negrito na UI.
 */
import { formatCount, formatMoney } from "@/lib/format";
import { followUpDisplay } from "@/lib/pricingCatalog";
import type { PlanDisplay } from "@/lib/pricingCatalog";
import {
  EXTRA_CHANNEL_BRL,
  GROUPS_ADDON_BRL,
  PACK,
  PLANS,
  SERVICES,
  TRIAL,
  USAGE_WARN_PCT,
  type PlanKey,
} from "../../../../convex/lib/plans";

/** Fora do catálogo; vem do documento de decisão (revisar com o jurídico). */
export const BRIDGE_REACTIVATION_BRL = 190;
export const REFUND_DAYS = 7;
/** Dias de atraso a partir dos quais a conta pode ir para só leitura (decisão manual). */
export const LATE_DAYS = 7;

const brl0 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 0 });

export const PLAN_AUDIENCE: Record<PlanKey, string> = {
  essencial: "Para quem atende sozinho ou com equipe pequena: corretor, terapeuta, consultório.",
  profissional: "Para clínicas, equipes comerciais, escolas e espaços de eventos.",
  escala: "Para quem tem volume e vários números, como imobiliária com um número por corretor.",
  empresa: "Para redes com várias unidades: clínicas, hotéis, casas de eventos.",
};

export const PLAN_SUPPORT: Record<PlanKey, string> = {
  essencial: "E-mail",
  profissional: "E-mail e WhatsApp",
  escala: "Prioritário",
  empresa: "Gerente de conta, contrato e SLA",
};

/** As três linhas de cada cartão (o detalhe fica em "Compare os planos"). */
export function planCardLines(plan: PlanDisplay): string[] {
  const attendances = `${formatCount(plan.attendances)} pessoas atendidas pela IA por mês`;
  switch (plan.key) {
    case "essencial":
      return [attendances, `${plan.channels} canal (número de WhatsApp)`, "Usuários ilimitados"];
    case "profissional":
      return [attendances, `${plan.channels} canais`, "Grupos, setores, tradução e API"];
    case "escala":
      return [attendances, `${plan.channels} canais`, "Suporte prioritário"];
    case "empresa":
      return ["Central e painel por unidade", "Contrato, SLA e nota fiscal", "Gerente de conta"];
  }
}

export const ALL_PLANS_BAND =
  "Em todos os planos: Atendente de IA, Copiloto, leitura de áudio e de imagem, follow-up que a IA executa, pedido de ajuda à equipe e avisos no celular.";

export const COMPARE_NOTE =
  "Grupos funcionam só na conexão por QR code. Instagram e Messenger contam como canal e estão em liberação gradual, conforme a aprovação da Meta.";

export const NOT_CHARGED: readonly string[] = [
  "**Usuários:** a equipe inteira, em qualquer plano.",
  "**Conversas só da equipe:** não contam.",
  "**Grupos e campanhas:** não contam como pessoa atendida pela IA. Campanha tem a própria franquia de envios.",
  "**Conversar com o Copiloto:** não conta. Se você ou o Copiloto pedirem um rascunho à IA para um cliente, ele conta dentro da franquia e nunca vira excedente.",
  "**Mensagens, contatos, funis e leads:** sem limite.",
  "**Exportar os seus dados:** sempre liberado, até com a conta só para leitura.",
];

export const WHAT_IS_ATTENDED_INTRO =
  "É cada pessoa com quem a IA conversou no mês, respondendo ou escrevendo um rascunho para a sua equipe aprovar.";

export const WHAT_IS_ATTENDED: readonly string[] = [
  "**O mesmo cliente falando 20 vezes no mês conta 1.**",
  "A mesma pessoa, no mesmo contato, pelo WhatsApp e pelo Instagram conta 1.",
  "Resposta que falhou não conta.",
  "A contagem recomeça todo mês, do dia 1 ao último dia.",
  "Você acompanha o número em tempo real no painel Uso e fatura e pode contestar um valor em até 30 dias.",
];

export const QUOTA_END_TEXT =
  "A IA passa a só sugerir, e a sua equipe envia. Nada é cobrado a mais. Se quiser que ela continue respondendo sozinha, ligue o excedente e escolha um teto em reais. Ao chegar no teto, ela volta a só sugerir.";

export const THIRD_PARTY_POINTS: readonly string[] = [
  "O canal por QR code está incluído no plano.",
  "Se você usar a API oficial da Meta, a Meta cobra as mensagens direto de você.",
  "Se usar a sua própria chave de IA, o provedor cobra direto de você, e o excedente do plano fica mais barato.",
];

export const DEFINITIONS: readonly { term: string; text: string }[] = [
  { term: "Canal", text: "Um número de WhatsApp, ou uma conta de Instagram ou de Messenger conectada." },
  { term: "Envio de campanha", text: "Uma mensagem de campanha enviada a um contato." },
  { term: "Unidade", text: "Uma filial, casa ou hotel da rede, no plano Empresa." },
];

/** "Essencial: até 2 extras. Profissional: até 3. Escala e Empresa: sem teto." (do catálogo). */
export function extraChannelsLimitText(): string {
  return `${PLANS.essencial.label}: até ${PLANS.essencial.maxExtraChannels} extras. ${PLANS.profissional.label}: até ${PLANS.profissional.maxExtraChannels}. ${PLANS.escala.label} e ${PLANS.empresa.label}: sem teto.`;
}

export function addonLines(): { title: string; price: string; detail: string }[] {
  return [
    {
      title: "Canal extra",
      price: `${brl0(EXTRA_CHANNEL_BRL)}/mês cada`,
      detail: `Mais um número de WhatsApp, ou uma conta de Instagram ou Messenger. ${extraChannelsLimitText()}`,
    },
    {
      title: "Add-on Grupos (só Essencial)",
      price: `${brl0(GROUPS_ADDON_BRL)}/mês`,
      detail: `Até ${PLANS.essencial.groupsAddonMax} grupos com IA e publicações programadas. Do Profissional em diante já vem incluído.`,
    },
    {
      title: `Pacote de ${formatCount(PACK.attendances)} pessoas atendidas`,
      price: brl0(PACK.brl),
      detail: `Vale por ${PACK.months} meses, para quem tem meses de pico. Para contratar, fale com a gente.`,
    },
    {
      title: "Reativação do número por QR code",
      price: brl0(BRIDGE_REACTIVATION_BRL),
      detail: "Depois de um banimento. A primeira do ano é grátis.",
    },
  ];
}

export function faqItems(): { question: string; answer: string }[] {
  return [
    {
      question: "O que é uma pessoa atendida pela IA?",
      answer:
        "É cada pessoa com quem a IA conversou no mês, respondendo ou escrevendo um rascunho. O mesmo cliente falando 20 vezes conta 1. Conversas só da equipe, grupos, campanhas e o Copiloto não contam.",
    },
    { question: "Quantos usuários posso ter?", answer: "Quantos quiser, em qualquer plano pago." },
    {
      question: "O que acontece quando a franquia acaba?",
      answer:
        "A IA passa a só sugerir respostas, e a sua equipe envia. Não cobramos nada a mais. Se quiser que ela continue sozinha, você liga o excedente e escolhe um teto em reais.",
    },
    {
      question: "Posso ser cobrado sem querer?",
      answer: `Não. O excedente vem desligado. Você recebe aviso em ${USAGE_WARN_PCT}% e 100% da franquia e vê o uso do mês em tempo real.`,
    },
    {
      question: "Como funciona o teste?",
      answer: `São ${TRIAL.days} dias do plano ${PLANS[TRIAL.plan].label}, sem cartão, com ${formatCount(TRIAL.aiAttendances)} pessoas atendidas pela IA. No fim, a conta fica só para leitura e você exporta o que quiser. Nada é apagado. É um teste por pessoa.`,
    },
    {
      question: "Como eu pago?",
      answer: "Por cobrança enviada por e-mail, com Pix, boleto ou cartão. Emitimos nota fiscal a cada pagamento.",
    },
    {
      question: "Posso trocar de plano?",
      answer:
        "Sim, pelo painel Uso e fatura. Para subir de plano, você paga hoje o valor cheio do plano novo e um ciclo novo começa hoje. Os dias que sobraram do plano anterior não viram crédito. Para descer, a troca vale na próxima renovação.",
    },
    {
      question: "Tem fidelidade? Posso cancelar?",
      answer: `Não tem fidelidade. Cancele quando quiser pelo painel Uso e fatura, sem multa. O acesso vale até o fim do período já pago. Nos ${REFUND_DAYS} primeiros dias depois do primeiro pagamento, você pede o reembolso integral.`,
    },
    {
      question: "E se eu atrasar o pagamento?",
      answer: `Avisamos por e-mail. Se o atraso passar de ${LATE_DAYS} dias, a conta pode ficar só para leitura: a equipe continua vendo tudo e exportando, e as mensagens que chegam continuam sendo gravadas. Nunca apagamos dados por atraso.`,
    },
    {
      question: "O preço aumenta?",
      answer:
        "O preço fica travado por 12 meses. Depois, o reajuste é anual, pela variação do IPCA, com aviso de 30 dias e direito de cancelar sem multa.",
    },
    {
      question: "Quanto custa o WhatsApp?",
      answer:
        "O canal por QR code está incluído no plano. Se você usar a API oficial da Meta, a Meta cobra as mensagens direto de você, sem margem nossa. O mesmo vale para a sua própria chave de IA.",
    },
    {
      question: "O número pode ser banido?",
      answer: `Pode. O QR code usa uma conexão não oficial do WhatsApp, e existe risco de banimento do número. Explicamos o risco antes de ligar e recomendamos a API oficial da Meta quando o atendimento não pode parar. Se acontecer, oferecemos a reativação por ${brl0(BRIDGE_REACTIVATION_BRL)}, e a primeira do ano é grátis.`,
    },
    {
      question: "Preciso ter chave de IA própria?",
      answer:
        "Não. A IA já vem incluída no plano. A chave própria é opcional, do Profissional em diante, e deixa o excedente mais barato.",
    },
    {
      question: "Vocês fazem a implantação?",
      answer: `Se você quiser, sim. É um serviço à parte, a partir de ${brl0(SERVICES.implantacao.express.brl)}, parcelável. Também dá para montar tudo sozinho: o plano já inclui o que você precisa.`,
    },
    { question: "Emitem nota fiscal?", answer: "Sim, a cada pagamento." },
  ];
}

/** Escopo dos pacotes de implantação (preços vêm do catálogo, em `serviceDisplays`). */
export const SERVICE_COPY: Record<"express" | "completa" | "empresa", { audience: string; includes: string[] }> = {
  express: {
    audience: "Quem atende sozinho ou com equipe pequena",
    includes: [
      "Funil, Atendente e respostas frequentes montados com você",
      "Um treinamento da equipe",
      "Uma semana de ajustes",
    ],
  },
  completa: {
    audience: "Clínicas e equipes",
    includes: [
      "Tudo do Express",
      "Mais de um fluxo",
      "Formulário do site, campanhas e uma integração simples",
      "Duas semanas em modo sugestão, revisando com você",
    ],
  },
  empresa: {
    audience: "Redes com várias unidades",
    includes: [
      "Diagnóstico e duas semanas de medição",
      "Fluxos por unidade, departamentos e acessos",
      "Treinamento por equipe",
    ],
  },
};

export const CUSTOM_SERVICE_COPY = {
  audience: "Quando o caso não cabe num pacote",
  includes: [
    "Diagnóstico do atendimento",
    "Funil e regras de pedido de ajuda",
    "Jeito de falar e conhecimento da IA",
    "Integrações (site, formulários, API)",
    "Treinamento",
    "30 dias de acompanhamento",
  ],
};

export function servicesSubtitle(): string {
  return `O plano já inclui tudo para você montar sozinho. Se preferir alguém do lado, a implantação é cobrada à parte, uma vez, e pode ser parcelada em até ${SERVICES.installments} vezes.`;
}

export function followUpText(): string {
  const f = followUpDisplay();
  return `${brl0(f.monthlyBrl)}/mês, com ${f.hours} horas de ajustes e orientação depois da implantação.`;
}

export const SERVICES_FOOTER = `Fazemos poucas implantações por mês. Se a agenda estiver cheia, a gente avisa o prazo antes de você contratar. A garantia de reembolso de ${REFUND_DAYS} dias vale para o plano; o trabalho de implantação já feito não é reembolsado.`;

export const CTA_LABEL = `Testar ${TRIAL.days} dias grátis`;
export const CTA_NOTE = "Sem cartão de crédito.";

export const SEO_TITLE = (fromPrice: string) => `Preços do HNBCRM: a partir de ${fromPrice}/mês, equipe ilimitada`;
export const SEO_DESCRIPTION = `Você paga pelas pessoas que a IA atende, não por usuário. ${TRIAL.days} dias grátis sem cartão. Excedente só se você ligar, com teto.`;
