import { useState, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  FileText,
  Download,
  Trash2,
  Plus,
  File,
  FileImage,
  FileSpreadsheet,
} from "lucide-react";

interface LeadDocumentsProps {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
}

const CATEGORY_LABELS: Record<string, string> = {
  contract: "Contrato",
  proposal: "Proposta",
  invoice: "Fatura",
  other: "Outro",
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return FileImage;
  if (mimeType.includes("spreadsheet") || mimeType.includes("csv") || mimeType.includes("excel"))
    return FileSpreadsheet;
  if (mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("text"))
    return FileText;
  return File;
}

// Espelha o `returns` de convex/files.ts:getLeadDocuments. Existe porque o tipo
// que chega do `api` está caindo para `any` — sem isto, `doc` no map abaixo é
// implicitamente any e nada no arquivo é verificado.
type LeadDocumentRow = {
  documentId: Id<"leadDocuments">;
  fileId: Id<"files">;
  title?: string;
  category?: "contract" | "proposal" | "invoice" | "other";
  name: string;
  mimeType: string;
  size: number;
  url: string | null;
  uploadedBy: Id<"teamMembers">;
  createdAt: number;
};

export function LeadDocuments({ leadId, organizationId }: LeadDocumentsProps) {
  const [showUploadModal, setShowUploadModal] = useState(false);
  const documents = useQuery(api.files.getLeadDocuments, { leadId }) as
    | LeadDocumentRow[]
    | undefined;
  const removeDocument = useMutation(api.leads.removeLeadDocument);

  const handleDelete = async (documentId: Id<"leadDocuments">, name: string) => {
    if (!confirm(`Remover o documento "${name}"?`)) return;
    try {
      await removeDocument({ documentId });
      toast.success("Documento removido");
    } catch (error: any) {
      toast.error(error.message || "Falha ao remover documento");
    }
  };

  const handleDownload = (url: string | null, name: string) => {
    if (!url) {
      toast.error("URL do arquivo indisponível");
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide">
          Documentos
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowUploadModal(true)}
        >
          <Plus size={14} />
          Adicionar
        </Button>
      </div>

      {documents === undefined ? (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : documents.length === 0 ? (
        <div className="bg-surface-sunken rounded-card p-4 text-center">
          <FileText size={24} className="mx-auto text-text-muted mb-2" />
          <p className="text-sm text-text-muted">Nenhum documento</p>
        </div>
      ) : (
        <div className="space-y-1">
          {documents.map((doc) => {
            const Icon = getFileIcon(doc.mimeType);
            return (
              <div
                key={doc.documentId}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface-sunken transition-colors group"
              >
                <Icon size={16} className="shrink-0 text-text-muted" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary truncate">
                    {doc.title || doc.name}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <span>{formatFileSize(doc.size)}</span>
                    {doc.category && (
                      <>
                        <span>-</span>
                        <span>{CATEGORY_LABELS[doc.category] || doc.category}</span>
                      </>
                    )}
                    <span>-</span>
                    <span>
                      {new Date(doc.createdAt).toLocaleDateString("pt-BR", {
                        day: "2-digit",
                        month: "short",
                      })}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => handleDownload(doc.url, doc.name)}
                  className="p-1.5 rounded-full text-text-muted hover:text-brand-400 hover:bg-brand-500/10 transition-colors opacity-0 group-hover:opacity-100"
                  aria-label="Baixar"
                >
                  <Download size={14} />
                </button>
                <button
                  onClick={() => handleDelete(doc.documentId, doc.title || doc.name)}
                  className="p-1.5 rounded-full text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors opacity-0 group-hover:opacity-100"
                  aria-label="Remover"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <UploadDocumentModal
        open={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        leadId={leadId}
        organizationId={organizationId}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Upload Document Modal                                              */
/* ------------------------------------------------------------------ */

function UploadDocumentModal({
  open,
  onClose,
  leadId,
  organizationId,
}: {
  open: boolean;
  onClose: () => void;
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<"contract" | "proposal" | "invoice" | "other" | "">("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);
  const addLeadDocument = useMutation(api.leads.addLeadDocument);

  const resetForm = () => {
    setTitle("");
    setCategory("");
    setSelectedFile(null);
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      if (!title) {
        setTitle(file.name.replace(/\.[^.]+$/, ""));
      }
    }
  };

  const handleUpload = async () => {
    if (!selectedFile || uploading) return;
    setUploading(true);

    try {
      // 1. Get upload URL
      const uploadUrl = await generateUploadUrl({ organizationId });

      // 2. Upload file to storage
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": selectedFile.type },
        body: selectedFile,
      });

      if (!response.ok) throw new Error("Falha no upload do arquivo");

      const { storageId } = await response.json();

      // 3. Save file metadata
      const fileId = await saveFile({
        organizationId,
        storageId,
        name: selectedFile.name,
        mimeType: selectedFile.type || "application/octet-stream",
        size: selectedFile.size,
        fileType: "lead_document",
        leadId,
      });

      // 4. Create lead document entry
      await addLeadDocument({
        leadId,
        fileId,
        title: title.trim() || undefined,
        category: category || undefined,
      });

      toast.success("Documento adicionado com sucesso");
      handleClose();
    } catch (error: any) {
      toast.error(error.message || "Falha ao enviar documento");
      setUploading(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title="Adicionar Documento">
      <div className="space-y-4">
        {/* File input */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Arquivo
          </label>
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            className="hidden"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.gif,.webp"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "w-full px-4 py-3 border-2 border-dashed rounded-lg text-sm transition-colors text-left",
              selectedFile
                ? "border-brand-500/40 bg-brand-500/5 text-text-primary"
                : "border-border-strong bg-surface-raised text-text-muted hover:border-brand-500/40 hover:bg-surface-sunken"
            )}
          >
            {selectedFile ? (
              <span className="flex items-center gap-2">
                <File size={16} className="text-brand-400" />
                <span className="truncate">{selectedFile.name}</span>
                <span className="shrink-0 text-xs text-text-muted">
                  ({formatFileSize(selectedFile.size)})
                </span>
              </span>
            ) : (
              "Clique para selecionar um arquivo..."
            )}
          </button>
        </div>

        {/* Title */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Título <span className="text-text-muted font-normal">(opcional)</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Nome descritivo do documento"
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
          />
        </div>

        {/* Category */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Categoria <span className="text-text-muted font-normal">(opcional)</span>
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as typeof category)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            style={{ fontSize: "16px" }}
          >
            <option value="">Selecione...</option>
            <option value="contract">Contrato</option>
            <option value="proposal">Proposta</option>
            <option value="invoice">Fatura</option>
            <option value="other">Outro</option>
          </select>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button
            variant="secondary"
            size="md"
            onClick={handleClose}
            className="flex-1"
          >
            Cancelar
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleUpload}
            disabled={!selectedFile || uploading}
            className="flex-1"
          >
            {uploading ? "Enviando..." : "Enviar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
