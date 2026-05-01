export function renderNotionPreviewMarkdown(draft, tab) {
  let h = `<div class="notion-preview-card">`;
  h += `<div class="notion-preview-card__header">Notion fields</div>`;
  h += `<div class="notion-preview-card__body">`;

  if (draft.jobTitle) h += row("Job title", esc(draft.jobTitle));
  if (tab?.url) h += row("URL", `<a href="${escAttr(tab.url)}" target="_blank" rel="noreferrer">${esc(formatPreviewUrl(tab.url))}</a>`);
  if (draft.companyName) h += row("Company", esc(draft.companyName));
  if (draft.location) h += row("Location", esc(draft.location));
  if (draft.publishedAt) h += row("Published", esc(draft.publishedAt));
  if (typeof draft.fitScore === "number") {
    const score = draft.fitScore;
    const cls = score >= 7 ? "fit-score--high" : score >= 5 ? "fit-score--mid" : "fit-score--low";
    h += row("Fit score", `<span class="fit-score ${cls}">${score} / 10</span>`);
  }
  if (draft.aiSummary) h += row("Summary", esc(draft.aiSummary));

  h += `</div></div>`;
  return `\n\n__HTML__${h}`;
}

function row(label, valueHtml) {
  return `<div class="notion-preview-row"><span class="notion-preview-row__label">${label}</span><span class="notion-preview-row__value">${valueHtml}</span></div>`;
}

function formatPreviewUrl(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const shortPath = path.length > 40 ? `${path.slice(0, 37)}...` : path;
    return `${url.hostname}${shortPath}`;
  } catch {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 60);
  }
}

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escAttr(value) {
  return esc(value);
}
