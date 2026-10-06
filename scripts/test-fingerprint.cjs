const assert = require('node:assert/strict');
const path = require('node:path');
const { createFingerprintAsync } = require('expo/fingerprint');

const root = path.resolve(__dirname, '..');
process.env.APOLLO_APP_VARIANT = 'development';

async function fingerprint(transform) {
  return createFingerprintAsync(root, {
    platforms: ['ios'],
    silent: true,
    fileHookTransform: (source, chunk) => source.type === 'file' && chunk
      ? transform(source.filePath, chunk)
      : chunk,
  });
}

async function main() {
  const baseline = await fingerprint((_, chunk) => chunk);
  const relocated = await fingerprint((file, chunk) => file.includes('/node_modules/.bin/')
    ? Buffer.from(`${chunk}\n# Different build machine\n`)
    : chunk);
  assert.equal(relocated.hash, baseline.hash, 'Generated launchers must not change runtime compatibility');
  const nativeChange = await fingerprint((file, chunk) => file === 'modules/apollo-markdown-text/ios/T3MarkdownText.mm'
    ? Buffer.from(`${chunk}\n// Native source change\n`)
    : chunk);
  assert.notEqual(nativeChange.hash, baseline.hash, 'Native source must remain fingerprinted');
  console.log('PASS: generated launchers are ignored; native source changes affect the fingerprint');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
