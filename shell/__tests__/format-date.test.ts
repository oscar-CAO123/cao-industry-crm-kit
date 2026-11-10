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
  it("reads a bare date as that calendar day in the local zone", () => {
    expect(formatDatePattern("2026-01-02", "yyyy-MM-dd")).toBe("2026-01-02");
    expect(formatDatePattern("2026-01-02", "MMM dd yyyy")).toBe("Jan 02 2026");
    expect(formatDatePattern("2026-13-45", "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern("2026-02-30", "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern("2024-02-29", "yyyy-MM-dd")).toBe("2024-02-29");
    expect(formatDatePattern("0050-01-01", "yyyy-MM-dd")).toBe("0050-01-01");
  });
  it("never throws on a missing or invalid date", () => {
    expect(formatDatePattern(null, "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern(undefined, "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern("", "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern("not a date", "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern(Symbol("x"), "yyyy-MM-dd")).toBe("Invalid date");
    expect(formatDatePattern(BigInt(5), "yyyy-MM-dd")).toBe("Invalid date");
  });
});
