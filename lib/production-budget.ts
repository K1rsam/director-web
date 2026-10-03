import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import path from 'node:path';

export type ProductionBudgetContext = { id: string; directory: string };
type CallMetadata = { projectId: string; stage: string; provider: 'CLI' | 'API' | 'JEV'; model?: string; runId?: string; attemptId?: string };
const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));
const runtime = nativeRequire(path.join(process.cwd(), 'runtime/production-budget.mjs'));
const context = new AsyncLocalStorage<ProductionBudgetContext>();
export const productionBudgetRoot = path.resolve(process.env.DIRECTOR_PRODUCTION_BUDGET_DIR || path.join(process.cwd(), '.production-ledgers'));
export function currentProductionBudget(): ProductionBudgetContext | null {
  return context.getStore() ?? (process.env.DIRECTOR_PRODUCTION_BUDGET_ID
    ? { id: process.env.DIRECTOR_PRODUCTION_BUDGET_ID, directory: productionBudgetRoot } : null);
}
export function withProductionBudgetContext<T>(budget: ProductionBudgetContext, action: () => Promise<T>): Promise<T> {
  return context.run(budget, action);
}
export function productionBudgetStore(directory = productionBudgetRoot) {
  return runtime.createProductionBudgetStore(directory);
}
export async function budgetedProductionCall<T>(metadata: CallMetadata, action: () => Promise<T>): Promise<T> {
  const selected = currentProductionBudget();
  return runtime.withProductionBudget(selected ? { ...selected, ...metadata } : null, action);
}
