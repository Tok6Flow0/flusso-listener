import { createHash } from 'node:crypto';
import { DEFAULT_RISK } from './schema.mjs';

// An order ticket is a fenced ```flusso-orders block in a Journal entry. Its
// orders use Flusso's existing manual order element exactly, so the listener
// forwards them to submitManualFuturesLimitOrder without inventing a format.
export const TICKET_FENCE = 'flusso-orders';
export const MAX_TICKET_ORDERS = 20;
const TICKET_KEYS = new Set(['id', 'together', 'orders']);
const ORDER_KEYS = new Set(['instrumentId', 'side', 'quantity', 'limitPrice', 'conditions']);
const CONDITION_KEYS = new Set(['maxSlippagePct', 'maxNotionalUsd', 'minVolume24hUsd', 'maxLeverage']);
const INSTRUMENT = /^[a-z0-9][a-z0-9._-]*:.+$/;
const TICKET_ID = /^[!-~]{1,160}$/;
const TOGETHER_LEAD_MS = 3000;

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
const review = (reason, reasonCode) => ({ eligible: false, reason, reasonCode });

/** Returns null when the entry has no ticket; otherwise the parsed ticket or a reason it cannot run. */
export function readTicket(body) {
  if (typeof body !== 'string') return null;
  body = body.replaceAll('\r\n', '\n');
  const blocks = [];
  const fence = /^(```|~~~)[ \t]*flusso-orders[ \t]*\n([\s\S]*?)^\1[ \t]*$/gm;
  for (let match = fence.exec(body); match; match = fence.exec(body)) blocks.push(match[2]);
  if (!blocks.length) return null;
  if (blocks.length > 1) return { error: 'This entry has more than one order ticket. Keep one ticket per entry.' };
  let ticket;
  try { ticket = JSON.parse(blocks[0]); } catch { return { error: 'The order ticket is not valid JSON.' }; }
  if (!plain(ticket) || Object.keys(ticket).some((key) => !TICKET_KEYS.has(key))) return { error: 'The order ticket has unsupported fields. Use id, together and orders.' };
  if (typeof ticket.id !== 'string' || !TICKET_ID.test(ticket.id)) return { error: 'The ticket id must be 1–160 printable characters without spaces.' };
  if (ticket.together !== undefined && typeof ticket.together !== 'boolean') return { error: 'together must be true or false.' };
  if (!Array.isArray(ticket.orders) || ticket.orders.length < 1 || ticket.orders.length > MAX_TICKET_ORDERS) return { error: `A ticket needs 1–${MAX_TICKET_ORDERS} orders.` };
  for (const [index, order] of ticket.orders.entries()) {
    const at = `Order ${index + 1}`;
    if (!plain(order) || Object.keys(order).some((key) => !ORDER_KEYS.has(key))) return { error: `${at} has unsupported fields. Use instrumentId, side, quantity, limitPrice and conditions.` };
    if (typeof order.instrumentId !== 'string' || order.instrumentId.length < 3 || order.instrumentId.length > 256 || !INSTRUMENT.test(order.instrumentId)) return { error: `${at} needs an exact venue:instrument id from Flusso market facts.` };
    if (!['buy', 'sell'].includes(order.side)) return { error: `${at} side must be buy or sell.` };
    if (!positive(order.quantity)) return { error: `${at} needs a positive quantity in venue contracts.` };
    if (!positive(order.limitPrice)) return { error: `${at} needs a positive limit price.` };
    if (order.conditions !== undefined) {
      if (!plain(order.conditions) || !Object.keys(order.conditions).length || Object.keys(order.conditions).some((key) => !CONDITION_KEYS.has(key))) return { error: `${at} conditions support maxSlippagePct, maxNotionalUsd, minVolume24hUsd and maxLeverage.` };
      if (Object.values(order.conditions).some((value) => !positive(value)) || order.conditions.maxSlippagePct > 100 || order.conditions.maxLeverage < 1) return { error: `${at} conditions must be positive numbers; slippage is at most 100%.` };
    }
  }
  return { ticket };
}

// These are permission ceilings, not a local valuation of any contract. Allocate
// whole cents downward so every order may use its cap without exceeding the ticket.
function perOrderCap(orders, risk) {
  let cap = positive(risk.maxOrderUsd) ? risk.maxOrderUsd : Infinity;
  if (positive(risk.maxTicketUsd)) {
    const cents = Math.floor(risk.maxTicketUsd * 100);
    if (!Number.isSafeInteger(cents)) return 0;
    let each = Math.floor(cents / orders.length);
    if ((each / 100) * orders.length > risk.maxTicketUsd) each -= 1;
    cap = Math.min(cap, each / 100);
  }
  return cap;
}

/** Applies the owner's risk settings. A condition can only be tightened, never loosened. */
export function applyRisk(orders, risk = DEFAULT_RISK) {
  return orders.map(({ conditions = {}, ...order }) => {
    const next = { ...conditions };
    if (positive(risk.maxSlippagePct)) next.maxSlippagePct = Math.min(next.maxSlippagePct ?? Infinity, risk.maxSlippagePct);
    const notionalCap = perOrderCap(orders, risk);
    if (Number.isFinite(notionalCap)) next.maxNotionalUsd = Math.min(next.maxNotionalUsd ?? Infinity, notionalCap);
    if (positive(risk.maxLeverage)) next.maxLeverage = Math.min(next.maxLeverage ?? Infinity, risk.maxLeverage);
    if (positive(risk.minVolume24hUsd)) next.minVolume24hUsd = Math.max(next.minVolume24hUsd ?? 0, risk.minVolume24hUsd);
    return Object.keys(next).length ? { ...order, conditions: next } : { ...order };
  });
}

/** Notes select data only. Flusso still checks ownership, plan, risk and venue terms. */
export function buildOrderRequest({ entry, settings, now = Date.now() }) {
  const parsed = readTicket(entry?.body);
  if (!parsed) return null;
  if (parsed.error) return review(parsed.error, 'malformed_ticket');
  if (entry.status !== 'watching') return review('Set the entry to watching to place its ticket.', 'inactive_ticket');
  const maximumAge = settings.maxSignalAgeSeconds ?? 900;
  const written = Date.parse(entry.updatedAtUtc ?? entry.createdAtUtc);
  if (!Number.isFinite(written) || written > now + 60000 || now - written > maximumAge * 1000) return review('This ticket is older than your signal age limit, so it was not placed.', 'stale_ticket');
  const { ticket } = parsed;
  const risk = settings.risk ?? DEFAULT_RISK;
  if (!positive(risk.maxOrderUsd) || !positive(risk.maxTicketUsd) || !positive(risk.maxLeverage) || risk.maxLeverage < 1) return review('Choose explicit maximum order, ticket notional and leverage limits before execution.', 'missing_risk_limits');
  if (perOrderCap(ticket.orders, risk) < 0.01) return review('The ticket ceiling cannot allocate at least one cent to each order.', 'ticket_ceiling_too_small');
  const orders = applyRisk(ticket.orders, risk);
  if ((ticket.together ?? settings.risk?.together ?? true) && orders.length > 1) {
    const placeAtUtc = new Date(now + TOGETHER_LEAD_MS).toISOString();
    for (const order of orders) order.placeAtUtc = placeAtUtc;
  }
  // The explicit immutable ticket id is shared by edits and local/cloud copies.
  // Quantity, price, conditions and refreshed clocks cannot create another dispatch.
  const signalIdentity = createHash('sha256').update(JSON.stringify({ schemaVersion: 'flusso.listener_ticket.v1', id: ticket.id })).digest('hex');
  return { eligible: true, ticketId: ticket.id ?? null, orders, signalIdentity };
}

// The listener notes each decision on the ticket's own Journal entry, so the
// author (you or your agent) can see what happened without opening the app.
export const RESULT_HEADING = '## Listener result';
const RESULT_TITLE = { submitted: 'Placed', partial: 'Partly placed', blocked: 'Refused', review: 'Not placed' };
const LINE_STATUS = { submitted: 'sent', blocked: 'refused', unknown: 'unconfirmed', not_sent: 'not sent' };
const BODY_LIMIT = 20000;

/** Replaces any earlier listener result at the end of the body with this one. */
export function withResult(body, { status, reason = null, lines = [], atUtc }) {
  const text = typeof body === 'string' ? body : '';
  const previous = text.lastIndexOf(`\n${RESULT_HEADING}\n`);
  const base = (previous >= 0 ? text.slice(0, previous) : text.startsWith(`${RESULT_HEADING}\n`) ? '' : text).trimEnd();
  const when = `${new Date(atUtc).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const head = [RESULT_HEADING, '', `**${RESULT_TITLE[status] ?? 'Result'}** · ${when}`];
  if (reason) head.push('', String(reason).replace(/\s+/g, ' ').trim().slice(0, 500));
  const foot = ['', 'Noted by Flusso Journal. Sent is not filled.'];
  const rows = lines.map(line => `- ${line.side} ${line.instrumentId} ${line.quantity} @ ${line.limitPrice}: ${LINE_STATUS[line.status] ?? line.status}${line.message ? ` (${String(line.message).replace(/\s+/g, ' ').trim().slice(0, 200)})` : ''}`);
  const compose = list => `${base}${base ? '\n\n' : ''}${[...head, ...(list.length ? ['', ...list] : []), ...foot].join('\n')}\n`;
  let result = compose(rows);
  for (let keep = rows.length - 1; result.length > BODY_LIMIT && keep >= 0; keep -= 1) result = compose([...rows.slice(0, keep), `- ${rows.length - keep} more orders, see Activity`]);
  return result.length > BODY_LIMIT ? null : result;
}
