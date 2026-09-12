import { FOUNDATION_REQUEST_BUDGET } from './project-foundation';

/** Plan with the exact serialized request, after lossless wire projection. Never drop episodes. */
export function planFoundationRequestScope(pending: readonly number[], requestChars: (scope: number[]) => number): number[] {
  if (!pending.length) return [];
  const fits = (scope: number[]) => requestChars(scope) + FOUNDATION_REQUEST_BUDGET.estimatedOutputChars <= FOUNDATION_REQUEST_BUDGET.totalChars;
  const all = [...pending];
  if (fits(all)) return all;
  let lower = 1, upper = all.length - 1, best = 0;
  while (lower <= upper) {
    const count = Math.floor((lower + upper) / 2);
    if (fits(all.slice(0, count))) { best = count; lower = count + 1; }
    else upper = count - 1;
  }
  // Keep an indivisible episode intact; the caller's preflight reports an explicit limit.
  return all.slice(0, Math.max(1, best));
}
