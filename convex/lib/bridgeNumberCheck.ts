/**
 * Checagem de número no gateway bridge (wuzapi) em DUAS etapas — núcleo ÚNICO
 * de "Nova conversa" (`startConversation.runBridgeNumberCheck`) e do worker de
 * campanha (`campaignWorker.checkNumberAndSend`).
 *
 * Por que duas etapas (medido em prod, 03/10/2026): `POST /user/check` responde
 * UM usuário só, com JID `@lid`, para as duas grafias BR (com e sem o 9º
 * dígito) — não diz qual é a registrada, e os dígitos do LID NÃO são telefone.
 * `GET /user/lid/{p}` é o único endpoint que devolve o JID de TELEFONE, e só
 * para a grafia real (404 "LID not found" para a errada).
 *
 * Caso real que motivou o núcleo (10/10/2026): o worker de campanha lia o JID
 * do `/user/check` com `phoneFromJid` sem olhar o servidor, e `161495166009388@lid`
 * virava o "telefone canônico" do destinatário — em lista manual/CSV isso
 * criaria o contato "+161495166009388" (o mesmo bug da v0.66.2, só que na
 * campanha). Só JID de telefone (`isPhoneJid`) vale como prova.
 *
 * Nunca lança por problema de gateway: devolve `{ ok: false, error }` e quem
 * chama decide (Nova conversa segue "não verificado"; a campanha envia sem
 * confirmar, com nota).
 */
import { buildBridgeCheckUserRequest, parseBridgeCheckUserResponse } from "./bridgeSession";
import {
  parseUserLidPhone,
  phoneSpellingVariants,
  pickCanonicalFromCheck,
  type CheckedWhatsappUser,
} from "./startConversation";

export type BridgeNumberCheckResult =
  | {
      ok: true;
      onWhatsapp: true;
      /** Grafia que o WhatsApp conhece (só dígitos, 8–15). Igual a `phone` quando nada mudou. */
      canonicalPhone: string;
      ambiguous?: boolean;
      lid?: string;
      checked: CheckedWhatsappUser[];
    }
  | { ok: true; onWhatsapp: false; checked: CheckedWhatsappUser[] }
  | { ok: false; error: string };

function trimBase(u: string): string {
  return u.replace(/\/+$/, "");
}

export async function checkBridgeNumber(args: {
  baseUrl: string;
  token: string;
  /** Telefone já normalizado (só dígitos, com DDI). */
  phone: string;
  /** Grafias que já são contato na org — desempate quando o gateway confirma as duas. */
  knownPhones?: string[];
  signal?: AbortSignal;
}): Promise<BridgeNumberCheckResult> {
  const { baseUrl, token, phone, signal } = args;
  const knownPhones = args.knownPhones ?? [];
  const candidates = phoneSpellingVariants(phone);
  try {
    const req = buildBridgeCheckUserRequest({ baseUrl, token, phones: candidates });
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal });
    const body = await res.json().catch(() => ({}));
    const parsed = parseBridgeCheckUserResponse(res.ok, res.status, body);
    if (!parsed.ok) return { ok: false, error: parsed.error.slice(0, 200) };
    if (parsed.users.length === 0) return { ok: false, error: "Resposta sem usuários" };

    let pick = pickCanonicalFromCheck(parsed.users, candidates, knownPhones);
    const checked: CheckedWhatsappUser[] = parsed.users.map((u) => ({
      phone: u.phone,
      onWhatsapp: u.onWhatsapp,
      ...(u.jid ? { jid: u.jid } : {}),
    }));
    if (!pick.onWhatsapp) return { ok: true, onWhatsapp: false, checked };

    // 2ª etapa: sem JID de TELEFONE e com mais de uma grafia possível, pergunta
    // ao /user/lid qual delas existe. Qualquer falha mantém a 1ª etapa.
    if (!pick.jid && candidates.length > 1) {
      const confirmedByLid: string[] = [];
      for (const p of candidates) {
        try {
          const r = await fetch(`${trimBase(baseUrl)}/user/lid/${p}`, { method: "GET", headers: { token }, signal });
          const b = await r.json().catch(() => ({}));
          const real = parseUserLidPhone(r.ok, b);
          if (real) confirmedByLid.push(real);
        } catch {
          /* mantém a 1ª etapa */
        }
      }
      const unique = Array.from(new Set(confirmedByLid));
      if (unique.length === 1) {
        pick = { ...pick, canonicalPhone: unique[0], ambiguous: undefined };
      } else if (unique.length > 1) {
        const known = unique.find((u) => knownPhones.includes(u));
        pick = { ...pick, canonicalPhone: known ?? unique[0], ambiguous: true };
      }
    }
    return {
      ok: true,
      onWhatsapp: true,
      canonicalPhone: pick.canonicalPhone ?? phone,
      checked,
      ...(pick.ambiguous ? { ambiguous: true } : {}),
      ...(pick.lid ? { lid: pick.lid } : {}),
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, error: aborted ? "Tempo esgotado" : e instanceof Error ? e.message.slice(0, 200) : "Erro de rede" };
  }
}
