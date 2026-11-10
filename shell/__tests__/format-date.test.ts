import { formatDatePattern } from "@/lib/format-date";

describe("formatDatePattern", () => {
  it("formats the table patterns the way moment did", () => {
    const d = new Date(2026, 10, 9, 14, 5, 7);
    expect(formatDatePattern(d, "MMM dd yyyy")).toBe("Nov 09 2026");
    expect(formatDatePattern(d, "MMM d, yyyy")).toBe("Nov 9, 2026");
    expect(formatDatePattern(d, "yy-MM-dd")).toBe("26-11-09");
    expect(formatDatePattern(d, "yyyy-MM-dd HH:mm:ss")).toBe("2026-11-09 14:05:07");
    expect(formatDatePattern(d, "yyyy/MM/dd-HH:mm")).toBe("2026/11/09-14:05");
  });
  it("accepts a date string and a number", () => {
    expect(formatDatePattern(new Date(2026, 0, 2).toISOString(), "yyyy-MM-dd")).toBe("2026-01-02");
    expect(formatDatePattern(new Date(2026, 0, 2).getTime(), "yyyy-MM-dd")).toBe("2026-01-02");
  });
  it("never throws on a missing or invalid date", () => {
    expect(formatDatePattern(null, "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern(undefined, "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern("", "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern("not a date", "yyyy-MM-dd")).toBe("Invalid date");
  });
});
