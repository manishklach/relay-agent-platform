declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    OPENAI_API_KEY?: string;
    OPENAI_BASE_URL?: string;
    RELAY_ENV?: string;
    RELAY_MODEL_TIMEOUT_MS?: string;
    RELAY_MODEL_MAX_RESPONSE_BYTES?: string;
    RELAY_MODEL_MAX_ATTEMPTS?: string;
    RELAY_RUN_MAX_TURNS?: string;
    RELAY_RUN_MAX_TOOL_CALLS?: string;
    RELAY_RUN_MAX_INPUT_TOKENS?: string;
    RELAY_RUN_MAX_OUTPUT_TOKENS?: string;
    RELAY_RUN_MAX_COST_USD?: string;
    RELAY_RUN_MAX_DURATION_MS?: string;
    RELAY_RUN_MAX_CONTEXT_BYTES?: string;
    RELAY_RUN_MAX_TOOL_RESULT_BYTES?: string;
  }
}
