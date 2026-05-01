export async function readPageText(tabId, url = "") {
  const func = isLinkedInJobSearch(url) ? extractLinkedInJobText : () => document.body.innerText;
  const results = await chrome.scripting.executeScript({ target: { tabId }, func });
  return results[0]?.result || "";
}

function isLinkedInJobSearch(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("linkedin.com")
      && u.pathname.startsWith("/jobs/search/")
      && u.searchParams.has("currentJobId");
  } catch {
    return false;
  }
}

function extractLinkedInJobText() {
  const panel = document.querySelector(".jobs-search__job-details--wrapper");
  if (!panel) return document.body.innerText;
  const company = panel.querySelector(".job-details-jobs-unified-top-card__company-name")?.innerText?.trim() || "";
  const text = panel.innerText.trim().replace(/\bundefined\b\s*$/, "").trim();
  return company ? `Company: ${company}\n\n${text}` : text;
}
