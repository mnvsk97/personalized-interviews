import OpenAI from "openai";
import { z } from "zod";
import type { TranscriptTurn } from "./generate-hcp-report";

type SavedAnswer = { key: string; value: string; confirmed: boolean };
type ConfirmedCorrection = { key: "name" | "age" | "location"; value: string; correctionEvidence: string; confirmationEvidence: string };
type ReportDetail = { key: string; label: string; value: string; evidence: string; source: "intake_form" | "confirmed_answer" | "transcript" };

const extractedDetailSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  evidence: z.string().min(1),
}).strict();

const confirmedCorrectionSchema = z.object({
  key: z.enum(["name", "age", "location"]),
  value: z.string().min(1),
  correctionEvidence: z.string().min(1),
  confirmationEvidence: z.string().min(1),
}).strict();

const reportSchema = z.object({
  summary: z.string().min(1),
  capturedDetails: z.array(extractedDetailSchema).max(20),
  conversationHighlights: z.array(z.string().min(1)).max(6),
  unansweredQuestions: z.array(z.string().min(1)).max(10),
  nextSteps: z.array(z.string().min(1)).max(6),
  confirmedCorrections: z.array(confirmedCorrectionSchema).max(3),
});

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "capturedDetails", "conversationHighlights", "unansweredQuestions", "nextSteps", "confirmedCorrections"],
  properties: {
    summary: { type: "string" },
    capturedDetails: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value", "evidence"],
        properties: { label: { type: "string" }, value: { type: "string" }, evidence: { type: "string" } },
      },
    },
    conversationHighlights: { type: "array", maxItems: 6, items: { type: "string" } },
    unansweredQuestions: { type: "array", maxItems: 10, items: { type: "string" } },
    nextSteps: { type: "array", maxItems: 6, items: { type: "string" } },
    confirmedCorrections: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value", "correctionEvidence", "confirmationEvidence"],
        properties: {
          key: { type: "string", enum: ["name", "age", "location"] },
          value: { type: "string" },
          correctionEvidence: { type: "string" },
          confirmationEvidence: { type: "string" },
        },
      },
    },
  },
};

function labelForKey(key: string) {
  return key.replace(/^answer:/, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clean(value: string, maxLength = 1000) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function applyConfirmedCorrections(details: ReportDetail[], corrections: ConfirmedCorrection[]) {
  const correctionByKey = new Map(corrections.map((correction) => [correction.key, correction]));
  const added = new Set<string>();
  const merged: ReportDetail[] = [];
  for (const detail of details) {
    const canonicalKey = detail.key.startsWith("intake_") ? detail.key.slice(7) : detail.key;
    const correction = correctionByKey.get(canonicalKey as ConfirmedCorrection["key"])
      || [...correctionByKey.values()].find((item) => detail.label.toLowerCase() === labelForKey(item.key).toLowerCase());
    if (!correction) {
      merged.push(detail);
      continue;
    }
    if (added.has(correction.key)) continue;
    added.add(correction.key);
    merged.push({
      key: correction.key,
      label: labelForKey(correction.key),
      value: correction.key === "age" ? `${clean(correction.value, 200)} years` : clean(correction.value, 200),
      evidence: `${clean(correction.correctionEvidence, 300)} Confirmed with: ${clean(correction.confirmationEvidence, 200)}`,
      source: "confirmed_answer",
    });
  }
  for (const correction of corrections) {
    if (!added.has(correction.key)) merged.push({
      key: correction.key,
      label: labelForKey(correction.key),
      value: correction.key === "age" ? `${clean(correction.value, 200)} years` : clean(correction.value, 200),
      evidence: `${clean(correction.correctionEvidence, 300)} Confirmed with: ${clean(correction.confirmationEvidence, 200)}`,
      source: "confirmed_answer",
    });
  }
  return merged;
}

function savedDetails(answers: SavedAnswer[]) {
  return answers.filter((answer) => answer.confirmed && clean(answer.value)).map((answer) => ({
    key: answer.key,
    label: labelForKey(answer.key),
    value: clean(answer.value),
    evidence: "Confirmed and saved during the conversation",
    source: "confirmed_answer" as const,
  }));
}

function intakeDetails(profile: Record<string, unknown>) {
  const fields = [
    { key: "name", label: "Name", value: profile.name },
    { key: "age", label: "Age", value: profile.age, suffix: " years" },
    { key: "location", label: "Location", value: profile.location },
  ];
  return fields.flatMap(({ key, label, value, suffix = "" }) => {
    if (typeof value !== "string" || !clean(value, 200)) return [];
    return [{ key: `intake_${key}`, label, value: `${clean(value, 200)}${suffix}`, evidence: "Provided before the conversation", source: "intake_form" as const }];
  });
}

function candidateLines(transcript: TranscriptTurn[]) {
  return transcript
    .filter((turn) => turn.role === "user" && clean(turn.content))
    .map((turn) => clean(turn.content));
}

function fallbackReport(answers: SavedAnswer[], transcript: TranscriptTurn[], profile: Record<string, unknown> = {}) {
  const intake = intakeDetails(profile);
  const confirmed = savedDetails(answers);
  const spoken = candidateLines(transcript);
  const existingValues = new Set(confirmed.map((detail) => detail.value.toLowerCase()));
  const transcriptDetails = spoken
    .filter((value) => !existingValues.has(value.toLowerCase()))
    .slice(0, 12)
    .map((value, index) => ({ key: `candidate_response_${index + 1}`, label: `Candidate response ${index + 1}`, value, evidence: value.slice(0, 300), source: "transcript" as const }));
  const capturedDetails = [...intake, ...confirmed, ...transcriptDetails];
  return {
    summary: capturedDetails.length ? `Captured ${capturedDetails.length} detail${capturedDetails.length === 1 ? "" : "s"} from the conversation.` : "No candidate details were captured from the conversation.",
    capturedDetails,
    conversationHighlights: [],
    unansweredQuestions: [],
    nextSteps: [],
    confirmedCorrections: [],
    reportSource: transcriptDetails.length ? "post_call_transcript" : confirmed.length ? "confirmed_answers" : intake.length ? "intake_form" : "unavailable",
  };
}

export async function generateSurrogacyReport(profile: Record<string, unknown>, transcript: TranscriptTurn[], answers: SavedAnswer[]) {
  const fallback = fallbackReport(answers, transcript, profile);
  const dialogue = transcript
    .filter((turn) => (turn.role === "user" || turn.role === "assistant") && clean(turn.content))
    .map((turn) => `${turn.role === "user" ? "CANDIDATE" : "COORDINATOR"}: ${clean(turn.content)}`)
    .join("\n")
    .slice(0, 30_000);
  if (!dialogue || !process.env.OPENAI_API_KEY) return fallback;

  try {
    const model = process.env.OPENAI_MODEL || "gpt-5-mini";
    const response = await new OpenAI().responses.create({
      model,
      input: `Create a factual post-call intake recap using only what the CANDIDATE said in the transcript. Coordinator statements are context, never candidate data.

Extraction rules:
- Extract concrete candidate details such as motivation, pregnancy or delivery history, support system, work or household context, timing, preferences, concerns, and questions.
- Do not copy values from the original form unless the candidate also stated or confirmed them in the conversation.
- Never infer missing facts, emotions, medical status, suitability, or eligibility.
- Use plain, respectful labels and concise values. Omit greetings, filler, acknowledgements, and unclear one-word responses.
- Every captured detail needs a short exact excerpt from the candidate as evidence.
- Put a name, age, or location change in confirmedCorrections only when the candidate explicitly corrects the old value and then explicitly confirms the corrected value. Include separate exact evidence for the correction and confirmation. A correction replaces the old value. Otherwise return an empty array.
- Summarize what was discussed without making a decision. List meaningful highlights, questions that remained unanswered, and only neutral process next steps supported by the conversation.
- If little was discussed, return fewer details honestly. Never pad the report.

ORIGINAL FORM (context only; do not extract from it): ${JSON.stringify(profile)}
TRANSCRIPT:\n${dialogue}`,
      text: { format: { type: "json_schema", name: "surrogacy_conversation_report", strict: true, schema: responseSchema } },
      max_output_tokens: 1800,
      ...(model.startsWith("gpt-5") ? { reasoning: { effort: "low" as const } } : {}),
    });
    const parsed = reportSchema.parse(JSON.parse(response.output_text));
    const intake = intakeDetails(profile);
    const confirmed = savedDetails(answers);
    const confirmedValues = new Set([...intake, ...confirmed].map((detail) => detail.value.toLowerCase().replace(/ years$/, "")));
    const extracted = parsed.capturedDetails
      .filter((detail) => !confirmedValues.has(clean(detail.value).toLowerCase().replace(/ years$/, "")))
      .map((detail, index) => ({ key: `transcript_detail_${index + 1}`, label: clean(detail.label, 120), value: clean(detail.value), evidence: clean(detail.evidence, 300), source: "transcript" as const }));
    return { ...parsed, capturedDetails: applyConfirmedCorrections([...intake, ...confirmed, ...extracted], parsed.confirmedCorrections), reportSource: "post_call_transcript" };
  } catch {
    return fallback;
  }
}

export { fallbackReport as buildFallbackSurrogacyReport };
