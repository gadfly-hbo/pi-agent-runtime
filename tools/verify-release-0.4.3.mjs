// Offline promotion verification. Uses immutable archives and existing synthetic
// consumers/host fixtures; never installs dependencies or reads product state.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = resolve('.');
const directory = mkdtempSync(join(tmpdir(), 'pi-release-043-'));
const identities = [
  ['0.4.3', '475480217d5f644a15264b2f838e5567d3e2c2e431b8a23c061a0665dbdbfa70', 108617],
  ['0.4.2', 'f25371b12db238988c2a5beac85f81ff037782a30d5c09d778d570436f2f3c8d', 106189],
  ['0.4.1', '1ddace3a5b7ff97e80627dc4660d9f300ac402a4bfc67f43144380d3352d6da5', 102550],
];
assert.equal(process.argv.length, 5, 'Usage: node tools/verify-release-0.4.3.mjs <0.4.3.tgz> <0.4.2.tgz> <0.4.1.tgz>');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, expected = 0) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', timeout: 60000,
    env: {...process.env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true'}});
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return result.stdout;
}
const modules = join(directory, 'node_modules');
mkdirSync(modules);
for (const name of readdirSync(join(root, 'node_modules'))) {
  if (name !== '.bin') symlinkSync(join(root, 'node_modules', name), join(modules, name));
}
const packages = {};
const archives = {};
for (const [index, [version, hash, size]] of identities.entries()) {
  const archive = resolve(process.argv[index + 2]);
  const bytes = readFileSync(archive);
  assert.equal(bytes.length, size); assert.equal(sha256(bytes), hash);
  const entries = run('/usr/bin/tar', ['-tzf', archive]).trim().split('\n');
  assert.ok(entries.every(p => p.startsWith('package/') && !p.split('/').includes('..')));
  const target = join(directory, version); mkdirSync(target);
  run('/usr/bin/tar', ['-xzf', archive, '-C', target, '--strip-components=1']);
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'))).version, version);
  packages[version] = target; archives[version] = archive;
  if (version === '0.4.3') {
    for (const entry of entries) {
      const file = entry.slice('package/'.length);
      assert.equal(sha256(readFileSync(join(target, file))), sha256(readFileSync(join(root, file))), file);
    }
    assert.equal(entries.length, 49);
    console.log('FIXED_ARCHIVE_49_FILES_MATCH_SOURCE_BUILD');
  }
}

// Consume the exact fixed archive with the existing native, legacy, uncapped,
// and neutral-type consumer. Replace only the pack step, not its assertions.
let consumer = readFileSync(join(root, 'tools/verify-harness-package.mjs'), 'utf8');
const packStep = "const [packed]=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',directory]));";
assert.ok(consumer.includes(packStep));
consumer = consumer.replace(packStep, `const packed={filename:'pi-agent-runtime-0.4.3.tgz',files:new Array(49)};copyFileSync(${JSON.stringify(archives['0.4.3'])},join(directory,packed.filename));`);
const consumerFile = join(directory, 'fixed-consumer.mjs'); writeFileSync(consumerFile, consumer);
process.stdout.write(run(process.execPath, [consumerFile]));

// The approved MT/UC tests now import the fixed archive, not the source tree.
const packedTests = ['mimo-thinking.test.ts', 'cached-context.test.ts'].map(name => {
  let source = readFileSync(join(root, 'tests', name), 'utf8');
  for (const module of ['index', 'settings']) source = source.replaceAll(`'../src/${module}.ts'`, JSON.stringify(pathToFileURL(join(packages['0.4.3'], 'dist', module + '.js')).href));
  const file = join(directory, name); writeFileSync(file, source); return file;
});
process.stdout.write(run(process.execPath, ['--experimental-strip-types', '--test', ...packedTests]));

// Existing persistent synthetic host fixtures, only changing the SDK import.
// Each invocation is a separate process. There is no production SQLite adapter.
function fixture(version, kind) {
  const file = join(directory, `${version}-${kind}.mjs`);
  const source = readFileSync(join(root, 'tests/fixtures', kind + '-process.mjs'), 'utf8');
  assert.ok(source.includes("'../../src/index.ts'"));
  writeFileSync(file, source.replace("'../../src/index.ts'", JSON.stringify(pathToFileURL(join(packages[version], 'dist/index.js')).href)));
  return file;
}
const compatibility = [];
for (const previous of ['0.4.1', '0.4.2']) {
  for (const kind of ['session', 'uncapped']) {
    const stateRoot = join(directory, `${previous}-${kind}-state`); mkdirSync(stateRoot);
    const oldFixture = fixture(previous, kind), nextFixture = fixture('0.4.3', kind);
    const child = (file, mode, exit = 0) => {
      const output = run(process.execPath, ['--experimental-strip-types', file, stateRoot, mode], exit);
      return exit === 0 ? JSON.parse(output) : undefined;
    };
    const first = child(oldFixture, 'first'); assert.equal(first.status, 'succeeded');
    const ledger = join(stateRoot, kind === 'session' ? 'host-ledger.json' : 'ledger.json');
    const readState = () => JSON.parse(readFileSync(ledger, 'utf8'));
    const before = readState();
    const second = child(nextFixture, 'second'); assert.equal(second.status, 'succeeded');
    assert.equal(second.value, 'consumed 73');
    const after = readState();
    assert.equal(after.taskId, before.taskId); assert.equal(after.configuration, before.configuration);
    assert.equal(after.usage.modelCalls, before.usage.modelCalls + 1);
    assert.equal(after.usage.toolCalls, before.usage.toolCalls);
    assert.ok(after.usage.activeMs >= before.usage.activeMs);
    if (kind === 'uncapped') {
      assert.equal(after.usage.inputTokens, before.usage.inputTokens + 3);
      assert.equal(after.usage.outputTokens, before.usage.outputTokens + 2);
      assert.equal(child(nextFixture, 'fork').value, 'consumed 73');
      // Old archive crashes after physical admission. New archive must retain UNKNOWN.
      child(oldFixture, 'crash', 81);
      const crashed = readState(); assert.equal(crashed.usage.reservedOutputTokens, 4);
      assert.equal(crashed.configuration, before.configuration);
      assert.equal(child(nextFixture, 'recover').reason, 'TASK_BUSY');
      // Reconcile only this synthetic, confirmed-dead child ownership, as UB14 does.
      crashed.usage.activeMs += Date.now() - crashed.started;
      delete crashed.owner; delete crashed.started; writeFileSync(ledger, JSON.stringify(crashed));
      unlinkSync(join(stateRoot, 'budget.lock')); unlinkSync(join(stateRoot, 'writer.lock'));
      const physical = readFileSync(join(stateRoot, 'physical.jsonl'), 'utf8');
      const effects = readFileSync(join(stateRoot, 'effects.jsonl'), 'utf8');
      const recovered = child(nextFixture, 'recover'); assert.equal(recovered.reason, 'STATE_FAILED');
      for (const field of ['modelCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'reservedOutputTokens']) {
        assert.equal(recovered.usage[field], crashed.usage[field], field);
      }
      assert.equal(readFileSync(join(stateRoot, 'physical.jsonl'), 'utf8'), physical);
      assert.equal(readFileSync(join(stateRoot, 'effects.jsonl'), 'utf8'), effects);
    }
    compatibility.push({from: previous, to: '0.4.3', mode: kind, sameTask: true, sameConfiguration: true,
      storedToolResultConsumed: true, cumulativeHistoryPreserved: true,
      hardExitUnknownNoReplay: kind === 'uncapped' ? true : 'covered by source suite'});
  }
}
console.log(JSON.stringify({status: 'PASS', physicalProviderRequests: 0, compatibility}));
