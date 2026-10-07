/**
 * Groq Cloud chat-completions client + human-sounding cold email prompt builder.
 * ES module — used by background.js only (keeps the API key inside the service worker).
 */
import { GROQ_API_URL } from "./constants.js";

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

/** Extracts the first valid-looking JSON object from a string. */
function extractJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found in model response.");
  const candidate = text.slice(start, end + 1);
  return JSON.parse(candidate);
}

function containsBannedPhrase(text, bannedPhrases) {
  const lower = (text || "").toLowerCase();
  return (bannedPhrases || []).find((p) => p && lower.includes(p.toLowerCase())) || null;
}

/**
 * Calls Groq's chat completions endpoint and returns { subject, body }.
 * Retries once with a corrective instruction if the output contains a banned phrase
 * or fails to parse as JSON.
 */
export async function generateColdEmail(lead, settings) {
  if (!settings.groqApiKey) {
    throw new Error("Missing Groq API key. Add it in the extension's Settings tab.");
  }

  const temperature = Math.min(
    0.95,
    Math.max(0.6, (Number(settings.temperature) || 0.8) + (Math.random() * 0.1 - 0.05))
  );

  async function callOnce(extraSystemNote) {
    const messages = buildMessages(lead, settings);
    if (extraSystemNote) {
      messages.push({ role: "system", content: extraSystemNote });
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
        max_tokens: 500,
        presence_penalty: 0.4,
        frequency_penalty: 0.3
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
      throw new Error(`Groq API error (${res.status}): ${detail}`);
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJSON(raw);
    if (!parsed.subject || !parsed.body) {
      throw new Error("Model response missing subject or body.");
    }
    return { subject: String(parsed.subject).trim(), body: String(parsed.body).trim() };
  }

  let result = await callOnce();
  const banned = containsBannedPhrase(`${result.subject} ${result.body}`, settings.bannedPhrases);
  if (banned) {
    result = await callOnce(
      `Your previous draft used the banned phrase "${banned}". Rewrite completely from scratch, avoiding every banned phrase, with fresh wording and a different structure.`
    );
  }

  return result;
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

/** Lightweight connectivity/key check used by the "Test API Key" button. */
export async function testGroqKey(apiKey, model) {
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      max_tokens: 5,
      temperature: 0
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
  return true;
}
