# LibreTranslate (tradução automática do HNBCRM)

Container opcional que traduz mensagens dentro do nosso próprio VPS, sem enviar texto a terceiros. É o primeiro motor
da cadeia de tradução; se ele não estiver configurado ou falhar, o HNBCRM cai no fallback por LLM (OpenRouter).

- **Como o Convex chega nele:** HTTPS, pelas envs do Convex `LIBRETRANSLATE_URL` e (opcional) `LIBRETRANSLATE_API_KEY`.
  O container escuta só em `127.0.0.1:5000`; um proxy reverso (Caddy ou nginx) termina o TLS e expõe apenas
  `/translate`, `/detect` e `/languages`.
- **Idiomas carregados:** pt, es, en, fr, it, de (`LT_LOAD_ONLY`). Pares sem modelo direto passam pelo inglês.
- **RAM:** reserve cerca de 4 GB livres (limite do container em `mem_limit`). Medir no VPS antes de ligar.
- **Segurança:** chave de API obrigatória (`LT_API_KEYS=true` e `LT_REQ_LIMIT=0`), interface web e tradução de arquivos desligadas.
- **AGPL-3.0:** só chamamos o LibreTranslate por HTTP, sem alterar o código e sem expor o serviço ao público.
  Se um dia for preciso modificá-lo, publicar as alterações. Leitura técnica, não parecer jurídico.

Arquivos: `docker-compose.yml`, `env.example` (copiar para `.env`), `probe.sh` (teste de fumaça com latência).
Passo a passo completo: `docs/LIBRETRANSLATE-SETUP.md`.
