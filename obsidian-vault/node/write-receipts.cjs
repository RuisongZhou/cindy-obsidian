const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The plugin's private folder in this computer's application data.
function stateDirectory() {
  const home = os.homedir();
  const state = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : path.isAbsolute(process.env.XDG_STATE_HOME || '') ? process.env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(state, 'Cindy Obsidian Vault');
}

const receiptDirectory = () => path.join(stateDirectory(), 'write-receipts');

function unknownWrite() {
  return Object.assign(new Error('无法确认上次写入结果。请在执行电脑核对目标笔记，避免重复写入。'), {
    code: 'WRITE_OUTCOME_UNKNOWN',
  });
}

function receiptFile(vault, method, rawKey) {
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!key) return null;
  if (key.length > 128) throw Object.assign(new Error('写入请求编号过长。'), { code: 'INVALID_WRITE_KEY' });
  return path.join(receiptDirectory(), digest([vault.path, method, key]) + '.json');
}

async function readReceipt(file) {
  try {
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    if (record?.state === 'saved' && typeof record.hash === 'string' && record.result) return record;
    if (record?.state === 'pending' && typeof record.hash === 'string') return record;
    throw unknownWrite();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw unknownWrite();
  }
}

async function writeRecord(file, record) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareWrite(vault, method, key, payload) {
  const file = receiptFile(vault, method, key);
  if (!file) return { commit: (write) => write() };
  const hash = digest(payload);
  const savedResult = (record) => {
    if (!record) throw unknownWrite();
    if (record.hash !== hash) {
      throw Object.assign(new Error('同一请求编号不能用于不同的写入。'), { code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    if (record.state !== 'saved') throw unknownWrite();
    return record.result;
  };
  const previous = await readReceipt(file);
  if (previous) return { previous: savedResult(previous) };

  async function commit(write) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // Claim the request before changing the note, including across worker processes.
      await writeRecord(file, { state: 'pending', hash, path: payload.rel });
    } catch (error) {
      if (error.code === 'EEXIST') return savedResult(await readReceipt(file));
      throw Object.assign(new Error('无法保存写入编号，本次未修改笔记。'), { code: 'WRITE_RECEIPT_UNAVAILABLE' });
    }
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const result = await write();
      await writeRecord(temporary, { state: 'saved', hash, result });
      await fs.rename(temporary, file);
      return result;
    } catch {
      // A worker exit or an I/O failure can straddle the note commit. Keep the claim.
      await fs.unlink(temporary).catch(() => {});
      throw unknownWrite();
    }
  }
  return { commit };
}

async function getWriteReceipt(vault, method, key) {
  const file = receiptFile(vault, method, key);
  if (!file) throw Object.assign(new Error('缺少写入请求编号。'), { code: 'INVALID_WRITE_KEY' });
  let record;
  try {
    record = await readReceipt(file);
  } catch {
    return { state: 'unconfirmed' };
  }
  if (!record) return { state: 'missing' };
  if (record.state !== 'saved') return { state: 'unconfirmed', path: record.path };
  return { state: 'saved', path: record.result.path };
}

module.exports = { prepareWrite, getWriteReceipt, stateDirectory };
