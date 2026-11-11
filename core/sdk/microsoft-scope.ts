import { optional } from '../lib/secrets.ts';
import type { CallInput, Op } from './call.ts';

/** REST account boundaries are deployment configuration, including selectors nested in request objects. */
export function microsoftInput(op: Op, input: CallInput): CallInput {
  const account = optional('MSADS_ACCOUNT_ID');
  const customer = optional('MSADS_CUSTOMER_ID');
  if (!account || !customer || !/^\d+$/.test(account) || !/^\d+$/.test(customer)) throw new Error('microsoft-advertising: configure numeric MSADS_ACCOUNT_ID and MSADS_CUSTOMER_ID');
  if (input.body !== undefined && (!input.body || typeof input.body !== 'object' || Array.isArray(input.body))) throw new Error('microsoft-advertising: JSON body must be an object');
  const fields = new Set(op.params.filter(p => p.in === 'body').map(p => p.name));
  const body = { ...(input.body as Record<string, unknown> ?? {}), ...(input.params ?? {}) };
  for (const key of Object.keys(input.body as object ?? {})) if (!fields.has(key)) throw new Error(`microsoft-advertising: unknown body field ${key}`);
  for (const key of Object.keys(input.params ?? {})) if (!op.params.some(p => p.name === key)) throw new Error(`microsoft-advertising: unknown param ${key}`);
  // Reject conflicting values before normal params-over-body merging can hide them.
  const visited = new WeakSet<object>(); let count = 0;
  function walk(value: unknown, depth = 0): void {
    if (++count > 20000 || depth > 24) throw new Error('microsoft-advertising: request is too complex');
    if (!value || typeof value !== 'object') return;
    if (visited.has(value)) throw new Error('microsoft-advertising: cyclic request refused');
    visited.add(value);
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); }
    else for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[_-]/g, '').toLowerCase();
      const expected = /accountids?$/.test(normalized) ? account : /customerids?$/.test(normalized) ? customer : undefined;
      if (expected !== undefined) {
        const values = normalized.endsWith('ids') ? child : [child];
        if (!Array.isArray(values) || values.length === 0 || values.some(x => !['string','number'].includes(typeof x) || (typeof x === 'number' && !Number.isSafeInteger(x)) || String(x) !== expected)) throw new Error(`microsoft-advertising: ${key} must match the configured account or customer`);
      }
      if ((normalized === 'account' || normalized === 'customer') && child !== null && typeof child === 'object') throw new Error(`microsoft-advertising: nested ${key} object is not scoped`);
      if (/^(accountfilter|customernamefilter)$/.test(normalized) && child != null) throw new Error(`microsoft-advertising: unscoped ${key} is refused`);
      walk(child, depth + 1);
    }
    visited.delete(value);
  }
  walk(input.body); walk(input.params);
  const params = { ...(input.params ?? {}) };
  for (const field of ['AccountId', 'CustomerAccountId', 'CustomerId']) if (fields.has(field)) params[field] = field === 'CustomerId' ? customer : account;
  for (const p of op.params) if (p.required && body[p.name] == null && params[p.name] == null) throw new Error(`microsoft-advertising: missing required ${p.name}`);
  return { ...input, params };
}
