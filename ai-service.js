import { readStreamingText } from "./bedrock-event-stream.js";

const DEFAULT_BEDROCK_API_URL = "https://bedrock-runtime.us-west-2.amazonaws.com";
const MAX_COMPARISON_PAGE_TEXT_LENGTH = 30000;

const DUPLICATE_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["found", "uncertain", "new"] },
    summary: { type: "string" },
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          certainty: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string" },
        },
        required: ["id", "certainty", "reason"],
      },
    },
  },
  required: ["verdict", "summary", "matches"],
};

const NOTION_FIELDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    jobTitle: { type: "string" },
    companyName: { type: "string" },
    location: { type: "string" },
    publishedAt: { type: "string" },
    aiSummary: { type: "string" },
    fitScore: { anyOf: [{ type: "number" }, { type: "null" }] },
  },
  required: ["jobTitle", "companyName", "location", "publishedAt", "aiSummary", "fitScore"],
};

export function createAiService({
  apiKey,
  fetchImpl = fetch,
  bedrockApiUrl = DEFAULT_BEDROCK_API_URL,
} = {}) {
  if (!apiKey) throw new Error("Missing AI API key.");

  async function compareJobPageToSavedJobs({ modelId, page, jobs, signal } = {}) {
    if (!modelId) throw new Error("Missing model id.");
    if (!page?.text?.trim()) throw new Error("Missing page text.");
    if (!Array.isArray(jobs)) throw new Error("Jobs must be an array.");

    if (!jobs.length) {
      return {
        result: { verdict: "new", summary: "Notion has no saved jobs yet, so this page is treated as new.", matches: [] },
        usage: null,
      };
    }

    const urlMatch = page.url ? jobs.find((job) => normalizeUrl(job.jobUrl) === normalizeUrl(page.url)) : null;
    if (urlMatch) {
      return {
        result: {
          verdict: "found",
          urlMatch: true,
          summary: "",
          matches: [{
            id: urlMatch.id,
            notionUrl: urlMatch.notionUrl,
            jobTitle: urlMatch.jobTitle || urlMatch.name || "Untitled job",
            companyName: urlMatch.companyName || "",
            status: urlMatch.status || "",
            platform: urlMatch.platform || "",
            location: urlMatch.location || "",
            publishedAt: urlMatch.publishedAt || "",
            certainty: "high",
            reason: "",
          }],
        },
        usage: null,
      };
    }

    const prompt = buildDuplicateCheckPrompt({ page, jobs });
    const response = await runStructuredDuplicateCheck({ modelId, prompt, signal });
    return { result: parseComparisonResult(response.text, jobs), usage: response.usage || null };
  }

  async function streamJobAnalysis({ modelId, systemPrompt, page, signal, onDelta } = {}) {
    if (!modelId) throw new Error("Missing model id.");
    if (!systemPrompt?.trim()) throw new Error("Missing system prompt.");
    if (!page?.text?.trim()) throw new Error("Missing page text.");

    const response = await fetchImpl(`${bedrockApiUrl}/model/${modelId}/converse-stream`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        system: [{ text: systemPrompt }],
        messages: [{ role: "user", content: [{ text: buildJobAnalysisPrompt(page) }] }],
        inferenceConfig: { maxTokens: 2400, temperature: 0.2 },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error (${response.status}): ${errorText}`);
    }

    if (!response.body) throw new Error("Bedrock stream is unavailable.");

    return readStreamingText(response.body, { signal, onDelta });
  }

  async function streamChatReply({ modelId, systemPrompt, context, messages = [], userMessage, signal, onDelta } = {}) {
    if (!modelId) throw new Error("Missing model id.");
    if (!systemPrompt?.trim()) throw new Error("Missing system prompt.");
    if (!context) throw new Error("Missing chat context.");
    if (!userMessage?.trim()) throw new Error("Missing chat message.");

    const prompt = buildChatPrompt({ context, messages, userMessage });
    logChatPrompt(prompt, { context, messages, userMessage });

    const response = await fetchImpl(`${bedrockApiUrl}/model/${modelId}/converse-stream`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        system: [{ text: systemPrompt }],
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 1800, temperature: 0.2 },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error (${response.status}): ${errorText}`);
    }

    if (!response.body) throw new Error("Bedrock stream is unavailable.");

    return readStreamingText(response.body, { signal, onDelta });
  }

  async function runStructuredDuplicateCheck({ modelId, prompt, signal } = {}) {
    const response = await requestConverse({
      modelId,
      signal,
      system: [{
        text: [
          "You compare the current job page against a list of saved Notion jobs.",
          "Return the result in the provided structured format.",
          "Use `found` only when the current page clearly matches one or more saved jobs.",
          "Use `uncertain` when there are plausible duplicates but you are not fully confident.",
          "Use `new` when there is no convincing duplicate.",
          "don't assume a match solely on the job title - all job titles are similar.",
          "If different company - not a match. if different urls - not a match.",
          "Keep summary and reasons short.",
        ].join(" "),
      }],
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 1200, temperature: 0.1 },
      outputConfig: {
        textFormat: {
          type: "json_schema",
          structure: {
            jsonSchema: { name: "duplicate_check", description: "Duplicate job detection result", schema: JSON.stringify(DUPLICATE_CHECK_SCHEMA) },
          },
        },
      },
    });

    return { text: readAssistantText(response), usage: response?.usage || null };
  }

  async function extractNotionFields({ modelId, page, analysisText, signal } = {}) {
    if (!modelId) throw new Error("Missing model id.");
    if (!page?.text?.trim()) throw new Error("Missing page text.");
    if (!analysisText?.trim()) throw new Error("Missing analysis text.");

    const response = await requestConverse({
      modelId,
      signal,
      system: [{
        text: [
          "Extract Notion-ready job fields from the job page and the completed analysis.",
          "Return only the requested structured fields.",
          "Keep strings concise and useful.",
          "Use empty strings for unknown text fields.",
          "Use a number from 1 to 10 for fitScore only when the fit is clear, otherwise null.",
          "AI summary must be plain text, useful in Notion, and around 300-350 characters.",
        ].join(" "),
      }],
      messages: [{ role: "user", content: [{ text: buildNotionFieldsPrompt({ page, analysisText }) }] }],
      inferenceConfig: { maxTokens: 800, temperature: 0.1 },
      outputConfig: {
        textFormat: {
          type: "json_schema",
          structure: {
            jsonSchema: { name: "notion_fields", description: "Extracted Notion-ready job fields", schema: JSON.stringify(NOTION_FIELDS_SCHEMA) },
          },
        },
      },
    });

    return { fields: parseNotionFields(readAssistantText(response)), usage: response?.usage || null };
  }

  async function requestConverse({ modelId, signal, system, messages, inferenceConfig, outputConfig } = {}) {
    const response = await fetchImpl(`${bedrockApiUrl}/model/${modelId}/converse`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ system, messages, inferenceConfig, outputConfig }),
    });

    const responseText = await response.text();
    let data = null;
    try { data = responseText ? JSON.parse(responseText) : null; } catch { data = null; }

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${data?.message || data?.Message || responseText}`);
    }

    return data;
  }

  return { compareJobPageToSavedJobs, extractNotionFields, streamChatReply, streamJobAnalysis };
}

function buildDuplicateCheckPrompt({ page, jobs }) {
  return JSON.stringify(
    {
      currentPage: { title: page.title || "", url: page.url || "", text: page.text.slice(0, MAX_COMPARISON_PAGE_TEXT_LENGTH) },
      savedJobs: jobs,
    },
    null,
    2
  );
}

function buildJobAnalysisPrompt(page) {
  return [
    "Analyze this job opportunity for the user. Start directly with the analysis — no title heading.",
    `Title: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    "",
    "Page content:",
    page.text,
  ].join("\n");
}

function buildNotionFieldsPrompt({ page, analysisText }) {
  return JSON.stringify(
    {
      page: { title: page.title || "", url: page.url || "", text: page.text.slice(0, MAX_COMPARISON_PAGE_TEXT_LENGTH) },
      analysisText,
    },
    null,
    2
  );
}

function buildChatPrompt({ context, messages, userMessage }) {
  return [
    "Continue the chat using the context below.",
    "If the context does not contain enough information, say what is missing.",
    "",
    "## Current page",
    JSON.stringify(context.page, null, 2),
    "",
    "## Duplicate check",
    JSON.stringify(context.duplicateCheck, null, 2),
    "",
    "## Matched Notion jobs",
    JSON.stringify(context.matchedNotionJobs || [], null, 2),
    "",
    "## Completed analysis",
    context.analysisText || "No analysis is available yet.",
    "",
    "## Extracted Notion fields",
    JSON.stringify(context.notionDraft || null, null, 2),
    "",
    "## Recent conversation",
    JSON.stringify(messages.slice(-12), null, 2),
    "",
    "## User question",
    userMessage,
  ].join("\n");
}

function logChatPrompt(prompt, details) {
  console.groupCollapsed("💬 Chat LLM prompt");
  console.log("Context object:", details.context);
  console.log("Recent conversation:", details.messages.slice(-12));
  console.log("User question:", details.userMessage);
  console.log("Prompt sent as user message:\n" + prompt);
  console.groupEnd();
}

function readAssistantText(response) {
  return (response?.output?.message?.content || []).map((part) => part?.text || "").filter(Boolean).join("");
}

function parseComparisonResult(responseText, jobs) {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const parsed = JSON.parse(extractJsonObject(responseText));
  const verdict = normalizeVerdict(parsed.verdict);
  const matches = Array.isArray(parsed.matches)
    ? parsed.matches
        .map((match) => {
          const job = jobsById.get(match?.id);
          if (!job) return null;
          return {
            id: job.id,
            notionUrl: job.notionUrl,
            jobTitle: job.jobTitle || job.name || "Untitled job",
            companyName: job.companyName || "",
            status: job.status || "",
            platform: job.platform || "",
            location: job.location || "",
            publishedAt: job.publishedAt || "",
            certainty: normalizeCertainty(match.certainty),
            reason: truncateText(match.reason, 160),
          };
        })
        .filter(Boolean)
    : [];

  return {
    verdict: matches.length ? verdict : verdict === "new" ? "new" : "uncertain",
    summary: truncateText(parsed.summary, 240),
    matches,
  };
}

function parseNotionFields(responseText) {
  const parsed = JSON.parse(extractJsonObject(responseText));
  return {
    jobTitle: truncateText(parsed.jobTitle, 160),
    companyName: truncateText(parsed.companyName, 120),
    location: truncateText(parsed.location, 160),
    publishedAt: truncateText(parsed.publishedAt, 80),
    aiSummary: truncateText(parsed.aiSummary, 500),
    fitScore: typeof parsed.fitScore === "number" ? parsed.fitScore : null,
  };
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    // Strip trailing slash and fragment; keep path + query for matching
    return `${url.hostname}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function normalizeVerdict(value) {
  return ["found", "uncertain", "new"].includes(value) ? value : "uncertain";
}

function normalizeCertainty(value) {
  return ["high", "medium", "low"].includes(value) ? value : "medium";
}

function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Model returned empty text.");

  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```\s*([\s\S]*?)```/);
  if (fencedMatch) return fencedMatch[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("Model returned invalid JSON.");

  return trimmed.slice(start, end + 1);
}

function truncateText(value, maxLength) {
  if (!value) return "";
  return String(value).slice(0, maxLength);
}
