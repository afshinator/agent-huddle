import { test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoomLog } from "../src/room-log";

describe("createRoomLog", () => {
  test("every line reaches the terminal and the file, and the file's directory is created", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-room-log-"));
    try {
      const path = join(dir, "_run", "001-demo", "room.log");
      const seen: string[] = [];
      const log = createRoomLog(path, { write: (s) => seen.push(s) });

      log.write("── room demo ──\n");
      log.write("[@lead] DONE\n");

      expect(log.path).toBe(path);
      expect(seen.join("")).toBe("── room demo ──\n[@lead] DONE\n");
      expect(await readFile(path, "utf8")).toBe("── room demo ──\n[@lead] DONE\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unappendable transcript warns once on the terminal and keeps the room alive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-room-log-fail-"));
    try {
      // the transcript path is a directory: the room log can be created, but not appended to
      const path = join(dir, "room.log");
      await mkdir(path);
      const seen: string[] = [];
      const log = createRoomLog(path, { write: (s) => seen.push(s) });

      log.write("one\n");
      log.write("two\n");

      expect(seen.join("")).toContain("one\n");
      expect(seen.join("")).toContain("two\n");
      expect(seen.filter((s) => s.includes("[room-log]")).length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
