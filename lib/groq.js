/**
 * Groq Cloud chat-completions client + human-sounding cold email prompt builder.
 * ES module — used by background.js only (keeps the API key inside the service worker).
 */
import { GROQ_API_URL, GROQ_MODELS_URL } from "./constants.js";

const OPENING_STYLES = [
  "Start by referencing something specific about their company's industry or niche.",
  "Start with a quick, genuine observation about their role or team.",
  "Start by mentioning something a visitor to their website would notice.",
  "Start with a short, casual one-liner before getting to the point.",
  "Start by connecting their company's work to a very specific, concrete detail.",
  "Start mid-thought, like you were already thinking about their business.",
  "Start with a light, honest compliment that is not generic flattery."
];

const STRUCTURE_HINTS = [
  "Keep it to two short paragraphs.",
  "Keep it to three very short paragraphs, almost like a text message.",
  "Write it as one tight paragraph plus a one-line question.",
  "Use a short opening line, one supporting sentence, then the ask.",
  "Write it the way you'd dash off a quick note between meetings."
];

const CTA_STYLES = [
  "End with a soft, curious question instead of a hard ask.",
  "End by asking if it's even worth a quick reply.",
  "End with a low-key, no-pressure offer to share something useful.",
  "End with a one-line question that's easy to answer in two words."
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null || v === "" ? "" : String(v);
  });
}

/** Builds the final chat messages array sent to Groq, with randomized style jitter. */
export function buildMessages(lead, settings) {
  const vars = {
    senderName: settings.senderName || "the sender",
    senderCompany: settings.senderCompany || "our company",
    firstName: lead.firstName || lead.fullName || "there",
    fullName: lead.fullName || lead.email,
    title: lead.title || "their role",
    company: lead.company || "their company",
    industry: lead.industry || "their industry",
    description: lead.description || "no extra background available",
    location: lead.location || "",
    website: lead.website || "",
    offer: settings.offer || "a relevant product or service",
    maxWords: settings.maxWords || 110,
    bannedPhrases: (settings.bannedPhrases || []).join(", ")
  };

  const basePrompt = fillTemplate(settings.promptTemplate, vars);

  const jitterNote = [
    pick(OPENING_STYLES),
    pick(STRUCTURE_HINTS),
    pick(CTA_STYLES),
    `Variation seed: ${Date.now()}-${Math.floor(Math.random() * 100000)} (use this only to ensure uniqueness, never mention it).`
  ].join(" ");

  return [
    {
      role: "system",
      content:
        "You are an expert human SDR who writes extremely natural, non-templated, short cold emails. " +
        "You never sound like a bot, a template, or a marketing tool. You always output strict JSON only."
    },
    {
      role: "user",
      content: `${basePrompt}\n\nStyle guidance for this specific email (follow it but never reference it directly): ${jitterNote}`
    }
  ];
}

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" }
  },
  required: ["subject", "body"],
  additionalProperties: false
};

// These models support Groq's strict JSON Schema mode. Other chat models still
// get JSON Object Mode, which guarantees valid JSON but not a particular shape.
const STRICT_STRUCTURED_MODELS = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b"
]);

const REASONING_MODELS = /^(openai\/gpt-oss-(?:20b|120b)|qwen\/qwen3\.8-27b|minimaxai\/minimax-m2\.7)$/i;
const GPT_OSS_MODELS = /^openai\/gpt-oss-(?:20b|120b)$/i;

class ModelResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelResponseError";
  }
}

/**
 * Extracts a JSON object without assuming the response contains only one pair
 * of braces. The fallback scanner tolerates markdown fences, commentary, and
 * braces inside JSON strings. When multiple objects exist, prefer the last one
 * that looks like an email draft.
 */
export function extractJSON(text) {
  const source = typeof text === "string" ? text.trim().replace(/^\uFEFF/, "") : "";
  if (!source) throw new ModelResponseError("The AI model returned an empty response.");

  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to the balanced-object scanner.
  }

  const parsedObjects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const parsed = JSON.parse(source.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) parsedObjects.push(parsed);
        } catch {
          // Keep scanning: a later object may still be valid.
        }
        start = -1;
      }
    }
  }

  const draft = [...parsedObjects].reverse().find((item) => "subject" in item && "body" in item);
  if (draft) return draft;
  if (parsedObjects.length) return parsedObjects[parsedObjects.length - 1];
  throw new ModelResponseError("The AI model did not return valid JSON.");
}

function normalizeDraft(value) {
  const parsed = typeof value === "string" ? extractJSON(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelResponseError("The AI model returned an invalid draft.");
  }
  if (typeof parsed.subject !== "string" || !parsed.subject.trim()) {
    throw new ModelResponseError("The AI draft is missing a subject.");
  }
  if (typeof parsed.body !== "string" || !parsed.body.trim()) {
    throw new ModelResponseError("The AI draft is missing an email body.");
  }
  return { subject: parsed.subject.trim(), body: parsed.body.trim() };
}

function responseFormat(model, name, schema) {
  if (STRICT_STRUCTURED_MODELS.has(model)) {
    return {
      type: "json_schema",
      json_schema: { name, strict: true, schema }
    };
  }
  return { type: "json_object" };
}

function reasoningOptions(model) {
  if (!REASONING_MODELS.test(model || "")) return {};
  return {
    // Keep reasoning from contaminating the JSON response body.
    reasoning_format: "hidden",
    ...(GPT_OSS_MODELS.test(model) ? { reasoning_effort: "low" } : {})
  };
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "string" ? part : part?.text || part?.content || ""))
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }

  // Some reasoning models put the complete answer in a reasoning field when
  // their visible content is empty. This is only a last-resort compatibility
  // path; requests normally ask Groq to hide reasoning and return strict JSON.
  for (const fallback of [message?.reasoning, message?.reasoning_content]) {
    if (typeof fallback === "string" && fallback.trim()) return fallback;
  }
  return "";
}

function containsBannedPhrase(text, bannedPhrases) {
  const lower = (text || "").toLowerCase();
  return (bannedPhrases || []).find((p) => p && lower.includes(p.toLowerCase())) || null;
}

/**
 * Calls Groq's chat completions endpoint and returns { subject, body }.
 * Retries once with a corrective instruction if the output contains a banned phrase
 * or fails validation.
 */
export async function generateColdEmail(lead, settings) {
  if (!settings.groqApiKey) {
    throw new Error("Missing Groq API key. Add it in the extension's Settings tab.");
  }

  const temperature = Math.min(
    0.95,
    Math.max(0.6, (Number(settings.temperature) || 0.8) + (Math.random() * 0.1 - 0.05))
  );

  async function callOnce(correction) {
    const messages = buildMessages(lead, settings);
    if (correction) {
      messages.push({ role: "system", content: correction });
    }

    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.groqApiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature,
        top_p: 0.95,
        // Reasoning tokens share this budget on GPT-OSS. The old 500-token
        // budget could be exhausted before any visible JSON was produced.
        max_completion_tokens: 1200,
        presence_penalty: 0.4,
        frequency_penalty: 0.3,
        response_format: responseFormat(settings.model, "cold_email", EMAIL_SCHEMA),
        ...reasoningOptions(settings.model)
      })
    });

    if (!res.ok) {
      let errJson = null;
      let detail = "";
      try {
        errJson = await res.json();
        detail = errJson?.error?.message || JSON.stringify(errJson);
      } catch {
        detail = await res.text();
      }

      // JSON Object Mode can occasionally report a validation error while
      // returning a usable draft in failed_generation. Avoid wasting it.
      const failedGeneration = errJson?.error?.failed_generation;
      if (failedGeneration) {
        try {
          return normalizeDraft(failedGeneration);
        } catch {
          // Surface the original API error below if recovery is impossible.
        }
      }
      throw new Error(`Groq API error (${res.status}): ${detail}`);
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const raw = messageText(choice?.message);
    if (!raw && choice?.finish_reason === "length") {
      throw new ModelResponseError("The AI model ran out of output tokens before returning the draft.");
    }
    return normalizeDraft(raw);
  }

  let correction = "";
  let lastValidationError = null;

  // A maximum of two calls prevents malformed output or a banned phrase from
  // failing a lead immediately while keeping API usage predictable.
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await callOnce(correction);
    } catch (err) {
      if (!(err instanceof ModelResponseError) || attempt === 1) throw err;
      lastValidationError = err;
      correction =
        "Your previous response was empty, malformed, or missing a required field. Return one complete JSON object with exactly two non-empty string fields: subject and body. Return no markdown or commentary.";
      continue;
    }

    const banned = containsBannedPhrase(`${result.subject} ${result.body}`, settings.bannedPhrases);
    if (!banned) return result;
    if (attempt === 1) {
      throw new ModelResponseError(`The AI repeatedly used the banned phrase "${banned}".`);
    }
    correction =
      `Your previous draft used the banned phrase "${banned}". Rewrite completely from scratch, avoiding every banned phrase, with fresh wording and a different structure.`;
  }

  throw lastValidationError || new ModelResponseError("The AI model could not produce a valid draft.");
}

/** Converts AI plain-text body (with \n\n paragraph breaks) into clean HTML for the Zoho editor. */
export function bodyToHtml(body) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs
    .map((p) => `<div>${escapeHtml(p).replace(/\n/g, "<br>")}</div>`)
    .join("<div><br></div>");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Returns the active text-generation models available to this specific API key.
 * Groq retires models periodically, so this endpoint is the source of truth
 * instead of a hard-coded dropdown.
 */
export async function listGroqModels(apiKey) {
  if (!apiKey) throw new Error("Enter a Groq API key first.");

  const res = await fetch(GROQ_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    let detail = "";
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      detail = await res.text();
    }
    throw new Error(`${res.status}: ${detail}`);
  }

  const data = await res.json();
  // The models endpoint also returns speech and safety-only models. Those do
  // not work with this extension's /chat/completions request.
  const unsupported = /(whisper|orpheus|playai|tts|speech|prompt-guard|safeguard|moderation)/i;
  return (data?.data || [])
    .filter((model) => model?.id && model.active !== false && !unsupported.test(model.id))
    .map((model) => ({
      id: model.id,
      ownedBy: model.owned_by || "Groq",
      contextWindow: model.context_window || null
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Finds a model that this key can actually use for chat completions. The Models
 * API can occasionally include a model that is restricted for a project, so a
 * tiny completion is the final availability check.
 */
export async function findWorkingGroqModel(apiKey, preferredModel) {
  const models = await listGroqModels(apiKey);
  if (!models.length) throw new Error("Groq returned no compatible chat models for this key.");

  const priority = [
    preferredModel,
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile"
  ].filter(Boolean);
  const orderedIds = [
    ...priority.filter((id, index) => priority.indexOf(id) === index && models.some((model) => model.id === id)),
    ...models.map((model) => model.id).filter((id) => !priority.includes(id))
  ];

  let lastError = null;
  for (const model of orderedIds) {
    try {
      await testGroqKey(apiKey, model);
      return { model, models };
    } catch (err) {
      lastError = err;
      // Authentication and rate-limit failures are key/account problems; trying
      // every other model would only repeat the same failure.
      if (/^(401|429):/.test(err?.message || "")) throw err;
    }
  }

  throw new Error(
    `None of the ${orderedIds.length} chat models returned by Groq accepted a completion request.${lastError ? ` Last error: ${lastError.message}` : ""}`
  );
}

/** Lightweight connectivity/key check used by the "Test API Key" button. */
export async function testGroqKey(apiKey, model) {
  const selectedModel = model || "openai/gpt-oss-20b";
  const testSchema = {
    type: "object",
    properties: { status: { type: "string", enum: ["OK"] } },
    required: ["status"],
    additionalProperties: false
  };
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [{ role: "user", content: 'Return only this JSON object: {"status":"OK"}' }],
      max_completion_tokens: 256,
      temperature: 0,
      response_format: responseFormat(selectedModel, "connection_test", testSchema),
      ...reasoningOptions(selectedModel)
    })
  });
  if (!res.ok) {
    let detail = "";
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      detail = await res.text();
    }
    throw new Error(`${res.status}: ${detail}`);
  }

  const data = await res.json();
  let parsed;
  try {
    parsed = extractJSON(messageText(data?.choices?.[0]?.message));
  } catch (err) {
    throw new Error(`Model returned no usable test response: ${err?.message || err}`);
  }
  if (parsed?.status !== "OK") {
    throw new Error("Model returned an unexpected test response.");
  }
  return true;
}
