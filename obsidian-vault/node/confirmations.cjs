'use strict';

// Destructive operations wait here for the user's click on a Cindy chat card.
//
// A request moves pending -> claimed -> done. The rename to "claimed" is atomic, so one request
// runs at most once even if the card is clicked twice. Note content is stored only while a request
// is waiting or running; the "done" record keeps the outcome alone.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { stateDirectory } = require('./write-receipts.cjs');

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const EXECUTION_STALE_MS = 5 * 60 * 1000;
const CONFIRMATION_KEEP_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[a-f0-9]{32}$/;
const FILE_RE = /^([a-f0-9]{32})\.(pending|claimed|done)\.json$/;

const directory = () => path.join(stateDirectory(), 'confirmations');
const recordFile = (id, stage) => path.join(directory(), id + '.' + stage + '.json');

function confirmationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw confirmationError('CONFIRMATION_NOT_FOUND', '确认编号无效。');
  }
  return id;
}

async function readRecord(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw confirmationError('CONFIRMATION_UNREADABLE', '无法读取待确认的操作记录。');
  }
}

async function writeRecord(file, record) {
  const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

// What may be kept once a request is settled: never the pending parameters or their preview.
function summaryOf(record) {
  return {
    id: record.id,
    tool: record.tool,
    cardCallId: record.cardCallId,
    vaultName: record.vaultName,
    path: record.path,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

async function settleConfirmation(record, stage, state, extra = {}) {
  const settled = { ...summaryOf(record), ...extra, state, finishedAt: Date.now() };
  await writeRecord(recordFile(record.id, 'done'), settled);
  // The done record is written first, so a reader never sees the request vanish.
  await fs.unlink(recordFile(record.id, stage)).catch(() => {});
  return settled;
}

async function sweepConfirmations(now) {
  const names = await fs.readdir(directory());
  for (const name of names) {
    const match = FILE_RE.exec(name);
    const file = path.join(directory(), name);
    try {
      if (!match) {
        if (name.endsWith('.tmp') && now - (await fs.stat(file)).mtimeMs > CONFIRMATION_KEEP_MS) await fs.unlink(file);
        continue;
      }
      const [, , stage] = match;
      const record = await readRecord(file);
      if (!record) continue;
      if (stage === 'pending' && now > record.expiresAt) await settleConfirmation(record, 'pending', 'expired');
      else if (stage !== 'pending' && now - record.createdAt > CONFIRMATION_KEEP_MS) await fs.unlink(file);
    } catch {
      // Housekeeping never blocks a new request.
    }
  }
}

async function createConfirmation(details) {
  const now = Date.now();
  await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
  await sweepConfirmations(now).catch(() => {});
  const record = {
    ...details,
    id: randomBytes(16).toString('hex'),
    createdAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
  };
  await writeRecord(recordFile(record.id, 'pending'), record);
  return record;
}

async function confirmationStatus(id) {
  assertId(id);
  // Read in lifecycle order so a request moving forward is still found.
  const pending = await readRecord(recordFile(id, 'pending'));
  if (pending) return { ...summaryOf(pending), state: Date.now() > pending.expiresAt ? 'expired' : 'pending' };
  const claimed = await readRecord(recordFile(id, 'claimed'));
  const done = await readRecord(recordFile(id, 'done'));
  if (done) return done;
  if (claimed) {
    const stale = Date.now() - (claimed.claimedAt || claimed.createdAt) > EXECUTION_STALE_MS;
    return { ...summaryOf(claimed), state: stale ? 'unconfirmed' : 'executing' };
  }
  return { id, state: 'missing' };
}

function assertSameCard(record, cardCallId) {
  if (record.cardCallId && record.cardCallId !== cardCallId) {
    throw confirmationError('CONFIRMATION_MISMATCH', '这个按钮不属于该确认卡片。');
  }
}

// Takes a pending request for execution. At most one caller ever receives { taken: true }.
async function takeConfirmation(id, cardCallId) {
  assertId(id);
  if (typeof cardCallId !== 'string' || !cardCallId) {
    throw confirmationError('CONFIRMATION_MISMATCH', '缺少确认卡片编号。');
  }
  const notTaken = async () => {
    const status = await confirmationStatus(id);
    assertSameCard(status, cardCallId);
    return { taken: false, status };
  };
  const record = await readRecord(recordFile(id, 'pending'));
  if (!record) return notTaken();
  assertSameCard(record, cardCallId);
  if (Date.now() > record.expiresAt) {
    await settleConfirmation(record, 'pending', 'expired');
    return notTaken();
  }
  try {
    await fs.rename(recordFile(id, 'pending'), recordFile(id, 'claimed'));
  } catch (error) {
    if (error.code === 'ENOENT') return notTaken();
    throw error;
  }
  const claimed = { ...record, claimedAt: Date.now() };
  await writeRecord(recordFile(id, 'claimed'), claimed);
  return { taken: true, record: claimed };
}

module.exports = {
  CONFIRMATION_TTL_MS,
  createConfirmation,
  confirmationStatus,
  takeConfirmation,
  settleConfirmation,
};
