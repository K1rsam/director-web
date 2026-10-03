type Part={kind:'SOURCE_SLICE'|'SOURCE_SEPARATOR';unitId:string;start:number;end:number};
export type InlinePerformance={version:'inline-performance-v1';spoken:{text:string;parts:Part[]};cues:Array<{text:string;parts:Part[];markerParts:Part[];spokenOffset:number}>};
export const INLINE_PERFORMANCE_VERSION:'inline-performance-v1';
export function inlinePerformanceProjection(source:string,parts:Part[]):InlinePerformance|null;
