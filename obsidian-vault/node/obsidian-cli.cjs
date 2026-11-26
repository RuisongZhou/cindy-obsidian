'use strict';

// Thin adapter over the official Obsidian CLI (Settings → General → Command line interface).
//
// Behaviour verified against Obsidian 1.15.1 on macOS:
// - The exit code is 0 even on failure; errors are plain text ("Error: …", "Vault not found.").
// - Empty results are English sentences ("No backlinks found."), not "[]".
// - `content=` values have every "\n" / "\t" turned into newline / tab with no escape, so note
//   bodies are never sent through the CLI; this adapter only runs read-only queries and `open`.
// - rename/move can block on an in-app "update links?" dialog, so they are not exposed either.
//
// Every caller must treat a thrown error as "CLI unavailable for this call" and fall back to the
// filesystem implementation.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 4000;
const PROBE_TIMEOUT_MS = 1500;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SESSION_TTL_MS = 30000;

// Only these commands may ever be run. Nothing model-controlled selects a command name.
const ALLOWED_COMMANDS = new Set(['version', 'vault', 'backlinks', 'links', 'tags', 'daily:path', 'open']);

const EMPTY_RESULT_RE = /^No [\w ]+ found\.$/;

function cliError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function trustedBinaryCandidates() {
  const list = [];
  if (process.platform === 'darwin') {
    list.push('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli');
    list.push(path.join(os.homedir(), 'Applications', 'Obsidian.app', 'Contents', 'MacOS', 'obsidian-cli'));
  } else if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    list.push(path.join(localApp, 'Programs', 'obsidian', 'Obsidian.com'));
  } else {
    list.push(path.join(os.homedir(), '.local', 'bin', 'obsidian'));
    list.push('/usr/bin/obsidian');
    list.push('/usr/local/bin/obsidian');
  }
  return list;
}

function execText(file, args, timeout) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (err, stdout, stderr) => {
      const text = String(stdout || '') + (stderr ? String(stderr) : '');
      if (err) {
        err.outputText = text;
        reject(err);
        return;
      }
      resolve(text);
    });
  });
}

function classifyUnavailable(text) {
  if (/Command line interface is not enabled/i.test(text)) return 'cli-disabled';
  if (/unable to find Obsidian/i.test(text)) return 'not-running';
  return null;
}

// Without this check, the first CLI command would launch Obsidian when it is closed.
async function isObsidianRunning() {
  try {
    if (process.platform === 'win32') {
      const out = await execText('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'], PROBE_TIMEOUT_MS);
      return /obsidian\.exe/i.test(out);
    }
    const out = await execText('pgrep', ['-xi', 'obsidian'], PROBE_TIMEOUT_MS);
    return out.trim().length > 0;
  } catch {
    return false; // pgrep exits 1 when nothing matches; unknown counts as not running
  }
}

async function detectObsidianCli() {
  for (const bin of trustedBinaryCandidates()) {
    let isFile = false;
    try { isFile = fs.existsSync(bin) && fs.statSync(bin).isFile(); } catch { isFile = false; }
    if (!isFile) continue;
    if (!(await isObsidianRunning())) {
      return { installed: true, running: false, cliEnabled: null, binary: bin };
    }
    let out = '';
    try {
      out = (await execText(bin, ['version'], PROBE_TIMEOUT_MS)).trim();
    } catch (err) {
      out = String(err.outputText || err.message || '').trim();
      const reason = classifyUnavailable(out);
      if (!reason) return { installed: true, running: true, cliEnabled: null, binary: bin, message: out.slice(0, 300) };
    }
    const reason = classifyUnavailable(out);
    if (reason === 'cli-disabled') return { installed: true, running: true, cliEnabled: false, binary: bin, message: out };
    if (reason === 'not-running') return { installed: true, running: false, cliEnabled: true, binary: bin, message: out };
    if (!out) return { installed: true, running: true, cliEnabled: null, binary: bin };
    return { installed: true, running: true, cliEnabled: true, binary: bin, version: out.split(/\r?\n/)[0].slice(0, 120) };
  }
  return { installed: false, running: false, cliEnabled: false, binary: null };
}

function assertSafeValue(value) {
  const str = String(value);
  // The CLI rewrites "\n" and "\t" inside values, and control characters have no place in paths or ids.
  if (/[\u0000-\u001f\u007f\\]/.test(str)) {
    throw cliError('CLI_UNSAFE_ARGUMENT', 'Value cannot be passed to the Obsidian CLI unchanged.');
  }
  return str;
}

function parseOutput(text) {
  const trimmed = text.replace(/\r\n/g, '\n').trim();
  const reason = classifyUnavailable(trimmed);
  if (reason) throw cliError('CLI_UNAVAILABLE', reason);
  if (/^Error:/i.test(trimmed) || trimmed === 'Vault not found.') {
    throw cliError('CLI_COMMAND_ERROR', trimmed.split('\n')[0].slice(0, 300));
  }
  return trimmed;
}

function parseJsonList(text) {
  if (EMPTY_RESULT_RE.test(text)) return [];
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw cliError('CLI_UNEXPECTED_OUTPUT', 'Obsidian CLI returned output that is not JSON.');
  }
  if (!Array.isArray(value)) throw cliError('CLI_UNEXPECTED_OUTPUT', 'Obsidian CLI returned an unexpected JSON shape.');
  return value;
}

function parseLines(text) {
  if (!text || EMPTY_RESULT_RE.test(text)) return [];
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function createSession(binary, vault, version) {
  async function run(command, params = {}, flags = []) {
    if (!ALLOWED_COMMANDS.has(command)) throw cliError('CLI_COMMAND_NOT_ALLOWED', command);
    const args = ['vault=' + assertSafeValue(vault.id), command];
    for (const [key, value] of Object.entries(params)) args.push(key + '=' + assertSafeValue(value));
    args.push(...flags);
    let text;
    try {
      text = await execText(binary, args, DEFAULT_TIMEOUT_MS);
    } catch (err) {
      if (err && err.killed) throw cliError('CLI_TIMEOUT', 'Obsidian CLI did not answer in time.');
      throw cliError('CLI_EXEC_FAILED', String((err && err.message) || 'Obsidian CLI failed').slice(0, 300));
    }
    return parseOutput(text);
  }

  return {
    binary,
    version,
    vaultId: vault.id,
    async vaultPath() {
      return run('vault', { info: 'path' });
    },
    async backlinks(relPath) {
      const rows = parseJsonList(await run('backlinks', { path: relPath, format: 'json' }));
      return rows
        .map((row) => (row && typeof row.file === 'string' ? row.file : null))
        .filter(Boolean);
    },
    async links(relPath) {
      const resolved = [];
      const unresolved = [];
      for (const line of parseLines(await run('links', { path: relPath }))) {
        const m = line.match(/^(.*) \(unresolved\)$/);
        if (m) unresolved.push(m[1]);
        else resolved.push(line);
      }
      return { resolved, unresolved };
    },
    async tags() {
      const rows = parseJsonList(await run('tags', { format: 'json' }, ['counts']));
      return rows
        .filter((row) => row && typeof row.tag === 'string')
        .map((row) => ({ tag: row.tag.replace(/^#+/, ''), count: toCount(row.count) }))
        .filter((row) => row.tag);
    },
    async open(relPath) {
      await run('open', { path: relPath });
    },
    async dailyPath() {
      const out = await run('daily:path');
      const line = out.split('\n')[0].trim();
      if (!line || !/\.md$/i.test(line)) throw cliError('CLI_UNEXPECTED_OUTPUT', 'Unexpected daily note path.');
      return line;
    },
  };
}

const sessionCache = new Map(); // vault.id -> { at, promise }

async function openSession(vault) {
  const status = await detectObsidianCli();
  if (!status.installed || !status.running || status.cliEnabled !== true || !status.binary) {
    throw cliError('CLI_UNAVAILABLE', status.installed ? (status.cliEnabled === false ? 'cli-disabled' : 'not-running') : 'not-installed');
  }
  const session = createSession(status.binary, vault, status.version || null);
  // Make sure `vault=<id>` reaches the same folder this plugin resolved, not a same-named vault.
  const reported = await session.vaultPath();
  let reportedReal = null;
  try { reportedReal = fs.realpathSync(reported); } catch { reportedReal = null; }
  if (!reportedReal || reportedReal !== vault.path) {
    throw cliError('CLI_VAULT_MISMATCH', 'Obsidian CLI resolved a different vault.');
  }
  return session;
}

// Returns a session for a vault registered in Obsidian and currently open there, or throws.
async function sessionForVault(vault) {
  if (!vault || vault.source !== 'obsidian' || !vault.exists) {
    throw cliError('CLI_VAULT_NOT_REGISTERED', 'Vault is not registered in Obsidian.');
  }
  if (!vault.open) {
    // Querying a closed vault would make Obsidian open it in a new window.
    throw cliError('CLI_VAULT_NOT_OPEN', 'Vault is not open in Obsidian.');
  }
  const now = Date.now();
  const cached = sessionCache.get(vault.id);
  if (cached && now - cached.at < SESSION_TTL_MS) return cached.promise;
  const promise = openSession(vault);
  sessionCache.set(vault.id, { at: now, promise });
  promise.catch(() => {
    const current = sessionCache.get(vault.id);
    if (current && current.promise === promise) sessionCache.delete(vault.id);
  });
  return promise;
}

function resetSessions() {
  sessionCache.clear();
}

module.exports = {
  detectObsidianCli,
  sessionForVault,
  resetSessions,
  trustedBinaryCandidates,
  _internal: { parseOutput, parseJsonList, parseLines, assertSafeValue, ALLOWED_COMMANDS },
};
