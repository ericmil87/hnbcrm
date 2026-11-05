import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { Check, RefreshCw, AlertTriangle } from "lucide-react";
import type { ChannelConfig, BridgeSessionState } from "./types";

// --- Bridge QR modal (pairing) ---
// Auto-detects pairing: polls the gateway every ~4s while open. When the session
// flips to "connected" it persists the state once (via checkChannelHealth, so the
// card updates reactively), shows a success state, and auto-closes. The poll also
// renews the QR automatically as the gateway rotates it. The manual "Atualizar QR"
// button remains as a fallback.
const QR_POLL_INTERVAL_MS = 4000;
const QR_SUCCESS_CLOSE_MS = 1500;

type QrResult = {
  state: BridgeSessionState;
  qrCode?: string;
  displayPhoneNumber?: string;
  error?: string;
  // Contas que perderam este número por causa deste pareamento.
  displacedFrom?: string[];
};

export function BridgeQrModal({ config, onClose }: { config: ChannelConfig; onClose: () => void }) {
  const getBridgeQrCode = useAction(api.channelConfigs.getBridgeQrCode);
  const checkChannelHealth = useAction(api.channelConfigs.checkChannelHealth);

  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<QrResult | null>(null);
  // Transient warning shown while a poll tick fails but we keep retrying — never
  // tears down an already-rendered QR.
  const [pollError, setPollError] = useState<string | null>(null);
  // True once we've entered the success/close sequence. Distinguishes a fresh pair
  // ("Conectado!") from a number that was already connected when the modal opened.
  const [pairedNow, setPairedNow] = useState(false);
  const [displaced, setDisplaced] = useState<string[] | null>(null);

  // Refs survive re-renders without re-arming the effect below.
  const inFlightRef = useRef(false); // a getBridgeQrCode call is outstanding — skip the tick
  const doneRef = useRef(false); // pairing detected — stop polling, fire success once
  const hadQrRef = useRef(false); // a QR was displayed at some point (⇒ this is a fresh pair)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest onClose without re-arming the polling effect.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Success sequence — runs exactly once. Persists the pairing so the card badge
  // flips reactively, toasts, then auto-closes the modal.
  const finishConnected = useCallback(
    (displayPhoneNumber?: string, displacedFrom?: string[]) => {
      if (doneRef.current) return;
      doneRef.current = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      setPairedNow(hadQrRef.current);
      // One-shot persist so getChannelConfigs (a reactive query) updates the card.
      void checkChannelHealth({ configId: config._id }).catch(() => undefined);
      toast.success(
        hadQrRef.current
          ? `Número pareado com sucesso${displayPhoneNumber ? ` (${displayPhoneNumber})` : ""}`
          : `Número já conectado${displayPhoneNumber ? ` (${displayPhoneNumber})` : ""}`
      );
      // Desligar o canal de outra conta é consequência séria o bastante para não
      // caber num toast que some: fica no modal até o usuário fechar.
      if (displacedFrom && displacedFrom.length > 0) {
        setDisplaced(displacedFrom);
        toast.warning(
          `Este número foi desconectado de: ${displacedFrom.join(", ")}`,
          { duration: 10000 }
        );
        return; // sem auto-close — o aviso precisa ser lido
      }
      closeTimerRef.current = setTimeout(() => onCloseRef.current(), QR_SUCCESS_CLOSE_MS);
    },
    [checkChannelHealth, config._id]
  );

  // One poll tick — guarded so ticks never stack and stop once paired.
  const poll = useCallback(async () => {
    if (inFlightRef.current || doneRef.current) return;
    inFlightRef.current = true;
    try {
      const r = await getBridgeQrCode({ configId: config._id });
      if (doneRef.current) return;
      if (r.qrCode) hadQrRef.current = true;
      setResult(r);
      setPollError(null);
      if (r.state === "connected") finishConnected(r.displayPhoneNumber, r.displacedFrom);
    } catch (e) {
      if (doneRef.current) return;
      // Keep the modal (and any existing QR) alive; surface a discreet warning.
      setPollError(e instanceof Error ? e.message : "Não foi possível consultar a conexão. Tentando de novo…");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [getBridgeQrCode, config._id, finishConnected]);

  // Arm polling once on mount; tear it down on close/unmount.
  useEffect(() => {
    void poll();
    intervalRef.current = setInterval(() => void poll(), QR_POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, [poll]);

  const isConnected = result?.state === "connected";

  return (
    <Modal open onClose={onClose} title="Conectar número por QR code">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          No celular do número dedicado, abra o WhatsApp e vá em{" "}
          <span className="text-text-primary">Aparelhos conectados → Conectar um aparelho</span> e escaneie
          o código abaixo.
        </p>

        {/* Aviso ANTES de escanear. Genérico porque o número só é conhecido
            depois da conexão — não dá para nomear a conta antes. */}
        <div className="flex gap-2.5 rounded-lg border border-semantic-warning/30 bg-semantic-warning/5 p-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-semantic-warning" />
          <p className="text-xs leading-relaxed text-text-secondary">
            Um número de WhatsApp só pode estar ativo em <span className="text-text-primary">uma conta</span> do
            HNBCRM. Se este número já estiver conectado em outra conta, aquela conexão será{" "}
            <span className="text-text-primary">encerrada automaticamente</span> ao concluir a conexão — o
            canal de lá é desativado e as campanhas em andamento são pausadas. O histórico não é apagado.
          </p>
        </div>

        {displaced && displaced.length > 0 && (
          <div className="flex gap-2.5 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-semantic-warning" />
            <div className="text-xs leading-relaxed text-text-secondary">
              <p className="text-text-primary font-medium">Conexão anterior encerrada</p>
              <p className="mt-1">
                Este número estava conectado em{" "}
                <span className="text-text-primary">{displaced.join(", ")}</span>. O canal de lá foi desativado
                e o aparelho, desvinculado. Nenhuma conversa foi apagada.
              </p>
            </div>
          </div>
        )}

        <div className="flex min-h-[280px] items-center justify-center rounded-lg border border-border bg-surface-base p-4">
          {isConnected ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-semantic-success/10">
                <Check size={24} className="text-semantic-success" />
              </div>
              <p className="text-sm font-medium text-text-primary">
                {pairedNow ? "Conectado" : "Número já conectado"}
              </p>
              {result?.displayPhoneNumber && (
                <p className="text-xs text-text-muted tabular-nums">{result.displayPhoneNumber}</p>
              )}
            </div>
          ) : loading && !result ? (
            <div className="flex flex-col items-center gap-3 text-text-muted">
              <Spinner />
              <span className="text-sm">Consultando a conexão…</span>
            </div>
          ) : result?.qrCode ? (
            <div className="flex flex-col items-center gap-3">
              {/* wuzapi returns a base64 PNG data-URI — safe to render directly */}
              <img
                src={result.qrCode}
                alt="QR code para conectar o WhatsApp"
                className="h-56 w-56 rounded-lg bg-white p-2"
              />
              <p className="text-xs text-text-muted flex items-center gap-1.5">
                <RefreshCw size={12} className="animate-spin" />
                Aguardando leitura — o QR se renova sozinho.
              </p>
              {pollError && <p className="text-xs text-semantic-warning max-w-xs text-center">{pollError}</p>}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-semantic-error/10">
                <AlertTriangle size={24} className="text-semantic-error" />
              </div>
              <p className="text-sm font-medium text-text-primary">
                {result?.state === "banned" ? "Número banido" : "Não foi possível obter o QR"}
              </p>
              {(result?.error || pollError) && (
                <p className="text-xs text-semantic-error max-w-xs">{result?.error ?? pollError}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Fechar
          </Button>
          <Button
            onClick={() => void poll()}
            disabled={loading || isConnected || inFlightRef.current}
            className="flex-1"
          >
            <RefreshCw size={16} />
            Atualizar QR
          </Button>
        </div>
      </div>
    </Modal>
  );
}
