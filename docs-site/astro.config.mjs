// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'SASY Policy Translation and Enforcement Demo',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/sasy-labs/sasy-demo',
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Quick Start', slug: 'quickstart' },
            { label: 'Translate a Policy', slug: 'translate' },
          ],
        },
        {
          label: 'Claude Code',
          items: [
            { label: 'Enforce Policy on Claude Code', slug: 'claude-code' },
            { label: 'Why sasy-guard, not hooks?', slug: 'why-sasy-guard' },
          ],
        },
        {
          label: 'Policy',
          items: [
            { label: 'Policy Walkthrough', slug: 'policy/walkthrough' },
            { label: 'Confidence Report (experimental)', slug: 'policy/confidence' },
          ],
        },
        {
          label: 'Demo',
          items: [
            { label: 'Scenarios', slug: 'demo/scenarios' },
            { label: 'How Enforcement Works', slug: 'demo/enforcement' },
          ],
        },
        {
          label: 'Benchmarks',
          items: [
            { label: 'Tau2 Airline', slug: 'benchmarks/tau2-airline' },
          ],
        },
      ],
    }),
  ],
});
