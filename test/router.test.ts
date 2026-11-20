import { test, expect, describe } from "bun:test";
import { resolveMentions, resolveTargets } from "../src/router";
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
      lead,
      agents: [dev1, dev2, reviewer],
    },
    sourcePath: "/r/team.yaml",
    allAgents,
    agentById: new Map(allAgents.map((a) => [a.id, a])),
  };
}

describe("resolveTargets", () => {
  const cfg = makeConfig();

  test("single @handle resolves to that agent id", () => {
    expect(resolveTargets("@dev1 fix this", cfg)).toEqual(["dev1"]);
  });

  test("multiple mentions: deduped, first-occurrence order", () => {
    expect(resolveTargets("@dev2 @dev1 @dev2", cfg)).toEqual(["dev2", "dev1"]);
  });

  test("@lead resolves to lead id", () => {
    expect(resolveTargets("@lead status", cfg)).toEqual(["lead"]);
  });

  test("lead's custom handle and @lead both resolve to lead", () => {
    const cfg2 = makeConfig("@coordinator");
    expect(resolveTargets("@coordinator go", cfg2)).toEqual(["lead"]);
    expect(resolveTargets("@lead go", cfg2)).toEqual(["lead"]);
  });

  test("@all and @everyone target every agent", () => {
    const expected = ["lead", "dev1", "dev2", "reviewer"];
    expect(resolveTargets("@all go", cfg)).toEqual(expected);
    expect(resolveTargets("@everyone go", cfg)).toEqual(expected);
  });

  test("no mention -> lead", () => {
    expect(resolveTargets("just a status update", cfg)).toEqual(["lead"]);
    expect(resolveTargets("", cfg)).toEqual(["lead"]);
  });

  test("unknown @handle is reported and does not route to lead", () => {
    expect(resolveTargets("@nobody do x", cfg)).toEqual([]);
    expect(resolveMentions("@nobody do x", cfg)).toEqual({
      targets: [],
      unknownHandles: ["@nobody"],
      hadMention: true,
    });
  });

  test("known + unknown mention: known kept and unknown reported", () => {
    expect(resolveTargets("@dev1 @nobody", cfg)).toEqual(["dev1"]);
    expect(resolveMentions("@dev1 @nobody", cfg).unknownHandles).toEqual(["@nobody"]);
  });

  test("broadcast + specific mention dedupes", () => {
    expect(resolveTargets("@all @dev1", cfg)).toEqual(["lead", "dev1", "dev2", "reviewer"]);
  });

  test("mention adjacent to punctuation", () => {
    expect(resolveTargets("@dev1, please check.", cfg)).toEqual(["dev1"]);
  });
});
