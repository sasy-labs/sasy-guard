// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Sasy Guard',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/sasy-labs/sasy-guard',
        },
      ],
      sidebar: [
        {
          label: 'Claude Code',
          items: [
            { label: 'Enforce Policy on Claude Code', slug: 'claude-code' },
            { label: 'Why sasy-guard, not hooks?', slug: 'why-sasy-guard' },
          ],
        },
      ],
    }),
  ],
});
