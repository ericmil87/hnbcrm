import { Helmet } from 'react-helmet-async';
import { buildLandingJsonLd } from '@/lib/pricingJsonLd';

export function OrganizationStructuredData() {
  const siteUrl = import.meta.env.VITE_SITE_URL || 'https://hnbcrm.com';
  const structuredData = buildLandingJsonLd(siteUrl);

  return (
    <Helmet>
      <script type="application/ld+json">
        {JSON.stringify(structuredData)}
      </script>
    </Helmet>
  );
}
