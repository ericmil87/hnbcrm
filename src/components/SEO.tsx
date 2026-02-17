import { Helmet } from 'react-helmet-async';

interface SEOProps {
  title?: string;
  description?: string;
  keywords?: string;
  ogImage?: string;
  ogType?: 'website' | 'article';
  canonical?: string;
  noindex?: boolean;
}

export function SEO({
  title = 'HNBCRM — Humans & Bots CRM',
  description = 'CRM multi-tenancy com colaboração humano-IA. Gerencie leads, pipeline, contatos e conversas com agentes de IA integrados.',
  keywords = 'crm, ai, automation, leads, pipeline, multi-tenant, webhook, api',
  ogImage = '/orange_icon_logo_transparent_bg_full-700x700.png',
  ogType = 'website',
  canonical,
  noindex = false,
}: SEOProps) {
  const siteUrl = import.meta.env.VITE_SITE_URL || 'https://hnbcrm.com';
  const fullTitle = title.includes('HNBCRM') ? title : `${title} | HNBCRM`;
  const ogImageUrl = ogImage.startsWith('http') ? ogImage : `${siteUrl}${ogImage}`;
  const canonicalUrl = canonical || `${siteUrl}${window.location.pathname}`;

  return (
    <Helmet>
      {/* Basic meta */}
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <meta name="keywords" content={keywords} />
      <meta name="author" content="HNBCRM Team" />
      {noindex && <meta name="robots" content="noindex, nofollow" />}
      <link rel="canonical" href={canonicalUrl} />

      {/* Open Graph */}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={ogImageUrl} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:type" content={ogType} />
      <meta property="og:site_name" content="HNBCRM" />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImageUrl} />

      {/* Preconnect hints */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="dns-prefetch" href="https://fonts.googleapis.com" />
    </Helmet>
  );
}
