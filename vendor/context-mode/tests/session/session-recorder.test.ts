import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "vitest";
import { SessionDB, resolveSessionDbPath } from "../../src/session/db.js";
import { createSessionRecorder } from "../../src/session/index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("public session recorder", () => {
  test("projects external events into the project session database", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "context-mode-recorder-project-"));
    const storageDir = mkdtempSync(join(tmpdir(), "context-mode-recorder-storage-"));
    cleanups.push(() => rmSync(projectDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(storageDir, { recursive: true, force: true }));

    const recorder = createSessionRecorder({
      projectDir,
      storageDir,
      source: "dsh",
    });
    recorder.ensureSession("dsh-session-1");
    recorder.append("dsh-session-1", {
      type: "user/message",
      category: "user",
      data: "keep this decision",
      priority: 3,
    }, "session/event");
    recorder.appendBatch("dsh-session-1", [
      {
        type: "tool/call",
        category: "tool",
        data: "ctx_execute",
        bytesAvoided: 1200,
      },
      {
        type: "tool/result",
        category: "tool",
        data: "ctx_execute:ok",
        bytesReturned: 48,
      },
    ], "session/event");
    recorder.close();

    const dbPath = resolveSessionDbPath({
      projectDir,
      sessionsDir: join(storageDir, "sessions"),
    });
    const db = new SessionDB({ dbPath });
    try {
      const stats = db.getSessionStats("dsh-session-1");
      assert.ok(stats);
      assert.equal(stats.project_dir, projectDir);
      assert.equal(stats.event_count, 3);

      const events = db.getEvents("dsh-session-1");
      assert.deepEqual(events.map(event => event.type), ["user/message", "tool/call", "tool/result"]);
      assert.equal(events[0]?.attribution_source, "dsh");
      assert.equal(events[1]?.bytes_avoided, 1200);
      assert.equal(events[2]?.bytes_returned, 48);
    } finally {
      db.close();
    }
  });
});
