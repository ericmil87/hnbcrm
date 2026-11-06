#!/usr/bin/env bash
# Teste de fumaça do LibreTranslate: /languages, /translate (pt->es) e /detect, com latência por chamada.
# Uso: URL=https://lt.exemplo.com KEY=<chave> ./probe.sh     (KEY vem do ambiente; não grave a chave em arquivo versionado)
set -u
: "${URL:?defina URL (ex.: https://lt.exemplo.com)}"
: "${KEY:?defina KEY (chave criada com ltmanage keys add)}"
URL="${URL%/}"
fail=0

call() { # nome, método, caminho, corpo-json, status-esperado
  local name="$1" method="$2" path="$3" body="$4" out code time
  out=$(mktemp)
  if [ -n "$body" ]; then
    read -r code time < <(curl -sS -m 60 -o "$out" -w '%{http_code} %{time_total}\n' -X "$method" \
      -H 'Content-Type: application/json' -d "$body" "$URL$path" 2>/dev/null) || { code=000; time=0; }
  else
    read -r code time < <(curl -sS -m 60 -o "$out" -w '%{http_code} %{time_total}\n' "$URL$path" 2>/dev/null) || { code=000; time=0; }
  fi
  if [ "$code" = "200" ]; then
    printf 'OK   %-10s %ss  %s\n' "$name" "$time" "$(head -c 160 "$out" | tr '\n' ' ')"
  else
    printf 'FAIL %-10s http=%s %ss  %s\n' "$name" "$code" "$time" "$(head -c 160 "$out" | tr '\n' ' ')"
    fail=1
  fi
  rm -f "$out"
}

call languages GET  /languages ""
call translate POST /translate "{\"q\":\"Olá, tudo bem? Quero marcar uma reunião amanhã.\",\"source\":\"pt\",\"target\":\"es\",\"format\":\"text\",\"api_key\":\"$KEY\"}"
call detect    POST /detect    "{\"q\":\"Hola, quisiera saber el precio del curso.\",\"api_key\":\"$KEY\"}"

[ "$fail" = 0 ] && echo "Tudo certo." || echo "Falhou: veja docs/LIBRETRANSLATE-SETUP.md (Solução de problemas)."
exit "$fail"
