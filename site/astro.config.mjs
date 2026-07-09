import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Site URL: Cloudflare Pages default subdomain until a custom domain lands.
// Update here (single place) when the domain is decided.
export default defineConfig({
  site: 'https://gamepricemap.pages.dev',
  integrations: [sitemap()],
  trailingSlash: 'ignore',
});
