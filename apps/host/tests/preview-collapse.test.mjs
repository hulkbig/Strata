// Exercise the real Chat callbacks and store mutations without starting a host or engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const chatText = readFileSync(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8');
const storeText = readFileSync(new URL('../src/lib/store.ts', import.meta.url), 'utf8');
const chat = ts.createSourceFile('Chat.tsx', chatText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const store = ts.createSourceFile('store.ts', storeText, ts.ScriptTarget.Latest, true);
const declarations = new Map();
const callbacks = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText());
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    const name = node.tagName.getText();
    if (['ChatToolbar', 'ArtifactPanel', 'TimeSkipPanel'].includes(name)) {
      const attr = node.attributes.properties.find(a => a.name?.getText() === 'onClose');
      if (attr?.initializer && ts.isJsxExpression(attr.initializer)) callbacks.push({ name, expression: attr.initializer.expression.getText() });
    }
  }
  ts.forEachChild(node, visit);
}
visit(chat);
visit(store);
const js = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function harness(expression, sessions, activeId) {
  const session = sessions.find(s => s.id === activeId);
  let selected = session?.previewOpen ?? null;
  let expanded = true;
  let saved = JSON.stringify(sessions);
  const storeState = { sessions };
  const persistSessions = next => { saved = JSON.stringify(next); };
  const set = next => { Object.assign(storeState, next); sessions = storeState.sessions; };
  // Compile actual function bodies; no store import, timers, network or browser globals.
  const names = ['patchSession', 'setPreviewTabClosed', 'collapsePreview', 'closePreview'];
  const source = names.filter(n => declarations.has(n)).map(n => declarations.get(n).replace(/^export /, '')).join('\n');
  const actions = new Function('state', 'persistSessions', 'set', 'session', 'setSelectedPreview', 'setExpanded', js(`
    ${source}
    return { execute: () => (${expression})(), reopen: (id) => setPreviewTabClosed(session?.id, id, false, id) };
  `))(storeState, persistSessions, set, session, v => { selected = v; }, v => { expanded = v; });
  return { ...actions, state: () => ({ sessions, selected, expanded, restored: JSON.parse(saved) }) };
}

assert.equal(callbacks.length, 5, 'all regular and setup preview close entries are covered');
for (const [index, callback] of callbacks.entries()) {
  test(`${callback.name} close entry ${index}: collapse survives reconstruction without closing tabs`, () => {
    const original = [{ id: 'a', previewOpen: 'file:a', closedPreviews: ['old'], messages: [{ artifacts: [{ id: 'file:a' }, { id: 'file:b' }] }] }, { id: 'b', previewOpen: 'file:other' }];
    const h = harness(callback.expression, original, 'a');
    h.execute();
    const state = h.state();
    assert.equal(state.selected, null);
    assert.equal(state.restored[0].previewOpen, undefined);
    assert.deepEqual(state.restored[0].closedPreviews, ['old']);
    assert.deepEqual(state.restored[0].messages, original[0].messages);
    assert.equal(state.restored[1].previewOpen, 'file:other', 'switching back to another chat keeps its selection');
    const other = harness(callback.expression, state.restored, 'b');
    assert.equal(other.state().selected, 'file:other');
    const reconstructed = harness(callback.expression, other.state().restored, 'a');
    assert.equal(reconstructed.state().selected, null, 'new component/session state stays collapsed');
    h.execute();
    assert.deepEqual(h.state().restored, state.restored, 'repeated collapse is harmless');
    h.reopen('file:a');
    assert.equal(h.state().restored[0].previewOpen, 'file:a', 'explicit reopen is persisted');
  });
}

for (const previewOpen of ['time-skip:run-1', 'plan:a']) {
  test(`collapse also preserves ${previewOpen} tab data`, () => {
    const initial = [{ id: 'a', previewOpen, messages: [], timeSkips: [{ id: 'run-1' }] }];
    const h = harness(callbacks[0].expression, initial, 'a');
    h.execute();
    assert.deepEqual(h.state().restored, [{ id: 'a', messages: [], timeSkips: [{ id: 'run-1' }] }]);
    assert.equal(h.state().expanded, false);
    h.reopen(previewOpen);
    assert.equal(h.state().restored[0].previewOpen, previewOpen);
  });
}

test('closing with no active session creates no chat and does not change another chat', () => {
  const initial = [{ id: 'other', previewOpen: 'file:other' }];
  const h = harness(callbacks[0].expression, initial, undefined);
  h.execute();
  assert.equal(h.state().selected, null);
  assert.deepEqual(h.state().restored, initial);
});
