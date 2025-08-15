# Email-Agent

# Gmail AI Auto-Reply Agent (OOO)

This script reads inbox threads (non-newsletters), drafts a short reply, and:
- Auto-sends for low-risk emails from trusted domains
- Saves a Draft for everything else
- Labels threads to avoid double replies

## 1) Before you start
- You need an OpenAI (or compatible) API key.

## 2) Install (choose one)
### A) Copy this project
File → Make a copy (into your own Google account).

### B) Create a fresh project
Go to https://script.new and create files `Code.gs` and `appsscript.json` from this repo.

## 3) Minimal OAuth scopes (appsscript.json)
{
  "timeZone": "America/New_York",
  "exceptionLogging": "STACKDRIVER",
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}

## 4) Configure
In Code.gs:
- Set OOO_UNTIL (YYYY-MM-DD)
- Set BACKUP = { name: 'Your Backup', email: 'backup@example.com' }
- Set TRUSTED_DOMAINS = ['@yourcompany.com', '@partner.com']

## 5) Add your API key
Project Settings → Script properties → Add:
- OPENAI_API_KEY = your_key_here
(Optional) MODEL = gpt-4o-mini

## 6) Authorize & test
- Run → aiAgentReply → authorize (Advanced → Continue → Allow)
- Send yourself a test email from a trusted domain with "meet" or "schedule" in the text
- Check labels: "ai-replied" or "ai-needs-review"

## 7) Turn it on
Triggers → Add Trigger:
- Function: aiAgentReply
- Type: Time-driven → Every 5 or 10 minutes

## 8) Stop it
Disable or delete the trigger.

## Safety
- Add label "skip-auto" on any thread to suppress the agent.
- Terms like “contract, salary, NDA” force Draft-only.
- Do not hardcode your API key in code.
