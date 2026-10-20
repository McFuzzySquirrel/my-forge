/** Credential variables each CLI harness may receive; keep this module dependency-free. */
export const HARNESS_CREDENTIAL_VARIABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  copilot: Object.freeze(["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]),
  claude: Object.freeze(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
  opencode: Object.freeze([
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  ]),
});
