import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

// Seed npm's standard lock from the producer's exact dependency identities.
// npm ci prunes unrelated entries; it needs cached tar bytes, not mutable registry metadata.
export function installFixedConsumer(root,directory,selected,command,ui=false){
 const source=readFileSync(join(root,'package-lock.json'));
 const lock=JSON.parse(source),bytes=readFileSync(selected);
 const packed=spawnSync('/usr/bin/tar',['-xOf',selected,'package/package.json'],{encoding:'utf8'});assert.equal(packed.status,0,packed.stderr);
 const sdk=JSON.parse(packed.stdout);
 const dependencies={'pi-agent-runtime':'file:'+selected,'@types/node':'24.10.1',typescript:'5.9.3',
  ...(ui?{react:'19.3.0','react-dom':'19.3.0','@types/react':'19.3.0'}:{})};
 const manifest={name:'pi-fixed-consumer',version:'1.0.0',private:true,type:'module',dependencies};
 lock.name=manifest.name;lock.version=manifest.version;lock.packages['']={name:manifest.name,version:manifest.version,dependencies};
 lock.packages['node_modules/pi-agent-runtime']={version:sdk.version,resolved:'file:'+selected,
  integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),dependencies:sdk.dependencies,
  peerDependencies:sdk.peerDependencies,peerDependenciesMeta:sdk.peerDependenciesMeta,engines:sdk.engines};
 writeFileSync(join(directory,'package.json'),JSON.stringify(manifest,null,2)+'\n');
 const consumerLock=JSON.stringify(lock,null,2)+'\n';writeFileSync(join(directory,'package-lock.json'),consumerLock);
 command(['ci','--offline','--ignore-scripts','--no-audit','--no-fund'],directory);
 assert.equal(readFileSync(join(directory,'package-lock.json'),'utf8'),consumerLock,'npm ci changed the locked tree');
 for(const [path,entry]of Object.entries(lock.packages)){
  if(!path||!existsSync(join(directory,path,'package.json')))continue;
  assert.equal(lstatSync(join(directory,path)).isSymbolicLink(),false,'Isolated install must not link producer dependencies');
  assert.equal(JSON.parse(readFileSync(join(directory,path,'package.json'),'utf8')).version,entry.version,path);
 }
 return{producerLockSha256:createHash('sha256').update(source).digest('hex'),consumerLockSha256:createHash('sha256').update(consumerLock).digest('hex'),installation:'locked npm ci --offline',optionalUi:ui};
}
