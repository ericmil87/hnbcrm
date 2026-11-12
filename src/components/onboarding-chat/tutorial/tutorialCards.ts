/**
 * Cartões do tutorial guiado (plano 4.5): 5 cenas curtas de 2 bolhas, mostradas
 * depois do teste do atendente e disponíveis depois pelo menu de ajuda.
 * Só conteúdo (sem Convex): os textos das bolhas são exemplos inventados.
 */
export type TutorialSide = "customer" | "team" | "ai" | "copilot";

export interface TutorialBubble {
  from: TutorialSide;
  label?: string;
  text: string;
}

export interface TutorialCardData {
  id: "traducao" | "audio_imagem" | "pedido_de_ajuda" | "copiloto" | "aviso_celular";
  title: string;
  /** O que acontece, em uma ou duas frases honestas. */
  body: string;
  scene: readonly [TutorialBubble, TutorialBubble];
}

export const TUTORIAL_CARDS: readonly TutorialCardData[] = [
  {
    id: "traducao",
    title: "Clientes de outros idiomas",
    body: "Quando um cliente escreve em outro idioma, você lê em português e responde em português. A mensagem sai no idioma dele.",
    scene: [
      { from: "customer", label: "Cliente", text: "Hola, ¿tienen lugar para el sábado?" },
      { from: "team", label: "Você vê", text: "Olá, vocês têm vaga para sábado?" },
    ],
  },
  {
    id: "audio_imagem",
    title: "Áudio e imagem",
    body: "O atendente entende nota de voz (transcrita) e lê imagens, como um comprovante. Isso depende de a IA estar ativa.",
    scene: [
      { from: "customer", label: "Cliente", text: "Nota de voz: queria saber o preço do plano." },
      { from: "ai", label: "Atendente IA", text: "Entendi o seu áudio: você quer o preço do plano. Posso explicar as opções?" },
    ],
  },
  {
    id: "pedido_de_ajuda",
    title: "Pedido de ajuda à equipe",
    body: "Quando o assunto é delicado ou o cliente pede uma pessoa, o atendente chama a sua equipe. A conversa aparece em Requer atenção, com um resumo.",
    scene: [
      { from: "customer", label: "Cliente", text: "Prefiro falar com uma pessoa, o meu caso é diferente." },
      { from: "ai", label: "Atendente IA", text: "Claro. Vou chamar a nossa equipe e já passo o resumo da conversa." },
    ],
  },
  {
    id: "copiloto",
    title: "Copiloto: pergunte em vez de procurar",
    body: "O Copiloto responde sobre os seus dados e prepara ações. Antes de mudar algo, ele mostra o que vai fazer e espera a sua confirmação.",
    scene: [
      { from: "team", label: "Você", text: "Quais clientes estão sem resposta há 3 dias?" },
      { from: "copilot", label: "Copiloto", text: "Encontrei 4. Quer que eu crie uma tarefa de retorno para cada um?" },
    ],
  },
  {
    id: "aviso_celular",
    title: "Aviso no celular",
    body: "Instale o HNBCRM no celular (adicionar à tela inicial) e ligue os avisos: você fica sabendo quando um cliente escreve ou pede ajuda.",
    scene: [
      { from: "customer", label: "Cliente", text: "Oi, o comprovante chegou aí?" },
      { from: "team", label: "Aviso no celular", text: "Nova mensagem de um cliente no HNBCRM." },
    ],
  },
];
