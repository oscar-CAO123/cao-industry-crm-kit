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
  // Reject conflicting values before normal params-over-body merging can hide them, then check the merged request too,
  // so a selector split between body and params (EntityType in one, EntityIds in the other) is still paired.
  const visited = new WeakSet<object>(); let count = 0;
  const norm = (key: string) => key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  function walk(value: unknown, depth = 0, inheritedType = ''): void {
    if (++count > 20000 || depth > 24) throw new Error('microsoft-advertising: request is too complex');
    if (!value || typeof value !== 'object') return;
    if (visited.has(value)) throw new Error('microsoft-advertising: cyclic request refused');
    visited.add(value);
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1, inheritedType); }
    else {
    // EntityType names what EntityId(s) and a parent ID point at, here and in every object below it (Microsoft Learn:
    // GetLabelAssociationsByEntityIds, GetNegativeKeywordsByEntityIds, where a campaign's parent is its account).
    const typeKey = Object.keys(value).find(k => norm(k) === 'entitytype');
    let entityType = inheritedType;
    if (typeKey !== undefined) {
      const t = (value as Record<string, unknown>)[typeKey];
      if (t != null && typeof t !== 'string') throw new Error(`microsoft-advertising: ${typeKey} must be text`);
      if (typeof t === 'string') entityType = t.replace(/[^A-Za-z]/g, '').toLowerCase();
    }
    for (const [key, child] of Object.entries(value)) {
      const normalized = norm(key);
      // EntityScope is Account or Customer; Customer reaches every account under the manager account. Only the exact
      // text Account passes (a report's Scope is an object of account IDs and is walked instead).
      const reportScope = op.id === 'reporting.SubmitGenerateReport' && normalized === 'scope' && child !== null && typeof child === 'object' && !Array.isArray(child);
      if (normalized.endsWith('scope') && child != null && !reportScope && child !== 'Account')
        throw new Error(`microsoft-advertising: ${key} must be Account; customer-wide scope is refused`);
      const pointsAt = (normalized === 'entityids' || normalized === 'entityid') && (entityType === 'account' || entityType === 'customer') ? entityType
        : (normalized === 'parententityid' || normalized === 'parentid') && entityType === 'campaign' ? 'account' : '';
      if (pointsAt) {
        const want = pointsAt === 'account' ? account : customer;
        const values = Array.isArray(child) ? child : [child];
        if (values.length === 0 || values.some(x => !['string','number'].includes(typeof x) || String(x) !== want)) throw new Error(`microsoft-advertising: ${key} must match the configured ${pointsAt}`);
      }
      const expected = /accountids?$/.test(normalized) ? account : /customerids?$/.test(normalized) ? customer : undefined;
      if (expected !== undefined) {
        const values = normalized.endsWith('ids') ? child : [child];
        if (!Array.isArray(values) || values.length === 0 || values.some(x => !['string','number'].includes(typeof x) || (typeof x === 'number' && !Number.isSafeInteger(x)) || String(x) !== expected)) throw new Error(`microsoft-advertising: ${key} must match the configured account or customer`);
      }
      if ((normalized === 'account' || normalized === 'customer') && child !== null && typeof child === 'object') throw new Error(`microsoft-advertising: nested ${key} object is not scoped`);
      if (/^(accountfilter|customernamefilter)$/.test(normalized) && child != null) throw new Error(`microsoft-advertising: unscoped ${key} is refused`);
      // Import ID mappings name their source IDs in SourceEntityIds and SourceParentId, which the rules above do not read;
      // an Account or Customer mapping could point past the configured account, so only entities below it are mapped.
      if (normalized === 'importentitytype' && child != null) {
        if (typeof child !== 'string') throw new Error(`microsoft-advertising: ${key} must be text`);
        if (/^(account|customer)$/.test(child.replace(/[^A-Za-z]/g, '').toLowerCase())) throw new Error(`microsoft-advertising: ${key} ${child} is refused; import mappings stay inside the configured account`);
      }
      walk(child, depth + 1, entityType);
    }
    }
    visited.delete(value);
  }
  walk(input.body); count = 0; walk(input.params); count = 0; walk(body);
  // A report without account IDs in its scope could cover every account the user can see.
  if (op.id === 'reporting.SubmitGenerateReport') {
    const ids = (body as { ReportRequest?: { Scope?: { AccountIds?: unknown } } }).ReportRequest?.Scope?.AccountIds;
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('microsoft-advertising: a report request must name the configured account in ReportRequest.Scope.AccountIds');
  }
  const params = { ...(input.params ?? {}) };
  for (const field of ['AccountId', 'CustomerAccountId', 'CustomerId']) if (fields.has(field)) params[field] = field === 'CustomerId' ? customer : account;
  for (const p of op.params) if (p.required && body[p.name] == null && params[p.name] == null) throw new Error(`microsoft-advertising: missing required ${p.name}`);
  return { ...input, params };
}
