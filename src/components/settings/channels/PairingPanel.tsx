import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound, QrCode, RefreshCw } from "lucide-react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { ConvexError } from "convex/values";
import { mutationErrorMessage } from "@/lib/errors";
import {
  CODE_REGENERATE_AFTER_MS,
  PAIRING_POLL_INTERVAL_MS,
  canRequestNewCode,
  codePollWindowEnd,
  friendlyPairingError,
  codeSecondsLeft,
  formatCountdown,
  formatLinkingCode,
  keepLinkingCode,
  type ConnectMode,
} from "@/lib/channelConnect";
import { copyToClipboard } from "./copyToClipboard";
import type { PairingResult, PollPairingFn, StartPairingFn } from "./types";

const SUCCESS_DONE_MS = 1500;

export interface ConnectedInfo {
  /** Um QR ou código foi mostrado antes de conectar (conexão nova, não um número que já estava conectado). */
  fresh: boolean;
  displayPhoneNumber?: string;
  displacedFrom: string[];
}

interface PairingPanelProps {
  configId: Id<"channelConfigs">;
  defaultMode: ConnectMode;
  /** DDI padrão da organização, só para a dica do campo de telefone. */
  defaultCountryCode?: string;
  startPairing: StartPairingFn;
  pollPairing: PollPairingFn;
  /** Dispara uma vez assim que o número conecta. */
  onConnected?: (info: ConnectedInfo) => void;
  /** Dispara depois da tela de sucesso (automático; se outra conta perdeu o número, só no "Concluir"). */
  onDone?: () => void;
}

/**
 * Passo "conectar o número": duas abas, código de conexão (padrão no celular) e QR code (padrão no
 * computador). Sem Convex: as chamadas chegam por props. Nunca guarda nem registra o QR ou o código.
 */
export function PairingPanel({
  configId,
  defaultMode,
  defaultCountryCode,
  startPairing,
  pollPairing,
  onConnected,
  onDone,
}: PairingPanelProps) {
  const [mode, setMode] = useState<ConnectMode>(defaultMode);
  const [connected, setConnected] = useState<ConnectedInfo | null>(null);
  const sawArtifactRef = useRef(false);
  const connectedRef = useRef(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const markArtifact = useCallback(() => {
    sawArtifactRef.current = true;
  }, []);

  const handleConnected = useCallback((r: PairingResult) => {
    if (connectedRef.current) return;
    connectedRef.current = true;
    const info: ConnectedInfo = {
      fresh: sawArtifactRef.current,
      displayPhoneNumber: r.displayPhoneNumber,
      displacedFrom: r.displacedFrom ?? [],
    };
    setConnected(info);
    onConnectedRef.current?.(info);
  }, []);

  // Sem aviso de outra conta, a tela de sucesso se fecha sozinha.
  const hasDisplaced = (connected?.displacedFrom.length ?? 0) > 0;
  useEffect(() => {
    if (!connected || hasDisplaced) return;
    const timer = setTimeout(() => onDoneRef.current?.(), SUCCESS_DONE_MS);
    return () => clearTimeout(timer);
  }, [connected, hasDisplaced]);

  if (connected) {
    return (
      <div className="space-y-4">
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface-base p-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-semantic-success/10">
            <Check size={24} className="text-semantic-success" />
          </div>
          <p className="text-sm font-medium text-text-primary" role="status">
            {connected.fresh ? "Número conectado" : "Número já conectado"}
          </p>
          {connected.displayPhoneNumber && (
            <p className="text-xs text-text-muted tabular-nums">{connected.displayPhoneNumber}</p>
          )}
        </div>
        {hasDisplaced && (
          <div className="flex gap-2.5 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-semantic-warning" />
            <div className="text-xs leading-relaxed text-text-secondary">
              <p className="font-medium text-text-primary">Conexão anterior encerrada</p>
              <p className="mt-1">
                Este número estava conectado em{" "}
                <span className="text-text-primary">{connected.displacedFrom.join(", ")}</span>. O canal de lá
                foi desativado e o aparelho, desvinculado. Nenhuma conversa foi apagada.
              </p>
            </div>
          </div>
        )}
        {hasDisplaced && (
          <Button className="w-full" onClick={() => onDoneRef.current?.()}>
            Concluir
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Aviso ANTES de conectar. Genérico porque o número só é conhecido depois da conexão. */}
      <div className="flex gap-2.5 rounded-lg border border-semantic-warning/30 bg-semantic-warning/5 p-3">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-semantic-warning" />
        <p className="text-xs leading-relaxed text-text-secondary">
          Um número de WhatsApp só pode estar ativo em <span className="text-text-primary">uma conta</span> do
          HNBCRM. Se este número já estiver conectado em outra conta, aquela conexão será{" "}
          <span className="text-text-primary">encerrada automaticamente</span> ao concluir a conexão: o canal de
          lá é desativado e as campanhas em andamento são pausadas. O histórico não é apagado.
        </p>
      </div>

      <SegmentedControl
        ariaLabel="Como conectar o número"
        value={mode}
        onValueChange={(v) => setMode(v as ConnectMode)}
        className="w-full"
        options={[
          { value: "code", label: "Conectar com código", icon: <KeyRound size={14} /> },
          { value: "qr", label: "Usar QR code", icon: <QrCode size={14} /> },
        ]}
      />

      {mode === "code" ? (
        <CodeTab
          key="code"
          configId={configId}
          defaultCountryCode={defaultCountryCode}
          startPairing={startPairing}
          pollPairing={pollPairing}
          onArtifact={markArtifact}
          onConnected={handleConnected}
        />
      ) : (
        <QrTab
          key="qr"
          configId={configId}
          startPairing={startPairing}
          pollPairing={pollPairing}
          onArtifact={markArtifact}
          onConnected={handleConnected}
        />
      )}
    </div>
  );
}

interface TabProps {
  configId: Id<"channelConfigs">;
  startPairing: StartPairingFn;
  pollPairing: PollPairingFn;
  onArtifact: () => void;
  onConnected: (r: PairingResult) => void;
}

function QrTab({ configId, startPairing, pollPairing, onArtifact, onConnected }: TabProps) {
  const [qr, setQr] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Incrementa para pedir um QR novo (botão "Gerar novo QR code").
  const [round, setRound] = useState(0);
  const [fatal, setFatal] = useState(false);
  const callbacks = useRef({ onArtifact, onConnected });
  callbacks.current = { onArtifact, onConnected };

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const run = async (fn: () => Promise<PairingResult>) => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const r = await fn();
        if (cancelled) return;
        setLoading(false);
        if (r.qrCode) {
          setQr(r.qrCode);
          callbacks.current.onArtifact();
        }
        setError(r.state === "error" ? friendlyPairingError(r.error, "Não foi possível obter o QR code.") : null);
        if (r.state === "connected") {
          stop();
          callbacks.current.onConnected(r);
        }
      } catch (e) {
        // Mantém o QR que já está na tela e tenta de novo no próximo ciclo.
        if (!cancelled) {
          setLoading(false);
          setError(friendlyPairingError(mutationErrorMessage(e, "Não foi possível consultar a conexão. Tentando de novo…")));
          // Erro de permissão ou de conta (ConvexError) não se resolve sozinho: para de consultar.
          if (e instanceof ConvexError) {
            setFatal(true);
            stop();
          }
        }
      } finally {
        inFlight = false;
      }
    };
    setLoading(true);
    setFatal(false);
    void run(() => startPairing({ configId, mode: "qr" }));
    // O poll renova o QR sozinho enquanto a aba estiver aberta.
    timer = setInterval(() => void run(() => pollPairing({ configId, mode: "qr" })), PAIRING_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [configId, round, startPairing, pollPairing]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        No celular do número, abra o WhatsApp e vá em{" "}
        <span className="text-text-primary">Aparelhos conectados › Conectar um aparelho</span> e aponte a câmera
        para o QR code.
      </p>
      <div className="flex min-h-[280px] items-center justify-center rounded-lg border border-border bg-surface-base p-4">
        {qr ? (
          <div className="flex flex-col items-center gap-3">
            <img src={qr} alt="QR code para conectar o WhatsApp" className="h-56 w-56 rounded-lg bg-white p-2" />
            <p className="flex items-center gap-1.5 text-xs text-text-muted">
              <RefreshCw size={12} className="animate-spin" />
              Aguardando leitura. O QR code se renova sozinho.
            </p>
            {error && <p className="max-w-xs text-center text-xs text-semantic-warning">{error}</p>}
          </div>
        ) : loading || !error ? (
          <div className="flex flex-col items-center gap-3 text-text-muted">
            <Spinner />
            <span className="text-sm">Consultando a conexão…</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-semantic-error/10">
              <AlertTriangle size={24} className="text-semantic-error" />
            </div>
            <p className="text-sm font-medium text-text-primary">Não foi possível obter o QR code</p>
            {error && <p className="max-w-xs text-xs text-semantic-error">{error}</p>}
          </div>
        )}
      </div>
      <Button variant="secondary" className="w-full" onClick={() => setRound((n) => n + 1)} disabled={loading && !fatal}>
        <RefreshCw size={16} />
        {fatal ? "Tentar de novo" : "Gerar novo QR code"}
      </Button>
    </div>
  );
}

function CodeTab({
  configId,
  defaultCountryCode,
  startPairing,
  pollPairing,
  onArtifact,
  onConnected,
}: TabProps & { defaultCountryCode?: string }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<string | undefined>();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // "Já digitei o código": o poll volta por mais 1 minuto.
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | undefined>();
  const callbacks = useRef({ onArtifact, onConnected });
  callbacks.current = { onArtifact, onConnected };

  const phoneDigits = phone.replace(/\D/g, "");
  const elapsed = startedAt === null ? 0 : now - startedAt;
  const windowEnd = startedAt === null ? 0 : codePollWindowEnd(startedAt, resumedAt);
  const expired = startedAt !== null && now >= windowEnd;

  const generate = async () => {
    setStarting(true);
    setError(null);
    try {
      const r = await startPairing({ configId, mode: "code", phone });
      if (r.attemptsLeft !== undefined) setAttemptsLeft(r.attemptsLeft);
      if (r.state === "connected") {
        callbacks.current.onConnected(r);
        return;
      }
      if (r.state === "error" || !r.linkingCode) {
        setError(friendlyPairingError(r.error, "Não foi possível gerar o código de conexão."));
        return;
      }
      setCode((prev) => keepLinkingCode(prev, r.linkingCode));
      setPollWarning(null);
      const t = Date.now();
      setNow(t);
      setResumedAt(null);
      setStartedAt(t);
      callbacks.current.onArtifact();
    } catch (e) {
      setError(friendlyPairingError(mutationErrorMessage(e, "Não foi possível gerar o código de conexão.")));
    } finally {
      setStarting(false);
    }
  };

  // Contagem a cada segundo; consulta o estado a cada 4 s por até 3 minutos (mais 1 depois de "Já digitei").
  useEffect(() => {
    if (startedAt === null) return;
    let cancelled = false;
    let inFlight = false;
    let finalDone = false;
    let lastPoll = startedAt;
    const end = codePollWindowEnd(startedAt, resumedAt);
    const doPoll = () => {
      inFlight = true;
      void pollPairing({ configId, mode: "code" })
        .then((r) => {
          if (cancelled) return;
          if (r.state === "connected") {
            clearInterval(timer);
            callbacks.current.onConnected(r);
            return;
          }
          // O poll não reenvia o código: mantém o último.
          setCode((prev) => keepLinkingCode(prev, r.linkingCode));
          setPollWarning(r.state === "error" ? friendlyPairingError(r.error) : null);
        })
        .catch((e) => {
          if (!cancelled)
            setPollWarning(friendlyPairingError(mutationErrorMessage(e, "Não foi possível consultar a conexão. Tentando de novo…")));
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= end) {
        // Um poll final antes de parar.
        if (!finalDone) {
          finalDone = true;
          if (!inFlight) doPoll();
        }
        clearInterval(timer);
        return;
      }
      if (inFlight || t - lastPoll < PAIRING_POLL_INTERVAL_MS) return;
      lastPoll = t;
      doPoll();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [startedAt, resumedAt, configId, pollPairing]);

  const canAnother = startedAt !== null && canRequestNewCode(elapsed);
  const secondsLeft = codeSecondsLeft(elapsed);
  const secondsToAnother = Math.max(0, Math.ceil((CODE_REGENERATE_AFTER_MS - elapsed) / 1000));

  return (
    <div className="space-y-3">
      {code === undefined ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <p className="text-sm text-text-secondary">
            Informe o número do WhatsApp que será conectado. Vamos gerar um código de conexão para você digitar no
            celular, sem precisar de outro aparelho para ler o QR code.
          </p>
          <Input
            label="Número do WhatsApp"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="ex.: 11 98765-4321"
            required
          />
          <p className="-mt-1 text-[13px] text-text-muted">
            Com DDD.{defaultCountryCode ? ` Sem o código do país, usamos +${defaultCountryCode}.` : ""}
          </p>
          <Button type="submit" className="w-full" disabled={starting || phoneDigits.length < 8}>
            {starting ? <Spinner size="sm" /> : <KeyRound size={16} />}
            Gerar código
          </Button>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-base p-4">
            <span
              className="select-all font-mono text-4xl font-semibold tracking-widest text-text-primary tabular-nums"
              aria-label="Código de conexão"
            >
              {formatLinkingCode(code)}
            </span>
            <Button
              variant="secondary"
              onClick={() => void copyToClipboard(formatLinkingCode(code), "Código copiado")}
            >
              <Copy size={14} />
              Copiar código
            </Button>
            <p className="flex items-center gap-1.5 text-xs text-text-muted" role="status">
              {expired ? (
                "Paramos de consultar. Se já digitou o código, toque em “Já digitei o código”; senão, gere outro."
              ) : secondsLeft === 0 ? (
                "O código pode ter vencido. Gere outro."
              ) : (
                <>
                  <RefreshCw size={12} className="animate-spin" />
                  Aguardando a conexão. O código vale por cerca de 2 minutos ({formatCountdown(secondsLeft)}).
                </>
              )}
            </p>
          </div>
          <ol className="list-inside list-decimal space-y-1 text-sm text-text-secondary">
            <li>No celular do número, abra o WhatsApp.</li>
            <li>
              Vá em <span className="text-text-primary">Aparelhos conectados › Conectar um aparelho</span>.
            </li>
            <li>
              Toque em <span className="text-text-primary">Conectar com número de telefone</span> e digite o código.
            </li>
          </ol>
          {expired && (
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => {
                const t = Date.now();
                setNow(t);
                setResumedAt(t);
              }}
            >
              Já digitei o código
            </Button>
          )}
          <Button
            variant="secondary"
            className="w-full"
            disabled={!canAnother || starting}
            onClick={() => void generate()}
          >
            {starting ? <Spinner size="sm" /> : <RefreshCw size={16} />}
            Gerar outro código
          </Button>
          {!canAnother && (
            <p className="text-center text-xs text-text-muted">
              Você poderá gerar outro código em {formatCountdown(secondsToAnother)}.
            </p>
          )}
          {pollWarning && <p className="text-center text-xs text-semantic-warning">{pollWarning}</p>}
        </div>
      )}
      {error && (
        <p className="text-sm text-semantic-error" role="alert">
          {error}
        </p>
      )}
      {attemptsLeft !== undefined && (
        <p className="text-xs text-text-muted">
          {attemptsLeft === 1 ? "Resta 1 código" : `Restam ${attemptsLeft} códigos`} nesta hora.
        </p>
      )}
    </div>
  );
}
