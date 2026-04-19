# RTAA Voice-to-Voice Test Harness — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a WebSocket-level autonomous conversation harness that runs 100+ AI-to-AI voice test sessions against ViraCue's training simulator and produces a structured JSON report with pass/fail, latency, and evaluator scores.

**Architecture:** The harness connects directly to ViraCue's `/openai-realtime-proxy` WebSocket using the same PCM16/base64 protocol the browser client uses. A persona brain (LLM) generates utterances, OpenAI TTS converts them to PCM16 24kHz audio, and the injector streams them as `input_audio_buffer.append` messages. Responses are captured via transcript events. Playwright validates extension/UI connectivity in parallel.

**Tech Stack:** Node.js, `ws` (WebSocket), OpenAI TTS API, OpenAI/Anthropic for persona brain + evaluator, Playwright (existing in repo), Vitest for unit tests.

**Repository:** `Viraforge/rtaa` (not the Paperclip repo — this plan is stored here for reference, code goes there)

---

## Task 1: Scaffold the test-harness directory and dependencies

**Files:**
- Create: `test-harness/package.json`
- Create: `test-harness/tsconfig.json`
- Create: `test-harness/.gitignore`

**Step 1: Create the package.json**

```json
{
  "name": "rtaa-voice-test-harness",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "harness": "tsx src/run.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.18.1",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.14"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
reports/
*.log
```

**Step 4: Install dependencies**

Run: `cd test-harness && npm install`

**Step 5: Commit**

```bash
git add test-harness/
git commit -m "feat(test-harness): scaffold voice test harness package"
```

---

## Task 2: Build the WebSocket injector

This is the core component. It speaks the OpenAI Realtime protocol through ViraCue's proxy.

**Files:**
- Create: `test-harness/src/ws-injector.ts`
- Create: `test-harness/src/__tests__/ws-injector.test.ts`

**Step 1: Write the failing test**

```typescript
// test-harness/src/__tests__/ws-injector.test.ts
import { describe, it, expect } from 'vitest';
import { WsInjector, type WsEvent } from '../ws-injector.js';

describe('WsInjector', () => {
  it('builds a valid input_audio_buffer.append message from PCM16 bytes', () => {
    // 10 samples of silence as Int16
    const silence = new Int16Array(10);
    const msg = WsInjector.buildAudioAppendMessage(silence);

    expect(msg.type).toBe('input_audio_buffer.append');
    expect(typeof msg.audio).toBe('string');
    // base64 of 20 zero bytes
    const decoded = Buffer.from(msg.audio, 'base64');
    expect(decoded.length).toBe(20); // 10 samples * 2 bytes each
  });

  it('builds a valid session.update message', () => {
    const msg = WsInjector.buildSessionUpdate({
      voice: 'ash',
      instructions: 'You are a test persona.',
    });

    expect(msg.type).toBe('session.update');
    expect(msg.session.voice).toBe('ash');
    expect(msg.session.instructions).toBe('You are a test persona.');
    expect(msg.session.input_audio_transcription.model).toBe('whisper-1');
    expect(msg.session.turn_detection.type).toBe('server_vad');
  });

  it('chunks PCM16 audio into ~100ms frames at 24kHz', () => {
    // 24000 samples = 1 second of 24kHz audio
    const oneSecond = new Int16Array(24000);
    const chunks = WsInjector.chunkAudio(oneSecond, 24000, 100);

    // 1s / 100ms = 10 chunks
    expect(chunks.length).toBe(10);
    // Each chunk: 2400 samples * 2 bytes = 4800 bytes
    for (const chunk of chunks) {
      expect(chunk.length).toBe(2400);
    }
  });

  it('parses transcript events from server messages', () => {
    const aiResponse: WsEvent = {
      type: 'response.audio_transcript.done',
      transcript: 'Hello, how can I help you today?',
    };
    const parsed = WsInjector.parseServerEvent(JSON.stringify(aiResponse));
    expect(parsed.type).toBe('response.audio_transcript.done');
    expect(parsed.transcript).toBe('Hello, how can I help you today?');

    const whisperHeard: WsEvent = {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'I want to know about my score',
    };
    const parsed2 = WsInjector.parseServerEvent(JSON.stringify(whisperHeard));
    expect(parsed2.type).toBe('conversation.item.input_audio_transcription.completed');
    expect(parsed2.transcript).toBe('I want to know about my score');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd test-harness && npx vitest run src/__tests__/ws-injector.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// test-harness/src/ws-injector.ts
import WebSocket from 'ws';

export interface WsEvent {
  type: string;
  [key: string]: unknown;
}

export interface SessionConfig {
  voice: string;
  instructions: string;
}

export interface InjectorCallbacks {
  onAiTranscript: (text: string) => void;
  onWhisperHeard: (text: string) => void;
  onAudioDelta: (timestamp: number) => void;
  onResponseDone: () => void;
  onError: (error: string) => void;
  onClose: () => void;
}

export class WsInjector {
  private ws: WebSocket | null = null;
  private callbacks: InjectorCallbacks;

  constructor(callbacks: InjectorCallbacks) {
    this.callbacks = callbacks;
  }

  /** Connect to the ViraCue WS proxy and authenticate */
  async connect(url: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.send({ type: 'auth', token });
      });

      this.ws.on('message', (data) => {
        const event = WsInjector.parseServerEvent(data.toString());

        switch (event.type) {
          case 'session.created':
            resolve();
            break;
          case 'response.audio_transcript.done':
          case 'response.output_audio_transcript.done':
            this.callbacks.onAiTranscript(event.transcript as string);
            break;
          case 'conversation.item.input_audio_transcription.completed':
            this.callbacks.onWhisperHeard(event.transcript as string);
            break;
          case 'response.audio.delta':
          case 'response.output_audio.delta':
            this.callbacks.onAudioDelta(Date.now());
            break;
          case 'response.done':
            this.callbacks.onResponseDone();
            break;
          case 'error':
            this.callbacks.onError(JSON.stringify(event));
            break;
        }
      });

      this.ws.on('error', (err) => reject(err));
      this.ws.on('close', () => this.callbacks.onClose());

      setTimeout(() => reject(new Error('WS connect timeout')), 15_000);
    });
  }

  /** Send session.update to configure voice and persona */
  configureSession(config: SessionConfig): void {
    this.send(WsInjector.buildSessionUpdate(config));
  }

  /** Stream PCM16 audio in ~100ms chunks with realistic timing */
  async streamAudio(pcm16: Int16Array, sampleRate: number = 24000): Promise<void> {
    const chunks = WsInjector.chunkAudio(pcm16, sampleRate, 100);
    for (const chunk of chunks) {
      this.send(WsInjector.buildAudioAppendMessage(chunk));
      // Pace chunks at real-time speed to simulate natural speech
      await sleep(100);
    }
  }

  /** Close the WebSocket connection */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  // --- Static helpers (tested independently) ---

  static buildAudioAppendMessage(pcm16: Int16Array): { type: string; audio: string } {
    const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    const audio = Buffer.from(bytes).toString('base64');
    return { type: 'input_audio_buffer.append', audio };
  }

  static buildSessionUpdate(config: SessionConfig) {
    return {
      type: 'session.update',
      session: {
        voice: config.voice,
        instructions: config.instructions,
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad' },
      },
    };
  }

  static chunkAudio(pcm16: Int16Array, sampleRate: number, chunkMs: number): Int16Array[] {
    const samplesPerChunk = Math.floor(sampleRate * (chunkMs / 1000));
    const chunks: Int16Array[] = [];
    for (let offset = 0; offset < pcm16.length; offset += samplesPerChunk) {
      const end = Math.min(offset + samplesPerChunk, pcm16.length);
      chunks.push(pcm16.slice(offset, end));
    }
    return chunks;
  }

  static parseServerEvent(raw: string): WsEvent {
    return JSON.parse(raw) as WsEvent;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**Step 4: Run test to verify it passes**

Run: `cd test-harness && npx vitest run src/__tests__/ws-injector.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add test-harness/src/ws-injector.ts test-harness/src/__tests__/ws-injector.test.ts
git commit -m "feat(test-harness): add WebSocket injector with OpenAI Realtime protocol"
```

---

## Task 3: Build the TTS engine

Converts persona utterance text into PCM16 24kHz audio suitable for WebSocket injection.

**Files:**
- Create: `test-harness/src/tts-engine.ts`
- Create: `test-harness/src/__tests__/tts-engine.test.ts`

**Step 1: Write the failing test**

```typescript
// test-harness/src/__tests__/tts-engine.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TtsEngine } from '../tts-engine.js';

describe('TtsEngine', () => {
  it('converts raw PCM bytes to Int16Array at 24kHz', () => {
    // Simulate what OpenAI returns: raw PCM16 bytes
    const samples = new Int16Array([100, -200, 300, -400]);
    const bytes = Buffer.from(samples.buffer);

    const result = TtsEngine.pcmBytesToInt16(bytes);
    expect(result.length).toBe(4);
    expect(result[0]).toBe(100);
    expect(result[1]).toBe(-200);
  });

  it('generates silence of a specified duration', () => {
    const silence = TtsEngine.generateSilence(500, 24000); // 500ms
    expect(silence.length).toBe(12000); // 24000 * 0.5
    expect(silence.every((s) => s === 0)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd test-harness && npx vitest run src/__tests__/tts-engine.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// test-harness/src/tts-engine.ts

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const SAMPLE_RATE = 24000;

export class TtsEngine {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Convert text to PCM16 24kHz audio via OpenAI TTS.
   * Returns Int16Array ready for WsInjector.streamAudio().
   */
  async textToPcm16(text: string, voice: string = 'alloy'): Promise<Int16Array> {
    const res = await fetch(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice,
        response_format: 'pcm',   // raw PCM16 at 24kHz
        speed: 1.0,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`TTS failed (${res.status}): ${body}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return TtsEngine.pcmBytesToInt16(Buffer.from(arrayBuffer));
  }

  /** Parse raw PCM bytes (little-endian Int16) into an Int16Array */
  static pcmBytesToInt16(buffer: Buffer): Int16Array {
    // Ensure byte alignment
    const aligned = buffer.byteLength % 2 === 0
      ? buffer
      : buffer.subarray(0, buffer.byteLength - 1);
    return new Int16Array(
      aligned.buffer,
      aligned.byteOffset,
      aligned.byteLength / 2,
    );
  }

  /** Generate silence (useful for pause injection) */
  static generateSilence(durationMs: number, sampleRate: number = SAMPLE_RATE): Int16Array {
    const samples = Math.floor(sampleRate * (durationMs / 1000));
    return new Int16Array(samples); // zeros = silence
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd test-harness && npx vitest run src/__tests__/tts-engine.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test-harness/src/tts-engine.ts test-harness/src/__tests__/tts-engine.test.ts
git commit -m "feat(test-harness): add TTS engine for text-to-PCM16 conversion"
```

---

## Task 4: Build the persona brain

LLM-driven conversational agent that generates natural utterances based on persona, goal, and conversation history.

**Files:**
- Create: `test-harness/src/persona-brain.ts`
- Create: `test-harness/src/__tests__/persona-brain.test.ts`
- Create: `test-harness/src/types.ts`

**Step 1: Create shared types**

```typescript
// test-harness/src/types.ts

export interface Scenario {
  name: string;
  persona: {
    prompt: string;
    voice_style: string;
    max_turns: number;
  };
  goal: string;
  success_criteria: string[];
  failure_conditions: string[];
  timing: {
    max_response_latency_ms: number;
    max_silence_gap_ms: number;
  };
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  latency_ms?: number;
  timestamp: number;
}

export interface BrainDecision {
  action: 'speak' | 'goal_met' | 'failure' | 'timeout';
  utterance?: string;
  reason?: string;
}

export interface SessionResult {
  scenario: string;
  verdict: 'pass' | 'fail' | 'error';
  turns: Turn[];
  metrics: SessionMetrics;
  evaluator_scores?: Record<string, number>;
  error?: string;
}

export interface SessionMetrics {
  turn_count: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  max_silence_gap_ms: number;
  transcript_match_rate: number;
}

export interface RunReport {
  run_id: string;
  timestamp: string;
  target: string;
  scenarios_total: number;
  scenarios_passed: number;
  scenarios_failed: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  playwright_validation: 'pass' | 'fail' | 'skip';
  sessions: SessionResult[];
}
```

**Step 2: Write the failing test**

```typescript
// test-harness/src/__tests__/persona-brain.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PersonaBrain } from '../persona-brain.js';
import type { Scenario, Turn } from '../types.js';

const testScenario: Scenario = {
  name: 'test_persona',
  persona: {
    prompt: 'You are a confused customer who cannot understand technical terms.',
    voice_style: 'slow, uncertain',
    max_turns: 5,
  },
  goal: 'Get a simple explanation of what happened to your account.',
  success_criteria: ['AI provides a non-technical explanation'],
  failure_conditions: ['Conversation loops 3 times'],
  timing: { max_response_latency_ms: 5000, max_silence_gap_ms: 8000 },
};

describe('PersonaBrain', () => {
  it('builds a valid system prompt from scenario config', () => {
    const prompt = PersonaBrain.buildSystemPrompt(testScenario);
    expect(prompt).toContain('confused customer');
    expect(prompt).toContain('simple explanation');
    expect(prompt).toContain('goal_met');
    expect(prompt).toContain('failure');
  });

  it('formats conversation history for the LLM', () => {
    const turns: Turn[] = [
      { role: 'user', text: 'Hi, I have a question', timestamp: 1000 },
      { role: 'assistant', text: 'Hello! How can I help?', timestamp: 2000 },
    ];
    const messages = PersonaBrain.formatHistory(testScenario, turns);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe('Hi, I have a question');
    expect(messages[2].role).toBe('assistant');
    expect(messages[2].content).toBe('Hello! How can I help?');
  });

  it('parses a speak decision from LLM output', () => {
    const raw = JSON.stringify({ action: 'speak', utterance: 'What do you mean by that?' });
    const decision = PersonaBrain.parseDecision(raw);
    expect(decision.action).toBe('speak');
    expect(decision.utterance).toBe('What do you mean by that?');
  });

  it('parses a goal_met decision from LLM output', () => {
    const raw = JSON.stringify({ action: 'goal_met', reason: 'Got a clear explanation' });
    const decision = PersonaBrain.parseDecision(raw);
    expect(decision.action).toBe('goal_met');
    expect(decision.reason).toBe('Got a clear explanation');
  });

  it('defaults to failure on unparseable output', () => {
    const decision = PersonaBrain.parseDecision('this is not json');
    expect(decision.action).toBe('failure');
    expect(decision.reason).toContain('unparseable');
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd test-harness && npx vitest run src/__tests__/persona-brain.test.ts`
Expected: FAIL

**Step 4: Write the implementation**

```typescript
// test-harness/src/persona-brain.ts
import type { Scenario, Turn, BrainDecision } from './types.js';

interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LlmProvider {
  chat(messages: LlmMessage[]): Promise<string>;
}

export class PersonaBrain {
  private provider: LlmProvider;
  private scenario: Scenario;

  constructor(provider: LlmProvider, scenario: Scenario) {
    this.provider = provider;
    this.scenario = scenario;
  }

  /** Generate the next decision: speak, goal_met, failure, or timeout */
  async decide(turns: Turn[]): Promise<BrainDecision> {
    // First turn — generate opening line without needing AI response
    if (turns.length === 0) {
      const messages = PersonaBrain.formatHistory(this.scenario, turns);
      messages.push({
        role: 'user',
        content: 'Generate your opening line. The call just started. Respond with JSON only.',
      });
      const raw = await this.provider.chat(messages);
      return PersonaBrain.parseDecision(raw);
    }

    // Check max turns
    const userTurns = turns.filter((t) => t.role === 'user').length;
    if (userTurns >= this.scenario.persona.max_turns) {
      return { action: 'timeout', reason: `Max turns (${this.scenario.persona.max_turns}) reached` };
    }

    const messages = PersonaBrain.formatHistory(this.scenario, turns);
    messages.push({
      role: 'user',
      content: 'Based on the conversation so far, decide your next action. Respond with JSON only.',
    });

    const raw = await this.provider.chat(messages);
    return PersonaBrain.parseDecision(raw);
  }

  static buildSystemPrompt(scenario: Scenario): string {
    return `You are a synthetic test caller in a voice conversation.

PERSONA: ${scenario.persona.prompt}
VOICE STYLE: ${scenario.persona.voice_style}

YOUR GOAL: ${scenario.goal}

SUCCESS CRITERIA (if ALL met, respond with goal_met):
${scenario.success_criteria.map((c) => `- ${c}`).join('\n')}

FAILURE CONDITIONS (if ANY met, respond with failure):
${scenario.failure_conditions.map((c) => `- ${c}`).join('\n')}

RULES:
- Respond ONLY with a JSON object, no other text
- For speaking: {"action": "speak", "utterance": "what you say next"}
- If goal achieved: {"action": "goal_met", "reason": "why"}
- If failure detected: {"action": "failure", "reason": "which condition"}
- Keep utterances short and natural (1-2 sentences)
- Stay in character at all times`;
  }

  static formatHistory(scenario: Scenario, turns: Turn[]): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: 'system', content: PersonaBrain.buildSystemPrompt(scenario) },
    ];
    for (const turn of turns) {
      messages.push({ role: turn.role, content: turn.text });
    }
    return messages;
  }

  static parseDecision(raw: string): BrainDecision {
    try {
      // Strip markdown code fences if present
      const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!['speak', 'goal_met', 'failure', 'timeout'].includes(parsed.action)) {
        return { action: 'failure', reason: `Unknown action: ${parsed.action}` };
      }
      return parsed as BrainDecision;
    } catch {
      return { action: 'failure', reason: `LLM output unparseable: ${raw.slice(0, 100)}` };
    }
  }
}
```

**Step 5: Run test to verify it passes**

Run: `cd test-harness && npx vitest run src/__tests__/persona-brain.test.ts`
Expected: PASS (5 tests)

**Step 6: Commit**

```bash
git add test-harness/src/types.ts test-harness/src/persona-brain.ts test-harness/src/__tests__/persona-brain.test.ts
git commit -m "feat(test-harness): add persona brain with LLM-driven conversation decisions"
```

---

## Task 5: Build the auth client

Handles ViraCue login and training session creation.

**Files:**
- Create: `test-harness/src/auth.ts`
- Create: `test-harness/src/__tests__/auth.test.ts`

**Step 1: Write the failing test**

```typescript
// test-harness/src/__tests__/auth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthClient } from '../auth.js';

describe('AuthClient', () => {
  it('builds the correct login request', () => {
    const client = new AuthClient('https://viracue.ai');
    const req = AuthClient.buildLoginRequest('test@example.com', 'password123');
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://viracue.ai/api/auth/login');
    expect(req.body).toEqual({ email: 'test@example.com', password: 'password123' });
  });

  it('builds the correct training session request', () => {
    const req = AuthClient.buildTrainingSessionRequest('https://viracue.ai', {
      callId: 123,
      personaId: 1,
      personaName: 'The Skeptic',
      modifiers: { temperament: 'irritated', pace: 'fast' },
    });
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://viracue.ai/api/training-sessions');
    expect(req.body.call_id).toBe(123);
    expect(req.body.persona_id).toBe(1);
    expect(req.body.modifiers_json.temperament).toBe('irritated');
  });

  it('constructs the WebSocket URL from the base URL', () => {
    expect(AuthClient.wsUrl('https://viracue.ai')).toBe('wss://viracue.ai/openai-realtime-proxy');
    expect(AuthClient.wsUrl('http://localhost:3000')).toBe('ws://localhost:3000/openai-realtime-proxy');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd test-harness && npx vitest run src/__tests__/auth.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// test-harness/src/auth.ts

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
}

interface CallResponse {
  id: number;
}

interface TrainingSessionRequest {
  callId: number;
  personaId: number;
  personaName: string;
  modifiers: Record<string, string>;
}

export class AuthClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Login and store access token */
  async login(email: string, password: string): Promise<LoginResponse> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`Login failed (${res.status}): ${await res.text()}`);
    const data = await res.json() as LoginResponse;
    this.token = data.accessToken;
    return data;
  }

  /** Create a call record (required before training session) */
  async createCall(): Promise<number> {
    const res = await this.authedFetch(`${this.baseUrl}/api/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Create call failed (${res.status}): ${await res.text()}`);
    const data = await res.json() as CallResponse;
    return data.id;
  }

  /** Create a training session for a given persona */
  async createTrainingSession(req: TrainingSessionRequest): Promise<{ id: number; token: string }> {
    const body = AuthClient.buildTrainingSessionRequest(this.baseUrl, req).body;
    const res = await this.authedFetch(`${this.baseUrl}/api/training-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Create session failed (${res.status}): ${await res.text()}`);
    return res.json() as Promise<{ id: number; token: string }>;
  }

  /** Get the stored access token */
  getToken(): string {
    if (!this.token) throw new Error('Not authenticated — call login() first');
    return this.token;
  }

  private authedFetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        ...init.headers as Record<string, string>,
        'Authorization': `Bearer ${this.getToken()}`,
      },
    });
  }

  // --- Static helpers for testing ---

  static buildLoginRequest(email: string, password: string) {
    return {
      method: 'POST' as const,
      url: `https://viracue.ai/api/auth/login`,
      body: { email, password },
    };
  }

  static buildTrainingSessionRequest(baseUrl: string, req: TrainingSessionRequest) {
    return {
      method: 'POST' as const,
      url: `${baseUrl.replace(/\/$/, '')}/api/training-sessions`,
      body: {
        call_id: req.callId,
        persona_id: req.personaId,
        persona_name: req.personaName,
        modifiers_json: req.modifiers,
      },
    };
  }

  static wsUrl(baseUrl: string): string {
    return baseUrl.replace(/^https/, 'wss').replace(/^http/, 'ws').replace(/\/$/, '') + '/openai-realtime-proxy';
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd test-harness && npx vitest run src/__tests__/auth.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add test-harness/src/auth.ts test-harness/src/__tests__/auth.test.ts
git commit -m "feat(test-harness): add auth client for ViraCue login and session creation"
```

---

## Task 6: Build the conversation runner

Orchestrates the full conversation loop: persona brain → TTS → WS inject → capture response → repeat.

**Files:**
- Create: `test-harness/src/conversation.ts`
- Create: `test-harness/src/__tests__/conversation.test.ts`

**Step 1: Write the failing test**

```typescript
// test-harness/src/__tests__/conversation.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ConversationRunner } from '../conversation.js';
import type { Scenario, Turn, BrainDecision, SessionMetrics } from '../types.js';

describe('ConversationRunner', () => {
  it('computes session metrics from turn data', () => {
    const turns: Turn[] = [
      { role: 'user', text: 'Hi', timestamp: 1000 },
      { role: 'assistant', text: 'Hello!', latency_ms: 800, timestamp: 2000 },
      { role: 'user', text: 'Question?', timestamp: 3000 },
      { role: 'assistant', text: 'Answer.', latency_ms: 1200, timestamp: 4500 },
    ];

    const metrics = ConversationRunner.computeMetrics(turns);
    expect(metrics.turn_count).toBe(4);
    expect(metrics.avg_latency_ms).toBe(1000); // (800 + 1200) / 2
    expect(metrics.max_latency_ms).toBe(1200);
    expect(metrics.max_silence_gap_ms).toBe(1500); // gap between 3000 and 4500
  });

  it('determines verdict from brain decision', () => {
    expect(ConversationRunner.verdictFrom({ action: 'goal_met', reason: 'done' })).toBe('pass');
    expect(ConversationRunner.verdictFrom({ action: 'failure', reason: 'looped' })).toBe('fail');
    expect(ConversationRunner.verdictFrom({ action: 'timeout', reason: 'max turns' })).toBe('fail');
  });

  it('computes transcript match rate', () => {
    const sent = ['hello world', 'how are you'];
    const heard = ['hello world', 'how are you'];
    expect(ConversationRunner.transcriptMatchRate(sent, heard)).toBe(1.0);

    const heard2 = ['hello world', 'how are yo'];
    const rate = ConversationRunner.transcriptMatchRate(sent, heard2);
    expect(rate).toBeGreaterThan(0.8);
    expect(rate).toBeLessThan(1.0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd test-harness && npx vitest run src/__tests__/conversation.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// test-harness/src/conversation.ts
import { WsInjector } from './ws-injector.js';
import { TtsEngine } from './tts-engine.js';
import { PersonaBrain } from './persona-brain.js';
import { AuthClient } from './auth.js';
import type { Scenario, Turn, BrainDecision, SessionResult, SessionMetrics } from './types.js';

interface ConversationDeps {
  tts: TtsEngine;
  brain: PersonaBrain;
  wsUrl: string;
  authToken: string;
  scenario: Scenario;
  /** Voice ID for the persona's TTS (default: 'alloy') */
  ttsVoice?: string;
  /** Voice ID for the OpenAI Realtime session (default: 'ash') */
  sessionVoice?: string;
}

export class ConversationRunner {
  /**
   * Run a single conversation session end-to-end.
   * Returns a structured result with verdict, turns, and metrics.
   */
  static async run(deps: ConversationDeps): Promise<SessionResult> {
    const { tts, brain, wsUrl, authToken, scenario } = deps;
    const turns: Turn[] = [];
    const sentTexts: string[] = [];
    const heardTexts: string[] = [];
    const latencies: number[] = [];
    let lastDecision: BrainDecision = { action: 'speak' };
    let audioSendTime = 0;

    // Collect events from the WebSocket
    let aiTranscript = '';
    let whisperHeard = '';
    let firstAudioDeltaTime = 0;
    let responseDone = false;

    const injector = new WsInjector({
      onAiTranscript: (text) => { aiTranscript = text; },
      onWhisperHeard: (text) => { whisperHeard = text; },
      onAudioDelta: (ts) => { if (!firstAudioDeltaTime) firstAudioDeltaTime = ts; },
      onResponseDone: () => { responseDone = true; },
      onError: (err) => { console.error(`[WS Error] ${err}`); },
      onClose: () => {},
    });

    try {
      // Connect and configure
      await injector.connect(wsUrl, authToken);
      injector.configureSession({
        voice: deps.sessionVoice ?? 'ash',
        instructions: scenario.persona.prompt,
      });

      // Conversation loop
      while (lastDecision.action === 'speak') {
        const decision = await brain.decide(turns);
        lastDecision = decision;

        if (decision.action !== 'speak' || !decision.utterance) break;

        // Generate audio from utterance
        const pcm16 = await tts.textToPcm16(decision.utterance, deps.ttsVoice ?? 'alloy');
        sentTexts.push(decision.utterance);

        // Send audio and measure latency
        aiTranscript = '';
        whisperHeard = '';
        firstAudioDeltaTime = 0;
        responseDone = false;
        audioSendTime = Date.now();

        turns.push({ role: 'user', text: decision.utterance, timestamp: audioSendTime });
        await injector.streamAudio(pcm16);

        // Wait for AI response (with timeout)
        const responseTimeout = scenario.timing.max_response_latency_ms * 2;
        const aiReply = await waitForResponse(() => responseDone, responseTimeout);

        if (!aiReply) {
          turns.push({
            role: 'assistant',
            text: '[TIMEOUT - no response]',
            latency_ms: responseTimeout,
            timestamp: Date.now(),
          });
          lastDecision = { action: 'failure', reason: 'Response timeout' };
          break;
        }

        const latency = firstAudioDeltaTime ? firstAudioDeltaTime - audioSendTime : responseTimeout;
        latencies.push(latency);
        if (whisperHeard) heardTexts.push(whisperHeard);

        turns.push({
          role: 'assistant',
          text: aiTranscript || '[no transcript]',
          latency_ms: latency,
          timestamp: Date.now(),
        });
      }

      injector.close();

      return {
        scenario: scenario.name,
        verdict: ConversationRunner.verdictFrom(lastDecision),
        turns,
        metrics: {
          ...ConversationRunner.computeMetrics(turns),
          transcript_match_rate: ConversationRunner.transcriptMatchRate(sentTexts, heardTexts),
        },
      };
    } catch (err) {
      injector.close();
      return {
        scenario: scenario.name,
        verdict: 'error',
        turns,
        metrics: ConversationRunner.computeMetrics(turns),
        error: String(err),
      };
    }
  }

  static computeMetrics(turns: Turn[]): SessionMetrics {
    const latencies = turns
      .filter((t) => t.latency_ms !== undefined)
      .map((t) => t.latency_ms!);

    const gaps: number[] = [];
    for (let i = 1; i < turns.length; i++) {
      gaps.push(turns[i].timestamp - turns[i - 1].timestamp);
    }

    return {
      turn_count: turns.length,
      avg_latency_ms: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      max_latency_ms: latencies.length ? Math.max(...latencies) : 0,
      max_silence_gap_ms: gaps.length ? Math.max(...gaps) : 0,
      transcript_match_rate: 0,
    };
  }

  static verdictFrom(decision: BrainDecision): 'pass' | 'fail' {
    return decision.action === 'goal_met' ? 'pass' : 'fail';
  }

  /** Simple word-overlap similarity between sent and heard texts */
  static transcriptMatchRate(sent: string[], heard: string[]): number {
    if (sent.length === 0) return 1.0;
    let totalScore = 0;
    const pairs = Math.min(sent.length, heard.length);
    for (let i = 0; i < pairs; i++) {
      const sentWords = new Set(sent[i].toLowerCase().split(/\s+/));
      const heardWords = new Set(heard[i].toLowerCase().split(/\s+/));
      const intersection = [...sentWords].filter((w) => heardWords.has(w));
      totalScore += intersection.length / Math.max(sentWords.size, heardWords.size);
    }
    return Math.round((totalScore / sent.length) * 100) / 100;
  }
}

function waitForResponse(check: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (check()) return resolve(true);
    const interval = setInterval(() => {
      if (check()) { clearInterval(interval); resolve(true); }
    }, 100);
    setTimeout(() => { clearInterval(interval); resolve(false); }, timeoutMs);
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd test-harness && npx vitest run src/__tests__/conversation.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add test-harness/src/conversation.ts test-harness/src/__tests__/conversation.test.ts
git commit -m "feat(test-harness): add conversation runner with full loop orchestration"
```

---

## Task 7: Build the evaluator

Post-session LLM judge that grades transcripts against success/failure criteria.

**Files:**
- Create: `test-harness/src/evaluator.ts`
- Create: `test-harness/src/__tests__/evaluator.test.ts`

**Step 1: Write the failing test**

```typescript
// test-harness/src/__tests__/evaluator.test.ts
import { describe, it, expect } from 'vitest';
import { Evaluator } from '../evaluator.js';
import type { Scenario, Turn } from '../types.js';

describe('Evaluator', () => {
  it('builds a valid evaluation prompt from scenario and transcript', () => {
    const scenario: Scenario = {
      name: 'test',
      persona: { prompt: 'Frustrated customer', voice_style: 'impatient', max_turns: 5 },
      goal: 'Get explanation of score drop',
      success_criteria: ['Explains cause', 'Suggests action'],
      failure_conditions: ['Hallucination', 'Loops 3 times'],
      timing: { max_response_latency_ms: 5000, max_silence_gap_ms: 8000 },
    };

    const turns: Turn[] = [
      { role: 'user', text: 'Why did my score drop?', timestamp: 1000 },
      { role: 'assistant', text: 'Your score dropped because of a late payment.', timestamp: 2000 },
    ];

    const prompt = Evaluator.buildPrompt(scenario, turns);
    expect(prompt).toContain('Frustrated customer');
    expect(prompt).toContain('Why did my score drop?');
    expect(prompt).toContain('late payment');
    expect(prompt).toContain('Explains cause');
    expect(prompt).toContain('"accuracy"');
  });

  it('parses valid evaluator output', () => {
    const raw = JSON.stringify({
      accuracy: 4,
      conciseness: 5,
      information_gathering: 3,
      hallucination_free: 5,
      tone_matching: 4,
      goal_completion: 4,
      overall: 'pass',
      notes: 'Good response but could ask more probing questions.',
    });
    const result = Evaluator.parseScores(raw);
    expect(result.accuracy).toBe(4);
    expect(result.overall).toBe('pass');
  });

  it('returns defaults on unparseable output', () => {
    const result = Evaluator.parseScores('garbage');
    expect(result.overall).toBe('error');
    expect(result.error).toContain('unparseable');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd test-harness && npx vitest run src/__tests__/evaluator.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// test-harness/src/evaluator.ts
import type { Scenario, Turn } from './types.js';

interface LlmProvider {
  chat(messages: { role: string; content: string }[]): Promise<string>;
}

export interface EvalScores {
  accuracy: number;
  conciseness: number;
  information_gathering: number;
  hallucination_free: number;
  tone_matching: number;
  goal_completion: number;
  overall: 'pass' | 'fail' | 'error';
  notes?: string;
  error?: string;
}

export class Evaluator {
  private provider: LlmProvider;

  constructor(provider: LlmProvider) {
    this.provider = provider;
  }

  async evaluate(scenario: Scenario, turns: Turn[]): Promise<EvalScores> {
    const prompt = Evaluator.buildPrompt(scenario, turns);
    const raw = await this.provider.chat([{ role: 'user', content: prompt }]);
    return Evaluator.parseScores(raw);
  }

  static buildPrompt(scenario: Scenario, turns: Turn[]): string {
    const transcript = turns
      .map((t) => `${t.role.toUpperCase()}: ${t.text}`)
      .join('\n');

    return `You are evaluating an AI voice assistant's performance in a test conversation.

PERSONA: ${scenario.persona.prompt}
GOAL: ${scenario.goal}

SUCCESS CRITERIA:
${scenario.success_criteria.map((c) => `- ${c}`).join('\n')}

FAILURE CONDITIONS:
${scenario.failure_conditions.map((c) => `- ${c}`).join('\n')}

TRANSCRIPT:
${transcript}

Score each dimension 1-5 (1=terrible, 5=excellent) and determine overall pass/fail.

Respond with JSON only:
{
  "accuracy": <1-5>,
  "conciseness": <1-5>,
  "information_gathering": <1-5>,
  "hallucination_free": <1-5>,
  "tone_matching": <1-5>,
  "goal_completion": <1-5>,
  "overall": "pass" or "fail",
  "notes": "brief explanation"
}`;
  }

  static parseScores(raw: string): EvalScores {
    try {
      const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return {
        accuracy: parsed.accuracy ?? 0,
        conciseness: parsed.conciseness ?? 0,
        information_gathering: parsed.information_gathering ?? 0,
        hallucination_free: parsed.hallucination_free ?? 0,
        tone_matching: parsed.tone_matching ?? 0,
        goal_completion: parsed.goal_completion ?? 0,
        overall: parsed.overall === 'pass' ? 'pass' : parsed.overall === 'fail' ? 'fail' : 'error',
        notes: parsed.notes,
      };
    } catch {
      return {
        accuracy: 0, conciseness: 0, information_gathering: 0,
        hallucination_free: 0, tone_matching: 0, goal_completion: 0,
        overall: 'error',
        error: `LLM output unparseable: ${raw.slice(0, 100)}`,
      };
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd test-harness && npx vitest run src/__tests__/evaluator.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add test-harness/src/evaluator.ts test-harness/src/__tests__/evaluator.test.ts
git commit -m "feat(test-harness): add post-session LLM evaluator with structured scoring"
```

---

## Task 8: Create the starter scenario library

Five scenarios covering the core test buckets.

**Files:**
- Create: `test-harness/scenarios/happy-path.json`
- Create: `test-harness/scenarios/frustrated-user.json`
- Create: `test-harness/scenarios/vague-user.json`
- Create: `test-harness/scenarios/interrupter.json`
- Create: `test-harness/scenarios/confused-user.json`

**Step 1: Create all five scenario files**

```json
// test-harness/scenarios/happy-path.json
{
  "name": "happy_path_product_inquiry",
  "persona": {
    "prompt": "You are a polite, professional prospect interested in learning about the product. You ask clear questions, listen to answers, and follow up logically. You are ready to buy if the pitch is good.",
    "voice_style": "calm, measured, professional",
    "max_turns": 6
  },
  "goal": "Understand the product's main value proposition and pricing.",
  "success_criteria": [
    "AI explains the core product benefit",
    "AI provides pricing or directs to pricing",
    "AI asks a qualifying question",
    "Conversation feels natural and complete"
  ],
  "failure_conditions": [
    "No response within 10 seconds",
    "AI hallucinates specific pricing not in its training",
    "AI fails to ask any questions about the prospect's needs"
  ],
  "timing": {
    "max_response_latency_ms": 5000,
    "max_silence_gap_ms": 8000
  }
}
```

```json
// test-harness/scenarios/frustrated-user.json
{
  "name": "frustrated_user_score_drop",
  "persona": {
    "prompt": "You are a frustrated customer who just noticed a 40-point credit score drop. You are upset, speak in short clipped sentences, and interrupt long explanations. You want a direct answer, not a runaround. You do not volunteer account details unless asked directly.",
    "voice_style": "impatient, clipped sentences, occasionally interrupting",
    "max_turns": 8
  },
  "goal": "Get a clear explanation of why the score dropped and a concrete next step.",
  "success_criteria": [
    "AI explains at least one plausible cause for the score drop",
    "AI suggests a specific next action the user can take",
    "AI does not dismiss the user's frustration",
    "AI asks for relevant account details to investigate"
  ],
  "failure_conditions": [
    "No response within 10 seconds",
    "AI produces a hallucinated policy or regulation name",
    "Conversation loops with the same exchange repeated 3+ times",
    "AI ignores the user's emotional state entirely"
  ],
  "timing": {
    "max_response_latency_ms": 5000,
    "max_silence_gap_ms": 8000
  }
}
```

```json
// test-harness/scenarios/vague-user.json
{
  "name": "vague_user_unclear_request",
  "persona": {
    "prompt": "You are a customer who doesn't quite know what they want. You say things like 'I just want to talk to someone about my thing' and 'you know, the thing I signed up for.' You give incomplete information and need to be guided through the conversation with specific questions.",
    "voice_style": "meandering, uncertain, lots of filler words",
    "max_turns": 8
  },
  "goal": "The AI should identify your actual need through patient questioning.",
  "success_criteria": [
    "AI asks at least 2 clarifying questions",
    "AI narrows down the user's need to a specific topic",
    "AI does not make assumptions without checking",
    "Conversation reaches a concrete next step"
  ],
  "failure_conditions": [
    "AI assumes the user's intent without asking",
    "AI gives up or redirects to a different channel",
    "Conversation goes 6+ turns without progress toward identifying the need"
  ],
  "timing": {
    "max_response_latency_ms": 5000,
    "max_silence_gap_ms": 10000
  }
}
```

```json
// test-harness/scenarios/interrupter.json
{
  "name": "interrupter_mid_response",
  "persona": {
    "prompt": "You are a fast-talking customer who interrupts the AI mid-sentence. After the AI starts responding, you cut in with 'wait wait' or 'hold on' or 'that's not what I asked.' You never let the AI finish a response longer than 2 sentences before redirecting. You have a specific question and you want only that answered.",
    "voice_style": "fast, assertive, interrupts frequently",
    "max_turns": 8
  },
  "goal": "Get a one-sentence answer to: what is the cancellation policy?",
  "success_criteria": [
    "AI eventually provides a concise answer about cancellation",
    "AI adapts to the interruption pattern (shorter responses)",
    "AI does not repeat the same long explanation after being interrupted"
  ],
  "failure_conditions": [
    "AI gives the same long response after 2+ interruptions",
    "AI never provides the requested information",
    "AI becomes confused and stops responding coherently"
  ],
  "timing": {
    "max_response_latency_ms": 5000,
    "max_silence_gap_ms": 6000
  }
}
```

```json
// test-harness/scenarios/confused-user.json
{
  "name": "confused_user_technical_terms",
  "persona": {
    "prompt": "You are an elderly customer who does not understand technical or financial jargon. When the AI uses terms like 'utilization ratio', 'credit bureau', or 'hard inquiry', you say things like 'what does that mean?' or 'I don't understand.' You need everything explained in plain language. You are patient but persistent.",
    "voice_style": "slow, deliberate, asks for clarification often",
    "max_turns": 8
  },
  "goal": "Get a plain-language explanation of what happened to your account.",
  "success_criteria": [
    "AI rephrases technical terms when asked",
    "AI uses analogies or simple language in explanations",
    "AI confirms understanding before moving forward",
    "The user eventually says they understand"
  ],
  "failure_conditions": [
    "AI keeps using jargon after being asked to simplify",
    "AI becomes condescending or overly simplified to the point of inaccuracy",
    "AI fails to check if the user understood"
  ],
  "timing": {
    "max_response_latency_ms": 5000,
    "max_silence_gap_ms": 12000
  }
}
```

**Step 2: Commit**

```bash
git add test-harness/scenarios/
git commit -m "feat(test-harness): add 5 starter conversation scenarios"
```

---

## Task 9: Build the LLM provider adapter

Thin wrapper that lets the persona brain and evaluator call any LLM. Start with OpenAI since the repo already uses it.

**Files:**
- Create: `test-harness/src/llm-provider.ts`
- Create: `test-harness/src/__tests__/llm-provider.test.ts`

**Step 1: Write the failing test**

```typescript
// test-harness/src/__tests__/llm-provider.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../llm-provider.js';

describe('OpenAIProvider', () => {
  it('formats messages into OpenAI chat completion request body', () => {
    const provider = new OpenAIProvider('test-key', 'gpt-4o');
    const body = OpenAIProvider.buildRequestBody(
      [{ role: 'user', content: 'Hello' }],
      'gpt-4o',
    );
    expect(body.model).toBe('gpt-4o');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe('Hello');
    expect(body.temperature).toBe(0.7);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd test-harness && npx vitest run src/__tests__/llm-provider.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// test-harness/src/llm-provider.ts

interface ChatMessage {
  role: string;
  content: string;
}

export interface LlmProvider {
  chat(messages: ChatMessage[]): Promise<string>;
}

export class OpenAIProvider implements LlmProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'gpt-4o') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const body = OpenAIProvider.buildRequestBody(messages, this.model);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI chat failed (${res.status}): ${text}`);
    }
    const data = await res.json() as { choices: { message: { content: string } }[] };
    return data.choices[0].message.content;
  }

  static buildRequestBody(messages: ChatMessage[], model: string) {
    return {
      model,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd test-harness && npx vitest run src/__tests__/llm-provider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test-harness/src/llm-provider.ts test-harness/src/__tests__/llm-provider.test.ts
git commit -m "feat(test-harness): add OpenAI LLM provider for persona brain and evaluator"
```

---

## Task 10: Build the CLI runner and report generator

The entry point that loads scenarios, runs conversations, and produces the JSON report.

**Files:**
- Create: `test-harness/src/run.ts`
- Create: `test-harness/src/report.ts`
- Create: `test-harness/src/__tests__/report.test.ts`

**Step 1: Write the report test**

```typescript
// test-harness/src/__tests__/report.test.ts
import { describe, it, expect } from 'vitest';
import { ReportGenerator } from '../report.js';
import type { SessionResult } from '../types.js';

describe('ReportGenerator', () => {
  it('aggregates session results into a run report', () => {
    const sessions: SessionResult[] = [
      {
        scenario: 'happy_path',
        verdict: 'pass',
        turns: [],
        metrics: { turn_count: 4, avg_latency_ms: 900, max_latency_ms: 1200, max_silence_gap_ms: 500, transcript_match_rate: 1.0 },
      },
      {
        scenario: 'frustrated_user',
        verdict: 'fail',
        turns: [],
        metrics: { turn_count: 6, avg_latency_ms: 2100, max_latency_ms: 3500, max_silence_gap_ms: 800, transcript_match_rate: 0.9 },
      },
      {
        scenario: 'happy_path',
        verdict: 'pass',
        turns: [],
        metrics: { turn_count: 3, avg_latency_ms: 800, max_latency_ms: 1000, max_silence_gap_ms: 400, transcript_match_rate: 1.0 },
      },
    ];

    const report = ReportGenerator.generate(sessions, 'wss://viracue.ai/openai-realtime-proxy', 'pass');
    expect(report.scenarios_total).toBe(3);
    expect(report.scenarios_passed).toBe(2);
    expect(report.scenarios_failed).toBe(1);
    expect(report.avg_latency_ms).toBe(1267); // (900+2100+800)/3
    expect(report.playwright_validation).toBe('pass');
    expect(report.run_id).toBeTruthy();
  });

  it('calculates p95 latency', () => {
    const sessions: SessionResult[] = Array.from({ length: 20 }, (_, i) => ({
      scenario: 'test',
      verdict: 'pass' as const,
      turns: [],
      metrics: {
        turn_count: 4,
        avg_latency_ms: 1000 + i * 100, // 1000, 1100, ..., 2900
        max_latency_ms: 1000 + i * 100,
        max_silence_gap_ms: 500,
        transcript_match_rate: 1.0,
      },
    }));

    const report = ReportGenerator.generate(sessions, 'wss://test', 'pass');
    // p95 of [1000..2900] = value at index 19 (95th percentile of 20 items)
    expect(report.p95_latency_ms).toBeGreaterThanOrEqual(2800);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd test-harness && npx vitest run src/__tests__/report.test.ts`
Expected: FAIL

**Step 3: Write the report generator**

```typescript
// test-harness/src/report.ts
import { randomUUID } from 'node:crypto';
import type { RunReport, SessionResult } from './types.js';

export class ReportGenerator {
  static generate(
    sessions: SessionResult[],
    target: string,
    playwrightResult: 'pass' | 'fail' | 'skip',
  ): RunReport {
    const passed = sessions.filter((s) => s.verdict === 'pass').length;
    const latencies = sessions.map((s) => s.metrics.avg_latency_ms).filter((l) => l > 0);
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

    const sorted = [...latencies].sort((a, b) => a - b);
    const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
    const p95 = sorted.length ? sorted[Math.max(0, p95Index)] : 0;

    return {
      run_id: randomUUID(),
      timestamp: new Date().toISOString(),
      target,
      scenarios_total: sessions.length,
      scenarios_passed: passed,
      scenarios_failed: sessions.length - passed,
      avg_latency_ms: avgLatency,
      p95_latency_ms: p95,
      playwright_validation: playwrightResult,
      sessions,
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd test-harness && npx vitest run src/__tests__/report.test.ts`
Expected: PASS

**Step 5: Write the CLI runner**

```typescript
// test-harness/src/run.ts
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuthClient } from './auth.js';
import { TtsEngine } from './tts-engine.js';
import { PersonaBrain } from './persona-brain.js';
import { ConversationRunner } from './conversation.js';
import { Evaluator } from './evaluator.js';
import { OpenAIProvider } from './llm-provider.js';
import { ReportGenerator } from './report.js';
import type { Scenario, SessionResult } from './types.js';

// --- Config from env ---
const TARGET_URL = process.env.HARNESS_TARGET_URL ?? 'https://viracue.ai';
const EMAIL = process.env.HARNESS_EMAIL ?? '';
const PASSWORD = process.env.HARNESS_PASSWORD ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const RUNS_PER_SCENARIO = parseInt(process.env.HARNESS_RUNS ?? '20', 10);
const SCENARIO_FILTER = process.env.HARNESS_SCENARIO ?? '';
const SKIP_EVALUATOR = process.env.HARNESS_SKIP_EVAL === 'true';

async function main() {
  // Validate config
  if (!EMAIL || !PASSWORD) throw new Error('Set HARNESS_EMAIL and HARNESS_PASSWORD');
  if (!OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY');

  console.log(`\n=== RTAA Voice Test Harness ===`);
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Runs per scenario: ${RUNS_PER_SCENARIO}`);

  // Load scenarios
  const scenariosDir = resolve(import.meta.dirname ?? '.', '..', 'scenarios');
  const scenarioFiles = readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));
  const scenarios: Scenario[] = scenarioFiles
    .map((f) => JSON.parse(readFileSync(join(scenariosDir, f), 'utf-8')) as Scenario)
    .filter((s) => !SCENARIO_FILTER || s.name.includes(SCENARIO_FILTER));

  console.log(`Loaded ${scenarios.length} scenarios\n`);

  // Init services
  const auth = new AuthClient(TARGET_URL);
  await auth.login(EMAIL, PASSWORD);
  console.log('Authenticated\n');

  const tts = new TtsEngine(OPENAI_API_KEY);
  const llm = new OpenAIProvider(OPENAI_API_KEY, 'gpt-4o');
  const evaluator = SKIP_EVALUATOR ? null : new Evaluator(llm);
  const wsUrl = AuthClient.wsUrl(TARGET_URL);

  // Run conversations
  const sessions: SessionResult[] = [];
  let total = 0;
  const grandTotal = scenarios.length * RUNS_PER_SCENARIO;

  for (const scenario of scenarios) {
    for (let run = 0; run < RUNS_PER_SCENARIO; run++) {
      total++;
      const brain = new PersonaBrain(llm, scenario);

      console.log(`[${total}/${grandTotal}] ${scenario.name} (run ${run + 1}/${RUNS_PER_SCENARIO})`);

      const result = await ConversationRunner.run({
        tts,
        brain,
        wsUrl,
        authToken: auth.getToken(),
        scenario,
      });

      // Run evaluator if enabled
      if (evaluator && result.verdict !== 'error') {
        const scores = await evaluator.evaluate(scenario, result.turns);
        result.evaluator_scores = scores as unknown as Record<string, number>;
      }

      console.log(`  -> ${result.verdict} (${result.metrics.turn_count} turns, ${result.metrics.avg_latency_ms}ms avg)\n`);
      sessions.push(result);
    }
  }

  // Generate report
  const report = ReportGenerator.generate(sessions, wsUrl, 'skip');

  // Write report
  mkdirSync(resolve(import.meta.dirname ?? '.', '..', 'reports'), { recursive: true });
  const reportPath = resolve(import.meta.dirname ?? '.', '..', 'reports', `report-${report.run_id}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Summary
  console.log(`\n=== Results ===`);
  console.log(`Total: ${report.scenarios_total}`);
  console.log(`Passed: ${report.scenarios_passed}`);
  console.log(`Failed: ${report.scenarios_failed}`);
  console.log(`Avg latency: ${report.avg_latency_ms}ms`);
  console.log(`P95 latency: ${report.p95_latency_ms}ms`);
  console.log(`\nReport: ${reportPath}\n`);

  // Exit with non-zero if any failures
  process.exit(report.scenarios_failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Harness failed:', err);
  process.exit(2);
});
```

**Step 6: Commit**

```bash
git add test-harness/src/run.ts test-harness/src/report.ts test-harness/src/__tests__/report.test.ts
git commit -m "feat(test-harness): add CLI runner and JSON report generator"
```

---

## Task 11: Add the Playwright mic-connectivity validator

Single Playwright test that verifies the extension loads, widget appears, and WebSocket connects.

**Files:**
- Create: `test-harness/src/playwright-validator.ts`

**Step 1: Write the validator**

This reuses the existing Playwright fixtures pattern from `tests/extension/fixtures.ts`.

```typescript
// test-harness/src/playwright-validator.ts
import { chromium, type BrowserContext } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface ValidationResult {
  passed: boolean;
  checks: Record<string, boolean>;
  errors: string[];
  screenshot?: string;
}

export async function validateMicConnectivity(
  appUrl: string,
  extensionPath: string,
): Promise<ValidationResult> {
  const checks: Record<string, boolean> = {
    extension_loaded: false,
    widget_visible: false,
    no_console_errors: true,
  };
  const errors: string[] = [];
  const userDataDir = mkdtempSync(join(tmpdir(), 'rtaa-harness-'));

  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // Extensions require headed mode
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    // Wait for service worker (extension loaded)
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    checks.extension_loaded = true;

    // Navigate to app
    const page = context.pages()[0] ?? await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('favicon')) {
          errors.push(text);
          checks.no_console_errors = false;
        }
      }
    });

    await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    // Check for widget injection
    try {
      await page.waitForSelector('#rtaa-widgets', { state: 'attached', timeout: 10_000 });
      checks.widget_visible = true;
    } catch {
      errors.push('Widget #rtaa-widgets not found within 10s');
    }

    // Screenshot for evidence
    const screenshotPath = join(userDataDir, 'validation.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const passed = Object.values(checks).every(Boolean);
    return { passed, checks, errors, screenshot: screenshotPath };
  } catch (err) {
    errors.push(String(err));
    return { passed: false, checks, errors };
  } finally {
    await context?.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
```

**Step 2: Commit**

```bash
git add test-harness/src/playwright-validator.ts
git commit -m "feat(test-harness): add Playwright mic-connectivity validator"
```

---

## Task 12: Wire Playwright validation into the CLI runner

Update `run.ts` to optionally run the Playwright check before conversations.

**Files:**
- Modify: `test-harness/src/run.ts`

**Step 1: Add the --validate flag and wire it in**

Add these lines to `run.ts` after the auth section and before the conversation loop:

```typescript
// After auth, before conversation loop — add:
import { validateMicConnectivity } from './playwright-validator.js';

const SKIP_PLAYWRIGHT = process.env.HARNESS_SKIP_PLAYWRIGHT === 'true';
const EXTENSION_PATH = process.env.HARNESS_EXTENSION_PATH ?? '';

let playwrightResult: 'pass' | 'fail' | 'skip' = 'skip';

if (!SKIP_PLAYWRIGHT && EXTENSION_PATH) {
  console.log('Running Playwright mic-connectivity check...');
  const validation = await validateMicConnectivity(TARGET_URL, EXTENSION_PATH);
  playwrightResult = validation.passed ? 'pass' : 'fail';
  console.log(`Playwright: ${playwrightResult}`);
  if (!validation.passed) {
    console.log('Checks:', validation.checks);
    console.log('Errors:', validation.errors);
  }
  console.log('');
}
```

Then update the report generation to use `playwrightResult` instead of `'skip'`.

**Step 2: Commit**

```bash
git add test-harness/src/run.ts
git commit -m "feat(test-harness): wire Playwright validation into CLI runner"
```

---

## Task 13: Add environment configuration and README

**Files:**
- Create: `test-harness/.env.example`
- Create: `test-harness/README.md`

**Step 1: Create .env.example**

```bash
# Required
OPENAI_API_KEY=sk-...
HARNESS_EMAIL=test@example.com
HARNESS_PASSWORD=your-password
HARNESS_TARGET_URL=https://viracue.ai

# Optional
HARNESS_RUNS=20                          # Runs per scenario (default: 20)
HARNESS_SCENARIO=                        # Filter scenarios by name substring
HARNESS_SKIP_EVAL=false                  # Skip LLM evaluator (faster runs)
HARNESS_SKIP_PLAYWRIGHT=false            # Skip browser connectivity check
HARNESS_EXTENSION_PATH=../chrome-extension  # Path to built extension
```

**Step 2: Create README.md**

```markdown
# RTAA Voice Test Harness

Autonomous AI-to-AI voice conversation testing for ViraCue's training simulator.

## How it works

1. Connects to ViraCue's `/openai-realtime-proxy` WebSocket
2. A persona brain (LLM) generates natural utterances
3. OpenAI TTS converts utterances to PCM16 24kHz audio
4. Audio is streamed over WebSocket as `input_audio_buffer.append` messages
5. AI responses are captured via transcript events
6. Persona brain decides next action based on conversation history
7. Post-session evaluator grades the transcript

## Quick start

```bash
cp .env.example .env
# Fill in your credentials

npm install
npm run harness
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | OpenAI API key for TTS + persona brain |
| `HARNESS_EMAIL` | Yes | - | ViraCue login email |
| `HARNESS_PASSWORD` | Yes | - | ViraCue login password |
| `HARNESS_TARGET_URL` | No | `https://viracue.ai` | Target deployment URL |
| `HARNESS_RUNS` | No | `20` | Runs per scenario |
| `HARNESS_SCENARIO` | No | - | Filter by scenario name |
| `HARNESS_SKIP_EVAL` | No | `false` | Skip post-session evaluator |
| `HARNESS_SKIP_PLAYWRIGHT` | No | `false` | Skip browser check |
| `HARNESS_EXTENSION_PATH` | No | - | Path to Chrome extension |

## Adding scenarios

Create a JSON file in `scenarios/`:

```json
{
  "name": "my_scenario",
  "persona": {
    "prompt": "You are...",
    "voice_style": "calm, professional",
    "max_turns": 6
  },
  "goal": "Achieve X.",
  "success_criteria": ["Criterion 1", "Criterion 2"],
  "failure_conditions": ["Condition 1"],
  "timing": {
    "max_response_latency_ms": 5000,
    "max_silence_gap_ms": 8000
  }
}
```

## Reports

Reports are saved to `reports/report-<uuid>.json` with per-session verdicts, latency metrics, transcripts, and evaluator scores.
```

**Step 3: Commit**

```bash
git add test-harness/.env.example test-harness/README.md
git commit -m "docs(test-harness): add env config and README"
```

---

## Task 14: Integration smoke test against a live target

This is not a unit test — it's the first real end-to-end run.

**Step 1: Set up environment**

```bash
cd test-harness
cp .env.example .env
# Edit .env with real credentials
```

**Step 2: Run a single scenario, single run**

```bash
HARNESS_RUNS=1 HARNESS_SCENARIO=happy_path HARNESS_SKIP_EVAL=true HARNESS_SKIP_PLAYWRIGHT=true npm run harness
```

Expected: Conversation completes, report JSON written, exit code 0 or 1.

**Step 3: Inspect the report**

```bash
cat reports/report-*.json | jq '.sessions[0] | {scenario, verdict, turns: (.turns | length), avg_latency_ms: .metrics.avg_latency_ms}'
```

Expected: `{ "scenario": "happy_path_product_inquiry", "verdict": "pass" or "fail", "turns": 4-6, "avg_latency_ms": <number> }`

**Step 4: Fix any issues discovered**

Common issues:
- Auth endpoint returns different shape → update `auth.ts`
- WebSocket expects different first message → update `ws-injector.ts`
- VAD doesn't trigger (silence detection) → may need explicit `input_audio_buffer.commit` after streaming
- Transcript events use different event names → check exact server whitelist

**Step 5: Run full suite (5 scenarios x 20 runs = 100 sessions)**

```bash
npm run harness
```

Expected: Runs 100 sessions, produces report, completes in < 30 minutes.

**Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(test-harness): integration fixes from first live run"
```

---

## Summary

| Task | What it builds | Tests |
|------|---------------|-------|
| 1 | Scaffold + deps | - |
| 2 | WS Injector (protocol client) | 4 unit tests |
| 3 | TTS Engine (text → PCM16) | 2 unit tests |
| 4 | Persona Brain (LLM decisions) | 5 unit tests |
| 5 | Auth Client (login + session) | 3 unit tests |
| 6 | Conversation Runner (loop) | 3 unit tests |
| 7 | Evaluator (post-session grading) | 3 unit tests |
| 8 | 5 Scenario files | - |
| 9 | LLM Provider adapter | 1 unit test |
| 10 | CLI Runner + Report generator | 2 unit tests |
| 11 | Playwright mic-connectivity | - |
| 12 | Wire Playwright into CLI | - |
| 13 | Env config + README | - |
| 14 | Integration smoke test | Live run |

**Total: 14 tasks, 23 unit tests, 1 integration test**

Estimated effort: Tasks 1-13 are pure construction (~3-4 days). Task 14 is integration debugging (~1-2 days). Fits the 1-week Phase 1 deadline.
