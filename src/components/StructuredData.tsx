import { Helmet } from 'react-helmet-async';

export function OrganizationStructuredData() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "HNBCRM",
    "applicationCategory": "BusinessApplication",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "BRL"
    },
    "operatingSystem": "Web",
    "description": "CRM multi-tenancy com colaboração humano-IA. Gerencie leads, pipeline, contatos e conversas com agentes de IA integrados, com central de atendimento opcional (setores, filas e painel com CAC e ROAS) e tradução automática de mensagens para atendimento multilíngue.",
  };

  return (
    <Helmet>
      <script type="application/ld+json">
        {JSON.stringify(structuredData)}
      </script>
    </Helmet>
  );
}
