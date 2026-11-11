/** #5806: execute the production queue and selection effects against the real store, with mocked transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createChatStore } from '../server/chat-store.mjs';
import { installFakeHostFetch } from './helpers/fake-host-chats.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

async function bundle(entry, plugins = []) {
  const result = await build({
    entryPoints: [here(entry)], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    alias: { react: here('./helpers/react-stub.mjs') }, loader: { '.json': 'json' }, plugins,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

test('#5806 parked messages wait for their own selected chat, including stale effects and repeated navigation', async () => {
  const hostDir = mkdtempSync(join(tmpdir(), 'strata-5806-host-'));
  const chatStore = createChatStore({ dir: hostDir });
  const fakeHost = installFakeHostFetch(chatStore);
  try {
    globalThis.window ??= globalThis;
    globalThis.location ??= { hash: '#/chat' };
    globalThis.document ??= { addEventListener() {}, hasFocus: () => true, visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } };
    const memory = new Map();
    globalThis.localStorage = {
      get length() { return memory.size; },
      key: (i) => [...memory.keys()][i] ?? null,
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => { memory.set(k, v); },
      removeItem: (k) => memory.delete(k),
    };
    globalThis.navigator ??= { language: 'en' };
    globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    globalThis.__streams = [];
    const mockClient = {
      name: 'mock-client',
      setup(b) {
        b.onResolve({ filter: /\/client$/ }, () => ({ path: 'mock-client', namespace: 'mock' }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
          loader: 'js',
          contents: `
            export class ApiError extends Error {}
            const reject = async () => { throw new Error('offline'); };
            export const api = { get: reject, post: async () => ({}), put: reject, patch: reject, del: reject, delete: reject };
            export function onEvent() { return () => {}; }
            export async function streamPost(path, body, onFrame) {
              await new Promise((release) => globalThis.__streams.push({ body, onFrame, release }));
            }`,
        }));
      },
    };
    const store = await bundle('../src/lib/store.ts', [mockClient]);
    await store.loadChatsFromHost();   // the first read of the host's chats (the page's own start-up does this inside bootstrap)
    const wait = async (n) => { for (let i = 0; i < 200 && globalThis.__streams.length < n; i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(globalThis.__streams.length >= n, `stream ${n} started`); };

    const source = ts.createSourceFile('Chat.tsx', readFileSync(here('../src/screens/Chat.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const effects = [];
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') effects.push(node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    // Execute the callbacks from the source so this test also fails on the pre-fix effect.
    // This isolates effect ordering; it does not simulate React rendering or a browser.
    const queueEffect = effects.find(text => /takeParked|sendParked/.test(text));
    const selectionEffect = effects.find(text => text.includes('selectSession(session.id)'));
    assert.ok(queueEffect && selectionEffect);
    const render = (session) => {
      const activeId = store.useStore(s => s.activeSession);
      const streaming = store.useStore(s => s.streaming);
      const parked = store.useStore(s => s.parked[session.id]);
      const registered = [];
      new Function('useEffect', 'session', 'activeId', 'streaming', 'parked', 'takeParked', 'sendMessage', 'sendParked', 'selectSession', 'setDraft', 'sessionStorage', 'draftKey', queueEffect + ';' + selectionEffect)(
        (run, deps) => registered.push({ run, deps }), session, activeId, streaming, parked,
        store.takeParked, store.sendMessage, store.sendParked, store.selectSession, () => {}, { getItem: () => null }, session.id);
      return registered;
    };
    const a = store.newSession();
    store.parkMessage(a.id, 'queued A one');
    store.parkMessage(a.id, 'queued A two');
    const b = store.newSession();
    // Route points to A before the later selection effect catches up with it.
    const first = render(a);
    first[0].run();
    assert.deepEqual(store.useStore(s => s.sessions.find(s => s.id === b.id).messages), [], 'the old effect must not send A’s message to B');
    assert.deepEqual(store.useStore(s => s.parked[a.id]), ['queued A one', 'queued A two'], 'navigation must not dequeue into B');
    assert.equal(globalThis.__streams.length, 0);
    assert.equal(store.useStore(s => s.activeSession), b.id, 'draining must not select a chat');
    first[1].run();
    const selected = render(a);
    assert.notDeepEqual(selected[0].deps, first[0].deps, 'selection alone must rerun the queue effect');
    // A callback captured while A was selected must also recheck the current store.
    store.selectSession(b.id);
    selected[0].run();
    assert.deepEqual(store.useStore(s => s.parked[a.id]), ['queued A one', 'queued A two']);
    store.selectSession(a.id);
    render(a)[0].run();
    await wait(1);
    const one = globalThis.__streams[0];
    assert.equal(one.body.sessionId, a.id);
    selected[0].run(); // stale idle snapshot: the store must still refuse a second send while busy
    render(a)[0].run();
    assert.deepEqual(store.useStore(s => s.parked[a.id]), ['queued A two'], 'a running turn holds the second message');
    one.onFrame({ type: 'done' }); one.release();
    for (let i = 0; i < 200 && store.useStore(s => s.streaming); i++) await new Promise(r => setTimeout(r, 5));
    render(a)[0].run();
    await wait(2);
    const two = globalThis.__streams[1];
    assert.equal(two.body.sessionId, a.id);
    two.onFrame({ type: 'done' }); two.release();
    for (let i = 0; i < 200 && store.useStore(s => s.streaming); i++) await new Promise(r => setTimeout(r, 5));
    render(a)[0].run();
    assert.equal(globalThis.__streams.length, 2, 'each queued message is sent once');
    assert.equal(store.useStore(s => s.sessions.find(s => s.id === b.id).messages.length), 0, 'B receives nothing');
    assert.deepEqual(store.useStore(s => s.sessions.find(s => s.id === a.id).messages.filter(m => m.role === 'user').map(m => m.content)), ['queued A one', 'queued A two']);
    store.parkMessage(a.id, '/loop stop');
    store.selectSession(b.id);
    render(a)[0].run();
    assert.deepEqual(store.useStore(s => s.parked[a.id]), ['/loop stop']);
    store.selectSession(a.id);
    render(a)[0].run();
    assert.equal(globalThis.__streams.length, 2, 'the slash command remains local, rather than becoming a model prompt');
    const note = store.useStore(s => s.sessions.find(s => s.id === a.id).messages.at(-1));
    assert.equal(note.local, true);
    assert.equal(note.content, 'No loop is running in this chat.');
    assert.equal(store.useStore(s => s.sessions.find(s => s.id === b.id).messages.length), 0);
    await store.flushSessions();
  } finally { fakeHost.restore(); rmSync(hostDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
