export function createTabSession({ storage = chrome.storage.session } = {}) {
  const memory = {
    context: new Map(),
    history: new Map(),
  };

  function sessionKeys(tabId) {
    const id = String(tabId);
    return {
      context: `tab:${id}:context`,
      history: `tab:${id}:history`,
    };
  }

  async function getContext(tabId) {
    if (memory.context.has(tabId)) return memory.context.get(tabId);

    const keys = sessionKeys(tabId);
    const stored = await storage.get(keys.context);
    const context = stored[keys.context];
    if (context) memory.context.set(tabId, context);
    return context ?? null;
  }

  async function getHistory(tabId) {
    if (memory.history.has(tabId)) return memory.history.get(tabId) || [];

    const keys = sessionKeys(tabId);
    const stored = await storage.get(keys.history);
    const history = stored[keys.history];
    if (Array.isArray(history)) memory.history.set(tabId, history);
    return memory.history.get(tabId) || [];
  }

  function setContext(tabId, context) {
    memory.context.set(tabId, context);
  }

  function updateContext(tabId, updates) {
    const updated = { ...(memory.context.get(tabId) || {}), ...updates };
    memory.context.set(tabId, updated);
    return updated;
  }

  function setHistory(tabId, history) {
    memory.history.set(tabId, history);
  }

  async function save(tabId) {
    const keys = sessionKeys(tabId);
    await storage.set({
      [keys.context]: memory.context.get(tabId) ?? null,
      [keys.history]: memory.history.get(tabId) ?? [],
    });
  }

  async function initContext(tabId, context) {
    memory.context.set(tabId, context);
    memory.history.set(tabId, []);
    await save(tabId);
  }

  async function persistContextUpdate(tabId, updates) {
    updateContext(tabId, updates);
    await save(tabId);
  }

  async function clear(tabId) {
    memory.context.delete(tabId);
    memory.history.delete(tabId);
    const keys = sessionKeys(tabId);
    await storage.remove([keys.context, keys.history]);
  }

  return {
    clear,
    getContext,
    getHistory,
    initContext,
    persistContextUpdate,
    save,
    setHistory,
    updateContext,
  };
}
