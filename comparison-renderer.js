export function renderComparisonMarkdown(result) {
  const verdictConfig = {
    found: { label: result.urlMatch ? "✅ Exact URL match" : "Match found", cls: "match-card--found" },
    uncertain: { label: "Possible match", cls: "match-card--uncertain" },
    new: { label: "Looks new", cls: "match-card--new" },
  };
  const { label, cls } = verdictConfig[result.verdict] || verdictConfig.new;

  let h = `<div class="match-card ${cls}">`;
  h += `<div class="match-card__header"><span class="match-card__verdict">${label}</span>`;
  if (result.summary) h += `<span class="match-card__summary">${esc(result.summary)}</span>`;
  h += `</div>`;

  for (const match of result.matches) {
    const title = match.companyName ? `${match.jobTitle} at ${match.companyName}` : match.jobTitle;
    h += `<div class="match-item">`;
    h += `<a href="${escAttr(match.notionUrl)}" target="_blank" rel="noreferrer" class="match-item__title">${esc(title)}</a>`;
    if (match.status) h += `<div class="match-item__status"><span class="status-badge status-badge--${statusKey(match.status)}">${esc(match.status)}</span></div>`;
    h += `<div class="match-item__badges">`;
    h += `<span class="confidence-badge confidence-badge--${match.certainty}">${confidenceLabel(match.certainty)}</span>`;
    if (match.platform) h += `<span class="meta-tag">${esc(match.platform)}</span>`;
    h += `</div>`;
    if (match.location) h += `<div class="match-item__detail">📍 ${esc(match.location)}</div>`;
    if (match.publishedAt) h += `<div class="match-item__detail">📅 ${esc(match.publishedAt)}</div>`;
    if (match.reason) h += `<div class="match-item__reason">${esc(match.reason)}</div>`;
    h += `</div>`;
  }

  const footer = result.verdict === "found"
    ? "Duplicate likely. Reuse the existing Notion item instead of creating a new one."
    : result.verdict === "uncertain"
      ? "There are plausible duplicates. Review the Notion links before saving."
      : "No strong Notion duplicate found. Full job analysis is the next step.";

  h += `<div class="match-card__footer">${footer}</div></div>`;
  return `__HTML__${h}`;
}

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escAttr(value) {
  return esc(value);
}

function statusKey(status) {
  const s = String(status || "").toLowerCase().replace(/\s+/g, "-");
  const known = ["applied", "ignored", "interviewing", "offered", "rejected"];
  return known.includes(s) ? s : "default";
}

function confidenceLabel(certainty) {
  if (certainty === "high") return "High confidence";
  if (certainty === "medium") return "Medium confidence";
  return "Low confidence";
}
