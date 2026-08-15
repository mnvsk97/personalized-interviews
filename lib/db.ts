import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Experience, GeneratedConfig, SessionRecord } from "./types";

type SessionRow = {
  id: string;
  participant_id: string | null;
  previous_session_id: string | null;
  experience: Experience;
  status: string;
  profile: string;
  config: string;
  conversation_id: string | null;
  conversation_url: string | null;
  pal_id: string | null;
  objectives_id: string | null;
  summary: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
};

type Participant = {
  id: string;
  email: string;
  displayName: string;
};

let database: Database.Database | undefined;

function json<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function openDatabase() {
  if (database) return database;
  const configured = process.env.DATABASE_URL || "./data/personalized-interviews.db";
  const filename = configured === ":memory:" ? configured : resolve(/* turbopackIgnore: true */ configured);
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  database = new Database(filename);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      email_normalized TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      participant_id TEXT REFERENCES participants(id),
      previous_session_id TEXT REFERENCES sessions(id),
      experience TEXT NOT NULL CHECK (experience IN ('surrogacy', 'hcp')),
      status TEXT NOT NULL DEFAULT 'created',
      profile TEXT NOT NULL,
      config TEXT NOT NULL,
      conversation_id TEXT,
      conversation_url TEXT,
      pal_id TEXT,
      objectives_id TEXT,
      summary TEXT,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      external_event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      arguments TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, external_event_id)
    );
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, key)
    );
    CREATE TABLE IF NOT EXISTS callback_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      preferred_time TEXT NOT NULL,
      reason TEXT NOT NULL,
      candidate_message TEXT NOT NULL,
      email_status TEXT NOT NULL DEFAULT 'pending_email',
      email_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  database.exec("DROP TABLE IF EXISTS feedback");
  const sessionColumns = new Set((database.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(({ name }) => name));
  if (!sessionColumns.has("participant_id")) database.exec("ALTER TABLE sessions ADD COLUMN participant_id TEXT REFERENCES participants(id)");
  if (!sessionColumns.has("previous_session_id")) database.exec("ALTER TABLE sessions ADD COLUMN previous_session_id TEXT REFERENCES sessions(id)");
  if (!sessionColumns.has("pal_id")) database.exec("ALTER TABLE sessions ADD COLUMN pal_id TEXT");
  if (!sessionColumns.has("objectives_id")) database.exec("ALTER TABLE sessions ADD COLUMN objectives_id TEXT");
  database.exec(`
    CREATE INDEX IF NOT EXISTS sessions_participant_experience_idx ON sessions(participant_id, experience, created_at);
  `);
  backfillParticipants(database);
  return database;
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function looksLikeEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function findParticipant(db: Database.Database, email: string) {
  return db.prepare(`
    SELECT id, email_normalized AS email, display_name AS displayName
    FROM participants
    WHERE email_normalized = ?
  `).get(email) as Participant | undefined;
}

function getOrCreateParticipant(db: Database.Database, input: { id: string; email: string; displayName?: string }) {
  const email = normalizeEmail(input.email);
  const displayName = input.displayName?.trim() || "";
  const existing = findParticipant(db, email);

  if (existing) {
    db.prepare(`
      UPDATE participants
      SET display_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(displayName || existing.displayName, existing.id);

    return { ...existing, displayName: displayName || existing.displayName };
  }

  db.prepare(`
    INSERT INTO participants (id, email_normalized, display_name)
    VALUES (?, ?, ?)
  `).run(input.id, email, displayName);

  return { id: input.id, email, displayName };
}

function backfillParticipants(db: Database.Database) {
  const rows = db.prepare("SELECT id, profile FROM sessions WHERE participant_id IS NULL").all() as Array<{ id: string; profile: string }>;
  const update = db.prepare("UPDATE sessions SET participant_id = ? WHERE id = ?");
  const backfill = db.transaction(() => {
    for (const row of rows) {
      const profile = json<Record<string, unknown>>(row.profile, {});
      if (typeof profile.email !== "string") continue;
      const email = normalizeEmail(profile.email);
      if (!looksLikeEmail(email)) continue;
      const participant = getOrCreateParticipant(db, {
        id: randomUUID(),
        email,
        displayName: typeof profile.name === "string" ? profile.name : "",
      });
      update.run(participant.id, row.id);
    }
  });
  backfill();
}

function hydrate(row: SessionRow): SessionRecord {
  const db = openDatabase();
  const answers = db.prepare("SELECT key, value, confirmed FROM answers WHERE session_id = ? ORDER BY id").all(row.id) as Array<{ key: string; value: string; confirmed: number }>;
  return {
    id: row.id,
    ...(row.participant_id ? { participantId: row.participant_id } : {}),
    ...(row.previous_session_id ? { previousSessionId: row.previous_session_id } : {}),
    experience: row.experience,
    status: row.status,
    profile: json(row.profile, {}),
    config: json<GeneratedConfig>(row.config, {} as GeneratedConfig),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.conversation_url ? { conversationUrl: row.conversation_url } : {}),
    ...(row.pal_id ? { palId: row.pal_id } : {}),
    ...(row.objectives_id ? { objectivesId: row.objectives_id } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.result ? { result: json(row.result, {}) } : {}),
    answers: answers.map((answer) => ({ ...answer, confirmed: Boolean(answer.confirmed) })),
  };
}

export function createSession(input: { id: string; participantId?: string; previousSessionId?: string; experience: Experience; profile: Record<string, unknown>; config: GeneratedConfig }) {
  openDatabase().prepare("INSERT INTO sessions (id, participant_id, previous_session_id, experience, profile, config) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.id, input.participantId ?? null, input.previousSessionId ?? null, input.experience, JSON.stringify(input.profile), JSON.stringify(input.config));
  return getSession(input.id)!;
}

export function upsertParticipant(input: { id: string; email: string; displayName?: string }) {
  return getOrCreateParticipant(openDatabase(), input);
}

export function getLatestReusableSession(participantId: string, experience: Experience) {
  const row = openDatabase().prepare(`
    SELECT s.*
    FROM sessions s
    WHERE s.participant_id = ?
      AND s.experience = ?
      AND (
        s.status IN ('completed', 'escalated')
        OR EXISTS (
          SELECT 1 FROM answers a
          WHERE a.session_id = s.id AND a.confirmed = 1
        )
      )
    ORDER BY s.updated_at DESC, s.rowid DESC
    LIMIT 1
  `).get(participantId, experience) as SessionRow | undefined;

  return row ? hydrate(row) : undefined;
}

export function getConfirmedParticipantAnswers(participantId: string, experience: Experience) {
  const rows = openDatabase().prepare(`
    SELECT a.key, a.value
    FROM answers a
    JOIN sessions s ON s.id = a.session_id
    WHERE s.participant_id = ?
      AND s.experience = ?
      AND a.confirmed = 1
    ORDER BY a.updated_at DESC, a.id DESC
  `).all(participantId, experience) as Array<{ key: string; value: string }>;
  const latest = new Map<string, string>();
  for (const answer of rows) if (!latest.has(answer.key)) latest.set(answer.key, answer.value);
  return [...latest].map(([key, value]) => ({ key, value, confirmed: true as const }));
}

export function getParticipantByEmail(email: string) {
  return findParticipant(openDatabase(), normalizeEmail(email));
}

export function getSession(id: string) {
  const row = openDatabase().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? hydrate(row) : undefined;
}

export function updateSession(id: string, patch: { status?: string; conversationId?: string; conversationUrl?: string; palId?: string; objectivesId?: string; summary?: string; result?: Record<string, unknown> }) {
  const current = getSession(id);
  if (!current) return undefined;
  openDatabase().prepare(`UPDATE sessions SET status = ?, conversation_id = ?, conversation_url = ?, pal_id = ?, objectives_id = ?, summary = ?, result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    patch.status ?? current.status,
    patch.conversationId ?? current.conversationId ?? null,
    patch.conversationUrl ?? current.conversationUrl ?? null,
    patch.palId ?? current.palId ?? null,
    patch.objectivesId ?? current.objectivesId ?? null,
    patch.summary ?? current.summary ?? null,
    patch.result ? JSON.stringify(patch.result) : current.result ? JSON.stringify(current.result) : null,
    id,
  );
  return getSession(id)!;
}

export function saveAnswer(sessionId: string, key: string, value: string, confirmed: boolean) {
  openDatabase().prepare(`INSERT INTO answers (session_id, key, value, confirmed) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value, confirmed = excluded.confirmed, updated_at = CURRENT_TIMESTAMP`)
    .run(sessionId, key, value, confirmed ? 1 : 0);
}

export function saveCallbackRequest(input: { id: string; sessionId: string; phone: string; preferredTime: string; reason: string; candidateMessage: string }) {
  openDatabase().prepare("INSERT INTO callback_requests (id, session_id, phone, preferred_time, reason, candidate_message) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.id, input.sessionId, input.phone, input.preferredTime, input.reason, input.candidateMessage);
}

export function updateCallbackEmail(id: string, status: "sent" | "pending_email", emailId?: string) {
  openDatabase().prepare("UPDATE callback_requests SET email_status = ?, email_id = ? WHERE id = ?").run(status, emailId ?? null, id);
}

export function findEvent(sessionId: string, externalEventId: string) {
  const row = openDatabase().prepare("SELECT result FROM events WHERE session_id = ? AND external_event_id = ?").get(sessionId, externalEventId) as { result: string } | undefined;
  return row ? json<Record<string, unknown>>(row.result, {}) : undefined;
}

export function saveEvent(input: { sessionId: string; externalEventId: string; name: string; arguments: unknown; result: unknown }) {
  openDatabase().prepare("INSERT INTO events (session_id, external_event_id, name, arguments, result) VALUES (?, ?, ?, ?, ?)")
    .run(input.sessionId, input.externalEventId, input.name, JSON.stringify(input.arguments), JSON.stringify(input.result));
}

export function runTransaction<T>(fn: () => T): T {
  return openDatabase().transaction(fn)();
}

export function resetDatabaseForTests(filename = ":memory:") {
  database?.close();
  database = undefined;
  process.env.DATABASE_URL = filename;
}
