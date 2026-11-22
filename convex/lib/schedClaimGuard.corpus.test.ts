import { describe, expect, test } from "vitest";
import { evaluateCorpus } from "./schedClaimGuard.corpus.test-helper";

/**
 * Medição do guard de agenda (D2). ANTES (guard do D1, commit 7034a51c, mesma medição):
 *  - eventos reais: das 19 indevidas, 19 barradas (nenhuma passa); das 62 corretas, 56 barradas (6 reconstruções nem disparavam o
 *    guard antigo) = 100% das corretas reproduzidas barradas;
 *  - cego (40 indevidas + 40 legítimas): 6 indevidas passavam (5 do profissional, que o guard antigo nem olhava, e "Já passei seu
 *    pedido para a equipe e ficou tudo resolvido") e 9 legítimas eram barradas (22,5%);
 *  - 22 quase-iguais (adversarial): 22 barradas.
 * DEPOIS: veja as asserções abaixo.
 */
describe("schedClaimGuard — corpus rotulado (eventos reais + cego + quase-iguais)", () => {
  const r = evaluateCorpus();

  test("eventos reais: nenhuma indevida passa e nenhuma correta é barrada", () => {
    expect(r.events.leaked).toEqual([]);
    expect(r.events.falsePositives).toEqual([]);
    expect(r.events.acertoBlocked).toBe(r.events.acerto);
  });

  test("cego: nenhuma legítima barrada e só uma indevida (conhecida) passa", () => {
    expect(r.blind.falsePositives).toEqual([]);
    // B29 ("Já passei seu pedido para a equipe e ficou tudo resolvido") passou a ser barrado: sem repasse no turno nem pendente na conversa
    // (`ClaimState.handoff` já considera o repasse pendente lido do contexto), "passei para a equipe" é ação que não aconteceu.
    expect(r.blind.leaked).toEqual([]);
  });

  test("revisão adversarial do PR #200: as 13 afirmações falsas que passavam são barradas", () => {
    expect(r.review.leaked).toEqual([]);
  });

  test("2ª revisão adversarial do PR #200: afirmações falsas (marcador sem substantivo, pergunta-eco, oração, mudança em 1ª pessoa, gíria) são barradas e as vizinhas legítimas passam", () => {
    expect(r.review2.leaked).toEqual([]);
    expect(r.review2.falsePositives).toEqual([]);
  });

  test("quase-iguais das frases liberadas: todas continuam barradas", () => {
    expect(r.adversarial.leaked).toEqual([]);
  });
});

/**
 * Falsos positivos achados NA REMEDIÇÃO com modelo real (depois das correções do D2): frases corretas que o guard barrou. Entram aqui
 * para não voltarem; a lista cresce só com frase lida numa conversa de verdade.
 */
import { buildAliasIndex, detectUnbackedBookingClaim } from "./schedClaimGuard";
import { buildState } from "./schedClaimGuard.corpus.test-helper";

describe("schedClaimGuard — falsos positivos da remedição com modelo real", () => {
  const nada = buildState({});
  const ofertas = buildState({ offered: ["2026-11-24 10:00", "2026-11-24 14:00"] });
  test.each<[string, ReturnType<typeof buildState>]>([
    ["Amanhã (segunda, 23/11) às 9h não tem horário com o Dr. Marcos, ele está de folga.", ofertas],
    ["Na terça, 24/11, às 9h não tem vaga, mas tenho às 10h.", ofertas],
    ["Às 16h não tem mais horário nesse dia.", nada],
  ])("passa: %s", (text, state) => {
    expect(detectUnbackedBookingClaim(text, state)).toBeNull();
  });
  test("profissional citado só para dizer que NÃO atende (folga) não é promessa; misturado com outro horário dele, é", () => {
    const st = buildState({ offered: ["2026-11-24 13:00", "2026-11-24 14:00"] });
    expect(detectUnbackedBookingClaim("Nesse dia à tarde tenho 13h e 14h com outros barbeiros, já que o Tato está de folga.", st)).toBeNull();
    expect(detectUnbackedBookingClaim("Com o Léo não tenho horário na terça, mas tenho 13h e 14h com outro barbeiro.", st)).toBeNull();
    expect(detectUnbackedBookingClaim("Tenho 13h com outro barbeiro, e 14h com o Tato.", st)?.kind).toBe("resource_not_offered");
    expect(detectUnbackedBookingClaim("O Tato está de folga, mas tenho 14h com o Léo.", st)?.kind).toBe("resource_not_offered");
  });
  test("e 'não tem problema' continua sem esconder afirmação indevida", () => {
    expect(detectUnbackedBookingClaim("Não tem problema, terça às 10h já está marcado!", ofertas)).not.toBeNull();
  });
  test("2ª rodada da remedição: frases corretas que o guard barrou com o D2 já no ar", () => {
    const terapeutas = ["Terapeuta Ana", "Terapeuta Bruno", "Terapeuta Carla", "Terapeuta Davi"];
    // "Terapeuta" serve a todas: o apelido do recurso é a palavra SÓ dele ("carla"), nunca o papel
    const carla = buildState({ names: terapeutas, booked: [["2026-11-23 09:00", "pending"]], offeredNamed: ["2026-11-23 09:00|Terapeuta Carla"] });
    expect(detectUnbackedBookingClaim("Pedido registrado para segunda-feira, 23/11, às 09:00 com Terapeuta Carla, aguardando confirmação da equipe.", carla)).toBeNull();
    expect(detectUnbackedBookingClaim("Pedido registrado para segunda, 23/11, às 09:00 com a Carla, aguardando a equipe.", carla)).toBeNull();
    expect(detectUnbackedBookingClaim("Pedido registrado para segunda, 23/11, às 09:00 com a Ana, aguardando a equipe.", carla)?.kind).toBe("resource_not_offered");
    expect(detectUnbackedBookingClaim("Pedido registrado para segunda, 23/11, às 09:00 com o Terapeuta Davi, aguardando a equipe.", carla)?.kind).toBe("resource_not_offered");
    const grupo = buildState({ offered: ["2026-11-23 14:00", "2026-11-23 16:00"] });
    // "para as duas" = para as duas PESSOAS, não 02:00
    expect(detectUnbackedBookingClaim("Para amanhã à tarde, segunda 23/11, tenho estes horários para as duas sessões juntas: 14h e 16h.", grupo)).toBeNull();
    expect(detectUnbackedBookingClaim("Na segunda, 23/11, tenho horários com vaga para as duas: 14h e 16h.", grupo)).toBeNull();
    expect(detectUnbackedBookingClaim("Aí eu já vejo os horários da tarde para as duas juntas.", grupo)).toBeNull();
    expect(detectUnbackedBookingClaim("Tenho 15h e às duas da tarde também.", grupo)).not.toBeNull(); // 14h/15h: 15h não ofertada continua barrada
    const pend = buildState({ existing: [["2026-11-23 18:00", "pending"]] });
    expect(detectUnbackedBookingClaim("Pode vir com roupa confortável e meias antiderrapantes.", pend)).toBeNull();
    expect(detectUnbackedBookingClaim("✅ roupa confortável", pend)).toBeNull();
    expect(detectUnbackedBookingClaim("Pode vir segunda às 18h, está tudo certo!", pend)).not.toBeNull();
    const handoff = buildState({ handoff: true, existing: [["2026-11-23 15:00", "pending"]] });
    expect(detectUnbackedBookingClaim("Eles verificam se terça-feira (24/11) às 14h está disponível e te confirmam por aqui.", handoff)).toBeNull();
    expect(detectUnbackedBookingClaim("Eles verificam e ajustam seu horário para terça (24/11) às 13h30 e te avisam por aqui.", handoff)).toBeNull();
    expect(detectUnbackedBookingClaim("E sobre o horário, você já viu as opções que passei pra quarta-feira, 25/11, à tarde?", buildState({}))).toBeNull();
    expect(detectUnbackedBookingClaim("Para remarcar uma consulta que já está marcada, quem cuida disso é a nossa equipe.", buildState({}))).toBeNull();
    expect(detectUnbackedBookingClaim("Nosso atendimento é só à tarde, das 14h às 18h, de segunda a sexta — às 9h não temos.", buildState({}))).toBeNull();
  });
  test("3ª rodada da remedição: palavra de serviço não é apelido de recurso; repasse criado + 'registrado' sem horário", () => {
    const pil = buildState({ names: ["Sala de pilates"], services: ["Aula de pilates"], offered: ["2026-11-30 18:00"] });
    expect(detectUnbackedBookingClaim("Só confirmando: segunda-feira, 30/11, às 18h, na aula de pilates em grupo. Posso registrar?", pil)).toBeNull();
    expect(detectUnbackedBookingClaim("Tenho segunda, 30/11, às 18h na Sala de pilates.", pil)?.kind).toBe("resource_not_offered");
    const sem = buildState({ offered: ["2026-11-27 13:00"] });
    const com = buildState({ offered: ["2026-11-27 13:00"], handoff: true });
    expect(detectUnbackedBookingClaim("Já deixei seu pedido registrado e eles te respondem por aqui.", com)).toBeNull();
    expect(detectUnbackedBookingClaim("Já deixei seu pedido registrado e eles te respondem por aqui.", sem)).not.toBeNull();
    expect(detectUnbackedBookingClaim("Marcado! Eles te respondem por aqui.", com)).not.toBeNull();
    expect(detectUnbackedBookingClaim("Registrei o pedido para sexta às 13h, eles te respondem por aqui.", sem)).not.toBeNull();
  });
  test("4ª rodada da remedição: indisponibilidade dita de outro jeito ('12h30 não tem', 'não tem disponível') passa; 'não tem problema' não esconde afirmação", () => {
    const st = buildState({ offered: ["2026-11-24 11:00", "2026-11-24 14:00"] });
    expect(detectUnbackedBookingClaim("Aqui as sessões vão até as 12h, então 12h30 não tem", st)).toBeNull();
    expect(detectUnbackedBookingClaim("No dia 24/11 (terça) o horário das 12h30 não tem disponível — nesse período a clínica fecha para o almoço.", st)).toBeNull();
    expect(detectUnbackedBookingClaim("Terça às 15h não tem esse horário livre, mas tenho 14h.", st)).toBeNull();
    expect(detectUnbackedBookingClaim("Não tem problema, terça às 11h já está marcado!", st)).not.toBeNull();
    expect(detectUnbackedBookingClaim("Não tem erro: quinta às 16h está garantido.", st)).not.toBeNull();
    // "um horário que já estava agendado": oração relativa que descreve o pedido do cliente
    expect(detectUnbackedBookingClaim("Thiago, como é uma remarcação de um horário que já estava agendado, a equipe cuida disso e te responde.", buildState({}))).toBeNull();
    expect(detectUnbackedBookingClaim("Pronto, o horário está agendado, te espero terça às 10h.", st)).not.toBeNull();
  });
  test("2ª revisão: nome curto de várias palavras ('Dr. Marcos Silva' × cadastro 'Dr. Marcos Silva Junior') liga a oferta ao recurso", () => {
    const names = ["Dr. Marcos Silva Junior", "Dra. Helena Souza"];
    const idx = buildAliasIndex(names);
    expect(idx.find((x) => x.key === "dr marcos silva junior")!.aliases).toContain("marcos silva");
    const st = buildState({ names, offeredNamed: ["2026-11-24 10:00|Marcos Silva"] });
    expect(detectUnbackedBookingClaim("Tenho terça às 10h com o Dr. Marcos Silva Junior. Qual prefere?", st)).toBeNull();
    expect(detectUnbackedBookingClaim("Tenho terça às 10h com o Marcos. Posso registrar?", st)).toBeNull();
    // a oferta nomeou o Marcos: ligar o mesmo horário à Helena continua barrado
    expect(detectUnbackedBookingClaim("Tenho terça às 10h com a Helena. Qual prefere?", st)?.kind).toBe("resource_not_offered");
    // dois recursos com o mesmo par de palavras: o par não vira apelido de nenhum
    const dup = buildAliasIndex(["Ana Maria Silva", "Ana Maria Souza"]);
    expect(dup[0].aliases).not.toContain("ana maria");
    expect(dup[0].aliases).toContain("silva");
  });
  test("apelido de recurso: palavra comum de nome ('Maca Nova', 'Box Principal', 'Profissional 2', 'Terapeuta Carla') nunca vira apelido", () => {
    const idx = buildAliasIndex(["Maca Nova", "Box Principal", "Profissional 2", "Terapeuta Carla", "Dra. Helena"]);
    const al = (k: string) => idx.find((x) => x.key === k)!.aliases;
    expect(al("maca nova")).toEqual(["maca nova"]);
    expect(al("box principal")).toEqual(["box principal"]);
    expect(al("profissional 2")).toEqual(["profissional 2"]);
    expect(al("terapeuta carla")).toEqual(["terapeuta carla", "carla"]);
    expect(al("dra helena")).toEqual(["dra helena", "helena"]);
    const st = buildState({ names: ["Maca Nova", "Profissional 2"], offered: ["2026-11-24 14:00"] });
    expect(detectUnbackedBookingClaim("Tenho terça às 14h, com o profissional que estiver livre.", st)).toBeNull();
  });
});

describe("schedClaimGuard — pedido decidido pela equipe (recusado, vencido, cancelado): D3", () => {
  const withDecided = (kind: "declined" | "expired" | "cancelled", at: string, base: Parameters<typeof buildState>[0] = {}) => {
    const [d, hhmm] = at.split(" ");
    return { ...buildState(base), decided: [{ localDate: d, timeMin: Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)), kind }] };
  };
  const declined = withDecided("declined", "2026-11-25 14:00");
  test.each([
    "Infelizmente a equipe não conseguiu confirmar o pedido de quarta às 14h. Quer que eu consulte outros horários?",
    "Seu pedido de quarta às 14h foi recusado pela equipe, desculpe. Posso consultar outros horários?",
    "Peço desculpas, o pedido de quarta, 25/11, às 14h foi cancelado. Quer ver outros horários?",
    "Não foi possível confirmar a quarta às 14h, desculpa! Quer que eu veja outros horários?",
    "O pedido de quarta às 14h não foi aprovado. Posso consultar de novo?",
  ])("dizer a verdade sobre o horário recusado passa: %s", (text) => {
    expect(detectUnbackedBookingClaim(text, declined)).toBeNull();
  });
  test.each([
    "Seu horário de quarta às 14h está confirmado!",
    "Pronto, marcado para quarta às 14h!",
    "Tudo certo para quarta às 14h, te espero!",
    "Cancelei seu pedido de quarta às 14h.", // 1ª pessoa: a IA não cancela
  ])("dizer que o horário recusado está marcado (ou que a IA cancelou) barra: %s", (text) => {
    expect(detectUnbackedBookingClaim(text, declined)).not.toBeNull();
  });
  test("vencido e cancelado: mesma regra", () => {
    const exp = withDecided("expired", "2026-11-24 10:00");
    expect(detectUnbackedBookingClaim("O pedido de terça às 10h venceu sem resposta da equipe. Posso consultar os horários de novo?", exp)).toBeNull();
    expect(detectUnbackedBookingClaim("Seu horário de terça às 10h está garantido!", exp)).not.toBeNull();
    const canc = withDecided("cancelled", "2026-11-24 10:00");
    expect(detectUnbackedBookingClaim("O horário de terça às 10h foi cancelado, quer outro?", canc)).toBeNull();
  });
  test("sem o estado decidido o horário continua desconhecido (a regra antiga: 'cancelado' com horário barra)", () => {
    expect(detectUnbackedBookingClaim("Peço desculpas, o pedido de quarta, 25/11, às 14h foi cancelado. Quer ver outros horários?", buildState({}))?.kind).toBe("reschedule_claim");
  });
  test("o horário do PRÓPRIO cliente com lastro passa ('seu horário é quinta às 10h')", () => {
    const sch = buildState({ existing: [["2026-11-26 10:00", "scheduled"]] });
    expect(detectUnbackedBookingClaim("Seu horário é quinta às 10h.", sch)).toBeNull();
    expect(detectUnbackedBookingClaim("Seu horário está marcado para quinta às 10h. Pode vir!", sch)).toBeNull();
    expect(detectUnbackedBookingClaim("Seu horário é quinta às 11h.", sch)).not.toBeNull();
  });
});
