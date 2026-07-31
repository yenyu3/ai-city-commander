import {
  TemplateLLMAdapter,
  type LLMAdapter,
  type MessageType,
  type PublicContext,
  type StructuredEvent,
} from "./llmAdapter";
import { toScenarioAt } from "../utils/timeUtils";

type Lang = "zh" | "en" | "ja" | "ko";

// Used both as the network-failure fallback and for methods the backend
// doesn't implement yet.
const localFallback = new TemplateLLMAdapter();

async function postAgent(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ text: string }> {
  const res = await fetch(`${baseUrl}/api/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`/api/agent (${body.action}) failed: HTTP ${res.status}`);
  }
  return res.json();
}

interface ChatResponse {
  answer: { text: string; sopRefs: string[]; source: string };
}

async function postChat(
  baseUrl: string,
  message: string,
  scenarioAt: string,
  audience: "government" | "public",
): Promise<ChatResponse> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: { scenarioAt, audience }, message }),
  });
  if (!res.ok) {
    throw new Error(`/api/chat failed: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Calls the real backend (backend/service/rules/ + agent/) instead of the
 * in-browser template simulation in TemplateLLMAdapter. Falls back to that
 * same template output on any network/server failure -- same resilience
 * contract agent/narrator.py already keeps on the backend side for LLM
 * provider failures, so a backend outage never blanks the UI.
 */
export class BackendLLMAdapter implements LLMAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async summarize(input: StructuredEvent): Promise<string> {
    try {
      const { text } = await postAgent(this.baseUrl, {
        action: "summarize",
        kind: input.kind,
        title: input.title,
        data: input.data,
        sopRef: input.sopRef,
      });
      return text;
    } catch (err) {
      console.warn("[BackendLLMAdapter] summarize failed, using local template", err);
      return localFallback.summarize(input);
    }
  }

  async answerWhatIf(
    question: string,
    _ruleResult: unknown,
    _sopExcerpt: string,
    scenarioAt = "",
  ): Promise<string> {
    // Deliberately ignores the frontend chatEngine.ts-computed ruleResult/
    // sopExcerpt: those come from a regex-matched local rule engine, and
    // the whole point of the real backend chat path is that the LLM decides
    // directly from the full SOP text, not from a pre-narrowed local guess.
    try {
      const { answer } = await postChat(this.baseUrl, question, toScenarioAt(scenarioAt), "government");
      return answer.text;
    } catch (err) {
      console.warn("[BackendLLMAdapter] answerWhatIf failed, using local template", err);
      return localFallback.answerWhatIf(question, _ruleResult, _sopExcerpt);
    }
  }

  async answerPublic(
    question: string,
    ruleResult: unknown,
    context: PublicContext,
    scenarioAt = "",
  ): Promise<string> {
    try {
      const { answer } = await postChat(this.baseUrl, question, toScenarioAt(scenarioAt), "public");
      return answer.text;
    } catch (err) {
      console.warn("[BackendLLMAdapter] answerPublic failed, using local template", err);
      return localFallback.answerPublic(question, ruleResult, context);
    }
  }

  generateMultilingual(type: MessageType, v: Record<string, string>): Record<Lang, string> {
    // Deliberately synchronous and local -- matches agent/narrator.py's
    // generate_multilingual, which stays templated even when an LLM is
    // configured (fixed-format CMS/SMS text is more reliable from
    // deterministic sentence construction than LLM translation). No need to
    // round-trip to the backend for this one.
    return localFallback.generateMultilingual(type, v);
  }
}
