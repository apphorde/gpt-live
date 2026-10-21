import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export const LIMITS = Object.freeze({
  chunkBytes: Number(process.env.MAX_CHUNK_BYTES ?? 2_000_000),
  sessionBytes: Number(process.env.MAX_SESSION_BYTES ?? 20_000_000),
  sessions: Number(process.env.MAX_SESSIONS ?? 100),
  chunkSeconds: Number(process.env.MAX_CHUNK_SECONDS ?? 30),
  idleMs: Number(process.env.SESSION_IDLE_MS ?? 300_000),
});

export class SessionManager {
  constructor({ transcribe = async () => "" } = {}) {
    this.transcribe = transcribe;
    this.sessions = new Map();
  }

  create(owner) {
    this.sweep();
    if (this.sessions.size >= LIMITS.sessions) {
      throw Object.assign(new Error("Session capacity reached"), {
        status: 429,
      });
    }
    const session = {
      id: randomUUID(),
      owner,
      events: new EventEmitter(),
      history: [],
      nextId: 0,
      chain: Promise.resolve(),
      closed: false,
      bytes: 0,
      text: "",
      lastActive: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.publish(session, { type: "session", sessionId: session.id });
    return session;
  }

  publish(session, event) {
    const item = { id: ++session.nextId, ...event };
    session.history.push(item);
    if (session.history.length > 500) {
      session.history.shift();
    }
    session.events.emit("event", item);
  }

  get(id, owner) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) {
      throw Object.assign(new Error("Session not found"), { status: 404 });
    }
    session.lastActive = Date.now();
    return session;
  }

  append(session, buffer, { final = false, duration = 0 } = {}) {
    if (session.closed) {
      throw Object.assign(new Error("Session is closed"), { status: 409 });
    }
    if (
      !Buffer.isBuffer(buffer) ||
      buffer.length === 0 ||
      buffer.length > LIMITS.chunkBytes
    ) {
      throw Object.assign(new Error("Invalid audio chunk size"), {
        status: 413,
      });
    }
    if (session.bytes + buffer.length > LIMITS.sessionBytes) {
      throw Object.assign(new Error("Session audio limit reached"), {
        status: 413,
      });
    }
    if (
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > LIMITS.chunkSeconds
    ) {
      throw Object.assign(new Error("Invalid chunk duration"), { status: 400 });
    }
    session.bytes += buffer.length;
    session.lastActive = Date.now();
    const chunk = Buffer.from(buffer);
    const operation = session.chain
      .catch(() => {})
      .then(async () => {
        if (session.closed) {
          throw Object.assign(new Error("Session is closed"), { status: 409 });
        }
        const text = String(
          await this.transcribe(chunk, { sessionId: session.id }),
        ).trim();
        if (text) {
          session.text = `${session.text}${session.text ? " " : ""}${text}`;
          this.publish(session, {
            type: "transcript",
            sessionId: session.id,
            text,
            partial: !final,
          });
        }
        if (final) {
          session.closed = true;
          this.publish(session, {
            type: "final",
            sessionId: session.id,
            text: session.text,
          });
        }
      });
    session.chain = operation.catch((error) => {
      this.publish(session, {
        type: "error",
        sessionId: session.id,
        message: "Transcription failed",
      });
      throw error;
    });
    return session.chain;
  }

  subscribe(session, lastEventId = 0) {
    const id = Number(lastEventId);
    if (!Number.isSafeInteger(id) || id < 0) {
      throw Object.assign(new Error("Invalid Last-Event-ID"), { status: 400 });
    }
    return {
      replay: session.history.filter((event) => event.id > id),
      events: session.events,
    };
  }

  sweep(now = Date.now()) {
    for (const [id, session] of this.sessions) {
      if (now - session.lastActive > LIMITS.idleMs) {
        this.sessions.delete(id);
      }
    }
  }
}
