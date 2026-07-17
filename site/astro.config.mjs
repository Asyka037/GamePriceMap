import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://gamepricemap.com',
  integrations: [sitemap({
    // This route is a convenient alias for the current month. Its canonical
    // month page is indexed instead so search engines do not see duplicates.
    filter: (page) => !page.endsWith('/new-releases/'),
  })],
  trailingSlash: 'ignore',
});
