const DEFAULT_NOTION_VERSION = "2025-09-03";
const MAX_RICH_TEXT_LENGTH = 1900;
const NOTION_API_BASE_URL = "https://api.notion.com/v1";

export function createNotionService({
  authToken,
  dataSourceId,
  notionVersion = DEFAULT_NOTION_VERSION,
  fetchImpl = fetch,
} = {}) {
  if (!authToken) {
    throw new Error("Missing Notion auth token.");
  }

  if (!dataSourceId) {
    throw new Error("Missing Notion data source ID.");
  }

  async function request(path, { method = "GET", body } = {}) {
    const response = await fetchImpl(`${NOTION_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Notion-Version": notionVersion,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `Notion request failed (${response.status}).`);
    }

    return data;
  }

  async function getJob(pageId) {
    const data = await request(`/pages/${pageId}`);
    return mapJob(data);
  }

  async function queryAllJobs() {
    const jobs = [];
    let nextCursor = undefined;

    while (true) {
      const data = await request(`/data_sources/${dataSourceId}/query`, {
        method: "POST",
        body: nextCursor ? { start_cursor: nextCursor } : {},
      });

      for (const page of data.results || []) {
        jobs.push(mapJob(page));
      }

      if (!data.has_more || !data.next_cursor) {
        return jobs;
      }

      nextCursor = data.next_cursor;
    }
  }

  async function createJob(job) {
    const data = await request("/pages", {
      method: "POST",
      body: {
        parent: {
          type: "data_source_id",
          data_source_id: dataSourceId,
        },
        properties: buildJobProperties(job),
      },
    });

    return mapJob(data);
  }

  async function updateJob(pageId, updates) {
    const data = await request(`/pages/${pageId}`, {
      method: "PATCH",
      body: {
        properties: buildJobProperties(updates),
      },
    });

    return mapJob(data);
  }

  async function updateJobStatus(pageId, status) {
    return updateJob(pageId, { status });
  }

  async function trashJob(pageId) {
    await request(`/pages/${pageId}`, {
      method: "PATCH",
      body: {
        in_trash: true,
      },
    });
  }

  return {
    getJob,
    queryAllJobs,
    createJob,
    updateJob,
    updateJobStatus,
    trashJob,
  };
}

function buildJobProperties(job = {}) {
  const properties = {};
  const jobTitle = job.jobTitle || job.name;

  if (jobTitle) {
    properties["Job title"] = {
      title: [{ text: { content: truncateText(jobTitle) } }],
    };
  }

  if (job.companyName) {
    properties["Company Name"] = toRichTextProperty(job.companyName);
  }

  if (job.status) {
    properties.Status = {
      select: { name: job.status },
    };
  }

  if (job.url) {
    properties.URL = { url: job.url };
  }

  if (job.platform) {
    properties.Platform = toRichTextProperty(job.platform);
  }

  if (job.location) {
    properties.Location = toRichTextProperty(job.location);
  }

  if (job.createdAt) {
    properties["Created At"] = {
      date: { start: toDateValue(job.createdAt) },
    };
  }

  if (job.publishedAt) {
    properties["Published At"] = toRichTextProperty(job.publishedAt);
  }

  if (job.aiSummary) {
    properties["AI Summary"] = toRichTextProperty(job.aiSummary);
  }

  if (typeof job.fitScore === "number") {
    properties["Fit Score"] = { number: job.fitScore };
  }

  return properties;
}

function mapJob(page) {
  const properties = page.properties || {};
  const jobTitle = readTitle(properties["Job title"]) || readTitle(properties.Name);
  const companyName = readRichText(properties["Company Name"]);

  return {
    id: page.id,
    notionUrl: page.url,
    name: jobTitle,
    jobTitle,
    companyName,
    status: properties.Status?.select?.name || "",
    jobUrl: properties.URL?.url || "",
    platform: readRichText(properties.Platform),
    location: readRichText(properties.Location),
    createdAt: properties["Created At"]?.date?.start || "",
    publishedAt: readRichText(properties["Published At"]),
    aiSummary: readRichText(properties["AI Summary"]),
    fitScore: properties["Fit Score"]?.number ?? null,
  };
}

function toRichTextProperty(value) {
  return {
    rich_text: [{ text: { content: truncateText(value) } }],
  };
}

function readTitle(property) {
  return (property?.title || []).map((item) => item.plain_text || "").join("");
}

function readRichText(property) {
  return (property?.rich_text || []).map((item) => item.plain_text || "").join("");
}

function toDateValue(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function truncateText(value) {
  return String(value).slice(0, MAX_RICH_TEXT_LENGTH);
}
