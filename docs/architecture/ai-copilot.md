# Copiloto in-app

> Histórico técnico movido **verbatim** do `CLAUDE.md` da raiz em 22/10/2026 (snapshot do commit 1f51a2f). Ordem = ordem de versão. Pegadinhas que mudam a forma de codar foram destiladas em `.claude/rules/`; este arquivo é a fonte completa, para ler quando se mexe nesta área.

## Estado atual

Chat SSE (`convex/copilotHttp.ts`, `convex/copilot.ts`), age como o usuário, `pendingActions`; renderer de Markdown próprio (v0.54). O runtime compartilhado está em `ai-core.md`.

## Decisões, pegadinhas medidas e histórico

### Markdown na saída do Copiloto (v0.54)

**Markdown na saída do Copiloto (v0.54):** o chat do copiloto imprimia `content` como texto cru (`whitespace-pre-wrap`), então `**negrito**`, tabela GFM e lista chegavam à tela com os asteriscos e os pipes — a resposta mais útil (a tabela de leads sem responsável) era justamente a mais ilegível. Renderer próprio, sem dependência nova (remark+gfm custaria mais em bundle que o recurso inteiro): `src/lib/markdown.ts` faz o parse para uma AST tipada e `src/components/ui/Markdown.tsx` monta elementos React a partir dela — **nunca HTML cru**, então tag vinda do LLM aparece como texto e `href` fora de `http/https/mailto/tel/relativo` é descartado. Cobre título, negrito/itálico/riscado, código inline e em cerca (com botão de copiar), lista (aninhada, ordenada com `start`), tabela GFM (rola na horizontal em vez de espremer o painel), citação, regra horizontal e link (inclusive URL solta). Dois desvios DELIBERADOS do CommonMark, porque a saída é chat: quebra de linha simples vira `<br>`, e `_` só delimita itálico em fronteira de palavra (senão `lead_id_final` viraria itálico). Tolerante a texto incompleto — em streaming a cerca ainda não fechou e a tabela pode ter só o cabeçalho. UI do `CopilotPanel`: a resposta da IA passou a ocupar a largura toda (a bolha de 85% espremia tabela e código), o painel abre mais largo em tela grande (`lg:600px`/`xl:680px`), cada resposta tem "copiar" no hover e o streaming mostra cursor. `buildSystemPrompt` (`convex/copilotHttp.ts`) ganhou a seção FORMATO: tabela só com até 4 colunas e células curtas, sem título de nível 1/2. Rascunho do Atendente segue texto puro — é mensagem de WhatsApp, não tem onde renderizar. Testes: `src/lib/markdown.test.ts` (o vitest passou a incluir `src/**/*.test.ts`).

