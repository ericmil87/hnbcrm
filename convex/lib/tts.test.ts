import { describe, expect, test } from "vitest";
import {
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
  VOICE_REPLY_MAX_CHARS,
  estimateTtsCost,
  getTtsConfig,
  isValidWaveform,
  parsePcmContentType,
  pcmDurationSeconds,
  pcmWaveform,
  planOnboardingVoiceReply,
  planSpokenPart,
  planVoiceReply,
  resolveAttendantVoice,
  toSpeakableText,
  ttsProviderBody,
  voiceDataKinds,
  voiceNoteSeconds,
  waveformToBase64,
  wrapPcmAsWav,
  type VoiceReplyInput,
} from "./tts";
import { bridgeVoiceNoteFields, buildBridgeMediaSendRequest, planBridgeAudioSend } from "./bridgeSend";

const base: VoiceReplyInput = {
  enabled: true,
  transport: "bridge",
  isGroup: false,
  lastInboundWasAudio: true,
  draft: false,
  followUp: false,
  hasImage: false,
  text: "Oi! Tenho horário amanhã de manhã. Quer que eu reserve para você?",
  notice: null,
};

/** PCM s16le mono: `samples` amostras com amplitude que cresce ao longo do tempo. */
function rampPcm(samples: number): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    const amp = Math.round((i / samples) * 20_000);
    view.setInt16(i * 2, i % 2 === 0 ? amp : -amp, true);
  }
  return out;
}

describe("modelo e voz por env", () => {
  test("padrão do dono e env só dentro da lista", () => {
    expect(getTtsConfig("attendant", {})).toEqual({ model: TTS_DEFAULT_MODEL, voice: TTS_DEFAULT_VOICE, rejected: false });
    expect(TTS_DEFAULT_MODEL).toBe("google/gemini-3.8-flash-tts");
    expect(TTS_DEFAULT_VOICE).toBe("Kore");
    expect(getTtsConfig("attendant", { ATTENDANT_TTS_MODEL: "x-ai/grok-voice-tts-1.0", ATTENDANT_TTS_VOICE: "eve" })).toEqual({
      model: TTS_DEFAULT_MODEL,
      voice: TTS_DEFAULT_VOICE,
      rejected: true,
    });
    expect(getTtsConfig("attendant", { ATTENDANT_TTS_VOICE: "Puck" }).voice).toBe("Puck");
    // Superfícies independentes: env do onboarding não mexe no atendente.
    expect(getTtsConfig("attendant", { ONBOARDING_TTS_VOICE: "Puck" }).voice).toBe("Kore");
  });

  test("voz da org vence a env; voz fora do catálogo é ignorada (sem clonagem)", () => {
    expect(resolveAttendantVoice("Leda", { ATTENDANT_TTS_VOICE: "Puck" })).toBe("Leda");
    expect(resolveAttendantVoice("minha-voz-clonada", { ATTENDANT_TTS_VOICE: "Puck" })).toBe("Puck");
    expect(resolveAttendantVoice(undefined, {})).toBe("Kore");
  });

  test("trava de retenção no corpo: data_collection deny; zdr só com strictZdr; sem require_parameters", () => {
    expect(ttsProviderBody(false)).toEqual({ provider: { data_collection: "deny", allow_fallbacks: true } });
    expect(ttsProviderBody(true)).toEqual({ provider: { data_collection: "deny", allow_fallbacks: true, zdr: true } });
  });
});

describe("regras fixas (planVoiceReply)", () => {
  test("cliente mandou áudio → áudio com o texto inteiro", () => {
    const plan = planVoiceReply(base);
    expect(plan.kind).toBe("voice");
    if (plan.kind !== "voice") throw new Error("unreachable");
    expect(plan.textPart).toBeNull();
    expect(plan.spokenText).toBe(base.text);
    expect(plan.speakable).toBe(base.text);
  });

  test("cada regra que manda para texto, na ordem", () => {
    expect(planVoiceReply({ ...base, enabled: false })).toEqual({ kind: "text", reason: "desligado" });
    expect(planVoiceReply({ ...base, transport: "instagram" })).toEqual({ kind: "text", reason: "canal" });
    expect(planVoiceReply({ ...base, transport: null })).toEqual({ kind: "text", reason: "canal" });
    expect(planVoiceReply({ ...base, isGroup: true })).toEqual({ kind: "text", reason: "grupo" });
    expect(planVoiceReply({ ...base, lastInboundWasAudio: false })).toEqual({ kind: "text", reason: "cliente_mandou_texto" });
    expect(planVoiceReply({ ...base, draft: true })).toEqual({ kind: "text", reason: "rascunho" });
    expect(planVoiceReply({ ...base, followUp: true })).toEqual({ kind: "text", reason: "follow_up" });
    expect(planVoiceReply({ ...base, hasImage: true })).toEqual({ kind: "text", reason: "imagem" });
    expect(planVoiceReply({ ...base, language: "en" })).toEqual({ kind: "text", reason: "idioma" });
    expect(planVoiceReply({ ...base, text: "   " })).toEqual({ kind: "text", reason: "vazio" });
    expect(planVoiceReply({ ...base, text: "<tool_call>{\"name\":\"x\"}</tool_call>" })).toEqual({ kind: "text", reason: "marcacao" });
    expect(planVoiceReply({ ...base, text: "a ".repeat(VOICE_REPLY_MAX_CHARS) })).toEqual({ kind: "text", reason: "longo" });
  });

  test("Cloud API (meta) fica no texto até a validação viva; só o bridge fala", () => {
    expect(planVoiceReply({ ...base, transport: "meta" })).toEqual({ kind: "text", reason: "canal" });
    expect(planVoiceReply({ ...base, transport: "bridge" }).kind).toBe("voice");
  });

  test("idioma fora do português → texto", () => {
    expect(planVoiceReply({ ...base, language: "en" })).toEqual({ kind: "text", reason: "idioma" });
    expect(planVoiceReply({ ...base, language: "es-ES" })).toEqual({ kind: "text", reason: "idioma" });
    expect(planVoiceReply({ ...base, language: "pt-BR" }).kind).toBe("voice");
    expect(planVoiceReply({ ...base, language: "pt" }).kind).toBe("voice");
    expect(planVoiceReply({ ...base, language: null }).kind).toBe("voice");
  });

  // Revisão do P4.1: frases reais que vazavam dado para a voz. Nenhum dado pode
  // ser falado: ou tudo vai em texto, ou a fala não tem dígito/símbolo/endereço.
  const LEAKS = [
    "O corte sai por 50 e a barba por 30. Quer agendar?",
    "O total fica 150 no débito",
    "Mensalidade de 99 e matrícula grátis",
    "Total:\n150\nPosso confirmar?",
    "ficamos na Av Paulista 1000",
    "joao arroba gmail ponto com",
    "Nosso Instagram é @lojadamaria",
    "It costs $150 per month",
    "Cuesta 150 pesos al mes",
    // do script da revisão
    "Oi! O corte sai por 50 e a barba por 30. Quer agendar para amanhã?",
    "Claro! O total fica 150 no débito. Posso reservar seu horário?",
    "Perfeito, ficamos na Av Paulista 1000, perto do metrô. Te espero lá às 15h!",
    "Pode mandar para joao arroba gmail ponto com que eu confirmo, tá bom?",
    "Fica cento e cinquenta por mês, parcelado em três vezes. Fechamos?",
    "A chave é o meu CPF mesmo, 123.456.789-00. Assim que cair te aviso, combinado?",
    "Pode transferir para a chave 11987654321 que eu confirmo. Combinado?",
    "Estamos na Rua das Flores. Abrimos às 9h. Quer que eu te mande a localização?",
  ];
  test.each(LEAKS)("nenhum dado falado: %s", (text) => {
    const plan = planVoiceReply({ ...base, text });
    if (plan.kind === "text") {
      expect(plan.reason).toBe("dado_sensivel");
      return;
    }
    const spoken = plan.speakable.replace(/\b\d{1,2}(?::\d{2}|h\d{2}|h)\b/gi, "");
    expect(spoken).not.toMatch(/\d|\$|@|arroba|ponto com|\bav\b|rua|cpf|chave|total|d[ée]bito|mensalidade|por m[eê]s|parcel/i);
    expect(plan.textPart).toBeTruthy();
  });

  test("conversa sem dado continua falada (horários liberados)", () => {
    const plan = planVoiceReply({ ...base, text: "Entendi, vou verificar com a equipe e já te retorno em instantes, tudo bem?" });
    expect(plan.kind).toBe("voice");
    const withTime = planVoiceReply({ ...base, text: "Tenho às 15h, às 10h30 ou às 14:30. Qual fica melhor?" });
    if (withTime.kind !== "voice") throw new Error("esperava voz");
    expect(withTime.textPart).toBeNull();
  });

  test("Pix/link/valor: fala o resto e manda o dado em texto", () => {
    const text = [
      "Perfeito, já separei sua vaga para quinta de manhã.",
      "O Pix é a chave pagamentos@clinica.example.",
      "O link do endereço é https://maps.example.com/abc.",
      "Qualquer dúvida é só me chamar por aqui.",
    ].join("\n");
    const plan = planVoiceReply({ ...base, text });
    expect(plan.kind).toBe("voice");
    if (plan.kind !== "voice") throw new Error("unreachable");
    expect(plan.speakable).not.toMatch(/pix|https|@|link/i);
    expect(plan.speakable).toContain("separei sua vaga");
    expect(plan.speakable).toContain("Qualquer dúvida");
    expect(plan.textPart).toContain("pagamentos@clinica.example");
    expect(plan.textPart).toContain("https://maps.example.com/abc");
  });

  test("resposta que é só dado (ou dado demais) vai inteira em texto", () => {
    expect(planVoiceReply({ ...base, text: "Chave Pix: 12345678900" })).toEqual({ kind: "text", reason: "dado_sensivel" });
    const many = ["Oi, tudo certo por aqui com você hoje?", "R$ 10", "R$ 20", "R$ 30", "R$ 40", "R$ 50"].join("\n");
    expect(planVoiceReply({ ...base, text: many })).toEqual({ kind: "text", reason: "dado_sensivel" });
  });

  test("tipos de dado reconhecidos", () => {
    expect(voiceDataKinds("Faz o Pix")).toContain("pix");
    expect(voiceDataKinds("acesse www.exemplo.com.br")).toContain("link");
    expect(voiceDataKinds("custa R$ 250,00")).toContain("valor");
    expect(voiceDataKinds("são duzentos e cinquenta reais")).toContain("valor");
    expect(voiceDataKinds("Rua das Flores, 100")).toContain("endereco");
    expect(voiceDataKinds("CEP 01310-100")).toContain("endereco");
    expect(voiceDataKinds("seu código é ABC123")).toContain("codigo");
    expect(voiceDataKinds("protocolo 99887")).toContain("codigo");
    expect(voiceDataKinds("me escreve em a@b.co")).toContain("email");
    expect(voiceDataKinds("liga no (11) 98888-7777")).toContain("telefone");
    expect(voiceDataKinds("| plano | preço |")).toContain("tabela");
    expect(voiceDataKinds("ficamos na Av Paulista 1000")).toContain("endereco");
    expect(voiceDataKinds("R. Augusta, perto do metrô")).toContain("endereco");
    expect(voiceDataKinds("joao arroba gmail ponto com")).toEqual(expect.arrayContaining(["email", "link"]));
    expect(voiceDataKinds("Nosso Instagram é @lojadamaria")).toContain("link");
    expect(voiceDataKinds("It costs $150 per month")).toContain("valor");
    // Qualquer dígito fora de horário é dado (data, ano, quantia sem moeda)…
    expect(voiceDataKinds("O corte sai por 50")).toEqual(["numero"]);
    expect(voiceDataKinds("na quinta, 18/10")).toEqual(["numero"]);
    // …e horário continua falável.
    expect(voiceDataKinds("Tenho vaga amanhã às 14h, 10h30 ou 14:30.")).toEqual([]);
  });

  test("aviso de voz sintética vai na frente da fala e no texto do histórico", () => {
    const plan = planVoiceReply({ ...base, notice: "  Esta mensagem usa voz gerada por IA. " });
    if (plan.kind !== "voice") throw new Error("esperava voz");
    expect(plan.noticeIncluded).toBe(true);
    expect(plan.speakable.startsWith("Esta mensagem usa voz gerada por IA.")).toBe(true);
    expect(plan.spokenText.startsWith("Esta mensagem usa voz gerada por IA.\n\n")).toBe(true);
  });
});

describe("texto falável", () => {
  test("tira marcação de WhatsApp, emoji e lista; quebra de linha vira pausa", () => {
    expect(toSpeakableText("*Olá* _tudo_ bem? 😀\n- primeiro\n- segundo")).toBe("Olá tudo bem? primeiro. segundo.");
    expect(toSpeakableText("# Título\n`x`")).toBe("Título. x.");
  });
});

describe("custo", () => {
  test("bate com o custo medido no spike (gemini-3.8-flash-tts, Kore)", () => {
    const cost = estimateTtsCost("google/gemini-3.8-flash-tts", { chars: 447, seconds: 27.84 });
    expect(cost.promptTokens).toBe(112);
    expect(cost.completionTokens).toBe(696);
    expect(cost.costUsd).toBeCloseTo(0.00632, 5);
    expect(cost.estimated).toBe(false);
  });

  test("modelo fora da tabela: preço mais alto + estimado; entradas inválidas = 0", () => {
    const unknown = estimateTtsCost("x/qualquer", { chars: 400, seconds: 20 });
    expect(unknown.estimated).toBe(true);
    expect(unknown.costUsd).toBeGreaterThan(estimateTtsCost(TTS_DEFAULT_MODEL, { chars: 400, seconds: 20 }).costUsd);
    expect(estimateTtsCost(TTS_DEFAULT_MODEL, { chars: Number.NaN, seconds: -1 }).costUsd).toBe(0);
  });
});

describe("PCM, waveform e WAV", () => {
  test("content-type do Gemini; mp3 e estéreo recusados", () => {
    expect(parsePcmContentType("audio/pcm;rate=24000;channels=1")).toEqual({ sampleRate: 24000, channels: 1 });
    expect(parsePcmContentType("audio/pcm")).toEqual({ sampleRate: 24000, channels: 1 });
    expect(parsePcmContentType("audio/mpeg")).toBeNull();
    expect(parsePcmContentType("audio/pcm;rate=24000;channels=2")).toBeNull();
    expect(parsePcmContentType(null)).toBeNull();
  });

  test("duração e segundos inteiros", () => {
    expect(pcmDurationSeconds(48_000)).toBe(1);
    expect(pcmDurationSeconds(1_336_320)).toBeCloseTo(27.84, 2);
    expect(pcmDurationSeconds(0)).toBe(0);
    expect(voiceNoteSeconds(27.84)).toBe(28);
    expect(voiceNoteSeconds(0.2)).toBe(1);
  });

  test("waveform: 64 valores 0–100, normalizada pelo maior pico", () => {
    const wave = pcmWaveform(rampPcm(24_000));
    expect(wave).toHaveLength(64);
    expect(isValidWaveform(wave)).toBe(true);
    expect(Math.max(...wave)).toBe(100);
    expect(wave[0]).toBeLessThan(wave[63]);
    expect(pcmWaveform(new Uint8Array(4_800))).toEqual(new Array(64).fill(0));
    expect(isValidWaveform([1, 2, 3])).toBe(false);
    expect(isValidWaveform(new Array(64).fill(101))).toBe(false);
  });

  test("waveform em base64 = os 64 bytes", () => {
    const wave = new Array(64).fill(0).map((_, i) => i);
    const decoded = atob(waveformToBase64(wave));
    expect(decoded.length).toBe(64);
    expect(decoded.charCodeAt(10)).toBe(10);
  });

  test("cabeçalho WAV (RIFF, PCM 16 bits, mono, 24 kHz)", () => {
    const pcm = rampPcm(100);
    const wav = wrapPcmAsWav(pcm);
    const view = new DataView(wav.buffer);
    const ascii = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n));
    expect(wav.byteLength).toBe(44 + 200);
    expect(ascii(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 200);
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(200);
    expect(wav.subarray(44)).toEqual(pcm);
  });
});

describe("envio de voice note no bridge (campos opcionais)", () => {
  const wave = new Array(64).fill(50);

  test("metadata válida vira PTT/Seconds/Waveform/MimeType; inválida não manda nada", () => {
    expect(bridgeVoiceNoteFields({ seconds: 12, waveform: wave })).toEqual({
      PTT: true,
      MimeType: "audio/ogg; codecs=opus",
      Seconds: 12,
      Waveform: waveformToBase64(wave),
    });
    expect(bridgeVoiceNoteFields({ seconds: 12, waveform: [1, 2] })).toEqual({
      PTT: true,
      MimeType: "audio/ogg; codecs=opus",
      Seconds: 12,
    });
    expect(bridgeVoiceNoteFields({ seconds: 0 })).toBeUndefined();
    expect(bridgeVoiceNoteFields(undefined)).toBeUndefined();
  });

  test("planBridgeAudioSend: áudio humano declara PTT e codec, sem duração; voz da IA ganha os campos medidos", () => {
    expect(planBridgeAudioSend({ fileMimeType: "audio/ogg", fileName: "a.ogg", converted: false })).toEqual({
      kind: "audio",
      sendMime: "audio/ogg",
      useConverted: false,
      voiceFields: { PTT: true, MimeType: "audio/ogg; codecs=opus" },
    });
    const plan = planBridgeAudioSend({
      fileMimeType: "audio/ogg",
      fileName: "resposta-em-audio.ogg",
      converted: false,
      voiceNote: { seconds: 3, waveform: wave },
    });
    expect(plan.voiceFields?.Seconds).toBe(3);
    // Documento (sem conversão) nunca leva campos de voice note.
    expect(
      planBridgeAudioSend({ fileMimeType: "audio/webm", fileName: "a.webm", converted: false, voiceNote: { seconds: 3 } })
        .voiceFields
    ).toBeUndefined();
  });

  test("buildBridgeMediaSendRequest só põe os campos no áudio", () => {
    const fields = bridgeVoiceNoteFields({ seconds: 3, waveform: wave })!;
    const audio = JSON.parse(
      buildBridgeMediaSendRequest({
        baseUrl: "https://bridge.example.com",
        token: "tok",
        toPhone: "5511900000000",
        kind: "audio",
        dataUri: "data:audio/ogg;base64,AAAA",
        voiceFields: fields,
      }).body
    );
    expect(audio).toMatchObject({ PTT: true, Seconds: 3, MimeType: "audio/ogg; codecs=opus", Waveform: fields.Waveform });
    const doc = JSON.parse(
      buildBridgeMediaSendRequest({
        baseUrl: "https://bridge.example.com",
        token: "tok",
        toPhone: "5511900000000",
        kind: "document",
        dataUri: "data:audio/webm;base64,AAAA",
        voiceFields: fields,
      }).body
    );
    expect(doc.PTT).toBeUndefined();
  });
});

describe("chat do onboarding (planOnboardingVoiceReply, P4.2b)", () => {
  const text = "Que bom ouvir você! Montei um funil inicial. Está certo assim?";

  test("só fala quando o usuário mandou áudio; idioma fora do português fica no texto", () => {
    expect(planOnboardingVoiceReply({ userSentAudio: false, text })).toEqual({ kind: "text", reason: "cliente_mandou_texto" });
    expect(planOnboardingVoiceReply({ userSentAudio: true, text, language: "en" })).toEqual({ kind: "text", reason: "idioma" });
    const plan = planOnboardingVoiceReply({ userSentAudio: true, text, language: "pt" });
    expect(plan).toMatchObject({ kind: "voice", speakable: text, textPart: null, noticeIncluded: false });
  });

  test("mesma regra de dado do atendente: a fala perde Pix/valor; resposta só de dado não é falada", () => {
    const plan = planOnboardingVoiceReply({
      userSentAudio: true,
      text: "Perfeito, anotei tudo. Você aceita Pix e a consulta custa R$ 150. Quer ajustar o funil?",
    });
    expect(plan.kind).toBe("voice");
    if (plan.kind !== "voice") return;
    expect(plan.speakable).not.toMatch(/pix|150|R\$/i);
    expect(plan.textPart).toContain("R$ 150");
    expect(planOnboardingVoiceReply({ userSentAudio: true, text: "A consulta custa R$ 150." })).toEqual({
      kind: "text",
      reason: "dado_sensivel",
    });
    expect(planOnboardingVoiceReply({ userSentAudio: true, text: "a ".repeat(VOICE_REPLY_MAX_CHARS) })).toEqual({
      kind: "text",
      reason: "longo",
    });
  });

  test("planVoiceReply e o onboarding compartilham planSpokenPart (uma implementação)", () => {
    expect(planVoiceReply(base)).toEqual(planSpokenPart(base.text, null));
  });
});
