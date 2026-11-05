import { FileText, Image as ImageIcon, Mic } from "lucide-react";

// Tipos e constantes do simulador do Atendente IA (cópia de settings/ai/SimulatorModal.tsx,
// que segue intocado até o fv2-23 trocá-lo pelo AttendantSimulator).

export type SimKind = "text" | "audio" | "image" | "file";

export type SimTurn = {
  role: "customer" | "agent";
  content: string;
  audio?: boolean;
  image?: boolean;
  file?: boolean;
  /** Quem falou, no modo grupo. */
  senderName?: string;
  actions?: string[];
};

/** Sala fictícia do modo grupo do simulador. */
export const SIM_GROUP = { subject: "Grupo de clientes (teste)", participantsCount: 12 };

export const SIM_KINDS: Array<{
  kind: Exclude<SimKind, "text">;
  Icon: typeof Mic;
  label: string;
  hint: string;
  placeholder: string;
}> = [
  {
    kind: "audio",
    Icon: Mic,
    label: "nota de voz (transcrita)",
    hint: "Enviar como nota de voz — o texto vira a transcrição",
    placeholder: "Transcrição da nota de voz…",
  },
  {
    kind: "image",
    Icon: ImageIcon,
    label: "imagem (lida pela IA)",
    hint: "Enviar como imagem — o texto vira a descrição que a leitura de imagens produziria",
    placeholder: "O que a IA leu na imagem (ex.: comprovante de Pix de R$ 1.247,90 em 26/08)...",
  },
  {
    kind: "file",
    Icon: FileText,
    label: "arquivo (só o nome chega)",
    hint: "Enviar como arquivo — só o NOME chega à IA, que não consegue abrir o conteúdo",
    placeholder: "Nome do arquivo (ex.: comprovante-pix.pdf)...",
  },
];

export type SimTransport = "meta" | "bridge" | "instagram" | "messenger";

export const SIM_TRANSPORT_OPTIONS: Array<{ value: SimTransport; label: string }> = [
  { value: "meta", label: "WhatsApp oficial (Meta)" },
  { value: "bridge", label: "WhatsApp por QR code" },
  { value: "instagram", label: "Instagram" },
  { value: "messenger", label: "Messenger" },
];
