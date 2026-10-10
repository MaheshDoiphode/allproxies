export const VERSION = "0.1.0";

export const OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const OAUTH_CLIENT_SECRET = "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";

export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
export const OAUTH_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const OAUTH_CALLBACK_PORT = 51121;

export const HUB_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
export const HUB_VERSION_FLOOR = "2.9.1";

export const DAILY_URL = "https://daily-cloudcode-pa.googleapis.com";
export const DAILY_SANDBOX_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const PROD_URL = "https://cloudcode-pa.googleapis.com";

export const GENERATE_PATH = "/v1internal:generateContent";
export const STREAM_PATH = "/v1internal:streamGenerateContent";
export const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
export const ONBOARD_USER_PATH = "/v1internal:onboardUser";
export const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";
export const MODELS_PATH = "/v1internal:fetchAvailableModels";

export const USER_AGENT_PRODUCT = "antigravity";
export const IDE_TYPE = "ANTIGRAVITY";
export const PLUGIN_TYPE = "GEMINI";
export const DEFAULT_TIER = "free-tier";
export const X_GOOG_API_CLIENT = "gl-node/22.21.1";
export const ONBOARD_UA_SUFFIX = "google-api-nodejs-client/10.3.0";

export const ENDPOINT_ALIASES = {
  daily: DAILY_URL,
  "daily-sandbox": DAILY_SANDBOX_URL,
  sandbox: DAILY_SANDBOX_URL,
  prod: PROD_URL,
  production: PROD_URL,
};
