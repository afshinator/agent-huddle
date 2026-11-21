import { test, expect, describe } from "bun:test";
import { formatRunName, nextRunName } from "../src/run-slug";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A run directory has to say when it was created, from `ls` alone — so its name starts with
 * a zero-padded ordinal and the name the human gave it.
 */
describe("formatRunName", () => {
  test("the first run is 001", () => {
    expect(formatRunName([], "docs-audit")).toBe("001-docs-audit");
  });

  test("the next run takes the highest number plus one, not the first gap", () => {
    // A gap means a run was deleted; reusing its number would reorder history.
    expect(formatRunName(["001-a", "003-b"], "c")).toBe("004-c");
  });

  test("a requested name that already carries a number is reused, not renumbered", () => {
    expect(formatRunName(["001-a", "002-b"], "002-b")).toBe("002-b");
    // numbered but absent: strip the number and take the next free ordinal
    expect(formatRunName(["001-a"], "007-b")).toBe("002-b");
  });

  test("a bare name an existing run carries is a rerun, so it reuses that directory", () => {
    expect(formatRunName(["001-first", "002-second"], "second")).toBe("002-second");
    // still create a new run when the name is new
    expect(formatRunName(["001-first"], "second")).toBe("002-second");
  });

  test("a rerun reuses the earliest directory even when the listing is unsorted", () => {
    // readdir order is arbitrary; the first match in that order is often the newest run
    expect(formatRunName(["004-second", "003-third", "001-first", "002-second"], "second")).toBe(
      "002-second",
    );
  });

  test("directories without an ordinal are ignored when counting", () => {
    expect(formatRunName(["notes", "foo-bar", "002-b"], "c")).toBe("003-c");
  });

  test("the ordinal is three digits and keeps counting past 999", () => {
    expect(formatRunName(["009-a"], "b")).toBe("010-b");
    expect(formatRunName(["999-a"], "b")).toBe("1000-b");
  });
});

describe("nextRunName", () => {
  test("reads the run root and returns the name to use", async () => {
    const root = await mkdtemp(join(tmpdir(), "ah-slug-"));
    try {
      await mkdir(join(root, "001-first"));
      await mkdir(join(root, "002-second"));
      await mkdir(join(root, "notes"));
      expect(await nextRunName(root, "third")).toBe("003-third");
      // a missing root is the state before the first run
      expect(await nextRunName(join(root, "absent"), "first")).toBe("001-first");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
