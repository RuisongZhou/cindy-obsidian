const $ = (sel) => document.querySelector(sel);
let loadedOk = false;

async function init() {
  $('#save').disabled = true;
  try {
    const res = await fetch('/kv');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const cfg = (await res.json()) || {};
    $('#defaultVault').value = cfg.default_vault !== undefined ? String(cfg.default_vault) : (cfg.defaultVault || '');
    $('#inboxFolder').value = cfg.inbox_folder !== undefined ? String(cfg.inbox_folder) : (cfg.inboxFolder || 'Inbox');
    $('#dailyFolder').value = cfg.daily_folder !== undefined ? String(cfg.daily_folder) : (cfg.dailyFolder || '');
    $('#insertStyle').value = cfg.insert_style !== undefined ? String(cfg.insert_style) : (cfg.insertStyle || 'wikilink');
    loadedOk = true;
    $('#save').disabled = false;
  } catch {
    $('#msg').textContent = '读取设置失败，为避免覆盖现有配置已禁用保存，请刷新重试。';
  }
}

$('#save').onclick = async () => {
  if (!loadedOk) return;
  $('#save').disabled = true;
  $('#msg').textContent = '正在保存…';
  try {
    // Re-fetch latest /kv right before PUT so custom_vaults or cindy.ui.settings updates are never clobbered!
    const latestRes = await fetch('/kv');
    if (!latestRes.ok) throw new Error('HTTP ' + latestRes.status);
    const latestCfg = (await latestRes.json()) || {};
    const next = {
      ...latestCfg,
      default_vault: $('#defaultVault').value.trim(),
      inbox_folder: $('#inboxFolder').value.trim() || 'Inbox',
      daily_folder: $('#dailyFolder').value.trim(),
      insert_style: $('#insertStyle').value,
    };
    delete next.defaultVault;
    delete next.inboxFolder;
    delete next.dailyFolder;
    delete next.insertStyle;

    const putRes = await fetch('/kv', { method: 'PUT', body: JSON.stringify(next) });
    if (!putRes.ok) throw new Error('HTTP ' + putRes.status);
    try {
      new BroadcastChannel('obsidian-vault').postMessage({ type: 'settings-changed', settings: next });
    } catch {}
    $('#msg').textContent = '已保存';
  } catch {
    $('#msg').textContent = '保存失败，请重试';
  } finally {
    $('#save').disabled = false;
  }
};

void init();
