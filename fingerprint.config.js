/** @type {import('expo/fingerprint').Config} */
module.exports = {
  sourceSkips: ['PackageJsonScriptsAll', 'GitIgnore'],
  // pnpm launchers contain machine-specific paths, including in local modules.
  ignorePaths: ['**/node_modules/.bin/**'],
  // These package.json options configure the native markdown library at build time.
  extraSources: [{
    type: 'contents',
    id: 'enriched-markdown-config',
    contents: JSON.stringify(require('./package.json')['enriched-markdown']),
    reasons: ['Native markdown build options'],
  }],
};
