// Shared shapes for the file-notes workflow. Crons read Fireflies and write drafts into the workflow store only.
export type Platform = "fireflies";

export interface Settings {
  business_name?: string;
  adviser?: string;            // the adviser who checks and files each draft
  lookback_days?: number;      // how far back the intake cron looks for meetings (default 2)
  max_per_run?: number;        // meetings listed per intake run (default 20, max 50)
}

export interface Meeting {
  id: string; title: string; when: string; organizer?: string; attendees: string[];
  status: "new" | "drafted" | "skipped"; attempts: number; reason?: string;
}

export interface FileNote {
  meeting: string; title: string; when: string; body: string; status: "draft"; created: string;
}

export interface Transcript {
  id: string; title?: string | null; dateString?: string | null; organizer_email?: string | null;
  meeting_attendees?: ({ email?: string | null; name?: string | null } | null)[] | null;
  summary?: { overview?: string | null; action_items?: string | null; keywords?: string[] | null } | null;
  transcript_url?: string | null;
}
