#!/usr/bin/env node
// Guarda "no-loss": todo identificador (code span ou título em negrito) do CLAUDE.md
// de baseline precisa continuar existindo em algum arquivo do corpus de documentação.
//   node scripts/claude/check-no-loss.mjs                     verifica (exit 1 se faltar algo)
//   node scripts/claude/check-no-loss.mjs --generate-baseline regera o JSON a partir do git
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const BASELINE_PATH = join(here, "no-loss-baseline.json");
const BASELINE_COMMIT = "1f51a2f";

// Code spans seguem o CommonMark: um run de N backticks abre e só um run de exatamente N fecha.
// (Um regex ingênuo /`([^`]+)`/ desalinha o resto da linha quando aparece uma cerca ```json inline.)
export function extractCodeSpans(text) {
  const spans = [];
  const re = /`+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = m[0];
    const start = re.lastIndex;
    const closeRe = new RegExp("`{" + open.length + "}(?!`)", "g");
    closeRe.lastIndex = start;
    let c;
    let found = null;
    while ((c = closeRe.exec(text)) !== null) {
      // o run de fechamento precisa ter EXATAMENTE N backticks (não ser prefixo de um run maior)
      if (c.index === 0 || text[c.index - 1] !== "`") { found = c; break; }
    }
    if (!found) continue; // run sem fechamento: literal, segue
    const inner = text.slice(start, found.index);
    if (!inner.includes("\n")) spans.push(inner);
    re.lastIndex = found.index + open.length;
  }
  return spans;
}

export function extractIdentifiers(text) {
  const found = new Set();
  const norm = (s) => s.normalize("NFC").trim();
  for (const raw of extractCodeSpans(text)) {
    const s = norm(raw);
    if (s.length < 3) continue;
    if (/^[\p{P}\p{S}\d\s]+$/u.test(s)) continue; // só pontuação/números
    found.add(s);
  }
  for (const m of text.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
    const s = norm(m[1]);
    if (s.length >= 3) found.add(s);
  }
  return [...found];
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

export function loadCorpus(rootDir = root) {
  const files = ["CLAUDE.md", "convex/CLAUDE.md", "src/CLAUDE.md"].map((f) => join(rootDir, f));
  for (const d of ["docs/architecture", ".claude/rules", ".claude/skills"]) walk(join(rootDir, d), files);
  const agents = join(rootDir, ".claude/agents");
  if (existsSync(agents)) {
    for (const n of readdirSync(agents)) if (n.endsWith(".md")) files.push(join(agents, n));
  }
  return files.filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
}

// Um identificador conta como presente se aparece no corpus como code span / negrito (conjunto exato),
// ou, para quem foi citado em tabela sem backtick, como palavra inteira (fronteira [\w.-]).
// Substring pura não vale: "run", "env", "convex/" casariam qualquer coisa.
export function findMissing(identifiers, corpus, allowlist = []) {
  const allow = new Set(allowlist);
  const text = corpus.normalize("NFC");
  const exact = new Set(extractIdentifiers(text));
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return identifiers.filter((id) => {
    if (allow.has(id) || exact.has(id)) return false;
    return !new RegExp("(?<![\\w.-])" + escape(id) + "(?![\\w.-])").test(text);
  });
}

function main() {
  if (process.argv.includes("--generate-baseline")) {
    const text = execFileSync("git", ["show", `${BASELINE_COMMIT}:CLAUDE.md`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const identifiers = extractIdentifiers(text);
    writeFileSync(BASELINE_PATH, JSON.stringify({ source: `CLAUDE.md @ ${BASELINE_COMMIT}`, generatedAt: new Date().toISOString(), identifiers, allowlist: [] }, null, 2) + "\n");
    console.log(`Baseline gerado: ${identifiers.length} identificadores.`);
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const missing = findMissing(baseline.identifiers, loadCorpus(), baseline.allowlist);
  if (missing.length) {
    console.error(`${missing.length} identificador(es) do ${baseline.source} sumiram do corpus:`);
    for (const m of missing) console.error(`  - ${m}`);
    console.error(`Restaure o trecho na documentação ou, se a remoção for intencional, adicione o identificador a "allowlist" em ${BASELINE_PATH}.`);
    process.exit(1);
  }
  console.log(`OK: ${baseline.identifiers.length} identificadores presentes no corpus.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
