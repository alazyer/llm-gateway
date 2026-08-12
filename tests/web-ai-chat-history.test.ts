import { describe, expect, it } from "vitest";

import {
  composeMessagePages,
  composeSessionPages,
} from "../packages/web/composables/useGatewayApi";

interface Msg { messageId: string; content: string; }
interface Sess { sessionId: string; updatedAt: number; }

const msgKey = (m: Msg) => m.messageId;
const sessKey = (s: Sess) => s.sessionId;

describe("composeMessagePages", () => {
  it("replaces the timeline on initial load deterministically", () => {
    const page: Msg[] = [
      { messageId: "m1", content: "hi" },
      { messageId: "m2", content: "hello" },
    ];
    expect(composeMessagePages([], page, true, msgKey)).toEqual(page);
  });

  it("appends the next page in order without duplicating messages", () => {
    const existing: Msg[] = [
      { messageId: "m1", content: "hi" },
      { messageId: "m2", content: "hello" },
    ];
    const next: Msg[] = [
      { messageId: "m3", content: "how" },
      { messageId: "m4", content: "are you" },
    ];
    const merged = composeMessagePages(existing, next, false, msgKey);

    expect(merged.map((m) => m.messageId)).toEqual(["m1", "m2", "m3", "m4"]);
    // No duplicates.
    expect(new Set(merged.map((m) => m.messageId)).size).toBe(merged.length);
  });

  it("drops messages that already exist when reloading a page (no duplication across refresh)", () => {
    const existing: Msg[] = [
      { messageId: "m1", content: "hi" },
      { messageId: "m2", content: "hello" },
    ];
    // A reload returns an overlapping page (m2 again) plus a new one.
    const overlapping: Msg[] = [
      { messageId: "m2", content: "hello" },
      { messageId: "m3", content: "again" },
    ];
    const merged = composeMessagePages(existing, overlapping, false, msgKey);

    expect(merged.map((m) => m.messageId)).toEqual(["m1", "m2", "m3"]);
  });

  it("preserves chronological order across multiple pages (no skipping)", () => {
    const page1: Msg[] = [
      { messageId: "m1", content: "1" },
      { messageId: "m2", content: "2" },
    ];
    const page2: Msg[] = [
      { messageId: "m3", content: "3" },
      { messageId: "m4", content: "4" },
    ];
    const page3: Msg[] = [
      { messageId: "m5", content: "5" },
    ];

    let timeline = composeMessagePages([], page1, true, msgKey);
    timeline = composeMessagePages(timeline, page2, false, msgKey);
    timeline = composeMessagePages(timeline, page3, false, msgKey);

    expect(timeline.map((m) => m.messageId)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("dedupes within a single page on replace", () => {
    const page: Msg[] = [
      { messageId: "m1", content: "1" },
      { messageId: "m1", content: "1-dup" },
      { messageId: "m2", content: "2" },
    ];
    const merged = composeMessagePages([], page, true, msgKey);
    expect(merged.map((m) => m.messageId)).toEqual(["m1", "m2"]);
  });
});

describe("composeSessionPages", () => {
  it("replaces the session list on refresh", () => {
    const page: Sess[] = [
      { sessionId: "s1", updatedAt: 2 },
      { sessionId: "s2", updatedAt: 1 },
    ];
    expect(composeSessionPages([], page, true, sessKey)).toEqual(page);
  });

  it("appends older sessions via cursor without duplication", () => {
    const existing: Sess[] = [
      { sessionId: "s1", updatedAt: 3 },
      { sessionId: "s2", updatedAt: 2 },
    ];
    const next: Sess[] = [
      { sessionId: "s3", updatedAt: 1 },
    ];
    const merged = composeSessionPages(existing, next, false, sessKey);

    expect(merged.map((s) => s.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(new Set(merged.map((s) => s.sessionId)).size).toBe(merged.length);
  });

  it("drops overlapping sessions on load-more (no duplication)", () => {
    const existing: Sess[] = [
      { sessionId: "s1", updatedAt: 3 },
      { sessionId: "s2", updatedAt: 2 },
    ];
    const overlapping: Sess[] = [
      { sessionId: "s2", updatedAt: 2 },
      { sessionId: "s3", updatedAt: 1 },
    ];
    const merged = composeSessionPages(existing, overlapping, false, sessKey);

    expect(merged.map((s) => s.sessionId)).toEqual(["s1", "s2", "s3"]);
  });
});
