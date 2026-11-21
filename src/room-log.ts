import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { errorMessage } from "./errors";

/**
 * The room's human-readable transcript (#59).
 *
 * `messages.jsonl` is the machine record and stays that way; this is the same lines the
 * pane shows, on disk, so closing the pane does not lose the run. Written from the
 * composition root because the coordinator has no business knowing about files.
 */
export interface RoomLog {
  path: string;
  write(s: string): void;
}

export function createRoomLog(path: string, terminal: { write(s: string): void } = process.stdout): RoomLog {
  mkdirSync(dirname(path), { recursive: true });
  let warned = false;
  return {
    path,
    write(s: string) {
      terminal.write(s);
      try {
        appendFileSync(path, s, "utf8");
      } catch (e) {
        // A transcript that cannot be written must not end the room, and must not be
        // silent either: one line on the terminal, once.
        if (warned) return;
        warned = true;
        terminal.write(`[room-log] cannot append to ${path}: ${errorMessage(e)}\n`);
      }
    },
  };
}
