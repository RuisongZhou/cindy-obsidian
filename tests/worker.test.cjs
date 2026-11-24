const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { once } = require('node:events');
const { test } = require('node:test');

function vaultWorker(t, vault, { home, preload } = {}) {
  const privateHome = home || mkdtempSync(path.join(os.tmpdir(), 'obsidian-worker-home-'));
  const worker = spawn(process.execPath, [
    ...(preload ? ['--require', preload] : []),
    path.join(__dirname, '../obsidian-vault/node/worker.cjs'),
  ], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, HOME: privateHome, USERPROFILE: privateHome, LOCALAPPDATA: privateHome, XDG_STATE_HOME: privateHome },
  });
  const workerExit = once(worker, 'exit');
  const lines = createInterface({ input: worker.stdout });
  const output = lines[Symbol.asyncIterator]();
  async function stop() {
    worker.stdin.end();
    await workerExit;
  }
  t.after(async () => {
    await stop();
    if (!home) await fs.rm(privateHome, { recursive: true, force: true });
  });
  let id = 0;
  async function request(method, params = {}) {
    worker.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: ++id, method, params: {
        vault, settings: { custom_vaults: [vault] }, ...params,
      },
    }) + '\n');
    const line = await output.next();
    if (line.done) throw new Error('Worker exited before replying');
    const response = JSON.parse(line.value);
    assert.equal(response.id, id);
    return response.error?.data.errorCode ?? response.result;
  }
  request.stop = stop;
  return request;
}

test('vault computer and write receipts survive a new execution process', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-reconnect-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const vault = path.join(fixture, 'vault');
  const home = path.join(fixture, 'home');
  await fs.mkdir(vault);
  await fs.mkdir(home);
  await fs.writeFile(path.join(vault, 'Note.md'), '# Initial\n');

  const request = vaultWorker(t, vault, { home });
  const status = await request('vault_status');
  assert.equal(status.executionHost, os.hostname());
  const vaultId = status.activeVault.id;
  const note = { vault: vaultId, mode: 'append', path: 'Note.md', content: 'one note append', idempotencyKey: 'note-once' };
  const daily = { vault: vaultId, action: 'add-task', date: '2026-11-24', content: 'one daily task', idempotencyKey: 'daily-once' };
  assert.deepEqual(await request('write_receipt', { vault: vaultId, method: 'write_note', idempotencyKey: note.idempotencyKey }), { state: 'missing' });
  const originalNote = await request('write_note', note);
  const originalDaily = await request('daily_note', daily);
  assert.equal(originalNote.path, 'Note.md');
  assert.equal(originalDaily.path, '2026-11-24.md');
  await request.stop();

  const reconnected = vaultWorker(t, vault, { home });
  for (const [method, args, expected] of [['write_note', note, originalNote], ['daily_note', daily, originalDaily]]) {
    const receipt = await reconnected('write_receipt', { method, vault: vaultId, idempotencyKey: args.idempotencyKey });
    assert.deepEqual(receipt, { state: 'saved', path: expected.path });
    assert.deepEqual(await reconnected(method, args), expected);
    assert.equal(await reconnected(method, { ...args, content: 'changed payload' }), 'IDEMPOTENCY_KEY_REUSED');
    const body = await fs.readFile(path.join(vault, expected.path), 'utf8');
    assert.equal(body.split(args.content).length - 1, 1);
  }
  const readOnly = { custom_vaults: [vault], vault_write_policies: { [await fs.realpath(vault)]: { readOnly: true, writeFolders: null } } };
  assert.equal(await reconnected('write_note', { ...note, settings: readOnly, idempotencyKey: 'new-write' }), 'VAULT_READ_ONLY');
  assert.deepEqual(await reconnected('write_receipt', { vault: vaultId, method: 'write_note', idempotencyKey: note.idempotencyKey, settings: readOnly }), { state: 'saved', path: note.path });

  const parallel = vaultWorker(t, vault, { home });
  const shared = { ...note, content: 'parallel retry', idempotencyKey: 'parallel' };
  const outcomes = await Promise.all([reconnected('write_note', shared), parallel('write_note', shared)]);
  assert.ok(outcomes.some((outcome) => outcome.path === note.path));
  assert.ok(outcomes.every((outcome) => outcome.path === note.path || outcome === 'WRITE_OUTCOME_UNKNOWN'));
  assert.equal((await fs.readFile(path.join(vault, note.path), 'utf8')).split(shared.content).length - 1, 1);
});

test('an interrupted write keeps its claim if the note was committed before the worker exited', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-write-interrupted-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const vault = path.join(fixture, 'vault');
  const home = path.join(fixture, 'home');
  const notePath = path.join(vault, 'Note.md');
  const preload = path.join(fixture, 'interrupt.cjs');
  await fs.mkdir(vault);
  await fs.mkdir(home);
  await fs.writeFile(notePath, '# Initial\n');
  await fs.writeFile(preload, `
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      await rename(from, to);
      if (path.basename(to) === 'Note.md') process.exit(71);
    };
  `);

  const initial = vaultWorker(t, vault, { home, preload });
  const vaultId = (await initial('vault_status')).activeVault.id;
  const args = { vault: vaultId, path: 'Note.md', mode: 'append', content: 'interrupted append', idempotencyKey: 'interrupted' };
  await assert.rejects(initial('write_note', args), /Worker exited before replying/);
  await initial.stop();

  const reconnected = vaultWorker(t, vault, { home });
  assert.deepEqual(await reconnected('write_receipt', {
    method: 'write_note', vault: vaultId, idempotencyKey: args.idempotencyKey,
  }), { state: 'unconfirmed', path: args.path });
  assert.equal(await reconnected('write_note', args), 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(await reconnected('write_note', { ...args, path: 'Other.md' }), 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await fs.readFile(notePath, 'utf8')).split(args.content).length - 1, 1);
});

test('directory enumeration and paginated body matches use the registered vault', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-discovery-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const vault = path.join(fixture, 'vault');
  await fs.mkdir(path.join(vault, 'Notes', 'Empty'), { recursive: true });
  await fs.mkdir(path.join(vault, '.obsidian'));
  const body = '# Heading\r\nİ 🔎 needle needle\r\n' + 'x'.repeat(33000) + '\nlate hit';
  await Promise.all([
    fs.writeFile(path.join(vault, 'Notes', 'Main.md'), '---\r\ntags: [metadataonly]\r\n---\r\n' + body),
    fs.writeFile(path.join(vault, 'Notes', 'Other.md'), 'needle'),
    fs.writeFile(path.join(vault, 'Notes', 'Picture.PNG'), ''),
    fs.writeFile(path.join(vault, '.obsidian', 'Private.md'), 'needle'),
    fs.writeFile(path.join(fixture, 'Outside.md'), 'needle'),
  ]);
  await fs.symlink(fixture, path.join(vault, 'Outside'), 'dir');

  const request = vaultWorker(t, vault);

  const root = await request('list_notes');
  assert.deepEqual(root.entries, [{ path: 'Notes', name: 'Notes', type: 'directory' }]);
  const listing = await request('list_notes', { folder: 'Notes', extension: '.PNG' });
  assert.deepEqual(listing.entries.map(({ path, type }) => [path, type]), [
    ['Notes/Empty', 'directory'], ['Notes/Picture.PNG', 'file'],
  ]);
  assert.deepEqual((await request('list_notes', { depth: 2, extension: 'md' })).entries.map((entry) => entry.path),
    ['Notes', 'Notes/Empty', 'Notes/Main.md', 'Notes/Other.md']);
  assert.equal(await request('list_notes', { folder: '../' }), 'INVALID_FOLDER');
  assert.equal(await request('list_notes', { folder: vault }), 'INVALID_FOLDER');
  assert.equal(await request('list_notes', { folder: 'Outside' }), 'FOLDER_NOT_FOUND');
  assert.equal(await request('list_notes', { folder: '.obsidian' }), 'INVALID_FOLDER');

  const options = { query: 'needle', limit: 1, maxMatchesPerNote: 1 };
  const first = await request('search_notes', options);
  assert.equal(first.totalMatches, 2);
  assert.ok(first.nextCursor);
  const second = await request('search_notes', { ...options, cursor: first.nextCursor, refresh: true });
  assert.equal(second.offset, 1);
  assert.equal(second.nextCursor, null);
  const results = [...first.results, ...second.results];
  assert.equal(new Set(results.map((note) => note.path)).size, 2);
  const main = results.find((note) => note.path === 'Notes/Main.md');
  const [hit] = main.matches;
  assert.equal(main.matchesTruncated, true);
  assert.equal(hit.start, body.indexOf('needle'));
  assert.equal(body.slice(hit.start, hit.end), 'needle');
  assert.equal(hit.line, 2);
  assert.equal(hit.column, 'İ 🔎 '.length + 1);
  const late = (await request('search_notes', { query: 'late' })).results[0].matches[0];
  assert.equal(late.start, body.indexOf('late'));
  assert.equal(late.line, 4);
  assert.deepEqual((await request('search_notes', { query: '#metadataonly' })).results[0].matches, []);
  assert.equal(await request('search_notes', { ...options, cursor: 'invalid' }), 'INVALID_CURSOR');
  assert.equal(await request('search_notes', { ...options, query: 'late', cursor: first.nextCursor }), 'STALE_CURSOR');
  await fs.writeFile(path.join(vault, 'New.md'), 'needle');
  assert.equal(await request('search_notes', { ...options, cursor: first.nextCursor, refresh: true }), 'STALE_CURSOR');
});

test('precise writes keep scope, block IDs, BOM, and unrelated Markdown intact', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-edit-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  const filename = path.join(vault, 'Plan.md');
  const original = '\uFEFF---\r\ntags: [old]\r\n---\r\n\r\n' +
    '# Alpha\r\n## Summary\r\nold Alpha\r\n\r\n' +
    '# Beta\r\n## Summary\r\nold Beta\r\n\r\n' +
    '- [ ] old task ^task\r\n- old neighbor\r\n\r\n' +
    '> old quote\r\n> continues\r\n\r\n^quote\r\n\r\n' +
    '~~~md\r\n## Summary\r\nfake ^fake\r\n~~~\r\n\r\n' +
    '> ```md\r\n> fake ^quote-fake\r\n> ```\r\n';
  await fs.writeFile(filename, original);
  const request = vaultWorker(t, vault);
  const read = (scope) => request('read_note', { path: 'Plan.md', ...scope });
  const write = (mode, scope, content) => request('write_note', { path: 'Plan.md', mode, content, ...scope });
  const replace = (options) => request('replace_in_note', { path: 'Plan.md', find: 'old', replace: 'new', ...options });
  const onDisk = () => fs.readFile(filename, 'utf8');

  assert.equal(await read({ heading: '## Summary' }), 'AMBIGUOUS_HEADING');
  const beta = await read({ headingPath: ['Beta', 'Summary'] });
  assert.deepEqual(beta.selectedHeadingPath, ['Beta', 'Summary']);
  assert.deepEqual(beta.headings.map((heading) => heading.path), [
    ['Alpha'], ['Alpha', 'Summary'], ['Beta'], ['Beta', 'Summary'],
  ]);
  assert.match(beta.content, /old Beta/);
  assert.doesNotMatch(beta.content, /old Alpha/);
  assert.equal((await read({ blockId: '^task' })).content, 'old task');
  assert.equal((await request('read_note', { title: '[[Plan#^task|Task]]' })).content, 'old task');
  assert.equal((await read({ blockId: 'quote' })).content, '> old quote\r\n> continues');
  assert.equal(await read({ blockId: '^fake' }), 'BLOCK_NOT_FOUND');
  assert.equal(await read({ blockId: '^quote-fake' }), 'BLOCK_NOT_FOUND');
  assert.equal(await read({ headingPath: ['Beta', 'Summary'], blockId: 'task' }), 'AMBIGUOUS_NOTE_SCOPE');
  assert.equal(await write('replace-section', { headingPath: ['Missing', 'Summary'] }, 'wrong'), 'HEADING_NOT_FOUND');
  const preview = await replace({ dryRun: true });
  assert.equal(preview.matchCount, 5);
  assert.equal(await replace({}), 'REPLACEMENT_COUNT_MISMATCH');
  assert.equal(await onDisk(), original);

  const edited = await replace({ blockId: '^task', expectedCount: 1, expectedMtimeMs: preview.mtimeMs, idempotencyKey: 'once' });
  assert.equal(edited.matchCount, 1);
  assert.deepEqual(await replace({ blockId: '^task', expectedCount: 1, expectedMtimeMs: preview.mtimeMs, idempotencyKey: 'once' }), edited);
  assert.equal(await onDisk(), original.replace('old task', 'new task'));
  assert.equal(await replace({ blockId: '^task', find: 'new', replace: 'changed', expectedMtimeMs: preview.mtimeMs - 5000 }), 'WRITE_CONFLICT');
  assert.equal(await write('replace-block', { blockId: 'task' }, 'bad\n\nparagraph'), 'BLOCK_STRUCTURE_CHANGED');
  assert.equal((await write('append-block', { blockId: 'task' }, 'finished')).blockId, 'task');
  assert.match(await onDisk(), /- \[ \] new task finished \^task\r\n- old neighbor/);

  const scoped = await replace({ headingPath: ['Alpha', 'Summary'], expectedCount: 1, replace: '$& is literal' });
  assert.equal(scoped.matchCount, 1);
  const afterHeadingReplace = await onDisk();
  assert.match(afterHeadingReplace, /\$& is literal Alpha/);
  assert.match(afterHeadingReplace, /old Beta/);
  assert.equal((await write('replace-section', { headingPath: ['Beta', 'Summary'] }, 'revised')).action, 'replace-section');
  const final = await onDisk();
  assert.match(final, /^\uFEFF---\r\ntags: \[old\]\r\n---\r\n\r\n/);
  assert.match(final, /# Beta\r\n## Summary\r\n\r\nrevised/);
  await fs.writeFile(path.join(vault, 'Duplicate.md'), 'first ^dupe\n\nsecond ^dupe\n');
  assert.equal(await request('read_note', { path: 'Duplicate.md', blockId: 'dupe' }), 'AMBIGUOUS_BLOCK');
  const batch = { path: 'Duplicate.md', find: 'dupe', replace: 'fixture', replaceAll: true };
  assert.equal(await request('replace_in_note', { ...batch, expectedCount: 1 }), 'REPLACEMENT_COUNT_MISMATCH');
  assert.equal((await request('replace_in_note', { ...batch, expectedCount: 2 })).matchCount, 2);
});

test('write rules cover note, daily, Canvas, trash and tag operations', async (t) => {
  const top = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-policy-'));
  t.after(() => fs.rm(top, { recursive: true, force: true }));
  const vault = await fs.realpath(top);
  const inbox = path.join(vault, 'Inbox');
  await fs.mkdir(inbox);
  await fs.mkdir(path.join(vault, 'Inbox-Other'));
  const original = '\uFEFF---\r\nother: keep\r\ntags: [Alpha, alpha/Child, "#Exact"]\r\ntag: Alpha\r\n---\r\n\r\nKeep #Alpha in the body.\r\n';
  const target = path.join(inbox, 'Tagged.md');
  await fs.writeFile(target, original);
  await fs.writeFile(path.join(vault, 'Outside.md'), 'outside text');
  await fs.writeFile(path.join(inbox, 'Unsafe.md'), '---\ntags: Alpha #note\n---\nbody');
  const request = vaultWorker(t, vault);
  const configuration = (policy) => ({
    custom_vaults: [vault, inbox],
    daily_folder: 'Daily',
    vault_write_policies: { [vault]: policy },
  });
  const readonly = configuration({ readOnly: true, writeFolders: null });
  const restricted = configuration({ readOnly: false, writeFolders: ['Inbox'] });
  const denied = [
    ['write_note', { path: 'Inbox/Tagged.md', mode: 'append', content: 'unexpected' }],
    ['write_note', { path: 'Inbox/Tagged.md', mode: 'delete' }],
    ['inspect_write_target', { path: 'Inbox/Tagged.md' }],
    ['replace_in_note', { path: 'Inbox/Tagged.md', find: 'Keep', replace: 'Change' }],
    ['manage_tags', { path: 'Inbox/Tagged.md', operation: 'add', tags: ['new'] }],
    ['daily_note', { action: 'add-task', content: 'unexpected', date: '2026-11-23' }],
    ['canvas_ops', { action: 'create', path: 'Inbox/Board.canvas', nodes: [] }],
  ];
  for (const [method, args] of denied) {
    assert.equal(await request(method, { ...args, settings: readonly }), 'VAULT_READ_ONLY', method);
  }
  assert.equal(await request('write_note', { vault: inbox, path: 'Tagged.md', mode: 'delete', settings: readonly }), 'VAULT_READ_ONLY');
  assert.equal(await request('write_note', { path: 'Outside.md', mode: 'delete', settings: restricted }), 'WRITE_OUTSIDE_ALLOWED_FOLDERS');
  assert.equal(await request('write_note', { path: 'Inbox-Other/Blocked.md', mode: 'create', settings: restricted }), 'WRITE_OUTSIDE_ALLOWED_FOLDERS');
  assert.equal(await request('daily_note', { action: 'ensure', date: '2026-11-23', settings: restricted }), 'WRITE_OUTSIDE_ALLOWED_FOLDERS');
  assert.equal(await request('inspect_vault_write_policy', { policy: { readOnly: false, writeFolders: ['../'] } }), 'INVALID_FOLDER');
  assert.deepEqual((await request('vault_status', { settings: restricted })).writePolicy, { readOnly: false, writeFolders: ['Inbox'] });
  assert.equal((await request('replace_in_note', { path: 'Inbox/Tagged.md', find: 'Keep', replace: 'Change', dryRun: true, settings: readonly })).matchCount, 1);
  assert.equal((await request('daily_note', { action: 'read', date: '2026-11-23', settings: readonly })).exists, false);
  const tags = (operation, values, settings = restricted) =>
    request('manage_tags', { path: 'Inbox/Tagged.md', operation, tags: values, settings });
  assert.deepEqual((await tags('list', undefined, readonly)).tags, ['Alpha', 'alpha/Child', 'Exact']);
  assert.deepEqual((await tags('add', ['ALPHA', 'Project/Next'])).applied, ['Project/Next']);
  assert.deepEqual((await tags('remove', ['#alpha', 'absent'])).tags, ['alpha/Child', 'Exact', 'Project/Next']);
  const disk = await fs.readFile(target, 'utf8');
  assert.match(disk, /^\uFEFF---\r\nother: keep\r\n/);
  assert.ok(disk.endsWith('---\r\n\r\nKeep #Alpha in the body.\r\n'));
  assert.match(disk, /tag: \[\]/);
  assert.deepEqual((await tags('remove', ['alpha'])).skipped, ['alpha']);
  assert.equal(await fs.readFile(target, 'utf8'), disk);
  assert.equal(await request('manage_tags', { path: 'Inbox/Unsafe.md', operation: 'remove', tags: ['Alpha'], settings: restricted }), 'UNSUPPORTED_TAGS_PROPERTY');
  assert.equal(await fs.readFile(path.join(inbox,'Unsafe.md'), 'utf8'), '---\ntags: Alpha #note\n---\nbody');
  assert.equal((await request('write_note', { path: 'Inbox/New/Allowed.md', mode: 'create', content: 'allowed', settings: restricted })).action, 'created');
  assert.equal((await request('canvas_ops', { path: 'Inbox/Board.canvas', action: 'create', nodes: [], settings: restricted })).action, 'created');
});

test('the host confirms rule changes and fetches fresh rules before writes', async () => {
  const vm = require('node:vm');
  const main = await fs.readFile(path.join(__dirname, '../obsidian-vault/main.js'), 'utf8');
  const vault = { id: 'test', name: 'Test vault', path: '/fixtures/test-vault' };
  let settings = { inbox_folder: 'Inbox' };
  let listener;
  let confirmed = false;
  let offline = false;
  const dispatched = [];
  const results = [];
  vm.runInNewContext(main, {
    cindy: {
      onHostMessage: (handler) => { listener = handler; },
      confirm: async () => ({ ok: true, confirmed }),
      send: async (result) => results.push(result),
      node: {
        async request({ method, params }) {
          dispatched.push({ method, params });
          if (method === 'inspect_vault_write_policy') return { ok: true, result: { vault, policy: params.policy } };
          return { ok: false, message: 'Policy checked by worker.' };
        },
      },
    },
    fetch: async (endpoint, options) => {
      assert.equal(endpoint, '/kv');
      if (offline) return { ok: false };
      if (options?.method === 'PUT') settings = JSON.parse(options.body);
      return { ok: true, json: async () => settings };
    },
  });
  const invoke = (tool, args) => listener({ type: 'tool-call', tool, args, callId: 'fixture' });
  const proposed = { vault: vault.id, readOnly: true, restrictFolders: true, folders: ['Inbox'] };
  await invoke('set_vault_write_policy', proposed);
  assert.equal(results.at(-1).result.structuredContent.errorCode, 'CONFIRMATION_DECLINED');
  assert.equal(settings.vault_write_policies, undefined);
  confirmed = true;
  await invoke('set_vault_write_policy', proposed);
  assert.deepEqual(settings.vault_write_policies[vault.path], { readOnly: true, writeFolders: ['Inbox'] });
  assert.equal(settings.inbox_folder, 'Inbox');
  settings = { ...settings, vault_write_policies: { [vault.path]: { readOnly: false, writeFolders: [] } } };
  await invoke('write_note', { path: 'Blocked.md', content: 'fixture' });
  assert.deepEqual(dispatched.at(-1).params.settings.vault_write_policies[vault.path], { readOnly: false, writeFolders: [] });
  offline = true;
  const callsBeforeFailure = dispatched.length;
  await invoke('write_note', { path: 'Blocked.md', content: 'fixture' });
  assert.equal(dispatched.length, callsBeforeFailure);
  assert.equal(results.at(-1).result.isError, true);
});
