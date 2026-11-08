// Settings for the tabs and room charges workflow. Only the property number is read by the crons.
export interface Settings {
  property_id: number;   // Cloudbeds property (sent as the X-Property-ID header)
  business_name?: string;
  timezone?: string;
}
