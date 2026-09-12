/**
 * Public session ingestion API for external host integrations.
 *
 * Host adapters keep their own durable session log and use this recorder to
 * project selected events into context-mode's analytics database. The recorder
 * owns database lifecycle and never exposes the SQLite implementation.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventPriority, type SessionEvent } from "../types.js";
import { resolveSessionDbPath, SessionDB, type EventBytes } from "./db.js";
import type { AttributionSource } from "./project-attribution.js";

/** One event supplied by an external host adapter. */
export interface SessionRecorderEvent {
  /** Stable event type used by timeline and resume queries. */
  readonly type: string;
  /** Event category used by analytics and priority filters. */
  readonly category: string;
  /** Serialized event payload. */
  readonly data: string;
  /** Retention priority; defaults to {@link EventPriority.NORMAL}. */
  readonly priority?: number;
  /** Bytes kept out of the model context for this event. */
  readonly bytesAvoided?: number;
  /** Bytes returned to the model for this event. */
  readonly bytesReturned?: number;
}

/** Configuration for one project-scoped recorder. */
export interface SessionRecorderOptions {
  /** Absolute or relative project directory used for DB sharding and attribution. */
  readonly projectDir: string;
  /** Context-mode storage root; the recorder uses its `sessions` child directory. */
  readonly storageDir: string;
  /** Attribution label stored on projected events. */
  readonly source?: AttributionSource;
  /** Attribution confidence stored on projected events. */
  readonly confidence?: number;
}

/** Stable host-facing session projection API. */
export interface SessionRecorder {
  /** Ensure a session metadata row exists before tool-side analytics arrive. */
  ensureSession(sessionId: string): void;
  /** Append one projected event to the session database. */
  append(sessionId: string, event: SessionRecorderEvent, sourceHook?: string): void;
  /** Append several projected events in one database transaction. */
  appendBatch(sessionId: string, events: readonly SessionRecorderEvent[], sourceHook?: string): void;
  /** Close the recorder's database connection. */
  close(): void;
}

/**
 * Open a project-scoped recorder for an external host integration.
 *
 * @param options - storage, attribution, and project settings.
 * @returns an owned recorder; callers must invoke `close()` during teardown.
 */
export function createSessionRecorder(options: SessionRecorderOptions): SessionRecorder {
  const projectDir = resolve(options.projectDir);
  const storageDir = resolve(options.storageDir);
  const sessionsDir = join(storageDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const source: AttributionSource = options.source ?? "unknown";
  const confidenceValue = options.confidence ?? 1;
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 1;
  const dbPath = resolveSessionDbPath({
    projectDir,
    sessionsDir,
  });
  const db = new SessionDB({ dbPath });

  const ensureSession = (sessionId: string): void => {
    db.ensureSession(sessionId, projectDir);
  };

  const toDbEvent = (event: SessionRecorderEvent): Omit<SessionEvent, "data_hash"> & { data_hash?: string } => ({
    type: event.type,
    category: event.category,
    data: event.data,
    priority: event.priority ?? EventPriority.NORMAL,
    project_dir: projectDir,
    attribution_source: source,
    attribution_confidence: confidence,
  });

  const append = (sessionId: string, event: SessionRecorderEvent, sourceHook = source): void => {
    ensureSession(sessionId);
    const bytes: EventBytes = {
      bytesAvoided: event.bytesAvoided,
      bytesReturned: event.bytesReturned,
    };
    db.insertEvent(sessionId, toDbEvent(event), sourceHook, {
      projectDir,
      source,
      confidence,
    }, bytes);
  };

  const appendBatch = (
    sessionId: string,
    events: readonly SessionRecorderEvent[],
    sourceHook = source,
  ): void => {
    if (events.length === 0) return;
    ensureSession(sessionId);
    const bytes = events.map(event => ({
      bytesAvoided: event.bytesAvoided,
      bytesReturned: event.bytesReturned,
    }));
    db.bulkInsertEvents(
      sessionId,
      events.map(toDbEvent) as SessionEvent[],
      sourceHook,
      events.map(() => ({ projectDir, source, confidence })),
      bytes,
    );
  };

  return {
    ensureSession,
    append,
    appendBatch,
    close: () => db.close(),
  };
}

export type { EventBytes } from "./db.js";
