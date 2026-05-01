import { renderMarkdown } from "./markdown.js";
import { formatUsageSummary } from "./usage-format.js";

const settingsBtn = document.getElementById("settings-btn");
const rerunBtn = document.getElementById("rerun-btn");
const ignoreBtn = document.getElementById("ignore-btn");
const appliedBtn = document.getElementById("applied-btn");
const settingsPanel = document.getElementById("settings-panel");
const modelSelect = document.getElementById("model-select");
const currentModelLabelEl = document.getElementById("current-model-label");
const apiKeyInput = document.getElementById("api-key-input");
const notionApiKeyInput = document.getElementById("notion-api-key-input");
const notionDataSourceIdInput = document.getElementById("notion-data-source-id-input");
const saveKeyBtn = document.getElementById("save-key-btn");
const statusLineEl = document.getElementById("status-line");
const statusSummaryEl = document.getElementById("status-summary");
const inlineStatusLineEl = document.getElementById("inline-status-line");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const statusSpinnerEl = document.getElementById("status-spinner");
const statusRetryBtn = document.getElementById("status-retry-btn");
const inlineStatusEl = document.getElementById("inline-status");
const inlineStatusTextEl = document.getElementById("inline-status-text");
const inlineStatusSpinnerEl = document.getElementById("inline-status-spinner");
const inlineStatusRetryBtn = document.getElementById("inline-status-retry-btn");
const responseEl = document.getElementById("response");
const responseActionsEl = document.getElementById("response-actions");
const analyzeBtn = document.getElementById("analyze-btn");
const usageSummaryEl = document.getElementById("usage-summary");
const chatFormEl = document.getElementById("chat-form");
const chatInputEl = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const scrollToBottomBtn = document.getElementById("scroll-to-bottom-btn");

let responseText = "";
let autoScrollEnabled = true;
let hasSavedApiKey = false;
let hasSavedNotionApiKey = false;
let hasSavedNotionDataSourceId = false;
let currentRequestId = null;
let currentTabId = null;
let analysisStartedAt = 0;
let statusHistory = [];
let saveTarget = null;
let canForceAnalyze = false;
let preserveResponseOnNextAnalysis = false;
let savedMatchMarkdown = "";
let lastStatusAt = 0;
let streamingStatusShown = false;
let actionsReady = false;
let saveInProgress = false;
let chatReady = false;
let chatInProgress = false;
let currentChatRequestId = null;
let notionDraft = null;

const AUTO_SCROLL_THRESHOLD = 48;
const MAX_CHAT_INPUT_LINES = 10;

setStatusLine("Starting…");
showStatus("Preparing extension…", { isLoading: true });
initialize();

saveKeyBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  const notionApiKey = notionApiKeyInput.value.trim();
  const notionDataSourceId = notionDataSourceIdInput.value.trim();

  chrome.storage.local.set({ apiKey: key, notionApiKey, notionDataSourceId }, () => {
    console.log("💾 Settings saved");
    hasSavedApiKey = Boolean(key);
    hasSavedNotionApiKey = Boolean(notionApiKey);
    hasSavedNotionDataSourceId = Boolean(notionDataSourceId);
    statusEl.hidden = true;
    if (canRunAnalysis()) {
      triggerAnalysis();
    } else {
      setStatusLine("Waiting for credentials");
      showStatus("Settings saved.");
    }
  });
});

rerunBtn.addEventListener("click", handleRetry);
statusRetryBtn.addEventListener("click", handleRetry);
inlineStatusRetryBtn.addEventListener("click", handleRetry);

function handleRetry() {
  if (blockAnalysisDuringChat()) return;

  if (canRunAnalysis()) {
    triggerAnalysis({ resetStatusHistory: true });
  } else {
    openSettingsPanel();
    apiKeyInput.focus();
  }
}

settingsBtn.addEventListener("click", () => {
  const isOpen = !settingsPanel.hidden;
  if (isOpen) {
    closeSettingsPanel();
  } else {
    openSettingsPanel();
  }
});
modelSelect.addEventListener("change", () => {
  updateCurrentModelLabel();
  chrome.storage.local.set({ selectedModel: modelSelect.value });
  if (blockAnalysisDuringChat()) return;

  if (canRunAnalysis()) {
    triggerAnalysis();
  }
});
ignoreBtn.addEventListener("click", () => saveToNotion("Ignore"));
appliedBtn.addEventListener("click", () => saveToNotion("Applied"));
analyzeBtn.addEventListener("click", () => {
  if (blockAnalysisDuringChat()) return;
  triggerAnalysis({ forceFullAnalysis: true });
});
chatFormEl.addEventListener("submit", handleChatSubmit);
chatInputEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  handleChatSubmit(event);
});
chatInputEl.addEventListener("input", resizeChatInput);
window.addEventListener("scroll", handleScroll, { passive: true });
scrollToBottomBtn.addEventListener("click", () => {
  autoScrollEnabled = true;
  scrollToBottom("smooth");
});

async function saveToNotion(status) {
  if (!actionsReady || saveInProgress) return;

  try {
    const tab = await getActiveTab();
    const notionStatus = status === "Ignore" ? "Ignored" : status;
    const saveMode = saveTarget ? "update" : "create";
    const messageSaveTarget = saveMode === "update" ? saveTarget : null;
    const actionLabel = `${saveMode === "update" ? "upd" : "new"}: ${notionStatus}`;
    saveInProgress = true;
    updateSaveButtons();
    updateAnalyzeButton();
    updateChatForm();
    console.log(`📝 Saving current page as ${actionLabel}`);
    setStatusLine("Saving to Notion");
    statusEl.hidden = true;
    showInlineStatus(`Saving to Notion as ${actionLabel}...`, { isLoading: true });
    chrome.runtime.sendMessage({
      type: "save-to-notion",
      status: notionStatus,
      tabId: tab.id,
      saveTarget: messageSaveTarget,
      draft: notionDraft,
    });
  } catch (error) {
    saveInProgress = false;
    updateSaveButtons();
    updateAnalyzeButton();
    updateChatForm();
    console.error("❌ Failed to start Notion save", error);
    setStatusLine("Save failed");
    showInlineStatus(`❌ ${error.message}`, { isError: true });
  }
}

async function triggerAnalysis({ forceFullAnalysis = false, resetStatusHistory = false } = {}) {
  if (blockAnalysisDuringChat()) return;

  try {
    const previousSaveTarget = saveTarget;
    const previousCanForceAnalyze = canForceAnalyze;
    currentRequestId = crypto.randomUUID();
    analysisStartedAt = Date.now();
    lastStatusAt = analysisStartedAt;
    if (resetStatusHistory) statusHistory = [];
    preserveResponseOnNextAnalysis = forceFullAnalysis && Boolean(responseText.trim());
    streamingStatusShown = false;
    if (!preserveResponseOnNextAnalysis) {
      resetResponse();
    }
    if (forceFullAnalysis) {
      saveTarget = previousSaveTarget;
      canForceAnalyze = previousCanForceAnalyze;
    } else {
      saveTarget = null;
      canForceAnalyze = false;
      actionsReady = false;
    }
    chatReady = false;
    chatInProgress = false;
    currentChatRequestId = null;
    updateSaveButtons();
    updateAnalyzeButton();
    updateChatForm();
    rerunBtn.hidden = true;
    showStatus("⏳ Reading page…", { isLoading: true });

    const tab = await getActiveTab();
    console.log(`🚀 Triggering analysis for tab ${tab.id} with ${modelSelect.value}`);
    chrome.runtime.sendMessage({
      type: "analyze-page",
      tabId: tab.id,
      model: modelSelect.value,
      requestId: currentRequestId,
      forceFullAnalysis,
    });
  } catch (error) {
    console.error("❌ Failed to trigger analysis", error);
    setStatusLine("Startup error");
    rerunBtn.hidden = false;
    showStatus(error.message, { isError: true });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.tabId && currentTabId && message.tabId !== currentTabId) return;
  if (message.requestId && message.requestId !== currentRequestId && message.requestId !== currentChatRequestId) return;

  if (message.type === "progress") {
    rerunBtn.hidden = true;
    setStatusLine(message.text);
    if (message.text === "🧾 Preparing Notion fields…") {
      showInlineStatus(message.text, { isLoading: true });
      statusEl.hidden = true;
    } else {
      hideInlineStatus();
      showStatus(message.text, { isLoading: true });
    }
  } else if (message.type === "notion-match-result") {
    setStatusLine(getNotionMatchStatusText(message.verdict));
  } else if (message.type === "stream-start") {
    if (preserveResponseOnNextAnalysis || message.preserveResponse) {
      savedMatchMarkdown = responseText;
      responseText = "";
      preserveResponseOnNextAnalysis = false;
    } else {
      resetResponse();
    }
    streamingStatusShown = false;
    chatReady = false;
    chatInProgress = false;
    currentChatRequestId = null;
    updateChatForm();
    setStatusLine("Waiting for response");
    hideInlineStatus();
    showStatus("✨ Waiting for first token…", { isLoading: true });
  } else if (message.type === "stream-delta") {
    statusEl.hidden = true;
    hideInlineStatus();
    if (!streamingStatusShown) {
      setStatusLine("Streaming analysis");
      streamingStatusShown = true;
    }
    responseText += message.text;
    responseEl.innerHTML = renderMarkdown(responseText);
    if (autoScrollEnabled) {
      scrollToBottom();
    } else {
      updateScrollToBottomButton();
    }
  } else if (message.type === "analysis-result") {
    statusEl.hidden = true;
    hideInlineStatus();
    preserveResponseOnNextAnalysis = false;
    actionsReady = false;
    saveInProgress = false;
    chatReady = true;
    chatInProgress = false;
    saveTarget = message.saveTarget || null;
    canForceAnalyze = Boolean(message.canForceAnalyze);
    updateSaveButtons();
    updateAnalyzeButton();
    updateChatForm();
    setStatusLine(getAnalysisResultStatusText(message.verdict));
    responseText = message.markdown || "";
    responseEl.innerHTML = renderMarkdown(responseText);
    if (autoScrollEnabled) scrollToBottom();
  } else if (message.type === "notion-preview") {
    actionsReady = true;
    saveInProgress = false;
    chatReady = true;
    chatInProgress = false;
    notionDraft = message.draft || null;
    updateSaveButtons();
    updateAnalyzeButton();
    updateChatForm();
    hideInlineStatus();
    responseText = `${responseText.trimEnd()}\n\n${message.markdown}`;
    if (savedMatchMarkdown) {
      responseText = `${responseText.trimEnd()}\n\n---\n\n${savedMatchMarkdown}`;
      savedMatchMarkdown = "";
    }
    responseEl.innerHTML = renderMarkdown(responseText);
    if (autoScrollEnabled) scrollToBottom();
  } else if (message.type === "usage") {
    setStatusLine("Complete");
    preserveResponseOnNextAnalysis = false;
    rerunBtn.hidden = true;
    hideInlineStatus();
    statusEl.hidden = true;
    usageSummaryEl.textContent = formatUsageSummary(message.usage, message.costUsd, getElapsedSeconds());
    usageSummaryEl.hidden = false;
    if (autoScrollEnabled) scrollToBottom();
  } else if (message.type === "error") {
    if (needsApiKey(message.error)) {
      hasSavedApiKey = false;
      openSettingsPanel();
    }
    preserveResponseOnNextAnalysis = false;
    saveInProgress = false;
    chatInProgress = false;
    updateSaveButtons();
    updateAnalyzeButton();
    updateChatForm();
    hideInlineStatus();
    setStatusLine("Error");
    rerunBtn.hidden = false;
    showStatus(message.error, { isError: true });
  } else if (message.type === "save-success") {
    saveInProgress = false;
    updateSaveButtons();
    updateAnalyzeButton();
    updateChatForm();
    setStatusLine("Saved");
    statusEl.hidden = true;
    showInlineStatus(`✅ Saved to Notion as ${message.status}.`);
  } else if (message.type === "save-error") {
    saveInProgress = false;
    updateSaveButtons();
    updateAnalyzeButton();
    updateChatForm();
    setStatusLine("Save failed");
    rerunBtn.hidden = false;
    statusEl.hidden = true;
    showInlineStatus(`❌ ${message.error}`, { isError: true });
  } else if (message.type === "chat-start") {
    chatInProgress = true;
    updateChatForm();
    showInlineStatus("💬 Thinking...", { isLoading: true });
  } else if (message.type === "chat-delta") {
    statusEl.hidden = true;
    hideInlineStatus();
    responseText += message.text;
    responseEl.innerHTML = renderMarkdown(responseText);
    if (autoScrollEnabled) {
      scrollToBottom();
    } else {
      updateScrollToBottomButton();
    }
  } else if (message.type === "chat-complete") {
    chatInProgress = false;
    currentChatRequestId = null;
    updateChatForm();
    hideInlineStatus();
    if (message.usage) {
      usageSummaryEl.textContent = formatUsageSummary(message.usage, message.costUsd, null);
      usageSummaryEl.hidden = false;
    }
  } else if (message.type === "chat-error") {
    chatInProgress = false;
    currentChatRequestId = null;
    updateChatForm();
    showInlineStatus(`❌ ${message.error}`, { isError: true });
  }
});

async function handleChatSubmit(event) {
  event.preventDefault();
  if (!chatReady || chatInProgress) return;

  const text = chatInputEl.value.trim();
  if (!text) return;

  try {
    const tab = await getActiveTab();
    currentChatRequestId = crypto.randomUUID();
    chatInProgress = true;
    chatInputEl.value = "";
    resizeChatInput();
    updateChatForm();
    appendChatMessage("You", text);
    appendChatMessage("AI", "");
    showInlineStatus("💬 Thinking...", { isLoading: true });

    chrome.runtime.sendMessage({
      type: "chat-message",
      tabId: tab.id,
      model: modelSelect.value,
      requestId: currentChatRequestId,
      text,
    });
  } catch (error) {
    chatInProgress = false;
    currentChatRequestId = null;
    updateChatForm();
    showInlineStatus(`❌ ${error.message}`, { isError: true });
  }
}

async function initialize() {
  try {
    console.log("🔍 Initializing side panel");
    const tab = await getActiveTab();
    currentTabId = tab.id;
    const { apiKey, selectedModel, notionApiKey, notionDataSourceId } = await chrome.storage.local.get([
      "apiKey",
      "selectedModel",
      "notionApiKey",
      "notionDataSourceId",
    ]);
    hasSavedApiKey = Boolean(apiKey);
    hasSavedNotionApiKey = Boolean(notionApiKey);
    hasSavedNotionDataSourceId = Boolean(notionDataSourceId);
    apiKeyInput.value = apiKey || "";
    notionApiKeyInput.value = notionApiKey || "";
    notionDataSourceIdInput.value = notionDataSourceId || "";
    if (selectedModel && modelSelect.querySelector(`option[value="${selectedModel}"]`)) {
      modelSelect.value = selectedModel;
    }
    updateCurrentModelLabel();

    if (canRunAnalysis()) {
      setStatusLine("Ready to analyze");
      triggerAnalysis();
    } else {
      setStatusLine("Setup required");
      showStatus("Add your API keys and Notion data source ID to start analyzing jobs.");
      openSettingsPanel();
    }
  } catch (error) {
    console.error("❌ Failed to initialize side panel", error);
    setStatusLine("Startup error");
    showStatus("Failed to initialize the extension panel.", { isError: true });
  }
}

function showStatus(text, { isError = false, isLoading = false } = {}) {
  statusTextEl.textContent = text;
  statusEl.hidden = false;
  statusSpinnerEl.hidden = !isLoading;
  statusRetryBtn.hidden = !isError;
  statusEl.className = "status" + (isError ? " error" : "");
}

function setStatusLine(text) {
  if (!text) {
    statusSummaryEl.textContent = "";
    statusLineEl.textContent = "";
    return;
  }

  const entryText = appendElapsedToStatus(text);
  const lastEntry = statusHistory[statusHistory.length - 1];
  if (lastEntry !== entryText) statusHistory.push(entryText);

  statusSummaryEl.textContent = entryText;
  statusLineEl.textContent = statusHistory.join(" → ");
}

function showInlineStatus(text, { isError = false, isLoading = false } = {}) {
  inlineStatusTextEl.textContent = text;
  inlineStatusEl.hidden = false;
  inlineStatusSpinnerEl.hidden = !isLoading;
  inlineStatusRetryBtn.hidden = !isError;
  inlineStatusEl.className = "status inline-status" + (isError ? " error" : "");
}

function hideInlineStatus() {
  inlineStatusEl.hidden = true;
}

function openSettingsPanel() {
  settingsPanel.hidden = false;
  settingsBtn.setAttribute("aria-expanded", "true");
}

function closeSettingsPanel() {
  settingsPanel.hidden = true;
  settingsBtn.setAttribute("aria-expanded", "false");
}

function needsApiKey(errorText) {
  return (
    errorText === "API key not set. Enter it above." ||
    errorText === "Notion API key not set. Enter it above." ||
    errorText === "Notion data source ID not set. Enter it above." ||
    errorText.includes("Invalid API Key")
  );
}

function canRunAnalysis() {
  return hasSavedApiKey && hasSavedNotionApiKey && hasSavedNotionDataSourceId;
}

function updateCurrentModelLabel() {
  currentModelLabelEl.textContent = modelSelect.selectedOptions[0]?.textContent || "Model";
}

function updateSaveButtons() {
  const prefix = saveTarget?.mode === "update" ? "upd" : "new";
  ignoreBtn.hidden = !actionsReady;
  appliedBtn.hidden = !actionsReady;
  ignoreBtn.disabled = saveInProgress || !actionsReady;
  appliedBtn.disabled = saveInProgress || !actionsReady;
  ignoreBtn.textContent = `${prefix}: Ignore`;
  appliedBtn.textContent = `${prefix}: Applied`;
}

function updateAnalyzeButton() {
  analyzeBtn.hidden = !canForceAnalyze;
  responseActionsEl.hidden = !canForceAnalyze && !actionsReady;
  analyzeBtn.disabled = saveInProgress || chatInProgress;
}

function blockAnalysisDuringChat() {
  if (!chatInProgress) return false;
  showInlineStatus("Chat is still responding...", { isLoading: true });
  return true;
}

function updateChatForm() {
  chatFormEl.hidden = !chatReady;
  chatInputEl.disabled = chatInProgress;
  chatSendBtn.disabled = chatInProgress;
}

function getNotionMatchStatusText(verdict) {
  if (verdict === "found") return "✅ Matching Notion job found";
  if (verdict === "uncertain") return "🟡 Possible Notion match found";
  return "🆕 No Notion match found";
}

function getAnalysisResultStatusText(verdict) {
  if (verdict === "found") return "Duplicate found";
  if (verdict === "uncertain") return "Review possible duplicate";
  return "Analysis ready";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("Could not detect the active tab. Focus a browser tab and retry.");
  }
  currentTabId = tab.id;
  return tab;
}

function getElapsedSeconds() {
  if (!analysisStartedAt) return null;
  return Math.max(1, Math.round((Date.now() - analysisStartedAt) / 1000));
}

function appendElapsedToStatus(text) {
  const now = Date.now();
  if (!lastStatusAt || now < lastStatusAt) {
    lastStatusAt = now;
    return text;
  }

  const stepMs = now - lastStatusAt;
  lastStatusAt = now;
  return `${text} (${(stepMs / 1000).toFixed(1)}s)`;
}

function resetResponse() {
  responseText = "";
  preserveResponseOnNextAnalysis = false;
  savedMatchMarkdown = "";
  streamingStatusShown = false;
  responseEl.innerHTML = "";
  inlineStatusLineEl.hidden = true;
  inlineStatusLineEl.textContent = "";
  hideInlineStatus();
  responseActionsEl.hidden = true;
  usageSummaryEl.textContent = "";
  usageSummaryEl.hidden = true;
  autoScrollEnabled = true;
  chatReady = false;
  chatInProgress = false;
  currentChatRequestId = null;
  notionDraft = null;
  chatInputEl.value = "";
  resizeChatInput();
  updateChatForm();
  updateScrollToBottomButton();
}

function resizeChatInput() {
  const lineHeight = parseFloat(getComputedStyle(chatInputEl).lineHeight) || 19;
  const paddingY = chatInputEl.offsetHeight - chatInputEl.clientHeight;
  const maxHeight = Math.ceil(lineHeight * MAX_CHAT_INPUT_LINES + paddingY);

  chatInputEl.style.height = "auto";
  chatInputEl.style.maxHeight = `${maxHeight}px`;
  chatInputEl.style.overflowY = chatInputEl.scrollHeight > maxHeight ? "auto" : "hidden";
  chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, maxHeight)}px`;
}

function appendChatMessage(author, text) {
  const safeText = sanitizeChatMarkdown(text);
  responseText = `${responseText.trimEnd()}\n\n### ${author}\n`;
  if (safeText) responseText += safeText;
  responseEl.innerHTML = renderMarkdown(responseText);
  if (autoScrollEnabled) scrollToBottom();
}

function sanitizeChatMarkdown(text) {
  return String(text || "")
    .replace(/^__HTML__/gm, "\\_\\_HTML__")
    .trim();
}

function handleScroll() {
  autoScrollEnabled = isNearBottom();
  updateScrollToBottomButton();
}

function isNearBottom() {
  const scrollingEl = document.scrollingElement;
  return scrollingEl.scrollHeight - scrollingEl.scrollTop - scrollingEl.clientHeight <= AUTO_SCROLL_THRESHOLD;
}

function updateScrollToBottomButton() {
  scrollToBottomBtn.hidden = !shouldShowScrollToBottomButton();
}

function scrollToBottom(behavior = "auto") {
  const scrollingEl = document.scrollingElement;
  scrollingEl.scrollTo({ top: scrollingEl.scrollHeight, behavior });
  updateScrollToBottomButton();
}

function shouldShowScrollToBottomButton() {
  if (!responseText.trim()) return false;
  const scrollingEl = document.scrollingElement;
  const hasOverflow = scrollingEl.scrollHeight - scrollingEl.clientHeight > AUTO_SCROLL_THRESHOLD;
  return hasOverflow && !isNearBottom();
}
