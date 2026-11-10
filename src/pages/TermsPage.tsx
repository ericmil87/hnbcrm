import { Link } from "react-router";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SEO } from "@/components/SEO";
import { Footer } from "@/components/landing/Footer";
import { LegalIdentification } from "@/components/landing/LegalIdentification";
import { formatCount, formatMoney } from "@/lib/format";
import { LEGAL_ENTITY } from "@/lib/legalEntity";
import { EXTRA_CHANNEL_BRL, GROUPS_ADDON_BRL, PACK, PLAN_KEYS, PLANS, TRIAL } from "../../convex/lib/plans";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";

const EFFECTIVE_DATE = "10 de novembro de 2026";

const brl = (v: number) => formatMoney(v, "BRL", { fractionDigits: 0 });

function LegalSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-3 scroll-mt-24">
      <h2 className="text-xl md:text-2xl font-bold text-text-primary">{title}</h2>
      <div className="space-y-3 text-text-secondary leading-relaxed">{children}</div>
    </section>
  );
}

export function TermsPage() {
  return (
    <>
      <SEO
        title="Termos de Uso e Assinatura"
        description="Termos de Uso e Assinatura do HNBCRM: planos, atendimentos de IA, excedente, teste, troca de plano, cancelamento, reembolso de 7 dias, só leitura, WhatsApp não oficial e proteção de dados."
        keywords="termos de uso, termos de assinatura, hnbcrm, planos, reembolso, whatsapp, saas"
      />
      <div className="min-h-screen bg-surface-base text-text-primary">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-surface-base/85 backdrop-blur-md border-b border-border">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <Link to="/" className="flex items-center gap-2">
              <BrandLogo className="h-7 w-7 object-contain" />
              <span className="text-lg font-bold text-text-primary">HNBCRM</span>
            </Link>
            <div className="flex items-center gap-1">
              <PublicThemeButton />
              <Link to="/">
                <Button variant="ghost" size="sm">
                  <ArrowLeft size={16} />
                  Voltar
                </Button>
              </Link>
            </div>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-4 py-10 md:py-16">
          {/* Title */}
          <div className="mb-10 space-y-2">
            <h1 className="text-3xl md:text-4xl font-bold text-text-primary">Termos de Uso e Assinatura</h1>
            <p className="text-sm text-text-muted">Vigência: {EFFECTIVE_DATE}</p>
          </div>

          <div className="space-y-10">
            <p className="text-text-secondary leading-relaxed">
              Estes Termos de Uso e Assinatura ("Termos") regem o acesso e o uso da plataforma HNBCRM
              ("HNBCRM", "plataforma" ou "serviço"), um CRM multi-tenant com colaboração entre humanos e
              agentes de IA, oferecido como serviço por assinatura (SaaS). Ao criar uma conta ou utilizar
              o serviço, você declara ter lido, compreendido e aceito estes Termos. Caso não concorde, não
              utilize a plataforma.
            </p>

            <LegalSection id="objeto" title="1. Objeto e fornecedor">
              <p>
                O HNBCRM disponibiliza ferramentas de gestão de relacionamento com clientes: pipeline de
                vendas, gestão de contatos e leads, caixa de entrada multicanal, repasses entre humanos e
                IA, calendário, automações de comunicação, API REST, servidor MCP e webhooks. Os recursos
                disponíveis variam conforme o plano contratado.
              </p>
              <p>O serviço é fornecido por:</p>
              <LegalIdentification className="block not-italic text-sm text-text-secondary" />
              <p>
                Estes Termos, o plano escolhido e a{" "}
                <Link to="/privacidade" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Política de Privacidade
                </Link>{" "}
                formam o contrato entre você e o fornecedor.
              </p>
            </LegalSection>

            <LegalSection id="conta" title="2. Conta e cadastro">
              <p>
                O uso do serviço exige a criação de uma conta. Você é responsável por manter a
                confidencialidade das suas credenciais e por todas as atividades realizadas na sua conta e
                na sua organização. Você concorda em fornecer informações verdadeiras e mantê-las
                atualizadas, e em notificar imediatamente qualquer uso não autorizado.
              </p>
              <p>
                Administradores de uma organização são responsáveis pelos membros que convidam, pelas
                permissões que concedem e pelas chaves de API e integrações que configuram. O acesso é
                nominal: contas compartilhadas para contornar o plano podem levar à revisão da assinatura.
              </p>
              <p>
                Quem cria a organização aceita estes Termos em nome dela e declara ter poderes para isso.
                O aceite fica registrado com a versão, a data e a hora.
              </p>
            </LegalSection>

            <LegalSection id="uso-aceitavel" title="3. Uso aceitável">
              <p>Ao utilizar o HNBCRM, você concorda em não:</p>
              <ul className="list-disc list-inside space-y-1.5">
                <li>Violar leis aplicáveis, incluindo a legislação de proteção de dados e anti-spam;</li>
                <li>
                  Enviar comunicações não solicitadas em massa, mensagens fraudulentas ou conteúdo ilícito
                  a titulares que não consentiram com o contato. O recurso de Campanhas exige, a cada
                  disparo, a declaração de que a organização possui base legal para contatar a lista;
                  a plataforma aplica automaticamente a lista de supressão (pedidos de não contato) e
                  limites de envio, mas a responsabilidade pelo consentimento é da organização;
                </li>
                <li>Tentar comprometer a segurança, a integridade ou a disponibilidade da plataforma;</li>
                <li>Acessar dados de outras organizações ou contornar o isolamento multi-tenant;</li>
                <li>Utilizar o serviço para finalidades que infrinjam direitos de terceiros.</li>
              </ul>
              <p>
                Você é o único responsável pelo conteúdo e pelos dados que insere, importa ou processa por
                meio do HNBCRM, bem como pela obtenção das bases legais necessárias para tratá-los.
              </p>
            </LegalSection>

            <LegalSection id="planos" title="4. Planos, franquias e atendimento IA">
              <p>
                Os planos são {PLAN_KEYS.map((k) => PLANS[k].label).join(", ")}, com usuários ilimitados em
                todos. Cada plano inclui canais, atendimentos IA por mês e envios de campanha, conforme a
                tabela abaixo; os recursos de cada plano estão na{" "}
                <Link to="/precos" className="text-brand-400 hover:text-brand-300 transition-colors">
                  página de preços
                </Link>
                .
              </p>
              <ul className="list-disc list-inside space-y-1.5 tabular-nums">
                {PLAN_KEYS.map((k) => {
                  const p = PLANS[k];
                  return (
                    <li key={k}>
                      {p.label}: {k === "empresa" ? `a partir de ${brl(p.monthlyBrl)} mais ${brl(p.perUnitBrl ?? 0)} por unidade` : brl(p.monthlyBrl)} por mês,{" "}
                      {p.channels === "perUnit" ? "1 canal por unidade" : `${p.channels} ${p.channels === 1 ? "canal" : "canais"}`},{" "}
                      {formatCount(p.aiAttendances)} atendimentos IA
                      {p.aiAttendancesPerUnit ? ` mais ${formatCount(p.aiAttendancesPerUnit)} por unidade` : ""} e{" "}
                      {formatCount(p.campaignSends)} envios de campanha por mês.
                    </li>
                  );
                })}
              </ul>
              <p>
                Canal extra: {brl(EXTRA_CHANNEL_BRL)} por mês cada. O plano {PLANS.essencial.label} comporta
                até {PLANS.essencial.maxExtraChannels} canais extras e o {PLANS.profissional.label}, até{" "}
                {PLANS.profissional.maxExtraChannels}; para mais canais, é preciso um plano maior. O add-on Grupos do plano Essencial custa{" "}
                {brl(GROUPS_ADDON_BRL)} por mês. O pacote de {formatCount(PACK.attendances)} atendimentos
                é contratado falando com a gente. As mudanças na tabela não alteram os contratos em curso.
              </p>
              <p id="atendimento-ia">
                <span className="text-text-primary font-medium">Atendimento IA</span> é um contato distinto
                que a IA atendeu (respondeu ou rascunhou resposta) no mês calendário. O mesmo contato
                atendido várias vezes no mês conta uma vez. Conversas só da equipe, grupos e campanhas não
                contam. Conversar com o Copiloto não conta. Um rascunho que você ou o Copiloto pedem à IA
                para um contato conta como atendimento dentro da franquia, nunca como excedente. O medidor do painel "Uso e fatura" é a referência, e você pode
                contestar um valor em até 30 dias.
              </p>
              <p id="excedente">
                <span className="text-text-primary font-medium">Excedente.</span> Quando a franquia acaba, a
                IA passa a só sugerir respostas e a sua equipe envia; nada é cobrado além do plano. O
                excedente só é cobrado se você o ligar e escolher um teto mensal em reais. Ao chegar no
                teto, a IA volta a só sugerir. Avisamos em 80% e 100% da franquia, e a ativação e o teto
                ficam registrados com data e autor.
              </p>
              <p>
                <span className="text-text-primary font-medium">Terceiros.</span> A API oficial da Meta e a
                chave de IA própria são cobradas direto de você pelo fornecedor, sem margem nossa.
              </p>
            </LegalSection>

            {/* WhatsApp unofficial channel — dedicated risk section */}
            <section id="whatsapp-nao-oficial" className="scroll-mt-24">
              <div className="rounded-xl border border-semantic-warning/40 bg-semantic-warning/10 p-5 md:p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={20} className="text-semantic-warning shrink-0" />
                  <h2 className="text-xl md:text-2xl font-bold text-text-primary">
                    5. Canal WhatsApp não oficial (bridge)
                  </h2>
                </div>
                <div className="space-y-3 text-text-secondary leading-relaxed">
                  <p>
                    O HNBCRM permite conectar o WhatsApp por dois transportes distintos. O primeiro é a{" "}
                    <span className="text-text-primary font-medium">WhatsApp Cloud API oficial (Meta)</span>
                    , aprovada pela Meta e sujeita às suas regras (janela de atendimento de 24 horas e
                    templates de mensagem). O segundo é um{" "}
                    <span className="text-text-primary font-medium">gateway não oficial ("bridge")</span>,
                    auto-hospedado pela organização, que se conecta ao WhatsApp por leitura de QR code
                    utilizando um protocolo não sancionado pela Meta.
                  </p>
                  <p className="text-text-primary font-medium">
                    O uso do canal bridge é opcional, ativado voluntariamente por organização (opt-in) e se
                    dá inteiramente por sua conta e risco. Ao habilitá-lo, você reconhece e concorda que:
                  </p>
                  <ul className="list-disc list-inside space-y-1.5">
                    <li>
                      O canal bridge utiliza um protocolo não autorizado pela Meta e{" "}
                      <span className="text-text-primary font-medium">
                        viola os Termos de Serviço do WhatsApp
                      </span>
                      ;
                    </li>
                    <li>
                      O número de WhatsApp conectado por esse meio{" "}
                      <span className="text-text-primary font-medium">
                        pode ser banido permanentemente
                      </span>
                      , sem aviso prévio e sem possibilidade de recurso;
                    </li>
                    <li>
                      Você assume integralmente o risco de banimento, perda de acesso, perda de dados de
                      conversas e quaisquer prejuízos decorrentes do uso desse canal;
                    </li>
                    <li>
                      O HNBCRM não se responsabiliza por banimentos, indisponibilidade, perda de acesso ao
                      número ou qualquer dano resultante do uso do canal não oficial.
                    </li>
                  </ul>
                  <p>Recomendações para reduzir — mas não eliminar — o risco:</p>
                  <ul className="list-disc list-inside space-y-1.5">
                    <li>
                      Utilize um número dedicado e descartável, nunca o número principal do seu negócio;
                    </li>
                    <li>
                      Não dispare mensagens para desconhecidos ou listas frias — é o principal gatilho de
                      banimento;
                    </li>
                    <li>
                      Faça o aquecimento gradual do número e respeite limites de envio (rate limiting);
                    </li>
                    <li>Contate apenas titulares que consentiram em receber suas mensagens.</li>
                  </ul>
                  <p>
                    A responsabilidade por operar o gateway auto-hospedado, pela infraestrutura e pela
                    conformidade legal do uso desse canal é exclusivamente da organização que o habilita.
                  </p>
                </div>
              </div>
            </section>

            <LegalSection id="instagram-messenger" title="5-A. Instagram e Facebook Messenger">
              <p>
                Os canais Instagram e Messenger usam as APIs oficiais da Meta e dependem das{" "}
                <a
                  href="https://developers.facebook.com/terms/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-400 hover:text-brand-300 transition-colors"
                >
                  Políticas da Plataforma Meta
                </a>
                . Só é possível responder dentro da janela de atendimento de 24 horas após a última mensagem
                da pessoa (7 dias quando a conversa vem de um anúncio). Não é permitido enviar mensagens
                frias nem iniciar conversas por esses canais.
              </p>
              <p>
                Enquanto o aplicativo não for aprovado pela Meta (App Review), a disponibilidade fica
                restrita a contas que tenham papel no aplicativo.
              </p>
            </LegalSection>

            <LegalSection id="traducao-automatica" title="5-B. Tradução automática">
              <p>
                A tradução automática de mensagens é um recurso opcional, desligado por padrão, que só um
                administrador da organização pode ativar. Ela gera uma versão da mensagem em outro idioma
                para a equipe ler e, se a organização assim configurar, para o cliente receber. A tradução
                é automática e pode conter imprecisões: o texto original sempre é mantido, e a organização
                é responsável por revisar o que envia aos seus clientes.
              </p>
              <p>
                O HNBCRM usa primeiro um mecanismo de tradução hospedado na infraestrutura da organização
                e, na falta dele, o provedor de modelo de linguagem configurado por ela. Notas internas e
                grupos de WhatsApp não são traduzidos.
              </p>
            </LegalSection>

            <LegalSection id="grupos-whatsapp" title="6. Grupos de WhatsApp">
              <p>
                O HNBCRM permite acompanhar grupos de WhatsApp do número conectado pelo canal bridge. O
                recurso é opcional e depende de duas ativações independentes: habilitar grupos no número,
                mediante aceite expresso de um administrador, e marcar individualmente cada grupo como
                acompanhado.
              </p>
              <p>
                <span className="text-text-primary font-medium">
                  Somente os grupos marcados como acompanhados
                </span>{" "}
                têm a lista de participantes e o conteúdo das mensagens armazenados na plataforma. Dos
                demais grupos de que o número participa guardamos apenas o nome da sala, a quantidade de
                participantes e a data da última atividade — nome e telefone de membros não são gravados.
                Ao deixar de acompanhar um grupo, a lista de participantes é apagada e a conversa é
                arquivada; excluir o canal remove os dados das salas daquele número.
              </p>
              <p>
                <span className="text-text-primary font-medium">Mídia dos grupos:</span> você define, por
                número e, se quiser, por grupo, quais tipos de arquivo (imagens, áudios, vídeos e
                documentos) são baixados: sempre, nunca ou somente quando a mensagem é dirigida à sua
                empresa (menção ao número, resposta a uma mensagem dela ou palavra-chave do assistente de
                IA da sala) — esta é a configuração padrão. O arquivo não baixado não é armazenado; ficam
                apenas o tipo, o nome e o tamanho, e o download sob demanda permanece disponível por até
                14 (quatorze) dias. Ao optar por baixar sempre, você reconhece que passará a armazenar — e,
                se a transcrição de áudio ou a leitura de imagens por IA estiverem ativas, a processar —
                arquivos de terceiros que não se dirigiram à sua empresa, cuja base legal é de sua
                responsabilidade, nos termos abaixo. A plataforma pode remover arquivos de mídia de grupos já armazenados para
                liberar espaço, mantendo a mensagem no histórico.
              </p>
              <p>Ao acompanhar um grupo, você reconhece e concorda que:</p>
              <ul className="list-disc list-inside space-y-1.5">
                <li>
                  Os participantes de um grupo são terceiros que podem nunca ter contatado a sua empresa.
                  Cabe a você, na condição de controlador, definir, documentar e manter a base legal para
                  tratar o nome, o telefone e as mensagens dessas pessoas, nos termos da Lei nº
                  13.709/2018 (LGPD). O HNBCRM atua como operador, tratando esses dados conforme as suas
                  instruções;
                </li>
                <li>
                  Os webhooks e a API que você configurar podem transmitir a sistemas externos de sua
                  escolha os identificadores dos participantes (JID e LID do WhatsApp), seus telefones e o
                  conteúdo das mensagens da sala. A escolha desses destinos, a segurança deles e a
                  conformidade legal dessa transmissão são de sua exclusiva responsabilidade;
                </li>
                <li>
                  Os recursos de IA em grupos — resumo da sala, resumo diário, radar de oportunidade e
                  respostas quando o número é mencionado — enviam o conteúdo das mensagens ao provedor de
                  modelo de linguagem configurado para a sua organização, nas mesmas condições aplicáveis
                  aos demais recursos de IA da plataforma. Esses recursos são opcionais, vêm desligados e
                  só podem ser ativados por um administrador; permitir que a IA publique na sala sem
                  revisão humana exige um aceite adicional e específico;
                </li>
                <li>
                  O envio de mensagens individuais para membros de grupos exige a declaração, a cada
                  disparo, de que você possui base legal e o consentimento necessário para contatá-los. A
                  plataforma aplica automaticamente limites de envio por grupo e por período e a lista de
                  supressão (pedidos de não contato), mas a responsabilidade pelo consentimento, pelo
                  conteúdo e por eventual caracterização de spam permanece sua. Realizado pelo canal não
                  oficial, esse tipo de disparo é o principal gatilho do banimento descrito na cláusula 5,
                  cujo risco você assume integralmente;
                </li>
                <li>
                  As requisições de titulares (confirmação, acesso, correção ou eliminação) relativas a
                  membros de grupos devem ser atendidas por você. O HNBCRM disponibiliza os meios para
                  isso: deixar de acompanhar o grupo apaga a lista de participantes e excluir o canal
                  remove os dados das salas associadas.
                </li>
              </ul>
            </LegalSection>

            <LegalSection id="teste" title="7. Teste gratuito, preço, reajuste e preço de fundador">
              <p>
                <span className="text-text-primary font-medium">Teste gratuito.</span> Quem cria uma
                organização recebe {TRIAL.days} dias do plano {PLANS[TRIAL.plan].label}, com{" "}
                {formatCount(TRIAL.aiAttendances)} atendimentos IA, sem informar cartão e sem cobrança
                automática ao fim. É permitido um teste por pessoa; criar contas para obter novos testes é
                abuso e pode levar ao encerramento. Ao fim do teste, a conta passa a só leitura (cláusula 8)
                até a contratação de um plano.
              </p>
              <p id="reajuste">
                <span className="text-text-primary font-medium">Preço e reajuste.</span> Os preços são em
                reais e constam da{" "}
                <Link to="/precos" className="text-brand-400 hover:text-brand-300 transition-colors">
                  página de preços
                </Link>
                . O preço contratado não muda durante os primeiros 12 meses. Depois, o valor pode ser
                reajustado uma vez por ano pela variação do IPCA, ou por nova tabela, com aviso de 30
                dias por e-mail e direito de cancelar sem multa antes de o novo valor valer.
              </p>
              <p>
                <span className="text-text-primary font-medium">Preço de fundador.</span> Os 20 primeiros
                novos pagantes têm 30% de desconto sobre a tabela por 12 meses corridos, contados do
                primeiro pagamento. Ao fim desse prazo, o plano segue na tabela vigente, e perde o desconto
                quem ficar inadimplente além do prazo da cláusula 8 ou cancelar.
              </p>
            </LegalSection>

            <LegalSection id="inadimplencia" title="8. Pagamento, atraso e modo só leitura">
              <p>
                O pagamento é feito por meio de cobrança enviada por e-mail (Pix, boleto ou cartão), e
                emitimos nota fiscal a cada pagamento. Em caso de atraso, avisamos por e-mail. Se o atraso
                passar de 7 dias, a conta{" "}
                <span className="text-text-primary font-medium">poderá ser colocada em modo só leitura</span>
                , por decisão nossa, caso a caso: a equipe continua vendo tudo e exportando os dados, mas a
                IA e o envio de mensagens e campanhas ficam pausados. As mensagens que chegarem continuam
                sendo gravadas. Pagando o valor em aberto, o acesso volta.
              </p>
              <p>
                Nunca apagamos dados por atraso de pagamento. Em caso de multa e juros por atraso, valem os
                limites da lei.
              </p>
            </LegalSection>

            <LegalSection id="exportacao" title="9. Exportação dos dados e portabilidade">
              <p>
                Você pode exportar os dados da organização a qualquer momento, inclusive com a conta em
                só leitura, com o teste encerrado ou em atraso. Guardamos os dados por 90 dias após o
                cancelamento ou o fim do teste não contratado, para que você exporte; depois disso eles
                podem ser eliminados, com aviso prévio, salvo obrigação legal. Os dados que você insere continuam sendo seus.
              </p>
            </LegalSection>

            <LegalSection id="cancelamento" title="10. Troca de plano, cancelamento e reembolso">
              <p id="troca-de-plano">
                <span className="text-text-primary font-medium">Troca de plano.</span> Você troca de plano
                pelo painel "Uso e fatura". No upgrade, cobramos hoje o valor cheio do novo plano e um novo
                ciclo começa hoje, sem crédito proporcional dos dias restantes do ciclo atual; o plano muda
                quando o pagamento for confirmado. No downgrade, a troca vale a partir da próxima renovação
                e, até lá, você continua no plano atual. Dá para desfazer um downgrade agendado antes da
                data.
              </p>
              <p>
                <span className="text-text-primary font-medium">Cancelamento.</span> Você pode cancelar a
                qualquer momento pelo painel "Uso e fatura", sem multa e sem fidelidade. A assinatura não é
                renovada e o acesso vale até o fim do período já pago; depois a conta passa para modo
                leitura, com a exportação dos dados liberada. Antes do fim do período você pode reativar a
                assinatura, sem cobrança no ato. Se preferir, também atendemos pedidos de cancelamento por
                e-mail, em{" "}
                <a
                  href={`mailto:${LEGAL_ENTITY.email}`}
                  className="text-brand-400 hover:text-brand-300 transition-colors"
                >
                  {LEGAL_ENTITY.email}
                </a>
                . Podemos encerrar o serviço por violação destes Termos, abuso, fraude ou exigência legal,
                com aviso prévio de 30 dias, salvo nos casos graves.
              </p>
              <p id="reembolso">
                <span className="text-text-primary font-medium">Reembolso de 7 dias.</span> Para todos os
                clientes, devolvemos o valor integral do primeiro pagamento se você pedir em até 7 dias
                corridos depois dele, sem precisar explicar o motivo. Pelo painel, quando houver um único
                pagamento, o reembolso é automático, pelo mesmo meio de pagamento, e a conta passa para
                modo leitura. Nos demais casos (por exemplo, depois de uma troca de plano), fale com a
                gente e devolvemos o primeiro pagamento. As renovações não são reembolsáveis, salvo
                exigência legal. Ficam
                fora dessa garantia serviços de implantação já executados a seu pedido, atendimentos extras
                já consumidos e taxas de terceiros (Meta, provedor de IA). O serviço é contratado para uso
                profissional; essa garantia é uma liberalidade nossa e, quando o Código de Defesa do
                Consumidor se aplicar ao seu caso, nada aqui reduz os direitos que ele garante.
              </p>
            </LegalSection>

            <LegalSection id="ia" title="11. Inteligência artificial">
              <p>
                As respostas geradas por IA podem conter erros. Você define a persona, os horários e os
                repasses para a equipe, e responde pelo conteúdo enviado aos seus contatos. A IA é opcional
                e só funciona depois de ativada por um administrador. É proibido usá-la para spam ou
                finalidade ilícita. O conteúdo necessário à resposta é enviado ao provedor de modelo de
                linguagem configurado, conforme a{" "}
                <Link to="/privacidade" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Política de Privacidade
                </Link>
                .
              </p>
            </LegalSection>

            <LegalSection id="propriedade" title="12. Propriedade intelectual e licença de uso">
              <p>
                O software é licenciado para uso como serviço durante a vigência da assinatura. Esta
                assinatura não transfere código nem direitos de propriedade intelectual. A marca, o nome, o
                logotipo e os elementos de identidade visual "HNBCRM" não são licenciados para uso fora do
                serviço.
              </p>
              <p>
                Os dados que você insere na plataforma permanecem seus. Você concede ao HNBCRM apenas as
                permissões necessárias para operar o serviço em seu nome.
              </p>
            </LegalSection>

            <LegalSection id="sla" title="13. Disponibilidade e suporte">
              <p>
                Trabalhamos para manter o serviço disponível, mas a disponibilidade é uma meta, não uma
                garantia: ela depende de provedores como infraestrutura de nuvem, Meta e meios de
                pagamento. Avisamos por e-mail os incidentes relevantes. O suporte é feito por e-mail em{" "}
                <a
                  href={`mailto:${LEGAL_ENTITY.email}`}
                  className="text-brand-400 hover:text-brand-300 transition-colors"
                >
                  {LEGAL_ENTITY.email}
                </a>{" "}
                em todos os planos e, a partir do plano {PLANS.profissional.label}, também por WhatsApp.
              </p>
              <p>
                O uso de mensagens, contatos, funis e leads não tem limite de quantidade nos planos, desde
                que dentro de um uso razoável da plataforma.
              </p>
            </LegalSection>

            <LegalSection id="limitacao" title="14. Limitação de responsabilidade">
              <p>
                O serviço é fornecido "conforme disponível". Na máxima extensão permitida pela lei
                aplicável, a responsabilidade total do HNBCRM por qualquer reclamação fica limitada ao
                valor que você pagou nos 12 meses anteriores ao fato, e não respondemos por danos indiretos
                ou lucros cessantes, incluindo as perdas relacionadas ao canal WhatsApp não oficial da
                cláusula 5. Isso não exclui a responsabilidade por vício do serviço que a lei não permita
                excluir.
              </p>
            </LegalSection>

            <LegalSection id="lgpd" title="15. Proteção de dados e suboperadores">
              <p>
                Em relação aos dados dos seus contatos e leads, a sua organização é a controladora e o
                HNBCRM é operador, tratando os dados conforme as suas instruções. Para operar o serviço
                contamos com suboperadores: infraestrutura de backend (Convex), hospedagem do front
                (Vercel), envio de e-mails (Resend), provedores de IA configurados, Meta (canais oficiais)
                e meio de pagamento (Asaas). A lista completa e os demais detalhes estão na{" "}
                <Link to="/privacidade" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Política de Privacidade
                </Link>
                . O encarregado de dados atende em{" "}
                <a
                  href={`mailto:${LEGAL_ENTITY.dpoEmail}`}
                  className="text-brand-400 hover:text-brand-300 transition-colors"
                >
                  {LEGAL_ENTITY.dpoEmail}
                </a>
                .
              </p>
            </LegalSection>

            <LegalSection id="alteracoes" title="16. Alterações destes Termos">
              <p>
                Podemos atualizar estes Termos. Avisamos por e-mail e no aplicativo com 30 dias de
                antecedência, e quem discordar pode cancelar sem multa. Mudanças materiais (preço,
                franquias, reembolso, tratamento de dados) exigem o seu aceite ativo, e continuar usando o
                serviço não vale como aceite delas. Mudanças não materiais (correções, esclarecimentos
                e ajustes de redação) valem com o aviso prévio.
              </p>
            </LegalSection>

            <LegalSection id="foro" title="17. Aceite eletrônico, lei e foro">
              <p>
                O aceite destes Termos é feito por meio eletrônico, ao marcar a caixa de aceite no cadastro
                ou ao clicar em aceitar quando há uma nova versão. As partes reconhecem como válidos o registro do aceite
                (versão, data e hora) e os demais meios eletrônicos de comprovação (MP 2.200-2/2001, art. 10,
                § 2º). Estes Termos são regidos pelas leis da República Federativa do Brasil. Fica eleito o
                foro da comarca do domicílio do consumidor, quando houver relação de consumo, e, nos demais
                casos, o foro da comarca do domicílio do fornecedor.
              </p>
            </LegalSection>

            <LegalSection id="contato" title="18. Contato">
              <p>
                Dúvidas, cancelamento e pedidos de reembolso: {" "}
                <a
                  href={`mailto:${LEGAL_ENTITY.email}`}
                  className="text-brand-400 hover:text-brand-300 transition-colors"
                >
                  {LEGAL_ENTITY.email}
                </a>
                . Veja também a nossa{" "}
                <Link to="/privacidade" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Política de Privacidade
                </Link>
                .
              </p>
            </LegalSection>
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
}
