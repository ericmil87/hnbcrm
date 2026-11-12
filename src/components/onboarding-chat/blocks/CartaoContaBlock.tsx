import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, UserCheck } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  confirmResultMessage,
  emailCodeSentLine,
  emailIntroLine,
  ensureOncePerKey,
  ensureResultMessage,
  isEmailCodeComplete,
  markNotifiedOnce,
  normalizeEmailCode,
  requestResultMessage,
  resendWaitSeconds,
  type ConfirmReason,
  type EnsureReason,
  type RequestReason,
} from "@/lib/onboardingAccount";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

export interface CartaoContaViewProps {
  /** E-mail já confirmado (bloco do servidor ou status ao vivo). */
  verified: boolean;
  /** Endereço mascarado para onde o código foi ("bu…te@milfont.net"). */
  maskedEmail?: string | null;
  /** Materiais guardados à espera da confirmação. */
  pendingCount?: number;
  note?: string;
  /** Do `getEmailVerificationStatus` / envio automático (cooldown do último código). */
  canResendAt?: number;
  /** Aviso do envio automático (só quando ele não saiu por um motivo que a pessoa resolve). */
  initialMessage?: string | null;
  /** Versão compacta do começo da conversa (frase do Copiloto + campo). */
  compact?: boolean;
  onRequest: () => Promise<{ sent: boolean; reason?: RequestReason; canResendAt?: number }>;
  onConfirm: (code: string) => Promise<{ verified: boolean; reason?: ConfirmReason; attemptsLeft?: number }>;
  /** Chamado UMA vez quando a pessoa confirma o código por este cartão (a conversa avisa o Copiloto). */
  onVerified?: () => void;
  /** Relógio injetável (teste). */
  nowFn?: () => number;
}

/** Linha de sucesso (o cartão vira isto quando o e-mail está confirmado). */
export function EmailConfirmedLine() {
  return (
    <p
      role="status"
      className="inline-flex max-w-md items-center gap-2 rounded-field border border-semantic-success/40 bg-semantic-success/10 px-3 py-2 text-sm text-text-primary"
    >
      <CheckCircle2 className="size-4 shrink-0 text-semantic-success" aria-hidden="true" />
      E-mail confirmado
    </p>
  );
}

/**
 * `cartaoConta` (apresentação): o código foi enviado SOZINHO (a conversa avisa
 * para qual endereço); o campo aceita colar os 6 dígitos e confirma ao completar
 * o 6º dígito (sem botão obrigatório; "Confirmar" fica como alternativa). Erro
 * mostra as tentativas restantes e limpa o campo. Confirmado = uma linha de sucesso.
 */
export function CartaoContaView({
  verified,
  maskedEmail,
  pendingCount = 0,
  note,
  canResendAt,
  initialMessage = null,
  compact = false,
  onRequest,
  onConfirm,
  onVerified,
  nowFn = Date.now,
}: CartaoContaViewProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"request" | "confirm" | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [done, setDone] = useState(false);
  const [resendAt, setResendAt] = useState<number | undefined>(canResendAt);
  const [now, setNow] = useState(() => nowFn());
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmingRef = useRef(false);
  const verifiedHereRef = useRef(false);

  useEffect(() => {
    if (canResendAt !== undefined) setResendAt((cur) => Math.max(cur ?? 0, canResendAt));
  }, [canResendAt]);

  const wait = resendWaitSeconds(resendAt, now);
  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setInterval(() => setNow(nowFn()), 1000);
    return () => window.clearInterval(id);
  }, [wait > 0, nowFn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Avisa a conversa UMA vez, só quando a confirmação aconteceu por este cartão.
  useEffect(() => {
    if (done && verifiedHereRef.current) {
      verifiedHereRef.current = false;
      onVerified?.();
    }
  }, [done, onVerified]);

  if (verified || done) return <EmailConfirmedLine />;

  const request = async () => {
    setBusy("request");
    setMessage(null);
    try {
      const r = await onRequest();
      if (r.reason === "already_verified") setDone(true);
      if (typeof r.canResendAt === "number") {
        setResendAt(r.canResendAt);
        setNow(nowFn());
      }
      setMessage({ text: requestResultMessage(r, maskedEmail), tone: r.sent ? "info" : "error" });
    } catch {
      setMessage({ text: "Não foi possível enviar o código. Tente de novo.", tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (value: string) => {
    if (!isEmailCodeComplete(value) || confirmingRef.current) return;
    confirmingRef.current = true;
    setBusy("confirm");
    setMessage(null);
    try {
      const r = await onConfirm(value);
      if (r.verified) {
        verifiedHereRef.current = true;
        setDone(true);
        return;
      }
      setCode("");
      setMessage({ text: confirmResultMessage(r), tone: "error" });
    } catch {
      setCode("");
      setMessage({ text: confirmResultMessage({ verified: false }), tone: "error" });
    } finally {
      confirmingRef.current = false;
      setBusy(null);
      inputRef.current?.focus();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void confirm(code);
  };

  const shownMessage = message ?? (initialMessage ? { text: initialMessage, tone: "error" as const } : null);

  return (
    <BlockCard title="Confirme o seu e-mail" icon={UserCheck} note={note}>
      <p className="text-sm text-text-primary">{compact ? emailIntroLine(maskedEmail) : `${emailCodeSentLine(maskedEmail)} Digite ou cole aqui quando chegar.`}</p>
      {!compact && (
        <p className="mt-1 text-caption text-text-secondary">
          Confirmar o e-mail libera o envio de site, PDF, imagem e áudio.
          {pendingCount > 0 && (
            <>
              {" "}
              Guardei <span className="tabular-nums">{pendingCount}</span> {pendingCount === 1 ? "material" : "materiais"} para ler assim que você confirmar.
            </>
          )}
        </p>
      )}
      <form onSubmit={submit} className="mt-3 space-y-2" noValidate>
        <Input
          ref={inputRef}
          id={compact ? "onboarding-email-code-intro" : "onboarding-email-code"}
          label="Código de 6 dígitos"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          placeholder="000000"
          value={code}
          onChange={(e) => {
            const next = normalizeEmailCode(e.target.value);
            setCode(next);
            // Confirma sozinho ao completar o 6º dígito.
            if (isEmailCodeComplete(next)) void confirm(next);
          }}
          disabled={busy === "confirm"}
          className="tabular-nums tracking-widest"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" loading={busy === "request"} disabled={busy !== null || wait > 0} onClick={() => void request()}>
            {wait > 0 ? (
              <>
                Reenviar código em <span className="tabular-nums">{wait}</span> s
              </>
            ) : (
              "Reenviar código"
            )}
          </Button>
          <Button type="submit" variant="ghost" size="sm" disabled={busy !== null || !isEmailCodeComplete(code)}>
            Confirmar
          </Button>
        </div>
        <p className="text-caption text-text-muted">Não chegou? Confira o spam ou reenvie.</p>
      </form>
      <div aria-live="polite" className="mt-2">
        {shownMessage && (
          <p className={shownMessage.tone === "error" ? "text-sm text-semantic-error" : "text-sm text-text-secondary"}>{shownMessage.text}</p>
        )}
      </div>
    </BlockCard>
  );
}

/**
 * Container: estado ao vivo do e-mail, envio AUTOMÁTICO do código (uma vez por
 * sessão: o `ensureOncePerKey` cobre StrictMode e os dois cartões da conversa;
 * o servidor também é idempotente) e as mutations de reenviar/confirmar.
 */
export function CartaoContaBlock({ block, ctx }: BlockProps<"cartaoConta">) {
  const organizationId = ctx.organizationId as Id<"organizations"> | null;
  const sessionId = ctx.sessionId as Id<"onboardingSessions"> | null;
  const knownVerified = block.emailVerified || ctx.facts?.emailVerified === true;
  const status = useQuery(api.emailVerification.getEmailVerificationStatus, knownVerified ? "skip" : {}) as
    | { verified: boolean; canResendAt?: number; maskedEmail?: string }
    | undefined;
  const requestCode = useMutation(api.emailVerification.requestEmailVerificationCode);
  const confirmCode = useMutation(api.emailVerification.confirmEmailVerificationCode);
  const ensureSent = useMutation(api.onboardingChat.ensureEmailCodeSent);
  const [auto, setAuto] = useState<{ maskedEmail: string | null; canResendAt?: number; message: string | null } | null>(null);

  useEffect(() => {
    if (knownVerified || !organizationId || !sessionId) return;
    let alive = true;
    ensureOncePerKey(sessionId, () => ensureSent({ organizationId, sessionId }))
      .then((raw) => {
        if (!alive) return;
        const r = raw as { sent: boolean; reason?: EnsureReason; canResendAt?: number; maskedEmail: string | null };
        setAuto({ maskedEmail: r.maskedEmail ?? null, canResendAt: r.canResendAt, message: ensureResultMessage({ sent: r.sent, reason: r.reason }) });
      })
      .catch(() => {
        if (alive) setAuto({ maskedEmail: null, message: "Não consegui enviar o código agora. Toque em reenviar." });
      });
    return () => {
      alive = false;
    };
  }, [knownVerified, organizationId, sessionId, ensureSent]);

  const maskedEmail = block.maskedEmail ?? ctx.facts?.maskedEmail ?? status?.maskedEmail ?? auto?.maskedEmail ?? null;
  const verified = knownVerified || status?.verified === true;
  return (
    <CartaoContaView
      verified={verified}
      maskedEmail={maskedEmail}
      pendingCount={ctx.facts?.pendingMaterials ?? block.pendingCount ?? 0}
      note={block.note}
      compact={ctx.compact}
      canResendAt={status?.canResendAt ?? auto?.canResendAt}
      initialMessage={auto?.message ?? null}
      onRequest={() => requestCode({})}
      onConfirm={(code) => confirmCode({ code })}
      onVerified={() => {
        if (sessionId && markNotifiedOnce(`email_verified:${sessionId}`)) ctx.sendEvent({ kind: "notify", what: "email_verified" });
      }}
    />
  );
}
