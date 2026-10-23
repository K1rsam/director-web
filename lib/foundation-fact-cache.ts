import { createHash } from 'node:crypto';
import { buildFoundationFacts } from './foundation-facts';
import { scriptPerformanceVersion } from './standard-script-reception';

/** Only mechanical facts are cached. Identity names and aliases are extraction dependencies. */
const cache = new Map<string, ReturnType<typeof buildFoundationFacts>>();
export function cachedFoundationFacts(...args: Parameters<typeof buildFoundationFacts>) {
  const [index, context, catalog, options] = args;
  const performanceVersion=scriptPerformanceVersion(options);
  const key = createHash('sha256').update(JSON.stringify([index.version, context.version,
    (catalog?.assets ?? []).map(a => [a.name, [...a.aliases].sort(), ...(options?.standard ? [a.type] : [])]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), options?.standard === true,
    options?.resolutions ? Object.entries(options.resolutions).map(([n,p])=>[n,p.plan,p.diagnostics,...(p.speakerDecisions===undefined?[]:[p.speakerDecisions])]) : null, options?.standard ? options.syntax??(options.postColonCue===false?'legacy':'current') : null,
    options?.standard?[options.inlinePerformance!==false,performanceVersion,options.sourceRegroupVersion??null]:null])).digest('hex');
  let facts = cache.get(key);
  if (!facts) {
    facts = buildFoundationFacts(...args);
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(key, facts);
  }
  return facts;
}
