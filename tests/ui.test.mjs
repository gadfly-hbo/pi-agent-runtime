import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ModelSettingsPanel} from '../dist/ui.js';
const settings={providers:[{id:'p',name:'My provider',baseUrl:'https://example.invalid/v1',protocol:'anthropic-messages',enabled:true,credentialSet:true,
  models:[{id:'m1',modelId:'primary',contextWindow:8192,maxOutputTokens:4,enabled:true},{id:'m2',modelId:'backup',contextWindow:8192,maxOutputTokens:4,enabled:true}]}],primary:'m1',fallbacks:['m2']};
test('U01: reusable UI renders the approved provider fields and main/backup selectors without runtime jargon',()=>{
  const html=renderToStaticMarkup(createElement(ModelSettingsPanel,{initialValue:settings,onSave:async()=>{}}));
  for(const text of ['Base URL','API 格式','API Key','模型列表','主模型','备用模型','最大输出 Token'])assert.ok(html.includes(text),text);
  assert.equal(html.includes('Worker'),false);assert.equal(html.includes('待生效'),false);
  assert.equal(html.includes('@earendil'),false);
});
test('U02: stored credentials are never rendered and testing is unavailable without a host callback',()=>{
  const html=renderToStaticMarkup(createElement(ModelSettingsPanel,{initialValue:settings,onSave:async()=>{},credentialEditing:false}));
  assert.ok(html.includes('由宿主管理'));
  assert.match(html,/aria-label="测试 [^"]+" disabled=""/);
  assert.equal(html.includes('type="password" value="synthetic'),false);
});
