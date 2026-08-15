import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleHelp,
  HeartHandshake,
  Home as HomeIcon,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  X,
} from "lucide-react";
import type { Experience, GeneratedConfig, SessionRecord } from "../lib/types";
import { TavusRoom, type TavusConversation } from "./TavusRoom";

type View = "setup" | "call" | "result";
type FormValues = Record<string, string | boolean>;

const modes = {
  surrogacy: {
    eyebrow: "Consent-first protocol",
    title: "Surrogate interview",
    description: "A warm onboarding conversation that listens, confirms, and makes human support easy to reach.",
    icon: HeartHandshake,
  },
  hcp: {
    eyebrow: "Evidence-based coaching",
    title: "HCP meeting practice",
    description: "Practice a realistic fictional product discussion, then get a transcript-backed scorecard.",
    icon: Stethoscope,
  },
} as const;

const defaults: Record<Experience, FormValues> = {
  surrogacy: {
    name: "Priya Sharma",
    email: "demo.surrogacy@example.com",
    age: "31",
    location: "Austin, Texas",
    consent: false,
  },
  hcp: {
    name: "Jordan Lee",
    email: "demo.hcp@example.com",
    product: "Nuralis (fictional)",
    specialty: "Neurology",
    objective: "Earn agreement for a follow-up clinical discussion",
    context: "A first meeting after the physician asked for more information about access and tolerability.",
    challenge: "Evidence-focused and curious",
    difficulty: "Realistic",
    consent: false,
  },
};

function answerLabel(key: string) {
  return key
    .replace(/^answer:/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || "Something went wrong. Please try again.");
  return (body.session || body.conversation || body.data || body) as T;
}

function routeFor(experience: Experience, view: View, sessionId?: string) {
  return `/${experience}/${view === "call" ? "conversation" : view}${sessionId ? `/${sessionId}` : ""}`;
}

function initialExperience(): Experience {
  return window.location.pathname.startsWith("/hcp/") ? "hcp" : "surrogacy";
}

export default function Home() {
  const [experience, setExperience] = useState<Experience>(initialExperience);
  const [view, setView] = useState<View>("setup");
  const [form, setForm] = useState<FormValues>(defaults.surrogacy);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [conversation, setConversation] = useState<TavusConversation | null>(null);
  const [config, setConfig] = useState<GeneratedConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scorecardIncomplete, setScorecardIncomplete] = useState(false);
  const [reportPending, setReportPending] = useState(false);
  const ending = useRef(false);
  const flowVersion = useRef(0);

  useEffect(() => {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const routedExperience = parts[0] === "hcp" ? "hcp" : "surrogacy";
    const routedView = parts[1];
    const sessionId = parts[2];
    if (routedView === "result" && sessionId) {
      void request<SessionRecord>(`/api/sessions/${sessionId}`).then((saved) => {
        if (saved.experience !== routedExperience) throw new Error("Session route does not match the saved experience");
        setExperience(routedExperience);
        setForm({ ...defaults[routedExperience], ...saved.profile } as FormValues);
        setConfig(saved.config);
        setSession(saved);
        setView("result");
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not restore this result.");
        window.history.replaceState({}, "", routeFor(routedExperience, "setup"));
      });
    } else if (routedView === "conversation") {
      if (sessionId) {
        void request(`/api/sessions/${sessionId}/conversation`, { method: "DELETE", keepalive: true }).catch(() => undefined);
      }
      setError("A live conversation cannot be resumed after a page reload. Start a new conversation.");
      window.history.replaceState({}, "", routeFor(routedExperience, "setup"));
    } else if (window.location.pathname === "/") {
      window.history.replaceState({}, "", routeFor(routedExperience, "setup"));
    }
    const reloadForHistory = () => window.location.reload();
    window.addEventListener("popstate", reloadForHistory);
    return () => window.removeEventListener("popstate", reloadForHistory);
  }, []);

  const progress = view === "setup" ? 1 : view === "call" ? 2 : 3;
  const resultScorecard = useMemo(() => {
    const categories = session?.result?.categoryScores;
    const evidence = session?.result?.transcriptEvidence;
    if (!Array.isArray(categories)) return [];
    const usesFivePointScale = categories.length > 0 && categories.every((item) => Number((item as { score?: number }).score || 0) <= 5);
    return categories.map((item, index) => {
      const category = item as { category?: string; score?: number; weight?: number; feedback?: string; evidence?: string };
      const quote = Array.isArray(evidence) ? evidence[index] as { evidence?: string } : undefined;
      return {
        label: category.category || `Category ${index + 1}`,
        score: usesFivePointScale ? Math.round(Number(category.score || 0) * 200) / 10 : Number(category.score || 0),
        weight: Math.round(Number(category.weight || 0) * 100),
        feedback: category.feedback || "No category-specific coaching was returned.",
        evidence: category.evidence || quote?.evidence || "No supporting evidence",
      };
    });
  }, [session]);
  const overall = useMemo(() => {
    const saved = Number(session?.result?.weightedScore);
    const savedUsesFivePointScale = resultScorecard.length > 0 && saved > 0 && saved <= 5;
    if (Number.isFinite(saved) && saved > 0 && !savedUsesFivePointScale) return Math.round(saved);
    return resultScorecard.length ? Math.round(resultScorecard.reduce((sum, item) => sum + item.score * item.weight, 0) / 100) : 0;
  }, [resultScorecard, session]);
  const surrogateOutcome = session?.result as { outcome?: string; unansweredQuestions?: unknown; nextSteps?: unknown; callbackRequested?: boolean; emailStatus?: string } | undefined;
  const surrogateNextSteps = Array.isArray(surrogateOutcome?.nextSteps) ? surrogateOutcome.nextSteps.filter((item): item is string => typeof item === "string") : [];
  const surrogateUnanswered = Array.isArray(surrogateOutcome?.unansweredQuestions) ? surrogateOutcome.unansweredQuestions.filter((item): item is string => typeof item === "string") : [];
  const callbackRequested = session?.status === "escalated" && surrogateOutcome?.callbackRequested === true;
  const surrogateCapturedDetails = useMemo(() => {
    if (experience !== "surrogacy") return [];
    const extracted = session?.result?.capturedDetails;
    if (Array.isArray(extracted)) return extracted.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const detail = item as { key?: unknown; label?: unknown; value?: unknown; evidence?: unknown; source?: unknown };
      if (typeof detail.label !== "string" || typeof detail.value !== "string") return [];
      const source = detail.source === "confirmed_answer" || detail.source === "intake_form" ? detail.source : "transcript";
      return [{ key: typeof detail.key === "string" ? detail.key : `detail-${index}`, label: detail.label, value: detail.value, evidence: typeof detail.evidence === "string" ? detail.evidence : "", source }];
    });
    return (session?.answers || []).filter((answer) => answer.confirmed).map((answer) => ({ key: answer.key, label: answerLabel(answer.key), value: answer.value, evidence: "Confirmed and saved during the conversation", source: "confirmed_answer" }));
  }, [experience, session]);
  const surrogateHighlights = Array.isArray(session?.result?.conversationHighlights) ? session.result.conversationHighlights.filter((item): item is string => typeof item === "string") : [];
  const reportStrengths = Array.isArray(session?.result?.strengths) ? session.result.strengths.filter((item): item is string => typeof item === "string") : [];
  const reportImprovements = Array.isArray(session?.result?.improvements) ? session.result.improvements.filter((item): item is string => typeof item === "string") : [];
  const reportPracticePlan = Array.isArray(session?.result?.practicePlan) ? session.result.practicePlan.filter((item): item is string => typeof item === "string") : [];
  const reportRisks = Array.isArray(session?.result?.riskyStatements) ? session.result.riskyStatements.filter((item): item is { statement: string; risk: string; saferAlternative: string } => Boolean(item && typeof item === "object" && typeof (item as { statement?: unknown }).statement === "string" && typeof (item as { risk?: unknown }).risk === "string" && typeof (item as { saferAlternative?: unknown }).saferAlternative === "string")) : [];

  function choose(next: Experience) {
    setExperience(next);
    setForm(defaults[next]);
    setView("setup");
    window.history.pushState({}, "", routeFor(next, "setup"));
    setError("");
  }

  function field(name: string, value: string | boolean) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function createSession(event: FormEvent) {
    event.preventDefault();
    if (!form.consent) return setError("Please confirm the synthetic-demo consent before continuing.");
    const flow = ++flowVersion.current;
    setBusy(true);
    setError("");
    try {
      const created = await request<SessionRecord>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ experience, profile: form }),
      });
      if (flow !== flowVersion.current) return;
      setConfig(created.config);
      const createdConversation = await request<TavusConversation>(`/api/sessions/${created.id}/conversation`, { method: "POST" });
      if (flow !== flowVersion.current) {
        void request(`/api/sessions/${created.id}/conversation`, {
          method: "DELETE",
          keepalive: true,
          body: JSON.stringify({ conversationId: createdConversation.conversationId }),
        }).catch(() => undefined);
        return;
      }
      setConversation(createdConversation);
      setSession({ ...created, status: "active", conversationId: createdConversation.conversationId, conversationUrl: createdConversation.conversationUrl || undefined });
      setView("call");
      window.history.pushState({}, "", routeFor(experience, "call", created.id));
    } catch (cause) {
      if (flow === flowVersion.current) setError(cause instanceof Error ? cause.message : "Could not start the conversation.");
    } finally {
      if (flow === flowVersion.current) setBusy(false);
    }
  }

  async function finishCall() {
    if (!session || ending.current) return;
    const flow = flowVersion.current;
    ending.current = true;
    setBusy(true);
    setError("");
    setView("result");
    window.history.pushState({}, "", routeFor(experience, "result", session.id));
    setReportPending(true);
    try {
      if (conversation) {
        await request(`/api/sessions/${session.id}/conversation`, {
          method: "DELETE",
          body: JSON.stringify({ conversationId: conversation.conversationId }),
        });
      }
      if (flow !== flowVersion.current) return;
      const latest = await request<SessionRecord>(`/api/sessions/${session.id}`);
      if (flow !== flowVersion.current) return;
      setSession(latest);
      setScorecardIncomplete(experience === "hcp" && latest.status !== "completed");
    } catch (cause) {
      if (flow === flowVersion.current) setError(cause instanceof Error ? cause.message : "Could not finish the conversation.");
    } finally {
      if (flow === flowVersion.current) {
        setReportPending(false);
        setBusy(false);
        ending.current = false;
      }
    }
  }

  async function endFromHeader() {
    await finishCall();
  }

  function reset() {
    flowVersion.current += 1;
    setView("setup");
    setSession(null);
    setConversation(null);
    setConfig(null);
    setForm(defaults[experience]);
    setScorecardIncomplete(false);
    setReportPending(false);
    setBusy(false);
    ending.current = false;
    setError("");
    window.history.pushState({}, "", routeFor(experience, "setup"));
  }

  function goHome() {
    const activeSession = view === "call" ? session : null;
    const activeConversation = view === "call" ? conversation : null;
    reset();
    if (activeSession && activeConversation) {
      void request(`/api/sessions/${activeSession.id}/conversation`, {
        method: "DELETE",
        keepalive: true,
        body: JSON.stringify({ conversationId: activeConversation.conversationId }),
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : "The screen was reset, but the remote conversation could not be cleaned up.");
      });
    }
  }

  return (
    <main>
      <header className="site-header">
        <button className="brand" onClick={goHome} aria-label="Personalized Interviews home">
          <span className="brand-mark" aria-hidden="true" />
          <span>Personalized Interviews</span>
        </button>
        <button className="home-button" onClick={goHome} aria-label="Restart from home">
          <HomeIcon size={17} /> Home
        </button>
      </header>

      <div className="shell">
        <nav className="progress" aria-label="Session progress">
          {[experience === "surrogacy" ? "Intake" : "Configure", "Conversation", "Outcome"].map((label, index) => (
            <div key={label} className={progress > index ? "progress-step active" : "progress-step"}>
              <span>{progress > index + 1 ? <Check size={14} /> : index + 1}</span>{label}
            </div>
          ))}
        </nav>

        {view === "setup" && (
          <>
            <section className="hero">
              <p className="eyebrow">Practice with purpose</p>
              <h1>Prepare for a conversation that matters.</h1>
              <p>Share the context, then begin a focused role-play built around your answers.</p>
            </section>

            <section className="mode-grid" aria-label="Choose an experience">
              {(Object.keys(modes) as Experience[]).map((mode) => {
                const item = modes[mode];
                const Icon = item.icon;
                return (
                  <button key={mode} className={`mode-card ${experience === mode ? "selected" : ""}`} onClick={() => choose(mode)} aria-pressed={experience === mode}>
                    <span className="mode-icon"><Icon size={25} /></span>
                    <span className="mode-check">{experience === mode && <Check size={15} />}</span>
                    <span className="eyebrow">{item.eyebrow}</span>
                    <strong>{item.title}</strong>
                    <span>{item.description}</span>
                  </button>
                );
              })}
            </section>

            <section className="setup-layout">
              <form className="panel form-panel" onSubmit={createSession}>
                <div className="section-heading">
                  <div><p className="eyebrow">{experience === "surrogacy" ? "Surrogate prescreen" : "Your scenario"}</p><h2>{experience === "surrogacy" ? "Tell us about yourself" : "Shape the conversation"}</h2></div>
                  <span className="safe-chip"><ShieldCheck size={15} /> Safety rules on</span>
                </div>
                {experience === "surrogacy" ? <SurrogacyFields values={form} onChange={field} /> : <HcpFields values={form} onChange={field} />}
                <label className="consent">
                  <input type="checkbox" checked={Boolean(form.consent)} onChange={(event) => field("consent", event.target.checked)} />
                  <span>{experience === "surrogacy" ? "I consent to storing these answers for this intake. The role-play does not make medical or eligibility decisions, and I can request a person at any time." : "I understand this is an AI role-play using a fictional product. I can pause or stop at any time."}</span>
                </label>
                {error && <p className="error" role="alert"><CircleHelp size={17} />{error}</p>}
                <button className="primary wide" disabled={busy}>{busy ? <><LoaderCircle className="spin" /> Preparing conversation…</> : <><Sparkles /> Start conversation <ArrowRight /></>}</button>
              </form>

            </section>
          </>
        )}

        {view === "call" && (
          <section className="call-view">
            <div className="call-top"><div><span className="live-chip"><span /> Live</span><h1>{experience === "surrogacy" ? "Candidate conversation" : "HCP role-play"}</h1></div><button className="danger-link" onClick={endFromHeader}><X /> {experience === "surrogacy" ? "End conversation" : "End role-play"}</button></div>
            <div className="room-layout">
              <div className="tavus-stage">
                {config && <div className="room-intro"><strong>{config.pal.name}</strong><span>{config.pal.role}</span></div>}
                {conversation && <TavusRoom sessionId={session!.id} conversation={conversation} onLeave={finishCall} />}
              </div>
            </div>
          </section>
        )}

        {view === "result" && (
          <section className="result-view">
            <div className="result-heading"><span className="success-icon">{reportPending ? <LoaderCircle className="spin" /> : <Check />}</span><div><p className="eyebrow">{experience === "surrogacy" ? reportPending ? "Building your recap" : callbackRequested ? "Follow-up requested" : "Conversation recap" : reportPending ? "Building your report" : "Conversation analysis"}</p><h1>{experience === "surrogacy" ? reportPending ? "Reviewing what you shared." : callbackRequested ? "A coordinator can follow up with you." : surrogateCapturedDetails.length ? `Here’s what we captured${form.name ? `, ${String(form.name)}` : ""}.` : "No interview details were captured." : reportPending ? "Analyzing what you said." : resultScorecard.length ? "Your improvement report is ready." : "The conversation ended."}</h1><p>{experience === "surrogacy" ? reportPending ? "Extracting a structured record from the conversation transcript." : surrogateCapturedDetails.length ? "Review the details below alongside the conversation’s next steps." : "The conversation ended before enough information was captured." : reportPending ? "Reviewing the transcript against discovery, evidence, objection handling, and close." : resultScorecard.length ? "Every score below is tied to the conversation transcript." : "A transcript-backed report could not be generated."}</p></div></div>
            {experience === "surrogacy" ? reportPending ? (
              <div className="panel analysis-pending"><LoaderCircle className="spin" /><div><h2>Building the conversation record</h2><p>Pulling together confirmed answers and details supported by the transcript.</p></div></div>
            ) : (
              <div className="panel completion-card">
                <div className="completion-status"><ShieldCheck /><div><strong>{callbackRequested ? "Request received" : surrogateCapturedDetails.length ? "Conversation record ready" : "No details captured"}</strong><p>{callbackRequested ? "The callback details you confirmed during the conversation are saved." : session?.summary || "The conversation ended before a structured record could be created."}</p></div></div>
                <section className="collected-answers" aria-labelledby="collected-answers-heading">
                  <div className="collected-answers-heading">
                    <div><p className="eyebrow">Transcript-backed record</p><h2 id="collected-answers-heading">Details collected during the interview</h2></div>
                    <span>{surrogateCapturedDetails.length} {surrogateCapturedDetails.length === 1 ? "detail" : "details"}</span>
                  </div>
                  {surrogateCapturedDetails.length ? (
                    <dl>{surrogateCapturedDetails.map((detail) => <div key={detail.key}><dt>{detail.label}</dt><dd><strong>{detail.value}</strong>{detail.evidence && <small>{detail.source === "intake_form" ? detail.evidence : `“${detail.evidence}”`}</small>}</dd>{detail.source === "transcript" ? <MessageSquareText aria-label="Supported by transcript" /> : <CheckCircle2 aria-label={detail.source === "intake_form" ? "Provided before interview" : "Confirmed answer"} />}</div>)}</dl>
                  ) : <p className="empty-answers">No candidate statements or confirmed answers were available to extract.</p>}
                  <small>Basic information comes from the setup form. Interview details are included only when stated in the call or saved after confirmation.</small>
                </section>
                {surrogateHighlights.length > 0 && <div className="outcome-list"><p className="eyebrow">What you discussed</p><ul>{surrogateHighlights.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                {surrogateNextSteps.length > 0 && <div className="outcome-list"><p className="eyebrow">Next steps</p><ol>{surrogateNextSteps.map((step) => <li key={step}>{step}</li>)}</ol></div>}
                {surrogateUnanswered.length > 0 && <div className="outcome-list muted"><p className="eyebrow">Still to discuss</p><ul>{surrogateUnanswered.map((question) => <li key={question}>{question}</li>)}</ul></div>}
                <p className="outcome-note">No medical or eligibility decision was made.</p>
              </div>
            ) : reportPending ? (
              <div className="panel analysis-pending"><LoaderCircle className="spin" /><div><h2>Analyzing the conversation</h2><p>This normally takes a few seconds. The report will appear here automatically.</p></div></div>
            ) : scorecardIncomplete || !resultScorecard.length ? (
              <div className="panel incomplete-scorecard"><MessageSquareText /><div><p className="eyebrow">Practice ended</p><h2>No scorecard was generated.</h2><p>{typeof session?.result?.reason === "string" ? session.result.reason : "There was not enough medical-rep dialogue to produce transcript-backed feedback."}</p></div></div>
            ) : (
              <div className="scorecard">
                <div className="score-hero panel"><div className="score-ring" style={{ "--score": `${overall * 3.6}deg` } as React.CSSProperties}><span><strong>{overall}</strong>/100</span></div><div><p className="eyebrow">Weighted overall score</p><h2>{session?.summary || "Transcript-backed conversation score"}</h2><p>Discovery 25% · Evidence quality 30% · Objection handling 25% · Close 20%</p></div></div>
                <div className="score-list">
                  {resultScorecard.map((item) => <article className="score-row" key={item.label}><div className="score-meta"><strong>{item.label}</strong><span>{item.weight}% weight</span><b>{item.score}</b></div><div className="score-track"><span style={{ width: `${item.score}%` }} /></div><p className="category-feedback">{item.feedback}</p><p><MessageSquareText /> “{item.evidence}”</p></article>)}
                </div>
                <div className="report-details">
                  {reportStrengths.length > 0 && <section className="panel report-section"><p className="eyebrow">What worked</p><ul>{reportStrengths.map((item) => <li key={item}>{item}</li>)}</ul></section>}
                  {reportImprovements.length > 0 && <section className="panel report-section priority"><p className="eyebrow">Improve next</p><ol>{reportImprovements.map((item) => <li key={item}>{item}</li>)}</ol></section>}
                </div>
                {reportRisks.length > 0 && <section className="panel risk-section"><p className="eyebrow">Claims to tighten</p>{reportRisks.map((item) => <article key={`${item.statement}-${item.risk}`}><strong>“{item.statement}”</strong><p>{item.risk}</p><small>Safer: {item.saferAlternative}</small></article>)}</section>}
                {reportPracticePlan.length > 0 && <div className="coaching-note"><Sparkles /><div><strong>Practice plan</strong><ol>{reportPracticePlan.map((item) => <li key={item}>{item}</li>)}</ol></div></div>}
              </div>
            )}
            {error && <p className="error" role="alert"><CircleHelp size={17} />{error}</p>}
            <button className="secondary restart" onClick={reset}>Start another conversation <ArrowRight /></button>
          </section>
        )}
      </div>
      <footer>Private practice session · No medical or eligibility decisions</footer>
    </main>
  );
}

function SurrogacyFields({ values, onChange }: { values: FormValues; onChange: (name: string, value: string) => void }) {
  return <div className="form-grid">
    <div className="form-section-title"><span>1</span><div><strong>Basic information</strong><small>Maya will ask the remaining questions during the conversation.</small></div></div>
    <Field label="Name" name="name" value={values.name} onChange={onChange} placeholder="Alex Morgan" required />
    <Field label="Email" name="email" value={values.email} onChange={onChange} placeholder="alex@example.com" type="email" required />
    <Field label="Age in years" name="age" value={values.age} onChange={onChange} placeholder="29" required />
    <Field label="Location" name="location" value={values.location} onChange={onChange} placeholder="San Francisco, California" wide required />
  </div>;
}

function HcpFields({ values, onChange }: { values: FormValues; onChange: (name: string, value: string) => void }) {
  return <div className="form-grid">
    <Field label="Your name" name="name" value={values.name} onChange={onChange} placeholder="Alex Chen" required />
    <Field label="Email" name="email" value={values.email} onChange={onChange} placeholder="alex@example.com" type="email" required />
    <Field label="Fictional product" name="product" value={values.product} onChange={onChange} placeholder="Nuralis (fictional)" />
    <Field label="Context" name="context" value={values.context} onChange={onChange} placeholder="Example: A relaxed first meeting after the physician asked for more information about access and tolerability." wide textarea required />
    <Select label="HCP specialty" name="specialty" value={values.specialty} onChange={onChange} options={["Neurology", "Cardiology", "Primary care", "Oncology"]} />
    <Field label="Meeting objective" name="objective" value={values.objective} onChange={onChange} placeholder="Earn a focused follow-up…" wide />
    <Select label="Physician persona" name="challenge" value={values.challenge} onChange={onChange} options={["Evidence-focused and curious", "Interested but formulary-constrained", "Skeptical of new therapies", "Explicitly time-constrained"]} />
    <Select label="Difficulty" name="difficulty" value={values.difficulty} onChange={onChange} options={["Supportive", "Realistic", "Challenging"]} />
  </div>;
}

function Field({ label, name, value, onChange, placeholder, type = "text", wide, textarea, required }: { label: string; name: string; value: string | boolean; onChange: (name: string, value: string) => void; placeholder: string; type?: string; wide?: boolean; textarea?: boolean; required?: boolean }) {
  const props = { id: name, name, value: String(value), placeholder, required, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(name, event.target.value) };
  return <label className={wide ? "field wide" : "field"}><span>{label}{required && <b> *</b>}</span>{textarea ? <textarea {...props} rows={3} /> : <input {...props} type={type} />}</label>;
}

function Select({ label, name, value, onChange, options, placeholder, required }: { label: string; name: string; value: string | boolean; onChange: (name: string, value: string) => void; options: string[]; placeholder?: string; required?: boolean }) {
  return <label className="field"><span>{label}{required && <b> *</b>}</span><select id={name} name={name} value={String(value)} required={required} onChange={(event) => onChange(name, event.target.value)}>{placeholder && <option value="" disabled>{placeholder}</option>}{options.map((option) => <option key={option}>{option}</option>)}</select></label>;
}
