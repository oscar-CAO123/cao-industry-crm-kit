// One loop for every paged list, with a hard stop so a runaway cursor cannot spin forever.
// Stopping early throws instead of returning a short list, because a silently incomplete list
// is how the CRM once missed invoices past the first page.

export interface Page<T, C> { items: T[]; next: C | null }

export async function collect<T, C>(
  first: C,
  fetchPage: (cursor: C) => Promise<Page<T, C>>,
  opts: { maxPages?: number; limit?: number } = {},
): Promise<T[]> {
  const maxPages = opts.maxPages ?? 200;
  const out: T[] = [];
  let cursor: C | null = first;
  for (let n = 0; cursor !== null; n++) {
    if (n >= maxPages) throw new Error(`stopped at ${maxPages} pages; the list is incomplete`);
    const page: Page<T, C> = await fetchPage(cursor);
    out.push(...page.items);
    if (opts.limit && out.length >= opts.limit) return out.slice(0, opts.limit);
    cursor = page.next;
  }
  return out;
}
