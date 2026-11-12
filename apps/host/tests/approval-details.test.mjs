// #5856: approval Details must not use the shortened shell-command summary.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { presentTool } from '../server/agent/events.mjs';

const root = resolve(import.meta.dirname, '..');
const bundle = await build({
  stdin: { contents: `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { ApprovalCard } from './src/components/ApprovalCard.tsx'; export const html = tool => renderToStaticMarkup(React.createElement(ApprovalCard, {messageId:'message', tool})); export const tree = tool => ApprovalCard({messageId:'message', tool}); export { calls } from './src/lib/store';`, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{ name: 'isolated-ui', setup(b) {
    b.onResolve({ filter: /(?:lib\/store|^\.\/ui$|^\.\/QuestionCard$|lib\/i18n)$/ }, a => ({ path: a.path.endsWith('store') ? 'store' : a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: a.path.endsWith('store')
      ? 'export const calls=[]; export const resolveTool=(...args)=>calls.push(args); export const useStore=()=>{throw Error("Dock not part of this test")};'
      : a.path.endsWith('i18n') ? 'export const tr=(s,p=[])=>s.replace(/\\{(\\d+)\\}/g,(_,i)=>p[i]??_);'
      : a.path.endsWith('ui') ? 'export const Btn=({children})=>children; export const Icon=()=>null;'
      : 'export const QuestionCard=()=>null;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const {html, tree, calls} = mod.exports;
const escape = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
const tool = (name, command, ask=true) => ({...presentTool({callId:'call',name,args:{command}}), state:'proposed', ...(ask?{}:{ask:undefined})});
for (const name of ['bash','pwsh']) for (const ask of [true,false]) {
  test(`${name} full command survives projection and both detail layouts (ask=${ask})`, () => {
    const command=Array.from({length:13},(_,i)=>`echo 'step-${i} ${'x'.repeat(80)}'`).join(';\r\n')+';\nGet-Date # 最後 <script> & "quoted"';
    const t=tool(name,command,ask);
    assert.equal(t.preview.length,600);
    assert.ok(!t.preview.includes('Get-Date'));
    assert.ok(html(t).includes(escape(command)));
    assert.ok(!html(t).includes('<script>'));
    assert.equal(t.args.command,command);
    assert.equal(t.preview.length,600);
  });
}
for (const ask of [true,false]) {
  test(`legacy/malformed commands fall back; empty strings remain exact (ask=${ask})`, () => {
    for (const args of [undefined,{}, {command:null}, {command:42}, {command:{text:'wrong'}}]) {
      const t={...tool('bash','unused',ask), args, preview:'old preview'};
      assert.ok(html(t).includes('old preview'));
    }
    const t={...tool('bash','',ask),preview:'not the command'};
    assert.ok(!html(t).includes('not the command'));
  });
  test(`non-command tools retain preview (ask=${ask})`, () => {
    for(const name of ['job_list','job_output','job_kill','write','mcp__unknown']) {
      const t={...tool(name,'private command field',ask),preview:'existing preview'};
      assert.ok(html(t).includes('existing preview'));
      assert.ok(!html(t).includes('private command field'));
    }
  });
  test(`approval callbacks preserve IDs and decisions (ask=${ask})`, () => {
    calls.length=0;
    const visit = node => {
      if (!node || typeof node!=='object') return;
      if(node.props?.onClick) node.props.onClick();
      for(const child of [node.props?.children].flat(Infinity)) visit(child);
    };
    visit(tree(tool('pwsh','Write-Output "hello"',ask)));
    assert.deepEqual(calls,[['message','call',false],['message','call',true]]);
  });
}
