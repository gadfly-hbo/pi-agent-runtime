import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';
test('R09: exact Pi dependencies and lockfile contain no coding-agent', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(packageJson.dependencies, {'@earendil-works/pi-ai': '0.86.1', '@earendil-works/pi-agent-core': '0.86.1'});
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, packageJson.dependencies);
  for (const name of ['pi-ai', 'pi-agent-core']) assert.equal(lock.packages[`node_modules/@earendil-works/${name}`].version, '0.86.1');
  assert.equal(Object.keys(lock.packages).some(path => path.includes('/pi-coding-agent')), false);
});
test('R07: only the internal Pi Adapter may import Pi; public types do not leak it', () => {
  for (const name of readdirSync(new URL('../src/', import.meta.url))) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    if (name !== 'pi-adapter.ts') assert.equal(source.includes('@earendil-works/'), false, name);
  }
});
