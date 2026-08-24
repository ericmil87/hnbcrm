import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Camera, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

interface AvatarUploadProps {
  /** Current photo URL (resolved from storage) */
  currentPhotoUrl?: string | null;
  /** Fallback initials when no photo */
  initials: string;
  /** Organization for auth context */
  organizationId: Id<"organizations">;
  /** File type for storage metadata */
  fileType: "contact_photo" | "member_avatar";
  /** Optional entity relation */
  contactId?: Id<"contacts">;
  teamMemberId?: Id<"teamMembers">;
  /** Called with the new file ID after successful upload */
  onPhotoChange: (fileId: Id<"files"> | undefined) => void;
  /** Whether uploads are allowed */
  disabled?: boolean;
  /** Size variant */
  size?: "md" | "lg";
}

export function AvatarUpload({
  currentPhotoUrl,
  initials,
  organizationId,
  fileType,
  contactId,
  teamMemberId,
  onPhotoChange,
  disabled = false,
  size = "lg",
}: AvatarUploadProps) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);

  const sizeClasses = size === "lg" ? "w-20 h-20 text-2xl" : "w-14 h-14 text-lg";
  const iconSize = size === "lg" ? 20 : 16;

  const handleClick = () => {
    if (disabled || uploading) return;
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so the same file can be selected again
    e.target.value = "";

    // Validate type
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      toast.error("Formato inválido. Use JPEG, PNG, WebP ou GIF.");
      return;
    }

    // Validate size
    if (file.size > MAX_FILE_SIZE) {
      toast.error("Imagem muito grande. Máximo 5MB.");
      return;
    }

    setUploading(true);
    try {
      // 1. Get upload URL
      const uploadUrl = await generateUploadUrl({ organizationId });

      // 2. Upload to Convex storage
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!response.ok) {
        throw new Error("Falha no upload");
      }

      const { storageId } = await response.json();

      // 3. Save file metadata
      const fileId = await saveFile({
        organizationId,
        storageId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        fileType,
        contactId,
        teamMemberId,
      });

      // 4. Notify parent
      onPhotoChange(fileId);
      toast.success("Foto atualizada!");
    } catch (error: any) {
      toast.error(error.message || "Falha ao enviar foto.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || uploading}
        className={cn(
          "relative rounded-full overflow-hidden flex items-center justify-center font-semibold text-white bg-brand-600 transition-opacity focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
          sizeClasses,
          !disabled && !uploading && "cursor-pointer group",
          disabled && "opacity-60 cursor-not-allowed"
        )}
        aria-label="Alterar foto"
      >
        {currentPhotoUrl ? (
          <img
            src={currentPhotoUrl}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <span>{initials}</span>
        )}

        {/* Overlay on hover */}
        {!disabled && !uploading && (
          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <Camera size={iconSize} className="text-white" />
          </div>
        )}

        {/* Uploading spinner */}
        {uploading && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <Loader2 size={iconSize} className="text-white animate-spin" />
          </div>
        )}
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        onChange={handleFileSelect}
        className="hidden"
      />
    </div>
  );
}
