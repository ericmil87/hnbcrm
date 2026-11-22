# agenda-sim: medir a IA na Agenda v2 com modelo real (só DEV)

Harness que conversa com o Atendente IA pelo pipeline real (entrada `conversations.internalReceiveMessage`, fila, prompt, tools, guard e commit reais) em orgs de cenário (`sim-agenda-*`, `demoMode`: nada sai pelo WhatsApp) e verifica o resultado pelo banco.

Backend: `convex/simAgenda.ts` (escreve: semear org, cliente fictício, turno, trocar modo, desligar IA) e `convex/simAgendaRead.ts` (lê: estado da conversa, dump da org, custo). Tudo `internal*`, recusa org que não seja de cenário.

Uso (de um checkout cujo `.env.local` aponta para o DEV; nunca `--prod`):

1. `npx convex dev --once` (envia as funções).
2. `python3 scripts/agenda-sim/gen_orgs.py && python3 scripts/agenda-sim/seed.py -a` semeia 5 orgs (clínica com sala dupla, barbearia, consultório, advogado solo, pilates em turma; sufixo opcional como 1º argumento).
3. `python3 scripts/agenda-sim/run.py --tag meulote --suffix=-a --budget 1.0 --par 8` (`--sit A,B`, `--ids`, `--orgs`, `--maxrep N`, `--model` só rotula; troque o modelo da org com `simAgenda:internalSimSetModel`).
4. `python3 scripts/agenda-sim/aggregate.py meulote`, `analyze_E.py meulote` (modo inteligente), `show.py transcricoes/meulote/<arquivo>.json`, `free.py` (cliente simulado por LLM).
5. Ao terminar, desligue a IA: `simAgenda:internalSimSetAiEnabled` com `enabled:false` em cada org de `simAgendaRead:internalSimListOrgs`.

Saída em `temp/agenda-sim/` (gitignored; `AGENDA_SIM_OUT` muda). Custo medido: ~US$ 0,0012 por conversa com `deepseek-flash-latest`. Controle de gasto: cada org nasce com `spendCap` em `block` (US$ 0,50) e o runner para em `--budget`; confira a chave do OpenRouter (`https://openrouter.ai/api/v1/key`) sem imprimi-la.

Limites conhecidos: a IA "marca sozinha" exige o aceite do dono (conta autenticada); o harness grava o aceite do dono fictício direto. O guard anti-robô fica desligado nas orgs de cenário (cliente roteirizado responde rápido demais). Áudio, imagem, modo "sugerir" e a aprovação humana não são exercitados. Datas são relativas a "hoje" no momento da semeadura: rode o lote no mesmo dia.
