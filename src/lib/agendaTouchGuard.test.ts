// @vitest-environment node
/**
 * Guardas de toque e layout da Agenda v2 que o jsdom não mede (achados do teste visual no celular, 390 px).
 * Leem o código-fonte: se alguma falhar, leia a mensagem antes de mexer.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...tsxFiles(rel));
    else if (rel.endsWith(".tsx") && !rel.endsWith(".test.tsx")) out.push(rel);
  }
  return out;
}

describe("Agenda v2: alvos de toque e layout no celular", () => {
  it("fileira de botões que empilha no celular (flex-col-reverse) não usa `flex-1` puro", () => {
    // Em coluna, `flex-1` zera a base e vence a altura do botão: o "Marcar horário" da revisão ficou com 24 px.
    // Use `sm:flex-1` (só vale lado a lado).
    const bad: string[] = [];
    for (const file of [...tsxFiles("src/components/agenda"), ...tsxFiles("src/components/settings/agenda")]) {
      const src = read(file);
      let from = 0;
      for (;;) {
        const at = src.indexOf("flex-col-reverse", from);
        if (at < 0) break;
        const end = src.indexOf("</div>", at);
        const row = src.slice(at, end < 0 ? undefined : end);
        if (/className="(?:[^"]* )?flex-1(?: [^"]*)?"/.test(row)) bad.push(`${file}: ${row.slice(0, 60).replace(/\s+/g, " ")}`);
        from = at + 1;
      }
    }
    expect(bad).toEqual([]);
  });

  it("a seta Voltar do painel lateral tem 44 px no toque", () => {
    const src = read("src/components/ui/SlideOver.tsx");
    const back = src.slice(src.indexOf("Mobile: back arrow"), src.indexOf('aria-label="Voltar"'));
    expect(back).toContain("coarse:min-h-11");
    expect(back).toContain("coarse:min-w-11");
  });

  it("a faixa de detalhes da conversa quebra linha no celular (o chip Próximo não fica cortado)", () => {
    const src = read("src/components/inbox/ConversationHeader.tsx");
    const at = src.indexOf('aria-label="Detalhes da conversa"');
    const strip = src.slice(src.lastIndexOf("<div", at), at);
    expect(strip).toContain("flex-wrap");
    expect(strip).toContain("md:flex-nowrap");
  });

  it("campos de hora do horário de funcionamento cabem '09:00 AM' (navegador em formato de 12 h)", () => {
    const src = read("src/components/agenda/WeeklyHoursEditor.tsx");
    expect(src).not.toMatch(/type="time"[\s\S]{0,400}?w-28/);
    expect(src.match(/min-h-11 w-32 rounded-field/g)).toHaveLength(2);
  });

  it("a visão Semana embute a agenda antiga sem o seletor Dia/Semana/Mês dela", () => {
    expect(read("src/components/agenda/views/AgendaPageView.tsx")).toContain("<CalendarPage embedded />");
    const page = read("src/components/calendar/CalendarPage.tsx");
    expect(page).toContain("showViewToggle={!embedded}");
    expect(page).toContain('forcedView: "week"');
  });

  it("o painel de Pendências tem margem lateral", () => {
    expect(read("src/components/agenda/views/PendingQueuePanel.tsx")).toMatch(/<SlideOver[^>]*bodyClassName="[^"]*\bp-4\b/);
  });

  it("rótulos da agenda não dependem da localidade do navegador (só os formatadores do projeto)", () => {
    const bad: string[] = [];
    const files = [...tsxFiles("src/components/agenda"), ...tsxFiles("src/components/settings/agenda")];
    for (const name of readdirSync(join(root, "src/lib"))) {
      if (/^(agenda|booking|appointment).*\.ts$/.test(name) && !name.endsWith(".test.ts")) files.push(`src/lib/${name}`);
    }
    for (const file of files) {
      const src = read(file);
      // `toLocale*()` sem localidade ou `Intl.*Format()` sem localidade seguem o navegador (ex.: "09:00 AM").
      if (/\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined|\[\])/.test(src) || /Intl\.(?:DateTimeFormat|NumberFormat)\(\s*(?:\)|undefined)/.test(src) || /navigator\.language/.test(src)) bad.push(file);
    }
    expect(bad).toEqual([]);
  });
});
