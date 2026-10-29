import { describe, it, expect, vi, afterEach } from "vitest";
import { businessDate } from "./api";
afterEach(() => vi.useRealTimers());
describe("business dates", () => {
  it("uses location timezone rather than browser date at midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T15:01:00Z"));
    expect(businessDate("Asia/Tokyo")).toBe("2026-10-25");
    expect(businessDate("America/New_York")).toBe("2026-10-24");
  });
  it("handles DST boundaries without changing the calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T06:30:00Z"));
    expect(businessDate("America/New_York")).toBe("2026-11-01");
  });
});
