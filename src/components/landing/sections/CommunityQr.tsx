import { QRCodeSVG } from "qrcode.react";

interface CommunityQrProps {
  url: string;
}

/**
 * QR code do grupo em SVG, com as cores dos tokens do tema. Carregado sob
 * demanda e só no computador (`S8Community`), então o celular não baixa o código.
 */
export default function CommunityQr({ url }: CommunityQrProps) {
  return (
    <QRCodeSVG
      value={url}
      size={144}
      marginSize={2}
      level="M"
      fgColor="var(--text-primary)"
      bgColor="var(--surface-raised)"
      role="img"
      aria-label="QR code do grupo do WhatsApp"
      className="size-36 rounded-card"
    />
  );
}
