export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";
export const CHATGPT_OAUTH_AUTH_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`;
export const CHATGPT_OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;
export const CHATGPT_OAUTH_SCOPE = "openid profile email offline_access";
export const CHATGPT_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CHATGPT_OAUTH_CALLBACK_PORT = 1455;
export const CHATGPT_OAUTH_CALLBACK_PATH = "/auth/callback";

export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CHATGPT_CODEX_VERSION = "0.144.1";
export const CHATGPT_USER_AGENT = `codex_cli_rs/${CHATGPT_CODEX_VERSION}`;
