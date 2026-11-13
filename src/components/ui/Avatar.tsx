import { useState } from "react";
import { cn } from "@/lib/utils";
import { Bot } from "lucide-react";

const sizes = {
  xs: "h-6 w-6 text-micro",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-lg",
} as const;

interface AvatarProps {
  name: string;
  type?: "human" | "ai";
  size?: keyof typeof sizes;
  status?: "active" | "busy" | "inactive";
  imageUrl?: string | null;
  className?: string;
}

export function Avatar({ name, type = "human", size = "md", status, imageUrl, className }: AvatarProps) {
  // Imagem que não carrega (arquivo apagado, rede) volta às iniciais; a falha é
  // lembrada POR URL, então uma foto nova é tentada de novo.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(imageUrl) && failedUrl !== imageUrl;
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className={cn("relative inline-flex shrink-0", className)}>
      <div
        className={cn(
          "rounded-full flex items-center justify-center font-semibold text-white bg-brand-600 overflow-hidden",
          sizes[size]
        )}
        aria-label={`${name} (${type === "ai" ? "IA" : "Humano"})`}
      >
        {showImage ? (
          <img
            src={imageUrl ?? undefined}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailedUrl(imageUrl ?? null)}
            className="w-full h-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* AI badge */}
      {type === "ai" && (
        <div className="absolute -bottom-0.5 -right-0.5 bg-surface-overlay border border-border rounded-full p-0.5">
          <Bot size={size === "xs" ? 8 : size === "sm" ? 10 : 12} className="text-brand-400" />
        </div>
      )}

      {/* Status indicator */}
      {status && (
        <div
          className={cn(
            "absolute -top-0.5 -right-0.5 rounded-full border-2 border-surface-raised",
            size === "xs" || size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3",
            status === "active" && "bg-semantic-success",
            status === "busy" && "bg-semantic-warning",
            status === "inactive" && "bg-text-muted"
          )}
          aria-label={status === "active" ? "Ativo" : status === "busy" ? "Ocupado" : "Inativo"}
        />
      )}
    </div>
  );
}
