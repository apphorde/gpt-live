import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Issuer } from "openid-client";
import { SessionManager } from "./sessions.js";

const port = Number(process.env.PORT ?? 3000);
const issuerUrl = process.env.OIDC_ISSUER;
const clientId = process.env.OIDC_CLIENT_ID;
const clientSecret = process.env.OIDC_CLIENT_SECRET;
const sessionSecret = process.env.SESSION_SECRET;
if (!issuerUrl || !clientId || !clientSecret) {
  throw new Error(
    "OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET are required",
  );
}
if (!sessionSecret) {
  throw new Error("SESSION_SECRET is required");
}
const issuer = await Issuer.discover(issuerUrl);
const redirectUri =
  process.env.OIDC_REDIRECT_URI ?? `http://localhost:${port}/oidc/callback`;
const oidc = new issuer.Client({
  client_id: clientId,
  client_secret: clientSecret,
  redirect_uris: [redirectUri],
  response_types: ["code"],
});
const sessions = new SessionManager({ transcribe: createTranscriber() });
const states = new Map();

function createTranscriber() {
  const backend = process.env.TRANSCRIBER ?? "whisper.cpp";
  const endpoint = process.env.WHISPER_URL ?? "http://whisper:8080/inference";
  return async (audio) => {
    if (backend !== "whisper.cpp") {
      throw new Error(`Unsupported transcriber: ${backend}`);
    }
    const wav = await new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "wav",
        "pipe:1",
      ]);
      const output = [];
      ffmpeg.stdout.on("data", (chunk) => output.push(chunk));
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) =>
        code === 0
          ? resolve(Buffer.concat(output))
          : reject(new Error("Audio decode failed")),
      );
      ffmpeg.stdin.end(audio);
    });
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
    const response = await fetch(endpoint, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Whisper returned ${response.status}`);
    }
    const result = await response.json();
    return result.text ?? "";
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}
function owner(req) {
  const raw = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("session="))
    ?.slice(8);
  if (!raw) {
    return null;
  }
  const [sub, expiry, signature] = raw.split(".");
  if (
    !sub ||
    Number(expiry) < Date.now() ||
    signature !== createCookieSignature(`${sub}.${expiry}`)
  ) {
    return null;
  }
  return decodeURIComponent(sub);
}
function createCookieSignature(value) {
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}
async function body(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error("Request too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { status: "ok" });
    }
    if (req.method === "GET" && url.pathname === "/login") {
      const nonce = randomUUID();
      const state = nonce;
      const nonceValue = randomUUID();
      const codeVerifier = oidc.generators.codeVerifier();
      states.set(state, {
        expires: Date.now() + 300_000,
        nonce: nonceValue,
        codeVerifier,
      });
      return res
        .writeHead(302, {
          location: oidc.authorizationUrl({
            scope: "openid profile email",
            state,
            nonce: nonceValue,
            code_challenge: oidc.generators.codeChallenge(codeVerifier),
            code_challenge_method: "S256",
          }),
          "cache-control": "no-store",
        })
        .end();
    }
    if (req.method === "GET" && url.pathname === "/oidc/callback") {
      const state = url.searchParams.get("state");
      const login = states.get(state);
      if (!login || login.expires < Date.now()) {
        return send(res, 400, { error: "Invalid login state" });
      }
      states.delete(state);
      if (url.searchParams.has("error")) {
        return send(res, 401, { error: "Login failed" });
      }
      const token = await oidc.callback(
        redirectUri,
        Object.fromEntries(url.searchParams),
        { state, nonce: login.nonce, code_verifier: login.codeVerifier },
      );
      const claims = token.claims();
      if (!claims.sub) {
        return send(res, 401, { error: "Missing subject claim" });
      }
      const expires = Date.now() + 8 * 60 * 60_000;
      const value = `${encodeURIComponent(claims.sub)}.${expires}`;
      const key = `${value}.${createCookieSignature(value)}`;
      return res
        .writeHead(302, {
          location: "/",
          "set-cookie": `session=${key}; HttpOnly; ${process.env.COOKIE_SECURE === "false" ? "" : "Secure;"} SameSite=Lax; Path=/; Max-Age=28800`,
          "cache-control": "no-store",
        })
        .end();
    }
    const sub = owner(req);
    if (!sub) {
      return send(res, 401, {
        error: "Authentication required",
        login: "/login",
      });
    }
    if (req.method === "POST" && url.pathname === "/sessions") {
      const session = sessions.create(sub);
      return send(res, 201, { sessionId: session.id });
    }
    const audioMatch = url.pathname.match(/^\/sessions\/([\w-]+)\/chunks$/);
    if (req.method === "POST" && audioMatch) {
      const session = sessions.get(audioMatch[1], sub);
      const audio = await body(req, 2_000_000);
      const duration = Number(req.headers["x-audio-duration"] ?? 0);
      await sessions.append(session, audio, {
        final: req.headers["x-final"] === "true",
        duration,
      });
      return send(res, 202, { accepted: true, sessionId: session.id });
    }
    const eventMatch = url.pathname.match(/^\/sessions\/([\w-]+)\/events$/);
    if (req.method === "GET" && eventMatch) {
      const session = sessions.get(eventMatch[1], sub);
      const { replay, events } = sessions.subscribe(
        session,
        req.headers["last-event-id"] ??
          url.searchParams.get("lastEventId") ??
          0,
      );
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const write = (event) =>
        res.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      replay.forEach(write);
      const listener = (event) => write(event);
      events.on("event", listener);
      const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        events.off("event", listener);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(new URL("./index.html", import.meta.url));
      res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(html);
      return;
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    if (!res.headersSent) {
      send(res, error.status ?? 500, {
        error: error.status ? error.message : "Internal server error",
      });
    } else {
      res.destroy();
    }
  }
});
server.listen(port, "0.0.0.0");
