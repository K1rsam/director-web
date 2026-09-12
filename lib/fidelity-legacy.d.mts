export function validatePlan(source: unknown, plan: unknown, options?: { decisions?: unknown[] }): {ok: boolean; errors: {code:string;message:string}[]};
export function proposePlan(source: unknown, options?: {decisions?: unknown[]}): {segments:{speakerLabels:string[]}[];[key:string]:unknown};
