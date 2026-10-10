import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const ADMIN_SECRET = 'test-admin-secret';
// Satisfies wrangler's required-secrets check when there is no .dev.vars.
process.env.ADMIN_SECRET = ADMIN_SECRET;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Wins over a developer's .dev.vars.
      miniflare: { bindings: { ADMIN_SECRET } },
    }),
  ],
});
