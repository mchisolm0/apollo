const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  ...expoConfig,
  {
    ignores: ['.expo/*', 'dist/*'],
  },
  {
    // TypeScript already checks namespace members. The import plugin misses SDK 58
    // enums whose `export` follows a doc comment on the same line.
    files: ['**/*.ts', '**/*.tsx'],
    rules: { 'import/namespace': 'off' },
  },
]);
