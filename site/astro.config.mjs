import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://willcoliveira.github.io',
  base: '/mac-cleanup-agent',
  trailingSlash: 'always',
  integrations: [sitemap()],
});
