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
  personalization: {
    summary: string;
    knownFacts: string[];
    locationContext: string;
    conversationWarmers: string[];
    currentSessionFocus: string[];
    priorSessionUse: string;
  };
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
  palId?: string;
  objectivesId?: string;
  summary?: string;
  result?: Record<string, unknown>;
  answers: Array<{ key: string; value: string; confirmed: boolean }>;
};
