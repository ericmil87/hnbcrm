/**
 * Busca de URL segura (P2.2 do onboarding v2) — núcleo PURO, sem Node.
 *
 * Defesa contra SSRF (OWASP): o destino é escolhido por terceiros (o usuário
 * cola o site; a agenda externa vem da configuração; o flyer vem do JSON da
 * agenda). Regras:
 *  - só `https`, porta 443 (ou lista explícita do chamador), sem `user:pass@`;
 *  - hostname recusado se for `localhost`, `*.local`, `*.internal`, rótulo
 *    único etc.; IP literal só na forma canônica (decimal/octal/hex/curta =
 *    recusado) e só se for público;
 *  - o DNS é resolvido AQUI e TODOS os IPs devolvidos são validados; a conexão
 *    é feita NO IP validado (o conector recebe o endereço, não resolve de
 *    novo) — defesa contra DNS rebinding;
 *  - redirect manual, revalidado a cada salto (máximo 3); cabeçalhos do
 *    chamador (ex.: chave da agenda) só vão para a origem inicial;
 *  - prazo total, limite de bytes lidos em streaming, allowlist de
 *    content-type; sem cookies, User-Agent genérico do produto.
 *
 * A parte de rede real (dns + https) mora em `lib/safeFetchNode.ts`
 * ("use node"); aqui o resolvedor e o conector são injetados, o que permite
 * testar o caminho inteiro com funções puras.
 */

export const SAFE_FETCH_USER_AGENT = "HNBCRM-Leitor/1.0";
export const SAFE_FETCH_MAX_REDIRECTS = 3;
export const SAFE_FETCH_MAX_URL_LENGTH = 2048;

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "SCHEME"
  | "CREDENTIALS"
  | "PORT"
  | "HOST_BLOCKED"
  | "IP_FORMAT"
  | "IP_BLOCKED"
  | "DNS_FAILED"
  | "TOO_MANY_REDIRECTS"
  | "HTTP_STATUS"
  | "CONTENT_TYPE"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "NETWORK";

/** Mensagens curtas em PT-BR (podem ir ao usuário; nunca levam a URL). */
export const SAFE_FETCH_MESSAGES: Record<SafeFetchErrorCode, string> = {
  INVALID_URL: "Endereço inválido.",
  SCHEME: "Só aceito endereços https://.",
  CREDENTIALS: "Endereço com usuário e senha não é aceito.",
  PORT: "Porta não permitida.",
  HOST_BLOCKED: "Esse endereço não é público.",
  IP_FORMAT: "Endereço numérico em formato não aceito.",
  IP_BLOCKED: "Esse endereço aponta para uma rede interna.",
  DNS_FAILED: "Não encontrei esse site.",
  TOO_MANY_REDIRECTS: "O site redirecionou vezes demais.",
  HTTP_STATUS: "O site não respondeu com sucesso.",
  CONTENT_TYPE: "Tipo de conteúdo não aceito.",
  TOO_LARGE: "Conteúdo grande demais.",
  TIMEOUT: "O site demorou demais para responder.",
  NETWORK: "Não consegui acessar o site.",
};

// ---------------------------------------------------------------------------
// IPs
// ---------------------------------------------------------------------------

/** IPv4 estrito: 4 partes decimais 0–255, sem zero à esquerda. */
export function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** IPv6 (com `::` e cauda IPv4) → 8 grupos de 16 bits. Zona (`%eth0`) = null. */
export function parseIPv6(input: string): number[] | null {
  let s = input;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s || s.includes("%") || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  // Cauda IPv4 (::ffff:1.2.3.4)
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4 || lastColon < 0) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1);
    if (s.endsWith("::")) {
      // ok: "::" seguido da cauda
    } else if (s.endsWith(":")) {
      s = s.slice(0, -1);
    }
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(dbl[0]);
  if (!head) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const rest = parseGroups(dbl[1]);
    if (!rest) return null;
    const missing = 8 - head.length - rest.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array(missing).fill(0), ...rest, ...tail];
  } else {
    groups = [...head, ...tail];
  }
  return groups.length === 8 ? groups : null;
}

type V4Range = [number, number, number, number, number, string];
// [a, b, c, d, prefixo, motivo]
const BLOCKED_V4: V4Range[] = [
  [0, 0, 0, 0, 8, "this-network"],
  [10, 0, 0, 0, 8, "private"],
  [100, 64, 0, 0, 10, "cgnat"],
  [127, 0, 0, 0, 8, "loopback"],
  [169, 254, 0, 0, 16, "link-local"],
  [172, 16, 0, 0, 12, "private"],
  [192, 0, 0, 0, 24, "ietf-protocol"],
  [192, 0, 2, 0, 24, "documentation"],
  [192, 88, 99, 0, 24, "6to4-relay"],
  [192, 168, 0, 0, 16, "private"],
  [198, 18, 0, 0, 15, "benchmark"],
  [198, 51, 100, 0, 24, "documentation"],
  [203, 0, 113, 0, 24, "documentation"],
  [224, 0, 0, 0, 4, "multicast"],
  [240, 0, 0, 0, 4, "reserved"], // inclui 255.255.255.255 (broadcast)
];

function v4ToInt(o: number[]): number {
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

/** Motivo do bloqueio de um IPv4 (octetos) ou null se for público. */
export function blockedIPv4Reason(octets: number[]): string | null {
  const ip = v4ToInt(octets);
  for (const [a, b, c, d, prefix, reason] of BLOCKED_V4) {
    const base = v4ToInt([a, b, c, d]);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (((ip & mask) >>> 0) === ((base & mask) >>> 0)) return reason;
  }
  return null;
}

function embeddedV4(g: number[], hiIdx: number): number[] {
  return [g[hiIdx] >> 8, g[hiIdx] & 0xff, g[hiIdx + 1] >> 8, g[hiIdx + 1] & 0xff];
}

/**
 * Motivo do bloqueio de um IPv6 (8 grupos) ou null se for público.
 * Allowlist: só unicast global 2000::/3, menos as faixas especiais; endereços
 * com IPv4 embutido (mapeado ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4
 * 2002::/16) seguem a regra do IPv4 embutido.
 */
export function blockedIPv6Reason(g: number[]): string | null {
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return "unspecified";
  if (allZero(0, 7) && g[7] === 1) return "loopback";
  if (allZero(0, 5) && g[5] === 0xffff) {
    const r = blockedIPv4Reason(embeddedV4(g, 6));
    return r ? `mapped-${r}` : null;
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) {
    const r = blockedIPv4Reason(embeddedV4(g, 6));
    return r ? `nat64-${r}` : null;
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return "nat64-local";
  if (g[0] === 0x2002) {
    const r = blockedIPv4Reason(embeddedV4(g, 1));
    return r ? `6to4-${r}` : null;
  }
  if ((g[0] & 0xfe00) === 0xfc00) return "unique-local";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xffc0) === 0xfec0) return "site-local";
  if ((g[0] & 0xff00) === 0xff00) return "multicast";
  if ((g[0] & 0xe000) !== 0x2000) return "not-global"; // fora de 2000::/3 (inclui ::/8, 100::/64)
  if (g[0] === 0x2001 && g[1] < 0x0200) return "ietf-protocol"; // 2001::/23 (Teredo, ORCHID, benchmark)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation";
  if (g[0] === 0x3fff && g[1] < 0x1000) return "documentation"; // 3fff::/20
  return null;
}

export type IpCheck =
  | { ok: true; family: 4 | 6 }
  | { ok: false; code: "IP_BLOCKED" | "IP_FORMAT"; reason: string };

/** Valida um endereço IP textual (como o resolvedor devolve). */
export function checkIpAddress(address: string): IpCheck {
  const v4 = parseIPv4(address);
  if (v4) {
    const r = blockedIPv4Reason(v4);
    return r ? { ok: false, code: "IP_BLOCKED", reason: r } : { ok: true, family: 4 };
  }
  const v6 = parseIPv6(address);
  if (v6) {
    const r = blockedIPv6Reason(v6);
    return r ? { ok: false, code: "IP_BLOCKED", reason: r } : { ok: true, family: 6 };
  }
  return { ok: false, code: "IP_FORMAT", reason: "unparseable" };
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
  ".arpa",
  ".lan",
  ".intranet",
  ".corp",
  ".private",
  ".home",
];
// `.test`/`.example`/`.invalid` (RFC 2606) não resolvem no DNS público; se um
// resolvedor local os mapear, a validação de IP decide.

export type UrlCheck =
  | {
      ok: true;
      url: URL;
      /** hostname sem colchetes e sem ponto final. */
      host: string;
      /** Literal IP (já validado como público) ou null para nome. */
      ipLiteral: { address: string; family: 4 | 6 } | null;
      port: number;
    }
  | { ok: false; code: SafeFetchErrorCode; reason?: string };

/** Host como digitado (antes do parser WHATWG normalizar). */
function rawAuthorityHost(raw: string): string | null {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#\\]*)/.exec(raw.trim());
  if (!m) return null;
  let auth = m[1];
  const at = auth.lastIndexOf("@");
  if (at >= 0) auth = auth.slice(at + 1);
  if (auth.startsWith("[")) {
    const end = auth.indexOf("]");
    return end > 0 ? auth.slice(0, end + 1) : auth;
  }
  const colon = auth.indexOf(":");
  return colon >= 0 ? auth.slice(0, colon) : auth;
}

const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/i;

/**
 * Valida a URL (sem rede). `allowedPorts` padrão [443].
 * O parser WHATWG converte `2130706433`, `0x7f.1`, `0177.0.0.1` e `１２７.０.０.１`
 * em `127.0.0.1`: por isso o host CRU é comparado com o normalizado e qualquer
 * forma numérica não canônica é recusada (IP_FORMAT), mesmo que pública.
 */
export function checkUrl(raw: string, opts: { allowedPorts?: number[] } = {}): UrlCheck {
  if (typeof raw !== "string" || !raw.trim() || raw.length > SAFE_FETCH_MAX_URL_LENGTH) {
    return { ok: false, code: "INVALID_URL" };
  }
  if (/[\u0000-\u001f\u007f\s]/.test(raw.trim())) return { ok: false, code: "INVALID_URL" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: "INVALID_URL" };
  }
  if (url.protocol !== "https:") return { ok: false, code: "SCHEME" };
  if (url.username || url.password) return { ok: false, code: "CREDENTIALS" };
  const rawHost = rawAuthorityHost(raw);
  if (rawHost === null) return { ok: false, code: "INVALID_URL" };
  if (rawHost.includes("%")) return { ok: false, code: "IP_FORMAT", reason: "percent-encoded host" };

  const allowedPorts = opts.allowedPorts ?? [443];
  const port = url.port ? Number(url.port) : 443;
  if (!allowedPorts.includes(port)) return { ok: false, code: "PORT" };

  const hostname = url.hostname.toLowerCase();
  // IPv6 literal
  if (hostname.startsWith("[")) {
    const g = parseIPv6(hostname);
    if (!g) return { ok: false, code: "IP_FORMAT" };
    const r = blockedIPv6Reason(g);
    if (r) return { ok: false, code: "IP_BLOCKED", reason: r };
    const address = hostname.slice(1, -1);
    return { ok: true, url, host: address, ipLiteral: { address, family: 6 }, port };
  }
  // IPv4 literal (o WHATWG já trata como IPv4 quando o último rótulo é numérico)
  const labels = hostname.replace(/\.$/, "").split(".");
  const lastLabel = labels[labels.length - 1] ?? "";
  if (parseIPv4(hostname) || NUMERIC_LABEL.test(lastLabel)) {
    const v4 = parseIPv4(hostname);
    if (!v4 || rawHost.toLowerCase() !== hostname) {
      return { ok: false, code: "IP_FORMAT", reason: "non-canonical ipv4" };
    }
    const r = blockedIPv4Reason(v4);
    if (r) return { ok: false, code: "IP_BLOCKED", reason: r };
    return { ok: true, url, host: hostname, ipLiteral: { address: hostname, family: 4 }, port };
  }
  // Nome
  const host = hostname.replace(/\.$/, "");
  if (!host || host.length > 253) return { ok: false, code: "INVALID_URL" };
  if (!host.includes(".")) return { ok: false, code: "HOST_BLOCKED", reason: "single-label" };
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, code: "HOST_BLOCKED", reason: "internal-name" };
  }
  if (!/^[a-z0-9.-]+$/.test(host) || host.split(".").some((l) => !l || l.length > 63)) {
    return { ok: false, code: "INVALID_URL" };
  }
  return { ok: true, url, host, ipLiteral: null, port };
}

// ---------------------------------------------------------------------------
// Content-type
// ---------------------------------------------------------------------------

export function parseContentType(header: string | undefined | null): {
  mime: string;
  charset: string | null;
} {
  const raw = (header ?? "").trim();
  const [mimePart, ...params] = raw.split(";");
  let charset: string | null = null;
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p);
    if (m) charset = m[1].toLowerCase();
  }
  return { mime: mimePart.trim().toLowerCase(), charset };
}

/** `allowed` aceita tipos exatos, `tipo/*` e `*\/*` (tudo, opt-in explícito). */
export function contentTypeAllowed(mime: string, allowed: readonly string[]): boolean {
  if (!mime || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) {
    return allowed.includes("*/*");
  }
  return allowed.some((a) => {
    const rule = a.toLowerCase();
    if (rule === "*/*") return true;
    if (rule.endsWith("/*")) return mime.startsWith(rule.slice(0, -1));
    return mime === rule;
  });
}

// ---------------------------------------------------------------------------
// Orquestração (resolvedor e conector injetados)
// ---------------------------------------------------------------------------

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type SafeFetchConnectRequest = {
  url: URL;
  /** IP já validado: o conector conecta NELE (sem resolver o nome de novo). */
  address: ResolvedAddress;
  /** Nome para SNI/Host (igual a `url.hostname`). */
  servername: string;
  headers: Record<string, string>;
  signal: AbortSignal;
};

export type SafeFetchRawResponse = {
  status: number;
  /** Nomes em minúsculas. */
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  /** Fecha a conexão sem ler o resto. */
  cancel: () => void;
};

export type SafeFetchDeps = {
  resolve: (hostname: string) => Promise<ResolvedAddress[]>;
  connect: (req: SafeFetchConnectRequest) => Promise<SafeFetchRawResponse>;
};

export type SafeFetchOptions = {
  /** Allowlist de content-type (ex.: ["text/html", "application/pdf", "image/*"]). */
  contentTypes: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  /** "abort" (padrão): passou do limite = erro TOO_LARGE. "truncate": devolve o começo. */
  onOverflow?: "abort" | "truncate";
  maxRedirects?: number;
  allowedPorts?: number[];
  /** Cabeçalhos extras; vão SÓ para a origem inicial (redirect para outra origem os descarta). */
  headers?: Record<string, string>;
  accept?: string;
};

export type SafeFetchResult =
  | {
      ok: true;
      status: number;
      finalUrl: string;
      mime: string;
      charset: string | null;
      bytes: Uint8Array;
      truncated: boolean;
      redirects: number;
    }
  | {
      ok: false;
      code: SafeFetchErrorCode;
      message: string;
      status?: number;
      reason?: string;
    };

const FORBIDDEN_CALLER_HEADERS = new Set([
  "host",
  "cookie",
  "cookie2",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "proxy-authorization",
  "te",
  "upgrade",
  "user-agent",
]);

function fail(code: SafeFetchErrorCode, extra: { status?: number; reason?: string } = {}): SafeFetchResult {
  return { ok: false, code, message: SAFE_FETCH_MESSAGES[code], ...extra };
}

class DeadlineError extends Error {
  constructor() {
    super("deadline");
    this.name = "DeadlineError";
  }
}

function raceDeadline<T>(p: Promise<T>, deadline: number, controller: AbortController): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) {
    controller.abort();
    return Promise.reject(new DeadlineError());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineError());
    }, left);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Escolhe o endereço e valida TODOS (um IP interno no conjunto recusa o nome inteiro). */
export function pickValidatedAddress(
  addresses: ResolvedAddress[]
): { ok: true; address: ResolvedAddress } | { ok: false; code: SafeFetchErrorCode; reason?: string } {
  if (!addresses.length) return { ok: false, code: "DNS_FAILED" };
  let chosen: ResolvedAddress | null = null;
  for (const a of addresses) {
    const c = checkIpAddress(a.address);
    if (!c.ok) return { ok: false, code: c.code === "IP_FORMAT" ? "DNS_FAILED" : "IP_BLOCKED", reason: c.reason };
    if (!chosen || (chosen.family === 6 && c.family === 4)) chosen = { address: a.address, family: c.family };
  }
  return { ok: true, address: chosen! };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Busca a URL com todas as regras. Nunca lança: erro vira `{ok:false, code}`.
 * Não loga nada (a URL pode ter segredo na query string).
 */
export async function safeFetchCore(
  rawUrl: string,
  opts: SafeFetchOptions,
  deps: SafeFetchDeps
): Promise<SafeFetchResult> {
  const deadline = Date.now() + opts.timeoutMs;
  const controller = new AbortController();
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  const callerHeaders: Record<string, string> = {};
  for (const [k, val] of Object.entries(opts.headers ?? {})) {
    if (!FORBIDDEN_CALLER_HEADERS.has(k.toLowerCase())) callerHeaders[k] = val;
  }

  let current = rawUrl;
  let originalOrigin: string | null = null;
  let response: SafeFetchRawResponse | null = null;
  try {
    for (let hop = 0; ; hop++) {
      const check = checkUrl(current, { allowedPorts: opts.allowedPorts });
      if (!check.ok) return fail(check.code, { reason: check.reason });
      if (originalOrigin === null) originalOrigin = check.url.origin;

      let address: ResolvedAddress;
      if (check.ipLiteral) {
        address = check.ipLiteral;
      } else {
        let resolved: ResolvedAddress[];
        try {
          resolved = await raceDeadline(deps.resolve(check.host), deadline, controller);
        } catch (e) {
          if (e instanceof DeadlineError) return fail("TIMEOUT");
          return fail("DNS_FAILED");
        }
        const picked = pickValidatedAddress(resolved);
        if (!picked.ok) return fail(picked.code, { reason: picked.reason });
        address = picked.address;
      }

      const headers: Record<string, string> = {
        "User-Agent": SAFE_FETCH_USER_AGENT,
        Accept: opts.accept ?? opts.contentTypes.join(", "),
        "Accept-Encoding": "identity",
        ...(check.url.origin === originalOrigin ? callerHeaders : {}),
      };
      try {
        response = await raceDeadline(
          deps.connect({
            url: check.url,
            address,
            servername: check.host,
            headers,
            signal: controller.signal,
          }),
          deadline,
          controller
        );
      } catch (e) {
        if (e instanceof DeadlineError || (e instanceof Error && e.name === "TimeoutError")) {
          return fail("TIMEOUT");
        }
        return fail("NETWORK");
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers["location"];
        response.cancel();
        response = null;
        if (!location) return fail("HTTP_STATUS", { status: 0 });
        if (hop >= maxRedirects) return fail("TOO_MANY_REDIRECTS");
        try {
          current = new URL(location, check.url).toString();
        } catch {
          return fail("INVALID_URL");
        }
        continue;
      }
      if (response.status < 200 || response.status > 299) {
        const status = response.status;
        response.cancel();
        response = null;
        return fail("HTTP_STATUS", { status });
      }

      const { mime, charset } = parseContentType(response.headers["content-type"]);
      if (!contentTypeAllowed(mime, opts.contentTypes)) {
        response.cancel();
        response = null;
        return fail("CONTENT_TYPE", { reason: mime || "missing" });
      }
      const overflow = opts.onOverflow ?? "abort";
      const declared = Number(response.headers["content-length"] ?? "");
      if (overflow === "abort" && Number.isFinite(declared) && declared > opts.maxBytes) {
        response.cancel();
        response = null;
        return fail("TOO_LARGE");
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      const iterator = response.body[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await raceDeadline(iterator.next(), deadline, controller);
          if (next.done) break;
          const chunk = next.value;
          if (total + chunk.byteLength > opts.maxBytes) {
            if (overflow === "abort") {
              response.cancel();
              response = null;
              return fail("TOO_LARGE");
            }
            chunks.push(chunk.subarray(0, opts.maxBytes - total));
            total = opts.maxBytes;
            truncated = true;
            response.cancel();
            response = null;
            break;
          }
          chunks.push(chunk);
          total += chunk.byteLength;
        }
      } catch (e) {
        if (e instanceof DeadlineError || (e instanceof Error && e.name === "TimeoutError")) {
          return fail("TIMEOUT");
        }
        return fail("NETWORK");
      }
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.byteLength;
      }
      const status = response?.status ?? 200;
      response = null;
      return {
        ok: true,
        status,
        finalUrl: check.url.toString(),
        mime,
        charset,
        bytes,
        truncated,
        redirects: hop,
      };
    }
  } finally {
    if (response) {
      try {
        response.cancel();
      } catch {
        // já fechado
      }
    }
    controller.abort();
  }
}

/** Texto do corpo: charset do cabeçalho → `<meta charset>` → utf-8. */
export function decodeBody(bytes: Uint8Array, charset: string | null, sniffHtml = false): string {
  let label = charset;
  if (!label && sniffHtml) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head);
    if (m) label = m[1].toLowerCase();
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
