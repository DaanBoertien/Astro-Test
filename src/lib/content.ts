import site from '../data/site.json';
import concerts from '../data/concerts.json';

// Load all page JSON files at build time
const pageModules = import.meta.glob('../data/pages/*.json', { eager: true });

export interface PageData {
  slug: string;
  title: Record<string, string>;
  showInNav: boolean;
  navOrder: number;
  sections: Section[];
}

export interface Section {
  id: string;
  type: string;
  content: Record<string, any>;
}

export interface SiteData {
  siteTitle: string;
  defaultLocale: string;
  locales: string[];
  localeNames: Record<string, string>;
  copyrightName: string;
  socialLinks: { label: string; url: string }[];
}

export interface Concert {
  date: string;
  venue: string;
  city: string;
  program: string;
}

export function loadSite(): SiteData {
  return site as SiteData;
}

export function loadConcerts(): Concert[] {
  return (concerts as { concerts: Concert[] }).concerts;
}

export function loadPages(): PageData[] {
  return Object.values(pageModules)
    .map((mod: any) => mod.default || mod)
    .sort((a: PageData, b: PageData) => a.navOrder - b.navOrder);
}

export function loadPage(slug: string): PageData | undefined {
  return loadPages().find(p => p.slug === slug);
}

/**
 * Get the localized text for a translatable field.
 * Falls back to the default locale if the requested locale is missing.
 */
export function t(
  field: Record<string, string> | string | undefined,
  locale: string
): string {
  if (!field) return '';
  if (typeof field === 'string') return field;
  const { defaultLocale } = loadSite();
  return field[locale] ?? field[defaultLocale] ?? '';
}

/**
 * Build navigation items from pages with showInNav: true
 */
export function getNavItems(locale: string) {
  const { defaultLocale } = loadSite();
  return loadPages()
    .filter(p => p.showInNav)
    .sort((a, b) => a.navOrder - b.navOrder)
    .map(p => {
      let href: string;
      if (locale === defaultLocale) {
        href = p.slug === '' ? '/' : `/${p.slug}`;
      } else {
        href = p.slug === '' ? `/${locale}` : `/${locale}/${p.slug}`;
      }
      return { href, label: t(p.title, locale) };
    });
}

/**
 * Build the path for a given page and locale
 */
export function pagePath(page: PageData, locale: string): string {
  const { defaultLocale } = loadSite();
  if (locale === defaultLocale) {
    return page.slug === '' ? '/' : `/${page.slug}`;
  }
  return page.slug === '' ? `/${locale}` : `/${locale}/${page.slug}`;
}

/**
 * Format a date string for display
 */
export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
