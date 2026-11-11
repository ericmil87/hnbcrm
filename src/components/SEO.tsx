import { Helmet } from 'react-helmet-async';

interface SEOProps {
  title?: string;
  description?: string;
  ogImage?: string;
  /** Preload the display font (Plus Jakarta Sans) for pages whose h1 uses it above the fold (avoids layout shift). */
  preloadDisplayFont?: boolean;
  ogType?: 'website' | 'article';
  canonical?: string;
  noindex?: boolean;
}

export function SEO({
  title = 'HNBCRM — Humans & Bots CRM',
  description = 'CRM multi-tenancy com colaboração humano-IA. Gerencie leads, pipeline, contatos e conversas com agentes de IA integrados.',
  // Neutral wordmark-only card: index.html is served for every route (client forms included), so the
  // default must never carry marketing copy. Pages that want the marketing image pass it explicitly.
  ogImage = '/og-neutral.png',
  ogType = 'website',
  canonical,
  noindex = false,
  preloadDisplayFont = false,
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

      {preloadDisplayFont && (
        <link rel="preload" href="/fonts/plus-jakarta-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      )}
    </Helmet>
  );
}
