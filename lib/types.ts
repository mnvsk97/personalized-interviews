export type Experience = "surrogacy" | "hcp";

export type GeneratedConfig = {
  pal: {
    name: string;
    role: string;
    systemPrompt: string;
    greeting: string;
    style: string;
  };
  casting: { faceProfile: string; voiceProfile: string; language: string; pace: string };
  objectives: string[];
  guardrails: string[];
};

export type SessionRecord = {
  id: string;
  participantId?: string;
  previousSessionId?: string;
  experience: Experience;
  status: string;
  profile: Record<string, unknown>;
  config: GeneratedConfig;
  conversationId?: string;
  conversationUrl?: string;
  summary?: string;
  result?: Record<string, unknown>;
  answers: Array<{ key: string; value: string; confirmed: boolean }>;
  feedback: Array<{ rating: number; comment: string }>;
};
