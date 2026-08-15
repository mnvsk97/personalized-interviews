import { useCallback, useEffect, useRef, useState } from "react";

type Conversation = {
  mode: "live";
  conversationId: string;
  conversationUrl: string;
  meetingToken: string;
};

type CallFrame = {
  on(event: string, handler: (event: unknown) => void): void;
  join(input: { url: string; token: string }): Promise<unknown>;
  sendAppMessage(message: object, recipients: "*"): void;
  leave(): Promise<unknown>;
  destroy(): Promise<unknown>;
};

type ToolMessage = {
  message_type?: string;
  event_type?: string;
  conversation_id?: string;
  seq?: number;
  properties?: { name?: string; arguments?: string | Record<string, unknown>; tool_call_id?: string };
};

const allowedTools = new Set([
  "save_interview_answer",
  "request_human_callback",
  "complete_prescreen",
  "record_hcp_objection",
  "complete_hcp_practice",
]);

export function toolResultMessage(conversationId: string, toolCallId: string, ok: boolean, output: unknown) {
  return {
    message_type: "conversation",
    event_type: "conversation.tool_result",
    conversation_id: conversationId,
    properties: { tool_call_id: toolCallId, output, status: ok ? "success" : "error" },
  };
}

export function TavusRoom({ sessionId, conversation, onLeave }: { sessionId: string; conversation: Conversation; onLeave?: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const call = useRef<CallFrame | null>(null);
  const handled = useRef(new Set<string>());
  const onLeaveRef = useRef(onLeave);
  const [status, setStatus] = useState("Joining private room…");

  useEffect(() => {
    onLeaveRef.current = onLeave;
  }, [onLeave]);

  const handleMessage = useCallback(async (event: unknown, frame: CallFrame) => {
    const envelope = event as { data?: ToolMessage };
    const message = (envelope.data || event) as ToolMessage;
    const properties = message.properties;
    if (message.message_type !== "conversation" || message.event_type !== "conversation.tool_call") return;
    const toolName = properties?.name;
    const eventId = properties?.tool_call_id;
    if (!toolName || !eventId) return;
    if (message.conversation_id && message.conversation_id !== conversation.conversationId) return;
    if (!allowedTools.has(toolName)) return;

    if (handled.current.has(eventId)) return;
    handled.current.add(eventId);
    setStatus(`Saving ${toolName.replaceAll("_", " ")}…`);

    let args: Record<string, unknown> = {};
    try {
      const parsed = typeof properties.arguments === "string" ? JSON.parse(properties.arguments) : properties.arguments;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
    } catch {
      args = {};
    }

    let ok = false;
    let result: { data?: unknown; error?: string } = { error: "Tool call failed" };
    try {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, name: toolName, arguments: args, externalEventId: eventId }),
      });
      ok = response.ok;
      result = await response.json().catch(() => result);
    } catch {
      // Return the correlated failure below so the PAL can recover.
    }
    frame.sendAppMessage(toolResultMessage(
      conversation.conversationId,
      eventId,
      ok,
      ok ? (result.data ?? { saved: true }) : { error: String(result.error || "invalid request") },
    ), "*");
    setStatus(ok ? "Saved — continuing interview" : "Needs clarification before saving");
  }, [conversation.conversationId, sessionId]);

  useEffect(() => {
    if (!container.current) return;
    let active = true;

    void import("@daily-co/daily-js").then(async ({ default: Daily }) => {
      if (!active || !container.current) return;
      const frame = Daily.createFrame(container.current, {
        showLeaveButton: false,
        showFullscreenButton: true,
        iframeStyle: { width: "100%", height: "100%", border: "0", borderRadius: "24px" },
      }) as CallFrame;
      call.current = frame;
      frame.on("joined-meeting", () => setStatus("Connected"));
      frame.on("left-meeting", () => {
        if (active) onLeaveRef.current?.();
      });
      frame.on("error", () => setStatus("The video room could not connect"));
      frame.on("app-message", (event) => void handleMessage(event, frame));
      await frame.join({ url: conversation.conversationUrl!, token: conversation.meetingToken! });
    }).catch(() => setStatus("The video room could not connect"));

    return () => {
      active = false;
      const frame = call.current;
      call.current = null;
      if (frame) void frame.leave().catch(() => undefined).then(() => frame.destroy()).catch(() => undefined);
    };
  }, [conversation, handleMessage]);

  return (
    <section aria-label="Interview room" style={{ display: "grid", gap: 14 }}>
      <div ref={container} style={{ minHeight: 480, overflow: "hidden", borderRadius: 24, background: "#101519", display: "grid", placeItems: "center" }}>
      </div>
      <div aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ color: "#66706d", fontSize: 14 }}>{status}</span>
      </div>
    </section>
  );
}

export type { Conversation as TavusConversation };
