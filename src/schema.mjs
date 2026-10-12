import { randomUUID } from 'node:crypto';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const quality = new Set(['fresh', 'stale', 'degraded', 'unavailable']);
const groups = new Set(['prediction', 'futures', 'spot', 'equity', 'fx']);
export function object(value, allowed, name = 'request') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new InputError(`Supply a ${name} object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new InputError(`Unsupported ${name} field: ${key}.`);
  return value;
}
export function text(value, max, name, { nullable = false, blank = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length > max || (!blank && !value.trim())) throw new InputError(`Invalid ${name}.`);
  return value;
}
export function timestamp(value, name, nullable = true) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new InputError(`Invalid ${name} timestamp.`);
  return value;
}
function choice(value, options, name, nullable = false) {
  if (nullable && value == null) return null;
  if (!options.has(value)) throw new InputError(`Invalid ${name}.`);
  return value;
}
function number(value, name) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new InputError(`Invalid ${name}.`);
  return value;
}
export function signalSnapshot(value) {
  if (value == null) return null;
  object(value, ['schemaVersion', 'strategyDefinitionId', 'strategyName', 'sourceOperationId', 'sourceRecordId', 'sourceAsOfUtc', 'quality', 'action', 'legs'], 'signal');
  if (value.schemaVersion !== 'product.journal_signal.v1' || !Array.isArray(value.legs) || value.legs.length < 1 || value.legs.length > 8 || Buffer.byteLength(JSON.stringify(value)) > 32768) throw new InputError('Invalid signal schema or leg count.');
  for (const required of ['sourceRecordId', 'sourceAsOfUtc']) if (!(required in value)) throw new InputError(`Missing signal ${required}.`);
  text(value.strategyDefinitionId, 160, 'strategy identity', { nullable: true });
  text(value.strategyName, 200, 'strategy name', { nullable: true });
  text(value.sourceOperationId, 160, 'source operation');
  text(value.sourceRecordId, 200, 'source record', { nullable: true });
  timestamp(value.sourceAsOfUtc, 'signal source');
  choice(value.quality, quality, 'signal quality');
  text(value.action, 80, 'signal action', { nullable: true });
  for (const leg of value.legs) {
    object(leg, ['asset', 'side', 'direction', 'quantity', 'quantityUnit', 'quantityAsset', 'notionalUsd', 'referencePrice'], 'signal leg');
    for (const key of ['side', 'direction', 'quantity', 'quantityUnit', 'quantityAsset']) if (!(key in leg)) throw new InputError(`Missing leg ${key}.`);
    choice(leg.side, new Set(['buy', 'sell']), 'side', true);
    choice(leg.direction, new Set(['long', 'short', 'neutral']), 'direction', true);
    choice(leg.quantityUnit, new Set(['tokens', 'contracts', 'base', 'quote']), 'quantity unit', true);
    text(leg.quantityAsset, 80, 'quantity asset', { nullable: true });
    number(leg.quantity, 'quantity'); number(leg.notionalUsd, 'USD notional'); number(leg.referencePrice, 'reference price');
    const asset = object(leg.asset, ['instrumentId', 'nativeInstrumentId', 'assetKey', 'assetGroup', 'instrumentType', 'venue', 'symbol', 'source', 'observedAtUtc', 'quality'], 'asset');
    for (const key of ['instrumentId', 'nativeInstrumentId', 'instrumentType', 'venue', 'symbol', 'source']) text(asset[key], 200, `asset ${key}`);
    text(asset.assetKey, 160, 'asset key', { nullable: true });
    choice(asset.assetGroup, groups, 'asset group'); choice(asset.quality, quality, 'asset quality');
    if (!('observedAtUtc' in asset)) throw new InputError('Missing asset clock.');
    timestamp(asset.observedAtUtc, 'asset observation');
  }
  return structuredClone(value);
}
export function journalInput(value, { update = false } = {}) {
  object(value, ['notebookId', 'title', 'body', 'instrument', 'venue', 'status', 'source', 'observedAtUtc', 'signal', ...(update ? ['version'] : [])]);
  if (!ID.test(value.notebookId)) throw new InputError('Choose a valid notebook.');
  if (update && (!Number.isInteger(value.version) || value.version < 1)) throw new InputError('Supply the current entry version.');
  const result = {
    notebookId: value.notebookId, title: text(value.title, 200, 'title').trim(),
    body: text(value.body, 20000, 'body', { blank: true }),
    instrument: text(value.instrument, 160, 'instrument', { nullable: true }),
    venue: text(value.venue, 80, 'venue', { nullable: true }),
    status: choice(value.status ?? 'watching', new Set(['watching', 'reviewed', 'closed']), 'status'),
    source: choice(value.source ?? 'manual', new Set(['manual', 'agent']), 'source'),
    observedAtUtc: timestamp(value.observedAtUtc, 'observation'),
  };
  if ('signal' in value) result.signal = signalSnapshot(value.signal);
  if (update) result.version = value.version;
  return result;
}
export function newEntry(input, now = new Date().toISOString()) {
  return { ...journalInput(input), signal: input.signal ?? null, id: randomUUID(), version: 1, createdAtUtc: now, updatedAtUtc: now, telegramStatus: 'none' };
}
export const DEFAULT_SETTINGS = Object.freeze({ enabled: false, source: 'local', notebookIds: [], section: '', instructions: '', intervalSeconds: 60, model: 'qwen3:1.7b', executionEnabled: false, accountId: null, authorizationId: null, policy: null, maxSignalAgeSeconds: 120 });
export function settingsInput(value) {
  object(value, ['version', 'enabled', 'source', 'notebookIds', 'section', 'instructions', 'intervalSeconds', 'executionEnabled', 'accountId', 'authorizationId']);
  if (!Number.isInteger(value.version) || value.version < 1 || typeof value.enabled !== 'boolean' || typeof value.executionEnabled !== 'boolean') throw new InputError('Supply the current settings version and explicit on/off choices.');
  choice(value.source, new Set(['local', 'cloud', 'both']), 'Journal source');
  if (!Array.isArray(value.notebookIds) || value.notebookIds.length > 100 || value.notebookIds.some(id => !ID.test(id))) throw new InputError('Invalid notebook filter.');
  if (!Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 15 || value.intervalSeconds > 3600) throw new InputError('Choose a polling interval from 15 to 3600 seconds.');
  for (const field of ['accountId', 'authorizationId']) if (value[field] != null && !ID.test(value[field])) throw new InputError(`Invalid ${field}.`);
  return { ...value, section: text(value.section, 200, 'section filter', { blank: true }), instructions: text(value.instructions, 1000, 'custom instructions', { blank: true }) };
}
