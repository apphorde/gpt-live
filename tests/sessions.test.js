import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../app/sessions.js";

test("processes chunks in order and replays identified events", async () => {
  const manager = new SessionManager({
    transcribe: async (chunk) => chunk.toString(),
  });
  const session = manager.create("alice");
  const first = manager.append(session, Buffer.from("first"));
  const last = manager.append(session, Buffer.from("last"), { final: true });
  await Promise.all([first, last]);
  assert.equal(session.text, "first last");
  assert.equal(session.closed, true);
  const events = manager.subscribe(session, 1).replay;
  assert.deepEqual(
    events.map(({ id, type }) => [id, type]),
    [
      [2, "transcript"],
      [3, "transcript"],
      [4, "final"],
    ],
  );
});

test("isolates ownership and enforces closed/size constraints", async () => {
  const manager = new SessionManager();
  const session = manager.create("alice");
  assert.throws(() => manager.get(session.id, "bob"), { status: 404 });
  assert.throws(() => manager.append(session, Buffer.alloc(2_000_001)), {
    status: 413,
  });
  await manager.append(session, Buffer.from("done"), { final: true });
  assert.throws(() => manager.append(session, Buffer.from("extra")), {
    status: 409,
  });
});

test("reports transcription errors while keeping queue rejection observable", async () => {
  const manager = new SessionManager({
    transcribe: async () => {
      throw new Error("private detail");
    },
  });
  const session = manager.create("alice");
  await assert.rejects(manager.append(session, Buffer.from("chunk")));
  assert.equal(session.history.at(-1).type, "error");
  assert.equal(session.history.at(-1).message, "Transcription failed");
});
