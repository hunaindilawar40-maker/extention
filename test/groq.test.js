import test from "node:test";
import assert from "node:assert/strict";

import { extractJSON, generateColdEmail, testGroqKey } from "../lib/groq.js";
import { DEFAULT_SETTINGS } from "../lib/constants.js";

function jsonResponse(content, extra = {}) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content },
          ...extra
        }
      ]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function settings(overrides = {}) {
  return {
    ...DEFAULT_SETTINGS,
    groqApiKey: "gsk_test",
    senderName: "Sam",
    senderCompany: "Example Co",
    offer: "a faster quoting workflow",
    bannedPhrases: [],
    ...overrides
  };
}

async function withMockFetch(mock, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("extractJSON handles fenced output, multiple objects, and braces inside strings", () => {
  const output = [
    'Example schema: {"example":true}',
    "```json",
    '{"subject":"A note for {your team}","body":"First line\\n\\nSecond line"}',
    "```"
  ].join("\n");

  assert.deepEqual(extractJSON(output), {
    subject: "A note for {your team}",
    body: "First line\n\nSecond line"
  });
});

test("generateColdEmail uses strict structured output and retries an empty response", async () => {
  const requests = [];
  const responses = [
    jsonResponse(""),
    jsonResponse('{"subject":"A faster quote","body":"Hi Bret,\\n\\nThought this might help your team."}')
  ];

  await withMockFetch(
    async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return responses.shift();
    },
    async () => {
      const result = await generateColdEmail(
        { firstName: "Bret", email: "bret@example.com", company: "Platinum Floor Coatings" },
        settings()
      );

      assert.deepEqual(result, {
        subject: "A faster quote",
        body: "Hi Bret,\n\nThought this might help your team."
      });
    }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].response_format.type, "json_schema");
  assert.equal(requests[0].response_format.json_schema.strict, true);
  assert.equal(requests[0].reasoning_format, "hidden");
  assert.equal(requests[0].reasoning_effort, "low");
  assert.equal(requests[0].max_completion_tokens, 1200);
  assert.equal("max_tokens" in requests[0], false);
  assert.match(requests[1].messages.at(-1).content, /previous response was empty/i);
});

test("generateColdEmail spends its single retry replacing a banned phrase", async () => {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse('{"subject":"Quick note","body":"I hope this email finds you well, Bret."}');
      }
      return jsonResponse('{"subject":"Floor coating quotes","body":"Bret, saw your team handles floor coatings. Open to a quicker quoting workflow?"}');
    },
    async () => {
      const result = await generateColdEmail(
        { firstName: "Bret", email: "bret@example.com", company: "Platinum Floor Coatings" },
        settings({ bannedPhrases: ["I hope this email finds you well"] })
      );
      assert.equal(result.subject, "Floor coating quotes");
    }
  );
  assert.equal(calls, 2);
});

test("generateColdEmail recovers a usable failed_generation from Groq", async () => {
  await withMockFetch(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Failed to validate JSON",
            failed_generation: 'Draft: {"subject":"Still usable","body":"Recovered body"}'
          }
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      ),
    async () => {
      const result = await generateColdEmail(
        { email: "lead@example.com", company: "Example" },
        settings({ model: "some/other-chat-model" })
      );
      assert.deepEqual(result, { subject: "Still usable", body: "Recovered body" });
    }
  );
});

test("testGroqKey rejects an HTTP success with no usable model output", async () => {
  await withMockFetch(
    async () => jsonResponse(""),
    async () => {
      await assert.rejects(
        () => testGroqKey("gsk_test", "openai/gpt-oss-20b"),
        /no usable test response/i
      );
    }
  );
});
