export const RUNTIME_MAINTENANCE_VERSION:'runtime-maintenance-v1';
export function loadRuntimeMaintenanceHost():Promise<any>;
export function runtimeMaintenanceState(dataRoot:string):any;
export function assertRuntimeAdmission(dataRoot:string):void;
export function runtimeMaintenanceBridgeVersion():'runtime-maintenance-v1'|null;
