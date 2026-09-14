# Limites WhatsApp/Meta e Anti-Ban para CRM Multi-Tenant

Pesquisa para calibrar constantes de pacing/fila de envio nos dois transportes do ClawCRM: (a) WhatsApp Cloud API oficial da Meta e (b) gateway não-oficial via protocolo WhatsApp Web (whatsmeow/wuzapi).

## Resumo Executivo

A Cloud API tem regras **documentadas e numéricas** que dá para codificar com precisão: pair rate limit de 1 msg/6s por destinatário (erro 131056), throughput de 80 mps por número (erro 130429), tiers de mensageamento (250→2K→10K→100K→ilimitado) e backoff de retry `4^X` segundos — tudo confirmado na documentação oficial [1][2][3]. Não existe, na doc atual, um número análogo para o protocolo não-oficial: as faixas de delay usadas pela comunidade variam de 1-5s a 15-45s dependendo da fonte, e o fator que mais aparece como decisivo não é o delay em si, mas se o número já tem "relação" com o destinatário (contato salvo, conversa iniciada pelo cliente) — um usuário relatou ban mesmo com 30s de delay ao mandar para contatos frios [10]. Recomendo tratar os números do protocolo não-oficial como estimativas de engenharia calibráveis por métrica de bloqueio real, não como limites garantidos por ninguém.

## Descobertas

### 1. Cloud API oficial — limites publicados

**Tiers de conversas iniciadas pelo negócio (messaging limit)** [1][5]
- Portfólio novo: **250** destinatários únicos por período móvel de 24h, fora da janela de atendimento de 24h (customer service window).
- Sobe para **2.000** completando um "scaling path": verificar o negócio, ter parceiro verificando, OU enviar 2.000 mensagens entregues (fora da janela de atendimento) para números únicos num período móvel de **30 dias**, usando templates de alta qualidade.
- Depois de 2.000, escala automaticamente (sem ação manual) para **10.000 → 100.000 → Ilimitado**, condicionado a: (a) mensagens de alta qualidade em todos os números/templates e (b) uso de **mais de 50% do limite atual nos últimos 7 dias**. Quando os critérios batem, o limite sobe um nível em até **6 horas**.
- O limite é por **portfólio de negócio**, compartilhado entre todos os números WABA daquele portfólio — um número sozinho pode consumir a cota inteira.
- Consultar via API: campo `whatsapp_business_manager_messaging_limit` (o antigo `messaging_limit_tier` foi descontinuado).
- Importante: esse limite só vale para mensagens **fora** da janela de atendimento de 24h. Dentro dela (cliente respondeu ou iniciou), não conta.

**Throughput (mensagens por segundo, por número)** [2]
- Default: **80 mps**, contando inbound + outbound, todos os tipos de mensagem.
- Upgrade automático e gratuito para **1.000 mps** se: portfólio tem messaging limit "Unlimited" + número mensageou 100K+ destinatários únicos fora da janela de atendimento em 24h móveis + `quality_score` é YELLOW ou melhor.
- Números do WhatsApp Business app usados também via Cloud API ficam fixos em **20 mps**.
- Exceder o throughput → **erro 130429** até voltar dentro do limite.
- Durante o processo de upgrade (até 1 minuto), o número fica indisponível: erro **131057**.

**Pair rate limit (mesmo destinatário)** [3] — este é o número mais relevante para pacing por conversa:
- **1 mensagem a cada 6 segundos** para o mesmo usuário do WhatsApp (0,17 msg/s ≈ 10/min ≈ 600/hora).
- Exceder → **erro 131056** até normalizar.
- Permite burst de até **45 mensagens em 6 segundos**, mas isso "toma emprestado" da cota futura — ex.: um burst de 20 exige ~2 minutos de espera antes de mandar mais para aquele mesmo usuário.
- Retry recomendado pela própria doc: backoff exponencial de **4^X segundos** (X começa em 0 e sobe 1 a cada falha) até suceder.

**Limites de chamadas de API (rate limit de app/WABA)** [3]
- Endpoints de gestão (WABA info, `phone_numbers`, `message_templates`, `subscribed_apps`, `assigned_users`, status): **200 requisições/hora** por app/WABA por padrão; **5.000/hora** se a WABA estiver ativa com ao menos um número registrado.
- Credit Line API: 5.000 req/hora.
- A doc também nomeia "Test message rate limit" (WABAs não verificadas), "Capacity rate limit" (todas as contas) e "Business phone rate limit" (por número) como categorias existentes, mas não publica valores numéricos para elas na versão atual — é uma lacuna documental, não um dado que eu tenha encontrado em outro lugar confiável.

**O que acontece ao exceder cada limite:**
| Limite excedido | Código de erro | Efeito |
|---|---|---|
| Throughput (mps) | 130429 | Rejeitado até voltar à taxa permitida |
| Pair rate limit (mesmo destinatário) | 131056 | Rejeitado até normalizar; retry com backoff 4^X |
| Upgrade de throughput em andamento | 131057 | Número indisponível por até 1 min |
| Messaging limit (tier) estourado | — | Mensagens de template fora da janela simplesmente não são aceitas até resetar/subir tier |

Não há evidência oficial de que exceder rate limits técnicos, por si só, sinalize a conta para banimento — são erros de throttling. O que afeta o **quality rating** (e por consequência pode levar a enforcement) é um mecanismo separado, coberto abaixo.

### 2. Quality rating e enforcement oficial

**Quality rating do número de telefone** [4][5]
- Calculado com base no feedback dos últimos **7 dias**, ponderado por recência: bloqueios, denúncias, silenciamentos, arquivamentos, e o motivo selecionado pelo usuário ao bloquear (`No longer needed`, `Didn't sign up`, `Spam`, `Offensive messages`, `No reason`).
- Três estados: **Verde** (alta), **Amarelo** (média), **Vermelho** (baixa).
- **Mudança recente importante**: os status "Flagged" e "Restricted" de número de telefone foram **descontinuados em 7 de outubro de 2025** [5] — hoje só existem os três estados de quality acima no nível de número. Se algum código/doc antiga do projeto ainda menciona "flagged"/"restricted" como estado de número, está desatualizado.
- Números de alto tráfego podem mudar de rating em questão de minutos [6].

**Quality rating do template** (separado, por template) [7]
- `GREEN` / `YELLOW` / `RED` / `UNKNOWN` (novo template começa `UNKNOWN`).
- Alimenta dois mecanismos automáticos:
  - **Template pausing** [8]: se cai para RED, é pausado automaticamente — 1ª vez: 3h; 2ª vez: 6h; 3ª vez: desabilitado (precisa editar e ressubmeter para aprovação). Durante a pausa a API rejeita envios (não conta contra o limite, não cobra). Desde 12/out/2023, precisa ser despausado manualmente via `/unpause` ou WhatsApp Manager.
  - **Template pacing** [9]: templates novos, recém-despausados, ou sem rating GREEN podem ter mensagens "seguradas" (`message_status: held_for_quality_assessment`) até acumular feedback suficiente. Se o sinal for bom, libera tudo; se ruim, o template é pausado e as mensagens seguradas são descartadas com erro **132015**. A Meta garante que, mesmo com pacing, 99% das campanhas de alto throughput entregam dentro de 1 hora.

**Policy enforcement no nível de conta (WABA)** [4]
- Violação de política (spam, misclassificação de template, categorias de risco como conteúdo adulto/álcool-tabaco/drogas/jogos) → aviso inicial.
- Violações repetidas escalam:
  1. Bloqueio de 1 ou 3 dias (templates de marketing/utility/authentication + impedido de adicionar números)
  2. Bloqueio de 5, 7 ou 30 dias (**todas** as mensagens + impedido de adicionar números)
  3. **Account lock**: bloqueio indefinido, só reversível via apelação
  4. **Desabilitação permanente** da plataforma se o negócio não corrigir após múltiplos avisos
- Violações graves (exploração infantil, golpes, terrorismo, venda de drogas ilegais) → offboard **imediato**, sem escalada gradual.
- Feedback negativo excessivo dos usuários, isoladamente, também pode levar a limitação ou desligamento do negócio.
- Notificação via Business Support Home, Notification Center, banner no WhatsApp Manager, e-mail a admins e webhook `account_update`. Apelação possível na maioria dos casos (não em todos os de spam), decisão em 24-48h.

**Boas práticas oficiais para manter qualidade** [6]: seguir a WhatsApp Business Messaging Policy; só mandar para quem deu opt-in explícito; mensagens altamente personalizadas e úteis; evitar mensagens de boas-vindas genéricas/abertas; evitar excesso de mensagens por dia; otimizar conteúdo e tamanho.

### 3. Protocolo não-oficial (whatsmeow/wuzapi) — heurísticas da comunidade

Esta seção é **anedótica por natureza** — não existe documentação oficial da Meta para um protocolo que ela não sancionou. Priorizei relatos primários nas discussões do próprio repositório whatsmeow [10][11], cross-checando com um guia comercial de um provedor de API não-oficial [12] — que é fonte promocional (vende a própria API) e deve ser lida com ceticismo adicional, mas cujo framework geral é consistente com o relatado na comunidade.

**Motivos de ban reportados pelo próprio app do WhatsApp** (texto exibido ao usuário banido, coletado por membros da comunidade) [10]:
- "too many people blocked you"
- "you sent too many messages to people who don't have you in their address books"
- "you created too many groups with people who don't have you in their address books"
- "you sent the same message to too many people"
- "you sent too many messages to a broadcast list"

**O delay sozinho não é suficiente — o que parece importar mais é a relação prévia com o destinatário** [10]:
- Um usuário testou 30s de delay entre mensagens, mandando para 30 números que não estavam na agenda → foi banido mesmo assim.
- O mesmo tipo de teste, mas mandando 1.000 mensagens **sem** delay para um número próprio (conversa 1:1 já estabelecida) → nenhum ban.
- Conclusão recorrente na thread: **ser "respondente" (responder quem já procurou você) é bem menos arriscado que ser "broadcaster" (iniciar contato com quem nunca falou com você)** — mesmo com delay e variação de texto, iniciar contato frio em volume ainda banca.

**Recomendações de um usuário com bot em produção sem bans reportados** (jeffersonsc, na thread #567) [11]:
- Warm-up: conectar o número primeiro no app oficial e no WhatsApp Web antes de automatizar.
- Configurar o "client name" da sessão whatsmeow como "Chrome" (navegador mais popular) — mascarar a identificação de cliente.
- Delay **aleatório entre 1 e 5 segundos** entre envios.
- Indicador de "digitando" antes/durante envio de texto; indicador de "gravando áudio" para notas de voz (OGG) — citado por dois usuários independentes na mesma thread, com um relatando faixa de 1000-5000ms.
- Deixar o cliente iniciar a conversa sempre que possível (modelo responsivo, não broadcast).
- "Certifique-se de que a saída de mensagens por minuto não seja muito alta e que as pessoas escrevam para você primeiro antes de você escrever para elas."
- Contra-exemplo relevante: um usuário conectou um número novo direto no WhatsApp Web **oficial** (sem whatsmeow) e foi banido após só ~5 mensagens — evidência de que a detecção de "possível spammer" é comportamental, não exclusiva de bibliotecas não-oficiais.
- Números recuperados de ban anterior, ao reconectar, receberam aviso de "app não-oficial detectado" — sinal de que a Meta reconhece sessões/dispositivos já sinalizados.

**Framework do guia comercial WasenderAPI** [12] (fonte promocional — sinalizo o viés, mas o conteúdo é coerente com o observado acima):
- Diferencia "ban técnico" (implementação de biblioteca mal feita, detectada como bot) de "ban comportamental" (denúncias de usuário, padrão de envio parece máquina).
- Warm-up gradual sugerido: semana 1 só uso manual; semana 2, 10-20 msgs/dia automatizadas para contatos engajados; semana 3+, aumentar volume ~20% a cada poucos dias.
- Delay sugerido: **15-45 segundos** entre mensagens (bem mais conservador que os 1-5s relatados no whatsmeow), com pausa de 10-15 min a cada 50 mensagens.
- Personalização via spintax/variáveis para não repetir texto idêntico em massa.
- Taxa de resposta recebida/enviada como sinal forte de legitimidade.
- Consistência de IP/sessão (evitar login de múltiplos países, evitar reconectar com frequência).
- Evitar links encurtados na primeira mensagem a um contato novo.
- Oferecer opt-out ("responda STOP") para reduzir a chance do botão de denúncia.

**Divergência a destacar**: as faixas de delay vão de 1-5s (whatsmeow, relato de produção) a 15-45s (guia comercial). Nenhuma das duas é um número "oficial" ou garantido — são calibrações de risco diferentes. Dado que o ClawCRM é multi-tenant (múltiplos clientes rodando o mesmo código, potencialmente somando padrões de tráfego reconhecíveis), pender para o lado mais conservador é mais prudente do que copiar o número mais otimista encontrado.

### 4. Recomendações práticas de implementação de fila

**Cloud API (transporte oficial)**
- O throughput (80 mps default) não é o gargalo real para volume de CRM pequeno/médio — o gargalo é o **pair rate limit**: nunca menos de 6 segundos entre duas mensagens para o mesmo destinatário. Sugiro implementar o limitador por par `(organizationId, destinatário)` com um piso de 6-7s (margem de segurança sobre o limite documentado) e não usar o burst de 45/6s como recurso normal — ele consome cota futura e complica o cálculo de fila.
- Para retry em 429/130429/131056: usar literalmente o backoff da doc, `4^X segundos` (X=0,1,2,...), já que é um valor publicado pela própria Meta, não uma estimativa.
- Monitorar `quality_score` via webhook `phone_number_quality_update` e reduzir automaticamente o volume de campanhas (ou pausar) se o número cair para YELLOW/RED.
- Para broadcast de templates em massa, consultar `whatsapp_business_manager_messaging_limit` antes de disparar e não estourar a cota do tier atual; espalhar campanhas grandes ao longo de horas/dias em vez de gastar a cota de uma vez — isso também ajuda organicamente a bater o critério de "mais de 50% de uso em 7 dias" para subir de tier.
- Tratar no webhook de status o `message_status: held_for_quality_assessment` e o erro `132015` (mensagem descartada por template pacing) — isso é comportamento automático da Meta, o código só precisa reconhecer e não tratar como falha de envio "normal".
- Para o cenário citado (200 mensagens agendadas para as 9h): tecnicamente, se forem 200 destinatários diferentes, cabem dentro do throughput de 80 mps quase instantaneamente sem violar o pair rate limit (que é por destinatário, não agregado). Ainda assim, um pico abrupto de volume é o tipo de padrão que a doc oficial pede para evitar ("avoid sending too many messages per day") como fator de quality — não há limite técnico formal aqui, mas sugiro (decisão de engenharia minha, não exigência documentada) aplicar um jitter de 1-3s entre envios sequenciais dentro do lote, só para não gerar um pico visualmente idêntico a um blast de spam.

**Gateway não-oficial (bridge/wuzapi/whatsmeow)**
Como o risco de ban aqui é permanente e sem processo formal de apelação, e o produto é multi-tenant (múltiplas orgs no mesmo código, o que pode criar uma "assinatura" de tráfego reconhecível se todos usarem exatamente os mesmos parâmetros), recomendo ficar entre os dois extremos observados na pesquisa, mais perto do lado conservador:
- **Intervalo mínimo entre envios: 3-10 segundos com jitter aleatório** — faixa intermediária entre os 1-5s otimistas do whatsmeow (relato único de produção) e os 15-45s do guia comercial. Isto é uma escolha de engenharia, não um número documentado ou garantido por nenhuma fonte.
- **Simular "digitando..."** antes de cada envio de texto, com duração proporcional ao tamanho da mensagem — prática confirmada por múltiplos relatos independentes na comunidade.
- **Simular "gravando áudio"** antes de enviar notas de voz.
- **Aplicar a mesma lógica de pair rate limit por destinatário** mesmo não sendo documentada oficialmente para o protocolo não-oficial (por analogia de segurança, não por exigência confirmada).
- **Cap diário por número**: nenhuma fonte confiável publica um número "seguro" garantido. Recomendo começar conservador (algumas centenas/dia para número já aquecido, dezenas/dia para número novo) e ajustar com base em métricas reais de bloqueio/denúncia observadas no próprio produto — não tratar nenhum valor fixo como garantia.
- **Warm-up obrigatório para números novos**: dias de uso manual + rampa de volume automatizado crescente antes de liberar tráfego pleno. Não existe tabela oficial "dia X = Y mensagens" — é prática de mercado sem consenso numérico rígido; uma rampa razoável seria começar com dezenas/dia e dobrar a cada poucos dias, mas isso é uma proposta minha, não um dado coletado.
- **Priorizar sempre responder conversas iniciadas pelo cliente sobre iniciar contato novo** — este é o sinal mais forte e mais consistente em todas as fontes da comunidade, mais importante que qualquer ajuste fino de delay.
- **Tratamento de erro/desconexão**: se a sessão reportar desconexão com mensagem de "versão não-oficial do WhatsApp detectada" (padrão relatado na comunidade), tratar como sinal de alto risco — pausar a fila daquele número e alertar o operador, em vez de reconectar/retry automático.

## Recomendações

1. **Codificar os números da Cloud API como constantes exatas** (pair rate limit 6s/destinatário, backoff 4^X, throughput 80 mps) — são valores publicados pela Meta e não deveriam ser "chutados"; risco baixo de errar.
2. **Não copiar cegamente nenhuma faixa de delay do protocolo não-oficial como se fosse garantida** — nem os 1-5s do whatsmeow nem os 15-45s do guia comercial são "seguros" comprovados; comece em algo como 3-10s + jitter e monitore taxa de bloqueio real por org como sinal de ajuste, documentando no código que é uma estimativa calibrável, não um limite oficial.
3. **Priorizar no produto o sinal mais forte encontrado**: para o bridge não-oficial, dar prioridade de fila (ou até liberar sem tanta cautela) para conversas onde o cliente mandou mensagem primeiro, e aplicar as travas mais rígidas de warm-up/rampa apenas para mensagens iniciadas pela organização (broadcast/campanha) — o risco está concentrado ali, não no atendimento reativo.
4. **Monitorar `quality_score` da Cloud API via webhook e cortar automaticamente campanhas quando cair para YELLOW/RED** — já existe um sinal oficial de alerta antecipado antes de qualquer enforcement mais grave; vale a pena não depender só de erro 429 para reagir.
5. **Se o time decidir por um cap diário no bridge, documentar explicitamente no código que o valor é uma escolha de produto sem lastro documental**, para evitar que alguém no futuro trate esse número como um "limite oficial da Meta" que não existe.

## Fontes

[1] https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits — Documentação oficial Meta, tiers de messaging limit (250/2K/10K/100K/ilimitado) e critérios de auto-scaling. Atualizada em 21/mai/2026.
[2] https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput — Documentação oficial Meta, throughput por número (80 mps default, 1.000 mps upgrade) e critérios de elegibilidade. Atualizada em 17/jun/2026.
[3] https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform — Documentação oficial Meta, seção "Rate limits" e "Pair rate limits" (1 msg/6s, erro 131056, burst de 45/6s, backoff 4^X) e rate limit de chamadas de API (200/5000 req/hora).
[4] https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement — Documentação oficial Meta sobre enforcement de política, escalada de bloqueios e banimento. Atualizada em 21/mai/2026.
[5] https://www.facebook.com/business/help/896873687365001 — Meta Business Help Center, "About your WhatsApp Business phone number's quality rating". Confirma estados verde/amarelo/vermelho e a descontinuação dos status "Flagged"/"Restricted" em 7/out/2025.
[6] https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages — Documentação oficial Meta, seção "Message quality" (sinais de feedback, boas práticas).
[7] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality — Documentação oficial Meta, quality rating de templates (GREEN/YELLOW/RED/UNKNOWN).
[8] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing — Documentação oficial Meta, mecanismo de pausa automática de template (3h/6h/desabilitado).
[9] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pacing — Documentação oficial Meta, mecanismo de pacing/retenção de mensagens de template novo.
[10] https://github.com/tulir/whatsmeow/discussions/199 — Discussão da comunidade no repositório oficial do whatsmeow (biblioteca usada pelo wuzapi). Relatos anedóticos primários de usuários sobre motivos de ban e testes de delay vs. contato frio.
[11] https://github.com/tulir/whatsmeow/discussions/567 — Discussão da comunidade no whatsmeow sobre mudanças nas regras de ban; contém as recomendações mais concretas e testadas em produção (delay 1-5s, typing indicator, warm-up).
[12] https://wasenderapi.com/blog/stop-getting-banned-the-ultimate-whatsapp-anti-ban-strategy-for-unofficial-apis-in-2025 — Guia de um provedor comercial de API não-oficial. **Fonte promocional/comercial** (vende a própria API) — usado só como triangulação de framework, não como autoridade.

---

## Addendum 2026-07-26 — pesquisa complementar da rodada v4.1

### A. Rate limits não publicados da Meta (3 scouts, fontes oficiais)
As categorias **"Test message rate limit"**, **"Capacity rate limit"** e
**"Business phone rate limit"** são nomeadas pela doc oficial mas **não têm
valor numérico publicado em NENHUMA fonte confiável** (Meta, BSPs 360dialog,
comunidade) — não inventar caps. Códigos de throttling oficiais completos:
`4, 80007, 130429, 131048, 131056, 133016, 131064` (página error-codes).
- `80007` — "WABA has reached its rate limit", genérico, sem desambiguar a
  categoria → tratar como throttling (backoff 4^X), igual 130429.
- `131048` — restrição POR NÚMERO por "mensagens bloqueadas/denunciadas como
  spam". Candidato plausível (confiança MÉDIA, não confirmado) ao "business
  phone rate limit". **Não é throttling benigno — é sinal de risco de
  qualidade**: o ClawCRM congela a fila do canal 30min + alerta, sem retry.
- `80008` — rate limit da Management API (200/5000 req/h) — NÃO confundir com envio.

### B. Typing/warm-up de produção no protocolo não-oficial (baileys-antiban v4.10, mesmo protocolo do whatsmeow)
- **Typing model WPM**: 45±15 WPM (~267ms/char) com ciclos composing/paused e
  pausas de pensamento 0,8–3,5s (8% a cada 10 chars); fallback linear ~30ms/char.
  Mensagem de 200 chars = 30–60s "humano real". O ClawCRM usa 55ms/char + teto
  8s como compromisso deliberado UX×realismo (constante em
  `convex/lib/whatsappDispatch.ts`).
- **Warm-up com rampa concreta de produção**: dia 1=20, 2=36, 3=65, 4=117,
  5=210, 6=378, 7=680, 8+=sem limite (fator ~1,8×/dia; >72h inativo reinicia).
  Mais conservador e mais recente que qualquer blog. **Documentado como
  referência — NÃO implementado** (decisão v4/v4.1); `channelPacing.dailyCount`
  registra a métrica para calibrar se um dia virar produto.
- **Detecção 2025-26**: onda de "conta em risco" mai/2025 atingiu whatsmeow E
  Baileys simultaneamente (whatsmeow#807/#810, Baileys#1392; persiste em
  Baileys#2658, jun/2026) — comportamental + fingerprinting de SESSÃO (contas
  ociosas conectadas também receberam). Heurística nova relatada em 2026
  (confiança média, blog agregador): contador de mensagens NÃO respondidas em
  janela de 30 dias — penaliza broadcast, não atendimento reativo.
- **Hardening de gateway (fora do CRM, backlog)**: atrasar presença
  "available" 45–120s pós-conexão; pool de client names (o "Chrome" fixo
  idêntico em milhares de bots é ele próprio um fingerprint).
- **wuzapi**: confirmado SEM pacing embutido (wrapper fino do whatsmeow) — todo
  anti-ban é responsabilidade da nossa camada. `POST /chat/presence`
  `{Phone, State: "composing"|"paused", Media: ""|"audio"}`.

### C. Concorrentes
- **Letalk** (única com pacing documentado publicamente): temporizador de
  envios com intervalo aleatório **8–15s (média 12s)**, fila sequencial única
  por número, não configurável — base da faixa "fria" do bridge no ClawCRM
  (envio sem inbound do cliente nas últimas 24h).
- Kommo/Umbler/Blip/Huggy/Zenvia (API oficial): nenhum pacing próprio
  publicado — delegam throttling à Meta; conteúdo é compliance (opt-in,
  templates, quality rating). Chatwoot não tem WhatsApp não-oficial nativo
  (comunidade usa Evolution API/Baileys) e não tem pacing anti-ban no código.
- Ecossistema Evolution API (guias de terceiros, viés comercial): delay
  10–45s, caps 20–50/dia (número novo) a 80–200/dia (aquecido). Anedota de
  calibração de risco: **~30% de chance de ban em 6 meses mesmo com número
  aquecido** — o aceite de risco do P1 não é teatro.


---

## Addendum 2026-09-08 — rodada de pesquisa para o módulo de Campanhas

## Resumo Executivo

Três coisas mudaram e invalidam o conhecimento anterior: o degrau de tier virou **250 → 2.000 → 10.000 → 100.000 → ilimitado** (o de 1.000 morreu em 07/10/2025) e agora é por **portfólio de negócios**, não por número [1][2]. A cobrança é **por mensagem entregue** desde 01/07/2025, e template de utilidade dentro da janela de 24 h é **grátis** — marketing nunca é [3]. E a "MM Lite" foi renomeada para **Marketing Messages API**, com endpoint próprio `/marketing_messages` [12].

No lado não oficial, não existe limite publicado. O que existe é consenso de comunidade e defaults de biblioteca, que divergem em até 30x entre si — daí a seção final com os números que sugiro travar no HNBCRM.

---

# PARTE A — Cloud API oficial (Meta)

## A1. Versão e modelo de cobrança

A Graph API v26.0 saiu em **29/07/2026** [13]; a documentação da Meta usa v25.0/v26.0 nos exemplos [1][6]. A API On-Premises foi desligada em **23/10/2025**, então Cloud API é o único caminho oficial [13].

Cobrança **por mensagem**, efetiva 01/07/2025 [3]:

| Situação | Cobrado? |
|---|---|
| Template marketing (dentro ou fora da janela) | Sim, sempre |
| Template utility fora da janela de 24 h | Sim |
| Template utility dentro da janela aberta | **Grátis** |
| Template authentication fora da janela | Sim |
| Qualquer mensagem não-template (texto, imagem, áudio…) | Grátis (só pode dentro da janela) |
| Tudo, dentro da janela de free entry point | Grátis por 72 h |

Só se cobra quando o template é **entregue** (`"type":"template"`), não quando é enviado [3].

A janela de atendimento (customer service window, CSW) de 24 h reinicia a cada mensagem **ou chamada** do usuário [10].

**Calendário de preços** [3]: a Meta só altera preço no 1º dia de trimestre (1/jan, 1/abr, 1/jul, 1/out), com aviso mínimo de 1 mês para rate card, 3 meses para add-on de modelo e 6 meses para mudança de modelo.

**Brasil:** desde **01/07/2026** (9h PT) clientes com Sold-To Brasil no Billing Hub abrem WABAs em **BRL**, faturados pela Facebook Brasil. Migração de todas as WABAs do portfólio obrigatória até **30/06/2027** — a partir de 01/07/2027 a Meta **para de entregar** mensagens de WABA não-BRL de cliente elegível. Existem APIs de migração de moeda (WABA Currency Migration APIs) [3].

**Tarifas do Brasil** (fontes secundárias, convergentes entre si, não confirmadas no CSV oficial da Meta): **marketing US$ 0,0625**, **utility ≈ US$ 0,0068**, **authentication ≈ US$ 0,0068** (uma fonte diz 0,0225), **serviço grátis** [14]. A Meta publica os números reais só nos CSVs por moeda linkados dentro do painel, que não são acessíveis sem sessão [3].

Volume tiers existem para **utility e authentication** (preço menor conforme escala); marketing não tem volume tier [3].

## A2. Limites de envio (messaging limits / tiers)

Limite = número de **usuários únicos** que você alcança **fora** da janela de 24 h, em janela móvel de 24 h, **compartilhado por todos os números do portfólio** [1].

| Nível | Como se chega |
|---|---|
| 250 | Padrão de portfólio novo |
| 2.000 | Verificar o negócio, **ou** verificação via parceiro, **ou** entregar 2.000 mensagens fora da janela a números únicos em 30 dias com templates de qualidade alta |
| 10.000 | Escala automática |
| 100.000 | Escala automática |
| Ilimitado | Escala automática |

**Critério da escala automática** [1]:
- mensagens de alta qualidade em todos os números e templates do portfólio, **e**
- uso de pelo menos **metade** do limite atual nos últimos 7 dias.

Atendidos os dois, sobe um nível **em até 6 horas** [1].

**Mudanças de 07/10/2025 (já ativas)** [2]:
- limites saíram do número e foram para o **portfólio**; portfólio existente herdou o maior limite de qualquer número dele;
- número recém-registrado **já entra** com o limite do portfólio (antes começava em 250);
- o degrau de entrada da escala automática subiu de **1.000 para 2.000**;
- tempo de upgrade caiu de 24 h para **6 h**;
- o estado de qualidade **Flagged deixou de existir**, e queda de qualidade **não rebaixa mais** o limite;
- webhook `business_capability_update` ganhou `max_daily_conversations_per_business`; o antigo `max_daily_conversation_per_phone` foi removido em **fevereiro de 2026**.

**API:** `messaging_limit_tier` foi **descontinuado**. Use `whatsapp_business_manager_messaging_limit` [1]:

```
curl 'https://graph.facebook.com/v26.0/<PHONE_NUMBER_ID>?fields=whatsapp_business_manager_messaging_limit' \
  -H 'Authorization: Bearer <TOKEN>'
# → {"whatsapp_business_manager_messaging_limit":"TIER_250", "id":"..."}
```

Em caso de negativa de escala, chega webhook `account_alerts` com `alert_type` em `INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED` / `_FAILED` / `_NEED_MORE_INFO` [1].

## A3. Qualidade

**Qualidade do número:** calculada sobre **7 dias**, ponderada por recência, a partir de bloqueios, denúncias, silenciamentos, arquivamentos e o motivo declarado pelo usuário ao bloquear [10]. Números de alto tráfego mudam de qualidade "mesmo dentro de minutos" [10].

Diretrizes oficiais para manter qualidade alta [10]:
- seguir a Business Messaging Policy;
- enviar **só a quem optou** por receber;
- mensagens altamente personalizadas e úteis;
- **evitar** boas-vindas ou introduções genéricas e abertas;
- **evitar muitas mensagens por dia**;
- otimizar conteúdo e comprimento.

**Qualidade do template** (independente da do número) [6]: `GREEN` (alta), `YELLOW` (média — feedback negativo ou baixa leitura, ainda envia), `RED` (baixa — em risco de pausa), `UNKNOWN` (pendente, template novo). Consulta via `?fields=quality_score` no Template API.

## A4. Template pacing e pausa

**Pacing** [7] vale para templates de marketing e utility. Template novo, despausado ou sem rating `GREEN` pode ser pacing-ado. Passado um limiar não divulgado, as mensagens seguintes ficam **retidas**: a resposta do endpoint traz `message_status: held_for_quality_assessment` (contra `accepted` no caminho normal).

- Sinal bom → libera as retidas, dispara webhooks `sent`/`delivered` normalmente.
- Sinal ruim → template vira `PAUSED`, webhook `message_template_status_update` com evento `paused`, e **cada mensagem retida cai** com webhook `failed` + código **132015**.

A Meta afirma guardrail interno para decidir em até **1 hora no p99** mesmo em campanha grande [7]. Utility só entra em pacing se você já teve um utility pausado, e pelos 7 dias seguintes [7].

**Pausa por qualidade RED** [8]: 1ª ocorrência **3 h**, 2ª **6 h**, 3ª **desabilitado**. Enquanto pausado a API rejeita o envio (não cobra nem consome limite, mas rejeita). Template pausado **pelo pacing** exige **unpause manual**: `POST /{whats_app_message_template_id}/unpause` ou o link no WhatsApp Manager [8]. Apelação de rejeição exige amostra e é decidida em 24 h [8].

## A5. Limite por usuário (frequency capping) e opt-out

A Meta limita quantos **templates de marketing** uma pessoa recebe, de forma **dinâmica e adaptativa** — depende da taxa de leitura recente dela e de quanto a caixa de entrada está cheia de mensagens de amigos, família e empresas. **Não existe número publicado** [5].

- Marketing enviado **dentro de uma janela aberta não conta** para o limite [5].
- Falha vem como webhook `failed` + erro **131049** [5].
- Espere **pelo menos 24 h** antes de reenviar. Retry excessivo faz a Meta bloquear entregas àquele usuário por até 24 h e degrada a acurácia do relatório da campanha [5].
- **Não está ativo** para EEA, Reino Unido, Japão e Coreia do Sul — **o Brasil está sujeito** [5].

**EUA:** a Meta **não entrega** templates de marketing para números com +1 e área americana. Foi anunciado para abr/2025 e a doc atual afirma o bloqueio como estado corrente [5]. Não afeta Brasil.

**Opt-out** tem código próprio: **131050** — "o destinatário escolheu parar de receber mensagens de marketing da sua empresa". Não reenvie; existe webhook para ser notificado do opt-out [9].

## A6. Envio fora da janela e mídia outbound

Fora da janela, **só template aprovado**; texto livre retorna **131047** ("mais de 24 horas desde a última resposta") [9].

Header de template aceita imagem, vídeo ou documento. Recomendação oficial: **subir o arquivo e usar o media ID** em vez de URL própria, para aproveitar throughput alto; se precisar servir da sua infra, use media HTTP caching [4].

Limites de mídia [11]:

| Tipo | Formatos / MIME | Tamanho máx. |
|---|---|---|
| Imagem | jpeg, png | 5 MB |
| Vídeo | mp4, 3gp | 16 MB |
| Áudio | aac, amr, mp3, m4a, ogg (**só codec OPUS, mono**) | 16 MB |
| Documento | pdf, txt, doc/docx, xls/xlsx, ppt/pptx | 100 MB |
| Sticker | webp estático | 100 KB |
| Sticker | webp animado | 500 KB |

Media ID de upload expira em **30 dias**; media ID vindo de webhook expira em **7 dias** [11].

Tipos de mensagem disponíveis dentro da janela (não-template): endereço, áudio, contatos, documento, imagem, botão CTA de URL, chamada interativa, WhatsApp Flows, lista interativa, pedido de localização, botões de resposta rápida (até 3), localização, sticker, texto, vídeo e reação [10].

## A7. Checar se um número tem WhatsApp

Não existe mais endpoint de checagem — o `/contacts` foi removido. O comportamento atual é **enviar e ler o erro**: **131026** cobre "o número não é um número WhatsApp", "o destinatário não aceitou os novos termos" e "cliente WhatsApp antigo demais" [9]. Na Cloud API a validação é a posteriori, e cada tentativa errada custa em qualidade.

Outros erros relevantes para campanha [9]:

| Código | Significado | Ação |
|---|---|---|
| 130429 | Throughput da Cloud API estourado | backoff, reduzir frequência |
| 131026 | Não entregue: sem WhatsApp / ToS / cliente antigo | não reenviar |
| 131047 | Passaram 24 h da última resposta | usar template |
| 131048 | Restrição de envio por spam/bloqueios anteriores | checar qualidade, congelar canal |
| 131049 | Não entregue para manter engajamento saudável (per-user cap) | esperar 24 h |
| 131050 | Usuário optou por não receber marketing | **nunca** reenviar |
| 130403 | A empresa bloqueou o usuário | desbloquear |
| 132015 | Template pausado por baixa qualidade | corrigir e despausar |
| 131057 | Conta em manutenção (às vezes upgrade de throughput) | esperar |

## A8. Throughput e boas práticas de vazão

- **80 mensagens/segundo** por número registrado, padrão [4].
- Até **1.000 mps** por upgrade automático e gratuito [4].
- Elegibilidade para 1.000 mps: portfólio com limite **ilimitado** + número usado para alcançar **100 mil usuários únicos fora da janela em 24 h** + qualidade `YELLOW` ou melhor [4].
- Número compartilhado com o app WhatsApp Business fica travado em **20 mps** [4].
- O upgrade leva até 1 minuto, e durante ele a API responde **131057** [4].
- Throughput conta **inbound e outbound**, todos os tipos [4].
- Estourar devolve **130429**; excesso para o *mesmo* usuário devolve erro de **pair rate limit** [4].
- Webhook precisa aguentar **3x** o tráfego de saída (status callbacks) + 1x o de entrada; mediana ≤ 250 ms, menos de 1% acima de 1 s; a Meta reentrega falhas por até 7 dias com backoff exponencial [4].

## A9. Marketing Messages API (ex-MM Lite)

Renomeada de "Marketing Messages Lite API" para **Marketing Messages API for WhatsApp** (MM API). Endpoint dedicado **`/marketing_messages`**, mesmo esquema técnico e **mesmo modelo de cobrança** da Cloud API, reaproveita números e templates existentes [12].

O que ela adiciona [12]:
- otimização automática de entrega (teste A/B da Meta com ~12 milhões de mensagens na Índia em jan/2025, t-test 95%);
- benchmarks de performance e recomendações;
- otimizações criativas em teste (animação e filtro de imagem);
- formatos mais ricos, como **GIF**;
- **time-to-live**, para não entregar campanha sensível a tempo com atraso.

Restrições geográficas (fonte secundária de BSPs): mensagens de/para EEA, Reino Unido, Japão e Coreia do Sul **não recebem** otimização de entrega nem relatório de clique/conversão [busca]. Alinhado com a lista de países excluídos do per-user cap na doc oficial [5].

---

# PARTE B — Não oficial (whatsmeow / wuzapi / Evolution API / Baileys)

Nada aqui é documentado pela Meta. São defaults de biblioteca e consenso de mercado, e divergem muito entre si. O bridge viola os termos do WhatsApp e o risco de ban permanente é real.

## B1. Curvas de aquecimento publicadas

| Fonte | D1–2 | D3–4 | D5–7 | Depois |
|---|---|---|---|---|
| Letalk (provedor BR) [16] | 30–50/dia | 80–100/dia | 150–200/dia | campanhas graduais |
| baileys-antiban (defaults do código) [15] | 20 → 36 | 65 → 117 | 210 → 680 | sem teto (dia 8+) |
| Umbler (provedor BR) [17] | — | — | — | **só escale após ~1 mês** de uso normal |
| Consenso PT-BR de busca [busca] | 10–30/dia de primeiro contato | 30–50 na 1ª semana | — | 100–200 ao fim da 2ª semana |

A curva do baileys-antiban usa `warmUpDays: 7`, `day1Limit: 20`, `growthFactor: 1.8` — chega a 680/dia no dia 7 [15]. É agressiva demais para lista fria; trate como teto técnico da biblioteca, não como recomendação de segurança.

Letalk detalha o ritual completo do aquecimento [16]: nos dias 1–2, conversar com amigos/família/equipe, entrar em grupos, publicar status, fazer chamadas curtas; dias 3–4, aumentar volume e entrar em novos grupos; dias 5–7, fazer alguns contatos **iniciarem** a conversa com você. Recomenda 2–5 grupos e pelo menos 1 status por dia. Afirma que números com **mínimo de 5 dias** de aquecimento têm menos bloqueios; 3 dias basta para pouco volume, 5–7 dias para campanhas e automações. O critério de "aquecido" é **equilíbrio entre enviadas e recebidas** — o ideal é receber tanto quanto ou mais do que envia.

## B2. Defaults numéricos do baileys-antiban [15]

| Parâmetro | Default |
|---|---|
| Delay entre mensagens | 1.500–5.000 ms |
| Penalidade para chat novo | +2.500–3.000 ms |
| Multiplicador de delay: desconhecido | 2,5× |
| Multiplicador: handshake enviado | 1,8× |
| Multiplicador: handshake completo | 1,3× |
| Multiplicador: contato conhecido | 1,0× |
| Simulação de digitação | ~30 ms por caractere |
| Preset "moderado" | 8–15/min, 200–400/h, 1.500–2.000/dia |
| Novos contatos por dia | 5 |
| Contatos do mesmo grupo | 10 |
| Operações de grupo | ~3 adds / 10 min, 2 criações / 10 min |
| Taxa de resposta mínima | **10%** (abaixo disso, bloqueia envio) |
| Mínimo antes de aplicar a regra | 5 mensagens enviadas |
| Entrega abaixo de 60% de duplo-tique | sinal de soft-ban |
| Atividade humana de fundo | a cada 2–6 h; digitação 3–8 s; delay de leitura 10–60 min; toggle de presença 30–120 s |

Pontuação de risco na saúde da conexão: +15 a +30 por desconexão, +40 em erro 403, +60 em 401 (logged out), +25 em 463 (timelock), +20 por mensagem falha. Alerta em 3 desconexões/hora, crítico em 5/hora [15].

## B3. Sinais que levam a ban

O driver real é **denúncia e bloqueio do destinatário**; o resto é proxy [18]. Pesam também [16][18]:

- enviar muito mais do que recebe;
- mensagens para quem nunca respondeu ou não salvou seu contato;
- texto idêntico repetido em massa;
- volume alto logo no primeiro dia de um número novo;
- número recém-ativado disparando campanha;
- envio para número inexistente (sinal de lista comprada);
- link já no primeiro contato.

Pesquisa citada pela comunidade em 2025–2026 (fonte secundária, não verificável de forma independente): os modelos do WhatsApp pesam fortemente **razão de resposta** (abaixo de 10% = alto risco), **distância no grafo de contatos** (desconhecido = alto risco) e **padrão temporal** (timing robótico = alto risco), com rastreio de mensagens sem resposta em 48 h acumuladas em janela móvel de 30 dias [busca].

A Umbler recomenda dividir a lista em segmentos (leads, clientes ativos, reengajamento) e **esperar 24 h entre lotes** para observar resultado antes de continuar. Também recomenda **1 mês de uso normal** antes de escalar disparos em número recém-ativado, e nunca disparar com qualidade baixa ou sinalizada [17].

**Contraponto honesto:** a Chatsac argumenta que nenhuma rotina de aquecimento imuniza a conta, porque o motivo real da restrição é consentimento e qualidade da mensagem, não a curva de volume — um chip "bem aquecido" que passa a disparar para lista fria é restringido igual a um chip novo fazendo a mesma coisa. Sinaliza também que o mercado reconstituiu "regras" a partir de anedota, na ausência de dados oficiais [18]. Concordo com a leitura, e ela deveria estar visível na UI do produto.

## B4. Mídia e recursos suportados no wuzapi/whatsmeow

O README do wuzapi lista [19]:

- **Mensagens:** texto, imagem, áudio, documento, template, vídeo, sticker, localização, contato e **enquete (poll)**.
- **Usuários:** **checar se números têm WhatsApp**, obter info e avatar, listar contatos.
- **Chat:** presença (digitando / pausado / gravando mídia), marcar como lido, baixar imagens, enviar reações.
- **Grupos:** criar, apagar, listar, info, link de convite, participantes, foto e nome.
- **Webhooks:** eventos `Message`, `ReadReceipt`, `Presence`, `HistorySync`, `ChatPresence`, `All`.

**Botões e listas interativas não aparecem na lista de recursos** [19], e a comunidade do whatsmeow relata renderização incompleta ao montar mensagem interativa na mão — só header, body e footer aparecem, sem os botões e seções [20]. **Trate botão interativo como indisponível no bridge em 2026.**

O README traz aviso explícito contra uso para spam e recomenda um provedor global oficial para fins comerciais [19].

O ponto forte do bridge para campanha é justamente o **`IsOnWhatsApp`**: dá para validar a lista antes de disparar, coisa que a Cloud API não oferece mais.

---

# PARTE C — Como os concorrentes tratam campanhas

- **Blip Go** chama de "Campanhas" / "Mensagens ativas": upload de **CSV separado por vírgula**, envio **imediato ou agendado**, e público por "grupo de contatos" vindo de uma coluna do Kanban [21]. Relatório com quatro métricas: **Audiência** (1 disparo = 1 telefone), **Falhas**, **Recebidas**, **Lidas** [21]. Limite mensal de disparos reinicia junto com o ciclo de faturamento, do dia 1 ao último dia do mês [21].
- **Kommo** chama de **Broadcast**: segmentação por tags, personalização e escolha de template; até 256 contatos no app WhatsApp Business, ilimitado via API oficial. **Não tem agendamento** — o disparo é manual [22].
- **Umbler** não expõe delay por mensagem; expõe **lotes com intervalo de 24 h** entre eles e alerta sobre a qualidade do número antes do disparo [17].
- **Zenvia** posiciona como disparo multicanal (WhatsApp + SMS + e-mail), com importação de lista e segmentação da comunicação em massa [busca].
- **HubSpot** (via parceiros de integração) é o modelo mais maduro do ponto de vista de CRM: as respostas do broadcast **voltam automaticamente para o registro do contato**, preservando o histórico, e as métricas da campanha convivem com as do CRM no mesmo relatório [busca].
- Padrão comum entre as ferramentas mais novas: **dedup automático, metadado de opt-in e opt-out em um clique**, segmentação por campos do CRM e por comportamento (última abertura, último clique, última compra), contador de tamanho de segmento em tempo real, agendamento no fuso local do contato e teste A/B [busca].
- **Nenhuma** das ferramentas brasileiras que li publica o intervalo entre mensagens como configuração de usuário. Elas escondem isso. É uma oportunidade de diferenciação para o HNBCRM e, ao mesmo tempo, um risco de suporte (usuário sobe o número e culpa a ferramenta pelo ban).
- Vocabulário usado no mercado BR: "disparo em massa", "campanha", "mensagem ativa", "transmissão", "broadcast". Vale suportar mais de um termo na busca da UI.

---

# DEFAULTS RECOMENDADOS PARA O HNBCRM

## (a) Cloud API oficial

| Parâmetro | Número novo (tier 250) | Aquecido (tier ≥ 10k) |
|---|---|---|
| Destinatários únicos por dia | 200 (80% do tier) | 80% do tier vigente |
| Taxa de envio | 3–5 msg/s | 20 msg/s (teto documentado: 80) |
| Tamanho do lote | 200, pausa de 30 min entre lotes | 1.000, pausa de 5 min |
| Janela de envio | 09h–20h no fuso do lead | 08h–21h |
| Retry em 131049 | 1 tentativa, após 24 h | idem |
| Retry em 131050 / 131026 / 130403 | **nunca** | **nunca** |
| Retry em 130429 | backoff exponencial | idem |
| Parada automática | template `RED`, `PAUSED` ou 132015 | idem |

Justificativa: 80% do tier deixa margem para o tráfego transacional do dia, e a Meta exige **metade do limite usado em 7 dias** para escalar — então o default não pode ser tímido demais [1]. Trave um circuit breaker em `132015` e em `message_status: held_for_quality_assessment`: pacing ativo significa que continuar disparando só queima o template [7].

Campos a persistir por campanha, porque a Meta os fornece e o usuário vai perguntar: `message_status` do envio, `whatsapp_business_manager_messaging_limit` do portfólio no momento do disparo, `quality_score` do template.

## (b) Bridge não oficial

| Dia desde a conexão | Mensagens/dia | Novos contatos/dia | Delay entre mensagens |
|---|---|---|---|
| 1–2 | 20 | 5 | 45–120 s |
| 3–4 | 40 | 10 | 40–110 s |
| 5–7 | 80 | 20 | 35–100 s |
| 8–14 | 120 | 30 | 30–90 s |
| Aquecido (15+) | **150–200** | 50 | 30–90 s |

Complementos que eu tornaria **obrigatórios**, não opcionais:

1. **Pausa de 15–30 min a cada 30 mensagens**, e teto de 30/hora. O consenso brasileiro é "abaixo de 30 por hora e uma por minuto, dentro de uma janela de 8 horas, com intervalos aleatórios" [busca][16].
2. **Janela comercial 09h–20h** no fuso do lead, sem fim de semana por padrão [16].
3. **Checar `IsOnWhatsApp` antes de cada envio** e pular número inexistente [19]. É grátis no bridge e caríssimo em qualidade na Cloud API.
4. **Kill switch por taxa de resposta:** abaixo de 10% depois de 50 envios, pausar a campanha [15].
5. **Kill switch por entrega:** abaixo de 60% de duplo-tique, pausar [15].
6. **Variação obrigatória de texto** (spintax ou 3+ variantes por campanha) e **sem link no primeiro contato** [15][16].
7. **Bloquear disparo enquanto o número tiver menos de 7 dias** de conexão; exibir aviso até 30 dias [17].
8. **Multiplicador de delay 2,5× para desconhecido** (contato sem histórico de conversa), 1,0× para quem já respondeu [15].
9. **Presença "digitando" antes de cada envio**, proporcional ao tamanho do texto (~30 ms/caractere) — o HNBCRM já faz isso no `lib/whatsappDispatch.ts` para IA e agendadas [15].

Sobre teto máximo: **não** subiria além de 200/dia no bridge, mesmo com número velho. Os 680/dia do baileys-antiban [15] vêm de uma biblioteca que otimiza para volume, não para sobrevivência do número.

## (c) O que colocar na UI

O aviso mais importante desta pesquisa: **aquecimento reduz risco, não elimina**. O que derruba o número é denúncia e bloqueio de quem não pediu contato [18]. Exponha a **taxa de opt-out e de bloqueio** na tela da campanha com o mesmo destaque de "entregues" — é o indicador que antecede o ban, e nenhum concorrente que li mostra isso.

---

## Fontes

[1] https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits — doc oficial da Meta, atualizada 21/05/2026. Tiers, escala automática, campo de API.
[2] https://developers.facebook.com/documentation/business-messaging/whatsapp/upcoming-messaging-limits-changes — mudança de 07/10/2025, marcada como já ativa. Comparativo antes/depois.
[3] https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing — modelo por mensagem, calendário de preços, localização BRL do Brasil.
[4] https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput — 80/1.000 mps, elegibilidade, requisitos de webhook.
[5] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits — cap dinâmico por usuário, 131049, EUA, países excluídos.
[6] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality — GREEN/YELLOW/RED/UNKNOWN.
[7] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pacing — retenção, held_for_quality_assessment, 132015.
[8] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing — 3 h / 6 h / desabilitado, unpause manual.
[9] https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes — 131026, 131047, 131048, 131049, 131050, 130429, 132015.
[10] https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages — janela de 24 h, tipos de mensagem, qualidade de 7 dias.
[11] https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media — tabelas de tipo e tamanho, expiração de media ID.
[12] https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview — MM Lite renomeada, endpoint /marketing_messages, TTL e GIF.
[13] https://unalsoft.com/blog/2026-07-31-meta-graph-api-v26/en/ e ppc.land — Graph API v26.0 em 29/07/2026; sunset da On-Premises em 23/10/2025. **Secundárias.**
[14] https://setsmart.io/blog/whatsapp-business-api-pricing e https://blueticks.co/blog/whatsapp-business-api-pricing-2026 — tarifas do Brasil. **Secundárias**, convergentes entre si, não confirmadas no CSV oficial da Meta (que exige sessão).
[15] https://github.com/kobie3717/baileys-antiban — defaults numéricos de anti-ban. É código de biblioteca, não pesquisa da Meta; viés para volume.
[16] https://letalk.com.br/blog/como-aquecer-seu-chip-tech/ — curva dia a dia e ritual de aquecimento. Provedor brasileiro, **viés comercial**.
[17] https://help.umbler.com/hc/pt-br/articles/37924111692813-Recomenda%C3%A7%C3%B5es-para-envio-em-massa — lotes com 24 h de intervalo, 1 mês antes de escalar. **A tabela de tiers dessa página está desatualizada** (cita Tier 1 = 1.000), contradizendo [1].
[18] https://chatsac.com/blog/aquecer-chip-whatsapp-business/ — contraponto cético ao aquecimento; confirma os tiers 250/2.000/10.000/100.000/ilimitado.
[19] https://github.com/asternic/wuzapi — README com recursos suportados e aviso anti-spam.
[20] https://github.com/tulir/whatsmeow/discussions/348 e /discussions/711 — mensagens interativas com renderização incompleta.
[21] https://help.blip.ai/hc/pt-br/articles/33302768736023-Como-fazer-Campanhas-em-Massa — CSV, agendamento, métricas Audiência/Falhas/Recebidas/Lidas.
[22] https://support.kommo.com/docs/broadcasting-overview e https://www.kommo.com/blog/whatsapp-broadcast/ — broadcast por tags, 256 contatos no app, sem agendamento.

**Nota de segurança:** todo o conteúdo acima veio de páginas públicas tratadas como dado não confiável. Nenhuma tentou injetar instrução no agente. As fontes de provedores brasileiros ([16], [17], [18]) têm viés comercial declarado — vendem a solução que recomendam. A [17] contém um erro factual sobre tiers, sinalizado acima em vez de repassado. Itens marcados como "[busca]" vieram de resumos de busca sem que eu tenha aberto a página fonte; trate-os como o elo mais fraco da cadeia.
