// Shared shapes for the fleet service planner. Trackunit is the only platform here with mapped operations.
export type Platform = "trackunit";

export interface Settings {
  business_name?: string;
  assets: string[];                               // Trackunit asset ids for the vehicles this business plans for
  system_of_measurement?: "metric" | "imperial";  // sent as the systemOfMeasurement header when set
}

export type ServiceStatus = "OVERDUE" | "UPCOMING" | "PLANNED" | "UNKNOWN";
export interface PlannedService { plannedServiceId: string; servicePlanId: string; status: ServiceStatus }

/** One vehicle's snapshot, written by the status cron and read by the plan cron's log. */
export interface FleetRecord {
  asset: string;
  checked: string;
  due: PlannedService[];
  open_issues: number;
}

/** What the plan cron drafted for one vehicle, and the approvals it queued (a re-run returns the same ids). */
export interface PlanRecord {
  asset: string;
  drafted: string;
  due: string[];
  approvals: string[];
}
