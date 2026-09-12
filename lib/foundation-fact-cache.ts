import { createHash } from 'node:crypto';
import { buildFoundationFacts } from './foundation-facts';

/** Only mechanical facts are cached. Identity names and aliases are extraction dependencies. */
const cache = new Map<string, ReturnType<typeof buildFoundationFacts>>();
export function cachedFoundationFacts(...args: Parameters<typeof buildFoundationFacts>) {
  const [index, context, catalog] = args;
  const key = createHash('sha256').update(JSON.stringify([index.version, context.version,
    (catalog?.assets ?? []).map(a => [a.name, [...a.aliases].sort()]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])).digest('hex');
  let facts = cache.get(key);
  if (!facts) {
    facts = buildFoundationFacts(...args);
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(key, facts);
  }
  return facts;
}
