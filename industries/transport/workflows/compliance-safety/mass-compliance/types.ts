// Shared shapes for the mass compliance workflow. The vehicle register is the only data this workflow holds.

export interface Settings {
  family: "general";
  business_name?: string;
  required_fields?: string[];   // vehicle fields a vehicle chart needs; a vehicle missing one gets a note queued
}

/** The vehicle fields the workflow reads from the register. Only these names may appear in settings or notes. */
export const VEHICLE_FIELDS = ["assetType", "type", "brand", "model", "serialNumber", "productionYear", "externalReference"] as const;
export type VehicleField = typeof VEHICLE_FIELDS[number];
export const DEFAULT_REQUIRED: VehicleField[] = ["type", "brand", "model", "serialNumber", "productionYear"];

export interface VehicleRecord {
  id: string; name: string;
  assetType?: string; type?: string; brand?: string; model?: string;
  serialNumber?: string; productionYear?: number; externalReference?: string;
}
