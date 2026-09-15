export const CONTRACT_VERSION:string;
export function createSource(text:string):{text:string;sourceVersion:string;coordinateSystem:string;length:number};
export function proposePlan(source:ReturnType<typeof createSource>,options?:{decisions?:unknown[]}):Record<string,unknown>;
export function validatePlan(source:unknown,plan:unknown,options?:{decisions?:unknown[]}):{ok:boolean;errors:{code:string;message:string}[];issues:unknown[];coverage:{length:number;covered:number}};
export function normalize(source:string|ReturnType<typeof createSource>,options?:{decisions?:unknown[];plan?:unknown}):unknown;
export function renderNormalized(source:unknown,plan:unknown,options?:{decisions?:unknown[]}):string;
