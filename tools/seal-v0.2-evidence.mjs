// Local release evidence only. No Provider, git, service, or credential access.
import {readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=dirname(dirname(fileURLToPath(import.meta.url))),evidence=join(root,'artifacts/runtime-ui-v0.2');
const files=[];
function collect(path){
  const stat=lstatSync(path);assert.equal(stat.isSymbolicLink(),false);
  if(stat.isDirectory()){for(const name of readdirSync(path).sort())collect(join(path,name));return;}
  if(path.endsWith('/evidence-manifest.json')||path.endsWith('/seal.log'))return;
  const bytes=readFileSync(path);files.push({path:relative(root,path),byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
for(const path of ['src','tests','tools','examples','docs','package.json','package-lock.json','tsconfig.json','tsconfig.build.json','README.md','THIRD_PARTY_NOTICES.md','artifacts/runtime-ui-v0.2'])collect(join(root,path));
const manifest={version:'0.2.0',device:'MacBook',piVersion:'0.86.1',status:'local-candidate-not-published',providerCalls:'none',files};
writeFileSync(join(evidence,'evidence-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const independent=JSON.parse(readFileSync(join(evidence,'evidence-manifest.json'),'utf8'));
for(const file of independent.files){const bytes=readFileSync(join(root,file.path));assert.equal(bytes.length,file.byteLength);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);}
for(const name of ['desktop.jpg','narrow.jpg','add-model.jpg','final-execution.txt','final-desktop.jpg','final-narrow.jpg','final-ui.jpg']){
  assert.deepEqual(readFileSync(join(evidence,name)),readFileSync(join('/private/tmp/pi-shared-ui-jJVG9Q',name)));
}
console.log(JSON.stringify({filesVerified:files.length,copiedBrowserEvidence:7,piVersion:'0.86.1',manifest:join(evidence,'evidence-manifest.json'),sourceSnapshot:join(evidence,'candidate-source.tar.gz')}));
