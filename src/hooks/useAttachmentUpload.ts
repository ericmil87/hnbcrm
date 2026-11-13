import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { acceptedUploadMimes, validateUpload } from "@/lib/channelCapabilities";
import { ACCEPTED_ATTACHMENT_TYPES, MAX_ATTACHMENTS } from "@/lib/composerFiles";
import { measureImageFile } from "@/lib/imageMeasure";

export interface UploadedFile {
  fileId: Id<"files">;
  name: string;
  mimeType: string;
  size: number;
}

interface UseAttachmentUploadArgs {
  organizationId: Id<"organizations">;
  /** Anexos já na bandeja (conta para o limite por mensagem). */
  uploadedFiles: readonly UploadedFile[];
  onFilesUploaded: (files: UploadedFile[]) => void;
  /** Canal/transporte da conversa: tipo e tamanho são validados antes de subir. */
  channel?: string | null;
  transport?: string | null;
}

/**
 * Único caminho de upload de anexo: botão de clipe, colar e arrastar chamam
 * `uploadFiles`, com a mesma validação, o mesmo limite e as mesmas mensagens.
 */
export function useAttachmentUpload({
  organizationId,
  uploadedFiles,
  onFilesUploaded,
  channel,
  transport,
}: UseAttachmentUploadArgs) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const busy = useRef(false);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);

  /**
   * `strictType` (colar/soltar): o seletor do botão já filtra pelo `accept`,
   * mas colar/soltar não; aí o tipo é conferido contra a mesma lista.
   * Devolve `true` quando subiu.
   */
  const uploadFiles = async (files: File[], opts: { strictType?: boolean } = {}): Promise<boolean> => {
    if (files.length === 0 || busy.current) return false;

    for (const f of files) {
      const problem = validateUpload(channel, transport, f);
      if (problem) {
        toast.error(problem);
        return false;
      }
      if (opts.strictType && !acceptedUploadMimes(channel, transport)) {
        const base = f.type.split(";")[0].trim().toLowerCase();
        if (!(ACCEPTED_ATTACHMENT_TYPES as readonly string[]).includes(base)) {
          toast.error(`${f.name}: formato não aceito.`);
          return false;
        }
      }
    }

    if (uploadedFiles.length + files.length > MAX_ATTACHMENTS) {
      toast.error(`Máximo de ${MAX_ATTACHMENTS} arquivos por mensagem`);
      return false;
    }

    busy.current = true;
    setUploading(true);
    setProgress(0);
    const newFiles: UploadedFile[] = [];
    let completed = 0;
    try {
      for (const file of files) {
        // Imagem: mede aqui (o servidor não lê o blob) para a bolha já nascer
        // do tamanho final. Em paralelo ao upload; falha = sobe sem dimensões.
        const measuring = measureImageFile(file);
        const uploadUrl = await generateUploadUrl({ organizationId });
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!response.ok) {
          throw new Error(`Não foi possível enviar ${file.name}.`);
        }
        const { storageId } = await response.json();
        const dimensions = await measuring;
        const fileId = await saveFile({
          organizationId,
          storageId,
          name: file.name,
          mimeType: file.type,
          size: file.size,
          fileType: "message_attachment",
          ...(dimensions ?? {}),
        });
        newFiles.push({ fileId, name: file.name, mimeType: file.type, size: file.size });
        completed++;
        setProgress(Math.round((completed / files.length) * 100));
      }
      onFilesUploaded(newFiles);
      return true;
    } catch (error: any) {
      toast.error(error.message || "Não foi possível enviar o arquivo.");
      return false;
    } finally {
      busy.current = false;
      setUploading(false);
      setProgress(0);
    }
  };

  return { uploading, progress, uploadFiles };
}

export type AttachmentUploader = ReturnType<typeof useAttachmentUpload>;
