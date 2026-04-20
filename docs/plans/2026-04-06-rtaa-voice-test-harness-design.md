# RTAA Voice-to-Voice Test Harness Design

**Date:** 2026-04-06
**Status:** Approved
**Approach:** Hybrid (WebSocket injection + Playwright UI validation)
**Target:** Viraforge/rtaa repository
**Phase 1 deadline:** 1 week

---

## Problem

ViraCue is a real-time AI voice assistant. The training simulator lets users have spoken conversations with AI personas over OpenAI's Realtime API. There is no automated way to:

- Run conversations at scale and measure success/failure rates
- Detect latency regressions across deploys
- Validate persona behavior (hallucination, goal completion, tone)
- Catch conversational edge cases (interruptions, silence, topic drift)
- Score AI response quality with structured metrics

The existing 48 Playwright extension specs cover UI and audio capture mechanics. What's missing is an autonomous conversational test system that evaluates the intelligence layer.

## Decision: Why WebSocket Injection

ViraCue's simulator uses OpenAI Realtime API over WebSocket with a well-defined JSON protocol. The server at `/openai-realtime-proxy` whitelists specific event types. This means we can drive conversations by connecting directly to the WebSocket and sending the same `input_audio_buffer.append` messages the browser client sends — without touching OS audio, virtual mics, or browser MediaStream APIs.

**What we gain:** Deterministic, CI-stable conversation testing that runs headless with no audio dependencies.

**What we trade:** We don't test the browser's AudioContext → PCM16 encoding path. Mitigated by: (1) existing extension specs cover that path, (2) Phase 1 includes a Playwright mic-connectivity check that verifies the UI shows "Listening" and the WebSocket is active.

---

## Architecture

### Components

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **Test Runner** | Orchestrates scenarios, manages concurrency, produces reports | Node.js script |
| **WS Injector** | Connects to `/openai-realtime-proxy`, sends/receives audio + transcripts | Native WebSocket client |
| **Persona Brain** | Generates next utterance based on persona, goal, transcript history | LLM (Claude or GPT-4o) |
| **TTS Engine** | Converts persona utterance text to PCM16 24kHz audio | OpenAI TTS API or local |
| **Evaluator** | Post-session grading of transcript against success/failure criteria | LLM judge |
| **Playwright Validator** | Parallel UI assertions: extension loaded, widget visible, connection active | Playwright + Chromium |
| **Report Generator** | Aggregates all sessions into JSON + human-readable report | Built into runner |

### Conversation Loop

```
for each scenario in test suite:
  1. authenticate (get session token via /api/auth)
  2. select persona config on server (POST /api/personas or use existing)
  3. open WebSocket to wss://<host>/openai-realtime-proxy
  4. send session.update with persona instructions + voice config
  5. loop:
     a. persona brain generates utterance text
     b. TTS converts text → PCM16 24kHz → base64
     c. send input_audio_buffer.append (chunked, ~100ms frames)
     d. send input_audio_buffer.commit
     e. wait for response.output_audio_transcript.done (AI reply text)
     f. also capture: input_audio_transcription.completed (what OpenAI heard)
     g. measure: time from commit → first audio delta (latency)
     h. feed AI reply + heard transcript to persona brain
     i. persona brain decides: continue / goal_met / failure / timeout
  6. close WebSocket
  7. run evaluator on full transcript
  8. record metrics + verdict
```

### Playwright Validation (Parallel)

Runs once per test suite execution (not per conversation):

1. Launch Chromium with extension loaded (`--load-extension=` flag)
2. Navigate to ViraCue app
3. Start a training session
4. Assert: widget shows "Listening" state
5. Assert: no console errors related to WebSocket or audio
6. Assert: extension popup shows connected status
7. Screenshot on failure
8. Close browser

This satisfies the mic-connectivity constraint: if the UI reaches "Listening" and the WebSocket connects, the mic capture path is functional.

---

## WebSocket Protocol (from server.js analysis)

### Messages We Send

| Event | Purpose | Payload |
|-------|---------|---------|
| `session.update` | Configure voice, persona, VAD | `{session: {voice, instructions, input_audio_transcription: {model: "whisper-1"}}}` |
| `conversation.item.create` | Inject initial system prompt | `{item: {type: "message", role: "user", content: [{type: "input_audio", audio: "<base64>"}]}}` |
| `input_audio_buffer.append` | Stream PCM16 audio chunks | `{audio: "<base64-pcm16>"}` |
| `input_audio_buffer.commit` | Signal end of utterance | `{}` |
| `response.create` | Request AI response | `{}` |
| `response.cancel` | Interrupt/barge-in | `{}` |

### Messages We Receive

| Event | What it tells us |
|-------|-----------------|
| `response.output_audio.delta` | Streaming audio chunk (for latency measurement) |
| `response.output_audio_transcript.done` | Full text of AI response |
| `conversation.item.input_audio_transcription.completed` | What Whisper heard from our audio (validates TTS quality) |
| `input_audio_buffer.speech_started` | VAD detected speech start |
| `response.done` | Response complete (for turn-timing) |
| `error` | Session errors |

### Authentication

The proxy requires authentication. From `server.js`:
- WebSocket connection includes auth token (query param or header)
- Rate limited: 5 connections per IP, 30-minute session max
- 5-second auth timeout

The test harness authenticates via the same HTTP auth flow the client uses, then passes the token to the WebSocket connection.

---

## Test Definition Format

```json
{
  "name": "frustrated_user_score_drop",
  "persona": {
    "prompt": "You are a frustrated customer who just saw their credit score drop 40 points. You want to know why and what to do. You interrupt long explanations. You do not volunteer account details unless asked.",
    "voice_style": "impatient, clipped sentences",
    "max_turns": 8
  },
  "goal": "Get a clear explanation of the score drop cause and a concrete next action.",
  "success_criteria": [
    "AI explains at least one plausible cause for the score drop",
    "AI suggests a specific next action",
    "AI does not hallucinate policy details",
    "Conversation completes within max_turns"
  ],
  "failure_conditions": [
    "No response within 10 seconds",
    "AI produces hallucinated policy or regulation",
    "Conversation loops (same exchange repeated 3+ times)",
    "AI fails to ask for needed information"
  ],
  "timing": {
    "max_response_latency_ms": 5000,
    "max_silence_gap_ms": 8000
  }
}
```

Scenarios are JSON files in a `scenarios/` directory. The runner loads all of them (or a filtered subset).

---

## Scoring Model

### Per-Session Metrics (Automated)

| Metric | Source | Type |
|--------|--------|------|
| `task_success` | Evaluator LLM | pass/fail |
| `turns_to_completion` | Loop counter | integer |
| `avg_response_latency_ms` | Time from `commit` → first `audio.delta` | number |
| `max_response_latency_ms` | Worst single turn | number |
| `max_silence_gap_ms` | Longest gap between events | number |
| `transcript_match_rate` | Sent text vs. Whisper transcription accuracy | 0.0-1.0 |
| `barge_in_handled` | If tested: did cancel + re-speak work | pass/fail/skip |
| `session_errors` | WebSocket error events | count |
| `console_errors` | From Playwright validator | count |

### LLM Evaluator (Post-Session)

The evaluator receives the full transcript and scenario config, then grades:

- **Accuracy:** Did the AI answer the actual question?
- **Conciseness:** Was it appropriately brief?
- **Information gathering:** Did it ask for needed info?
- **Hallucination:** Did it fabricate policies, regulations, or facts?
- **Tone matching:** Did it handle the persona's emotional state?
- **Goal completion:** Was the stated goal achieved?

Output: structured JSON with per-criterion score (1-5) and reasoning.

### Hard Assertions (Non-LLM)

These fail the test immediately, no evaluator needed:

- WebSocket connection failed
- No `response.done` received within timeout
- Session error event received
- Auth failure
- Playwright: extension not loaded, widget not visible

---

## Report Format

Each run produces `report.json`:

```json
{
  "run_id": "uuid",
  "timestamp": "2026-04-06T...",
  "target": "wss://viracue.ai/openai-realtime-proxy",
  "scenarios_total": 100,
  "scenarios_passed": 87,
  "scenarios_failed": 13,
  "avg_latency_ms": 1240,
  "p95_latency_ms": 3100,
  "playwright_validation": "pass",
  "sessions": [
    {
      "scenario": "frustrated_user_score_drop",
      "verdict": "pass",
      "turns": 5,
      "avg_latency_ms": 980,
      "transcript": [...],
      "evaluator_scores": {...},
      "hard_assertions": {...}
    }
  ]
}
```

---

## Phasing

### Phase 1 (Week 1) — Core Harness

Deliverables:
- WS Injector: connect, authenticate, send/receive the full protocol
- TTS pipeline: text → PCM16 24kHz → base64 chunks (OpenAI TTS API)
- Persona brain: single-turn LLM call with transcript context
- Conversation loop: run a scenario end-to-end
- 5 starter scenarios covering: happy path, frustrated user, vague user, interrupter, confused user
- Playwright mic-connectivity check (extension loaded, widget listening, WS active)
- JSON report output
- Runner script: `node test-harness/run.js --scenarios=all --target=https://viracue.ai`

Success metric: run 100 conversations (5 scenarios x 20 runs each), produce a JSON report with pass/fail/latency.

### Phase 2 (Week 2-3) — Depth

- Barge-in testing (send `response.cancel` mid-response, then new audio)
- Silence/dead-air injection (pause 10s+ between turns)
- Partial utterance testing (commit audio mid-word)
- Evaluator LLM scoring with structured rubric
- Scenario library expansion (15-20 scenarios)
- Transcript diff: compare what we sent vs. what Whisper heard
- Screenshot + trace capture on failure

### Phase 3 (Week 4+) — Scale

- Parallel session execution (configurable concurrency)
- CI integration (GitHub Actions workflow, nightly runs)
- Trend tracking: latency/pass-rate over time by build/deploy
- Dashboard or markdown summary posted to PR/Slack
- Headed audio-path canary test (one scenario through real browser mic for full-path validation)

---

## File Structure (in Viraforge/rtaa repo)

```
test-harness/
  run.js                    # CLI entry point
  src/
    runner.js               # Orchestrates scenarios, concurrency, reporting
    ws-injector.js          # WebSocket client for OpenAI Realtime protocol
    persona-brain.js        # LLM-driven utterance generation
    tts-engine.js           # Text → PCM16 24kHz audio generation
    evaluator.js            # Post-session LLM grading
    playwright-validator.js # Browser + extension connectivity check
    report.js               # JSON report generation
    auth.js                 # ViraCue auth flow
  scenarios/
    frustrated-user.json
    happy-path.json
    vague-user.json
    interrupter.json
    confused-user.json
  reports/                  # Generated reports (gitignored)
  README.md
```

---

## Dependencies

| Dependency | Purpose | Notes |
|-----------|---------|-------|
| `ws` | WebSocket client | Native Node.js WebSocket also viable |
| `playwright` | Already in repo (v1.58.2) | Reuse existing config |
| OpenAI API | TTS generation + persona brain | Already have keys |
| Anthropic API | Alternative persona brain / evaluator | Optional |

No new infrastructure. Runs against any ViraCue deployment (local, staging, production).

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| OpenAI Realtime API costs per session | Cap turns, use shorter scenarios for regression, reserve long scenarios for nightly |
| Rate limiting (5 connections/IP) | Sequential execution in Phase 1; Phase 3 adds distributed execution |
| TTS → PCM16 encoding mismatch | Validate with `input_audio_transcription.completed` — if Whisper can't understand us, encoding is wrong |
| Evaluator LLM disagreement | Store full transcripts; evaluator scores are advisory, hard assertions are authoritative |
| Auth token expiry mid-session | 30-minute session limit is well above any scenario; refresh between scenarios |
| Flaky persona brain outputs | Bounded personas with constraints; cap turn count; seed where possible |

---

## Success Criteria for Phase 1

- [ ] Run 100 conversations (5 scenarios x 20 each) against production
- [ ] JSON report with per-session pass/fail, latency, turn count
- [ ] Playwright validates extension + widget + WS connectivity
- [ ] Transcript match rate > 0.8 (Whisper understands our TTS)
- [ ] Average response latency < 5s
- [ ] Zero auth or connection failures
- [ ] Script runs in < 30 minutes for 100 sessions (sequential)
