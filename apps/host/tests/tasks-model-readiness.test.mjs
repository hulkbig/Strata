import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Render the real TasksScreen with mock app state and inert child components.
// No browser, host, HTTP request, timer, or engine is started.
const root=resolve(import.meta.dirname,'..');
const temp=mkdtempSync(join(tmpdir(),'tasks-readiness-'));
const reactPath=resolve(root,'node_modules/react/index.js');
const mocks={
'react':`export * from ${JSON.stringify(reactPath)}; import R from ${JSON.stringify(reactPath)}; export default R;
export const useEffect=()=>{}; export const useState=initial=>{const n=globalThis.__taskTest.index++;return [n===0?globalThis.__taskTest.tasks:n===5?globalThis.__taskTest.pending:n===7?true:initial,()=>{}]};`,
'../lib/i18n':`export const tr=x=>x;export const localeTag=()=> 'en-US';`,
'../lib/router':`export const useLocation=()=>globalThis.__taskTest.location;export const navigate=()=>{};`,
'../lib/store':`export const useStore=f=>f(globalThis.__taskTest);export const continueTaskInNewChat=()=>{};export const pushToast=()=>{};`,
'../lib/native':`export const useNative=()=>globalThis.__taskTest.native;`,
'../lib/client':`export const api=new Proxy({}, {get(){throw Error('Unexpected API access')}});`,
'../lib/tasks':`export const blankTask=()=>({});`,
'../components/ui':`import React from ${JSON.stringify(reactPath)};
export const Btn=({children,disabled,title})=>React.createElement('button',{disabled,title},children);
export const IconBtn=()=>null,Icon=()=>null,Select=()=>null,Seg=()=>null,Dialog=()=>null,ErrorNotice=()=>null;`,
'../components/layout':`import React from ${JSON.stringify(reactPath)};export const Screen=({children,actions})=>React.createElement('main',null,actions,children);`,
'../components/TaskBoard':`import React from ${JSON.stringify(reactPath)};export const TaskBoard=({canRun})=>React.createElement('button', {disabled:!canRun},'Board run');`,
'../components/TaskDetail':`export const TaskDetail=()=>null;`,
'../components/TaskEditor':`export const TaskEditor=()=>null;`,
'../components/Markdown':`export const Markdown=()=>null;`,
};
await build({entryPoints:[join(root,'src/screens/Tasks.tsx')],outfile:join(temp,'screen.mjs'),bundle:true,platform:'node',format:'esm',jsx:'automatic',external:[reactPath, 'react/jsx-runtime'],plugins:[{name:'mock-app',setup(b){b.onResolve({filter:/.*/},a=>mocks[a.path]?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js',resolveDir:root}));}}],alias:{'react/jsx-runtime':resolve(root,'node_modules/react/jsx-runtime.js')}});
const {TasksScreen}=await import(pathToFileURL(join(temp,'screen.mjs')));
for(const view of ['schedule','detail','board']) for(const model of ['native-ready','native-loading','no-model','legacy','stale-legacy']) for(const running of [false,true]) for(const pending of [false,true]) for(const enabled of [false,true]) {
 test(`${view}: ${model}, running=${running}, pending=${pending}, enabled=${enabled}`,()=>{
  const task={id:'t',title:'Fixture',prompt:'Task',enabled,status:running?'running':'idle',timeZone:'UTC'};
  globalThis.__taskTest={index:0,tasks:[task],pending,location:{param:view==='detail'?'t':undefined,query:new URLSearchParams(view==='board'?'view=board':'')},library:{loaded:model==='legacy'||model==='stale-legacy'?'m':null,variants:model==='legacy'?[{id:'m'}]:[]},native:{instances:model.startsWith('native')?[{id:'n',status:model==='native-ready'?'ready':'loading'}]:[]}};
  const html=renderToStaticMarkup(React.createElement(TasksScreen));
  const label=view==='board'?'Board run':running?'Stop':'Run now';
  const button=[...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find(m=>m[2]===label);
  assert.ok(button,html);
  const disabled=/\bdisabled/.test(button[1]);
  const ready=model==='native-ready'||model==='legacy';
  const expected=view==='board'?!ready:pending||(!running&&!ready);
  assert.equal(disabled,expected,html);
 });
}
process.on('exit',()=>{delete globalThis.__taskTest;rmSync(temp,{recursive:true,force:true});});
