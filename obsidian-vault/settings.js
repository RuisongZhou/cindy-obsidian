const $ = (selector) => document.querySelector(selector);
const fields = [
  { key: 'default_vault', legacy: 'defaultVault', fallback: '' },
  { key: 'inbox_folder', legacy: 'inboxFolder', fallback: 'Inbox' },
  { key: 'daily_folder', legacy: 'dailyFolder', fallback: '' },
  { key: 'insert_style', legacy: 'insertStyle', fallback: 'wikilink' },
];
let baseline = null;
let chinese = true;
const ui = (zh, en) => chinese ? zh : en;
const message = (value) => { $('#msg').textContent = value; };

async function readSettings() {
  const response = await fetch('/kv');
  if (!response.ok) throw new Error('Settings unavailable');
  const settings = await response.json();
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings');
  return settings;
}

async function localize() {
  try {
    const response = await fetch('/app-context');
    if (!response.ok) return;
    const { context } = await response.json();
    chinese = /^(zh-CN|zh-Hans)(-|$)/i.test(context?.uiLocale ?? context?.locale ?? '');
    document.documentElement.lang = ui('zh-CN', 'en');
    for (const element of document.querySelectorAll('[data-en]')) {
      element.dataset.zh ??= element.textContent;
      element.textContent = ui(element.dataset.zh, element.dataset.en);
    }
  } catch {
    // The form remains usable if the host context cannot be loaded.
  }
}

function values() {
  return Object.fromEntries(fields.map(({ key, fallback }) => [key, $('#' + key).value.trim() || fallback]));
}

function updateSaveButton() {
  const current = values();
  $('#save').disabled = !baseline || $('#fields').disabled || fields.every(({ key }) => current[key] === baseline[key]);
}

async function load() {
  $('#retry').hidden = true;
  $('#fields').disabled = true;
  baseline = null;
  updateSaveButton();
  try {
    applySettings(await readSettings());
    $('#fields').disabled = false;
    message('');
  } catch {
    message(ui('读取设置失败，请重试。', 'Could not read preferences. Try again.'));
    $('#retry').hidden = false;
  }
  updateSaveButton();
}

function applySettings(settings) {
  for (const { key, legacy, fallback } of fields) {
    const value = settings[key] ?? settings[legacy];
    const field = $('#' + key);
    field.value = typeof value === 'string' ? value : fallback;
    if (key === 'insert_style' && !field.value) field.value = fallback;
  }
  baseline = values();
}

$('#preferences').oninput = updateSaveButton;
$('#retry').onclick = load;
$('#preferences').onsubmit = async (event) => {
  event.preventDefault();
  if ($('#save').disabled) return;
  const nextValues = values();
  for (const key of ['inbox_folder', 'daily_folder']) {
    const value = nextValues[key];
    if (/^[/\\]|^[A-Za-z]:|(?:^|[/\\])\.\.(?:$|[/\\])/.test(value)) {
      message(ui('收件箱和日记目录须使用库内相对路径。', 'Use vault-relative paths for the inbox and daily note folders.'));
      $('#' + key).focus();
      return;
    }
  }
  $('#fields').disabled = true;
  updateSaveButton();
  message(ui('正在保存…', 'Saving…'));
  try {
    const latest = await readSettings();
    for (const { key, legacy } of fields) {
      if (nextValues[key] === baseline[key]) continue;
      latest[key] = nextValues[key];
      delete latest[legacy];
    }
    const response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(latest) });
    if (!response.ok) throw new Error('Save failed');
    try {
      const channel = new BroadcastChannel('obsidian-vault');
      channel.postMessage({ type: 'settings-changed' });
      channel.close();
    } catch {
      // Other views can reload settings on their next request.
    }
    applySettings(latest);
    message(ui('已保存。', 'Preferences saved.'));
  } catch {
    message(ui('保存失败，已保留输入，请重试。', 'Could not save. Your edits are still here. Try again.'));
  } finally {
    if (baseline) $('#fields').disabled = false;
    updateSaveButton();
  }
};

void localize().then(load);
