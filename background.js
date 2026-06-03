import { createAiService } from "./ai-service.js";
import { renderComparisonMarkdown } from "./comparison-renderer.js";
import { estimateCostUsd, MODELS } from "./model-config.js";
import { createNotionService } from "./notion.js";
import { renderNotionPreviewMarkdown } from "./notion-draft.js";
import { readPageText } from "./page-reader.js";
import { createTabSession } from "./tab-session.js";

const MAX_PAGE_TEXT_LENGTH = 200000;
const SIDE_PANEL_PATH = "sidepanel.html";
const PROMPT_PATHS = ["config/prompt.local.md", "config/prompt.example.md"];

const activeByTab = new Map();
const tabSession = createTabSession();
let analysisPrompt = null;

function normalizeTabId(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid tab id: ${tabId}`);
  }
  return id;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = activeByTab.get(tabId);
  if (entry) {
    entry.controller.abort();
    activeByTab.delete(tabId);
  }
  tabSession.clear(tabId).catch((err) => console.error("❌ Failed to clear tab session", err));
});

initializeSidePanel();

function initializeSidePanel() {
  configureSidePanelAction();
  configureExistingTabs();

  chrome.runtime.onInstalled.addListener(() => {
    configureSidePanelAction();
    configureExistingTabs();
  });

  chrome.runtime.onStartup.addListener(() => {
    configureSidePanelAction();
    configureExistingTabs();
  });

  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id) configureTabSidePanel(tab.id);
  });

  chrome.tabs.onUpdated.addListener((tabId) => {
    configureTabSidePanel(tabId);
  });
}

function configureSidePanelAction() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.error("Failed to configure side panel action click", err);
  });
}

async function configureExistingTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) configureTabSidePanel(tab.id);
  }
}

function configureTabSidePanel(tabId) {
  chrome.sidePanel.setOptions({ tabId, path: sidePanelPathForTab(tabId), enabled: true }).catch((err) => {
    console.error("Failed to enable side panel for tab", err);
  });
}

function sidePanelPathForTab(tabId) {
  return `${SIDE_PANEL_PATH}?tabId=${tabId}`;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "analyze-page") {
    startAnalysis(normalizeTabId(message.tabId), message.model, message.requestId, message.forceFullAnalysis);
    return;
  }

  if (message.type === "save-to-notion") {
    saveToNotion(normalizeTabId(message.tabId), message.status, message.saveTarget, message.draft).catch((err) => {
      console.error("❌ Failed to save to Notion:", err);
      safeSendRuntimeMessage({ type: "save-error", tabId: message.tabId, error: err.message });
    });
  }

  if (message.type === "chat-message") {
    const tabId = normalizeTabId(message.tabId);
    continueChat(tabId, message.model, message.requestId, message.text).catch((err) => {
      console.error("❌ Failed to continue chat:", err);
      safeSendRuntimeMessage({ type: "chat-error", tabId, requestId: message.requestId, error: err.message });
    });
  }
});

function startAnalysis(tabId, modelKey, requestId, forceFullAnalysis = false) {
  const existing = activeByTab.get(tabId);
  if (existing) {
    console.log(`ℹ️ [${tabId}] aborting previous analysis: new analysis started`);
    existing.controller.abort();
  }

  const controller = new AbortController();
  activeByTab.set(tabId, { requestId, controller, startedAt: performance.now(), forceFullAnalysis });

  console.log(`🔍 [${tabId}] analysis start (${modelKey})${forceFullAnalysis ? " [forced]" : ""}`);
  analyzePage(tabId, modelKey, requestId, controller.signal);
}

function elapsedMs(tabId) {
  const entry = activeByTab.get(tabId);
  return entry ? Math.round(performance.now() - entry.startedAt) : 0;
}

function isActive(tabId, requestId) {
  return activeByTab.get(tabId)?.requestId === requestId;
}

async function saveToNotion(tabId, status, saveTarget, draftFromMessage) {
  const context = await tabSession.getContext(tabId);
  const draft = context?.notionDraft || draftFromMessage;

  if (!draft) {
    throw new Error("AI Notion fields are not ready. Run analysis first.");
  }

  const service = await createNotionServiceFromStorage();
  const actionLabel = `${saveTarget?.mode === "update" ? "upd" : "new"}: ${status}`;
  const tab = await chrome.tabs.get(tabId);
  const hostname = tab.url ? new URL(tab.url).hostname.replace(/^www\./, "") : "";

  console.log(`📋 [${tabId}] save draft:`, draft);

  const notionFields = {
    jobTitle: draft.jobTitle,
    companyName: draft.companyName,
    status,
    url: tab.url || "",
    platform: hostname,
    location: draft.location,
    createdAt: new Date(),
    publishedAt: draft.publishedAt,
    aiSummary: draft.aiSummary,
    fitScore: draft.fitScore,
  };

  let job;
  if (saveTarget?.mode === "update" && saveTarget.pageId) {
    console.log(`📝 Updating Notion job ${saveTarget.pageId}`);
    job = await service.updateJob(saveTarget.pageId, {
      jobTitle: notionFields.jobTitle,
      companyName: notionFields.companyName,
      status: notionFields.status,
      url: notionFields.url,
      platform: notionFields.platform,
      location: notionFields.location,
      publishedAt: notionFields.publishedAt,
      aiSummary: notionFields.aiSummary,
      fitScore: notionFields.fitScore,
    });
  } else {
    console.log(`📝 Creating Notion job -> ${status}`);
    job = await service.createJob(notionFields);
  }

  safeSendRuntimeMessage({ type: "save-success", tabId, status: actionLabel || "Saved", notionUrl: job.notionUrl });
}

async function analyzePage(tabId, modelKey, requestId, signal) {
  try {
    sendAnalysisMessage(tabId, requestId, { type: "progress", text: "⏳ Reading page…" });
    const tab = await chrome.tabs.get(tabId);
    const pageText = (await readPageText(tabId, tab.url)).slice(0, MAX_PAGE_TEXT_LENGTH);
    await tabSession.initContext(tabId, {
      page: { title: tab.title || "", url: tab.url || "", text: pageText },
      notionJobs: [],
      totalNotionJobs: 0,
      duplicateCheck: null,
      analysisText: "",
      notionDraft: null,
    });
    console.log(`📄 [${tabId}] page text: ${pageText.length} chars (+${elapsedMs(tabId)}ms)`);
    console.log(`📄 [${tabId}] page text content:\n`, pageText);

    if (!pageText.trim()) {
      sendAnalysisMessage(tabId, requestId, { type: "error", error: "No text found on page." });
      return;
    }

    sendAnalysisMessage(tabId, requestId, { type: "progress", text: "🗂️ Checking Notion for matches…" });
    const notionService = await createNotionServiceFromStorage();
    const jobs = await notionService.queryAllJobs();
    await updateChatContext(tabId, { notionJobs: jobs, totalNotionJobs: jobs.length });
    console.log(`🗂️ [${tabId}] loaded ${jobs.length} Notion jobs (+${elapsedMs(tabId)}ms)`);

    const prompt = await getAnalysisPrompt();
    await comparePageAgainstNotion(tabId, tab, pageText, jobs, modelKey, requestId, signal, prompt);
  } catch (err) {
    if (signal.aborted || !isActive(tabId, requestId)) return;
    sendAnalysisMessage(tabId, requestId, { type: "error", error: "Failed to read page: " + err.message });
  }
}

async function comparePageAgainstNotion(tabId, tab, pageText, jobs, modelKey, requestId, signal, prompt) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    sendAnalysisMessage(tabId, requestId, { type: "error", error: "API key not set. Enter it above." });
    return;
  }

  const model = MODELS[modelKey] || MODELS.sonnet;
  const aiService = createAiService({ apiKey });

  try {
    sendAnalysisMessage(tabId, requestId, { type: "progress", text: "🤖 Comparing this page with Notion…" });

    const { result, usage } = await aiService.compareJobPageToSavedJobs({
      modelId: model.modelId,
      page: { title: tab.title || "", url: tab.url || "", text: pageText },
      jobs,
      signal,
    });
    await updateChatContext(tabId, { duplicateCheck: result });
    console.log(`🔎 [${tabId}] duplicate result: ${result.verdict}, matches: ${result.matches.length}`, result);

    sendAnalysisMessage(tabId, requestId, { type: "notion-match-result", verdict: result.verdict });

    const autoAnalyze = result.verdict === "new" || result.verdict === "uncertain";
    if (autoAnalyze || messageForcesFullAnalysis(requestId, signal)) {
      if (result.verdict === "uncertain") {
        sendAnalysisMessage(tabId, requestId, {
          type: "analysis-result",
          verdict: result.verdict,
          saveTarget: getSaveTarget(result),
          canForceAnalyze: false,
          markdown: renderComparisonMarkdown(result),
        });
      }
      await streamFullAnalysis({ tabId, tab, pageText, model, requestId, signal, aiService, analysisPrompt: prompt, previousUsage: usage, preserveResponse: result.verdict === "uncertain" });
      return;
    }

    sendAnalysisMessage(tabId, requestId, {
      type: "analysis-result",
      verdict: result.verdict,
      saveTarget: getSaveTarget(result),
      canForceAnalyze: true,
      markdown: renderComparisonMarkdown(result),
    });

    if (usage) {
      sendAnalysisMessage(tabId, requestId, { type: "usage", usage, costUsd: estimateCostUsd(usage, model.pricing) });
    }

    console.log(`🏁 [${tabId}] comparison ready (+${elapsedMs(tabId)}ms)`);
  } catch (err) {
    if (signal.aborted || err.name === "AbortError" || !isActive(tabId, requestId)) return;
    console.log(`❌ [${tabId}] failed (+${elapsedMs(tabId)}ms): ${err.message}`);
    sendAnalysisMessage(tabId, requestId, { type: "error", error: "Request failed: " + err.message });
  } finally {
    if (activeByTab.get(tabId)?.controller.signal === signal) {
      activeByTab.delete(tabId);
    }
  }
}

async function streamFullAnalysis({ tabId, tab, pageText, model, requestId, signal, aiService, analysisPrompt, previousUsage, preserveResponse = false }) {
  sendAnalysisMessage(tabId, requestId, { type: "progress", text: "✨ Generating job analysis…" });
  sendAnalysisMessage(tabId, requestId, { type: "stream-start", preserveResponse });

  const { text, usage } = await aiService.streamJobAnalysis({
    modelId: model.modelId,
    systemPrompt: analysisPrompt,
    page: { title: tab.title || "", url: tab.url || "", text: pageText },
    signal,
    onDelta(textDelta) {
      if (!signal.aborted && isActive(tabId, requestId)) {
        sendAnalysisMessage(tabId, requestId, { type: "stream-delta", text: textDelta });
      }
    },
  });

  if (!text.trim()) throw new Error("Analysis returned no text.");
  sendAnalysisMessage(tabId, requestId, { type: "progress", text: "🧾 Preparing Notion fields…" });
  const extraction = await aiService.extractNotionFields({
    modelId: model.modelId,
    page: { title: tab.title || "", url: tab.url || "", text: pageText },
    analysisText: text,
    signal,
  });
  const notionDraft = extraction.fields;
  console.log(`🤖 [${tabId}] AI extracted Notion fields:`, notionDraft);

  await updateChatContext(tabId, { analysisText: text, notionDraft });
  sendAnalysisMessage(tabId, requestId, {
    type: "notion-preview",
    draft: notionDraft,
    markdown: renderNotionPreviewMarkdown(notionDraft, tab),
  });

  const totalUsage = sumUsage(previousUsage, usage);
  if (totalUsage) {
    sendAnalysisMessage(tabId, requestId, { type: "usage", usage: totalUsage, costUsd: estimateCostUsd(totalUsage, model.pricing) });
  }
}

async function continueChat(tabId, modelKey, requestId, userMessage) {
  const context = await tabSession.getContext(tabId);
  if (!context) {
    safeSendRuntimeMessage({ type: "chat-error", tabId, requestId, error: "Analyze the page before chatting." });
    return;
  }

  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    safeSendRuntimeMessage({ type: "chat-error", tabId, requestId, error: "API key not set. Enter it above." });
    return;
  }

  const model = MODELS[modelKey] || MODELS.sonnet;
  const prompt = await getAnalysisPrompt();
  const aiService = createAiService({ apiKey });
  const messages = await tabSession.getHistory(tabId);
  const historyEntry = { role: "user", text: userMessage };
  tabSession.setHistory(tabId, [...messages, historyEntry]);
  await tabSession.save(tabId);

  safeSendRuntimeMessage({ type: "chat-start", tabId, requestId });

  const { text, usage } = await aiService.streamChatReply({
    modelId: model.modelId,
    systemPrompt: prompt,
    context: compactChatContext(context),
    messages,
    userMessage,
    onDelta(textDelta) {
      safeSendRuntimeMessage({ type: "chat-delta", tabId, requestId, text: textDelta });
    },
  });

  tabSession.setHistory(tabId, [...messages, historyEntry, { role: "assistant", text }]);
  await tabSession.save(tabId);

  safeSendRuntimeMessage({
    type: "chat-complete",
    tabId,
    requestId,
    usage,
    costUsd: estimateCostUsd(usage, model.pricing),
  });
}

async function updateChatContext(tabId, updates) {
  await tabSession.persistContextUpdate(tabId, updates);
}

function compactChatContext(context) {
  const matchedJobIds = new Set(
    (context.duplicateCheck?.matches || [])
      .map((match) => match.id)
      .filter(Boolean)
  );
  const matchedJobs = (context.notionJobs || []).filter((job) => matchedJobIds.has(job.id));

  return {
    page: context.page,
    notionJobsCheckedCount: context.totalNotionJobs || 0,
    matchedNotionJobs: matchedJobs.map((job) => ({
      id: job.id,
      notionUrl: job.notionUrl,
      jobTitle: job.jobTitle || job.name,
      companyName: job.companyName,
      status: job.status,
      jobUrl: job.jobUrl,
      platform: job.platform,
      location: job.location,
      createdAt: job.createdAt,
      publishedAt: job.publishedAt,
      aiSummary: job.aiSummary,
      fitScore: job.fitScore,
    })),
    duplicateCheck: context.duplicateCheck,
    analysisText: context.analysisText,
    notionDraft: context.notionDraft,
  };
}

function sendAnalysisMessage(tabId, requestId, message) {
  if (!isActive(tabId, requestId)) return;
  chrome.runtime.sendMessage({ ...message, tabId, requestId }).catch((error) => {
    if (String(error?.message || error || "").includes("Receiving end does not exist")) {
      abortActiveAnalysis(tabId, requestId);
      return;
    }

    console.error("❌ Failed to deliver runtime message", error);
  });
}

function safeSendRuntimeMessage(message) {
  chrome.runtime.sendMessage(message).catch((error) => {
    if (String(error?.message || error || "").includes("Receiving end does not exist")) {
      console.log("ℹ️ Runtime message skipped: side panel is not listening");
      return;
    }
    console.error("❌ Failed to deliver runtime message", error);
  });
}

function abortActiveAnalysis(tabId, requestId) {
  const entry = activeByTab.get(tabId);
  if (entry?.requestId !== requestId) return;

  console.log(`ℹ️ [${tabId}] aborting analysis: side panel is not listening`);
  entry.controller.abort();
  activeByTab.delete(tabId);
}

async function createNotionServiceFromStorage() {
  const { notionApiKey, notionDataSourceId } = await chrome.storage.local.get(["notionApiKey", "notionDataSourceId"]);
  if (!notionApiKey) throw new Error("Notion API key not set. Enter it above.");
  if (!notionDataSourceId) throw new Error("Notion data source ID not set. Enter it above.");
  return createNotionService({ authToken: notionApiKey, dataSourceId: notionDataSourceId });
}

async function getAnalysisPrompt() {
  if (analysisPrompt) return analysisPrompt;
  for (const promptPath of PROMPT_PATHS) {
    const response = await fetch(chrome.runtime.getURL(promptPath));
    if (response.ok) {
      analysisPrompt = await response.text();
      return analysisPrompt;
    }
  }
  throw new Error("Analysis prompt not found. Add config/prompt.local.md or keep config/prompt.example.md.");
}

function sumUsage(firstUsage, secondUsage) {
  if (!firstUsage && !secondUsage) return null;
  const a = firstUsage || {};
  const b = secondUsage || {};
  return {
    inputTokens: Number(a.inputTokens || 0) + Number(b.inputTokens || 0),
    outputTokens: Number(a.outputTokens || 0) + Number(b.outputTokens || 0),
    totalTokens: Number(a.totalTokens || 0) + Number(b.totalTokens || 0),
  };
}

function getSaveTarget(result) {
  if (result.verdict !== "found" || !result.matches.length) return null;
  return { mode: "update", pageId: result.matches[0].id };
}

function messageForcesFullAnalysis(requestId, signal) {
  for (const entry of activeByTab.values()) {
    if (entry.requestId === requestId && entry.controller.signal === signal) {
      return Boolean(entry.forceFullAnalysis);
    }
  }
  return false;
}
