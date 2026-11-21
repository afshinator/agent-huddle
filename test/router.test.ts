import { test, expect, describe } from "bun:test";
import { resolveMentions, extractMentions } from "../src/router";
import type { LoadedConfig } from "../src/config";

function makeConfig(leadHandle = "@lead"): LoadedConfig {
  const lead = { id: "lead", handle: leadHandle, role: "lead" };
  const dev1 = { id: "dev1", handle: "@dev1", role: "dev" };
  const dev2 = { id: "dev2", handle: "@dev2", role: "dev" };
  const reviewer = { id: "reviewer", handle: "@reviewer", role: "review" };
  const allAgents = [lead, dev1, dev2, reviewer];
  return {
    config: {
      name: "r",
      room_dir: "/r",
      max_hops: 12,
      turn_timeout_ms: 300_000,
      ack_scope: "lead",
    dispatch_scope: "anyone",
      lead,
      agents: [dev1, dev2, reviewer],
    },
    sourcePath: "/r/team.yaml",
    allAgents,
    agentById: new Map(allAgents.map((a) => [a.id, a])),
  };
}

describe("extractMentions", () => {
  const cfg = makeConfig();

  test("single @handle resolves to that agent id", () => {
    expect(extractMentions("@dev1 fix this", cfg)).toEqual(["dev1"]);
  });

  test("multiple mentions: deduped, first-occurrence order", () => {
    expect(extractMentions("@dev2 @dev1 @dev2", cfg)).toEqual(["dev2", "dev1"]);
  });

  test("@lead resolves to lead id", () => {
    expect(extractMentions("@lead status", cfg)).toEqual(["lead"]);
  });

  test("lead's custom handle and @lead both resolve to lead", () => {
    const cfg2 = makeConfig("@coordinator");
    expect(extractMentions("@coordinator go", cfg2)).toEqual(["lead"]);
    expect(extractMentions("@lead go", cfg2)).toEqual(["lead"]);
  });

  test("@all and @everyone target every agent", () => {
    const expected = ["lead", "dev1", "dev2", "reviewer"];
    expect(extractMentions("@all go", cfg)).toEqual(expected);
    expect(extractMentions("@everyone go", cfg)).toEqual(expected);
  });

  test("no mention targets nobody (D6)", () => {
    expect(extractMentions("just a status update", cfg)).toEqual([]);
    expect(extractMentions("", cfg)).toEqual([]);
  });

  test("unknown @handle is reported and targets nobody", () => {
    expect(extractMentions("@nobody do x", cfg)).toEqual([]);
    expect(resolveMentions("@nobody do x", cfg)).toEqual({
      targets: [],
      unknownHandles: ["@nobody"],
    });
  });

  test("known + unknown mention: known kept and unknown reported", () => {
    expect(extractMentions("@dev1 @nobody", cfg)).toEqual(["dev1"]);
    expect(resolveMentions("@dev1 @nobody", cfg).unknownHandles).toEqual(["@nobody"]);
  });

  test("broadcast + specific mention dedupes", () => {
    expect(extractMentions("@all @dev1", cfg)).toEqual(["lead", "dev1", "dev2", "reviewer"]);
  });

  test("a scoped package name is not a mention", () => {
    // `@testing-library/react` reads as `@testing-library` to the handle grammar, so a ticket room
    // printed "unknown agent mention(s): @testing-library" three times in one run (#79).
    expect(resolveMentions("check @testing-library/react and @types/node", cfg)).toEqual({
      targets: [],
      unknownHandles: [],
    });
    expect(extractMentions("@testing-library/react", cfg)).toEqual([]);
  });

  test("an email address is not a mention", () => {
    expect(resolveMentions("write to dev1@example.com", cfg).unknownHandles).toEqual([]);
  });

  test("mention adjacent to punctuation", () => {
    expect(extractMentions("@dev1, please check.", cfg)).toEqual(["dev1"]);
  });
});
