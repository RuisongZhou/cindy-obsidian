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

test('directory enumeration, vault tag stats, and paginated body matches use the registered vault', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-discovery-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const vault = path.join(fixture, 'vault');
  await fs.mkdir(path.join(vault, 'Notes', 'Empty'), { recursive: true });
  await fs.mkdir(path.join(vault, '.obsidian'));
  const body = '# Heading\r\nİ 🔎 needle needle #project/release\r\n' + 'x'.repeat(33000) + '\nlate hit';
  await Promise.all([
    fs.writeFile(path.join(vault, 'Notes', 'Main.md'), '---\r\ntags: [metadataonly, project]\r\n---\r\n' + body),
    fs.writeFile(path.join(vault, 'Notes', 'Other.md'), 'needle #project'),
    fs.writeFile(path.join(vault, 'Notes', 'Picture.PNG'), ''),
    fs.writeFile(path.join(vault, '.obsidian', 'Private.md'), 'needle'),
    fs.writeFile(path.join(fixture, 'Outside.md'), 'needle'),
  ]);
  await fs.symlink(fixture, path.join(vault, 'Outside'), 'dir');

  const request = vaultWorker(t, vault);

  const root = await request('list_files');
  assert.deepEqual(root.entries, [{ path: 'Notes', name: 'Notes', type: 'directory' }]);
  const listing = await request('list_files', { folder: 'Notes', extension: '.PNG' });
  assert.deepEqual(listing.entries.map(({ path, type }) => [path, type]), [
    ['Notes/Empty', 'directory'], ['Notes/Picture.PNG', 'file'],
  ]);
  assert.deepEqual((await request('list_files', { depth: 2, extension: 'md' })).entries.map((entry) => entry.path),
    ['Notes', 'Notes/Empty', 'Notes/Main.md', 'Notes/Other.md']);
  assert.equal(await request('list_files', { folder: '../' }), 'INVALID_FOLDER');
  assert.equal(await request('list_files', { folder: vault }), 'INVALID_FOLDER');
  assert.equal(await request('list_files', { folder: 'Outside' }), 'FOLDER_NOT_FOUND');
  assert.equal(await request('list_files', { folder: '.obsidian' }), 'INVALID_FOLDER');

  const allTags = await request('list_tags');
  assert.equal(allTags.totalTags, 3);
  assert.equal(allTags.tags[0].tag, 'project');
  assert.equal(allTags.tags[0].count, 2);
  const prefixed = await request('list_tags', { prefix: '#project', limit: 1 });
  assert.equal(prefixed.totalTags, 2);
  assert.equal(prefixed.truncated, true);
  assert.equal(prefixed.tags.length, 1);
  assert.equal(await request('graph_links', { mode: 'tags' }), 'USE_LIST_TAGS');

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
  assert.equal(await request('write_note', { path: 'Plan.md', mode: 'delete' }), 'USE_DELETE_NOTE');
  assert.equal(await request('write_note', { path: 'Plan.md', mode: 'replace-text', find: 'old', replace: 'new' }), 'INVALID_WRITE_MODE');
  assert.equal(await request('write_note', { path: 'Plan.md', mode: 'manage-tags', operation: 'list' }), 'INVALID_WRITE_MODE');
  assert.equal(await request('write_note', { path: 'Plan.md', mode: 'append', content: 'x', tags: ['a'] }), 'USE_MANAGE_TAGS');
  assert.equal(await request('write_note', { path: 'Plan.md', mode: 'update-frontmatter', frontmatter: { tags: ['a'] } }), 'USE_MANAGE_TAGS');

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

  const created = await request('write_note', {
    path: 'Fresh.md',
    mode: 'create',
    content: '# Fresh',
    frontmatter: { tags: ['#Alpha', 'alpha', 'Beta/Sub'] },
  });
  assert.deepEqual(created.frontmatter.tags, ['Alpha', 'Beta/Sub']);

  await fs.writeFile(path.join(vault, 'Duplicate.md'), 'first ^dupe\n\nsecond ^dupe\n');
  assert.equal(await request('read_note', { path: 'Duplicate.md', blockId: 'dupe' }), 'AMBIGUOUS_BLOCK');
  const batch = { path: 'Duplicate.md', find: 'dupe', replace: 'fixture', replaceAll: true };
  assert.equal(await request('replace_in_note', { ...batch, expectedCount: 1 }), 'REPLACEMENT_COUNT_MISMATCH');
  assert.equal((await request('replace_in_note', { ...batch, expectedCount: 2 })).matchCount, 2);
});

test('write rules cover note, delete_note, daily, Canvas, and tag operations', async (t) => {
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
    ['delete_note', { path: 'Inbox/Tagged.md' }],
    ['inspect_write_target', { path: 'Inbox/Tagged.md' }],
    ['replace_in_note', { path: 'Inbox/Tagged.md', find: 'Keep', replace: 'Change' }],
    ['manage_tags', { path: 'Inbox/Tagged.md', operation: 'add', tags: ['new'] }],
    ['daily_note', { action: 'add-task', content: 'unexpected', date: '2026-11-23' }],
    ['canvas_ops', { action: 'create', path: 'Inbox/Board.canvas', nodes: [] }],
  ];
  for (const [method, args] of denied) {
    assert.equal(await request(method, { ...args, settings: readonly }), 'VAULT_READ_ONLY', method);
  }
  assert.equal(await request('delete_note', { vault: inbox, path: 'Tagged.md', settings: readonly }), 'VAULT_READ_ONLY');
  assert.equal(await request('delete_note', { path: 'Outside.md', settings: restricted }), 'WRITE_OUTSIDE_ALLOWED_FOLDERS');
  assert.equal(await request('write_note', { path: 'Inbox-Other/Blocked.md', mode: 'create', settings: restricted }), 'WRITE_OUTSIDE_ALLOWED_FOLDERS');
  assert.equal(await request('daily_note', { action: 'ensure', date: '2026-11-23', settings: restricted }), 'WRITE_OUTSIDE_ALLOWED_FOLDERS');
  assert.equal(await request('canvas_ops', { action: 'write', path: 'Inbox/Board.canvas', nodes: [], settings: restricted }), 'INVALID_CANVAS_ACTION');
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
  assert.equal(await fs.readFile(path.join(inbox, 'Unsafe.md'), 'utf8'), '---\ntags: Alpha #note\n---\nbody');
  assert.equal((await request('write_note', { path: 'Inbox/New/Allowed.md', mode: 'create', content: 'allowed', settings: restricted })).action, 'created');
  assert.equal((await request('canvas_ops', { path: 'Inbox/Board.canvas', action: 'create', nodes: [], settings: restricted })).action, 'created');

  const trashed = await request('delete_note', { path: 'Inbox/New/Allowed.md', idempotencyKey: 'del-once', settings: restricted });
  assert.equal(trashed.action, 'moved_to_obsidian_trash');
  assert.match(trashed.trashFile, /^\.trash\/Inbox__New__Allowed\./);
  assert.deepEqual(await request('delete_note', { path: 'Inbox/New/Allowed.md', idempotencyKey: 'del-once', settings: restricted }), trashed);
});

test('rules and deletion are confirmed away from the host dialog, and writes fetch fresh rules', async () => {
  const vm = require('node:vm');
  const main = await fs.readFile(path.join(__dirname, '../obsidian-vault/main.js'), 'utf8');
  const vault = { id: 'test', name: 'Test vault', path: '/fixtures/test-vault' };
  let settings = { inbox_folder: 'Inbox' };
  let listener;
  let offline = false;
  const dispatched = [];
  const sent = [];
  vm.runInNewContext(main, {
    cindy: {
      onHostMessage: (handler) => { listener = handler; },
      // A dialog would open on the plugin's own computer, so chat and workbench flows must not use it.
      confirm: async () => assert.fail('no host dialog for chat or workbench confirmations'),
      send: async (message) => sent.push(message),
      node: {
        async request({ method, params }) {
          dispatched.push({ method, params });
          if (method === 'inspect_vault_write_policy') return { ok: true, result: { vault, policy: params.policy } };
          if (method === 'request_confirmation') {
            return { ok: true, result: { required: true, tool: params.tool, confirmationId: 'a'.repeat(32), expiresAt: Date.now() + 600000,
              vault, path: params.args.path, executionHost: 'host', preview: {} } };
          }
          if (method === 'resolve_confirmation') {
            return { ok: true, result: { handled: true, state: 'done', tool: 'delete_note', vaultName: vault.name, path: 'Note.md', result: { trashFile: '.trash/Note.md' } } };
          }
          if (method === 'confirmation_status') return { ok: true, result: { state: 'pending', tool: 'delete_note', vaultName: vault.name, path: 'Note.md' } };
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
  const click = (actionId, callId = 'fixture') => listener({ type: 'event', name: 'card-action', callId, actionId });
  const lastResult = () => sent.filter((message) => message.type === 'tool-result').at(-1).result;
  const count = (method) => dispatched.filter((item) => item.method === method).length;

  const proposed = { vault: vault.id, readOnly: true, restrictFolders: true, folders: ['Inbox'] };
  await invoke('set_vault_write_policy', proposed);
  assert.equal(lastResult().structuredContent.errorCode, 'CONFIRMATION_REQUIRED');
  assert.equal(settings.vault_write_policies, undefined);
  await invoke('set_vault_write_policy', { ...proposed, confirmed: true });
  assert.deepEqual(settings.vault_write_policies[vault.path], { readOnly: true, writeFolders: ['Inbox'] });
  assert.equal(settings.inbox_folder, 'Inbox');

  sent.length = 0;
  await invoke('delete_note', { vault: vault.id, path: 'Note.md' });
  // The card goes out before the result, which returns without waiting for a click.
  assert.deepEqual(sent.map((message) => message.type), ['card-update', 'tool-result']);
  assert.equal(sent[0].callId, 'fixture');
  assert.deepEqual([...sent[0].html.matchAll(/data-ghost-action="([^"]+)"/g)].map((match) => match[1]),
    ['obs:ok:' + 'a'.repeat(32), 'obs:no:' + 'a'.repeat(32)]);
  assert.equal(lastResult().structuredContent.status, 'awaiting_confirmation');
  assert.equal(lastResult().structuredContent.committed, false);
  assert.equal(count('delete_note'), 0);
  assert.equal(count('resolve_confirmation'), 0);

  await click('obs:ok:not-an-id');
  await click('something-else');
  assert.equal(count('resolve_confirmation'), 0);

  // Rules cannot be read: nothing is claimed and the card says nothing ran.
  offline = true;
  sent.length = 0;
  await click('obs:ok:' + 'a'.repeat(32));
  assert.equal(count('resolve_confirmation'), 0);
  assert.match(sent.at(-1).html, /没有执行/);
  assert.doesNotMatch(sent.at(-1).html, /data-ghost-action/);
  offline = false;

  sent.length = 0;
  await Promise.all([click('obs:ok:' + 'a'.repeat(32)), click('obs:ok:' + 'a'.repeat(32))]);
  assert.equal(count('resolve_confirmation'), 1);
  const resolved = dispatched.find((item) => item.method === 'resolve_confirmation');
  assert.equal(resolved.params.cardCallId, 'fixture');
  assert.equal(resolved.params.decision, 'confirm');
  assert.deepEqual(resolved.params.settings.vault_write_policies[vault.path], { readOnly: true, writeFolders: ['Inbox'] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state, 'done');
  assert.match(sent[0].html, /已移入回收站/);

  settings = { ...settings, vault_write_policies: { [vault.path]: { readOnly: false, writeFolders: [] } } };
  await invoke('write_note', { path: 'Blocked.md', content: 'fixture' });
  assert.deepEqual(dispatched.at(-1).params.settings.vault_write_policies[vault.path], { readOnly: false, writeFolders: [] });
  offline = true;
  const callsBeforeFailure = dispatched.length;
  await invoke('write_note', { path: 'Blocked.md', content: 'fixture' });
  assert.equal(dispatched.length, callsBeforeFailure);
  assert.equal(lastResult().isError, true);
});

const confirmationDirectory = (home) => path.join(home,
  ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : []), 'Cindy Obsidian Vault', 'confirmations');

async function confirmationFixture(t, prefix) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(fixture, 'home');
  await fs.mkdir(path.join(fixture, 'vault'));
  await fs.mkdir(home);
  const vault = await fs.realpath(path.join(fixture, 'vault'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const request = vaultWorker(t, vault, { home });
  const vaultId = (await request('vault_status')).activeVault.id;
  const ask = (tool, args, cardCallId = 'card-1') => request('request_confirmation', { tool, args: { vault: vaultId, ...args }, cardCallId });
  const decide = (confirmationId, decision = 'confirm', extra = {}) =>
    request('resolve_confirmation', { confirmationId, cardCallId: 'card-1', decision, ...extra });
  const read = (name) => fs.readFile(path.join(vault, name), 'utf8');
  return { fixture, home, vault, vaultId, request, ask, decide, read };
}

test('a confirmed operation runs once, only from its own card', async (t) => {
  const { home, vault, vaultId, request, ask, decide, read } = await confirmationFixture(t, 'obsidian-confirm-');
  await fs.writeFile(path.join(vault, 'Gone.md'), 'delete me\n');
  await fs.writeFile(path.join(vault, 'Old.md'), 'old body\n');
  await fs.writeFile(path.join(vault, 'Board.canvas'), JSON.stringify({ nodes: [], edges: [] }));

  const removal = await ask('delete_note', { path: 'Gone.md' });
  assert.equal(removal.required, true);
  assert.equal(await read('Gone.md'), 'delete me\n');
  assert.equal(await decide(removal.confirmationId, 'confirm', { cardCallId: 'another-card' }), 'CONFIRMATION_MISMATCH');
  assert.equal((await request('confirmation_status', { confirmationId: removal.confirmationId })).state, 'pending');

  // Two execution processes receiving the same click: exactly one runs it.
  const second = vaultWorker(t, vault, { home });
  const params = { confirmationId: removal.confirmationId, cardCallId: 'card-1', decision: 'confirm' };
  const outcomes = await Promise.all([request('resolve_confirmation', params), second('resolve_confirmation', params)]);
  assert.equal(outcomes.filter((outcome) => outcome.handled).length, 1);
  assert.equal(outcomes.find((outcome) => outcome.handled).state, 'done');
  await assert.rejects(read('Gone.md'), { code: 'ENOENT' });
  assert.equal((await fs.readdir(path.join(vault, '.trash'))).length, 1);
  const again = await decide(removal.confirmationId);
  assert.deepEqual([again.handled, again.state], [false, 'done']);

  const overwrite = await ask('write_note', { path: 'Old.md', mode: 'overwrite', content: 'PRIVATE new body C:\\temp\\new\n' });
  assert.equal(overwrite.preview.chars, 'PRIVATE new body C:\\temp\\new\n'.length);
  assert.equal(await read('Old.md'), 'old body\n');
  assert.equal((await decide(overwrite.confirmationId)).state, 'done');
  assert.equal(await read('Old.md'), 'PRIVATE new body C:\\temp\\new\n');

  const board = await ask('canvas_ops', { path: 'Board.canvas', action: 'overwrite', nodes: [{ id: 'a', type: 'text', text: 'PRIVATE node' }] });
  assert.deepEqual(board.preview, { nodes: 1, edges: 0 });
  assert.equal((await decide(board.confirmationId)).state, 'done');
  assert.match(await read('Board.canvas'), /PRIVATE node/);

  // Settled records keep the outcome, never the content that was waiting.
  const directory = confirmationDirectory(home);
  const stored = await fs.readdir(directory);
  assert.equal(stored.length, 3);
  assert.ok(stored.every((name) => name.endsWith('.done.json')), stored.join(','));
  for (const name of stored) assert.doesNotMatch(await fs.readFile(path.join(directory, name), 'utf8'), /PRIVATE/);

  // A new target needs no question; a delete of a missing note is refused outright.
  assert.equal((await ask('write_note', { path: 'Fresh.md', mode: 'overwrite', content: 'x' })).required, false);
  assert.equal(await ask('delete_note', { path: 'Gone.md' }), 'NOTE_NOT_FOUND');
  assert.equal(await ask('write_note', { path: 'Old.md', mode: 'append', content: 'x' }), 'INVALID_CONFIRMATION_REQUEST');
  assert.equal(await ask('daily_note', { action: 'append', content: 'x' }), 'INVALID_CONFIRMATION_REQUEST');
  assert.equal(await request('resolve_confirmation', { confirmationId: '../escape', cardCallId: 'card-1', decision: 'confirm' }), 'CONFIRMATION_NOT_FOUND');
  assert.equal((await request('confirmation_status', { vault: vaultId, confirmationId: 'f'.repeat(32) })).state, 'missing');
});

test('a confirmation is dropped when cancelled, expired, outdated or no longer allowed', async (t) => {
  const { home, vault, vaultId, request, ask, decide, read } = await confirmationFixture(t, 'obsidian-confirm-guard-');
  const note = path.join(vault, 'Keep.md');
  const reset = () => fs.writeFile(note, 'original\n');
  const state = async (id) => (await request('confirmation_status', { confirmationId: id })).state;

  await reset();
  const cancelled = await ask('delete_note', { path: 'Keep.md' });
  assert.equal((await decide(cancelled.confirmationId, 'cancel')).state, 'cancelled');
  assert.deepEqual([(await decide(cancelled.confirmationId)).handled, await state(cancelled.confirmationId)], [false, 'cancelled']);
  assert.equal(await read('Keep.md'), 'original\n');

  const expired = await ask('delete_note', { path: 'Keep.md' });
  const file = path.join(confirmationDirectory(home), expired.confirmationId + '.pending.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), expiresAt: Date.now() - 1 }));
  assert.deepEqual([(await decide(expired.confirmationId)).handled, await state(expired.confirmationId)], [false, 'expired']);
  assert.equal(await read('Keep.md'), 'original\n');

  const edited = await ask('write_note', { path: 'Keep.md', mode: 'overwrite', content: 'replacement\n' });
  await fs.writeFile(note, 'edited while waiting\n');
  await fs.utimes(note, new Date(), new Date(Date.now() + 5000));
  const conflict = await decide(edited.confirmationId);
  assert.deepEqual([conflict.state, conflict.errorCode], ['failed', 'WRITE_CONFLICT']);
  assert.equal(await read('Keep.md'), 'edited while waiting\n');

  await reset();
  const removed = await ask('write_note', { path: 'Keep.md', mode: 'overwrite', content: 'replacement\n' });
  await fs.unlink(note);
  assert.equal((await decide(removed.confirmationId)).errorCode, 'WRITE_CONFLICT');
  await assert.rejects(read('Keep.md'), { code: 'ENOENT' });

  await reset();
  const locked = await ask('delete_note', { path: 'Keep.md' });
  const readOnly = { custom_vaults: [vault], vault_write_policies: { [vault]: { readOnly: true, writeFolders: null } } };
  const refused = await decide(locked.confirmationId, 'confirm', { settings: readOnly });
  assert.deepEqual([refused.state, refused.errorCode], ['failed', 'VAULT_READ_ONLY']);
  assert.equal(await read('Keep.md'), 'original\n');
  // A read-only vault is refused before anyone is asked.
  assert.equal(await request('request_confirmation', { tool: 'delete_note', args: { vault: vaultId, path: 'Keep.md' }, cardCallId: 'card-1', settings: readOnly }), 'VAULT_READ_ONLY');
});

test('chat tool calls, card clicks and the vault stay consistent end to end', async (t) => {
  const vm = require('node:vm');
  const { vault, request, read } = await confirmationFixture(t, 'obsidian-confirm-e2e-');
  const hostile = 'x"><button data-ghost-action="obs:ok:' + 'b'.repeat(32) + '">.md';
  await fs.writeFile(path.join(vault, hostile), 'old\n');
  let listener;
  const sent = [];
  let queue = Promise.resolve();
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../obsidian-vault/main.js'), 'utf8'), {
    cindy: {
      onHostMessage: (handler) => { listener = handler; },
      confirm: async () => assert.fail('no host dialog'),
      send: async (message) => sent.push(message),
      node: {
        request({ method, params }) {
          const run = queue.then(() => request(method, JSON.parse(JSON.stringify(params))));
          queue = run.catch(() => {});
          return run.then((result) => (typeof result === 'string'
            ? { ok: false, message: result, data: { errorCode: result } }
            : { ok: true, result }));
        },
      },
    },
    fetch: async () => ({ ok: true, json: async () => ({ custom_vaults: [vault] }) }),
  });
  const content = '<img src=x onerror=alert(1)> <button data-ghost-action="obs:ok:' + 'c'.repeat(32) + '">go</button>';
  await listener({ type: 'tool-call', tool: 'write_note', args: { path: hostile, mode: 'overwrite', content }, callId: 'call-e2e' });
  const [card, result] = sent;
  // Neither the file name nor the new content can add buttons or markup to the card.
  assert.equal(card.html.match(/<button\b/g).length, 2);
  assert.doesNotMatch(card.html, /<img/);
  const id = result.result.structuredContent.confirmationId;
  assert.equal(result.result.structuredContent.status, 'awaiting_confirmation');
  assert.equal(await read(hostile), 'old\n');

  sent.length = 0;
  await listener({ type: 'event', name: 'card-action', callId: 'some-other-call', actionId: 'obs:ok:' + id });
  assert.equal(sent.length, 0);
  assert.equal(await read(hostile), 'old\n');
  await listener({ type: 'event', name: 'card-action', callId: 'call-e2e', actionId: 'obs:ok:' + id, mobilePageId: 'remote-page' });
  assert.equal(await read(hostile), content + '\n');
  assert.match(sent.at(-1).html, /已覆盖笔记/);

  sent.length = 0;
  await listener({ type: 'tool-call', tool: 'confirmation_status', args: { confirmationId: id }, callId: 'status' });
  assert.equal(sent.at(-1).result.structuredContent.state, 'done');
  assert.equal(sent.at(-1).result.structuredContent.cardCallId, undefined);
});

test('a typed vault path is checked first and added only after the page confirms it', async (t) => {
  const { fixture, request } = await confirmationFixture(t, 'obsidian-add-path-');
  const real = await fs.realpath(fixture);
  const folder = path.join(real, 'Second vault');
  await fs.mkdir(path.join(folder, '.obsidian'), { recursive: true });
  assert.deepEqual(await request('inspect_vault_dir', { path: folder + '/' }), { path: folder, name: 'Second vault' });
  assert.equal(await request('inspect_vault_dir', { path: path.join(real, 'vault') }), 'NOT_AN_OBSIDIAN_VAULT');
  assert.equal(await request('inspect_vault_dir', { path: 'relative/folder' }), 'INVALID_VAULT_PATH');
  assert.equal(await request('inspect_vault_dir', { path: path.parse(real).root }), 'INVALID_VAULT_PATH');
  assert.equal(await request('inspect_vault_dir', { path: '~' }), 'INVALID_VAULT_PATH');
  assert.equal(await request('inspect_vault_dir', { path: path.join(real, 'missing') }), 'VAULT_PATH_NOT_FOUND');

  const vm = require('node:vm');
  let listener;
  let settings = {};
  const sent = [];
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../obsidian-vault/main.js'), 'utf8'), {
    cindy: {
      onHostMessage: (handler) => { listener = handler; },
      send: async (message) => sent.push(message),
      node: {
        async request({ method, params }) {
          if (method === 'inspect_vault_dir') return { ok: true, result: { path: folder, name: 'Second vault' } };
          return { ok: true, result: { activeVault: { path: params.vault } } };
        },
      },
    },
    fetch: async (_endpoint, options) => {
      if (options?.method === 'PUT') settings = JSON.parse(options.body);
      return { ok: true, json: async () => settings };
    },
  });
  const add = async (args) => {
    await listener({ type: 'tool-call', tool: 'add_vault_path', args, callId: 'page' });
    return sent.at(-1).result.structuredContent;
  };
  assert.deepEqual(JSON.parse(JSON.stringify((await add({ path: folder })).pending)), { path: folder, name: 'Second vault' });
  assert.equal(settings.custom_vaults, undefined);
  assert.equal((await add({ path: folder + '/../elsewhere', confirmed: true })).errorCode, 'CONFIRMATION_REQUIRED');
  assert.equal(settings.custom_vaults, undefined);
  await add({ path: folder, confirmed: true });
  assert.equal(settings.default_vault, folder);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.custom_vaults)), [{ name: 'Second vault', path: folder }]);
});

test('manifest tools, visibility declarations, and all locale files stay strictly aligned', async () => {
  const root = path.join(__dirname, '../obsidian-vault');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'ghost.json'), 'utf8'));
  assert.equal(manifest.version, '1.1.4');
  assert.ok(manifest.description.length > 0 && manifest.description.length <= 300);
  assert.ok(manifest.whenToUse.length > 0 && manifest.whenToUse.length <= 300);

  const toolMap = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const uiToolNames = Object.keys(manifest.mcpApps.ui.tools);
  assert.deepEqual([...toolMap.keys()].sort(), [...uiToolNames].sort());

  for (const tool of manifest.tools) {
    assert.ok(Buffer.byteLength(JSON.stringify(tool.parameters), 'utf8') <= 16384, tool.name);
  }

  for (const [locale, relFile] of Object.entries(manifest.locales)) {
    const raw = await fs.readFile(path.join(root, relFile), 'utf8');
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 65536, locale);
    const data = JSON.parse(raw);
    assert.ok(data.description.length > 0 && data.description.length <= 300, locale + ' description');
    assert.ok(data.whenToUse.length > 0 && data.whenToUse.length <= 300, locale + ' whenToUse');
    assert.deepEqual(Object.keys(data.tools).sort(), [...toolMap.keys()].sort(), locale + ' tool keys');
    for (const [toolName, locTool] of Object.entries(data.tools)) {
      const schemaProps = toolMap.get(toolName).parameters.properties || {};
      for (const pointer of Object.keys(locTool.parameters || {})) {
        const match = /^\/properties\/([^/]+)$/.exec(pointer);
        assert.ok(match && Object.hasOwn(schemaProps, match[1]), `${locale}:${toolName} invalid pointer ${pointer}`);
      }
    }
  }
});

test('partner folders take default destinations only, and reply capture never duplicates', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-partner-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const vault = path.join(fixture, 'vault');
  await fs.mkdir(path.join(vault, 'Projects'), { recursive: true });
  const request = vaultWorker(t, vault);
  const partner = { id: 'bot-1', name: '小助手', folder: '伙伴/小助手' };

  const status = await request('vault_status', { _companion: partner });
  assert.equal(status.summary.defaultFolder, '伙伴/小助手');
  assert.equal((await request('vault_status')).summary.defaultFolder, 'Inbox');

  const bare = await request('write_note', { path: '周报', content: 'a', _companion: partner });
  assert.equal(bare.path, '伙伴/小助手/周报.md');
  assert.equal(bare.redirectedFrom, '周报.md');
  const inbox = await request('write_note', { path: 'Inbox/Sub/想法.md', content: 'b', _companion: partner });
  assert.equal(inbox.path, '伙伴/小助手/Sub/想法.md');
  const explicit = await request('write_note', { path: 'Projects/计划.md', content: 'c', _companion: partner });
  assert.equal(explicit.path, 'Projects/计划.md');
  assert.equal(explicit.redirectedFrom, undefined);
  const inside = await request('write_note', { path: '伙伴/小助手/已在.md', content: 'd', _companion: partner });
  assert.equal(inside.path, '伙伴/小助手/已在.md');
  const appended = await request('write_note', { path: 'Root.md', mode: 'append', content: 'e', _companion: partner });
  assert.equal(appended.path, 'Root.md');
  const broken = await request('write_note', { path: 'Loose.md', content: 'f', _companion: { ...partner, folder: '../out' } });
  assert.equal(broken.path, 'Loose.md');
  assert.match(broken.companionFolderWarning, /无效/);

  const reply = '# 会议结论\n\n- 第一条\n';
  const first = await request('capture_note', { folder: partner.folder, content: reply, idempotencyKey: 'reply-1', frontmatter: { source: 'Cindy' } });
  assert.equal(first.path, '伙伴/小助手/会议结论.md');
  const again = await request('capture_note', { folder: partner.folder, content: reply, idempotencyKey: 'reply-1', frontmatter: { source: 'Cindy' } });
  assert.equal(again.path, first.path);
  assert.equal(again.replayed, true);
  const second = await request('capture_note', { folder: partner.folder, content: reply, idempotencyKey: 'reply-2' });
  assert.equal(second.path, '伙伴/小助手/会议结论 2.md');
  const saved = await fs.readFile(path.join(vault, first.path), 'utf8');
  assert.match(saved, /^---\nsource: Cindy\n---\n# 会议结论/);
  assert.equal(await request('capture_note', { folder: 'Inbox', content: '   ' }), 'EMPTY_CONTENT');
  assert.equal(await request('check_folder', { folder: '../x' }), 'INVALID_FOLDER');
  assert.deepEqual(await request('check_folder', { folder: '伙伴/新目录/' }), { folder: '伙伴/新目录' });

  const outside = path.join(fixture, 'AI 报告.md');
  await fs.writeFile(outside, '---\ntitle: x\n---\n报告正文\n');
  const info = await request('inspect_markdown_file', { file: outside });
  assert.equal(info.insideVault, null);
  assert.equal(info.stem, 'AI 报告');
  const imported = await request('import_markdown_file', { file: outside, folder: 'Inbox', name: 'AI 报告', idempotencyKey: 'file-1' });
  assert.equal(imported.path, 'Inbox/AI 报告.md');
  assert.equal(await fs.readFile(path.join(vault, imported.path), 'utf8'), '---\ntitle: x\n---\n报告正文\n');
  assert.equal(await fs.readFile(outside, 'utf8'), '---\ntitle: x\n---\n报告正文\n');
  const own = await request('inspect_markdown_file', { file: path.join(vault, imported.path) });
  assert.equal(own.insideVault.name, 'vault');
  assert.equal(await request('import_markdown_file', { file: path.join(vault, imported.path), folder: 'Inbox' }), 'ALREADY_IN_VAULT');
  assert.equal(await request('inspect_markdown_file', { file: path.join(fixture, 'missing.md') }), 'NOT_REGULAR_FILE');
  assert.equal(await request('inspect_markdown_file', { file: 'relative.md' }), 'INVALID_PATH');
});

test('the host-resolved partner sets default folders, and .md opens offer an import', async () => {
  const vm = require('node:vm');
  const main = await fs.readFile(path.join(__dirname, '../obsidian-vault/main.js'), 'utf8');
  let settings = { inbox_folder: 'Inbox' };
  let listener;
  const dispatched = [];
  const results = [];
  const sent = [];
  const forms = [];
  let formAnswer = { ok: true, outcome: 'cancel' };
  const confirms = [];
  let confirmAnswers = [];
  const bots = { 'session-bot': { kind: 'bot', id: 'bot-1', label: '小助手' }, 'session-task': { kind: 'task', id: 'session-task', label: '普通任务' } };
  vm.runInNewContext(main, {
    setTimeout: (fn) => setTimeout(fn, 0),
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    cindy: {
      onHostMessage: (handler) => { listener = handler; },
      confirm: async (spec) => { confirms.push(spec); return confirmAnswers.shift() || { ok: true, confirmed: false }; },
      form: async (spec) => { forms.push(spec); return formAnswer; },
      send: async (message) => (message.type === 'tool-result' ? results : sent).push(message),
      targets: {
        resolve: async ({ session, target }) => {
          if (target) return { kind: 'bot', id: target.id, label: '小助手' };
          if (!bots[session]) throw Object.assign(new Error('gone'), { code: 'TARGET_UNAVAILABLE' });
          return bots[session];
        },
        list: async () => ({ targets: [{ kind: 'bot', id: 'bot-1', label: '小助手' }, { kind: 'bot', id: 'bot-2', label: 'Writer' }] }),
      },
      node: {
        async request({ method, params }) {
          dispatched.push({ method, params });
          if (method === 'check_folder') return { ok: true, result: { folder: params.folder.replace(/\/+$/, '') } };
          if (method === 'inspect_markdown_file') {
            return { ok: true, result: { name: 'r.md', stem: 'r', insideVault: params.file.startsWith('/vault/') ? { id: 'v' } : null, vaults: [{ id: 'v', name: 'Vault' }], defaultVault: 'v', inboxFolder: 'Inbox' } };
          }
          if (method === 'import_markdown_file') return { ok: true, result: { vault: { id: 'v', name: 'Vault' }, path: params.folder + '/r.md' } };
          return { ok: true, result: { vault: { id: 'v', name: 'Vault' }, path: params.path || 'x.md', action: 'created' } };
        },
      },
    },
    fetch: async (endpoint, options) => {
      if (options?.method === 'PUT') settings = JSON.parse(options.body);
      return { ok: true, json: async () => settings };
    },
  });
  const invoke = (tool, args) => listener({ type: 'tool-call', tool, args, callId: 'fixture' });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const lastCall = (method) => dispatched.filter((call) => call.method === method).at(-1);

  await invoke('write_note', { path: 'a.md', content: 'x', session_context: { session_id: 'session-bot' }, _companion: { id: 'forged', folder: 'Elsewhere' } });
  assert.deepEqual(plain(lastCall('write_note').params._companion), { id: 'bot-1', name: '小助手', folder: '伙伴/小助手' });
  assert.equal(lastCall('write_note').params.session_context, undefined);
  await invoke('write_note', { path: 'b.md', content: 'x', _companion: { id: 'forged', folder: 'Elsewhere' } });
  assert.equal(lastCall('write_note').params._companion, undefined);
  await invoke('write_note', { path: 'c.md', content: 'x', session_context: { session_id: 'session-task' } });
  assert.equal(lastCall('write_note').params._companion, undefined);
  await invoke('write_note', { path: 'd.md', mode: 'append', content: 'x', session_context: { session_id: 'session-bot' } });
  assert.equal(lastCall('write_note').params._companion, undefined);

  await invoke('set_companion_folder', { companionId: 'bot-1', folder: 'Agents/Helper/' });
  assert.deepEqual(settings.companion_folders['bot-1'], { folder: 'Agents/Helper', name: '小助手' });
  await invoke('vault_status', { session_context: { session_id: 'session-bot' } });
  assert.equal(lastCall('vault_status').params._companion.folder, 'Agents/Helper');
  await invoke('companion_folders', { sessionId: 'session-bot' });
  const listed = results.at(-1).result.structuredContent;
  assert.deepEqual(plain(listed.companions.map((item) => [item.name, item.folder, item.custom])), [['小助手', 'Agents/Helper', true], ['Writer', '伙伴/Writer', false]]);
  assert.equal(listed.current.folder, 'Agents/Helper');
  await invoke('set_companion_folder', { companionId: 'bot-1', folder: '' });
  assert.equal(settings.companion_folders['bot-1'], undefined);

  await invoke('capture_reply', { content: '# Hi', sessionId: 'session-bot', idempotencyKey: 'reply-x' });
  assert.equal(lastCall('capture_note').params.folder, '伙伴/小助手');
  assert.equal(lastCall('capture_note').params.frontmatter.companion, '小助手');
  await invoke('capture_reply', { content: '# Hi', sessionId: 'session-task', idempotencyKey: 'reply-y' });
  assert.equal(lastCall('capture_note').params.folder, 'Inbox');
  settings = { ...settings, companion_folder_root: '' };
  await invoke('capture_reply', { content: '# Hi', sessionId: 'session-bot', idempotencyKey: 'reply-z' });
  assert.equal(lastCall('capture_note').params.folder, 'Inbox');
  settings = { inbox_folder: 'Inbox' };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const open = async (file, requestId) => {
    await listener({ type: 'event', name: 'open-file', requestId, deadline: Date.now() + 15000, data: { path: file } });
    await settle();
  };
  await open('/vault/in.md', 'r1');
  assert.deepEqual(plain(sent.at(-1)), { type: 'file-open-result', requestId: 'r1', ok: false });
  formAnswer = { ok: true, outcome: 'submit', values: { vault: 'v', folder: '伙伴/Writer', customFolder: '', name: 'r' } };
  confirmAnswers = [{ ok: false, errorCode: 'BUSY' }, { ok: true, confirmed: true }];
  await open('/tmp/r.md', 'r2');
  assert.equal(confirms.length, 2);
  assert.ok(confirms.every((spec) => spec.confirmText.length <= 12 && spec.cancelText.length <= 12));
  assert.match(confirms[1].body, /伙伴\/Writer\/r\.md/);
  assert.equal(lastCall('open_in_obsidian').params.path, '伙伴/Writer/r.md');
  assert.deepEqual(plain(sent.at(-1)), { type: 'file-open-result', requestId: 'r2', ok: true });
  assert.deepEqual(plain(forms.at(-1).fields.find((field) => field.key === 'folder').options.map((option) => option.value)), ['Inbox', '伙伴/小助手', '伙伴/Writer']);
  assert.equal(lastCall('import_markdown_file').params.folder, '伙伴/Writer');
  formAnswer = { ok: true, outcome: 'action', action: 'open' };
  await open('/tmp/r.md', 'r3');
  assert.equal(lastCall('open_with_default_app').params.file, '/tmp/r.md');
  settings = { ...settings, md_open_prompt: false };
  const before = forms.length;
  await open('/tmp/r.md', 'r4');
  assert.deepEqual(plain(sent.at(-1)), { type: 'file-open-result', requestId: 'r4', ok: false });
  assert.equal(forms.length, before);
});

// Stands in for the official Obsidian CLI: answers from `responses`, records every call in `log`.
async function fakeObsidianCli(fixture, { vaultPath, responses }) {
  const preload = path.join(fixture, 'fake-obsidian-cli.cjs');
  const log = path.join(fixture, 'cli-calls.jsonl');
  await fs.writeFile(preload, `
    const fs = require('node:fs');
    const childProcess = require('node:child_process');
    const responses = ${JSON.stringify(responses)};
    const vaultPath = ${JSON.stringify(vaultPath)};
    const isCli = (file) => /(obsidian-cli|Obsidian\\.com|[\\\\/]obsidian)$/.test(String(file));
    const existsSync = fs.existsSync;
    const statSync = fs.statSync;
    fs.existsSync = (file) => isCli(file) || existsSync(file);
    fs.statSync = (file, ...rest) => (isCli(file) ? { isFile: () => true } : statSync(file, ...rest));
    childProcess.execFile = (file, args, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      let out = '';
      if (file === 'pgrep' || file === 'tasklist') out = '4242 Obsidian.exe\\n';
      else if (isCli(file)) {
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
        const command = args[0] && args[0].startsWith('vault=') ? args[1] : args[0];
        if (command === 'vault') out = responses.vault ?? vaultPath;
        else out = responses[command] ?? 'Error: Command "' + command + '" not found.';
      }
      process.nextTick(() => callback(null, out + '\\n', ''));
      return { on() {}, kill() {} };
    };
  `);
  return {
    preload,
    async calls() {
      const text = await fs.readFile(log, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

async function registeredVaultFixture(prefix) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const vault = path.join(fixture, 'vault');
  const home = path.join(fixture, 'home');
  await fs.mkdir(vault);
  const configDir = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'obsidian')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obsidian');
  await fs.mkdir(configDir, { recursive: true });
  const real = await fs.realpath(vault);
  await fs.writeFile(path.join(configDir, 'obsidian.json'), JSON.stringify({
    vaults: { abc123: { path: real, ts: 1, open: true } },
  }));
  return { fixture, vault: real, home };
}

const skipCliTests = process.platform === 'win32' || (process.platform !== 'darwin' && process.env.XDG_CONFIG_HOME)
  ? 'needs a private Obsidian config directory'
  : false;

test('link, tag and daily queries use the Obsidian CLI and never send it writes', { skip: skipCliTests }, async (t) => {
  const { fixture, vault, home } = await registeredVaultFixture('obsidian-cli-queries-');
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await fs.mkdir(path.join(vault, 'Journal'));
  await fs.writeFile(path.join(vault, 'Hub.md'), 'see [[Spoke]] and [[Ghost]] #topic\n');
  await fs.writeFile(path.join(vault, 'Spoke.md'), 'plain text, no links #topic/sub\n');
  await fs.writeFile(path.join(vault, 'Journal', 'Today in Obsidian.md'), '# today\n');
  const cli = await fakeObsidianCli(fixture, {
    vaultPath: vault,
    responses: {
      version: '1.15.1 (installer 1.15.1)',
      backlinks: JSON.stringify([{ file: 'Spoke.md' }]),
      links: 'Spoke.md\nGhost (unresolved)',
      tags: JSON.stringify([{ tag: '#topic', count: '7' }, { tag: '#topic/sub', count: '3' }, { tag: '#other', count: '1' }]),
      'daily:path': 'Journal/Today in Obsidian.md',
    },
  });
  const request = vaultWorker(t, vault, { home, preload: cli.preload });

  const graph = await request('graph_links', { vault: 'abc123', path: 'Hub.md' });
  assert.equal(graph.linkSource, 'obsidian-cli');
  assert.deepEqual(graph.backlinks.map((b) => b.path), ['Spoke.md']);
  assert.deepEqual(graph.outlinks.map((o) => [o.target, o.exists, o.resolvedPath]), [['Spoke', true, 'Spoke.md'], ['Ghost', false, null]]);

  const tags = await request('list_tags', { vault: 'abc123', prefix: 'topic' });
  assert.equal(tags.tagSource, 'obsidian-cli');
  assert.deepEqual(tags.tags.map((x) => [x.tag, x.count]), [['topic', 7], ['topic/sub', 3]]);
  assert.deepEqual(tags.tags[0].sampleNotes, ['Hub.md']);

  const today = await request('daily_note', { vault: 'abc123', action: 'read' });
  assert.equal(today.pathSource, 'obsidian-cli');
  assert.equal(today.path, 'Journal/Today in Obsidian.md');
  const pastDay = await request('daily_note', { vault: 'abc123', action: 'read', date: '2020-01-02' });
  assert.equal(pastDay.pathSource, 'daily-notes-config');
  assert.equal(pastDay.path, '2020-01-02.md');
  const overridden = await request('daily_note', { vault: 'abc123', action: 'read', settings: { daily_format: 'YYYY-MM-DD' } });
  assert.equal(overridden.pathSource, 'daily-notes-config');

  await request('daily_note', { vault: 'abc123', action: 'append', content: 'C:\\temp\\new and $\\theta$' });
  const written = await fs.readFile(path.join(vault, 'Journal', 'Today in Obsidian.md'), 'utf8');
  assert.match(written, /C:\\temp\\new and \$\\theta\$/);

  const commands = (await cli.calls()).map((args) => args.find((a) => !a.startsWith('vault=')));
  assert.ok(commands.every((c) => ['version', 'vault', 'backlinks', 'links', 'tags', 'daily:path'].includes(c)), commands.join(','));
  assert.ok((await cli.calls()).every((args) => args[0] === 'version' || args[0] === 'vault=abc123'));
});

test('CLI problems fall back to the local index', { skip: skipCliTests }, async (t) => {
  for (const [label, responses, reason] of [
    ['disabled', { version: 'Command line interface is not enabled. Please turn it on in Settings > General > Advanced.' }, 'CLI_UNAVAILABLE'],
    ['other vault', { version: '1.15.1', vault: '/somewhere/else' }, 'CLI_VAULT_MISMATCH'],
    ['error text', { version: '1.15.1', backlinks: 'Error: File "Hub.md" not found.' }, 'CLI_COMMAND_ERROR'],
    ['not json', { version: '1.15.1', backlinks: 'Hub.md', links: 'No links found.' }, 'CLI_UNEXPECTED_OUTPUT'],
  ]) {
    const { fixture, vault, home } = await registeredVaultFixture('obsidian-cli-fallback-');
    t.after(() => fs.rm(fixture, { recursive: true, force: true }));
    await fs.writeFile(path.join(vault, 'Hub.md'), 'see [[Spoke]]\n');
    await fs.writeFile(path.join(vault, 'Spoke.md'), 'back to [[Hub]]\n');
    const cli = await fakeObsidianCli(fixture, { vaultPath: vault, responses });
    const request = vaultWorker(t, vault, { home, preload: cli.preload });
    const graph = await request('graph_links', { vault: 'abc123', path: 'Hub.md' });
    assert.equal(graph.linkSource, 'filesystem', label);
    assert.equal(graph.cliFallbackReason, reason, label);
    assert.deepEqual(graph.backlinks.map((b) => b.path), ['Spoke.md'], label);
  }
});

test('the CLI adapter refuses values the CLI would rewrite', () => {
  const { _internal } = require('../obsidian-vault/node/obsidian-cli.cjs');
  assert.throws(() => _internal.assertSafeValue('Notes\\new.md'), { code: 'CLI_UNSAFE_ARGUMENT' });
  assert.throws(() => _internal.assertSafeValue('a\tb'), { code: 'CLI_UNSAFE_ARGUMENT' });
  assert.equal(_internal.assertSafeValue('笔记/a b.md'), '笔记/a b.md');
  assert.throws(() => _internal.parseOutput('Vault not found.'), { code: 'CLI_COMMAND_ERROR' });
  assert.deepEqual(_internal.parseJsonList('No backlinks found.'), []);
  assert.equal(_internal.ALLOWED_COMMANDS.has('create'), false);
  assert.equal(_internal.ALLOWED_COMMANDS.has('eval'), false);
});
