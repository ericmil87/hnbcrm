import { useState } from "react";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  md: { box: "h-10 w-10", icon: 20 },
  lg: { box: "h-12 w-12", icon: 22 },
} as const;

interface GroupAvatarProps {
  /** Foto do grupo (URL do storage); ausente ou que falhou = ícone de grupo. */
  imageUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}

/**
 * Avatar de uma conversa de grupo: a foto do grupo, ou o ícone `Users` quando
 * não há foto ou a imagem não carrega. A falha é lembrada POR URL (uma foto
 * nova é tentada de novo), como no `Avatar`. Decorativo: o nome do grupo
 * já está ao lado.
 */
export function GroupAvatar({ imageUrl, size = "lg", className }: GroupAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(imageUrl) && failedUrl !== imageUrl;
  const dims = SIZES[size];
  return (
    <span
      data-testid="group-avatar"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-sunken text-text-secondary",
        dims.box,
        className
      )}
    >
      {showImage ? (
        <img
          src={imageUrl ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(imageUrl ?? null)}
          className="h-full w-full object-cover"
        />
      ) : (
        <Users size={dims.icon} aria-hidden="true" />
      )}
    </span>
  );
}
