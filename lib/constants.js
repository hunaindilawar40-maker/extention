/**
 * Shared constants for AI Outreach for Zoho Mail.
 * Used by background.js (service worker, ES module) and popup.js (ES module).
 * content.js is a classic (non-module) content script, so it keeps its own
 * local copy of the small subset of constants it needs at the top of the file.
 */

export const STORAGE_KEYS = {
  SETTINGS: "aoz_settings",
  LEADS: "aoz_leads",
  LOGS: "aoz_logs",
  QUOTA: "aoz_quota",
  CAMPAIGN: "aoz_campaign"
};

export const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

// Production chat models listed by Groq. The popup replaces this fallback list
// with the models returned for the user's key, so retired or unavailable models
// cannot remain selected.
export const GROQ_MODELS = [
  { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant — best for free tier" },
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile — higher quality" },
  { id: "openai/gpt-oss-20b", label: "OpenAI GPT-OSS 20B — fast reasoning" },
  { id: "openai/gpt-oss-120b", label: "OpenAI GPT-OSS 120B — strongest reasoning" }
];

export const DEFAULT_BANNED_PHRASES = [
  "i hope this email finds you well",
  "i hope this finds you well",
  "in today's fast-paced digital world",
  "in today's fast paced world",
  "i am reaching out because",
  "i am writing to",
  "i wanted to reach out",
  "i wanted to touch base",
  "just circling back",
  "just following up on my last email",
  "hope you're doing well",
  "hope all is well",
  "to whom it may concern",
  "dear sir/madam",
  "i came across your profile",
  "in this day and age",
  "leverage synergies",
  "take it to the next level",
  "best-in-class solution",
  "game changer",
  "revolutionize your business",
  "unlock your full potential"
];

export const DEFAULT_PROMPT_TEMPLATE = `You are {{senderName}}, a real human writing a short, casual, first-touch cold email from {{senderCompany}} to {{firstName}} at {{company}}.

Lead details you can reference (only use what is relevant and true, never invent facts):
- Name: {{fullName}}
- Title: {{title}}
- Company: {{company}}
- Industry: {{industry}}
- Company description / keywords / tech: {{description}}
- Location: {{location}}
- Website: {{website}}

What you're offering / context: {{offer}}

Write a short, warm, conversational cold email that:
- Sounds like it was typed by a busy human, not a marketer or an AI.
- Is {{maxWords}} words or fewer (body only, excluding greeting/sign-off).
- Opens with something specific and real about {{company}} or {{firstName}}'s role — never a generic greeting.
- Mentions at least one concrete detail from the lead data above to prove this isn't a mass blast.
- Has a single, low-pressure call to action (a question or a soft ask), not "let's schedule a call this week".
- Avoids these banned words/phrases entirely: {{bannedPhrases}}.
- Uses plain, simple sentences. Contractions are good. No corporate jargon, no buzzwords, no exclamation-point stacking, no emojis.
- Does not include a subject line inside the body.
- Does not include a signature block (the sender's own Zoho Mail signature will be appended automatically).

Vary your sentence structure and opening style every time so emails never look templated, even for leads in the same industry.

Respond with ONLY valid JSON in this exact shape, no markdown fences, no extra commentary:
{"subject": "short natural subject line, 3-7 words, no spammy punctuation", "body": "the email body as plain text with \\n\\n between paragraphs"}`;

export const DEFAULT_SETTINGS = {
  groqApiKey: "",
  model: "llama-3.1-8b-instant",
  temperature: 0.8,
  maxWords: 110,
  sendMode: "review", // "review" | "auto"
  delayMinSec: 30,
  delayMaxSec: 60,
  dailyQuota: 60,
  bannedPhrases: DEFAULT_BANNED_PHRASES,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  senderName: "",
  senderCompany: "",
  offer: "",
  keepSignature: true
};

// Canonical lead field -> list of possible Apollo.io / generic CSV header names (lowercased, trimmed)
export const APOLLO_COLUMN_MAP = {
  firstName: ["first name", "firstname", "first"],
  lastName: ["last name", "lastname", "last"],
  fullName: ["full name", "name", "contact name"],
  email: ["email", "email address", "work email", "primary email"],
  title: ["title", "job title", "position"],
  company: ["company name", "company", "organization", "account name"],
  industry: ["industry"],
  description: [
    "company description", "keywords", "technologies", "seo description",
    "short description", "about", "company keywords"
  ],
  city: ["city"],
  state: ["state"],
  country: ["country"],
  website: ["website", "company website", "website url"],
  linkedin: ["linkedin url", "person linkedin url", "linkedin", "company linkedin url"]
};

export const LEAD_STATUSES = {
  PENDING: "pending",
  GENERATING: "generating",
  INJECTED: "injected",
  SENT: "sent",
  FAILED: "failed",
  SKIPPED: "skipped"
};

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
