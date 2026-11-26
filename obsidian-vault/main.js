// Obsidian 知识库插件后台电子脑 (main.js)
let cachedSettings = null;
let cachedSettingsAt = 0;
let writeQueue = Promise.resolve();
let settingsChannel;
try {
  settingsChannel = new BroadcastChannel('obsidian-vault');
} catch {
  // Settings still refresh using the cache expiry.
}

async function getSettings(force = false, mustRead = false) {
  const now = Date.now();
  if (!force && cachedSettings && now - cachedSettingsAt < 2000) {
    return cachedSettings;
  }
  try {
    const res = await fetch('/kv');
    if (res.ok) {
      const json = await res.json();
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        cachedSettings = json;
        cachedSettingsAt = now;
        return cachedSettings;
      }
    }
  } catch {
    // ignore
  }
  if (mustRead) throw new Error('无法读取最新写入规则，本次修改已取消。');
  return cachedSettings || {};
}

async function patchSettings(patchObj) {
  const resGet = await fetch('/kv');
  if (!resGet.ok) {
    throw new Error('读取插件设置存储失败 (HTTP ' + resGet.status + ')');
  }
  const current = (await resGet.json()) || {};
  const next = { ...current };
  const patch = typeof patchObj === 'function' ? patchObj(current) : patchObj;
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const resPut = await fetch('/kv', { method: 'PUT', body: JSON.stringify(next) });
  if (!resPut.ok) {
    throw new Error('保存插件设置失败 (HTTP ' + resPut.status + ')');
  }
  cachedSettings = next;
  cachedSettingsAt = Date.now();
  try {
    settingsChannel?.postMessage({ type: 'settings-changed' });
  } catch {
    // The settings are already saved.
  }
  return next;
}

if (settingsChannel) {
  settingsChannel.onmessage = (ev) => {
    if (ev.data && ev.data.type === 'settings-changed') {
      cachedSettings = null;
      cachedSettingsAt = 0;
    }
  };
}

function serializeWrite(operation) {
  const result = writeQueue.then(operation);
  writeQueue = result.catch(() => {});
  return result;
}

const COMPANION_ROOT_DEFAULT = '伙伴';
const companionCache = new Map();
let companionLookupDenied = false;
let openFilePending = false;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function companionRoot(settings) {
  const raw = settings.companion_folder_root;
  return typeof raw === 'string' ? raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : COMPANION_ROOT_DEFAULT;
}

function folderSegment(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, 60)
    .trim();
}

function inboxFolder(settings) {
  const raw = settings.inbox_folder ?? settings.inboxFolder;
  return (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'Inbox';
}

// A partner uses its saved folder, otherwise <root>/<partner name>; a blank root turns the default off.
function companionFolder(companion, settings) {
  const saved = isPlainObject(settings.companion_folders) ? settings.companion_folders[companion.id] : null;
  if (isPlainObject(saved) && typeof saved.folder === 'string' && saved.folder.trim()) {
    return { folder: saved.folder.trim(), custom: true };
  }
  const root = companionRoot(settings);
  const segment = folderSegment(companion.name) || folderSegment(companion.id);
  return { folder: root && segment ? root + '/' + segment : null, custom: false };
}

// The host resolves only a partner's main conversation to that partner; other sessions return null.
async function companionForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || companionLookupDenied ||
      typeof cindy.targets?.resolve !== 'function') return null;
  const cached = companionCache.get(sessionId);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  let value = null;
  try {
    const target = await cindy.targets.resolve({ session: sessionId });
    if (target?.kind === 'bot' && typeof target.id === 'string') {
      value = { id: target.id, name: typeof target.label === 'string' ? target.label : '' };
    }
  } catch (err) {
    // Do not ask again after a refusal; saves fall back to the inbox.
    if (err?.code === 'PERMISSION_DENIED') companionLookupDenied = true;
  }
  companionCache.set(sessionId, { at: Date.now(), value });
  if (companionCache.size > 200) companionCache.delete(companionCache.keys().next().value);
  return value;
}

async function companionContext(sessionId, settings) {
  const companion = await companionForSession(sessionId);
  if (!companion) return null;
  const { folder } = companionFolder(companion, settings || await getSettings());
  return folder ? { id: companion.id, name: companion.name, folder } : null;
}

async function listCompanions(settings) {
  if (companionLookupDenied) return { companions: [], error: 'PERMISSION_DENIED' };
  if (typeof cindy.targets?.list !== 'function') return { companions: [], error: 'UNSUPPORTED' };
  try {
    const { targets } = await cindy.targets.list({ targetKind: 'bot' });
    const companions = (Array.isArray(targets) ? targets : []).slice(0, 100)
      .filter((target) => typeof target?.id === 'string')
      .map((target) => {
        const companion = { id: target.id, name: typeof target.label === 'string' ? target.label : '' };
        return { ...companion, ...companionFolder(companion, settings) };
      });
    return { companions, error: null };
  } catch (err) {
    if (err?.code === 'PERMISSION_DENIED') companionLookupDenied = true;
    return { companions: [], error: err?.code || 'UNAVAILABLE' };
  }
}

function newRequestKey() {
  try {
    return crypto.randomUUID();
  } catch {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
  }
}

function localTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

async function callWorker(method, params, callId, timeoutMs = 45000) {
  const action = params?.action;
  const mutates = method === 'write_note' || method === 'delete_note' ||
    method === 'capture_note' || method === 'import_markdown_file' ||
    (method === 'replace_in_note' && !params?.dryRun) ||
    (method === 'manage_tags' && params?.operation !== 'list') ||
    (method === 'daily_note' && Boolean(action) && action !== 'read') ||
    (method === 'canvas_ops' && Boolean(action) && action !== 'read' && action !== 'list');
  const run = async () => {
    const strict = mutates || method === 'inspect_write_target' || method === 'inspect_vault_write_policy';
    const settings = await getSettings(strict, strict);
    return cindy.node.request({
      method,
      params: { ...(params || {}), settings },
      ...(callId ? { callId } : {}),
      timeoutMs,
    });
  };
  return mutates || method === 'write_receipt' ? serializeWrite(run) : run();
}

function extractWorkerError(res, fallbackMsg) {
  const code = (res && res.data && res.data.errorCode) || (res && res.errorCode) || 'OBSIDIAN_ERROR';
  const msg = (res && res.message) || fallbackMsg || '操作未完成，请检查参数后重试。';
  return { code, msg };
}

function summarizeResult(tool, data) {
  if (!data || typeof data !== 'object') return '操作已完成。';
  switch (tool) {
    case 'vault_status': {
      const v = data.activeVault;
      if (!v) return data.activeVaultError || '尚未检测到可用的 Obsidian 知识库。';
      const s = data.summary;
      return '当前知识库：' + v.name + ' (' + v.path + ')，共 ' + (s ? s.noteCount : 0) + ' 篇笔记、' + (s ? s.totalWikilinks : 0) + ' 条双链、' + (s ? s.openTaskCount : 0) + ' 项未完待办。' +
        (s?.companion?.folder ? '当前伙伴「' + s.companion.name + '」的默认保存目录：' + s.companion.folder + '。' : '');
    }
    case 'search_notes': {
      const list = (data.results || []).map((r, i) => {
        const match = r.matches?.[0];
        const position = match ? '（正文第 ' + match.line + ' 行，第 ' + match.column + ' 列）' : '';
        const tags = r.tags?.length ? ' [#' + r.tags.join(' #') + ']' : '';
        return (i + 1 + (data.offset || 0)) + '. ' + r.path + position + tags + '\n   ' + (r.snippet || '');
      }).join('\n');
      return '在知识库「' + (data.vault?.name || '') + '」中找到 ' + (data.totalMatches || 0) + ' 篇匹配笔记' + (list ? '：\n' + list : '。') + (data.nextCursor ? '\n还有结果，可使用 nextCursor 获取下一页。' : '');
    }
    case 'list_files':
      return '目录「' + (data.folder || '/') + '」返回 ' + data.entries.length + ' 项' + (data.truncated ? '，结果不完整。' : '。');
    case 'list_tags':
      return '知识库「' + (data.vault?.name || '') + '」共有 ' + (data.totalTags || 0) + ' 个匹配标签，已返回前 ' + (data.tags?.length || 0) + ' 个。';
    case 'delete_note':
      return '已将知识库「' + (data.vault?.name || '') + '」中的笔记 ' + data.path + ' 移入回收站 (' + data.trashFile + ')。';
    case 'replace_in_note':
      return data.path + '：' + (data.action === 'preview' ? '预览找到 ' : '已处理 ') + data.matchCount + ' 处匹配。';
    case 'manage_tags':
      return data.path + ' 的 Frontmatter 标签：' + (data.tags.join(', ') || '无') + '。实际修改 ' + data.applied.length + ' 项。';
    case 'read_note': {
      const header = '笔记：' + data.path + '（知识库：' + (data.vault?.name || '') + '，反向链接 ' + (data.backlinks?.length || 0) + '，出链 ' + (data.outlinks?.length || 0) + '）';
      return header + '\n\n' + (data.content || '');
    }
    case 'daily_note': {
      if (!data.exists) return data.message || ('日记 ' + data.path + ' 尚未创建。');
      return '日记：' + data.path + ' (' + (data.date || '') + (data.updatedAction ? ', ' + data.updatedAction : '') + ')\n\n' + (data.content || '');
    }
    case 'graph_links': {
      if (data.mode === 'orphans') return '共发现 ' + data.count + ' 篇孤立笔记。';
      if (data.mode === 'hubs') return '已返回连接度最高的 ' + (data.hubs?.length || 0) + ' 篇枢纽笔记。';
      return '笔记「' + (data.note?.path || '') + '」图谱：出链 ' + (data.outlinks?.length || 0) + ' 条，反向链接 ' + (data.backlinks?.length || 0) + ' 条，未连接提及 ' + (data.unlinkedMentions?.length || 0) + ' 处，二跳关联 ' + (data.relatedTwoHop?.length || 0) + ' 篇。';
    }
    case 'canvas_ops': {
      if (data.canvases) return '共找到 ' + data.canvases.length + ' 个 Canvas 白板。';
      if (data.canvas) return '已读取白板 ' + data.path + '（节点 ' + (data.nodes?.length || 0) + ' 个，连线 ' + (data.edges?.length || 0) + ' 条）。';
      return '已保存白板 ' + data.path + '（' + data.action + '，节点 ' + data.nodeCount + ' 个，连线 ' + data.edgeCount + ' 条）。';
    }
    case 'open_in_obsidian':
      return '已向执行电脑上的 Obsidian 发送打开请求：' + (data.path || data.vault?.name || '');
    default:
      return '操作已完成。';
  }
}

function sendSuccess(callId, summaryText, data) {
  return cindy.send({
    type: 'tool-result',
    callId,
    ok: true,
    result: {
      content: [{ type: 'text', text: summaryText }],
      structuredContent: data,
    },
  });
}

function sendToolError(callId, message, errorCode = 'OBSIDIAN_ERROR', writeNotCommitted = false) {
  return cindy.send({
    type: 'tool-result',
    callId,
    ok: true,
    result: {
      isError: true,
      content: [{ type: 'text', text: '[' + errorCode + '] ' + String(message || '操作未完成，请检查参数后重试。') }],
      structuredContent: { ok: false, errorCode, message: String(message || '操作未完成'), ...(writeNotCommitted ? { writeNotCommitted } : {}) },
    },
  });
}

const CONFIRM_BUTTON_MAX = 12;
const CONFIRM_RETRY_CODES = new Set(['BUSY', 'RATE_LIMITED', 'UNAVAILABLE']);

// Host limits: body ≤300 and buttons ≤12 characters, one dialog at a time, 3 s between requests.
// A dialog that could not be shown is asked once more after the interval.
async function confirmWithRetry(spec) {
  const request = {
    ...spec,
    body: clip(spec.body, 300),
    ...(spec.confirmText ? { confirmText: clip(spec.confirmText, CONFIRM_BUTTON_MAX) } : {}),
    ...(spec.cancelText ? { cancelText: clip(spec.cancelText, CONFIRM_BUTTON_MAX) } : {}),
  };
  let answer = await cindy.confirm(request).catch(() => null);
  if (!answer?.ok && (!answer || CONFIRM_RETRY_CODES.has(answer.errorCode))) {
    await new Promise((resolve) => setTimeout(resolve, 3200));
    answer = await cindy.confirm(request).catch(() => null);
  }
  return answer;
}

async function openWithDefaultApp(file) {
  try {
    const res = await cindy.node.request({ method: 'open_with_default_app', params: { file }, timeoutMs: 10000 });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

async function askToImportMarkdown(file, info, settings) {
  const { companions } = await listCompanions(settings);
  const folderOptions = [{ value: info.inboxFolder, label: '收件箱 · ' + info.inboxFolder }];
  for (const companion of companions) {
    if (companion.folder && !folderOptions.some((option) => option.value === companion.folder)) {
      folderOptions.push({ value: companion.folder, label: clip((companion.name || '伙伴') + ' · ' + companion.folder, 120) });
    }
    if (folderOptions.length >= 50) break;
  }
  const fields = [];
  if (info.vaults.length > 1) {
    fields.push({ type: 'select', key: 'vault', label: '知识库', required: true,
      options: info.vaults.slice(0, 50).map((vault) => ({ value: vault.id, label: clip(vault.name, 120) })) });
  }
  fields.push(
    { type: 'select', key: 'folder', label: '保存到', required: true, options: folderOptions },
    { type: 'text', key: 'customFolder', label: '其他目录', placeholder: '可选，例如 项目/调研', maxLength: 240 },
    { type: 'text', key: 'name', label: '笔记名称', required: true, maxLength: 120 },
  );
  const answer = await cindy.form({
    title: '添加到 Obsidian',
    description: clip('把「' + info.name + '」复制一份到 Obsidian 知识库，原文件保持不变。', 300),
    fields,
    values: { vault: info.defaultVault || info.vaults[0].id, folder: info.inboxFolder, customFolder: '', name: info.stem },
    submitText: '添加到 Obsidian',
    cancelText: '取消',
    action: { id: 'open', text: '用默认应用打开' },
  }).catch(() => null);

  // The open was already claimed, so any failure to ask falls back to the usual default-app open.
  if (!answer?.ok || (answer.outcome === 'action' && answer.action === 'open')) {
    await openWithDefaultApp(file);
    return;
  }
  if (answer.outcome !== 'submit') return;

  const values = answer.values || {};
  const vaultId = typeof values.vault === 'string' && values.vault ? values.vault : (info.defaultVault || info.vaults[0].id);
  const folder = (typeof values.customFolder === 'string' && values.customFolder.trim()) ||
    (typeof values.folder === 'string' && values.folder) || info.inboxFolder;
  const res = await callWorker('import_markdown_file', {
    file, vault: vaultId, folder, name: typeof values.name === 'string' ? values.name : info.stem, idempotencyKey: newRequestKey(),
  }).catch((err) => ({ ok: false, message: err?.message }));

  if (res.ok) {
    const saved = res.result;
    const shown = await confirmWithRetry({
      body: '已添加到知识库「' + saved.vault.name + '」：' + saved.path,
      confirmText: '打开笔记',
      cancelText: '完成',
    });
    if (shown?.ok && shown.confirmed) await callWorker('open_in_obsidian', { vault: saved.vault.id, path: saved.path }).catch(() => {});
    return;
  }
  const failure = await confirmWithRetry({
    body: '没有添加到 Obsidian：' + extractWorkerError(res, '保存失败。').msg,
    confirmText: '用默认应用打开',
    cancelText: '关闭',
  });
  if (failure?.ok && failure.confirmed) await openWithDefaultApp(file);
}

// Cindy hands over a local .md file the user is opening with the default app.
async function handleOpenFile(msg) {
  const requestId = msg.requestId;
  const file = msg.data?.path;
  const reply = (ok) => cindy.send({ type: 'file-open-result', requestId, ok });
  let settings;
  let info;
  try {
    settings = await getSettings(true);
    if (settings.md_open_prompt === false || typeof cindy.form !== 'function' || openFilePending || typeof file !== 'string') {
      await reply(false);
      return;
    }
    const res = await cindy.node.request({ method: 'inspect_markdown_file', params: { file, settings }, timeoutMs: 8000 });
    // Notes already in a vault and setups without a vault keep the usual open.
    if (!res?.ok || res.result.insideVault || !res.result.vaults.length) {
      await reply(false);
      return;
    }
    info = res.result;
  } catch {
    await reply(false);
    return;
  }
  openFilePending = true;
  try {
    await reply(true);
    await askToImportMarkdown(file, info, settings);
  } finally {
    openFilePending = false;
  }
}

cindy.onHostMessage(async function (msg) {
  if (msg?.type === 'event' && msg.name === 'open-file') {
    // The dialog can stay open for minutes; do not hold up other host messages.
    void handleOpenFile(msg).catch(() => {});
    return;
  }
  if (!msg || msg.type !== 'tool-call') return;
  const { tool, callId } = msg;
  // session_context is minted by the host for Agent calls; _companion is only set below.
  const { session_context: sessionContext, _companion: _ignored, ...args } = isPlainObject(msg.args) ? msg.args : {};

  try {
    if (tool === 'companion_folders') {
      const settings = await getSettings(true);
      const { companions, error } = await listCompanions(settings);
      const current = await companionContext(args.sessionId, settings);
      await sendSuccess(callId, '已读取 ' + companions.length + ' 位伙伴的专属文件夹。', {
        root: companionRoot(settings),
        inboxFolder: inboxFolder(settings),
        companions,
        current,
        error,
      });
      return;
    }

    if (tool === 'set_companion_folder') {
      const id = args.companionId;
      if (typeof id !== 'string' || !id || id.length > 200) {
        await sendToolError(callId, '请选择一位伙伴。', 'INVALID_COMPANION');
        return;
      }
      if (typeof cindy.targets?.resolve !== 'function') {
        await sendToolError(callId, '当前 Cindy 版本无法查询伙伴。', 'UNSUPPORTED');
        return;
      }
      let target;
      try {
        target = await cindy.targets.resolve({ target: { kind: 'bot', id } });
      } catch (err) {
        await sendToolError(callId, '找不到这位伙伴，或伙伴已停用。', err?.code || 'TARGET_UNAVAILABLE');
        return;
      }
      let folder = null;
      if (typeof args.folder === 'string' && args.folder.trim()) {
        const checked = await callWorker('check_folder', { folder: args.folder }, callId);
        if (!checked.ok) {
          const error = extractWorkerError(checked, '目录无效。');
          await sendToolError(callId, error.msg, error.code);
          return;
        }
        folder = checked.result.folder;
      }
      const next = await serializeWrite(() => patchSettings((settings) => {
        const map = isPlainObject(settings.companion_folders) ? { ...settings.companion_folders } : {};
        if (folder) map[id] = { folder, name: target.label || '' };
        else delete map[id];
        return { companion_folders: map };
      }));
      const companion = { id, name: target.label || '' };
      const result = { ...companion, ...companionFolder(companion, next) };
      await sendSuccess(callId, (result.folder ? '伙伴「' + companion.name + '」的专属文件夹：' + result.folder : '伙伴「' + companion.name + '」不使用专属文件夹。'), { companion: result });
      return;
    }

    if (tool === 'capture_reply') {
      if (typeof args.content !== 'string' || !args.content.trim()) {
        await sendToolError(callId, '这条回复还没有可保存的正文。', 'EMPTY_CONTENT', true);
        return;
      }
      const settings = await getSettings(true, true);
      const companion = await companionContext(args.sessionId, settings);
      const res = await callWorker('capture_note', {
        vault: args.vault,
        folder: companion?.folder || inboxFolder(settings),
        title: args.title,
        content: args.content,
        frontmatter: { source: 'Cindy', created: localTimestamp(), ...(companion ? { companion: companion.name } : {}) },
        idempotencyKey: args.idempotencyKey,
      }, callId);
      if (!res.ok) {
        const { code, msg: errText } = extractWorkerError(res, '保存失败。');
        await sendToolError(callId, errText, code, Boolean(res.data?.errorCode && code !== 'WRITE_OUTCOME_UNKNOWN'));
        return;
      }
      await sendSuccess(callId, '已保存到 ' + res.result.path + '。', { ...res.result, companion });
      return;
    }

    if (tool === 'complete_notes') {
      const res = await callWorker('complete_notes', { trigger: args.trigger || '@', query: args.query || '' }, callId, 2000);
      const items = res.ok && res.result && Array.isArray(res.result.items) ? res.result.items : [];
      await cindy.send({
        type: 'tool-result',
        callId,
        ok: true,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ items }) }],
          structuredContent: { items },
        },
      });
      return;
    }

    if (tool === 'pick_vault_dir') {
      const picked = await cindy.pick({
        mode: 'directory',
        title: '选择 Obsidian 知识库 (Vault) 根目录',
        callId,
      });
      if (!picked?.ok || typeof picked.path !== 'string' || !picked.path) {
        const code = picked?.errorCode || 'PICK_FAILED';
        const msgText = code === 'CANCELLED'
          ? '已取消目录选择。'
          : '无法打开系统目录选择器，请到运行本插件的电脑上添加知识库。';
        await sendToolError(callId, msgText, code);
        return;
      }
      const latest = await getSettings(true);
      const prevList = Array.isArray(latest.custom_vaults)
        ? [...latest.custom_vaults]
        : (Array.isArray(latest.customVaults) ? [...latest.customVaults] : []);
      if (picked.path && !prevList.some((v) => (typeof v === 'string' ? v : v && v.path) === picked.path)) {
        prevList.push({ name: picked.name || 'Vault', path: picked.path });
      }
      await serializeWrite(() => patchSettings({
        default_vault: picked.path || latest.default_vault || '',
        custom_vaults: prevList,
        defaultVault: undefined,
        customVaults: undefined,
      }));
      const statusRes = await callWorker('vault_status', { vault: picked.path, refresh: true }, callId);
      const data = statusRes.ok ? statusRes.result : { picked, scanWarning: statusRes.message };
      await sendSuccess(callId, '已添加并切换默认知识库为：' + (picked.name || picked.path), data);
      return;
    }

    if (tool === 'set_vault_write_policy') {
      if (typeof args.restrictFolders !== 'boolean' || !Array.isArray(args.folders)) {
        await sendToolError(callId, '请选择有效的写入范围。', 'INVALID_WRITE_POLICY');
        return;
      }
      const checked = await callWorker('inspect_vault_write_policy', {
        vault: args.vault,
        policy: { readOnly: args.readOnly, writeFolders: args.restrictFolders ? args.folders : null },
      }, callId);
      if (!checked.ok) {
        const error = extractWorkerError(checked);
        await sendToolError(callId, error.msg, error.code);
        return;
      }
      const { vault, policy } = checked.result;
      const scope = policy.readOnly ? '只读' : policy.writeFolders === null ? '允许写入全库' :
        policy.writeFolders.length ? '仅允许写入 ' + policy.writeFolders.length + ' 个指定目录' : '不允许写入任何目录';
      const confirmation = await cindy.confirm({
        body: '更新执行电脑上知识库「' + vault.name + '」的插件写入规则：' + scope + '？',
        confirmText: '保存规则',
      });
      if (!confirmation?.ok || !confirmation.confirmed) {
        await sendToolError(callId, '写入规则未更改。', 'CONFIRMATION_DECLINED');
        return;
      }
      await serializeWrite(() => patchSettings((settings) => ({
        vault_write_policies: { ...settings.vault_write_policies, [vault.path]: policy },
      })));
      await sendSuccess(callId, '已保存知识库写入规则。', { vault, policy });
      return;
    }

    if (tool === 'open_workbench') {
      const companion = await companionContext(sessionContext?.session_id);
      const statusRes = await callWorker('vault_status', { vault: args.vault, _companion: companion }, callId);
      if (!statusRes.ok) {
        const { code, msg: errText } = extractWorkerError(statusRes, '读取 Obsidian 知识库状态失败。');
        await sendToolError(callId, errText, code);
        return;
      }
      const vaultId = statusRes.result?.activeVault?.id || args.vault;
      let initialNote = null;
      let initialNoteError = null;
      if (args.path || args.title) {
        const noteRes = await callWorker('read_note', { vault: vaultId, path: args.path, title: args.title }, callId);
        if (noteRes.ok) initialNote = noteRes.result;
        else initialNoteError = noteRes.message;
      }
      let searchResults = null;
      if (typeof args.query === 'string' && args.query.trim()) {
        const sRes = await callWorker('search_notes', { vault: vaultId, query: args.query.trim(), limit: 20 }, callId);
        if (sRes.ok) searchResults = sRes.result;
      }
      const payload = {
        mode: args.mode || 'browse',
        query: args.query || '',
        status: statusRes.result,
        initialNote,
        initialNoteError,
        searchResults,
        companion,
      };
      await sendSuccess(callId, '已打开 Obsidian 知识库工作台。', payload);
      return;
    }

    if (tool === 'write_note') {
      const mode = args.mode || 'create';
      let boundVaultId = args.vault;
      let boundPath = args.path;
      let expectedMtimeMs = null;

      if (mode === 'overwrite') {
        const inspectRes = await callWorker('inspect_write_target', { vault: args.vault, path: args.path, ext: '.md' }, callId);
        if (!inspectRes.ok) {
          const { code, msg: errText } = extractWorkerError(inspectRes, '无法核验目标笔记路径。');
          await sendToolError(callId, errText, code);
          return;
        }
        const target = inspectRes.result;
        boundVaultId = target.vault.id;
        boundPath = target.path;
        expectedMtimeMs = target.mtimeMs;
        if (target.exists) {
          const conf = await cindy.confirm({
            body: '整篇覆盖知识库「' + target.vault.name + '」中已有笔记「' + target.path + '」的全部内容？',
            confirmText: '确认覆盖',
            cancelText: '取消',
            danger: true,
          });
          if (!conf || !conf.ok || !conf.confirmed) {
            await sendToolError(callId, '用户未确认该覆盖操作，笔记保持原样未修改。', 'CONFIRMATION_DECLINED');
            return;
          }
        }
      }

      const companion = mode === 'create' ? await companionContext(sessionContext?.session_id) : null;
      const res = await callWorker(
        'write_note',
        {
          ...args,
          vault: boundVaultId,
          path: boundPath,
          ...(expectedMtimeMs !== null ? { expectedMtimeMs } : {}),
          ...(companion ? { _companion: companion } : {}),
        },
        callId
      );
      if (!res.ok) {
        const { code, msg: errText } = extractWorkerError(res, '写入笔记失败。');
        await sendToolError(callId, errText, code, Boolean(res.data?.errorCode && code !== 'WRITE_OUTCOME_UNKNOWN'));
        return;
      }
      const r = res.result;
      const summary = '已更新笔记 ' + r.path + '（动作: ' + r.action + '，知识库: ' + r.vault.name + '）。' +
        (r.redirectedFrom ? '已按伙伴「' + (companion?.name || '') + '」的专属文件夹保存（原路径 ' + r.redirectedFrom + '）。' : '') +
        (r.companionFolderWarning ? r.companionFolderWarning : '');
      await sendSuccess(callId, summary, r);
      return;
    }

    if (tool === 'delete_note') {
      const inspectRes = await callWorker('inspect_write_target', { vault: args.vault, path: args.path, ext: '.md' }, callId);
      if (!inspectRes.ok) {
        const { code, msg: errText } = extractWorkerError(inspectRes, '无法核验目标笔记路径。');
        await sendToolError(callId, errText, code);
        return;
      }
      const target = inspectRes.result;
      if (!target.exists) {
        await sendToolError(callId, '要移入回收站的笔记「' + target.path + '」在知识库「' + target.vault.name + '」中不存在。', 'NOTE_NOT_FOUND');
        return;
      }
      const conf = await cindy.confirm({
        body: '将知识库「' + target.vault.name + '」中的笔记「' + target.path + '」移入回收站 (.trash)？',
        confirmText: '移入回收站',
        cancelText: '取消',
        danger: true,
      });
      if (!conf || !conf.ok || !conf.confirmed) {
        await sendToolError(callId, '用户未确认移入回收站操作，笔记保持原样未修改。', 'CONFIRMATION_DECLINED');
        return;
      }
      const res = await callWorker(
        'delete_note',
        { ...args, vault: target.vault.id, path: target.path, expectedMtimeMs: target.mtimeMs },
        callId
      );
      if (!res.ok) {
        const { code, msg: errText } = extractWorkerError(res, '移入回收站失败。');
        await sendToolError(callId, errText, code, Boolean(res.data?.errorCode && code !== 'WRITE_OUTCOME_UNKNOWN'));
        return;
      }
      await sendSuccess(callId, summarizeResult('delete_note', res.result), res.result);
      return;
    }

    if (tool === 'canvas_ops') {
      const action = args.action || 'list';
      let boundVaultId = args.vault;
      let boundPath = args.path;
      let expectedMtimeMs = null;

      if (action === 'overwrite') {
        const inspectRes = await callWorker('inspect_write_target', { vault: args.vault, path: args.path, ext: '.canvas' }, callId);
        if (!inspectRes.ok) {
          const { code, msg: errText } = extractWorkerError(inspectRes, '无法核验目标白板路径。');
          await sendToolError(callId, errText, code);
          return;
        }
        const target = inspectRes.result;
        boundVaultId = target.vault.id;
        boundPath = target.path;
        expectedMtimeMs = target.mtimeMs;
        if (target.exists) {
          const conf = await cindy.confirm({
            body: '整板替换知识库「' + target.vault.name + '」中已有白板「' + target.path + '」的全部节点与连线？',
            confirmText: '确认替换',
            cancelText: '取消',
            danger: true,
          });
          if (!conf || !conf.ok || !conf.confirmed) {
            await sendToolError(callId, '用户未确认替换已有白板，文件未修改。', 'CONFIRMATION_DECLINED');
            return;
          }
        }
      }

      const res = await callWorker(
        'canvas_ops',
        { ...args, ...(boundVaultId ? { vault: boundVaultId } : {}), ...(boundPath ? { path: boundPath } : {}), ...(expectedMtimeMs !== null ? { expectedMtimeMs } : {}) },
        callId
      );
      if (!res.ok) {
        const { code, msg: errText } = extractWorkerError(res, '操作 Canvas 白板失败。');
        await sendToolError(callId, errText, code);
        return;
      }
      await sendSuccess(callId, summarizeResult('canvas_ops', res.result), res.result);
      return;
    }

    const directMethods = new Set([
      'vault_status',
      'search_notes',
      'list_files',
      'list_tags',
      'read_note',
      'replace_in_note',
      'manage_tags',
      'daily_note',
      'write_receipt',
      'graph_links',
      'open_in_obsidian',
    ]);

    if (directMethods.has(tool)) {
      const params = tool === 'vault_status' ? { ...args, _companion: await companionContext(sessionContext?.session_id) } : args;
      const res = await callWorker(tool, params, callId);
      if (!res.ok) {
        const { code, msg: errText } = extractWorkerError(res, '执行 Obsidian 工具失败。');
        const rejectedWrite = tool === 'daily_note' && args.action !== 'read' &&
          res.data?.errorCode && code !== 'WRITE_OUTCOME_UNKNOWN';
        await sendToolError(callId, errText, code, Boolean(rejectedWrite));
        return;
      }
      await sendSuccess(callId, summarizeResult(tool, res.result), res.result);
      return;
    }

    await sendToolError(callId, '未知工具调用: ' + tool, 'UNKNOWN_TOOL');
  } catch (err) {
    await sendToolError(callId, err && err.message ? err.message : '插件内部执行异常。', 'INTERNAL_PLUGIN_ERROR');
  }
});
