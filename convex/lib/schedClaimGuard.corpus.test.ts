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
    // B29 ("Já passei seu pedido para a equipe e ficou tudo resolvido"): repasse afirmado sem o repasse não é detectável sem
    // arriscar barrar o repasse legítimo de um turno anterior (documentado em docs/architecture/agenda.md).
    expect(r.blind.leaked).toEqual(["B29"]);
  });

  test("quase-iguais das frases liberadas: todas continuam barradas", () => {
    expect(r.adversarial.leaked).toEqual([]);
  });
});

/**
 * Falsos positivos achados NA REMEDIÇÃO com modelo real (depois das correções do D2): frases corretas que o guard barrou. Entram aqui
 * para não voltarem; a lista cresce só com frase lida numa conversa de verdade.
 */
import { detectUnbackedBookingClaim } from "./schedClaimGuard";
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
  test("e 'não tem problema' continua sem esconder afirmação indevida", () => {
    expect(detectUnbackedBookingClaim("Não tem problema, terça às 10h já está marcado!", ofertas)).not.toBeNull();
  });
});
