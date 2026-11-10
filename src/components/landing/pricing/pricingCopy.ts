/**
 * Textos PT-BR da seção de preços. Números do catálogo (planos, canal extra,
 * add-on, pacote, teste) entram por parâmetro: nada de valor digitado aqui,
 * exceto o que não existe no catálogo (reembolso, reativação do bridge).
 */
import { formatCount, formatMoney } from "@/lib/format";
import { LEGAL_ENTITY } from "@/lib/legalEntity";
import { EXTRA_CHANNEL_BRL, GROUPS_ADDON_BRL, PACK, PLANS, TRIAL } from "../../../../convex/lib/plans";

/** Fora do catálogo; vem do documento de decisão (revisar com o jurídico). */
export const BRIDGE_REACTIVATION_BRL = 190;
export const REFUND_DAYS = 7;
/** Dias de atraso a partir dos quais a conta pode ir para só leitura (decisão manual). */
export const LATE_DAYS = 7;

export const PLAN_AUDIENCE: Record<keyof typeof PLANS, string> = {
  essencial: "Corretor, terapeuta, consultório e autônomo",
  profissional: "Clínica, equipe comercial, startup, escola e espaço de eventos",
  escala: "Imobiliária com um número por corretor e rede de 2 a 3 clínicas",
  empresa: "Redes multiunidade, hotéis, venues e sociedades anônimas",
};

export const PLAN_SUPPORT: Record<keyof typeof PLANS, string> = {
  essencial: "Suporte por e-mail",
  profissional: "Suporte por e-mail e WhatsApp",
  escala: "Suporte prioritário",
  empresa: "Gerente de conta, contrato, SLA e nota fiscal",
};

export const NOT_CHARGED: readonly string[] = [
  "Usuários e assentos: a equipe inteira, em qualquer plano",
  "Conversas só da equipe: não contam como atendimento IA",
  "Grupos e campanhas: não contam como atendimento IA",
  "Conversar com o Copiloto não conta. Um rascunho pedido por você ou pelo Copiloto para um contato conta como atendimento dentro da franquia, nunca como excedente",
  "Mensagens, contatos, funis e leads sem limite",
  "Exportação dos seus dados: sempre liberada",
];

export const THIRD_PARTY_POINTS: readonly string[] = [
  "Se você usar a API oficial da Meta, a Meta cobra direto de você, sem margem nossa.",
  "Se usar a sua chave de IA própria, o provedor cobra direto de você, e o excedente do plano fica mais barato.",
  "O canal por QR code está incluído no plano.",
];

export const DEFINITIONS: readonly { term: string; text: string }[] = [
  { term: "Canal", text: "Um número de WhatsApp, uma conta de Instagram ou de Messenger conectada." },
  {
    term: "Atendimento IA",
    text: "Um contato que a IA atendeu no mês. O mesmo contato falando vinte vezes conta um.",
  },
  { term: "Envio de campanha", text: "Uma mensagem de campanha enviada a um contato." },
  { term: "Unidade", text: "Uma filial, casa ou hotel da rede, no plano Empresa." },
];

export function addonLines(): { title: string; price: string; detail: string }[] {
  return [
    {
      title: "Canal extra",
      price: `${formatMoney(EXTRA_CHANNEL_BRL, "BRL", { fractionDigits: 0 })}/mês`,
      detail: "Para passar da quantidade de canais do plano.",
    },
    {
      title: "Add-on Grupos (só Essencial)",
      price: `${formatMoney(GROUPS_ADDON_BRL, "BRL", { fractionDigits: 0 })}/mês`,
      detail: `Até ${PLANS.essencial.groupsAddonMax} grupos com IA e publicações agendadas. Do Profissional em diante já vem incluso.`,
    },
    {
      title: `Pacote de ${formatCount(PACK.attendances)} atendimentos`,
      price: formatMoney(PACK.brl, "BRL", { fractionDigits: 0 }),
      detail: `Vale por ${PACK.months} meses. Para contratar, fale com a gente.`,
    },
    {
      title: "Reativação do número por QR code",
      price: formatMoney(BRIDGE_REACTIVATION_BRL, "BRL", { fractionDigits: 0 }),
      detail: "Depois de um banimento. A primeira do ano é grátis.",
    },
  ];
}

export function faqItems(): { question: string; answer: string }[] {
  return [
    {
      question: "O que é um atendimento IA?",
      answer:
        "Um contato que a IA atendeu no mês (respondeu ou rascunhou). Se ela falar dez vezes com a mesma pessoa no mês, conta um. Conversa só da equipe, grupos e campanhas não contam. Conversar com o Copiloto não conta. Um rascunho que você ou o Copiloto pedem à IA para um contato conta como atendimento dentro da franquia, nunca como excedente.",
    },
    { question: "Quantos usuários posso ter?", answer: "Quantos quiser, em qualquer plano pago." },
    {
      question: "O que acontece quando a franquia acaba?",
      answer:
        "A IA passa a sugerir respostas e a sua equipe envia. Não cobramos nada a mais. Se quiser que ela continue sozinha, você liga o excedente e escolhe um teto em reais.",
    },
    {
      question: "Posso ser cobrado sem querer?",
      answer:
        "Não. O excedente vem desligado. Você recebe aviso em 80% e 100% e vê o uso do mês em tempo real.",
    },
    {
      question: "Como funciona o teste?",
      answer: `${TRIAL.days} dias do plano ${PLANS[TRIAL.plan].label}, sem cartão, com ${formatCount(TRIAL.aiAttendances)} atendimentos IA. No fim, a conta fica em só leitura e você exporta o que quiser; nada é apagado.`,
    },
    {
      question: "E se eu não pagar?",
      answer: `Avisamos por e-mail. Se o atraso passar de ${LATE_DAYS} dias, a conta pode ficar em só leitura: a equipe continua vendo tudo e exportando os dados, e as mensagens que chegam continuam sendo gravadas. Nunca apagamos dados por atraso.`,
    },
    {
      question: "Posso cancelar?",
      answer: `Quando quiser, por e-mail para ${LEGAL_ENTITY.email}, sem multa. Vale até o fim do período já pago. Nos ${REFUND_DAYS} primeiros dias depois do primeiro pagamento, devolvemos o valor.`,
    },
    {
      question: "O preço aumenta?",
      answer:
        "O preço fica travado por 12 meses. Depois, o reajuste é anual, pela variação do IPCA, com aviso de 30 dias e direito de cancelar sem multa.",
    },
    {
      question: "Quanto custa o WhatsApp?",
      answer:
        "O canal por QR code está incluído no plano. Se você usar a API oficial da Meta, a Meta cobra direto de você, sem margem nossa. O mesmo vale para a sua chave de IA própria.",
    },
    {
      question: "O número pode ser banido?",
      answer: `O QR code usa uma conexão não oficial e há risco de banimento do número. Explicamos o risco antes de ligar e recomendamos a API oficial para operações críticas. Oferecemos reativação (${formatMoney(BRIDGE_REACTIVATION_BRL, "BRL", { fractionDigits: 0 })}, a primeira do ano é grátis).`,
    },
    { question: "Emitem nota fiscal?", answer: "Sim, emitimos nota fiscal a cada pagamento." },
  ];
}

export const CTA_LABEL = `Testar ${TRIAL.days} dias grátis`;
export const CTA_NOTE = "Sem cartão de crédito.";
