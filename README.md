# Job Search Assistant

Chrome side-panel extension for analyzing job pages with Amazon Bedrock and saving job records to Notion.

## Setup

1. Clone the repo.
2. Create your private prompt:

   ```sh
   cp config/prompt.example.md config/prompt.local.md
   ```

3. Edit `config/prompt.local.md` with your own profile, preferences, and application style.
4. Open Chrome extensions at `chrome://extensions`.
5. Enable Developer Mode.
6. Click **Load unpacked** and select this repo folder.
7. Open the extension side panel and enter:
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

## Prompt

`config/prompt.example.md` is safe to commit. `config/prompt.local.md` is ignored and should contain your private profile and job-search preferences.

## Permissions

The extension requests `<all_urls>` so it can read visible page text from job pages you analyze. It also needs host access for Amazon Bedrock and Notion API calls.
