# Job Search Assistant

Chrome side-panel extension for analyzing job pages with Amazon Bedrock and saving job records to Notion.

## Setup

1. Clone the repo.
2. Create your private job-search context and extension instructions:

   ```sh
   cp config/job-search-context.example.md config/job-search-context.local.md
   cp config/extension-instructions.example.md config/extension-instructions.local.md
   ```

3. Edit `config/job-search-context.local.md` with your profile, preferences, constraints, and application style.
4. Edit `config/extension-instructions.local.md` with the analysis and output behavior you want in the side panel.
5. Open Chrome extensions at `chrome://extensions`.
6. Enable Developer Mode.
7. Click **Load unpacked** and select this repo folder.
8. Open the extension side panel and enter:
   - Amazon Bedrock API key
   - Notion API key
   - Notion Data Source ID

The extension stores these values in `chrome.storage.local`.

## Notion

Create a Notion integration, share your jobs data source with it, and copy the data source ID into the extension settings.

The extension expects job properties such as:

- `Job title`
- `Company Name`
- `Status`
- `URL`
- `Platform`
- `Location`
- `Created At`
- `Published At`
- `AI Summary`
- `Fit Score`

## Prompt configuration

The extension composes two prompt layers at runtime:

- `config/job-search-context.local.md`: private profile, preferences, constraints, and application voice
- `config/extension-instructions.local.md`: extension-specific analysis and output behavior

Both local files are ignored by Git. If they are absent, the extension uses the two committed `.example.md` files.

## Permissions

The extension requests `<all_urls>` so it can read visible page text from job pages you analyze. It also needs host access for Amazon Bedrock and Notion API calls.
