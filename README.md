# Chunk Speech

A small, containerized HTTP service for authenticated, ordered audio transcription sessions. Each uploaded chunk is transcribed immediately and emitted as an SSE `transcript` event; the final chunk closes the session and emits a `final` event. VAD is client-side: pause/stop is the explicit endpoint signal, with optional future client VAD integration.

## Run locally

Configure an OIDC provider with a callback URI matching `OIDC_REDIRECT_URI`, then create `.env` (never commit it):

```dotenv
OIDC_ISSUER=https://issuer.example
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URI=http://localhost:3000/oidc/callback
```

Place a compatible whisper.cpp ggml model at `./models/ggml-base.en.bin`, then run `docker compose up --build`. Visit `http://localhost:3000`. Production MUST use HTTPS because the session cookie is Secure. The whisper.cpp server is private to the Compose network and audio is submitted in memory; no audio files are written by the application. Configure TLS/reverse proxy and a persistent, shared session store before multi-instance deployment.

Local development: `npm install`, then `npm test`, `npm start`. The app refuses to start without OIDC settings. `GET /health` reports process liveness and does not expose transcriber/provider details.

## API

All routes except `/health` and OIDC login/callback require the HttpOnly authenticated session cookie. The login is standard Authorization Code flow using OIDC discovery and `openid profile email` scope.

* `POST /sessions` creates a session. Response: `{"sessionId":"..."}`.
* `POST /sessions/{id}/chunks` accepts raw audio request bytes. `X-Audio-Duration` is required in seconds (maximum 30); set `X-Final: true` for the final chunk. Audio must be accepted by the configured whisper.cpp HTTP server. Response is sent after transcription completes.
* `GET /sessions/{id}/events` streams `session`, `transcript`, `final`, and generic `error` SSE events. Events contain monotonically increasing `id`, `sessionId`, and transcript `text`; transcript has `partial` boolean. Reconnect using `Last-Event-ID` (or `lastEventId` query parameter), and retained events replay in order.

Sessions are isolated to the OIDC subject. Defaults: 2 MB/chunk, 20 MB/session, 30 seconds/chunk, 100 active sessions, 5 minutes idle retention. Override via `MAX_CHUNK_BYTES`, `MAX_SESSION_BYTES`, `MAX_CHUNK_SECONDS`, `MAX_SESSIONS`, `SESSION_IDLE_MS`. In-memory session state and event history are intentionally ephemeral; enforce authenticated access at a trusted TLS proxy, rate-limit login and session creation, and use a shared durable store/broker for multi-replica production. A request's audio buffer is released after queued transcription finishes.

## Architecture / deployment plan

Node's built-in HTTP server handles OIDC, limits, session ownership, in-memory ordered promise queues, and SSE replay. Audio goes to a separate whisper.cpp HTTP container over the private network. No Ollama/LLM is used. Deployment plan: pin image/model digests, add TLS and proxy request limits, configure OIDC issuer/client securely, add shared session/event storage and distributed admission controls before horizontal scaling, add metrics without audio/text, and test resource/time budgets. Compose uses a read-only app filesystem, non-root user, private model mount and no-new-privileges. Do not expose the whisper port publicly.

The included minimal browser page demonstrates mic capture and chunk uploads; browser-generated audio/container support varies by whisper.cpp build. Use a client/adapter that emits the audio format supported by the selected whisper.cpp build (commonly WAV) before production use. The HTTP adapter currently forwards request bytes labeled as WAV; it does not decode or transcode. Do not send arbitrary uploads from untrusted origins; deploy same-origin with CSRF protections appropriate to any additional browser endpoints.
