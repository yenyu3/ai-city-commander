import { TemplateLLMAdapter, type LLMAdapter } from "./llmAdapter";
import { BackendLLMAdapter } from "./backendLlmAdapter";

const backendBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

/**
 * Single switch point for which LLMAdapter implementation the app uses.
 * Set VITE_API_BASE_URL (see .env.example) to point at a running backend --
 * backend/service/local_server.py for local dev, or the deployed API
 * Gateway URL -- to use the real backend. Leave it unset to keep the
 * original zero-backend template demo (TemplateLLMAdapter).
 */
export const activeLlmAdapter: LLMAdapter = backendBaseUrl
  ? new BackendLLMAdapter(backendBaseUrl)
  : new TemplateLLMAdapter();
