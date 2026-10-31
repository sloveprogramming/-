# WhatsApp message campaigns

A cold-outreach sequence over WhatsApp, shaped like a LinkedIn campaign:
pick the sending numbers, add leads (spreadsheet or the lead database),
write a first message and follow-ups with delays, launch. A reply on any
channel stops the lead's sequence, and the reply lands in CRM → Action
required.

## What already exists (and is reused as is)

| Need | Existing piece |
| --- | --- |
| Send one message, new chat or existing | `sendWhatsapp` (`src/lib/whatsapp/send.ts`): Do Not Contact, warm-up, new chats a day, gap between sends, reserve-then-send under an advisory lock, CRM outbound record |
| Limits | Sending rules, `whatsapp` channel (`src/lib/channels/rules.ts`), per-number `new_chats_per_day` |
| Reply → Action required | webhook → `ingestWhatsappWebhook` → `forwardWhatsappInboundToCrm` → `ingestInboundReply` (classification job, `activeChannel = whatsapp`) |
| Earlier campaign messages in the CRM thread | `backfillOutreachHistoryInTransaction` reads `whatsapp_messages` on the first reply |
| Stop on reply, cross-channel | `ingestInboundReplyInTransaction` (`src/lib/crm/conversations.ts`) already stops email and LinkedIn enrollments for the Person |
| Merge fields | `personVariables` + `fillTemplate` (spin text, `{{key}}`, case-insensitive, unknown → "") |
| Lead identity from a phone list | `resolveImportRow` / `findOrCreateContactPerson` (`src/lib/calls/campaigns.ts`) |
| Spreadsheet mapping UI, add from People | `CampaignCsvMappingDialog`, `AddPeopleToCampaignModal` (gain a `whatsapp` channel) |
| Page kit | `src/components/page`, analytics kit, LinkedIn campaign pages as the reference |

What is new: the campaign tables, a sender loop, the stop-on-reply branch,
a WhatsApp sending-hours rule, and the pages.

## Data model (`src/lib/whatsapp/schema.ts`, `scripts/create-whatsapp-campaign-tables.ts`)

- `whatsapp_campaigns` — **scoped**. `name`, `description`, `status`
  (`active | paused`; created paused), `steps` jsonb
  (`{ id, body, delayHours }[]`, the first step's delay is ignored),
  `archived_at`, timestamps.
- `whatsapp_campaign_accounts` — **inherited** (campaign). The numbers that
  may send for the campaign; at least one to launch.
- `whatsapp_campaign_leads` — **inherited** (campaign). One per (campaign,
  person). `phone` (E.164 at enrollment), `custom_fields` jsonb (unmapped
  spreadsheet columns, merge fields), `status`
  (`queued | in_sequence | completed | replied | stopped | failed`),
  `current_step` (steps sent), `next_send_at`, `account_id` (the number that
  sent the first message; later steps stay on it), `attempts`,
  `last_error`, `last_sent_at`, `replied_at`.
- `whatsapp_campaign_sends` — **inherited** (lead). One per (lead, step):
  the durable claim that makes a step impossible to send twice, and the
  per-step history (`status sending | sent | failed`, `whatsapp_message_id`,
  `body`, `error`).

## Sender loop (`src/lib/whatsapp/campaigns/engine.ts`)

In-process tick every 30 s, production only, `PAUSE_WHATSAPP_OUTBOUND`
honoured — the same footing as the email scheduler (dev runs against the
live database, so the laptop must never send).

Per organization with Unipile connected, inside the new `sendingHours` rule,
per connected number assigned to an active campaign, **one send per tick**:

1. Pick the next due lead (`queued`/`in_sequence`, `next_send_at <= now`,
   campaign active and not archived, lead's number is this one or unset and
   this number is assigned). Follow-ups before first messages; first
   messages are skipped for the rest of the tick once the number hits its
   new-chat limit or is warming up.
2. Claim it: lock the lead row `FOR UPDATE SKIP LOCKED`, insert the
   `(lead, step)` send row. An existing claim means a crash mid-send:
   `sent` → repair the lead's position; `sending` → mark the lead
   `failed` ("delivery uncertain — check Messages"), never resend.
3. Re-check: a lead message in this number's chat since enrollment →
   `replied` (covers numbers the CRM could not match to a Person).
4. Render (`personVariables` ⊕ `custom_fields`, `fillTemplate`), send with
   `sendWhatsapp({ personId, accountId, text })`.
5. Advance: `current_step + 1`, `next_send_at = now + next step's delay`,
   or `completed`. The update is conditional on the lead still being
   `queued`/`in_sequence`, so a reply that lands mid-send wins.

Refusals carry a reason code (new on `WhatsappSendRefusedError`):
send gap / rate limit → release the claim, retry next tick;
new-chat limit / warm-up → release, stop first messages on that number this
tick; Do Not Contact → `stopped`; number not connected → release, skip the
number; WhatsApp rejected the message (not on WhatsApp, bad number) →
`failed`; Unipile unreachable → release, back off 10 min, `failed` after 3.

## Stop on reply

`ingestInboundReplyInTransaction` gains a WhatsApp branch beside email and
LinkedIn: the Person's `queued`/`in_sequence` enrollments become `replied`.
So a reply on WhatsApp, email or LinkedIn stops the WhatsApp sequence, and
the reply itself already reaches Action required through the existing path.

## API (`src/app/api/whatsapp/campaigns`)

| Route | |
| --- | --- |
| `GET /` · `POST /` | list with stats · create (paused) |
| `GET /[id]` · `PATCH /[id]` · `DELETE /[id]` | detail · name, description, numbers, steps, status (launch checks) · archive |
| `GET /[id]/leads` · `POST /[id]/leads` | page of leads (status filter, search) · add people by id |
| `POST /[id]/upload` | spreadsheet: `mode=preview` → headers + suggested mapping; import with mapping |
| `PATCH /[id]/leads/[leadId]` · `DELETE …` | stop / resume · remove |
| `GET /[id]/merge-fields` · `POST /[id]/preview` | merge-field picker · render a step for a lead |

Every route opens the organization scope (`requireCrmMutationContext` +
`runInOrganization`); pages show a connection prompt when the Unipile
integration is not ready.

## Pages

- Sidebar → WhatsApp → **Message campaigns** (`/whatsapp/campaigns`).
- List: KPI strip (leads, messaged, replied, reply rate), status filter,
  table with progress and reply rate, row menu.
- New: wizard — details & numbers → leads → sequence → review & launch.
- Detail: header with Pause/Resume, stat row, tabs Overview · Leads ·
  Sequence. Sequence editor: steps with delay, merge-field picker, live
  preview against a real lead.

## Out of scope for the first cut

Media/attachments, A/B variants, per-lead manual send, analytics page
integration, auto Do-Not-Contact on opt-out phrases.
