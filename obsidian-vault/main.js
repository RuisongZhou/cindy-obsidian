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

async function callWorker(method, params, callId, timeoutMs = 45000) {
  const action = params?.action;
  const mutates = method === 'write_note' || (method === 'replace_in_note' && !params?.dryRun) ||
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
      return '当前知识库：' + v.name + ' (' + v.path + ')，共 ' + (s ? s.noteCount : 0) + ' 篇笔记、' + (s ? s.totalWikilinks : 0) + ' 条双链、' + (s ? s.openTaskCount : 0) + ' 项未完待办。';
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
    case 'list_notes':
      return '目录「' + (data.folder || '/') + '」返回 ' + data.entries.length + ' 项' + (data.truncated ? '，结果不完整。' : '。');
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
      if (data.mode === 'tags') return '已返回 ' + (data.tags?.length || 0) + ' 个标签的分布统计。';
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

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  const { tool, args = {}, callId } = msg;

  try {
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
      const statusRes = await callWorker('vault_status', { vault: args.vault }, callId);
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
      };
      await sendSuccess(callId, '已打开 Obsidian 知识库工作台。', payload);
      return;
    }

    if (tool === 'write_note') {
      const mode = args.mode || 'create';
      let boundVaultId = args.vault;
      let boundPath = args.path;
      let expectedMtimeMs = null;

      if (mode === 'delete' || mode === 'overwrite') {
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
        if (mode === 'delete' && !target.exists) {
          await sendToolError(callId, '要删除的笔记「' + target.path + '」在知识库「' + target.vault.name + '」中不存在。', 'NOTE_NOT_FOUND');
          return;
        }
        if (mode === 'delete' || target.exists) {
          const actionDesc = mode === 'delete'
            ? '将知识库「' + target.vault.name + '」中的笔记「' + target.path + '」移入回收站 (.trash)？'
            : '整篇覆盖知识库「' + target.vault.name + '」中已有笔记「' + target.path + '」的全部内容？';
          const conf = await cindy.confirm({
            body: actionDesc,
            confirmText: mode === 'delete' ? '移入回收站' : '确认覆盖',
            cancelText: '取消',
            danger: true,
          });
          if (!conf || !conf.ok || !conf.confirmed) {
            await sendToolError(callId, '用户未确认该' + (mode === 'delete' ? '删除' : '覆盖') + '操作，笔记保持原样未修改。', 'CONFIRMATION_DECLINED');
            return;
          }
        }
      }

      const res = await callWorker(
        'write_note',
        { ...args, vault: boundVaultId, path: boundPath, ...(expectedMtimeMs !== null ? { expectedMtimeMs } : {}) },
        callId
      );
      if (!res.ok) {
        const { code, msg: errText } = extractWorkerError(res, '写入笔记失败。');
        await sendToolError(callId, errText, code, Boolean(res.data?.errorCode && code !== 'WRITE_OUTCOME_UNKNOWN'));
        return;
      }
      const r = res.result;
      const summary = mode === 'delete'
        ? '已将知识库「' + r.vault.name + '」中的笔记 ' + r.path + ' 移入回收站 (' + r.trashFile + ')。'
        : '已更新笔记 ' + r.path + '（动作: ' + r.action + '，知识库: ' + r.vault.name + '）。';
      await sendSuccess(callId, summary, r);
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
      'list_notes',
      'read_note',
      'replace_in_note',
      'manage_tags',
      'daily_note',
      'write_receipt',
      'graph_links',
      'open_in_obsidian',
    ]);

    if (directMethods.has(tool)) {
      const res = await callWorker(tool, args, callId);
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
