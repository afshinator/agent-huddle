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

  test("colour reaches the terminal but never the transcript file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-room-log-color-"));
    try {
      const path = join(dir, "room.log");
      const seen: string[] = [];
      const log = createRoomLog(path, { write: (s) => seen.push(s) });

      log.write("\u001b[38;2;230;170;80m[@lead]\u001b[0m \u001b[38;2;90;170;255m@dev1\u001b[0m go\n");

      // the pane keeps the colour, the file stays greppable
      expect(seen.join("")).toContain("\u001b[38;2;90;170;255m@dev1");
      expect(await readFile(path, "utf8")).toBe("[@lead] @dev1 go\n");
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
