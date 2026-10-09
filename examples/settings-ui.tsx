import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ModelSettingsPanel} from '../src/ui.tsx';
import type {ModelSettings} from '../src/settings.ts';
import '../src/ui.css';
const initialValue:ModelSettings={providers:[{id:'synthetic',name:'示例 Provider',baseUrl:'https://example.invalid/v1',protocol:'openai-completions',enabled:true,credentialSet:true,
  models:[{id:'primary',modelId:'primary-demo',contextWindow:8192,maxOutputTokens:4,enabled:true},{id:'backup',modelId:'backup-demo',contextWindow:8192,maxOutputTokens:4,enabled:true}]}],primary:'primary',fallbacks:['backup']};
function Preview(){
  const [result,setResult]=useState('');
  return <><p className="preview-note">合成宿主 · 不调用 Provider · 不输入真实密钥</p><ModelSettingsPanel initialValue={initialValue} credentialEditing={false}
    onSave={async(value,credentials)=>{
      if(credentials.length)throw new Error('No credentials in synthetic host');
      const response=await fetch('/configuration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
      if(!response.ok)throw new Error('Rejected');setResult(JSON.stringify(await response.json(),null,2));
    }} onTestModel={async()=>{}}/>
    {result&&<details className="preview-results" open><summary>合成宿主执行结果</summary><pre role="status">{result}</pre></details>}</>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
