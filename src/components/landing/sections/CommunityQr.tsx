import { QRCodeSVG } from "qrcode.react";
import { QR_BG, QR_FG } from "../qrColors";

interface CommunityQrProps {
  url: string;
}

/**
 * QR code do grupo em SVG, SEMPRE escuro sobre claro (`qrColors.ts`, iguais aos
 * tokens `qr-fg`/`qr-bg`, nos 4 temas: leitores falham com o código invertido). O quadro claro
 * e a quiet zone de 4 módulos (`marginSize`) ficam dentro do próprio SVG.
 * Carregado sob demanda e só no computador (`S8Community`).
 */
export default function CommunityQr({ url }: CommunityQrProps) {
  return (
    <div className="rounded-card border border-border bg-qr-bg p-2">
      <QRCodeSVG
        value={url}
        size={192}
        marginSize={4}
        level="M"
        fgColor={QR_FG}
        bgColor={QR_BG}
        role="img"
        aria-label="QR code do grupo do WhatsApp"
        className="size-48"
      />
    </div>
  );
}
