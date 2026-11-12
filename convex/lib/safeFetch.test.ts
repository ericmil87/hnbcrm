import { describe, expect, it } from "vitest";
import {
  checkIpAddress,
  checkUrl,
  contentTypeAllowed,
  decodeBody,
  parseIPv6,
  pickValidatedAddress,
  portAllowed,
  ResolvedAddress,
  SafeFetchConnectRequest,
  SafeFetchDeps,
  SafeFetchRawResponse,
  safeFetchCore,
  SAFE_FETCH_USER_AGENT,
} from "./safeFetch";

describe("checkIpAddress — bloqueados", () => {
  const blocked: Array<[string, string]> = [
    ["0.0.0.0", "this-network"],
    ["0.1.2.3", "this-network"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.254", "cgnat"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback"],
    ["169.254.169.254", "link-local"], // metadados de nuvem
    ["169.254.0.1", "link-local"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.8", "ietf-protocol"],
    ["192.0.2.10", "documentation"],
    ["192.88.99.1", "6to4-relay"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["198.18.0.1", "benchmark"],
    ["198.19.255.255", "benchmark"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::ffff:127.0.0.1", "mapped-loopback"],
    ["::ffff:7f00:1", "mapped-loopback"],
    ["::ffff:169.254.169.254", "mapped-link-local"],
    ["::ffff:10.1.2.3", "mapped-private"],
    ["64:ff9b::10.0.0.1", "nat64-private"],
    ["64:ff9b::a9fe:a9fe", "nat64-link-local"],
    ["64:ff9b:1::1", "nat64-local"],
    ["::127.0.0.1", "not-global"], // IPv4-compatível (obsoleto)
    ["::ffff:0:127.0.0.1", "not-global"], // SIIT
    ["100::1", "not-global"], // discard
    ["fc00::1", "unique-local"],
    ["fd12:3456:789a::1", "unique-local"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["ff05::2", "multicast"],
    ["2001::1", "ietf-protocol"], // Teredo
    ["2001:10::1", "ietf-protocol"], // ORCHID
    ["2001:db8::1", "documentation"],
    ["3fff::1", "documentation"],
    ["2002:7f00:1::1", "6to4-loopback"],
    ["2002:c0a8:101::1", "6to4-private"],
    ["5f00::1", "not-global"], // SRv6 (fora de 2000::/3)
    ["4000::1", "not-global"],
  ];
  it.each(blocked)("%s → %s", (ip, reason) => {
    const r = checkIpAddress(ip);
    expect(r).toEqual({ ok: false, code: "IP_BLOCKED", reason });
  });
});

describe("checkIpAddress — permitidos", () => {
  it.each([
    ["8.8.8.8", 4],
    ["1.1.1.1", 4],
    ["93.184.216.34", 4],
    ["100.63.255.255", 4], // logo abaixo do CGNAT
    ["100.128.0.1", 4], // logo acima do CGNAT
    ["172.15.255.255", 4],
    ["172.32.0.1", 4],
    ["169.253.255.255", 4],
    ["192.169.0.1", 4],
    ["223.255.255.255", 4],
    ["2606:4700:4700::1111", 6],
    ["2800:3f0:4001:810::200e", 6],
    ["::ffff:8.8.8.8", 6],
    ["64:ff9b::808:808", 6],
    ["2002:808:808::1", 6],
  ] as const)("%s", (ip, family) => {
    expect(checkIpAddress(ip)).toEqual({ ok: true, family });
  });

  it("texto que não é IP → IP_FORMAT", () => {
    expect(checkIpAddress("localhost").ok).toBe(false);
    expect(checkIpAddress("fe80::1%eth0")).toMatchObject({ ok: false, code: "IP_FORMAT" });
    expect(checkIpAddress("010.0.0.1")).toMatchObject({ ok: false, code: "IP_FORMAT" });
    expect(checkIpAddress("1.2.3")).toMatchObject({ ok: false, code: "IP_FORMAT" });
  });
});

describe("parseIPv6", () => {
  it("expande `::`, cauda IPv4 e recusa formas inválidas", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("[::ffff:1.2.3.4]")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("12345::1")).toBeNull();
    expect(parseIPv6("1::2:")).toBeNull();
    expect(parseIPv6("::1%lo")).toBeNull();
  });
});

describe("checkUrl", () => {
  const refused: Array<[string, string]> = [
    ["http://example.com/", "SCHEME"],
    ["ftp://example.com/", "SCHEME"],
    ["file:///etc/passwd", "SCHEME"],
    ["javascript:alert(1)", "SCHEME"],
    ["gopher://example.com/", "SCHEME"],
    ["https://user:pass@example.com/", "CREDENTIALS"],
    ["https://user@example.com/", "CREDENTIALS"],
    ["https://example.com:8443/", "PORT"],
    ["https://example.com:80/", "PORT"],
    ["https://example.com:22/", "PORT"],
    ["https://localhost/", "HOST_BLOCKED"],
    ["https://LOCALHOST./", "HOST_BLOCKED"],
    ["https://app.localhost/", "HOST_BLOCKED"],
    ["https://printer.local/", "HOST_BLOCKED"],
    ["https://metadata.google.internal/", "HOST_BLOCKED"],
    ["https://db.internal/", "HOST_BLOCKED"],
    ["https://nas.home.arpa/", "HOST_BLOCKED"],
    ["https://1.0.0.127.in-addr.arpa/", "HOST_BLOCKED"],
    ["https://router.lan/", "HOST_BLOCKED"],
    ["https://metadata/", "HOST_BLOCKED"],
    ["https://intranet/", "HOST_BLOCKED"],
    ["https://127.0.0.1/", "IP_BLOCKED"],
    ["https://10.0.0.5/", "IP_BLOCKED"],
    ["https://169.254.169.254/latest/meta-data/", "IP_BLOCKED"],
    ["https://192.168.1.1/", "IP_BLOCKED"],
    ["https://100.100.100.200/", "IP_BLOCKED"],
    ["https://0.0.0.0/", "IP_BLOCKED"],
    ["https://[::1]/", "IP_BLOCKED"],
    ["https://[::]/", "IP_BLOCKED"],
    ["https://[::ffff:127.0.0.1]/", "IP_BLOCKED"],
    ["https://[::ffff:a9fe:a9fe]/", "IP_BLOCKED"],
    ["https://[fd00::1]/", "IP_BLOCKED"],
    ["https://[fe80::1]/", "IP_BLOCKED"],
    ["https://[64:ff9b::7f00:1]/", "IP_BLOCKED"],
    // formatos numéricos alternativos (o parser WHATWG normalizaria)
    ["https://2130706433/", "IP_FORMAT"],
    ["https://0x7f000001/", "IP_FORMAT"],
    ["https://0x7f.0.0.1/", "IP_FORMAT"],
    ["https://0177.0.0.1/", "IP_FORMAT"],
    ["https://127.1/", "IP_FORMAT"],
    ["https://127.0.1/", "IP_FORMAT"],
    ["https://017700000001/", "IP_FORMAT"],
    ["https://127.0.0.1./", "IP_FORMAT"],
    ["https://%31%32%37.0.0.1/", "IP_FORMAT"],
    ["https://１２７.０.０.１/", "IP_FORMAT"],
    ["https://134744072/", "IP_FORMAT"], // 8.8.8.8 em decimal: recusado mesmo público
    ["https://0x08080808/", "IP_FORMAT"],
    ["https://foo.0x10/", "INVALID_URL"],
    ["", "INVALID_URL"],
    ["not a url", "INVALID_URL"],
    ["https://exa mple.com/", "INVALID_URL"],
    ["https://exa\nmple.com/", "INVALID_URL"],
    [`https://example.com/${"a".repeat(2100)}`, "INVALID_URL"],
  ];
  it.each(refused)("recusa %s → %s", (url, code) => {
    const r = checkUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it.each([
    ["https://example.com/", "example.com"],
    ["https://www.salao-exemplo.com.br/servicos?x=1#topo", "www.salao-exemplo.com.br"],
    ["https://EXAMPLE.com:443/a", "example.com"],
    ["https://example.com./", "example.com"],
    ["https://café.com.br/", "xn--caf-dma.com.br"],
    ["https://site.example/api/agenda", "site.example"],
  ])("aceita %s", (url, host) => {
    const r = checkUrl(url);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe(host);
      expect(r.ipLiteral).toBeNull();
      expect(r.port).toBe(443);
    }
  });

  it("IP literal público e canônico é aceito; porta extra só por lista explícita", () => {
    const r = checkUrl("https://8.8.8.8/");
    expect(r).toMatchObject({ ok: true, ipLiteral: { address: "8.8.8.8", family: 4 } });
    const v6 = checkUrl("https://[2606:4700:4700::1111]/");
    expect(v6).toMatchObject({ ok: true, ipLiteral: { family: 6 } });
    expect(checkUrl("https://example.com:8443/", { allowedPorts: [443, 8443] }).ok).toBe(true);
  });
});

describe("contentTypeAllowed / decodeBody", () => {
  it("tipos exatos, curinga de família e */* opt-in", () => {
    expect(contentTypeAllowed("text/html", ["text/html"])).toBe(true);
    expect(contentTypeAllowed("application/pdf", ["text/html"])).toBe(false);
    expect(contentTypeAllowed("image/png", ["image/*"])).toBe(true);
    expect(contentTypeAllowed("imagex/png", ["image/*"])).toBe(false);
    expect(contentTypeAllowed("", ["text/html"])).toBe(false);
    expect(contentTypeAllowed("", ["*/*"])).toBe(true);
    expect(contentTypeAllowed("application/json", ["*/*"])).toBe(true);
  });

  it("decodifica pelo charset do cabeçalho ou do <meta>", () => {
    const latin1 = new Uint8Array([0x63, 0xe7, 0xe3, 0x6f]); // "cção" em latin1 (sem o 1º c)
    expect(decodeBody(latin1, "iso-8859-1")).toBe("cção");
    const html = new TextEncoder().encode('<meta charset="windows-1252">');
    const withAccent = new Uint8Array([...html, 0xe9]);
    expect(decodeBody(withAccent, null, true).endsWith("é")).toBe(true);
    expect(decodeBody(new TextEncoder().encode("ação"), null)).toBe("ação");
  });
});

describe("pickValidatedAddress (DNS rebinding / multi-registro)", () => {
  it("um IP interno entre vários recusa o nome inteiro", () => {
    const r = pickValidatedAddress([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(r).toMatchObject({ ok: false, code: "IP_BLOCKED" });
  });
  it("prefere IPv4 quando há os dois", () => {
    const r = pickValidatedAddress([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]);
    expect(r).toEqual({ ok: true, address: { address: "1.1.1.1", family: 4 } });
  });
  it("lista vazia → DNS_FAILED", () => {
    expect(pickValidatedAddress([])).toMatchObject({ ok: false, code: "DNS_FAILED" });
  });
});

// ---------------------------------------------------------------------------
// Orquestração com resolvedor/conector falsos
// ---------------------------------------------------------------------------

type FakeRoute = {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
  /** Nunca termina o corpo (para testar prazo). */
  hang?: boolean;
};

function fakeNet(opts: {
  dns: Record<string, string[]>;
  routes: Record<string, FakeRoute>;
}) {
  const connects: SafeFetchConnectRequest[] = [];
  let canceled = 0;
  const deps: SafeFetchDeps = {
    resolve: async (host) => {
      const list = opts.dns[host];
      if (!list) throw new Error("ENOTFOUND");
      return list.map<ResolvedAddress>((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    connect: async (req) => {
      connects.push(req);
      const route = opts.routes[req.url.toString()];
      if (!route) throw new Error("ECONNREFUSED");
      const chunks = route.chunks ?? [];
      const res: SafeFetchRawResponse = {
        status: route.status ?? 200,
        headers: route.headers ?? { "content-type": "text/html" },
        body: (async function* () {
          for (const c of chunks) yield c;
          if (route.hang) await new Promise(() => {});
        })(),
        cancel: () => {
          canceled++;
        },
      };
      return res;
    },
  };
  return { deps, connects, canceled: () => canceled };
}

const enc = (s: string) => new TextEncoder().encode(s);
const HTML_OPTS = { contentTypes: ["text/html"], maxBytes: 1000, timeoutMs: 2000 };

describe("safeFetchCore", () => {
  it("caminho feliz: resolve, conecta NO IP validado com SNI do nome, sem cookie e com UA do produto", async () => {
    const net = fakeNet({
      dns: { "site.com.br": ["93.184.216.34"] },
      routes: { "https://site.com.br/": { headers: { "content-type": "text/html; charset=utf-8" }, chunks: [enc("<p>oi</p>")] } },
    });
    const r = await safeFetchCore("https://site.com.br/", { ...HTML_OPTS, headers: { Cookie: "a=b", Host: "evil" } }, net.deps);
    expect(r).toMatchObject({ ok: true, mime: "text/html", charset: "utf-8", truncated: false, redirects: 0 });
    if (r.ok) expect(new TextDecoder().decode(r.bytes)).toBe("<p>oi</p>");
    expect(net.connects).toHaveLength(1);
    expect(net.connects[0].address).toEqual({ address: "93.184.216.34", family: 4 });
    expect(net.connects[0].servername).toBe("site.com.br");
    expect(net.connects[0].headers["User-Agent"]).toBe(SAFE_FETCH_USER_AGENT);
    expect(Object.keys(net.connects[0].headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    expect(net.connects[0].headers.Host).toBeUndefined();
  });

  it("DNS que devolve IP privado → recusa sem conectar (inclui metadados e rebinding misto)", async () => {
    for (const ips of [["10.0.0.7"], ["169.254.169.254"], ["93.184.216.34", "127.0.0.1"], ["::1"], ["::ffff:192.168.0.1"]]) {
      const net = fakeNet({ dns: { "evil.com": ips }, routes: {} });
      const r = await safeFetchCore("https://evil.com/", HTML_OPTS, net.deps);
      expect(r).toMatchObject({ ok: false, code: "IP_BLOCKED" });
      expect(net.connects).toHaveLength(0);
    }
  });

  it("DNS falhou → DNS_FAILED", async () => {
    const net = fakeNet({ dns: {}, routes: {} });
    expect(await safeFetchCore("https://nao-existe.com/", HTML_OPTS, net.deps)).toMatchObject({ ok: false, code: "DNS_FAILED" });
  });

  it("redirect para IP privado é recusado no salto", async () => {
    const net = fakeNet({
      dns: { "a.com": ["93.184.216.34"] },
      routes: { "https://a.com/": { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } } },
    });
    const r = await safeFetchCore("https://a.com/", HTML_OPTS, net.deps);
    expect(r).toMatchObject({ ok: false, code: "IP_BLOCKED" });
    expect(net.connects).toHaveLength(1);
  });

  it("redirect para nome que resolve para rede interna é recusado (revalida o DNS a cada salto)", async () => {
    const net = fakeNet({
      dns: { "a.com": ["93.184.216.34"], "b.com": ["192.168.0.10"] },
      routes: { "https://a.com/": { status: 301, headers: { location: "https://b.com/x" } } },
    });
    expect(await safeFetchCore("https://a.com/", HTML_OPTS, net.deps)).toMatchObject({ ok: false, code: "IP_BLOCKED" });
  });

  it("redirect para http:// é recusado", async () => {
    const net = fakeNet({
      dns: { "a.com": ["93.184.216.34"] },
      routes: { "https://a.com/": { status: 302, headers: { location: "http://a.com/" } } },
    });
    expect(await safeFetchCore("https://a.com/", HTML_OPTS, net.deps)).toMatchObject({ ok: false, code: "SCHEME" });
  });

  it("até 3 redirects passa; o 4º é recusado", async () => {
    const routes: Record<string, FakeRoute> = {};
    for (let i = 0; i < 5; i++) {
      routes[`https://a.com/${i}`] = { status: 307, headers: { location: `/${i + 1}` } };
    }
    routes["https://a.com/3"] = { chunks: [enc("fim")] };
    const ok = fakeNet({ dns: { "a.com": ["93.184.216.34"] }, routes });
    const r = await safeFetchCore("https://a.com/0", HTML_OPTS, ok.deps);
    expect(r).toMatchObject({ ok: true, redirects: 3, finalUrl: "https://a.com/3" });

    routes["https://a.com/3"] = { status: 308, headers: { location: "/4" } };
    routes["https://a.com/4"] = { chunks: [enc("fim")] };
    const tooMany = fakeNet({ dns: { "a.com": ["93.184.216.34"] }, routes });
    expect(await safeFetchCore("https://a.com/0", HTML_OPTS, tooMany.deps)).toMatchObject({
      ok: false,
      code: "TOO_MANY_REDIRECTS",
    });
    expect(tooMany.connects).toHaveLength(4);
  });

  it("cabeçalhos do chamador (chave) não seguem redirect para outra origem", async () => {
    const net = fakeNet({
      dns: { "a.com": ["93.184.216.34"], "b.com": ["93.184.216.35"] },
      routes: {
        "https://a.com/": { status: 302, headers: { location: "https://a.com/2" } },
        "https://a.com/2": { status: 302, headers: { location: "https://b.com/" } },
        "https://b.com/": { chunks: [enc("ok")] },
      },
    });
    const r = await safeFetchCore("https://a.com/", { ...HTML_OPTS, headers: { "X-Api-Key": "k-test" } }, net.deps);
    expect(r.ok).toBe(true);
    expect(net.connects[0].headers["X-Api-Key"]).toBe("k-test");
    expect(net.connects[1].headers["X-Api-Key"]).toBe("k-test");
    expect(net.connects[2].headers["X-Api-Key"]).toBeUndefined();
  });

  it("resposta maior que o limite é abortada no streaming", async () => {
    const big = new Uint8Array(600);
    const net = fakeNet({
      dns: { "a.com": ["93.184.216.34"] },
      routes: { "https://a.com/": { chunks: [big, big, big] } },
    });
    const r = await safeFetchCore("https://a.com/", HTML_OPTS, net.deps);
    expect(r).toMatchObject({ ok: false, code: "TOO_LARGE" });
    expect(net.canceled()).toBeGreaterThan(0);
  });

  it("content-length declarado acima do limite recusa antes de ler", async () => {
    const net = fakeNet({
      dns: { "a.com": ["93.184.216.34"] },
      routes: { "https://a.com/": { headers: { "content-type": "text/html", "content-length": "999999" }, chunks: [] } },
    });
    expect(await safeFetchCore("https://a.com/", HTML_OPTS, net.deps)).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("modo truncate devolve o começo com truncated:true", async () => {
    const net = fakeNet({
      dns: { "a.com": ["93.184.216.34"] },
      routes: { "https://a.com/": { chunks: [new Uint8Array(700).fill(65), new Uint8Array(700).fill(66)] } },
    });
    const r = await safeFetchCore("https://a.com/", { ...HTML_OPTS, onOverflow: "truncate" }, net.deps);
    expect(r).toMatchObject({ ok: true, truncated: true });
    if (r.ok) expect(r.bytes.byteLength).toBe(1000);
  });

  it("content-type fora da allowlist é recusado", async () => {
    for (const ct of ["application/octet-stream", "application/x-msdownload", "", "text/html-evil"]) {
      const net = fakeNet({
        dns: { "a.com": ["93.184.216.34"] },
        routes: { "https://a.com/": { headers: ct ? { "content-type": ct } : {}, chunks: [enc("x")] } },
      });
      expect(await safeFetchCore("https://a.com/", HTML_OPTS, net.deps)).toMatchObject({ ok: false, code: "CONTENT_TYPE" });
    }
  });

  it("HTTP de erro → HTTP_STATUS com o status", async () => {
    const net = fakeNet({ dns: { "a.com": ["93.184.216.34"] }, routes: { "https://a.com/": { status: 404 } } });
    expect(await safeFetchCore("https://a.com/", HTML_OPTS, net.deps)).toMatchObject({
      ok: false,
      code: "HTTP_STATUS",
      status: 404,
    });
  });

  it("corpo que não termina estoura o prazo total", async () => {
    const net = fakeNet({
      dns: { "a.com": ["93.184.216.34"] },
      routes: { "https://a.com/": { chunks: [enc("a")], hang: true } },
    });
    const t0 = Date.now();
    const r = await safeFetchCore("https://a.com/", { ...HTML_OPTS, timeoutMs: 150 }, net.deps);
    expect(r).toMatchObject({ ok: false, code: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("URL inválida/privada nem chega ao resolvedor", async () => {
    let resolved = 0;
    const deps: SafeFetchDeps = {
      resolve: async () => {
        resolved++;
        return [];
      },
      connect: async () => {
        throw new Error("não deveria conectar");
      },
    };
    for (const url of ["http://a.com", "https://127.0.0.1/", "https://2130706433/", "https://u:p@a.com/", "https://x.internal/"]) {
      const r = await safeFetchCore(url, HTML_OPTS, deps);
      expect(r.ok).toBe(false);
    }
    expect(resolved).toBe(0);
  });
});

describe("política de porta (agenda: 443 ou ≥ 1024)", () => {
  it("portAllowed", () => {
    expect(portAllowed(443)).toBe(true);
    expect(portAllowed(8443)).toBe(false);
    expect(portAllowed(8443, { allowedPorts: [8443] })).toBe(true);
    expect(portAllowed(8443, { allowUnprivilegedPorts: true })).toBe(true);
    expect(portAllowed(1024, { allowUnprivilegedPorts: true })).toBe(true);
    expect(portAllowed(1023, { allowUnprivilegedPorts: true })).toBe(false);
    expect(portAllowed(80, { allowUnprivilegedPorts: true })).toBe(false);
    expect(portAllowed(22, { allowUnprivilegedPorts: true })).toBe(false);
    expect(portAllowed(65536, { allowUnprivilegedPorts: true })).toBe(false);
  });

  it("checkUrl e o núcleo seguem a política (redirect também)", async () => {
    expect(checkUrl("https://a.com:3000/", { allowUnprivilegedPorts: true }).ok).toBe(true);
    expect(checkUrl("https://a.com:3000/").ok).toBe(false);
    const net = fakeNet({
      dns: { "a.com": ["93.184.216.34"] },
      routes: {
        "https://a.com:8443/": { status: 302, headers: { location: "https://a.com:25/" } },
      },
    });
    const r = await safeFetchCore("https://a.com:8443/", { ...HTML_OPTS, allowUnprivilegedPorts: true }, net.deps);
    expect(r).toMatchObject({ ok: false, code: "PORT" });
    expect(net.connects).toHaveLength(1);
  });
});
