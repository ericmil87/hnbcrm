import { Helmet } from 'react-helmet-async';
import { useLocation } from 'react-router';

/** Both share cards are 1200x630 (scripts/generate-brand-assets.mjs). */
const KNOWN_CARDS = new Set(['/og-neutral.png', '/og-image.png']);

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
  // Router location instead of `window`: the same component renders at build time (prerender).
  const { pathname } = useLocation();
  const canonicalUrl = canonical || `${siteUrl}${pathname}`;

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
      <meta property="og:locale" content="pt_BR" />
      {KNOWN_CARDS.has(ogImage) && <meta property="og:image:width" content="1200" />}
      {KNOWN_CARDS.has(ogImage) && <meta property="og:image:height" content="630" />}

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
