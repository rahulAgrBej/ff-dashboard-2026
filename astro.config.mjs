// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),

  // The markdown reports used to be the whole site and lived at /reports/**.
  // They are now the secondary archive surface, so those paths are kept as
  // redirects rather than dropped — they are the URLs already shared, and the
  // report identity behind them (season/week/slug) is unchanged, so the
  // mapping is a pure path rewrite with no lookup.
  redirects: {
    '/reports': '/archive',
    '/reports/[season]/[week]/[slug]': '/archive/[season]/[week]/[slug]',
  },
});
