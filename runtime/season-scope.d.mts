export const SEASON_SCOPE_VERSION:'series-season-scope-v1';
export const SEASON_HANDOFF_VERSION:'series-season-handoff-v1';
export function seasonHash(value:unknown):string;
export function seasonEstimate(timeline:any[]):{minSeconds:number;maxSeconds:number};
export function validateSeasonScope(scope:any,basis:any,options?:{production?:boolean}):any;
export function assertSeasonEpisodes(scope:any,numbers:number[],consumer?:string):void;
export function assertSeasonBinding(scope:any,binding:any,numbers:number[]):void;
export function seasonAssetAllowed(scope:any,asset:any,basis?:any):boolean;
export function seasonDelivery(scope:any,basis:any,runs:any[],mode?:string):any;
export function bindSeasonSource(source:any,episode:any):any;
export function seasonCalibration(scope:any,basis:any,runs:any[]):any;

export function seasonDurationException(scope:any):boolean;
