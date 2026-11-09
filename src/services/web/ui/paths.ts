/**
 * Every page address the dashboard answers to.
 *
 * Data only, because two very different programs need it: the server, to tell a
 * page from a 404, and the browser, to route. Addresses are fixed strings on
 * purpose. Which conversation or tenant is open lives in memory and never in the
 * address, since a customer's phone number must not reach a URL
 * (AGENTS.md, "Conversations are read in exactly one place").
 */

export const PAGE_AREAS = ['public', 'client', 'operator'] as const;
export type PageArea = (typeof PAGE_AREAS)[number];

export const PAGES = {
  '/login': 'public',
  '/signup': 'public',
  '/verify-email': 'public',
  '/forgot-password': 'public',
  '/reset-password': 'public',
  '/operator/login': 'public',
  '/': 'client',
  '/whatsapp': 'client',
  '/persona': 'client',
  '/rules': 'client',
  '/knowledge': 'client',
  '/fallback': 'client',
  '/disclosure': 'client',
  '/handoff': 'client',
  '/preview': 'client',
  '/conversations': 'client',
  '/account': 'client',
  '/operator': 'operator',
  '/operator/account': 'operator',
} as const satisfies Readonly<Record<string, PageArea>>;

export type PagePath = keyof typeof PAGES;

export function isPagePath(path: string): path is PagePath {
  return Object.hasOwn(PAGES, path);
}
