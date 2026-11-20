const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { TextDecoder } = require('node:util');

const execFileAsync = promisify(execFile);
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.DS_Store']);
const PROTECTED_ROOT_DIRS = new Set(['.obsidian', '.git', '.trash']);
const MAX_INDEX_FILES = 5000;
const MAX_NOTE_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_MS = 10000;
const MAX_READ_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RPC_LINE_BYTES = 4 * 1024 * 1024;

let cachedIndexes = new Map(); // vaultRealPath -> index
let inflightScans = new Map(); // vaultRealPath -> Promise<index>
const writeLocks = new Map();  // targetKey -> Promise
const idempotencyCache = new Map(); // key -> { ts, payloadHash, result }

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function withWriteLock(lockKey, fn) {
  const prev = writeLocks.get(lockKey) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const settled = next.then(
    () => { if (writeLocks.get(lockKey) === settled) writeLocks.delete(lockKey); },
    () => { if (writeLocks.get(lockKey) === settled) writeLocks.delete(lockKey); }
  );
  writeLocks.set(lockKey, settled);
  return next;
}

function pruneIdempotencyCache() {
  const now = Date.now();
  for (const [k, v] of idempotencyCache.entries()) {
    if (now - v.ts > 30 * 60 * 1000 || idempotencyCache.size > 512) {
      idempotencyCache.delete(k);
    }
  }
}

function getObsidianConfigCandidates() {
  const home = os.homedir();
  const list = [];
  if (process.platform === 'darwin') {
    list.push(path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    list.push(path.join(appData, 'obsidian', 'obsidian.json'));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    list.push(path.join(xdg, 'obsidian', 'obsidian.json'));
    list.push(path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'));
  }
  return list;
}

function getTrustedObsidianCliCandidates() {
  const list = [];
  if (process.platform === 'darwin') {
    list.push('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli');
    list.push(path.join(os.homedir(), 'Applications', 'Obsidian.app', 'Contents', 'MacOS', 'obsidian-cli'));
  } else if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    list.push(path.join(localApp, 'Programs', 'obsidian', 'Obsidian.com'));
  } else {
    list.push('/usr/bin/obsidian');
    list.push('/usr/local/bin/obsidian');
  }
  return list;
}

async function detectObsidianCli() {
  for (const bin of getTrustedObsidianCliCandidates()) {
    try {
      if (!fs.existsSync(bin)) continue;
      const st = fs.statSync(bin);
      if (!st.isFile()) continue;
      const { stdout, stderr } = await execFileAsync(bin, ['version'], { timeout: 1500 });
      const out = String(stdout || stderr || '').trim();
      if (out.includes('Command line interface is not enabled')) {
        return { installed: true, running: false, cliEnabled: false, binary: bin, message: out };
      }
      if (out.includes('unable to find Obsidian')) {
        return { installed: true, running: false, cliEnabled: true, binary: bin, message: out };
      }
      if (out) {
        return { installed: true, running: true, cliEnabled: true, binary: bin, version: out };
      }
    } catch (err) {
      const msg = String((err && (err.stdout || err.stderr || err.message)) || '').trim();
      if (msg.includes('Command line interface is not enabled')) {
        return { installed: true, running: false, cliEnabled: false, binary: bin, message: msg };
      }
      if (msg.includes('unable to find Obsidian')) {
        return { installed: true, running: false, cliEnabled: true, binary: bin, message: msg };
      }
    }
  }
  return { installed: false, running: false, cliEnabled: false, binary: null };
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function isPathInsideRoot(rootReal, candidateReal, allowEqual = false) {
  const rel = path.relative(rootReal, candidateReal);
  if (rel === '') return allowEqual;
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
  return true;
}

function discoverVaults(settings = {}) {
  const extraVaults = settings.custom_vaults ?? settings.customVaults;
  const byReal = new Map();

  for (const cfgPath of getObsidianConfigCandidates()) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const vaultsObj = raw && typeof raw.vaults === 'object' ? raw.vaults : {};
      for (const [id, info] of Object.entries(vaultsObj)) {
        if (!info || typeof info.path !== 'string' || !info.path.trim()) continue;
        const resolved = path.resolve(info.path);
        const real = safeRealpath(resolved);
        let exists = false;
        if (real) {
          try { exists = fs.statSync(real).isDirectory(); } catch { exists = false; }
        }
        const key = real || resolved;
        byReal.set(key, {
          id: String(id),
          name: path.basename(resolved),
          path: real || resolved,
          configuredPath: resolved,
          open: Boolean(info.open),
          ts: Number(info.ts || 0),
          source: 'obsidian',
          exists,
        });
      }
    } catch {
      // ignore malformed obsidian.json
    }
  }

  if (Array.isArray(extraVaults)) {
    for (const item of extraVaults) {
      const p = typeof item === 'string' ? item : item && item.path;
      if (!p || typeof p !== 'string' || !p.trim()) continue;
      const resolved = path.resolve(p);
      const real = safeRealpath(resolved);
      const key = real || resolved;
      if (byReal.has(key)) continue;
      let exists = false;
      if (real) {
        try { exists = fs.statSync(real).isDirectory(); } catch { exists = false; }
      }
      const stableHash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
      byReal.set(key, {
        id: 'custom-' + stableHash,
        name: (item && typeof item.name === 'string' && item.name.trim()) ? item.name.trim() : path.basename(resolved),
        path: real || resolved,
        configuredPath: resolved,
        open: false,
        ts: 0,
        source: 'custom',
        exists,
      });
    }
  }

  return Array.from(byReal.values()).sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });
}

function resolveVault(params = {}) {
  const settings = params.settings && typeof params.settings === 'object' ? params.settings : {};
  const vaults = discoverVaults(settings);
  const existing = vaults.filter((v) => v.exists);

  const explicitReq = typeof params.vault === 'string' ? params.vault.trim() : '';
  const defaultSetting = typeof (settings.default_vault ?? settings.defaultVault) === 'string'
    ? String(settings.default_vault ?? settings.defaultVault).trim()
    : '';

  const matchRegistered = (query, sourceLabel) => {
    const byId = existing.find((v) => v.id === query);
    if (byId) return byId;
    const qReal = path.isAbsolute(query) ? (safeRealpath(query) || path.resolve(query)) : null;
    if (qReal) {
      const byPath = existing.find((v) => v.path === qReal || v.configuredPath === path.resolve(query));
      if (byPath) return byPath;
    }
    const byName = existing.filter((v) => v.name.toLowerCase() === query.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw makeError(
        'VAULT_AMBIGUOUS',
        '存在多个同名知识库 "' + query + '"，请改传具体的知识库 ID: ' + byName.map((v) => v.id + ' (' + v.path + ')').join(', ')
      );
    }
    const availableDesc = existing.map((v) => v.name + ' [id=' + v.id + ']').join(', ') || '无';
    throw makeError(
      'VAULT_NOT_REGISTERED',
      (sourceLabel === 'default'
        ? '插件设置中的默认知识库 "' + query + '" 不存在或未注册。'
        : '未找到已注册的知识库 "' + query + '"（出于安全限制，不允许直接传入未在 Obsidian 或插件设置中登记的任意目录）。') +
      ' 当前可用知识库: ' + availableDesc
    );
  };

  if (explicitReq) {
    return { vault: matchRegistered(explicitReq, 'explicit'), vaults };
  }
  if (defaultSetting) {
    return { vault: matchRegistered(defaultSetting, 'default'), vaults };
  }
  if (existing.length > 0) {
    return { vault: existing[0], vaults };
  }
  throw makeError(
    'NO_VAULT_AVAILABLE',
    '本机尚未检测到可用的 Obsidian 知识库。请在插件工作台点击「切换库」选择文件夹，或先在 Obsidian 中创建 Vault。'
  );
}

function normalizeRelPath(rel, requiredExt = '.md') {
  if (typeof rel !== 'string' || !rel.trim()) {
    throw makeError('INVALID_PATH', '文件路径不能为空。');
  }
  if (rel.includes('\0')) {
    throw makeError('INVALID_PATH', '文件路径包含非法空字节。');
  }
  let clean = rel.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.startsWith('[[') && clean.endsWith(']]')) {
    clean = clean.slice(2, -2).split('|')[0].split('#')[0].trim().replace(/^\/+/, '');
  }
  if (!clean || clean === '.' || clean === '..') {
    throw makeError('INVALID_PATH', '无效的笔记相对路径。');
  }
  const ext = path.posix.extname(clean).toLowerCase();
  if (!ext && requiredExt) {
    clean += requiredExt;
  } else if (requiredExt && ext !== requiredExt.toLowerCase()) {
    throw makeError(
      'UNSUPPORTED_FILE_EXTENSION',
      '文件后缀不匹配：该操作仅允许 "' + requiredExt + '" 文件，收到 "' + (ext || '无后缀') + '"（' + clean + '）。'
    );
  }
  return clean;
}

function resolveSafeVaultTarget(vaultRealPath, relInput, options = {}) {
  const {
    requiredExt = '.md',
    allowProtectedRoot = null,
    mustExist = false,
  } = options;

  const normalized = normalizeRelPath(relInput, requiredExt);
  const absCandidate = path.resolve(vaultRealPath, normalized);
  const relLexical = path.relative(vaultRealPath, absCandidate);
  if (!relLexical || relLexical === '..' || relLexical.startsWith('..' + path.sep) || path.isAbsolute(relLexical)) {
    throw makeError('PATH_OUTSIDE_VAULT', '路径越界：只允许访问当前 Obsidian 知识库内部的文件。');
  }

  const segments = relLexical.split(path.sep);
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw makeError('INVALID_PATH', '路径包含非法目录段。');
  }
  const topSeg = segments[0];
  if (PROTECTED_ROOT_DIRS.has(topSeg) && topSeg !== allowProtectedRoot) {
    throw makeError('PROTECTED_PATH', '安全限制：不允许直接访问受保护目录 "' + topSeg + '"。');
  }

  let cur = vaultRealPath;
  let exists = true;
  for (let i = 0; i < segments.length; i++) {
    cur = path.join(cur, segments[i]);
    let lst;
    try {
      lst = fs.lstatSync(cur);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        exists = false;
        break;
      }
      throw makeError('FS_STAT_ERROR', '无法检查路径状态: ' + normalized);
    }
    if (lst.isSymbolicLink()) {
      throw makeError('SYMLINK_FORBIDDEN', '安全限制：拒绝跟随知识库内的符号链接 "' + segments.slice(0, i + 1).join('/') + '"。');
    }
    const curReal = safeRealpath(cur);
    if (!curReal || !isPathInsideRoot(vaultRealPath, curReal, false)) {
      throw makeError('PATH_OUTSIDE_VAULT', '安全限制：真实路径越出当前 Obsidian 知识库边界。');
    }
    if (i < segments.length - 1 && !lst.isDirectory()) {
      throw makeError('INVALID_PATH', '路径中间段不是文件夹: ' + segments.slice(0, i + 1).join('/'));
    }
    if (i === segments.length - 1) {
      if (!lst.isFile()) {
        throw makeError('NOT_REGULAR_FILE', '目标路径不是普通文件: ' + normalized);
      }
    }
  }

  if (mustExist && !exists) {
    throw makeError('NOTE_NOT_FOUND', '未找到文件 "' + segments.join('/') + '"。');
  }

  return {
    abs: absCandidate,
    rel: segments.join('/'),
    exists,
    segments,
  };
}

async function ensureSafeParentDirs(vaultRealPath, segments) {
  let cur = vaultRealPath;
  for (let i = 0; i < segments.length - 1; i++) {
    cur = path.join(cur, segments[i]);
    try {
      const lst = await fsp.lstat(cur);
      if (lst.isSymbolicLink()) {
        throw makeError('SYMLINK_FORBIDDEN', '安全限制：父目录包含符号链接。');
      }
      if (!lst.isDirectory()) {
        throw makeError('INVALID_PATH', '目标父路径已存在且不是目录。');
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        await fsp.mkdir(cur);
      } else {
        throw err;
      }
    }
    const real = safeRealpath(cur);
    if (!real || !isPathInsideRoot(vaultRealPath, real, false)) {
      throw makeError('PATH_OUTSIDE_VAULT', '安全限制：父目录真实路径越出知识库边界。');
    }
  }
}

async function readStrictUtf8File(absPath, maxBytes = MAX_READ_FILE_BYTES) {
  const lst = await fsp.lstat(absPath);
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw makeError('NOT_REGULAR_FILE', '拒绝读取非常规文件或符号链接。');
  }
  if (lst.size > maxBytes) {
    throw makeError('FILE_TOO_LARGE', '文件体积超过安全读取上限 (' + lst.size + ' bytes)。');
  }
  const buf = await fsp.readFile(absPath);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text;
  try {
    text = strictUtf8Decoder.decode(hasBom ? buf.subarray(3) : buf);
  } catch {
    throw makeError('INVALID_UTF8', '文件不是有效的 UTF-8 文本，为防止损坏已拒绝读写。');
  }
  return { text, hasBom, stat: lst };
}

async function atomicWriteUtf8File(vaultRealPath, targetInfo, contentStr, options = {}) {
  const { createOnly = false, expectedMtimeMs = null, preserveBom = false } = options;
  await ensureSafeParentDirs(vaultRealPath, targetInfo.segments);

  const rechecked = resolveSafeVaultTarget(vaultRealPath, targetInfo.rel, {
    requiredExt: path.posix.extname(targetInfo.rel),
    allowProtectedRoot: targetInfo.segments[0] === '.trash' ? '.trash' : null,
  });

  let origMode = 0o644;
  if (createOnly && rechecked.exists) {
    throw makeError('NOTE_ALREADY_EXISTS', '文件 "' + targetInfo.rel + '" 已存在，拒绝覆盖。');
  }
  if (rechecked.exists) {
    const curStat = await fsp.lstat(rechecked.abs);
    if (curStat.isSymbolicLink() || !curStat.isFile()) {
      throw makeError('NOT_REGULAR_FILE', '目标不是普通文件，拒绝写入。');
    }
    origMode = curStat.mode & 0o777;
    if (expectedMtimeMs !== null && Math.abs(curStat.mtimeMs - expectedMtimeMs) > 1) {
      throw makeError('WRITE_CONFLICT', '文件在读取后已被外部修改，请重新读取后再写入以免丢失修改。');
    }
  }

  const outBytes = Buffer.from((preserveBom ? '\uFEFF' : '') + contentStr, 'utf8');
  if (createOnly) {
    const fh = await fsp.open(rechecked.abs, 'wx', origMode);
    try {
      await fh.writeFile(outBytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return outBytes.length;
  }

  const dir = path.dirname(rechecked.abs);
  const tmpName = '.cindy-tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, tmpName);
  let fh = null;
  try {
    fh = await fsp.open(tmpPath, 'wx', origMode);
    await fh.writeFile(outBytes);
    await fh.sync();
    await fh.close();
    fh = null;

    if (expectedMtimeMs !== null && fs.existsSync(rechecked.abs)) {
      const latestStat = await fsp.lstat(rechecked.abs);
      if (latestStat.isSymbolicLink()) throw makeError('SYMLINK_FORBIDDEN', '目标被替换为符号链接，终止写入。');
      if (Math.abs(latestStat.mtimeMs - expectedMtimeMs) > 1) {
        throw makeError('WRITE_CONFLICT', '写入提交前检测到外部并发修改，已中止覆盖。');
      }
    }
    await fsp.rename(tmpPath, rechecked.abs);
    return outBytes.length;
  } catch (err) {
    if (fh) { try { await fh.close(); } catch {} }
    try { await fsp.unlink(tmpPath); } catch {}
    throw err;
  }
}

function stripQuotes(str) {
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  return str;
}

function splitQuotedList(inner) {
  const result = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === '\\' && i + 1 < inner.length) {
        cur += ch + inner[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      const trimmed = cur.trim();
      if (trimmed) result.push(trimmed);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) result.push(cur.trim());
  return result;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---(\r?\n)([\s\S]*?)(?:\r?\n)?---(\r?\n|$)/);
  if (!match) {
    const emptyMatch = raw.match(/^---(\r?\n)---(\r?\n|$)/);
    if (emptyMatch) {
      return {
        frontmatter: {},
        rawBlock: emptyMatch[0],
        yamlInner: '',
        eol: emptyMatch[1],
        body: raw.slice(emptyMatch[0].length),
        hasFrontmatter: true,
        isComplexYaml: false,
      };
    }
    return {
      frontmatter: {},
      rawBlock: '',
      yamlInner: '',
      eol: raw.includes('\r\n') ? '\r\n' : '\n',
      body: raw,
      hasFrontmatter: false,
      isComplexYaml: false,
    };
  }

  const rawBlock = match[0];
  const eol = match[1] || '\n';
  const yamlInner = match[2];
  const body = raw.slice(rawBlock.length);
  const data = {};
  const lines = yamlInner.split(/\r?\n/);
  let currentKey = null;
  let isComplexYaml = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) {
      isComplexYaml = true;
      continue;
    }
    const listMatch = line.match(/^(\s*)-\s+(.*)$/);
    if (listMatch && currentKey) {
      if (listMatch[1].length > 4 || /[{}]|:\s/.test(listMatch[2])) isComplexYaml = true;
      if (!Array.isArray(data[currentKey])) data[currentKey] = data[currentKey] ? [data[currentKey]] : [];
      data[currentKey].push(stripQuotes(listMatch[2].trim()));
      continue;
    }
    if (/^\s+\S/.test(line)) {
      isComplexYaml = true;
      continue;
    }
    const kvMatch = line.match(/^([^:#\r\n]+?)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = stripQuotes(kvMatch[1].trim());
      const valRaw = kvMatch[2].trim();
      currentKey = key;
      if (valRaw === '|' || valRaw === '>' || valRaw === '|-' || valRaw === '>-' || valRaw.startsWith('&') || valRaw.startsWith('*')) {
        isComplexYaml = true;
        data[key] = valRaw;
      } else if (!valRaw) {
        data[key] = [];
      } else if (valRaw.startsWith('[') && valRaw.endsWith(']')) {
        const inner = valRaw.slice(1, -1).trim();
        data[key] = inner ? splitQuotedList(inner).map(stripQuotes) : [];
      } else if (valRaw.startsWith('{')) {
        isComplexYaml = true;
        data[key] = valRaw;
      } else if (valRaw === 'true' || valRaw === 'false') {
        data[key] = valRaw === 'true';
      } else if (/^-?\d+(\.\d+)?$/.test(valRaw)) {
        data[key] = Number(valRaw);
      } else {
        data[key] = stripQuotes(valRaw);
      }
    } else {
      isComplexYaml = true;
    }
  }

  return { frontmatter: data, rawBlock, yamlInner, eol, body, hasFrontmatter: true, isComplexYaml };
}

function serializeYamlKey(key) {
  const k = String(key);
  if (/^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(k)) return k;
  return JSON.stringify(k);
}

function serializeYamlScalar(val) {
  if (val === null) return 'null';
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    throw makeError('UNSUPPORTED_FRONTMATTER_VALUE', 'Frontmatter 仅支持字符串、数字、布尔值或字符串数组，拒绝写入嵌套对象以免损坏 YAML。');
  }
  const str = String(val);
  if (
    str === '' ||
    /^(true|false|null|~|yes|no|on|off|-?\d+(\.\d+)?)$/i.test(str) ||
    /[:#\[\]{}&*!|>'"%@`\r\n]|^\s|\s$|^[-?]/.test(str)
  ) {
    return JSON.stringify(str);
  }
  return str;
}

function serializeYamlEntry(key, val, eol = '\n') {
  const safeKey = serializeYamlKey(key);
  if (Array.isArray(val)) {
    if (val.length === 0) return [safeKey + ': []'];
    const out = [safeKey + ':'];
    for (const item of val) {
      if (item && typeof item === 'object') {
        throw makeError('UNSUPPORTED_FRONTMATTER_VALUE', 'Frontmatter 数组元素仅支持标量值。');
      }
      out.push('  - ' + serializeYamlScalar(item));
    }
    return out;
  }
  return [safeKey + ': ' + serializeYamlScalar(val)];
}

function patchFrontmatterPreservingRaw(parsed, fmPatch, extraTags) {
  const hasPatch = fmPatch && Object.keys(fmPatch).length > 0;
  const hasTags = Array.isArray(extraTags) && extraTags.length > 0;
  if (!hasPatch && !hasTags) {
    return { rawBlock: parsed.rawBlock, frontmatter: parsed.frontmatter };
  }

  const eol = parsed.eol || '\n';
  const updates = new Map();
  if (hasPatch) {
    for (const [k, v] of Object.entries(fmPatch)) updates.set(k, v);
  }
  if (hasTags) {
    const baseTags = updates.has('tags')
      ? (Array.isArray(updates.get('tags')) ? updates.get('tags') : [updates.get('tags')].filter(Boolean))
      : (Array.isArray(parsed.frontmatter.tags)
          ? parsed.frontmatter.tags.map(String)
          : (typeof parsed.frontmatter.tags === 'string' && parsed.frontmatter.tags ? [parsed.frontmatter.tags] : []));
    updates.set('tags', Array.from(new Set([...baseTags, ...extraTags])));
  }

  if (!parsed.hasFrontmatter) {
    const lines = ['---'];
    for (const [k, v] of updates.entries()) {
      if (v === null || v === undefined) continue;
      lines.push(...serializeYamlEntry(k, v, eol));
    }
    if (lines.length === 1) return { rawBlock: '', frontmatter: {} };
    lines.push('---', '');
    const block = lines.join(eol);
    return { rawBlock: block, frontmatter: parseFrontmatter(block).frontmatter };
  }

  // Line-range surgical patching inside existing YAML block so untouched comments, nested maps & multi-line scalars stay intact!
  const origLines = parsed.yamlInner ? parsed.yamlInner.split(/\r?\n/) : [];
  const outLines = [];
  const seenKeys = new Set();

  let i = 0;
  while (i < origLines.length) {
    const line = origLines[i];
    const topKv = line.match(/^([^\s:#][^:#\r\n]*?)\s*:\s*(.*)$/);
    if (!topKv) {
      outLines.push(line);
      i++;
      continue;
    }
    const key = stripQuotes(topKv[1].trim());
    let endKeyIdx = i + 1;
    while (endKeyIdx < origLines.length) {
      const nl = origLines[endKeyIdx];
      if (!nl.trim() || /^\s+/.test(nl) || /^\s*-\s/.test(nl)) {
        // keep trailing blank lines attached only if next non-blank is still indented
        if (!nl.trim()) {
          let probe = endKeyIdx + 1;
          while (probe < origLines.length && !origLines[probe].trim()) probe++;
          if (probe < origLines.length && (/^\s+/.test(origLines[probe]) || /^\s*-\s/.test(origLines[probe]))) {
            endKeyIdx++;
            continue;
          }
          break;
        }
        endKeyIdx++;
      } else {
        break;
      }
    }

    if (updates.has(key)) {
      seenKeys.add(key);
      const nextVal = updates.get(key);
      if (nextVal !== null && nextVal !== undefined) {
        outLines.push(...serializeYamlEntry(key, nextVal, eol));
      }
    } else {
      for (let k = i; k < endKeyIdx; k++) outLines.push(origLines[k]);
    }
    i = endKeyIdx;
  }

  for (const [k, v] of updates.entries()) {
    if (seenKeys.has(k) || v === null || v === undefined) continue;
    outLines.push(...serializeYamlEntry(k, v, eol));
  }

  const rebuiltBlock = '---' + eol + (outLines.length ? outLines.join(eol) + eol : '') + '---' + eol;
  return { rawBlock: rebuiltBlock, frontmatter: parseFrontmatter(rebuiltBlock).frontmatter };
}

// Fence-aware Markdown line scanner: returns line offsets, skips ``` and ~~~ fenced code blocks!
function scanMarkdownStructure(body) {
  const lines = [];
  let pos = 0;
  while (pos <= body.length) {
    const nextLf = body.indexOf('\n', pos);
    if (nextLf === -1) {
      lines.push({ text: body.slice(pos), start: pos, end: body.length, fullEnd: body.length });
      break;
    }
    const hasCr = nextLf > pos && body[nextLf - 1] === '\r';
    const lineEnd = hasCr ? nextLf - 1 : nextLf;
    lines.push({ text: body.slice(pos, lineEnd), start: pos, end: lineEnd, fullEnd: nextLf + 1 });
    pos = nextLf + 1;
    if (pos === body.length) break;
  }

  const headings = [];
  const tasks = { total: 0, open: 0, done: 0, openItems: [] };
  const nonCodeChunks = [];
  let inFence = null; // { char: '`' | '~', len: number }

  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx];
    const fenceMatch = ln.text.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!inFence) {
      if (fenceMatch) {
        const marker = fenceMatch[1];
        const info = fenceMatch[2];
        if (marker[0] !== '`' || !info.includes('`')) {
          inFence = { char: marker[0], len: marker.length };
          continue;
        }
      }
      // ATX Heading (supports optional closing # sequence per CommonMark)
      const hm = ln.text.match(/^\s{0,3}(#{1,6})(?:[ \t]+(.*?))??(?:[ \t]+#+[ \t]*)?$/);
      if (hm && (hm[2] !== undefined || ln.text.trim() === hm[1])) {
        const cleanHeading = (hm[2] || '').trim();
        if (cleanHeading) {
          headings.push({
            level: hm[1].length,
            text: cleanHeading,
            lineIndex: idx,
            startOffset: ln.start,
            afterHeadingOffset: ln.fullEnd,
          });
        }
      }
      const tm = ln.text.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
      if (tm) {
        tasks.total++;
        if (tm[1] === ' ') {
          tasks.open++;
          if (tasks.openItems.length < 20) tasks.openItems.push(tm[2].trim());
        } else {
          tasks.done++;
        }
      }
      nonCodeChunks.push(ln.text.replace(/`[^`]*`/g, ' '));
    } else if (fenceMatch) {
      const marker = fenceMatch[1];
      const trailing = fenceMatch[2].trim();
      if (marker[0] === inFence.char && marker.length >= inFence.len && trailing === '') {
        inFence = null;
      }
    }
  }

  return { lines, headings, tasks, nonCodeText: nonCodeChunks.join('\n'), unclosedFence: Boolean(inFence) };
}

function extractNoteMetadata(raw) {
  const parsedFm = parseFrontmatter(raw);
  const struct = scanMarkdownStructure(parsedFm.body);

  const wikilinks = [];
  const embeds = [];
  const linkRe = /(!?)\[\[([^\[\]\r\n]+)\]\]/g;
  let m;
  while ((m = linkRe.exec(struct.nonCodeText)) !== null) {
    const isEmbed = m[1] === '!';
    const inner = m[2].trim();
    const [targetPart, aliasPart] = inner.split('|');
    const [noteTarget, headingPart] = targetPart.split('#');
    const target = noteTarget.trim();
    if (!target) continue;
    const entry = {
      target,
      heading: headingPart ? headingPart.trim() : null,
      alias: aliasPart ? aliasPart.trim() : null,
    };
    if (isEmbed) embeds.push(entry);
    else wikilinks.push(entry);
  }

  const tagSet = new Set();
  const fmTags = parsedFm.frontmatter.tags || parsedFm.frontmatter.tag;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      const clean = String(t).trim().replace(/^#+/, '');
      if (clean) tagSet.add(clean);
    }
  } else if (typeof fmTags === 'string' && fmTags.trim()) {
    for (const t of fmTags.split(/[,\s]+/)) {
      const clean = t.trim().replace(/^#+/, '');
      if (clean) tagSet.add(clean);
    }
  }

  const inlineTagRe = /(?:^|[\s(\[])#([A-Za-z0-9_\-\/\u4e00-\u9fa5]+)/g;
  while ((m = inlineTagRe.exec(struct.nonCodeText)) !== null) {
    const tag = m[1];
    if (!/^\d+$/.test(tag)) tagSet.add(tag);
  }

  return {
    ...parsedFm,
    tags: Array.from(tagSet),
    wikilinks,
    embeds,
    headings: struct.headings.map((h) => ({ level: h.level, text: h.text })),
    headingRanges: struct.headings,
    tasks: struct.tasks,
    unclosedFence: struct.unclosedFence,
  };
}

function findSectionRange(body, headingQuery) {
  const struct = scanMarkdownStructure(body);
  const rawQ = headingQuery.trim();
  const explicitLevelMatch = rawQ.match(/^(#{1,6})\s+(.+?)$/);
  const wantedLevel = explicitLevelMatch ? explicitLevelMatch[1].length : null;
  const targetText = (explicitLevelMatch ? explicitLevelMatch[2] : rawQ.replace(/^#+\s*/, '')).trim().toLowerCase();

  const matches = struct.headings.filter(
    (h) => h.text.toLowerCase() === targetText && (wantedLevel === null || h.level === wantedLevel)
  );
  if (matches.length === 0) return { found: false, struct };
  if (matches.length > 1) {
    throw makeError(
      'AMBIGUOUS_HEADING',
      '笔记中存在多个同名章节 "' + targetText + '"，请带上准确井号层级（如 "## ' + matches[0].text + '"）消歧。'
    );
  }

  const target = matches[0];
  const targetIdxInHeadings = struct.headings.indexOf(target);
  let sectionEndOffset = body.length;
  for (let i = targetIdxInHeadings + 1; i < struct.headings.length; i++) {
    if (struct.headings[i].level <= target.level) {
      sectionEndOffset = struct.headings[i].startOffset;
      break;
    }
  }

  return {
    found: true,
    struct,
    heading: target,
    startOffset: target.startOffset,
    afterHeadingOffset: target.afterHeadingOffset,
    endOffset: sectionEndOffset,
    content: body.slice(target.startOffset, sectionEndOffset),
  };
}

function modifyBodyUnderHeading(body, headingQuery, insertionRaw, mode) {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const payload = String(insertionRaw).replace(/^(\r?\n)+|(\r?\n)+$/g, '');
  const sec = findSectionRange(body, headingQuery);

  if (!sec.found) {
    const fenceClosure = sec.struct.unclosedFence ? eol + '```' + eol : '';
    const headingLine = /^#{1,6}\s/.test(headingQuery.trim())
      ? headingQuery.trim()
      : '## ' + headingQuery.trim();
    const baseTrimmed = (body + fenceClosure).replace(/(\r?\n)+$/, '');
    return (baseTrimmed ? baseTrimmed + eol + eol : '') + headingLine + eol + eol + payload + eol;
  }

  const prefix = body.slice(0, sec.afterHeadingOffset);
  const middle = body.slice(sec.afterHeadingOffset, sec.endOffset);
  const suffix = body.slice(sec.endOffset);

  if (mode === 'replace-section') {
    return prefix + eol + payload + eol + (suffix ? eol + suffix : '');
  }
  if (mode === 'prepend-heading') {
    const cleanMid = middle.replace(/^(\r?\n)+/, '');
    return prefix + eol + payload + eol + (cleanMid ? eol + cleanMid : (suffix ? eol : '')) + suffix;
  }
  // append-heading: preserve exact middle bytes except trailing blank lines right before next heading
  const midStruct = scanMarkdownStructure(middle);
  const safeMid = midStruct.unclosedFence ? middle + eol + '```' : middle;
  const trimmedMid = safeMid.replace(/(\r?\n)+$/, '');
  return (
    prefix +
    (trimmedMid ? trimmedMid + eol + eol : eol) +
    payload +
    eol +
    (suffix ? eol + suffix : '')
  );
}

async function scanVaultIndex(vaultRealPath, force = false) {
  const now = Date.now();
  const cached = cachedIndexes.get(vaultRealPath);
  if (!force && cached && now - cached.builtAt < 4000) {
    return cached;
  }
  if (!force && inflightScans.has(vaultRealPath)) {
    return inflightScans.get(vaultRealPath);
  }

  const scanPromise = (async () => {
    const startedAt = Date.now();
    const notes = [];
    const canvases = [];
    const bases = [];
    const otherFiles = [];
    const warnings = [];
    let totalIndexedBytes = 0;
    let totalFilesSeen = 0;
    let truncatedScan = false;

    async function walk(dir) {
      if (truncatedScan) return;
      if (Date.now() - startedAt > MAX_SCAN_MS) {
        truncatedScan = true;
        warnings.push('知识库扫描超过 10 秒安全时限，仅返回已扫描部分。');
        return;
      }
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        warnings.push('无法读取目录: ' + path.relative(vaultRealPath, dir));
        return;
      }
      for (const entry of entries) {
        if (truncatedScan) break;
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) continue;

        const full = path.join(dir, entry.name);
        let lst;
        try {
          lst = await fsp.lstat(full);
        } catch {
          continue;
        }
        if (lst.isSymbolicLink()) continue;
        const real = safeRealpath(full);
        if (!real || !isPathInsideRoot(vaultRealPath, real, false)) continue;

        const rel = path.relative(vaultRealPath, real).split(path.sep).join('/');
        if (lst.isDirectory()) {
          await walk(real);
        } else if (lst.isFile()) {
          totalFilesSeen++;
          if (totalFilesSeen > MAX_INDEX_FILES) {
            truncatedScan = true;
            warnings.push('文件数量超过 ' + MAX_INDEX_FILES + ' 项索引上限，部分文件未纳入内存索引。');
            break;
          }
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.md') {
            let raw = '';
            let bodyIndexed = false;
            if (lst.size <= MAX_NOTE_INDEX_BYTES && totalIndexedBytes + lst.size <= MAX_TOTAL_INDEX_BYTES) {
              try {
                const readRes = await readStrictUtf8File(real, MAX_NOTE_INDEX_BYTES);
                raw = readRes.text;
                totalIndexedBytes += lst.size;
                bodyIndexed = true;
              } catch {
                warnings.push('跳过非 UTF-8 或读取失败的笔记: ' + rel);
              }
            }
            const meta = extractNoteMetadata(raw);
            const basename = path.basename(entry.name, '.md');
            const aliasesRaw = meta.frontmatter.aliases || meta.frontmatter.alias;
            const aliases = Array.isArray(aliasesRaw)
              ? aliasesRaw.map(String)
              : typeof aliasesRaw === 'string' && aliasesRaw.trim()
                ? [aliasesRaw.trim()]
                : [];
            notes.push({
              path: rel,
              title: basename,
              folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
              size: lst.size,
              mtimeMs: lst.mtimeMs,
              ctimeMs: lst.birthtimeMs || lst.ctimeMs,
              frontmatter: meta.frontmatter,
              tags: meta.tags,
              aliases,
              headings: meta.headings,
              wikilinks: meta.wikilinks,
              embeds: meta.embeds,
              tasks: meta.tasks,
              bodyIndexed,
              excerpt: meta.body.replace(/\s+/g, ' ').trim().slice(0, 240),
              searchBodyLower: bodyIndexed ? meta.body.toLowerCase() : '',
              rawBodySample: bodyIndexed ? meta.body.slice(0, 32768) : '',
            });
          } else if (ext === '.canvas') {
            canvases.push({ path: rel, name: path.basename(entry.name, '.canvas'), size: lst.size, mtimeMs: lst.mtimeMs });
          } else if (ext === '.base') {
            bases.push({ path: rel, name: path.basename(entry.name, '.base'), size: lst.size, mtimeMs: lst.mtimeMs });
          } else {
            otherFiles.push({ path: rel, ext, size: lst.size, mtimeMs: lst.mtimeMs });
          }
        }
      }
    }

    await walk(vaultRealPath);
    notes.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const byRelLower = new Map();
    const byTitleLowerList = new Map(); // lowerTitleOrAlias -> Note[]
    const addCandidate = (key, note) => {
      if (!byTitleLowerList.has(key)) byTitleLowerList.set(key, []);
      const arr = byTitleLowerList.get(key);
      if (!arr.includes(note)) arr.push(note);
    };

    for (const note of notes) {
      byRelLower.set(note.path.toLowerCase(), note);
      byRelLower.set(note.path.replace(/\.md$/i, '').toLowerCase(), note);
      addCandidate(note.title.toLowerCase(), note);
      for (const al of note.aliases) addCandidate(al.toLowerCase(), note);
    }

    function resolveLinkTarget(targetStr, fromFolder = '') {
      if (!targetStr) return { note: null, ambiguous: [] };
      const clean = targetStr.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      const lower = clean.toLowerCase();
      if (clean.includes('/')) {
        const exact = byRelLower.get(lower) || byRelLower.get(lower + '.md');
        return { note: exact || null, ambiguous: [] };
      }
      if (fromFolder) {
        const relSameDir = (fromFolder + '/' + clean).toLowerCase();
        const sibling = byRelLower.get(relSameDir) || byRelLower.get(relSameDir + '.md');
        if (sibling) return { note: sibling, ambiguous: [] };
      }
      const candidates = byTitleLowerList.get(lower) || [];
      if (candidates.length === 1) return { note: candidates[0], ambiguous: [] };
      if (candidates.length > 1) {
        const rootCand = candidates.find((c) => !c.folder);
        return { note: rootCand || candidates[0], ambiguous: candidates.map((c) => c.path) };
      }
      const exactRoot = byRelLower.get(lower) || byRelLower.get(lower + '.md');
      return { note: exactRoot || null, ambiguous: [] };
    }

    const backlinksMap = new Map();
    for (const n of notes) backlinksMap.set(n.path, []);

    for (const src of notes) {
      const seenTargets = new Set();
      for (const wl of [...src.wikilinks, ...src.embeds]) {
        const { note: targetNote } = resolveLinkTarget(wl.target, src.folder);
        if (targetNote && targetNote.path !== src.path && !seenTargets.has(targetNote.path)) {
          seenTargets.add(targetNote.path);
          backlinksMap.get(targetNote.path).push({
            path: src.path,
            title: src.title,
            heading: wl.heading,
          });
        }
      }
    }

    const built = {
      vaultPath: vaultRealPath,
      builtAt: Date.now(),
      notes,
      canvases,
      bases,
      otherFiles,
      warnings,
      truncatedScan,
      byRelLower,
      byTitleLowerList,
      backlinksMap,
      resolveLinkTarget,
    };
    cachedIndexes.set(vaultRealPath, built);
    return built;
  })();

  inflightScans.set(vaultRealPath, scanPromise);
  try {
    return await scanPromise;
  } finally {
    if (inflightScans.get(vaultRealPath) === scanPromise) inflightScans.delete(vaultRealPath);
  }
}

function invalidateVaultCache(vaultRealPath) {
  if (vaultRealPath) cachedIndexes.delete(vaultRealPath);
  else cachedIndexes.clear();
}

function readDailyNoteConfig(vaultRealPath, settings = {}) {
  let folder = typeof (settings.daily_folder ?? settings.dailyFolder) === 'string'
    ? String(settings.daily_folder ?? settings.dailyFolder).trim()
    : '';
  let format = typeof (settings.daily_format ?? settings.dailyFormat) === 'string'
    ? String(settings.daily_format ?? settings.dailyFormat).trim()
    : '';
  let template = '';

  try {
    const cfgTarget = resolveSafeVaultTarget(vaultRealPath, '.obsidian/daily-notes.json', {
      requiredExt: '.json',
      allowProtectedRoot: '.obsidian',
    });
    if (cfgTarget.exists) {
      const cfg = JSON.parse(fs.readFileSync(cfgTarget.abs, 'utf8'));
      if (!folder && typeof cfg.folder === 'string') folder = cfg.folder.trim();
      if (!format && typeof cfg.format === 'string') format = cfg.format.trim();
      if (typeof cfg.template === 'string') template = cfg.template.trim();
    }
  } catch {
    // ignore unreadable or symlinked config
  }

  return {
    folder: folder.replace(/^\/+|\/+$/g, ''),
    format: format || 'YYYY-MM-DD',
    template: template.replace(/^\/+/, ''),
  };
}

function parseStrictCalendarDate(dateInput, nowRef = new Date()) {
  if (dateInput === undefined || dateInput === null || String(dateInput).trim() === '') {
    return new Date(nowRef.getFullYear(), nowRef.getMonth(), nowRef.getDate(), nowRef.getHours(), nowRef.getMinutes(), nowRef.getSeconds());
  }
  const s = String(dateInput).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw makeError('INVALID_DATE', '日期参数必须使用严格的 YYYY-MM-DD 格式（例如 2026-11-20）。');
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(year, month - 1, day, nowRef.getHours(), nowRef.getMinutes(), nowRef.getSeconds());
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    throw makeError('INVALID_DATE', '无效的日历日期 "' + s + '"（如不存在的闰日或月份）。');
  }
  return dt;
}

// Single-pass Moment-compatible formatter supporting [escaped literals] and longest-token-first matching
function formatMomentPattern(dateObj, pattern) {
  const yyyy = String(dateObj.getFullYear());
  const yy = yyyy.slice(-2);
  const mNum = dateObj.getMonth() + 1;
  const mm = String(mNum).padStart(2, '0');
  const dNum = dateObj.getDate();
  const dd = String(dNum).padStart(2, '0');
  const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthsFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const weekdaysFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekdaysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const min = String(dateObj.getMinutes()).padStart(2, '0');
  const ss = String(dateObj.getSeconds()).padStart(2, '0');

  const tokenRe = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm|ss/g;
  return pattern.replace(tokenRe, (full, literal) => {
    if (literal !== undefined) return literal;
    switch (full) {
      case 'YYYY': return yyyy;
      case 'YY': return yy;
      case 'MMMM': return monthsFull[mNum - 1];
      case 'MMM': return monthsShort[mNum - 1];
      case 'MM': return mm;
      case 'M': return String(mNum);
      case 'DD': return dd;
      case 'D': return String(dNum);
      case 'dddd': return weekdaysFull[dateObj.getDay()];
      case 'ddd': return weekdaysShort[dateObj.getDay()];
      case 'HH': return hh;
      case 'mm': return min;
      case 'ss': return ss;
      default: return full;
    }
  });
}

const handlers = {
  async vault_status(params = {}) {
    const settings = params.settings || {};
    const vaults = discoverVaults(settings);
    const cli = await detectObsidianCli();
    let activeVault = null;
    let activeVaultError = null;
    try {
      activeVault = resolveVault(params).vault;
    } catch (err) {
      activeVault = null;
      activeVaultError = err.message;
    }

    let summary = null;
    if (activeVault && activeVault.exists) {
      const idx = await scanVaultIndex(activeVault.path, Boolean(params.refresh));
      const tagCounts = new Map();
      let totalLinks = 0;
      let openTasks = 0;
      for (const n of idx.notes) {
        totalLinks += n.wikilinks.length + n.embeds.length;
        openTasks += n.tasks.open;
        for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      }
      const topTags = Array.from(tagCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([tag, count]) => ({ tag, count }));

      const dailyCfg = readDailyNoteConfig(activeVault.path, settings);
      const inboxFolder = String(settings.inbox_folder ?? settings.inboxFolder ?? 'Inbox').trim() || 'Inbox';
      const nowLocal = formatMomentPattern(new Date(), 'YYYY-MM-DD');
      summary = {
        noteCount: idx.notes.length,
        canvasCount: idx.canvases.length,
        baseCount: idx.bases.length,
        attachmentCount: idx.otherFiles.length,
        totalWikilinks: totalLinks,
        openTaskCount: openTasks,
        topTags,
        dailyNotes: dailyCfg,
        inboxFolder,
        localDate: nowLocal,
        truncatedScan: idx.truncatedScan,
        warnings: idx.warnings,
        recentNotes: idx.notes.slice(0, 12).map((n) => ({
          path: n.path,
          title: n.title,
          folder: n.folder,
          mtime: new Date(n.mtimeMs).toISOString(),
          tags: n.tags,
          backlinkCount: (idx.backlinksMap.get(n.path) || []).length,
        })),
      };
    }

    return {
      activeVault: activeVault ? { id: activeVault.id, name: activeVault.name, path: activeVault.path, open: activeVault.open, source: activeVault.source, exists: activeVault.exists } : null,
      activeVaultError,
      vaults: vaults.map((v) => ({ id: v.id, name: v.name, path: v.path, open: v.open, source: v.source, exists: v.exists })),
      obsidianCli: cli,
      summary,
    };
  },

  async search_notes(params = {}) {
    const { vault } = resolveVault(params);
    const idx = await scanVaultIndex(vault.path, Boolean(params.refresh));
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    const folderPrefix = typeof params.folder === 'string' ? params.folder.trim().replace(/^\/+|\/+$/g, '').toLowerCase() : '';
    const tagFilter = typeof params.tag === 'string' ? params.tag.trim().replace(/^#+/, '').toLowerCase() : '';
    const propKey = typeof params.propertyKey === 'string' ? params.propertyKey.trim() : '';
    const propVal = params.propertyValue !== undefined ? String(params.propertyValue).trim().toLowerCase() : '';
    const limit = Math.min(Math.max(Number(params.limit) || 15, 1), 50);
    const terms = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];

    const scored = [];
    for (const note of idx.notes) {
      if (folderPrefix && !note.path.toLowerCase().startsWith(folderPrefix + '/') && note.folder.toLowerCase() !== folderPrefix) continue;
      if (tagFilter) {
        const hasTag = note.tags.some((t) => t.toLowerCase() === tagFilter || t.toLowerCase().startsWith(tagFilter + '/'));
        if (!hasTag) continue;
      }
      if (propKey) {
        const val = note.frontmatter[propKey];
        if (val === undefined) continue;
        if (propVal) {
          const serialized = Array.isArray(val) ? val.join(' ').toLowerCase() : String(val).toLowerCase();
          if (!serialized.includes(propVal)) continue;
        }
      }

      let score = 0;
      let snippet = note.excerpt;
      if (terms.length === 0) {
        score = 1;
      } else {
        const titleLower = note.title.toLowerCase();
        const pathLower = note.path.toLowerCase();
        const aliasLower = note.aliases.join(' ').toLowerCase();
        const tagsLower = note.tags.join(' ').toLowerCase();
        const headingsLower = note.headings.map((h) => h.text).join(' ').toLowerCase();
        const bodyLower = note.searchBodyLower;

        let matchedAll = true;
        for (const term of terms) {
          let termScore = 0;
          if (titleLower === term) termScore += 120;
          else if (titleLower.startsWith(term)) termScore += 80;
          else if (titleLower.includes(term)) termScore += 55;
          if (aliasLower.includes(term)) termScore += 45;
          if (pathLower.includes(term)) termScore += 25;
          if (tagsLower.includes(term)) termScore += 30;
          if (headingsLower.includes(term)) termScore += 25;
          if (bodyLower && bodyLower.includes(term)) termScore += 15;
          if (termScore === 0) { matchedAll = false; break; }
          score += termScore;
        }
        if (!matchedAll) continue;

        if (note.rawBodySample) {
          const sampleLower = note.rawBodySample.toLowerCase();
          const firstPos = sampleLower.indexOf(terms[0]);
          if (firstPos !== -1) {
            const start = Math.max(0, firstPos - 60);
            const end = Math.min(note.rawBodySample.length, firstPos + 180);
            snippet = (start > 0 ? '…' : '') + note.rawBodySample.slice(start, end).replace(/\s+/g, ' ').trim() + (end < note.rawBodySample.length ? '…' : '');
          }
        }
      }
      scored.push({ score, note, snippet });
    }

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.note.mtimeMs - a.note.mtimeMs));
    const results = scored.slice(0, limit).map(({ score, note, snippet }) => ({
      path: note.path,
      title: note.title,
      folder: note.folder,
      tags: note.tags,
      aliases: note.aliases,
      frontmatter: note.frontmatter,
      headings: note.headings.slice(0, 8).map((h) => '#'.repeat(h.level) + ' ' + h.text),
      backlinkCount: (idx.backlinksMap.get(note.path) || []).length,
      outlinkCount: note.wikilinks.length + note.embeds.length,
      mtime: new Date(note.mtimeMs).toISOString(),
      score,
      snippet,
    }));

    return {
      vault: { id: vault.id, name: vault.name, path: vault.path },
      totalMatches: scored.length,
      truncatedScan: idx.truncatedScan,
      results,
    };
  },

  async read_note(params = {}) {
    const { vault } = resolveVault(params);
    const idx = await scanVaultIndex(vault.path);
    const hasExplicitPath = typeof params.path === 'string' && params.path.trim() !== '';
    const hasTitle = typeof params.title === 'string' && params.title.trim() !== '';
    if (!hasExplicitPath && !hasTitle) {
      throw makeError('MISSING_NOTE_TARGET', '请提供要读取的笔记 path（精确相对路径）或 title（笔记标题 / 别名 / 双链名）。');
    }

    let targetInfo;
    let ambiguousCandidates = [];
    if (hasExplicitPath) {
      // Explicit path is strictly resolved without fuzzy title/alias guessing!
      targetInfo = resolveSafeVaultTarget(vault.path, params.path, { requiredExt: '.md', mustExist: true });
    } else {
      const { note, ambiguous } = idx.resolveLinkTarget(params.title);
      if (ambiguous.length > 1) {
        throw makeError(
          'AMBIGUOUS_NOTE_TITLE',
          '存在多篇同名或同别名笔记 "' + params.title + '"，请改传精确 path 参数: ' + ambiguous.join(', ')
        );
      }
      if (!note) {
        throw makeError('NOTE_NOT_FOUND', '未在知识库 "' + vault.name + '" 中找到标题为 "' + params.title + '" 的笔记。');
      }
      ambiguousCandidates = ambiguous;
      targetInfo = resolveSafeVaultTarget(vault.path, note.path, { requiredExt: '.md', mustExist: true });
    }

    const { text: raw, stat } = await readStrictUtf8File(targetInfo.abs);
    const meta = extractNoteMetadata(raw);

    let content = meta.body;
    let selectedHeading = null;
    if (typeof params.heading === 'string' && params.heading.trim()) {
      const sec = findSectionRange(meta.body, params.heading.trim());
      if (!sec.found) {
        const available = meta.headings.map((h) => '#'.repeat(h.level) + ' ' + h.text).join(' / ') || '无标题章节';
        throw makeError('HEADING_NOT_FOUND', '笔记 "' + targetInfo.rel + '" 中未找到章节 "' + params.heading + '"。可用章节: ' + available);
      }
      content = sec.content;
      selectedHeading = params.heading.trim();
    }

    const maxChars = Math.min(Math.max(Number(params.maxChars) || 40000, 500), 120000);
    const truncated = content.length > maxChars;
    if (truncated) content = content.slice(0, maxChars) + '\n\n…[内容已按 maxChars 截断]';

    const noteFolder = path.posix.dirname(targetInfo.rel) === '.' ? '' : path.posix.dirname(targetInfo.rel);
    const backlinks = idx.backlinksMap.get(targetInfo.rel) || [];
    const outlinks = [...meta.wikilinks.map((w) => ({ ...w, embed: false })), ...meta.embeds.map((e) => ({ ...e, embed: true }))].map((wl) => {
      const { note: tNote, ambiguous } = idx.resolveLinkTarget(wl.target, noteFolder);
      return {
        target: wl.target,
        embed: wl.embed,
        resolvedPath: tNote ? tNote.path : null,
        exists: Boolean(tNote),
        ambiguousPaths: ambiguous.length > 1 ? ambiguous : undefined,
        heading: wl.heading,
        alias: wl.alias,
      };
    });

    return {
      vault: { id: vault.id, name: vault.name, path: vault.path },
      path: targetInfo.rel,
      title: path.basename(targetInfo.rel, '.md'),
      mtime: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      selectedHeading,
      truncated,
      frontmatter: meta.frontmatter,
      tags: meta.tags,
      headings: meta.headings,
      tasks: meta.tasks,
      outlinks,
      backlinks,
      ambiguousCandidates: ambiguousCandidates.length ? ambiguousCandidates : undefined,
      content,
    };
  },

  async inspect_write_target(params = {}) {
    const { vault } = resolveVault(params);
    const requiredExt = params.ext === '.canvas' ? '.canvas' : '.md';
    const targetInfo = resolveSafeVaultTarget(vault.path, params.path, { requiredExt });
    let mtimeMs = null;
    if (targetInfo.exists) {
      const st = await fsp.lstat(targetInfo.abs);
      mtimeMs = st.mtimeMs;
    }
    return {
      vault: { id: vault.id, name: vault.name, path: vault.path },
      path: targetInfo.rel,
      exists: targetInfo.exists,
      mtimeMs,
    };
  },

  async write_note(params = {}) {
    const { vault } = resolveVault(params);
    const mode = params.mode || 'create';
    const validModes = new Set([
      'create',
      'overwrite',
      'append',
      'prepend',
      'append-heading',
      'prepend-heading',
      'replace-section',
      'update-frontmatter',
      'delete',
    ]);
    if (!validModes.has(mode)) {
      throw makeError('INVALID_WRITE_MODE', '不支持的写入模式 "' + mode + '"。');
    }

    const targetInfo = resolveSafeVaultTarget(vault.path, params.path, { requiredExt: '.md' });
    const lockKey = vault.path + '::' + targetInfo.rel;

    return withWriteLock(lockKey, async () => {
      pruneIdempotencyCache();
      const idemKey = typeof params.idempotencyKey === 'string' && params.idempotencyKey.trim()
        ? vault.id + '::write_note::' + params.idempotencyKey.trim()
        : null;
      const payloadHash = idemKey
        ? crypto.createHash('sha256').update(JSON.stringify({ rel: targetInfo.rel, mode, heading: params.heading, content: params.content, frontmatter: params.frontmatter, tags: params.tags })).digest('hex')
        : null;
      if (idemKey && idempotencyCache.has(idemKey)) {
        const prev = idempotencyCache.get(idemKey);
        if (prev.payloadHash !== payloadHash) {
          throw makeError('IDEMPOTENCY_KEY_REUSED', '同一请求幂等键不能用于不同的笔记修改内容。');
        }
        return prev.result;
      }

      const freshTarget = resolveSafeVaultTarget(vault.path, targetInfo.rel, { requiredExt: '.md' });

      if (mode === 'delete') {
        if (!freshTarget.exists) {
          throw makeError('NOTE_NOT_FOUND', '要移入回收站的笔记 "' + freshTarget.rel + '" 不存在。');
        }
        const curStat = await fsp.lstat(freshTarget.abs);
        if (params.expectedMtimeMs !== undefined && params.expectedMtimeMs !== null && Math.abs(curStat.mtimeMs - Number(params.expectedMtimeMs)) > 1) {
          throw makeError('WRITE_CONFLICT', '笔记在确认前已被外部修改，已取消移入回收站。');
        }
        const trashRel = '.trash/' + freshTarget.rel.replace(/\//g, '__').replace(/\.md$/i, '') + '.' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.md';
        const trashTarget = resolveSafeVaultTarget(vault.path, trashRel, { requiredExt: '.md', allowProtectedRoot: '.trash' });
        await ensureSafeParentDirs(vault.path, trashTarget.segments);
        const fh = await fsp.open(trashTarget.abs, 'wx', 0o600);
        await fh.close();
        await fsp.rename(freshTarget.abs, trashTarget.abs);
        invalidateVaultCache(vault.path);
        const delRes = {
          action: 'moved_to_obsidian_trash',
          vault: { id: vault.id, name: vault.name, path: vault.path },
          path: freshTarget.rel,
          trashFile: trashTarget.rel,
        };
        if (idemKey) idempotencyCache.set(idemKey, { ts: Date.now(), payloadHash, result: delRes });
        return delRes;
      }

      if (mode === 'create' && freshTarget.exists) {
        throw makeError('NOTE_ALREADY_EXISTS', '笔记 "' + freshTarget.rel + '" 已存在。若需追加请使用 mode="append" 或 "append-heading"，若确实需要覆盖请使用 mode="overwrite"。');
      }
      if (mode === 'update-frontmatter' && !freshTarget.exists) {
        throw makeError('NOTE_NOT_FOUND', '要更新 Frontmatter 的笔记 "' + freshTarget.rel + '" 不存在。');
      }

      const incomingContent = typeof params.content === 'string' ? params.content : '';
      const incomingFm = params.frontmatter && typeof params.frontmatter === 'object' && !Array.isArray(params.frontmatter) ? params.frontmatter : null;
      const incomingTags = Array.isArray(params.tags) ? params.tags.map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean) : null;

      let origRaw = '';
      let origBom = false;
      let origMtimeMs = params.expectedMtimeMs !== undefined && params.expectedMtimeMs !== null ? Number(params.expectedMtimeMs) : null;
      if (freshTarget.exists) {
        const readRes = await readStrictUtf8File(freshTarget.abs);
        origRaw = readRes.text;
        origBom = readRes.hasBom;
        if (origMtimeMs === null) origMtimeMs = readRes.stat.mtimeMs;
        else if (Math.abs(readRes.stat.mtimeMs - origMtimeMs) > 1) {
          throw makeError('WRITE_CONFLICT', '笔记在确认期间已被外部修改，已中止覆盖。');
        }
      }

      let baseParsed;
      if (mode === 'create' || mode === 'overwrite') {
        baseParsed = parseFrontmatter(incomingContent);
      } else {
        baseParsed = parseFrontmatter(origRaw);
      }

      const eol = baseParsed.eol || '\n';
      const patchedFm = patchFrontmatterPreservingRaw(baseParsed, incomingFm, incomingTags);

      let nextBody = baseParsed.body;
      if (mode === 'append') {
        const struct = scanMarkdownStructure(nextBody);
        const safeBase = struct.unclosedFence ? nextBody + eol + '```' : nextBody;
        const trimmedBase = safeBase.replace(/(\r?\n)+$/, '');
        const payload = incomingContent.replace(/^(\r?\n)+|(\r?\n)+$/g, '');
        nextBody = (trimmedBase ? trimmedBase + eol + eol : '') + payload + eol;
      } else if (mode === 'prepend') {
        const payload = incomingContent.replace(/^(\r?\n)+|(\r?\n)+$/g, '');
        const rest = nextBody.replace(/^(\r?\n)+/, '');
        nextBody = payload + (rest ? eol + eol + rest : eol);
      } else if (mode === 'append-heading' || mode === 'prepend-heading' || mode === 'replace-section') {
        if (!params.heading || !String(params.heading).trim()) {
          throw makeError('MISSING_HEADING', '模式 "' + mode + '" 需要指定目标章节标题参数 heading。');
        }
        nextBody = modifyBodyUnderHeading(nextBody, String(params.heading), incomingContent, mode);
      } else if (mode === 'update-frontmatter') {
        // Preserve exact body byte-for-byte!
      } else {
        // create or overwrite: preserve exact body except ensuring trailing newline
        if (nextBody && !nextBody.endsWith('\n')) nextBody += eol;
      }

      const finalRaw = patchedFm.rawBlock + (patchedFm.rawBlock ? nextBody.replace(/^\r?\n/, '') : nextBody);
      const bytesWritten = await atomicWriteUtf8File(vault.path, freshTarget, finalRaw, {
        createOnly: mode === 'create',
        expectedMtimeMs: freshTarget.exists ? origMtimeMs : null,
        preserveBom: origBom,
      });

      const afterStat = await fsp.lstat(freshTarget.abs);
      invalidateVaultCache(vault.path);

      const writeResult = {
        action: freshTarget.exists ? mode : 'created',
        vault: { id: vault.id, name: vault.name, path: vault.path },
        path: freshTarget.rel,
        bytesWritten,
        mtimeMs: afterStat.mtimeMs,
        frontmatter: patchedFm.frontmatter,
      };
      if (idemKey) idempotencyCache.set(idemKey, { ts: Date.now(), payloadHash, result: writeResult });
      return writeResult;
    });
  },

  async daily_note(params = {}) {
    const { vault } = resolveVault(params);
    const settings = params.settings || {};
    const cfg = readDailyNoteConfig(vault.path, settings);
    const nowRef = new Date();
    const targetDate = parseStrictCalendarDate(params.date, nowRef);
    const action = params.action || 'read';
    if (!['read', 'ensure', 'append', 'add-task'].includes(action)) {
      throw makeError('INVALID_DAILY_ACTION', '不支持的 daily_note 操作: ' + action);
    }

    if (action === 'append' || action === 'add-task') {
      if (typeof params.content !== 'string' || !params.content.trim()) {
        throw makeError('MISSING_CONTENT', '向日记追加内容或待办时，content 不能为空。');
      }
    }

    const formattedRelStem = formatMomentPattern(targetDate, cfg.format);
    const relPath = cfg.folder ? cfg.folder + '/' + formattedRelStem + '.md' : formattedRelStem + '.md';
    const targetInfo = resolveSafeVaultTarget(vault.path, relPath, { requiredExt: '.md' });
    const noteTitle = path.posix.basename(targetInfo.rel, '.md');
    const isoDate = formatMomentPattern(targetDate, 'YYYY-MM-DD');
    const hhmm = formatMomentPattern(nowRef, 'HH:mm');

    if (action === 'read') {
      if (!targetInfo.exists) {
        return {
          exists: false,
          vault: { id: vault.id, name: vault.name, path: vault.path },
          path: targetInfo.rel,
          title: noteTitle,
          date: isoDate,
          content: '',
          message: '该日期的日记尚未创建。传 action="ensure" 或 "append" 可自动初始化。',
        };
      }
      const note = await handlers.read_note({ ...params, vault: vault.id, path: targetInfo.rel });
      return { exists: true, date: isoDate, ...note };
    }

    const lockKey = vault.path + '::' + targetInfo.rel;
    const writeMeta = await withWriteLock(lockKey, async () => {
      pruneIdempotencyCache();
      const idemKey = typeof params.idempotencyKey === 'string' && params.idempotencyKey.trim()
        ? vault.id + '::daily_note::' + params.idempotencyKey.trim()
        : null;
      const payloadHash = idemKey
        ? crypto.createHash('sha256').update(JSON.stringify({ rel: targetInfo.rel, action, heading: params.heading, content: params.content, timestamp: params.timestamp })).digest('hex')
        : null;
      if (idemKey && idempotencyCache.has(idemKey)) {
        const prev = idempotencyCache.get(idemKey);
        if (prev.payloadHash !== payloadHash) throw makeError('IDEMPOTENCY_KEY_REUSED', '同一幂等键不能用于不同的日记内容。');
        return prev.result;
      }

      const freshTarget = resolveSafeVaultTarget(vault.path, targetInfo.rel, { requiredExt: '.md' });
      let baseRaw = '';
      let origBom = false;
      let origMtimeMs = null;
      let templateWarning = null;

      if (freshTarget.exists) {
        const r = await readStrictUtf8File(freshTarget.abs);
        baseRaw = r.text;
        origBom = r.hasBom;
        origMtimeMs = r.stat.mtimeMs;
      } else {
        baseRaw = '# ' + noteTitle + '\n\n';
        if (cfg.template) {
          try {
            const tplTarget = resolveSafeVaultTarget(vault.path, cfg.template, { requiredExt: '.md', mustExist: true });
            const tplRead = await readStrictUtf8File(tplTarget.abs);
            baseRaw = tplRead.text
              .replace(/\{\{date\}\}/g, () => isoDate)
              .replace(/\{\{title\}\}/g, () => noteTitle)
              .replace(/\{\{time\}\}/g, () => hhmm);
          } catch (err) {
            templateWarning = '日记模板未能加载（已使用默认标题初始化）: ' + err.message;
          }
        }
      }

      if (action === 'ensure' && freshTarget.exists) {
        const res = { committed: false, action: 'already_exists', path: freshTarget.rel, templateWarning };
        if (idemKey) idempotencyCache.set(idemKey, { ts: Date.now(), payloadHash, result: res });
        return res;
      }

      let finalRaw = baseRaw;
      if (action === 'append' || action === 'add-task') {
        const rawLine = params.content.trim();
        const formattedLine = action === 'add-task'
          ? '- [ ] ' + rawLine.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '')
          : (params.timestamp !== false ? '- **' + hhmm + '** ' + rawLine : rawLine);
        const parsed = parseFrontmatter(baseRaw);
        const eol = parsed.eol || '\n';
        let nextBody;
        if (params.heading && String(params.heading).trim()) {
          nextBody = modifyBodyUnderHeading(parsed.body, String(params.heading), formattedLine, 'append-heading');
        } else {
          const struct = scanMarkdownStructure(parsed.body);
          const safeBody = struct.unclosedFence ? parsed.body + eol + '```' : parsed.body;
          const trimmed = safeBody.replace(/(\r?\n)+$/, '');
          nextBody = (trimmed ? trimmed + eol + eol : '') + formattedLine + eol;
        }
        finalRaw = parsed.rawBlock + (parsed.rawBlock ? nextBody.replace(/^\r?\n/, '') : nextBody);
      }

      // Single atomic commit whether initializing template + first entry or appending to existing daily note!
      await atomicWriteUtf8File(vault.path, freshTarget, finalRaw, {
        createOnly: !freshTarget.exists,
        expectedMtimeMs: freshTarget.exists ? origMtimeMs : null,
        preserveBom: origBom,
      });
      invalidateVaultCache(vault.path);
      const res = { committed: true, action: freshTarget.exists ? action : 'created_and_' + action, path: freshTarget.rel, templateWarning };
      if (idemKey) idempotencyCache.set(idemKey, { ts: Date.now(), payloadHash, result: res });
      return res;
    });

    try {
      const updated = await handlers.read_note({ ...params, vault: vault.id, path: targetInfo.rel });
      return {
        exists: true,
        date: isoDate,
        updatedAction: writeMeta.action,
        templateWarning: writeMeta.templateWarning || undefined,
        ...updated,
      };
    } catch (readErr) {
      return {
        exists: true,
        date: isoDate,
        vault: { id: vault.id, name: vault.name, path: vault.path },
        path: targetInfo.rel,
        title: noteTitle,
        updatedAction: writeMeta.action,
        previewWarning: '日记已成功保存，但回读预览失败: ' + readErr.message,
      };
    }
  },

  async graph_links(params = {}) {
    const { vault } = resolveVault(params);
    const idx = await scanVaultIndex(vault.path, Boolean(params.refresh));
    const mode = params.mode || 'note';
    const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 100);

    if (mode === 'orphans') {
      const orphans = idx.notes
        .filter((n) => n.wikilinks.length === 0 && n.embeds.length === 0 && (idx.backlinksMap.get(n.path) || []).length === 0)
        .slice(0, limit)
        .map((n) => ({ path: n.path, title: n.title, folder: n.folder, mtime: new Date(n.mtimeMs).toISOString() }));
      return { vault: { id: vault.id, name: vault.name, path: vault.path }, mode, count: orphans.length, orphans };
    }

    if (mode === 'hubs') {
      const hubs = idx.notes
        .map((n) => {
          const backlinks = (idx.backlinksMap.get(n.path) || []).length;
          const outlinks = n.wikilinks.length + n.embeds.length;
          return { path: n.path, title: n.title, backlinks, outlinks, degree: backlinks + outlinks, tags: n.tags };
        })
        .sort((a, b) => b.degree - a.degree)
        .slice(0, limit);
      return { vault: { id: vault.id, name: vault.name, path: vault.path }, mode, hubs };
    }

    if (mode === 'tags') {
      const map = new Map();
      for (const n of idx.notes) {
        for (const t of n.tags) {
          if (!map.has(t)) map.set(t, []);
          map.get(t).push(n.path);
        }
      }
      const tags = Array.from(map.entries())
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, limit)
        .map(([tag, paths]) => ({ tag, count: paths.length, sampleNotes: paths.slice(0, 5) }));
      return { vault: { id: vault.id, name: vault.name, path: vault.path }, mode, tags };
    }

    let note = null;
    if (typeof params.path === 'string' && params.path.trim()) {
      const clean = normalizeRelPath(params.path, '.md').toLowerCase();
      note = idx.byRelLower.get(clean) || null;
    } else if (typeof params.title === 'string' && params.title.trim()) {
      const resolved = idx.resolveLinkTarget(params.title);
      if (resolved.ambiguous.length > 1) {
        throw makeError('AMBIGUOUS_NOTE_TITLE', '存在多篇同名笔记 "' + params.title + '"，请传入精确 path: ' + resolved.ambiguous.join(', '));
      }
      note = resolved.note;
    } else {
      throw makeError('MISSING_NOTE_TARGET', '查询单篇笔记图谱关系时请提供 path 或 title；或将 mode 设为 "hubs" / "orphans" / "tags"。');
    }
    if (!note) {
      throw makeError('NOTE_NOT_FOUND', '未找到目标笔记。');
    }

    const backlinks = idx.backlinksMap.get(note.path) || [];
    const outlinks = [...note.wikilinks.map((w) => ({ ...w, embed: false })), ...note.embeds.map((e) => ({ ...e, embed: true }))].map((wl) => {
      const { note: rNote, ambiguous } = idx.resolveLinkTarget(wl.target, note.folder);
      return {
        target: wl.target,
        embed: wl.embed,
        resolvedPath: rNote ? rNote.path : null,
        exists: Boolean(rNote),
        ambiguousPaths: ambiguous.length > 1 ? ambiguous : undefined,
      };
    });

    const linkedSet = new Set([note.path, ...backlinks.map((b) => b.path), ...outlinks.map((o) => o.resolvedPath).filter(Boolean)]);
    const titleLower = note.title.toLowerCase();
    const unlinkedMentions = [];
    if (titleLower.length >= 2) {
      for (const candidate of idx.notes) {
        if (linkedSet.has(candidate.path) || !candidate.searchBodyLower) continue;
        const pos = candidate.searchBodyLower.indexOf(titleLower);
        if (pos !== -1 && candidate.rawBodySample) {
          const start = Math.max(0, pos - 40);
          const end = Math.min(candidate.rawBodySample.length, pos + 100);
          unlinkedMentions.push({
            path: candidate.path,
            title: candidate.title,
            context: candidate.rawBodySample.slice(start, end).replace(/\s+/g, ' ').trim(),
          });
          if (unlinkedMentions.length >= 15) break;
        }
      }
    }

    const twoHopMap = new Map();
    for (const o of outlinks) {
      if (!o.resolvedPath) continue;
      const mid = idx.byRelLower.get(o.resolvedPath.toLowerCase());
      if (!mid) continue;
      for (const wl2 of [...mid.wikilinks, ...mid.embeds]) {
        const { note: hop2 } = idx.resolveLinkTarget(wl2.target, mid.folder);
        if (hop2 && !linkedSet.has(hop2.path)) {
          twoHopMap.set(hop2.path, { path: hop2.path, title: hop2.title, via: mid.title });
        }
      }
    }

    return {
      vault: { id: vault.id, name: vault.name, path: vault.path },
      note: { path: note.path, title: note.title, tags: note.tags },
      outlinks,
      backlinks,
      unlinkedMentions,
      relatedTwoHop: Array.from(twoHopMap.values()).slice(0, 15),
    };
  },

  async canvas_ops(params = {}) {
    const { vault } = resolveVault(params);
    const action = params.action || 'list';

    if (action === 'list') {
      const idx = await scanVaultIndex(vault.path);
      return {
        vault: { id: vault.id, name: vault.name, path: vault.path },
        canvases: idx.canvases.map((c) => ({
          path: c.path,
          name: c.name,
          size: c.size,
          mtime: new Date(c.mtimeMs).toISOString(),
        })),
      };
    }

    if (!params.path) {
      throw makeError('MISSING_CANVAS_PATH', '请指定 .canvas 文件路径 path（如 "知识白板.canvas"）。');
    }
    const targetInfo = resolveSafeVaultTarget(vault.path, params.path, { requiredExt: '.canvas' });

    if (action === 'read') {
      if (!targetInfo.exists) {
        throw makeError('CANVAS_NOT_FOUND', '未找到白板文件 "' + targetInfo.rel + '"。');
      }
      const { text, stat } = await readStrictUtf8File(targetInfo.abs);
      let doc;
      try {
        doc = JSON.parse(text);
      } catch {
        throw makeError('INVALID_CANVAS_JSON', '白板文件不是合法的 JSON 格式。');
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw makeError('INVALID_CANVAS_JSON', '白板根节点必须是 JSON 对象。');
      }
      return {
        vault: { id: vault.id, name: vault.name, path: vault.path },
        path: targetInfo.rel,
        mtimeMs: stat.mtimeMs,
        canvas: doc,
        nodes: Array.isArray(doc.nodes) ? doc.nodes : [],
        edges: Array.isArray(doc.edges) ? doc.edges : [],
      };
    }

    // Explicit non-destructive modes: create (no overwrite), upsert (merge by id preserving unknown fields!), overwrite (requires confirmation upstream)
    const normalizedAction = action === 'write' ? (targetInfo.exists ? 'upsert' : 'create') : action;
    if (!['create', 'upsert', 'overwrite'].includes(normalizedAction)) {
      throw makeError('INVALID_CANVAS_ACTION', '不支持的 canvas action "' + action + '"（可选 list / read / create / upsert / overwrite）。');
    }

    const validateNode = (n, idx, existingNode = null) => {
      if (!n || typeof n !== 'object' || Array.isArray(n)) {
        throw makeError('INVALID_CANVAS_NODE', '第 ' + (idx + 1) + ' 个节点必须是对象。');
      }
      const merged = { ...(existingNode || {}), ...n };
      const id = String(merged.id || ('node-' + (idx + 1))).trim();
      if (!id) throw makeError('INVALID_CANVAS_NODE', '节点 id 不能为空。');
      const type = merged.type || (merged.file ? 'file' : (merged.url ? 'link' : 'text'));
      if (!['text', 'file', 'link', 'group'].includes(type)) {
        throw makeError('INVALID_CANVAS_NODE', '节点 "' + id + '" 的 type 不合法（允许 text / file / link / group）。');
      }
      if (type === 'file') {
        if (typeof merged.file !== 'string' || !merged.file.trim()) {
          throw makeError('INVALID_CANVAS_NODE', 'file 类型节点 "' + id + '" 必须包含库内相对路径字段 file。');
        }
        const cleanFile = merged.file.trim().replace(/\\/g, '/').replace(/^\/+/, '');
        resolveSafeVaultTarget(vault.path, cleanFile, { requiredExt: path.posix.extname(cleanFile) || '.md' });
        merged.file = cleanFile;
      }
      if (type === 'link') {
        if (typeof merged.url !== 'string' || !/^https?:\/\//i.test(merged.url.trim())) {
          throw makeError('INVALID_CANVAS_NODE', 'link 类型节点 "' + id + '" 的 url 仅允许 http:// 或 https:// 地址。');
        }
      }
      const x = merged.x !== undefined ? Number(merged.x) : (idx % 3) * 380;
      const y = merged.y !== undefined ? Number(merged.y) : Math.floor(idx / 3) * 240;
      const width = merged.width !== undefined ? Number(merged.width) : 320;
      const height = merged.height !== undefined ? Number(merged.height) : 180;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw makeError('INVALID_CANVAS_NODE', '节点 "' + id + '" 的坐标或宽高数值无效（宽高必须为正数）。');
      }
      return { ...merged, id, type, x, y, width, height };
    };

    const validateEdge = (e, idx, nodeIds, existingEdge = null) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        throw makeError('INVALID_CANVAS_EDGE', '第 ' + (idx + 1) + ' 条连线必须是对象。');
      }
      const merged = { ...(existingEdge || {}), ...e };
      const id = String(merged.id || ('edge-' + (idx + 1))).trim();
      const fromNode = String(merged.fromNode || '').trim();
      const toNode = String(merged.toNode || '').trim();
      if (!fromNode || !toNode || !nodeIds.has(fromNode) || !nodeIds.has(toNode)) {
        throw makeError('INVALID_CANVAS_EDGE', '连线 "' + id + '" 引用了不存在的节点端点（fromNode=' + fromNode + ', toNode=' + toNode + '）。');
      }
      return {
        ...merged,
        id,
        fromNode,
        toNode,
        fromSide: merged.fromSide || 'right',
        toSide: merged.toSide || 'left',
      };
    };

    const lockKey = vault.path + '::' + targetInfo.rel;
    return withWriteLock(lockKey, async () => {
      const freshTarget = resolveSafeVaultTarget(vault.path, targetInfo.rel, { requiredExt: '.canvas' });
      if (normalizedAction === 'create' && freshTarget.exists) {
        throw makeError('CANVAS_ALREADY_EXISTS', '白板 "' + freshTarget.rel + '" 已存在。请使用 action="upsert" 增量合并节点，或使用 action="overwrite" 整板替换。');
      }
      if (!Array.isArray(params.nodes) && !Array.isArray(params.edges) && !Array.isArray(params.removeNodeIds) && !Array.isArray(params.removeEdgeIds)) {
        throw makeError('INVALID_CANVAS_PAYLOAD', '保存白板时必须提供 nodes、edges、removeNodeIds 或 removeEdgeIds 中的至少一项。');
      }

      let baseDoc = { nodes: [], edges: [] };
      let origBom = false;
      let origMtimeMs = params.expectedMtimeMs !== undefined && params.expectedMtimeMs !== null ? Number(params.expectedMtimeMs) : null;
      if (freshTarget.exists) {
        const r = await readStrictUtf8File(freshTarget.abs);
        origBom = r.hasBom;
        if (origMtimeMs === null) origMtimeMs = r.stat.mtimeMs;
        else if (Math.abs(r.stat.mtimeMs - origMtimeMs) > 1) {
          throw makeError('WRITE_CONFLICT', '白板在确认期间已被外部修改，已中止保存。');
        }
        if (normalizedAction === 'upsert') {
          const parsed = JSON.parse(r.text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) baseDoc = parsed;
        }
      }

      let finalNodes = [];
      let finalEdges = [];

      if (normalizedAction === 'upsert' && freshTarget.exists) {
        const removeNodes = new Set(Array.isArray(params.removeNodeIds) ? params.removeNodeIds.map(String) : []);
        const removeEdges = new Set(Array.isArray(params.removeEdgeIds) ? params.removeEdgeIds.map(String) : []);
        const nodeMap = new Map();
        for (const oldN of Array.isArray(baseDoc.nodes) ? baseDoc.nodes : []) {
          if (oldN && oldN.id && !removeNodes.has(String(oldN.id))) nodeMap.set(String(oldN.id), oldN);
        }
        if (Array.isArray(params.nodes)) {
          params.nodes.forEach((n, idx) => {
            const key = String(n.id || ('node-' + (nodeMap.size + idx + 1)));
            const validated = validateNode({ ...n, id: key }, idx, nodeMap.get(key) || null);
            nodeMap.set(validated.id, validated);
          });
        }
        finalNodes = Array.from(nodeMap.values());
        const validNodeIds = new Set(finalNodes.map((n) => n.id));

        const edgeMap = new Map();
        for (const oldE of Array.isArray(baseDoc.edges) ? baseDoc.edges : []) {
          if (
            oldE &&
            oldE.id &&
            !removeEdges.has(String(oldE.id)) &&
            validNodeIds.has(String(oldE.fromNode)) &&
            validNodeIds.has(String(oldE.toNode))
          ) {
            edgeMap.set(String(oldE.id), oldE);
          }
        }
        if (Array.isArray(params.edges)) {
          params.edges.forEach((e, idx) => {
            const key = String(e.id || ('edge-' + (edgeMap.size + idx + 1)));
            const validated = validateEdge({ ...e, id: key }, idx, validNodeIds, edgeMap.get(key) || null);
            edgeMap.set(validated.id, validated);
          });
        }
        finalEdges = Array.from(edgeMap.values());
      } else {
        const seenNodeIds = new Set();
        finalNodes = (Array.isArray(params.nodes) ? params.nodes : []).map((n, idx) => {
          const v = validateNode(n, idx, null);
          if (seenNodeIds.has(v.id)) throw makeError('DUPLICATE_CANVAS_ID', '存在重复的节点 id: ' + v.id);
          seenNodeIds.add(v.id);
          return v;
        });
        const seenEdgeIds = new Set();
        finalEdges = (Array.isArray(params.edges) ? params.edges : []).map((e, idx) => {
          const v = validateEdge(e, idx, seenNodeIds, null);
          if (seenEdgeIds.has(v.id)) throw makeError('DUPLICATE_CANVAS_ID', '存在重复的连线 id: ' + v.id);
          seenEdgeIds.add(v.id);
          return v;
        });
      }

      const finalDoc = { ...baseDoc, nodes: finalNodes, edges: finalEdges };
      const payload = JSON.stringify(finalDoc, null, 2) + '\n';
      await atomicWriteUtf8File(vault.path, freshTarget, payload, {
        createOnly: normalizedAction === 'create',
        expectedMtimeMs: freshTarget.exists ? origMtimeMs : null,
        preserveBom: origBom,
      });
      invalidateVaultCache(vault.path);
      return {
        action: freshTarget.exists ? normalizedAction : 'created',
        vault: { id: vault.id, name: vault.name, path: vault.path },
        path: freshTarget.rel,
        nodeCount: finalNodes.length,
        edgeCount: finalEdges.length,
      };
    });
  },

  async open_in_obsidian(params = {}) {
    const { vault } = resolveVault(params);
    const cli = await detectObsidianCli();
    let relPath = '';
    let absTarget = vault.path;

    if (typeof params.path === 'string' && params.path.trim()) {
      const rawExt = path.posix.extname(params.path.trim()).toLowerCase();
      const allowedExts = new Set(['.md', '.canvas', '.base', '.pdf', '.png', '.jpg', '.jpeg', '.webp']);
      const reqExt = rawExt ? (allowedExts.has(rawExt) ? rawExt : null) : '.md';
      if (!reqExt) {
        throw makeError('UNSUPPORTED_FILE_EXTENSION', '不支持在 Obsidian 中唤起该后缀类型的文件。');
      }
      const checked = resolveSafeVaultTarget(vault.path, params.path, { requiredExt: reqExt, mustExist: true });
      relPath = checked.rel;
      absTarget = checked.abs;
    }

    if (cli.running && cli.cliEnabled && cli.binary && relPath && vault.source === 'obsidian') {
      try {
        await execFileAsync(cli.binary, ['vault=' + vault.name, 'open', 'path=' + relPath], { timeout: 3000 });
        return { launchRequested: true, method: 'obsidian-cli', vault: { id: vault.id, name: vault.name }, path: relPath };
      } catch {
        // fallback to obsidian:// path URI
      }
    }

    // Use full path URI (obsidian://open?path=...) when registered by path to avoid duplicate vault name ambiguity!
    const uri = vault.source === 'obsidian' && /^[0-9a-f]{8,}$/i.test(vault.id) && relPath
      ? 'obsidian://open?path=' + encodeURIComponent(absTarget)
      : (relPath
          ? 'obsidian://open?path=' + encodeURIComponent(absTarget)
          : 'obsidian://open?path=' + encodeURIComponent(vault.path));

    if (process.platform === 'darwin') {
      await execFileAsync('/usr/bin/open', [uri], { timeout: 3000 });
    } else if (process.platform === 'win32') {
      // Avoid cmd.exe shell parsing; use rundll32 url.dll,FileProtocolHandler
      await execFileAsync('rundll32.exe', ['url.dll,FileProtocolHandler', uri], { timeout: 3000 });
    } else {
      await execFileAsync('xdg-open', [uri], { timeout: 3000 });
    }

    return {
      launchRequested: true,
      method: 'obsidian-uri',
      uri,
      vault: { id: vault.id, name: vault.name },
      path: relPath || null,
    };
  },

  async complete_notes(params = {}) {
    let resolved;
    try {
      resolved = resolveVault(params);
    } catch {
      return { items: [], reason: 'no_vault' };
    }
    const { vault } = resolved;
    const idx = await scanVaultIndex(vault.path);
    const q = typeof params.query === 'string' ? params.query.trim().toLowerCase() : '';
    const refStyle = params.settings && (params.settings.insert_style || params.settings.insertStyle) === 'path' ? 'path' : 'wikilink';

    const matches = [];
    for (const note of idx.notes) {
      if (!q) {
        matches.push({ score: 1, note });
      } else {
        let s = 0;
        const tl = note.title.toLowerCase();
        const pl = note.path.toLowerCase();
        if (tl === q) s = 100;
        else if (tl.startsWith(q)) s = 80;
        else if (tl.includes(q)) s = 60;
        else if (pl.includes(q)) s = 40;
        else if (note.tags.some((t) => t.toLowerCase().includes(q))) s = 30;
        if (s > 0) matches.push({ score: s, note });
      }
    }

    matches.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.note.mtimeMs - a.note.mtimeMs));
    const items = matches.slice(0, 8).map(({ note }, i) => {
      const sameTitleCount = (idx.byTitleLowerList.get(note.title.toLowerCase()) || []).length;
      const linkTarget = sameTitleCount > 1 ? note.path.replace(/\.md$/i, '') + '|' + note.title : note.title;
      const insertText = refStyle === 'path'
        ? '[Obsidian: ' + note.path + ']'
        : '[[' + linkTarget + ']] (Obsidian: ' + note.path + ')';
      const tagPreview = note.tags.length ? ' · #' + note.tags.slice(0, 3).join(' #') : '';
      return {
        id: 'obs-note-' + i + '-' + Buffer.from(note.path).toString('base64url').slice(0, 24),
        label: note.title + (note.folder ? ' — ' + note.folder : ''),
        insertText,
        description: (vault.name + ': ' + note.path + tagPreview).slice(0, 200),
      };
    });

    return { items };
  },
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line || !line.trim()) return;
  if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'RPC request payload too large' } });
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string') {
    const reqId = request && typeof request === 'object' && ('id' in request) ? request.id : null;
    reply({ jsonrpc: '2.0', id: reqId, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(handlers, request.method)) {
    reply({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32601, message: 'Unknown method: ' + request.method } });
    return;
  }
  const params = request.params === undefined ? {} : request.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    reply({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32602, message: 'Invalid params: expected JSON object' } });
    return;
  }

  try {
    const result = await handlers[request.method](params);
    reply({ jsonrpc: '2.0', id: request.id ?? null, result });
  } catch (err) {
    reply({
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: {
        code: -32000,
        message: err && err.message ? err.message : '操作执行失败',
        data: { errorCode: (err && err.code) || 'WORKER_ERROR' },
      },
    });
  }
});
