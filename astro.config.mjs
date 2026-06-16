// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://ishtiaque05.github.io',
  base: '/blog/',
  markdown: {
    shikiConfig: {
      // Dual themes: emitted with CSS variables so we can switch by data-theme.
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
      wrap: true,
    },
  },
});
