# LibreTranslate no HNBCRM: guia de instalação e operação

Como subir o motor de tradução self-hosted (LibreTranslate) no VPS e ligá-lo ao backend. É um módulo **opcional**: sem ele a
tradução automática continua funcionando pela cadeia de LLM. Arquivos versionados em `infra/libretranslate/`.
Itens marcados **a confirmar** ainda não foram verificados. Instalação real feita em 06/11/2026: ver a seção 0.

## 0. Instalação em produção (06/11/2026)

| Item | Valor |
|---|---|
| Host | o VPS do bridge (Ubuntu 24.04, 6 vCPU, 12 GB, Docker 29 + Compose v5, sem swap) |
| Pasta | `/opt/hnbcrm/libretranslate` (cópia de `infra/libretranslate/`, `.env` = `env.example` sem mudança) |
| Proxy | Caddy do sistema (`/etc/caddy/Caddyfile`), bloco `handle_path /lt/*` dentro do site do bridge (seção 5) |
| URL | `https://<dominio-do-bridge>/lt` (variante por caminho: não há DNS curinga em `hnbcrm.com` nem token de DNS no VPS) |
| Envs | `LIBRETRANSLATE_URL` e `LIBRETRANSLATE_API_KEY` em DEV e PROD, mesma chave (120 req/min) |
| RAM | container em cerca de 530 MB depois de carregar os 6 idiomas com 2 workers; disponível no VPS caiu de 9,3 GB para 8,8 GB |
| 1ª subida | cerca de 1 minuto: baixou cerca de 1,26 GB de modelos e passou a escutar |
| Latência | `/translate` 0,6 a 1,0 s, `/detect` 0,5 a 1,0 s (pelo HTTPS público, textos curtos) |

O `watchtower` do VPS usa `WATCHTOWER_LABEL_ENABLE=true`; o container `libretranslate` não tem o label, então a tag fixada não é trocada sozinha.
Backup do Caddyfile anterior: `/etc/caddy/Caddyfile.bak-2026-11-06-libretranslate`.


## 1. O que é e como se encaixa

| Peça | Papel |
|---|---|
| Container `libretranslate` (Argos Translate) | traduz e detecta idioma por HTTP, em CPU |
| Proxy reverso (Caddy ou nginx) | TLS e filtro de rotas; o container só escuta em `127.0.0.1:5000` |
| Envs do Convex `LIBRETRANSLATE_URL`, `LIBRETRANSLATE_API_KEY` | endereço e chave que o backend usa |
| Cadeia de provedores | LibreTranslate primeiro, LLM (OpenRouter) como fallback |

Pares sem modelo direto (por exemplo it→de) passam pelo inglês: mais lento e com mais perda. Qualidade em gíria e emoji é
menor que a de um LLM (ver `temp/traducao-automatica/03-pesquisa-motores-traducao.md`, local).

**AGPL-3.0:** só chamamos o serviço por HTTP, sem modificá-lo, e ele não é público. Nessas condições o código do HNBCRM não
vira AGPL. Se alterarmos o LibreTranslate e o oferecermos a usuários, as alterações precisam ser publicadas. Leitura técnica, não parecer jurídico.

## 2. Pré-requisitos

- VPS Ubuntu com Docker e o plugin Compose. O mesmo VPS roda o bridge de WhatsApp (wuzapi) e o Whisper atrás do proxy do
  domínio do bridge (ver `docs/architecture/whatsapp-bridge.md` e `docs/architecture/inbox.md`).
- **RAM:** verifique com `free -m`. Reserve **pelo menos 4 GB livres** além do que o bridge e o Whisper já usam. Se não houver,
  use um segundo VPS pequeno (cerca de 4 GB) só para a tradução. Referências de terceiros: 512 MB cai, cerca de 2 a 4 GB funciona
  com poucos idiomas; não há número oficial. Medido: cerca de 530 MB com 6 idiomas e 2 workers (seção 0); o `mem_limit` de 4 GB sobra.
- Um nome DNS para o serviço (sugestão `lt.hnbcrm.com`) ou um caminho no domínio do bridge.
- Porta 80/443 já tratadas pelo proxy existente; **não** abra a 5000 no firewall.

## 3. Instalação

1. Copie a pasta para o VPS: `scp -r infra/libretranslate <usuario>@<vps>:~/libretranslate`.
2. No VPS: `cd ~/libretranslate && cp env.example .env` (ajuste `LT_LOAD_ONLY`, `LT_THREADS`, `LT_MEM_LIMIT` se precisar).
3. `docker compose up -d`.
4. Acompanhe: `docker compose logs -f`. Na **primeira subida** ele baixa os modelos dos 6 idiomas (`LT_UPDATE_MODELS=true`); no VPS levou cerca de
   1 minuto (cerca de 1,26 GB). Os modelos ficam no volume `libretranslate_models` e não são baixados de novo.
   Depois da primeira subida, pode trocar `LT_UPDATE_MODELS` para `false` no `.env` para acelerar reinícios.
5. `docker compose ps` deve mostrar `healthy` (o `start_period` é de 5 minutos). Atenção: o healthcheck já marca `healthy`
   enquanto os modelos baixam. O sinal real de pronto é `Listening at: http://[::]:5000` no log ou `curl 127.0.0.1:5000/languages` = 200.

Decisões do compose: tag fixada em `v1.9.6` (a `latest` muda sem aviso); `LT_REQ_LIMIT=0` com `LT_API_KEYS=true` faz o serviço
**rejeitar toda requisição sem chave** (doc oficial, tabela de argumentos); `LT_THREADS=2` porque no entrypoint oficial esse valor
é o número de workers do gunicorn e cada worker carrega os modelos (o padrão é 4, o que multiplica a RAM; medido com 2: cerca de 530 MB).

## 4. Criar a chave de API

O banco de chaves fica no volume `libretranslate_api_keys` (`/app/db/api_keys.db`). Dentro do container o comando é `ltmanage`:

```bash
docker compose exec libretranslate ltmanage keys add 120                   # 120 requisições/min
docker compose exec libretranslate ltmanage keys add 120 --char-limit 5000 # com teto de caracteres por requisição
docker compose exec libretranslate ltmanage keys                           # listar
docker compose exec libretranslate ltmanage keys remove <chave>            # revogar
```

Doc: https://docs.libretranslate.com/guides/manage_api_keys/. Como o caminho do banco foi trocado via `LT_API_KEYS_DB_PATH`, se o
`ltmanage` não achar o banco, acrescente `--api-keys-db-path /app/db/api_keys.db`. Verificado: a env basta, `ltmanage keys add 120` gravou no volume e imprime só a chave (UUID).
Use `docker compose exec -T` em scripts, para a saída não vir com `\r`.
Guarde a chave no gerenciador de senhas; ela não vai para o repositório (o `secretScan.test.ts` barra segredos).

## 5. Proxy reverso (TLS e filtro de rotas)

Exponha só `/translate`, `/detect` e `/languages`. Tudo o mais (incluindo `/` e `/metrics`) responde 404.

**Caddy** (subdomínio `lt.hnbcrm.com`):

```caddyfile
lt.hnbcrm.com {
    @allowed path /translate /detect /languages
    handle @allowed {
        reverse_proxy 127.0.0.1:5000
    }
    handle {
        respond 404
    }
}
```

**nginx** (subdomínio; TLS via certbot):

```nginx
server {
    listen 443 ssl;
    server_name lt.hnbcrm.com;
    # ssl_certificate / ssl_certificate_key: gerados pelo certbot

    client_max_body_size 64k;
    location = /translate { proxy_pass http://127.0.0.1:5000; proxy_read_timeout 60s; }
    location = /detect    { proxy_pass http://127.0.0.1:5000; }
    location = /languages { proxy_pass http://127.0.0.1:5000; }
    location / { return 404; }
}
```

Variante por caminho no domínio do bridge: use `location /lt/translate` com `proxy_pass http://127.0.0.1:5000/translate;` (e equivalentes) e
`LIBRETRANSLATE_URL=https://<dominio-do-bridge>/lt`. Prefira o subdomínio quando houver DNS: é mais simples de operar e de isolar.

**Caddy, variante por caminho (a que está em produção).** Bloco aditivo no site do bridge, antes do `reverse_proxy` dele. `handle_path`
tira o prefixo `/lt`; o resto do site segue intacto (conferido: respostas do bridge e do Whisper iguais antes e depois do `systemctl reload caddy`).

```caddyfile
<dominio-do-bridge> {
    handle_path /lt/* {
        request_body {
            max_size 64KB
        }
        @lt_allowed path /translate /detect /languages
        handle @lt_allowed {
            reverse_proxy 127.0.0.1:5000
        }
        handle {
            respond 404
        }
    }
    reverse_proxy 127.0.0.1:8080   # bridge, já existia
}
```

Valide antes de recarregar: `caddy validate --config Caddyfile.new --adapter caddyfile`. O backend monta `${LIBRETRANSLATE_URL}/translate`, então a URL com caminho funciona.

**Lista de IPs (opcional).** O Convex Cloud não publica IPs fixos para saída (**a confirmar**), então não restrinja por IP a menos que
confirme isso; a chave de API é o controle principal. Se tiver certeza dos IPs, no nginx use `allow <ip>; deny all;` dentro dos `location`, ou no Caddy `@allowed` com `remote_ip`.

## 6. Testes de fumaça

Do seu computador (ou do VPS), com a chave em variável de ambiente:

```bash
URL=https://lt.hnbcrm.com KEY='<chave>' infra/libretranslate/probe.sh
```

O script roda `/languages`, `/translate` (pt→es) e `/detect`, imprime a latência de cada chamada e sai com código diferente de zero se
algum falhar. Equivalente manual:

```bash
curl -s https://lt.hnbcrm.com/languages | head -c 300
curl -s -X POST https://lt.hnbcrm.com/translate -H 'Content-Type: application/json' \
  -d '{"q":"Olá, tudo bem?","source":"pt","target":"es","format":"text","api_key":"<chave>"}'
curl -s -X POST https://lt.hnbcrm.com/detect -H 'Content-Type: application/json' \
  -d '{"q":"Hola, quisiera saber el precio.","api_key":"<chave>"}'
```

Sem a chave (ou com chave errada), `/translate` responde **429** `{"error":"Slowdown: 0 per 1 minute"}`, não 403. `/languages` responde 200
sem chave mesmo com `LT_REQ_LIMIT=0` (verificado). Latência medida: 0,5 a 1,0 s por chamada (seção 0).

## 7. Configurar o Convex (DEV e PROD)

Regra do projeto (`CLAUDE.md`, "Deployments: DEV vs PROD"): **sem flag = DEV; PROD só com `--prod`.** Configure o DEV primeiro e valide antes do PROD.

```bash
# DEV (tacit-chicken-195)
npx convex env set LIBRETRANSLATE_URL https://lt.hnbcrm.com
# só https:// é aceito (http:// apenas para localhost/127.0.0.1); outro esquema = "URL do LibreTranslate precisa ser https"
npx convex env set LIBRETRANSLATE_API_KEY '<chave>'

# PROD (careful-anaconda-127): só depois de validar no DEV
npx convex env set --prod LIBRETRANSLATE_URL https://lt.hnbcrm.com
npx convex env set --prod LIBRETRANSLATE_API_KEY '<chave>'
```

Sem barra final na URL. Use chaves separadas para DEV e PROD se quiser revogar uma sem afetar a outra. Depois, em Configurações > Tradução
(quando a tela existir) use "Testar conexão" para confirmar. Para remover: `npx convex env remove LIBRETRANSLATE_URL` (e `--prod` no PROD).
Não imprima a chave em logs de operação.

**Sem a env:** o provedor LibreTranslate fica indisponível e a cadeia usa só o LLM (OpenRouter). Nada quebra e nada precisa ser desligado.
Se a env existir mas o serviço cair, a chamada falha e a cadeia cai no LLM.

## 8. Monitoramento, atualização e rollback

- **Saúde:** `docker compose ps` (healthy), `docker compose logs --tail=100`, `docker stats libretranslate` (memória perto do limite = risco de OOM).
- **Monitor externo:** um check HTTP em `https://lt.hnbcrm.com/languages` (200 sem chave, verificado).
- **Atualizar o software:** edite a tag em `docker-compose.yml` para a nova versão testada, depois `docker compose pull && docker compose up -d`.
  Teste antes com `probe.sh`. Os volumes (modelos e chaves) são preservados.
- **Atualizar modelos:** suba uma vez com `LT_UPDATE_MODELS=true` no `.env` (`docker compose up -d --force-recreate`).
- **Rollback:** volte a tag anterior no compose e `docker compose up -d`. Se o problema for urgente e o serviço estiver instável, basta
  remover a env no Convex: a tradução segue pelo LLM.
- **Backup:** só o volume `libretranslate_api_keys` importa (as chaves); os modelos são rebaixados sozinhos.

## 9. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Container reinicia, `OOMKilled` em `docker inspect` | RAM insuficiente ou workers demais | confirmar 4 GB livres; `LT_THREADS=1`; reduzir `LT_LOAD_ONLY`; ou VPS próprio |
| Primeira requisição muito lenta ou timeout | modelos baixando ou carregando | esperar o `healthy`; ver `docker compose logs` |
| `429` com "Slowdown: 0 per 1 minute" | chave ausente, errada ou revogada (com `LT_REQ_LIMIT=0`) | conferir `api_key` no corpo; `ltmanage keys` para listar |
| `400` com "not supported" | par ou idioma fora de `LT_LOAD_ONLY` | acrescentar o idioma, recriar o container e aguardar o download |
| `429` com outro limite | passou do limite por minuto da chave | criar chave com limite maior (`ltmanage keys add 300`) |
| `502`/`504` no proxy | container fora do ar ou lento | `docker compose ps`; aumentar `proxy_read_timeout` |
| `/languages` ok mas `/translate` 404 | proxy bloqueando a rota | revisar o filtro de rotas da seção 5 |
| Tradução ruim em gíria, emoji ou nomes | limite do motor (Argos) | é esperado; o LLM de fallback trata esses casos quando configurado |
| Chaves sumiram após recriar | volume `libretranslate_api_keys` removido (`down -v`) | nunca use `down -v`; recriar as chaves |

Chave ausente ou errada: 429 reproduzido no VPS (06/11/2026). O 403 da versão upstream não apareceu nesta configuração.
