import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { Resend } from "resend";
import { z } from "zod";
import { createSession, findEvent, getConfirmedParticipantAnswers, getLatestReusableSession, getSession, normalizeEmail, runTransaction, saveAnswer, saveCallbackRequest, saveEvent, updateCallbackEmail, updateSession, upsertParticipant } from "./lib/db";
import { generateConfig } from "./lib/generate-config";
import { generateHcpReport } from "./lib/generate-hcp-report";
import { generateSurrogacyReport } from "./lib/generate-surrogacy-report";
import { createTavusSession, endTavusSession, surrogacyAnswerKeys } from "./lib/tavus";

loadEnv({ path: ".env.local", quiet: true });

const emailInput = z.string().trim().email().max(320);
const sessionInput = z.object({ experience: z.enum(["surrogacy", "hcp"]), profile: z.record(z.string(), z.unknown()).default({}) })
  .superRefine(({ profile }, context) => {
    if (!emailInput.safeParse(profile.email).success) context.addIssue({ code: z.ZodIssueCode.custom, path: ["profile", "email"], message: "A valid email is required" });
  });
const toolNames = ["save_interview_answer", "request_human_callback", "complete_prescreen", "record_hcp_objection", "complete_hcp_practice"] as const;
const toolInput = z.object({ sessionId: z.string().uuid(), name: z.enum(toolNames), arguments: z.record(z.string(), z.unknown()).default({}), externalEventId: z.string().min(1).max(200) });
const toolArgs = {
  save_interview_answer: z.object({ key: z.enum(surrogacyAnswerKeys), value: z.string().trim().min(1).max(4000), confirmed: z.boolean() }).strict(),
  request_human_callback: z.object({ phone: z.string().trim().min(7).max(30), preferredTime: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(1000), candidateMessage: z.string().trim().min(1).max(2000) }).strict(),
  complete_prescreen: z.object({ summary: z.string().trim().min(1).max(4000), outcome: z.enum(["continue_to_screening", "human_review", "not_completed"]), unansweredQuestions: z.array(z.string().trim().min(1)).max(20).default([]), nextSteps: z.array(z.string().trim().min(1)).min(1).max(10) }).strict(),
  record_hcp_objection: z.object({ objection: z.string().trim().min(1).max(2000), response: z.string().trim().min(1).max(4000), outcome: z.string().trim().max(1000).optional() }).strict(),
  complete_hcp_practice: z.object({
    summary: z.string().trim().min(1).max(4000),
    categoryScores: z.array(z.object({ category: z.string().trim().min(1).max(100), score: z.number().min(0).max(100), weight: z.number().positive().max(1) }).strict()).min(2).max(10)
      .refine((items) => Math.abs(items.reduce((sum, item) => sum + item.weight, 0) - 1) < 0.001, "Category weights must sum to 1"),
    transcriptEvidence: z.array(z.object({ observation: z.string().min(1), evidence: z.string().min(1) }).strict()).min(1).max(20),
    riskyStatements: z.array(z.object({ statement: z.string().min(1), risk: z.string().min(1), saferAlternative: z.string().min(1) }).strict()).max(20),
    practicePlan: z.array(z.string().trim().min(1)).min(1).max(10),
  }).strict(),
};
const allowedTools = { surrogacy: new Set(["save_interview_answer", "request_human_callback", "complete_prescreen"]), hcp: new Set(["record_hcp_objection", "complete_hcp_practice"]) };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function stringList(value: unknown, maxItems = 6) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, maxItems) : [];
}

function buildNextSessionBrief(experience: "surrogacy" | "hcp", summary: string | undefined, result: Record<string, unknown>) {
  if (experience === "hcp") {
    return {
      summary: summary || (typeof result.summary === "string" ? result.summary : ""),
      weightedScore: typeof result.weightedScore === "number" ? result.weightedScore : undefined,
      strengths: stringList(result.strengths, 5),
      improvements: stringList(result.improvements, 5),
      practicePlan: stringList(result.practicePlan, 5),
    };
  }
  const capturedDetails = Array.isArray(result.capturedDetails) ? result.capturedDetails.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const detail = item as { label?: unknown; value?: unknown };
    return typeof detail.label === "string" && typeof detail.value === "string" ? [{ label: detail.label, value: detail.value, ...(typeof (detail as { source?: unknown }).source === "string" ? { source: (detail as { source: string }).source } : {}) }] : [];
  }).slice(0, 20) : [];
  return {
    summary: summary || (typeof result.summary === "string" ? result.summary : ""),
    capturedDetails,
    unansweredQuestions: stringList(result.unansweredQuestions, 10),
    nextSteps: stringList(result.nextSteps, 6),
  };
}

function storedOrDerivedBrief(session: ReturnType<typeof getSession>, participantAnswers: Array<{ key: string; value: string; confirmed: boolean }> = []) {
  if (!session) return undefined;
  const stored = session.result?.nextSessionBrief;
  const base = stored && typeof stored === "object" && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : buildNextSessionBrief(session.experience, session.summary, session.result || {});
  const answers = participantAnswers.length ? participantAnswers : session.answers;
  if (session.experience === "hcp") {
    const objectionHistory = answers.flatMap((answer) => {
      if (!answer.confirmed || !answer.key.startsWith("objection:")) return [];
      try {
        const parsed = JSON.parse(answer.value) as { objection?: unknown; response?: unknown; outcome?: unknown };
        if (typeof parsed.objection !== "string" || typeof parsed.response !== "string") return [];
        return [{ objection: parsed.objection, response: parsed.response, ...(typeof parsed.outcome === "string" && parsed.outcome ? { outcome: parsed.outcome } : {}) }];
      } catch {
        return [];
      }
    }).slice(0, 8);
    return { ...base, objectionHistory };
  }
  const details = Array.isArray(base.capturedDetails) ? base.capturedDetails.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  const merged = new Map(details.flatMap((item) => typeof item.label === "string" ? [[item.label.toLowerCase(), item] as const] : []));
  for (const answer of answers) {
    if (!answer.confirmed) continue;
    const label = answer.key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    merged.set(label.toLowerCase(), { label, value: answer.value, source: "confirmed_answer" });
  }
  return { ...base, capturedDetails: [...merged.values()] };
}

async function executeTool(sessionId: string, name: keyof typeof toolArgs, raw: Record<string, unknown>, externalEventId: string) {
  const input = toolArgs[name].parse(raw) as Record<string, unknown>;
  if (name === "save_interview_answer") {
    saveAnswer(sessionId, input.key as string, input.value as string, input.confirmed as boolean);
    return { saved: true, key: input.key };
  }
  if (name === "record_hcp_objection") {
    saveAnswer(sessionId, `objection:${randomUUID()}`, JSON.stringify(input), true);
    return { recorded: true };
  }
  if (name === "request_human_callback") {
    const callbackId = randomUUID();
    saveCallbackRequest({ id: callbackId, sessionId, phone: input.phone as string, preferredTime: input.preferredTime as string, reason: input.reason as string, candidateMessage: input.candidateMessage as string });
    let emailStatus: "sent" | "pending_email" = "pending_email";
    let emailId: string | undefined;
    if (process.env.RESEND_API_KEY && process.env.ESCALATION_EMAIL) {
      try {
        const sent = await new Resend(process.env.RESEND_API_KEY).emails.send({
          from: process.env.EMAIL_FROM || "Personalized Interviews <onboarding@resend.dev>", to: process.env.ESCALATION_EMAIL,
          subject: "Human callback requested", text: `Session: ${sessionId}\nPhone: ${input.phone}\nPreferred time: ${input.preferredTime}\nReason: ${input.reason}\nMessage: ${input.candidateMessage}`,
        }, { idempotencyKey: externalEventId });
        if (sent.data?.id) { emailStatus = "sent"; emailId = sent.data.id; }
      } catch { /* The durable callback remains actionable. */ }
    }
    updateCallbackEmail(callbackId, emailStatus, emailId);
    const result = { callbackRequested: true, callbackId, emailStatus, ...(emailId ? { emailId } : {}) };
    updateSession(sessionId, { status: "escalated", result });
    return result;
  }
  if (name === "complete_prescreen") {
    const session = getSession(sessionId)!;
    if (!session.answers.some((answer) => answer.confirmed)) throw new Error("At least one confirmed answer is required before completion");
    const result = { ...input };
    updateSession(sessionId, { status: "completed", summary: input.summary as string, result: { ...result, nextSessionBrief: buildNextSessionBrief("surrogacy", input.summary as string, result) } });
    return { completed: true, callRemainsOpen: true };
  }
  const session = getSession(sessionId)!;
  if (!session.answers.some((answer) => answer.key.startsWith("objection:"))) throw new Error("Record at least one objection before completion");
  const categoryScores = input.categoryScores as Array<{ score: number; weight: number }>;
  const weightedScore = Math.round(categoryScores.reduce((sum, item) => sum + item.score * item.weight, 0) * 10) / 10;
  const result = { ...input, weightedScore };
  updateSession(sessionId, { status: "completed", summary: input.summary as string, result: { ...result, nextSessionBrief: buildNextSessionBrief("hcp", input.summary as string, result) } });
  return { completed: true, weightedScore };
}

export function createApp(dependencies: {
  configGenerator?: typeof generateConfig;
  tavusSessionCreator?: typeof createTavusSession;
  tavusSessionEnder?: typeof endTavusSession;
  surrogacyReportGenerator?: typeof generateSurrogacyReport;
} = {}) {
  const app = express();
  const configGenerator = dependencies.configGenerator || generateConfig;
  const tavusSessionCreator = dependencies.tavusSessionCreator || createTavusSession;
  const tavusSessionEnder = dependencies.tavusSessionEnder || endTavusSession;
  const surrogacyReportGenerator = dependencies.surrogacyReportGenerator || generateSurrogacyReport;
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/sessions", async (req, res) => {
    const input = sessionInput.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: "Invalid session", details: input.error.flatten() });
    try {
      const email = normalizeEmail(emailInput.parse(input.data.profile.email));
      const submittedProfile: Record<string, unknown> = { ...input.data.profile, email };
      const participant = upsertParticipant({ id: randomUUID(), email, displayName: typeof submittedProfile.name === "string" ? submittedProfile.name : "" });
      const previous = getLatestReusableSession(participant.id, input.data.experience);
      const participantAnswers = getConfirmedParticipantAnswers(participant.id, input.data.experience);
      const profile = { ...submittedProfile };
      if (input.data.experience === "surrogacy") {
        for (const answer of participantAnswers) {
          if (answer.key === "name" || answer.key === "age" || answer.key === "location") profile[answer.key] = answer.value;
        }
      }
      const config = await configGenerator(input.data.experience, profile, storedOrDerivedBrief(previous, participantAnswers));
      return res.status(201).json({ session: createSession({ id: randomUUID(), participantId: participant.id, previousSessionId: previous?.id, experience: input.data.experience, profile, config }) });
    } catch (error) { return res.status(500).json({ error: errorText(error) }); }
  });

  app.get("/api/sessions/:id", (req, res) => {
    const session = getSession(req.params.id);
    return session ? res.json({ session }) : res.status(404).json({ error: "Session not found" });
  });

  app.post("/api/sessions/:id/conversation", async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.status !== "created") return res.status(409).json({ error: "Conversation already started" });
    try {
      const conversation = await tavusSessionCreator(session.config, session.experience, session.participantId);
      updateSession(session.id, {
        status: "active",
        conversationId: conversation.conversationId,
        conversationUrl: conversation.conversationUrl,
        palId: conversation.palId,
        objectivesId: conversation.objectivesId,
      });
      return res.json({ conversation: {
        mode: conversation.mode,
        conversationId: conversation.conversationId,
        conversationUrl: conversation.conversationUrl,
        meetingToken: conversation.meetingToken,
      } });
    } catch (error) { return res.status(502).json({ error: errorText(error) }); }
  });

  app.delete("/api/sessions/:id/conversation", async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const conversationId = req.body?.conversationId || session.conversationId;
    if (!conversationId || (session.conversationId && conversationId !== session.conversationId)) return res.status(400).json({ error: "Conversation does not match this session" });
    const transcript = await tavusSessionEnder(conversationId, session.palId, true, session.objectivesId);
    try {
      if (session.experience === "surrogacy") {
        const latest = getSession(session.id) || session;
        const report = await surrogacyReportGenerator(latest.profile, transcript, latest.answers);
        for (const correction of report.confirmedCorrections) saveAnswer(session.id, correction.key, correction.value, true);
        const prior = Array.isArray(latest.result?.nextSteps) ? latest.result.nextSteps.filter((item): item is string => typeof item === "string") : [];
        const result = { ...latest.result, ...report, nextSteps: [...new Set([...prior, ...report.nextSteps])] };
        updateSession(session.id, { status: latest.status === "escalated" ? "escalated" : "completed", summary: report.summary, result: { ...result, nextSessionBrief: buildNextSessionBrief("surrogacy", report.summary, result) } });
        return res.json({ ok: true, reportGenerated: report.reportSource !== "unavailable" });
      }
      const report = await generateHcpReport(session.profile, transcript);
      if (!report) {
        const hasDialogue = transcript.some((turn) => turn.role === "user" && turn.content.trim());
        if (session.status !== "completed") updateSession(session.id, { status: "completed", result: { reportStatus: "unavailable", reason: hasDialogue ? "Conversation analysis is not configured" : "No medical-rep dialogue was captured" } });
        return res.json({ ok: true, reportGenerated: false });
      }
      updateSession(session.id, { status: "completed", summary: report.summary, result: { ...report, nextSessionBrief: buildNextSessionBrief("hcp", report.summary, report) } });
      return res.json({ ok: true, reportGenerated: true });
    } catch (error) {
      if (session.status !== "completed") updateSession(session.id, { status: "completed", result: { reportStatus: "failed", reason: errorText(error) } });
      return res.json({ ok: true, reportGenerated: false });
    }
  });

  app.post("/api/tools", async (req, res) => {
    const input = toolInput.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: "Invalid tool call", details: input.error.flatten() });
    const { sessionId, name, arguments: raw, externalEventId } = input.data;
    const replay = findEvent(sessionId, externalEventId);
    if (replay) return res.json({ ok: true, data: replay, replayed: true });
    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const allowedAfterCompletion = session.experience === "surrogacy" && (name === "save_interview_answer" || name === "request_human_callback");
    if (session.status === "escalated" || (session.status === "completed" && !allowedAfterCompletion)) {
      return res.status(409).json({ error: "Session is closed" });
    }
    if (!allowedTools[session.experience].has(name)) {
      const error = `Tool ${name} is not allowed for ${session.experience}`;
      return res.status(403).json({ error });
    }
    try {
      const data = await executeTool(sessionId, name, raw, externalEventId);
      runTransaction(() => saveEvent({ sessionId, externalEventId, name, arguments: raw, result: data }));
      return res.json({ ok: true, data, replayed: false });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid tool arguments", details: error.flatten() });
      return res.status(409).json({ error: errorText(error) });
    }
  });

  return app;
}

async function start() {
  const app = createApp();
  const production = process.env.NODE_ENV === "production";
  if (production && existsSync(resolve("dist"))) {
    app.use(express.static(resolve("dist")));
    app.use((req, res, next) => req.method === "GET" && req.accepts("html") ? res.sendFile(resolve("dist/index.html")) : next());
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }
  const port = Number(process.env.PORT || 3137);
  app.listen(port, "127.0.0.1", () => console.log(`Personalized Interviews: http://127.0.0.1:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void start();
