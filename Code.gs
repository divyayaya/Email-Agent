/*********** CONFIG ***********/
const OOO_UNTIL = '2025-08-26'; 
const BACKUP = { name: 'Divya Mahesh', email: 'divyamaheshms@gmail.com' }; 
const TRUSTED_DOMAINS = ['@andrew.cmu.edu', '@cmu.edu']; 
const LLM_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MODEL_FALLBACK = 'gpt-4o-mini';

// Labels used by the agent
const LBL_AI_SENT = 'ai-replied';
const LBL_AI_DRAFT = 'ai-needs-review';
const LBL_SKIP = 'skip-auto'; 

// Hard safety stops — always Draft Only if any appear
const STOPWORDS = ['offer', 'legal', 'contract', 'salary', 'nda', 'confidential', 'sow', 'invoice', 'po', 'security', 'privacy', 'dpa', 'hipaa'];

const SEARCH_QUERY = [
  'in:inbox',
  '-label:ai-replied',
  '-label:ai-needs-review',
  '-category:(promotions social updates forums)',
  '-is:chat',
  'newer_than:7d'
].join(' ');

/*********** MAIN ENTRY ***********/
function aiAgentReply() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('OPENAI_API_KEY');
  if (!apiKey) { Logger.log('Missing OPENAI_API_KEY'); return; }
  const model = props.getProperty('MODEL') || MODEL_FALLBACK;

  const labelSent  = getOrCreateLabel_(LBL_AI_SENT);
  const labelDraft = getOrCreateLabel_(LBL_AI_DRAFT);
  const labelSkip  = getOrCreateLabel_(LBL_SKIP);

  const threads = GmailApp.search(SEARCH_QUERY, 0, 30); // batch up to 30
  threads.forEach(t => {
    try {
      // Skip if already processed or in Trash/Spam
      if (
        hasLabel_(t, labelSent) ||
        hasLabel_(t, labelSkip) ||
        threadInSystemLabel_(t, 'TRASH') ||
        threadInSystemLabel_(t, 'SPAM')
      ) return;

      const msgs = t.getMessages();
      if (!msgs || !msgs.length) return;
      const last = msgs[msgs.length - 1];

      const raw = last.getRawContent();
      if (isMailingList_(raw)) return;

      const bodyPlain = (last.getPlainBody() || '').slice(0, 5000);
      const fromStr   = last.getFrom() || '';
      const subject   = t.getFirstMessageSubject() || '(no subject)';

      // Safety gate: stop words?
      const risky = containsStopwords_(subject + ' ' + bodyPlain);

      // Prepare prompt
      const sys = systemPrompt_(OOO_UNTIL, BACKUP.name, BACKUP.email);
      const user = `From: ${fromStr}\nSubject: ${subject}\nBody:\n${truncate_(bodyPlain, 2500)}`;

      const payload = {
        model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.2,
        // Force JSON from the model
        response_format: { type: 'json_object' }
      };

      const res = UrlFetchApp.fetch(LLM_ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${apiKey}` },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const data = safeJson_(res.getContentText());
      const content = data?.choices?.[0]?.message?.content;
      const parsed = extractJson_(content); // robust JSON extraction

      let toSendHtml, replySubject = 'Re: ' + subject, decision = 'draft';
      const isTrusted = trustedSender_(fromStr, TRUSTED_DOMAINS);
      const looksSchedule = /\b(meet|meeting|schedule|resched|call|chat|sync)\b/i.test(subject + ' ' + bodyPlain);

      if (!parsed || !parsed.reply) {
        // Fallback OOO if parsing failed
        const fallback = [
          `Thanks for your note — I’m on vacation until ${OOO_UNTIL}.`,
          `For anything urgent, please contact ${BACKUP.name} at ${BACKUP.email}.`,
          `I’ll follow up when I’m back.`
        ].join(' ');
        toSendHtml = addFooter_(fallback, OOO_UNTIL, BACKUP);

        // Heuristic: trusted + scheduling + not risky => send; else draft
        if (isTrusted && looksSchedule && !risky) {
          t.reply(htmlToText_(toSendHtml), { htmlBody: toSendHtml, subject: replySubject });
          t.addLabel(labelSent);
          decision = 'sent-fallback';
        } else {
          GmailApp.createDraft(last.getFrom(), replySubject, '', { htmlBody: toSendHtml, replyTo: BACKUP.email });
          t.addLabel(labelDraft);
          decision = 'draft-fallback';
        }

        Logger.log(JSON.stringify({ from: fromStr, trusted: isTrusted, category: 'fallback', safe: false, risky, subject, decision }));
        return;
      }

      // Normal path with parsed JSON from model
      const htmlReply = addFooter_(parsed.reply, OOO_UNTIL, BACKUP);
      const lowRisk = parsed.category && ['schedule', 'status', 'recruiting', 'fyi'].includes(String(parsed.category).toLowerCase());
      const safeFlag = parsed.safeToSend === true;

      // Decide: send vs draft (force Draft if risky or not trusted)
      const sendNow = safeFlag && lowRisk && isTrusted && !risky;

      // Debug log of the decision path
      Logger.log(JSON.stringify({
        from: fromStr,
        trusted: isTrusted,
        category: parsed.category,
        safe: safeFlag,
        risky,
        subject,
        decision: sendNow ? 'sent' : 'draft'
      }));

      if (sendNow) {
        t.reply(htmlToText_(htmlReply), { htmlBody: htmlReply, subject: replySubject });
        t.addLabel(labelSent);
      } else {
        GmailApp.createDraft(last.getFrom(), replySubject, '', { htmlBody: htmlReply, replyTo: BACKUP.email });
        t.addLabel(labelDraft);
      }
    } catch (e) {
      Logger.log('Error on thread: ' + e);
    }
  });
}

/*********** HELPERS ***********/
function systemPrompt_(until, backupName, backupEmail) {
  return `
You are an email auto-reply agent for Divya Mahesh. Constraints:
1) Divya is on vacation until ${until}. Always acknowledge receipt and state the return date.
2) Offer a next step: contact ${backupName} <${backupEmail}> for urgent items OR propose times after ${until}.
3) Never invent facts, quotes, pricing, commitments, or dates beyond ${until}.
4) Keep replies under 110 words, plain, warm-professional, first person ("I").
5) If the sender asks complex questions (contracts, legal, pricing, negotiation, compliance, security, HR), DO NOT answer—defer to the backup contact.
6) Do not include signatures—just the body. No links unless explicitly provided by the sender.
Return strict JSON only:
{"category":"schedule|status|recruiting|sales|fyi|complex","reply":"STRING","safeToSend":true|false}
  `.trim();
}

function isMailingList_(raw) {
  const hints = ['List-Id:', 'List-Unsubscribe:', 'Auto-Submitted:', 'Precedence: bulk', 'Precedence: list'];
  return hints.some(h => raw.indexOf(h) !== -1);
}

function trustedSender_(fromStr, domains) {
  const lower = (fromStr || '').toLowerCase();
  return domains.some(d => lower.includes(d.toLowerCase()));
}

function containsStopwords_(text) {
  const lower = (text || '').toLowerCase();
  return STOPWORDS.some(w => lower.includes(w));
}

function addFooter_(body, until, backup) {
  return [
    sanitizeReply_(body),
    `<br><br><small>Auto-reply while I am OOO until ${until}. Urgent? ${backup.name} — <a href="mailto:${backup.email}">${backup.email}</a>.</small>`
  ].join('');
}

function sanitizeReply_(s) {
  // Basic guard against model outputting JSON or code fences
  return String(s).replace(/^```[\s\S]*?```$/g, '').trim();
}

function htmlToText_(html) {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

function safeJson_(t) { try { return JSON.parse(t); } catch(_) { return null; } }

function extractJson_(text) {
  if (!text) return null;
  // direct
  try { return JSON.parse(text); } catch (_) {}
  // first {...}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  // ```json ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) {} }
  return null;
}

function truncate_(s, n) { return (s || '').length > n ? s.slice(0, n) : s; }

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function hasLabel_(thread, label) {
  if (!label) return false;
  const name = label.getName();
  return thread.getLabels().some(l => l.getName() === name);
}

function threadInSystemLabel_(thread, systemLabel) {
  // systemLabel can be 'SPAM', 'TRASH', etc. (Gmail exposes these as labels)
  return thread.getLabels().some(l => l.getName().toUpperCase() === systemLabel.toUpperCase());
}
