import OpenAI from "openai";
import { z } from "zod";

export type TranscriptTurn = { role: string; content: string; timestamp?: number; durationMs?: number };

const categorySchema = z.object({
  category: z.enum(["Discovery", "Evidence quality", "Objection handling", "Close and next step"]),
  score: z.number().min(0).max(100),
  weight: z.number().positive().max(1),
  feedback: z.string().min(1),
  evidence: z.string().min(1),
});
type ScoredCategory = z.infer<typeof categorySchema>;

const reportSchema = z.object({
  summary: z.string().min(1),
  categoryScores: z.array(categorySchema).length(4),
  strengths: z.array(z.string().min(1)).min(1).max(5),
  improvements: z.array(z.string().min(1)).min(1).max(5),
  riskyStatements: z.array(z.object({ statement: z.string().min(1), risk: z.string().min(1), saferAlternative: z.string().min(1) }).strict()).max(5),
  practicePlan: z.array(z.string().min(1)).min(1).max(5),
});

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "categoryScores", "strengths", "improvements", "riskyStatements", "practicePlan"],
  properties: {
    summary: { type: "string" },
    categoryScores: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "score", "weight", "feedback", "evidence"],
        properties: {
          category: { type: "string", enum: ["Discovery", "Evidence quality", "Objection handling", "Close and next step"] },
          score: { type: "number", minimum: 0, maximum: 100 },
          weight: { type: "number", minimum: 0.01, maximum: 1 },
          feedback: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    strengths: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
    improvements: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
    riskyStatements: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "risk", "saferAlternative"],
        properties: { statement: { type: "string" }, risk: { type: "string" }, saferAlternative: { type: "string" } },
      },
    },
    practicePlan: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
  },
};

export function normalizeCategoryScores(categories: ScoredCategory[]) {
  const usesFivePointScale = categories.length > 0 && categories.every((category) => category.score <= 5);
  return categories.map((category) => ({
    ...category,
    score: Math.min(100, Math.max(0, usesFivePointScale ? Math.round(category.score * 200) / 10 : category.score)),
  }));
}

export async function generateHcpReport(profile: Record<string, unknown>, transcript: TranscriptTurn[]) {
  const dialogue = transcript
    .filter((turn) => (turn.role === "user" || turn.role === "assistant") && turn.content.trim())
    .map((turn) => `${turn.role === "user" ? "MEDICAL REP" : "HCP"}: ${turn.content.replace(/\s+/g, " ").trim()}`)
    .join("\n")
    .slice(0, 30_000);
  if (!dialogue || !process.env.OPENAI_API_KEY) return undefined;

  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const response = await new OpenAI().responses.create({
    model,
    input: `Score the MEDICAL REP in this fictional HCP role-play using only the transcript. The HCP lines are context, never evidence of the rep's performance.

Use exactly these categories and weights:
- Discovery: 0.25 — asks relevant questions and uncovers the HCP's priorities before pitching.
- Evidence quality: 0.30 — makes clear, accurate, appropriately qualified claims and stays within the fictional scenario.
- Objection handling: 0.25 — acknowledges the concern, responds directly, and checks whether the response resolved it.
- Close and next step: 0.20 — summarizes value and earns a concrete, mutual next step.

Scoring rules:
- Use the 0–100 scale only: 0 means absent or harmful, 50 means inconsistent, 75 means solid, and 100 means exceptional. Never use a 0–5 or 0–10 scale.
- Scores must reflect observable behavior, not effort or tone alone.
- For every category, give one concise coaching point and one short exact transcript excerpt. If there is no supporting excerpt, say "No supporting evidence" and score accordingly.
- Identify strengths and the highest-impact improvements in plain language.
- Flag unsupported or risky clinical statements and provide safer alternatives. Do not invent a risk if none occurred.
- Do not praise generically. Do not claim the rep did something that is absent from the transcript.

SCENARIO: ${JSON.stringify(profile)}
TRANSCRIPT:\n${dialogue}`,
    text: { format: { type: "json_schema", name: "hcp_conversation_report", strict: true, schema: responseSchema } },
    max_output_tokens: 1800,
    ...(model.startsWith("gpt-5") ? { reasoning: { effort: "low" as const } } : {}),
  });
  const parsed = reportSchema.parse(JSON.parse(response.output_text));
  const expectedWeights: Record<string, number> = { Discovery: 0.25, "Evidence quality": 0.3, "Objection handling": 0.25, "Close and next step": 0.2 };
  const categoryScores = normalizeCategoryScores(parsed.categoryScores).map((category) => ({ ...category, weight: expectedWeights[category.category] }));
  const weightedScore = Math.round(categoryScores.reduce((sum, category) => sum + category.score * category.weight, 0));
  return { ...parsed, categoryScores, weightedScore, reportSource: "post_call_transcript" };
}
