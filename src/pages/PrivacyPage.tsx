import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SEO } from "@/components/SEO";
import { Footer } from "@/components/landing/Footer";

const EFFECTIVE_DATE = "19 de julho de 2026";

function LegalSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-3 scroll-mt-24">
      <h2 className="text-xl md:text-2xl font-bold text-text-primary">{title}</h2>
      <div className="space-y-3 text-text-secondary leading-relaxed">{children}</div>
    </section>
  );
}

export function PrivacyPage() {
  return (
    <>
      <SEO
        title="Política de Privacidade"
        description="Política de Privacidade do HNBCRM — quais dados tratamos, como atuamos como operador em nome da sua organização, o canal WhatsApp e seus direitos sob a LGPD."
        keywords="política de privacidade, lgpd, proteção de dados, hnbcrm, privacidade"
      />
      <div className="min-h-screen bg-surface-base text-text-primary">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-surface-base/80 backdrop-blur-md border-b border-border">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <Link to="/" className="flex items-center gap-2">
              <img
                src="/orange_icon_logo_transparent-bg-528x488.png"
                alt="HNBCRM Logo"
                className="h-7 w-7 object-contain"
              />
              <span className="text-lg font-bold text-text-primary">HNBCRM</span>
            </Link>
            <Link to="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft size={16} />
                Voltar
              </Button>
            </Link>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-4 py-10 md:py-16">
          {/* Title */}
          <div className="mb-10 space-y-2">
            <h1 className="text-3xl md:text-4xl font-bold text-text-primary">Política de Privacidade</h1>
            <p className="text-sm text-text-muted">Vigência: {EFFECTIVE_DATE}</p>
          </div>

          <div className="space-y-10">
            <p className="text-text-secondary leading-relaxed">
              Esta Política de Privacidade descreve como o HNBCRM trata dados pessoais em conformidade com a
              Lei Geral de Proteção de Dados (Lei nº 13.709/2018 — "LGPD"). Ela explica quais dados são
              coletados, com quais finalidades, o papel do HNBCRM no tratamento e os direitos dos titulares.
            </p>

            <LegalSection id="papeis" title="1. Papéis no tratamento de dados">
              <p>
                O HNBCRM atua de duas formas distintas. Em relação aos dados de cadastro e de conta dos
                usuários da plataforma, atuamos como{" "}
                <span className="text-text-primary font-medium">controlador</span>. Em relação aos dados de
                contatos, leads e conversas que cada organização insere e processa na plataforma, atuamos
                como <span className="text-text-primary font-medium">operador</span>, tratando esses dados{" "}
                em nome e sob as instruções da organização, que é a controladora desses dados.
              </p>
              <p>
                Cada organização é responsável por definir as bases legais, obter os consentimentos
                necessários e atender às requisições dos titulares dos dados que ela insere no HNBCRM.
              </p>
            </LegalSection>

            <LegalSection id="dados-coletados" title="2. Dados que tratamos">
              <p>
                <span className="text-text-primary font-medium">Dados de conta:</span> nome, e-mail,
                credenciais de acesso (armazenadas de forma protegida), organização à qual o usuário
                pertence, papel e permissões, além de registros de auditoria das ações realizadas na
                plataforma.
              </p>
              <p>
                <span className="text-text-primary font-medium">
                  Dados processados em nome da organização:
                </span>{" "}
                informações de contatos e leads (como nome, telefone, e-mail, empresa e campos
                personalizados), histórico de conversas e mensagens, tarefas, eventos de calendário e
                metadados relacionados ao atendimento.
              </p>
              <p>
                <span className="text-text-primary font-medium">Dados técnicos:</span> informações mínimas
                necessárias ao funcionamento e à segurança do serviço, como registros de acesso e uso de
                chaves de API.
              </p>
            </LegalSection>

            <LegalSection id="finalidades" title="3. Finalidades">
              <p>
                Tratamos dados para: fornecer e operar a plataforma; autenticar usuários e controlar
                acessos; permitir a gestão de leads, contatos e conversas; possibilitar integrações via API,
                MCP e webhooks; manter a segurança e a rastreabilidade (logs de auditoria); e cumprir
                obrigações legais e regulatórias.
              </p>
            </LegalSection>

            <LegalSection id="whatsapp" title="4. Canais de mensagem e WhatsApp">
              <p>
                Quando uma organização conecta o WhatsApp, as mensagens trafegam pelo transporte configurado
                por ela. No caso da{" "}
                <span className="text-text-primary font-medium">Cloud API oficial (Meta)</span>, o tráfego
                ocorre pela infraestrutura da Meta, sujeita às políticas dela. No caso do{" "}
                <span className="text-text-primary font-medium">gateway não oficial ("bridge")</span>, as
                mensagens trafegam pelo gateway auto-hospedado e configurado pela própria organização,
                estando sob responsabilidade dela.
              </p>
              <p>
                O conteúdo das conversas é armazenado na plataforma como parte do histórico de atendimento da
                organização. O uso do canal não oficial envolve riscos descritos nos nossos{" "}
                <Link to="/termos" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Termos de Uso
                </Link>
                .
              </p>
            </LegalSection>

            <LegalSection id="armazenamento" title="5. Armazenamento e infraestrutura">
              <p>
                Os dados da plataforma são armazenados e processados na infraestrutura da Convex, provedor de
                backend em tempo real utilizado pelo HNBCRM. As credenciais sensíveis de integrações (como
                tokens de canais) são armazenadas de forma criptografada.
              </p>
            </LegalSection>

            <LegalSection id="compartilhamento" title="6. Compartilhamento com terceiros">
              <p>
                Compartilhamos dados apenas com prestadores de serviço estritamente necessários à operação
                da plataforma (por exemplo, a infraestrutura de backend e o serviço de envio de e-mails
                transacionais), e com as plataformas de mensagem que cada organização opta por integrar. Não
                comercializamos dados pessoais.
              </p>
            </LegalSection>

            <LegalSection id="retencao" title="7. Retenção">
              <p>
                Os dados são mantidos enquanto a conta e a organização estiverem ativas e pelo tempo
                necessário para cumprir as finalidades descritas ou obrigações legais. Encerrada a conta, os
                dados podem ser excluídos ou anonimizados, ressalvadas as hipóteses de guarda obrigatória
                previstas em lei.
              </p>
            </LegalSection>

            <LegalSection id="direitos" title="8. Direitos do titular">
              <p>
                Nos termos da LGPD, o titular pode solicitar: confirmação da existência de tratamento;
                acesso aos dados; correção de dados incompletos ou desatualizados; anonimização, bloqueio ou
                eliminação de dados desnecessários; portabilidade; informação sobre compartilhamentos; e
                revogação de consentimento.
              </p>
              <p>
                Quando os dados são tratados pelo HNBCRM na qualidade de operador em nome de uma organização,
                as requisições devem ser direcionadas à organização controladora, que poderá acioná-lo como
                operador para atendê-las.
              </p>
            </LegalSection>

            <LegalSection id="seguranca" title="9. Segurança">
              <p>
                Adotamos medidas técnicas e organizacionais razoáveis para proteger os dados, incluindo
                isolamento estrito por organização (multi-tenant), controle de acesso baseado em permissões,
                autenticação por chave de API com hashing e criptografia de credenciais sensíveis. Nenhum
                sistema é totalmente imune a riscos; incidentes relevantes serão tratados conforme a
                legislação aplicável.
              </p>
            </LegalSection>

            <LegalSection id="alteracoes" title="10. Alterações desta Política">
              <p>
                Esta Política pode ser atualizada periodicamente. Alterações relevantes serão comunicadas por
                meios razoáveis, e a data de vigência no topo desta página será atualizada.
              </p>
            </LegalSection>

            <LegalSection id="contato" title="11. Contato">
              <p>
                Para exercer direitos ou esclarecer dúvidas sobre esta Política, utilize os canais de contato
                indicados no repositório do projeto. Consulte também os nossos{" "}
                <Link to="/termos" className="text-brand-400 hover:text-brand-300 transition-colors">
                  Termos de Uso
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
