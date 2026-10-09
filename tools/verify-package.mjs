import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'pi-sdk-consumer-'));
const cache = join(root, '.npm-cache');
function command(args, cwd = root) {
  const result = spawnSync('npm', args, {cwd, encoding: 'utf8', env: {...process.env, npm_config_cache: cache, npm_config_ignore_scripts: 'true'}, timeout: 60000});
  if (result.status !== 0) throw new Error(`npm command failed: ${result.stderr || result.error?.message || result.stdout}`);
  return result.stdout;
}
const [packed] = JSON.parse(command(['pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
assert.equal(packed.files.some(file => file.path.startsWith('artifacts/')), false);
assert.equal(packed.files.some(file => file.path.startsWith('node_modules/')), false);
// A separate consumer chooses its own exact compiler/types; producer lockfiles do not propagate.
command(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false', '--prefix', directory,
  join(directory, packed.filename), '@types/node@24.10.1', 'typescript@5.9.3']);
assert.equal(existsSync(join(directory,'node_modules/react')),false,'Core consumer must not require optional UI peer');
copyFileSync(join(root, 'examples/package-consumer.mjs'), join(directory, 'consumer.mjs'));
copyFileSync(join(root, 'examples/package-consumer.ts'), join(directory, 'consumer.mts'));
const types = spawnSync(process.execPath, [join(directory, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2023', '--types', 'node', 'consumer.mts'],
  {cwd: directory, encoding: 'utf8', timeout: 30000});
assert.equal(types.status, 0, types.stdout + types.stderr);
const result = spawnSync(process.execPath, [join(directory, 'consumer.mjs')], {cwd: directory, encoding: 'utf8', timeout: 10000});
assert.equal(result.status, 0, result.stderr); process.stdout.write(result.stdout);
command(['install','--offline','--ignore-scripts','--no-audit','--no-fund','--no-save','--package-lock=false','--prefix',directory,
  join(directory,packed.filename),'@types/node@24.10.1','typescript@5.9.3','react@19.3.0','react-dom@19.3.0','@types/react@19.3.0']);
copyFileSync(join(root,'examples/settings-consumer.mjs'),join(directory,'settings-consumer.mjs'));
const uiResult=spawnSync(process.execPath,[join(directory,'settings-consumer.mjs')],{cwd:directory,encoding:'utf8',timeout:10000});
assert.equal(uiResult.status,0,uiResult.stderr);process.stdout.write(uiResult.stdout);
const installed = join(directory, 'node_modules/pi-agent-runtime/dist');
for (const file of readdirSync(installed).filter(file => file.endsWith('.d.ts'))) {
  assert.equal(readFileSync(join(installed, file), 'utf8').includes('@earendil-works/'), false, `Pi type leaked in ${file}`);
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const delivery = join(root, 'artifacts/releases', version); mkdirSync(delivery, {recursive: true});
const bytes = readFileSync(join(directory, packed.filename));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const retained = join(delivery, `${sha256}-${packed.filename}`);
copyFileSync(join(directory, packed.filename), retained);
console.log(JSON.stringify({pack: packed.filename, files: packed.files.length, publicTypes: 'neutral', installation: 'offline', sha256, byteLength: bytes.length,
  retainedPack: retained, disposableConsumer: directory}));
