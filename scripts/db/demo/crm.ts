/**
 * The CRM half of the demo: Settings → Knowledge / Instructions / Lead
 * categories, the reply sequences, and then (after the channel modules have
 * ingested the leads' replies) everything that happened to those replies —
 * AI classifications, human corrections, drafts, sent replies, follow-ups,
 * stage moves, closed records.
 *
 * Nothing here calls out. Classification and drafting run through the app's
 * real handlers (`handleClassificationJob`, `generateDraftForStep`,
 * `generateFallbackDraft`, `applyHumanClassification`, `moveRecordStage`,
 * `sendDraft`, ...) with a FAKE model that returns the text written below, and
 * sending goes through a stub adapter that returns a provider-looking result.
 *
 * Time. Those helpers stamp rows with the real clock. So every step runs in a
 * "phase": take a database-clock marker, run the operation, then rewrite
 * everything the record gained since the marker (events, classifications,
 * drafts, runs, step runs, send attempts, outbound messages, ...) to the moment
 * the step should have happened. `crm_events` and `crm_conversation_messages`
 * have append-only triggers, so the rewrite runs in a transaction with
 * `SET LOCAL session_replication_role = replica`, which switches triggers
 * (and so also the validation triggers, whose conditions the lib calls just
 * satisfied) off for that transaction only. That needs a superuser, which the
 * local demo database and the deployed demo's dedicated Postgres both have.
 * Nothing here may ever run against a database holding real data.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { updateCrmAiInstructions } from "@/lib/crm/aiSettings";
import { createKnowledgeDocument } from "@/lib/crm/knowledge-service";
import {
  assignSubcategorySequence,
  createSequence,
  publishSequence,
  interruptActiveSequenceRunInTransaction,
  skipCurrentSequenceStep,
} from "@/lib/crm/sequences";
import { withCrmTransaction } from "@/lib/crm/repository";
import { handleClassificationJob } from "@/lib/crm/handlers";
import { generateDraftForStep, generateFallbackDraft, discardDraft, updateDraft } from "@/lib/crm/drafts";
import { acknowledgeClassification, applyHumanClassification, closeCrmRecord, createManualDraft, moveRecordStage } from "@/lib/crm/operations";
import { sendDraft, type CrmSendAdapter } from "@/lib/crm/send";
import type { CrmJob } from "@/lib/crm/queue";
import type { ClassificationCompletion } from "@/lib/crm/ai/types";
import type { DraftCompletion } from "@/lib/crm/ai/draft";
import {
  crmClassifications,
  crmConversationMessages,
  crmDrafts,
  crmRecords,
  crmSequenceRuns,
  crmSequenceStepRuns,
  crmSequenceSteps,
  crmSubcategories,
} from "@/lib/crm/schema";
import { AI_INSTRUCTIONS, KNOWLEDGE_DOCS, TEAM, type ReplyIntent } from "./content";
import { DAY, HOUR, MINUTE, count, type DemoContext, type DemoPerson, type DemoReply } from "./context";

// ===========================================================================
// Setup: knowledge, instructions, sequences
// ===========================================================================

type SequenceDef = {
  name: string;
  description: string;
  /** Subcategory names whose replies start this sequence. */
  assignTo: string[];
  steps: {
    name: string;
    /** Wait after the previous step went out (step 1 is always 0). */
    days: number;
    subjectTemplate: string | null;
    bodyTemplate: string;
    aiInstructions: string;
    knowledgeTags: string[];
  }[];
};

const SEQUENCES: SequenceDef[] = [
  {
    name: "Book the meeting",
    description: "For leads who ask for a call or a demo. Answers with two concrete times, then nudges twice if they go quiet.",
    assignTo: ["Meeting Requested", "Demo Request"],
    steps: [
      {
        name: "Propose two times",
        days: 0,
        subjectTemplate: null,
        bodyTemplate:
          "Hi {{first_name}},\n\nHappy to. Would [first slot] or [second slot] suit you? Thirty minutes is plenty, and I'll tailor it to how {{company_name}} prospects today.\n\nIf neither works, send me two windows that do.\n\n[Rep first name]",
        aiInstructions:
          "Answer what they actually asked. Offer two specific 30-minute slots within the next three business days, in the lead's timezone, and add the booking link as a fallback. If they named a day or a colleague, use it. Under 100 words, no attachments.",
        knowledgeTags: ["company"],
      },
      {
        name: "Nudge with the booking link",
        days: 2,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nBubbling this up in case it got buried. [Slot] still works on my side, or pick any time on the booking link.\n\n[Rep first name]",
        aiInstructions: "Two sentences. Repeat one concrete slot and the booking link. Do not repeat the pitch and do not apologise for following up.",
        knowledgeTags: [],
      },
      {
        name: "Last check-in",
        days: 4,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nI'll assume the timing isn't right and stop chasing. If you want to pick this up later, reply here and I'll find time within the week.\n\n[Rep first name]",
        aiInstructions: "A graceful close. Say you will stop following up, leave the door open, and make it easy to reply with a single word.",
        knowledgeTags: [],
      },
    ],
  },
  {
    name: "Send the overview",
    description: "For leads who want information first: pricing, integrations, security, onboarding or a case study. Answers the question, then offers a short walkthrough.",
    assignTo: ["Information Requested", "Case Study"],
    steps: [
      {
        name: "Answer their questions",
        days: 0,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nThanks for the quick reply. [Direct answer to what they asked.]\n\nIf it would help to see it, I can do a 20-minute walkthrough: [two slots].\n\n[Rep first name]",
        aiInstructions:
          "Answer the specific question first, using only facts from the knowledge base (pricing, security, integrations, onboarding). If they asked for a case study, share the closest one and be honest when there is no match for their industry. Then offer a short walkthrough with two slots. Never quote a discount above 15%.",
        knowledgeTags: ["pricing", "case study", "faq"],
      },
      {
        name: "Offer a short walkthrough",
        days: 3,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nDid the overview answer your questions? If something is still unclear, tell me what and I'll answer it directly.\n\n[Rep first name]",
        aiInstructions: "Ask whether the overview answered their question, invite the one thing still unclear, and offer a 20-minute walkthrough with two slots. No new claims.",
        knowledgeTags: ["company"],
      },
      {
        name: "Share a customer example",
        days: 6,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nOne more thing that might help the internal case: [customer example and result].\n\n[Rep first name]",
        aiInstructions: "Share one proof point that matches their industry or team size, with the link to the write-up. If nothing matches, say so rather than stretching a story.",
        knowledgeTags: ["case study"],
      },
    ],
  },
  {
    name: "Pilot kickoff",
    description: "For leads who would rather try it than talk. Sets up the two-seat, 14-day pilot and checks in as it runs.",
    assignTo: ["Trial Requested", "Trial User"],
    steps: [
      {
        name: "Confirm the pilot and next steps",
        days: 0,
        subjectTemplate: "Your Northwind Signal pilot: setup for {{company_name}}",
        bodyTemplate: "Hi {{first_name}},\n\nNo problem, you can start with a pilot instead of a call: two seats free for 14 days on one campaign. Which CRM are you on, and who are the two reps?\n\n[Rep first name]",
        aiInstructions:
          "Confirm the two-seat, 14-day pilot on one campaign. Ask which CRM they use and who the two reps are, so the workspace can be configured before the first session. Offer a 20-minute setup call.",
        knowledgeTags: ["pricing", "company"],
      },
      {
        name: "Check on setup",
        days: 2,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nChecking in on the pilot. Have the two reps connected their mailbox and LinkedIn? If anything is blocking, send me a screenshot.\n\n[Rep first name]",
        aiInstructions: "Ask if the reps have connected a mailbox and LinkedIn account. Mention domain verification as the usual blocker and promise a same-day fix.",
        knowledgeTags: ["faq"],
      },
      {
        name: "Review the first results",
        days: 7,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nOne week in, the first numbers should be visible in Analytics. Want 20 minutes to review them and decide whether to extend the pilot?\n\n[Rep first name]",
        aiInstructions: "Point to the first week's numbers in Analytics (replies by category, drafts sent as-is vs edited) and propose a 20-minute review. No pressure to buy.",
        knowledgeTags: ["company"],
      },
    ],
  },
  {
    name: "Nurture: check back next quarter",
    description: "For leads who said not now. Thanks them, goes quiet for six weeks, then checks in twice, two months apart.",
    assignTo: ["Not Required Right Now"],
    steps: [
      {
        name: "Acknowledge and park",
        days: 0,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nThanks for the straight answer, that's completely fair. I'll check back in [month] and not before.\n\n[Rep first name]",
        aiInstructions: "Thank them for the honest answer, name when you will check back (use their timing if they gave one), and invite them to reply sooner if things change. No pitch.",
        knowledgeTags: [],
      },
      {
        name: "Check back in",
        days: 45,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nCircling back as promised. Has anything shifted at {{company_name}} since we last spoke?\n\n[Rep first name]",
        aiInstructions: "Open by saying you are following up as promised and reference the reason they gave. One question: has anything changed. Offer the free two-seat pilot as the low-risk next step.",
        knowledgeTags: ["objections"],
      },
      {
        name: "Share what's new",
        days: 60,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nA quick update since we last spoke: [what is new]. If that's relevant to {{company_name}}, I can send details.\n\n[Rep first name]",
        aiInstructions: "Share one concrete product update that plausibly matters to them. Say you will leave them in peace if it is not relevant. Keep under 80 words.",
        knowledgeTags: ["company"],
      },
    ],
  },
  {
    name: "Bump after out-of-office",
    description: "For auto-replies. Skips the acknowledgement (nobody answers an auto-reply), then resurfaces once they are back.",
    assignTo: ["Out of Office"],
    steps: [
      {
        name: "Acknowledge the auto-reply",
        days: 0,
        subjectTemplate: null,
        bodyTemplate: "[Usually skipped: an auto-reply does not need an answer.]",
        aiInstructions: "Do not reply to an auto-responder. If a person reviews this step, they will normally skip it.",
        knowledgeTags: [],
      },
      {
        name: "Resurface when they are back",
        days: 5,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nHope the time away was good. Following up on my earlier note about {{company_name}}. Would a 20-minute call work?\n\n[Rep first name]",
        aiInstructions: "Welcome them back in one short line, restate the original ask in a sentence, and offer two slots. Do not mention the out-of-office message.",
        knowledgeTags: ["company"],
      },
      {
        name: "One last nudge",
        days: 4,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nLast nudge from me. If this is not on your plate, who at {{company_name}} owns it?\n\n[Rep first name]",
        aiInstructions: "Final note: ask who at the company owns outbound reply handling and offer to take it up with them. Two sentences.",
        knowledgeTags: [],
      },
    ],
  },
  {
    name: "After the meeting",
    description: "Starts when a record moves to Meeting Done: the recap and agreed next steps, then two check-ins on the decision.",
    assignTo: ["Meeting Done"],
    steps: [
      {
        name: "Send the recap and next steps",
        days: 0,
        subjectTemplate: "Recap and next steps: {{company_name}} x Northwind",
        bodyTemplate: "Hi {{first_name}},\n\nThanks for the time today. Quick recap: [what you want, what was covered]. Next step: [what happens next].\n\n[Rep first name]",
        aiInstructions:
          "Recap what they want to achieve and what was covered, using the stage-change note for facts. List the agreed next steps with owners. Offer the two-seat pilot if they have not started one. Do not invent anything the note does not say.",
        knowledgeTags: ["pricing", "company"],
      },
      {
        name: "Check on the decision",
        days: 3,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nHow did the pricing land with your team? I'm happy to talk it through.\n\n[Rep first name]",
        aiInstructions: "Ask how the proposal landed with their team and offer to join a call with whoever decides. Mention the pilot as a way to see it on their own data.",
        knowledgeTags: ["pricing", "objections"],
      },
      {
        name: "Nudge towards a pilot",
        days: 7,
        subjectTemplate: null,
        bodyTemplate: "Hi {{first_name}},\n\nI don't want this to drift. Would a one-campaign pilot help?\n\n[Rep first name]",
        aiInstructions: "Propose the pilot as a way to decide with data: one campaign, review after two weeks, no commitment. Keep it short and low-pressure.",
        knowledgeTags: ["pricing"],
      },
    ],
  },
];

const INSTRUCTION_BLOCKS = (() => {
  const lines = AI_INSTRUCTIONS.split("\n").map((line) => line.trim()).filter(Boolean);
  const titles = ["Voice", "Next step", "Proof points", "Pricing"];
  return lines.map((content, index) => ({ id: `northwind-${index + 1}`, title: titles[index] ?? `Guideline ${index + 1}`, content }));
})();

const CLASSIFICATION_BLOCKS = [
  {
    id: "auto-replies",
    title: "Auto-replies are not rejections",
    content:
      "An out-of-office or leave notice is Out of Office, never a no. If it says the person has left the company, use Left Company instead.",
  },
  {
    id: "referrals",
    title: "Referrals",
    content:
      "When someone names or copies a colleague who owns the topic, use Connected to Different POC. If they only say they are the wrong person, use Did Not Connect to Different POC.",
  },
  {
    id: "information-vs-meeting",
    title: "Information before meetings",
    content:
      "If a reply asks for pricing, security or integration details and does not ask for a call, it is Information Requested even when the tone is warm. A request for times or a calendar link is Meeting Requested.",
  },
  {
    id: "suppression",
    title: "Suppression",
    content: "Any request to stop, unsubscribe or be removed is Do Not Contact, regardless of tone.",
  },
];

export async function seedCrmSetup(ctx: DemoContext): Promise<void> {
  // Knowledge base (Settings → Knowledge)
  for (const doc of KNOWLEDGE_DOCS) {
    await createKnowledgeDocument({ title: doc.title, kind: doc.kind, tags: doc.tags, alwaysInclude: doc.alwaysInclude, content: doc.content });
  }
  count(ctx, "knowledge documents", KNOWLEDGE_DOCS.length);

  // Instructions (Settings → Instructions) — one titled block per guideline
  await updateCrmAiInstructions({
    pipelineId: ctx.pipelineId,
    draftInstructions: INSTRUCTION_BLOCKS,
    classificationInstructions: CLASSIFICATION_BLOCKS,
  });
  // There is no screen for these two switches. The demo's replies from "Other"
  // subcategories (out of office, referrals) are clear-cut, so let the AI
  // apply them rather than park every one of them in the review queue.
  await db.execute(sql`UPDATE crm_settings SET review_other = false WHERE pipeline_id = ${ctx.pipelineId}`);

  // Sequences (CRM → Sequences) and their assignment to subcategories
  const subcategories = await db.select({ id: crmSubcategories.id, name: crmSubcategories.name })
    .from(crmSubcategories).where(eq(crmSubcategories.pipelineId, ctx.pipelineId));
  const subcategoryId = new Map(subcategories.map((row) => [row.name, row.id]));
  let stepTotal = 0;
  for (const def of SEQUENCES) {
    const created = await createSequence({
      name: def.name,
      description: def.description,
      steps: def.steps.map((step) => ({
        name: step.name,
        delayMinutes: Math.round(step.days * 1440),
        subjectTemplate: step.subjectTemplate,
        bodyTemplate: step.bodyTemplate,
        aiInstructions: step.aiInstructions,
        knowledgeTags: step.knowledgeTags,
      })),
    });
    await publishSequence(created.id);
    for (const name of def.assignTo) {
      const id = subcategoryId.get(name);
      if (!id) throw new Error(`CRM setup: unknown subcategory ${name}`);
      await assignSubcategorySequence(id, { sequenceId: created.id });
    }
    stepTotal += def.steps.length;
  }
  count(ctx, "CRM sequences", SEQUENCES.length);
  count(ctx, "CRM sequence steps", stepTotal);
}

// ===========================================================================
// Words: what the (fake) model writes
// ===========================================================================

type Chan = "email";

type CopyKey =
  | "meeting" | "demo" | "info" | "case" | "trial" | "nurture" | "using" | "poc" | "other"
  | "recap" | "noShow"
  | "book_f1" | "book_f2" | "overview_f1" | "overview_f2" | "pilot_f1" | "pilot_f2"
  | "nurture_f1" | "nurture_f2" | "ooo_f1" | "ooo_f2" | "after_f1" | "after_f2";

type CopyCtx = {
  first: string;
  company: string;
  industry: string;
  title: string;
  rep: string;
  channel: Chan;
  tz: string;
  inbound: string;
  subject: string | null;
  /** The moment the draft is written; time offers are relative to it. */
  at: Date;
  variant: number;
  seats: number;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MORNING = ["9:30 am", "10:00 am", "10:30 am", "11:00 am"];
const AFTERNOON = ["1:30 pm", "2:00 pm", "2:30 pm", "3:00 pm", "4:00 pm"];

function tzLabel(person: DemoPerson): string {
  const c = person.company;
  switch (c.country) {
    case "US": {
      const state = /,\s*([A-Z]{2})\b/.exec(c.hq)?.[1] ?? "NY";
      if (["CA", "WA", "OR"].includes(state)) return "PT";
      if (["CO", "UT", "ID", "AZ"].includes(state)) return "MT";
      if (["TX", "IL", "MN", "MO", "NE", "TN", "OK", "WI", "MI"].includes(state)) return "CT";
      return "ET";
    }
    case "CA": return "ET";
    case "UK": return "UK time";
    case "IE": return "Irish time";
    case "DE": case "NL": case "FR": case "ES": case "SE": return "CET";
    case "IN": return "IST";
    case "AU": return "AEST";
    case "SG": return "SGT";
  }
}

function nextBusinessDays(from: Date, n: number): Date {
  const d = new Date(from);
  let k = 0;
  while (k < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) k++;
  }
  return d;
}

function nextWeekday(from: Date, weekday: number): Date {
  const d = new Date(from);
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== weekday);
  return d;
}

function slots(c: CopyCtx) {
  const preferred = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}\\b`, "i").test(c.inbound));
  const afternoonOnly = /afternoon|after 2|after 1/i.test(c.inbound);
  const morningOnly = /morning|before noon/i.test(c.inbound);
  // Times they named ("11:00-12:30", "after 2pm") beat our defaults.
  const fmt = (h: number, m: number) => `${h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`;
  let asked: [string, string] | null = null;
  const range = /(\d{1,2}):(\d{2})\s*[\u2013-]\s*(\d{1,2}):(\d{2})/.exec(c.inbound);
  const after = /after (\d{1,2})\s*(pm|am)/i.exec(c.inbound);
  const plusHalfHour = (h: number, m: number): [number, number] => {
    const total = h * 60 + m + 30;
    return [Math.floor(total / 60), total % 60];
  };
  if (range) {
    const h = Number(range[1]) < 8 ? Number(range[1]) + 12 : Number(range[1]);
    const [h2, m2] = plusHalfHour(h, Number(range[2]));
    asked = [fmt(h, Number(range[2])), fmt(h2, m2)];
  } else if (after) {
    const h = Number(after[1]) + (after[2].toLowerCase() === "pm" && Number(after[1]) < 12 ? 12 : 0);
    asked = [fmt(h, 30), fmt(h + 1, 0)];
  }
  const pickTime = (offset: number) => {
    if (asked) return asked[offset % 2 === 0 ? 0 : 1];
    const bank = afternoonOnly ? AFTERNOON : morningOnly ? MORNING : offset % 2 === 0 ? MORNING : AFTERNOON;
    return bank[(c.variant + offset) % bank.length];
  };
  let d1: Date, d2: Date, t1: string, t2: string;
  const hasDay = preferred > 0 && preferred < 6;
  if (hasDay) {
    d1 = nextWeekday(c.at, preferred);
    d2 = d1;
    t1 = pickTime(0);
    t2 = pickTime(1) === t1 ? pickTime(2) : pickTime(1);
  } else if (/next week/i.test(c.inbound)) {
    d1 = nextBusinessDays(nextWeekday(c.at, 1), c.variant % 3);
    d2 = nextBusinessDays(d1, 1 + (c.variant % 2));
    t1 = pickTime(0);
    t2 = pickTime(3);
  } else {
    d1 = nextBusinessDays(c.at, 1 + (c.variant % 2));
    d2 = nextBusinessDays(d1, 1 + ((c.variant + 1) % 2));
    t1 = pickTime(0);
    t2 = pickTime(3);
  }
  // Weekdays only, never a date: the demo's clock moves every timestamp
  // forward each day (src/lib/demo/clock.ts) but cannot rewrite text, so
  // "Wednesday 14 Oct" would soon read as a date in the past.
  const long = (d: Date, t: string) => `${WEEKDAYS[d.getUTCDay()]} at ${t} ${c.tz}`;
  const short = (d: Date, t: string) => `${WEEKDAYS[d.getUTCDay()]} at ${t}`;
  if (hasDay) {
    // They named the day: lead with it, then offer two times on it.
    return {
      sa: `${t1} ${c.tz}`,
      sb: `${t2} ${c.tz}`,
      sas: t1,
      sbs: t2,
      leadDay: `${WEEKDAYS[d1.getUTCDay()]} works. `,
    };
  }
  return { sa: long(d1, t1), sb: long(d2, t2), sas: short(d1, t1), sbs: short(d2, t2), leadDay: "" };
}

function topicOf(inbound: string): string {
  const t = inbound.toLowerCase();
  if (/pric|cost|budget|quote/.test(t)) return "pricing";
  if (/hubspot|salesforce|integrat|crm|slack/.test(t)) return "integration";
  if (/privacy|secur|stored|access|compliance|gdpr/.test(t)) return "privacy";
  if (/onboard|import|setup|set up|how long|contacts/.test(t)) return "onboarding";
  if (/different|already have|sequenc|compar/.test(t)) return "comparison";
  return "generic";
}

const TOPICS: Record<string, string> = {
  pricing:
    "Pricing is per seat: Starter is $49 per seat per month (up to 1,000 accounts tracked) and Team is $129 per seat per month (up to 25,000 accounts, shared inbox and CRM sync). Annual contracts get 15% off. For {company} I'd expect Team to be the fit, and we can start with a two-seat, 14-day pilot on one campaign before anyone commits to anything.",
  integration:
    "Northwind Signal syncs with HubSpot and Salesforce (CRM sync is part of the Team plan) and runs fine next to a sequencer you already use. It decides who is worth contacting this week and why, then feeds that tool, so most customers keep the stack they have.",
  privacy:
    "Short version: we are SOC 2 Type II and every customer gets an isolated workspace, so your lead data is never mixed with anyone else's. I'll send the SOC 2 report and our DPA, and the standard security review usually takes about two weeks. Tell me who on your side runs it and I'll send them the pack directly.",
  onboarding:
    "Onboarding is mostly import and mapping: you upload your spreadsheets or sync your CRM, we map the fields once, and the first prioritised account list is usually ready within a few days. A large import is routine. The overview at northwind.example/signal-overview walks through the first two weeks.",
  comparison:
    "The main difference: a sequencing tool sends messages, while Northwind Signal decides who is worth messaging this week and why. It scores accounts against your ICP and hands the list to the tool you already have. The median customer books about 31% more first meetings in their first quarter.",
  generic:
    "In short, Northwind Signal pulls lead and company data together, scores accounts against your ICP and tells reps who to contact this week and why. Customers cut research time per account from about 25 minutes to under 5. The overview is at northwind.example/signal-overview.",
};

const COPY: Record<CopyKey, { email: string[]; chat: string[] }> = {
  meeting: {
    email: [
      "Hi {first},\n\nThanks for getting back to me. {lead_day}Would {sa} or {sb} suit you? Thirty minutes is plenty to walk through how Signal would fit {company}'s outbound, and I'll bring a couple of examples from {industry} teams.\n\nIf neither works, send me two windows that do and I'll fit around you. My calendar is also open at northwind.example/book/{replower}.\n\nBest,\n{rep}",
      "Hi {first},\n\nGlad this landed at the right time. {lead_day}I can do {sa} or {sb}, whichever is easier, and I'll send an invite with a video link once you pick.\n\nIs there anyone else at {company} who should join? It usually helps to have whoever owns the CRM on the call.\n\nThanks,\n{rep}",
      "Hi {first},\n\nAbsolutely. {lead_day}{sa} or {sb} both work on my side, or grab a slot directly at northwind.example/book/{replower}.\n\nThe plan for the call: ten minutes on how {company} prospects today, fifteen on a live walkthrough, and the rest for your questions.\n\nCheers,\n{rep}",
    ],
    chat: [
      "Thanks {first}! {lead_day}Would {sas} or {sbs} work for a quick call? Happy to work around you.",
      "Great to hear from you, {first}. {lead_day}Would {sas} or {sbs} work for 30 minutes? I'll send an invite as soon as you pick one.",
      "Happy to. {lead_day}I have {sas} or {sbs} open, or send me what suits you and I'll make it work.",
    ],
  },
  demo: {
    email: [
      "Hi {first},\n\nHappy to show you. The demo takes about 30 minutes and I'll use a sample workspace set up like {company}'s, so it isn't all slides. Would {sa} or {sb} work?\n\nTo make it useful it helps to know which tools your team uses for outbound today and roughly how many reps will be in the room. A one-line reply is plenty.\n\nBest,\n{rep}",
      "Hi {first},\n\nYes, glad to. I can walk you and your sales ops lead through the live product on {sa} or {sb}. We'll cover how replies get classified, what the drafts look like before anything goes out, and how sending limits are set per rep.\n\nTell me which suits and I'll send the invite.\n\n{rep}",
      "Hi {first},\n\nThanks for asking. {lead_day}I can run a demo on {sa} or {sb} and keep it to thirty minutes. If you'd like the team to see the inbox and approvals flow, bring whoever manages replies today.\n\nBest,\n{rep}",
    ],
    chat: [
      "Happy to show you live, {first}. {lead_day}{sas} or {sbs}?",
      "Of course. A demo takes about 30 minutes: {sas} or {sbs} work for me.",
      "Yes! {lead_day}Would {sas} or {sbs} suit you? I'll bring a sample workspace set up like {company}'s.",
    ],
  },
  info: {
    email: [
      "Hi {first},\n\nThanks for the quick reply. {topic}\n\nIf it would help to see it in action, I can do a 20-minute walkthrough: {sa} or {sb} both work.\n\nBest,\n{rep}",
      "Hi {first},\n\nGood questions. {topic}\n\nHappy to answer anything else by email, and if a call is easier, say the word.\n\nThanks,\n{rep}",
      "Hi {first},\n\nThanks for coming back to me. {topic}\n\nI'll leave it there so it isn't an essay. What would be most useful to cover next?\n\nCheers,\n{rep}",
    ],
    chat: [
      "Thanks {first}. {topic_short}",
      "Good question, {first}. {topic_short} Want me to send the overview?",
      "Thanks for the reply, {first}. {topic_short} Happy to send more detail if useful.",
    ],
  },
  case: {
    email: [
      "Hi {first},\n\nHere's the closest match we have: Brightloop, a 140-person B2B SaaS company with six SDRs. They were spending about half the week on manual account research. After switching, first meetings went from 38 to 81 a month within a quarter and research time dropped 70%. Full write-up: northwind.example/customers/brightloop\n\n{industry_line}\n\nIf useful, I can walk you through it on a short call: {sa} or {sb}.\n\nBest,\n{rep}",
      "Hi {first},\n\nHappy to. The example I'd start with is Brightloop (B2B SaaS, 140 people): first meetings up from 38 to 81 a month in one quarter, research time down 70%. The write-up is at northwind.example/customers/brightloop.\n\n{industry_line}\n\nThanks,\n{rep}",
    ],
    chat: [
      "Sure {first}. The best match is Brightloop: first meetings went from 38 to 81 a month in a quarter. Write-up: northwind.example/customers/brightloop",
      "Happy to share. Brightloop (B2B SaaS, 140 people) went from 38 to 81 first meetings a month. Link: northwind.example/customers/brightloop",
      "Good ask, {first}. Closest example is Brightloop, 6 SDRs, first meetings went from 38 to 81 a month: northwind.example/customers/brightloop",
    ],
  },
  trial: {
    email: [
      "Hi {first},\n\nNo problem, you can start with a pilot instead of a call. It's two seats free for 14 days on one campaign, with your own mailbox and LinkedIn account connected. I'll set up the workspace today and send the invites tomorrow morning.\n\nTwo quick questions so I configure it properly: which CRM are you on, and who are the two reps you'd like in? Once I know, I'll book 20 minutes with them to get the first campaign live.\n\nBest,\n{rep}",
      "Hi {first},\n\nHappy to. We run it as a two-seat pilot for 14 days on a single campaign, so you see it on {company}'s own data without any commitment. All I need from you is the two reps' emails and which CRM you use.\n\nI'll create the workspace today.\n\nThanks,\n{rep}",
      "Hi {first},\n\nThanks for the quick reply. The simplest way to start is the pilot: two seats for 14 days, one campaign, your own mailbox and LinkedIn account. There's no contract and no card.\n\nIf you tell me the two reps and your CRM, I'll have the workspace ready by tomorrow and book 20 minutes with them to launch the first campaign.\n\nCheers,\n{rep}",
    ],
    chat: [
      "Of course {first}. We can run a free two-seat pilot for 14 days on one campaign. Who are the two reps, and which CRM do you use?",
      "Happy to set you up with a pilot: two seats, 14 days, one campaign. Send me the reps' emails and I'll create the workspace today.",
      "Sounds good {first}. Pilot is two seats, 14 days, one campaign, no card needed. Who should I invite, and what CRM do you use?",
    ],
  },
  nurture: {
    email: [
      "Hi {first},\n\nThanks for the straight answer, that's completely fair. I'll leave you alone until {when} and check in once then to see if priorities have shifted.\n\nIf anything changes before that, reply here and I'll pick it up.\n\nBest,\n{rep}",
      "Hi {first},\n\nUnderstood, and thanks for letting me know rather than leaving it hanging. I'll come back to you in {when}.\n\nIn the meantime, if it ever helps, the two-seat pilot is free for 14 days, so there's no budget needed to try it.\n\nThanks,\n{rep}",
      "Hi {first},\n\nThat's completely fair, and thanks for being direct about it. I'll note it down and get back in touch around {when}, not before.\n\nIf the picture changes sooner, a one-line reply here is all it takes.\n\nBest,\n{rep}",
    ],
    chat: [
      "No worries {first}, thanks for the honest answer. I'll check back in {when}. Shout if anything changes.",
      "Understood, {first}. I'll leave it until {when} and ping you then.",
      "Totally understand {first}. I'll circle back around {when}, and not before. Reply here whenever it makes sense.",
    ],
  },
  using: {
    email: [
      "Hi {first},\n\nThanks for being upfront, and good to hear the team is happy with what it has. I won't push. One thing worth knowing for later: Northwind Signal doesn't replace a sequencer, most customers run it alongside theirs to decide who gets contacted. If that ever becomes a gap, I'm glad to show you.\n\nEither way, all the best to you and the team at {company}.\n\n{rep}",
      "Hi {first},\n\nThat makes sense, and building something in-house means you know exactly what you need. I'll step back. If maintaining it ever starts to cost more than it saves, I'd be glad to compare notes.\n\nAll the best,\n{rep}",
    ],
    chat: [
      "Totally fair {first}, thanks for letting me know. If that ever changes, I'm around.",
      "Understood! Glad it's working well for you. I'll leave it there.",
      "No problem {first}, thanks for the reply. If your setup ever changes, feel free to reach out.",
    ],
  },
  poc: {
    email: [
      "Hi {first},\n\nThank you, I really appreciate the introduction. I'll reach out to {colleague} directly and mention that you pointed me their way. If there's context I should have first (what you've already looked at, for example), I'd welcome it.\n\nThanks again,\n{rep}",
      "Hi {first},\n\nThanks for pointing me to {colleague}. I'll write to them today and keep it short. If you'd rather I check with you before I do, tell me and I'll hold off.\n\nBest,\n{rep}",
    ],
    chat: [
      "Thanks {first}, appreciate the intro! I'll reach out to {colleague} today.",
      "Great, thank you. I'll get in touch with {colleague} and mention you pointed me over.",
      "Thank you {first}! I'll message {colleague} today and say you suggested it.",
    ],
  },
  other: {
    email: [
      "Hi {first},\n\nFair question. No, this isn't automated: I'm {rep}, on the sales team at Northwind. I came across {company} while looking at {industry} companies that run outbound by email and LinkedIn, and thought Northwind Signal might be relevant to you as {title}. If it isn't, tell me and I'll take you off my list straight away.\n\n{rep}",
    ],
    chat: [
      "Fair question, {first}! I'm {rep} from Northwind, a real person. I found {company} while looking at {industry} teams that do outbound. If it isn't relevant, just say and I'll stop.",
      "Sorry for the surprise, {first}. I'm {rep} at Northwind and found {company}'s contact details on its public page. Happy to stop here if you'd like.",
    ],
  },
  recap: {
    email: [
      "Hi {first},\n\nThanks for the time today. A quick recap so we're aligned:\n\n- You want to {goal} at {company}\n- We covered how Northwind Signal scores accounts and drafts the first touch\n- Next step: I'll send pricing for {seats} seats and set up a two-seat pilot if you'd like to see it on your own data\n\nIf anything above is off, tell me and I'll correct it. I'll check in on {sa_day} unless you'd rather I didn't.\n\nBest,\n{rep}",
      "Hi {first},\n\nThanks again for the call. What I took away:\n\n- Priority: {goal}\n- Team size in scope: {seats} seats\n- Agreed next step: I send the Team plan pricing and the pilot outline\n\nI'll have both over to you by tomorrow. Anything you want me to add for your colleagues?\n\n{rep}",
    ],
    chat: [
      "Thanks for the time today, {first}. Recap: you want to {goal}, we're looking at {seats} seats, and I'll send pricing plus a pilot outline tomorrow.",
    ],
  },
  noShow: {
    email: [
      "Hi {first},\n\nWe missed each other today, no problem at all, these things happen. Would {sa} or {sb} work to try again? Same link, thirty minutes.\n\n{rep}",
      "Hi {first},\n\nI waited a few minutes on the call but didn't see you, so I'm guessing something came up. Happy to rebook: {sa} or {sb}?\n\nBest,\n{rep}",
    ],
    chat: [
      "Hi {first}, we missed each other today, no worries. Can we try {sas} or {sbs}?",
      "Hey {first}, I think we crossed wires on the call. {sas} or {sbs} to rebook?",
    ],
  },
  book_f1: {
    email: [
      "Hi {first},\n\nBubbling this up in case it got buried. {sa} still works on my side, or pick any slot at northwind.example/book/{replower}. Thirty minutes, kept concrete for {company}.\n\n{rep}",
      "Hi {first},\n\nJust checking whether you saw my note about a call. I can still do {sa} or {sb}, and the booking link is northwind.example/book/{replower} if that's easier.\n\nBest,\n{rep}",
    ],
    chat: [
      "Hi {first}, bumping this in case it got buried. {sas} still works for me, or grab a slot: northwind.example/book/{replower}",
      "Hey {first}, still keen to find 30 minutes. {sas} or {sbs}?",
    ],
  },
  book_f2: {
    email: [
      "Hi {first},\n\nI'll assume the timing isn't right and stop chasing. If you want to pick this up later, reply here and I'll find time within the week.\n\nThanks,\n{rep}",
      "Hi {first},\n\nLast note from me on this. If a call would still be useful, a one-word reply is enough and I'll send times. Otherwise I'll leave you in peace.\n\nBest,\n{rep}",
    ],
    chat: [
      "Hi {first}, I'll stop chasing. If you'd like to pick this up, just reply and I'll find time.",
      "Last nudge from me, {first}. Reply anytime if you'd like to talk and I'll make it work.",
    ],
  },
  overview_f1: {
    email: [
      "Hi {first},\n\nDid the overview answer your questions? If something is still unclear, tell me what and I'll answer it directly. Otherwise a 20-minute walkthrough is the fastest way to see whether it fits: {sa} or {sb}?\n\n{rep}",
      "Hi {first},\n\nFollowing up on the information I sent. Anything missing for your internal discussion? I can also take you through it live, {sa} or {sb}.\n\nBest,\n{rep}",
    ],
    chat: [
      "Hi {first}, did that answer your questions? Happy to do a 20-minute walkthrough, {sas} or {sbs}.",
      "Hey {first}, anything still unclear from what I sent? Glad to fill the gaps.",
    ],
  },
  overview_f2: {
    email: [
      "Hi {first},\n\nOne more thing that might help the internal case: Brightloop (B2B SaaS, 140 people) went from 38 to 81 first meetings a month in a quarter. Write-up: northwind.example/customers/brightloop. Happy to talk through what that would look like at {company}.\n\n{rep}",
      "Hi {first},\n\nIf it helps to show colleagues a real result, this is the one I'd use: northwind.example/customers/brightloop. Research time down 70%, first meetings more than doubled. I can adapt it to {company}'s numbers if you share a few.\n\nBest,\n{rep}",
    ],
    chat: [
      "Hi {first}, one more example that might help your case: Brightloop went from 38 to 81 first meetings a month. northwind.example/customers/brightloop",
    ],
  },
  pilot_f1: {
    email: [
      "Hi {first},\n\nChecking in on the pilot setup. Have your two reps been able to connect their mailbox and LinkedIn account? If anything is blocking, domain verification is the usual one; send me a screenshot and I'll sort it the same day.\n\n{rep}",
      "Hi {first},\n\nHow is the pilot going so far? If the reps got stuck connecting mailboxes, tell me where and I'll fix it today.\n\nBest,\n{rep}",
    ],
    chat: [
      "Hi {first}, how's the pilot setup going? If anything is stuck connecting accounts, send me a screenshot.",
    ],
  },
  pilot_f2: {
    email: [
      "Hi {first},\n\nOne week in, the first numbers should be visible in Analytics (replies by category, drafts sent as-is versus edited). Want to spend 20 minutes reviewing them together and decide whether to extend the pilot to the rest of the team? {sa} or {sb}.\n\n{rep}",
    ],
    chat: [
      "Hi {first}, a week in the first numbers are ready. 20 minutes to review them, {sas} or {sbs}?",
    ],
  },
  nurture_f1: {
    email: [
      "Hi {first},\n\nCircling back as promised. Last time you said timing wasn't right; has anything shifted at {company} since? If outbound is on the agenda this quarter I'd be glad to show you what's new, and the two-seat pilot is still free for 14 days.\n\n{rep}",
      "Hi {first},\n\nFollowing up as I said I would. Anything changed on your side since we last spoke? No pressure either way.\n\nBest,\n{rep}",
    ],
    chat: [
      "Hi {first}, circling back as promised. Has anything shifted at {company}?",
    ],
  },
  nurture_f2: {
    email: [
      "Hi {first},\n\nA quick update since we last spoke: we've added per-rep sending limits and a shared reply inbox, and teams now get through the two-seat pilot in under a day. If that's relevant to {company}, I can send details. Otherwise I'll leave you in peace.\n\n{rep}",
    ],
    chat: [
      "Hi {first}, quick update: per-rep sending limits and a shared reply inbox are live. Relevant to {company}?",
    ],
  },
  ooo_f1: {
    email: [
      "Hi {first},\n\nHope the time away was good. I'm following up on my earlier note about {company}'s outbound. When you're caught up, would a 20-minute call work: {sa} or {sb}?\n\n{rep}",
      "Hi {first},\n\nWelcome back. When you have a moment, I'd value 20 minutes to show you how Signal handles replies. {sa} or {sb} both work for me.\n\nBest,\n{rep}",
    ],
    chat: [
      "Hi {first}, hope you had a good break. Free for a quick call {sas} or {sbs}?",
    ],
  },
  ooo_f2: {
    email: [
      "Hi {first},\n\nLast nudge from me. If this isn't on your plate right now, who at {company} owns outbound reply handling? Happy to take it up with them.\n\n{rep}",
    ],
    chat: [
      "Hi {first}, last nudge: if this isn't yours, who at {company} should I speak to?",
    ],
  },
  after_f1: {
    email: [
      "Hi {first},\n\nHow did the pricing land with your team? If it's easier to talk it through I'm free {sa} or {sb}. I can also start the two-seat pilot this week so you see it on {company}'s own data before deciding.\n\n{rep}",
    ],
    chat: [
      "Hi {first}, how did the pricing land with your team? Happy to talk it through, {sas} or {sbs}.",
    ],
  },
  after_f2: {
    email: [
      "Hi {first},\n\nI don't want this to drift. Would it help if I set up the pilot on a single campaign this week and we review results together in two weeks? No commitment, and if the numbers don't beat what you do today, we stop.\n\n{rep}",
    ],
    chat: [
      "Hi {first}, would a one-campaign pilot help you decide? Two weeks, review together, no commitment.",
    ],
  },
};

const GOALS = [
  "cut the time spent researching accounts",
  "stop replies from sitting unanswered in the inbox",
  "book more first meetings from the same lists",
  "give new SDRs a clear list to work every morning",
];
const COLLEAGUES = ["Marcus", "Elena", "their RevOps lead", "their head of growth"];

function fill(template: string, c: CopyCtx): string {
  const s = slots(c);
  const inboundText = c.inbound;
  const named = /\b(Marcus|Elena|Dana|Priyanka|Tom|Sofia)\b/.exec(inboundText)?.[1];
  const when = (() => {
    if (/april/i.test(inboundText)) return "April";
    if (/\bQ2\b/.test(inboundText)) return "the start of Q2";
    if (/next quarter/i.test(inboundText)) return "the start of next quarter";
    const d = new Date(c.at.getTime() + 55 * DAY);
    return MONTHS[d.getUTCMonth()];
  })();
  const topic = TOPICS[topicOf(inboundText)].replaceAll("{company}", c.company);
  const topicShort = topic.split(". ").slice(0, 2).join(". ").replace(/\.?$/, ".");
  const industryLine = c.industry === "B2B SaaS"
    ? "They're very close to your size and motion."
    : `I don't have a published ${c.industry} story yet, but I can introduce you to a customer in a comparable position if that would help.`;
  const out = template
    .replaceAll("{topic_short}", topicShort)
    .replaceAll("{topic}", topic)
    .replaceAll("{industry_line}", industryLine)
    .replaceAll("{lead_day}", s.leadDay)
    .replaceAll("{sas}", s.sas)
    .replaceAll("{sbs}", s.sbs)
    .replaceAll("{sa_day}", s.sas.split(" ")[0])
    .replaceAll("{sa}", s.sa)
    .replaceAll("{sb}", s.sb)
    .replaceAll("{first}", c.first)
    .replaceAll("{company}", c.company)
    .replaceAll("{industry}", c.industry.toLowerCase())
    .replaceAll("{title}", c.title)
    .replaceAll("{replower}", c.rep.toLowerCase())
    .replaceAll("{rep}", c.rep)
    .replaceAll("{when}", when)
    .replaceAll("{colleague}", named ?? COLLEAGUES[c.variant % COLLEAGUES.length])
    .replaceAll("{goal}", GOALS[c.variant % GOALS.length])
    .replaceAll("{seats}", String(c.seats));
  return out;
}

function writeCopy(c: CopyCtx, key: CopyKey): { subject: string | null; body: string } {
  const bank = c.channel === "email" ? COPY[key].email : COPY[key].chat;
  const body = fill(bank[c.variant % bank.length], c);
  if (c.channel !== "email") return { subject: null, body };
  const base = c.subject?.trim();
  const subject = base ? (/^re:/i.test(base) ? base : `Re: ${base}`) : `Re: Northwind Signal for ${c.company}`;
  return { subject, body };
}

/** A hand edit of an AI draft: small, human, never a rewrite. */
function lightEdit(body: string, channel: Chan, variant: number): string {
  const edits: ((text: string) => string)[] = [
    (t) => (channel === "email" ? t.replace(/\n\n(Best|Thanks|Cheers|Thanks again|All the best),\n/, "\n\nLooking forward to it.\n\n$1,\n") : `${t} Talk soon.`),
    (t) => t.replace(/^Hi (\w+),/, "Hello $1,"),
    (t) => (channel === "email" ? t.replace(/\n\n(?=[^\n]*\n?$)/, "\n\nP.S. Happy to loop in anyone else on your side.\n\n") : `${t} Happy to loop in a colleague too.`),
    (t) => t.replace("Thanks for", "Thank you for").replace("Happy to", "Glad to"),
    (t) => (channel === "email" ? t.replace(/^Hi (\w+),\n\n/, "Hi $1,\n\nHope your week is going well. ") : t.replace(/^Hi (\w+),/, "Hi $1 -")),
    (t) => t.replace(/\n(Best|Thanks|Cheers),\n/, (_m, w: string) => `\n${w === "Best" ? "Best regards" : w === "Thanks" ? "Many thanks" : "Cheers"},\n`),
    (t) => (channel === "email" ? t.replace(/\n\n(?=[^\n]+\n?$)/, "\n\nLet me know if any of that is off.\n\n") : t),
  ];
  for (let i = 0; i < edits.length; i++) {
    const next = edits[(variant + i) % edits.length](body);
    if (next.trim() !== body.trim()) return next;
  }
  return `${body}\n\nP.S. Happy to loop in anyone else on your side.`;
}

const HANDWRITTEN: Record<Chan, string[]> = {
  email: [
    "Hi {first},\n\nThanks, and sorry for the long reply earlier. Short version: yes, we can do this, and the quickest way is a 20-minute call. Tell me what suits you this week and I'll send an invite.\n\n{rep}",
    "Hi {first},\n\nAppreciate the reply. I'd rather not send you more text: can we do 15 minutes this week? You pick the time.\n\n{rep}",
  ],
};

// ===========================================================================
// Classification words
// ===========================================================================

const REASONING: Record<ReplyIntent, string[]> = {
  "Meeting Requested": [
    "The lead agrees to talk and asks for times, which is a direct meeting request.",
    "They ask to schedule a call and are waiting for availability.",
  ],
  "Demo Request": [
    "Explicitly asks to see the product in a live demo.",
    "Asks for a walkthrough of the product and mentions their team size.",
  ],
  "Information Requested": [
    "Asks for pricing or product details before committing to a call; no meeting or demo requested yet.",
    "Wants information (integrations, security or onboarding) to discuss internally.",
  ],
  "Case Study": [
    "Asks for a customer example from a comparable company.",
    "Requests a reference or proof of results before spending time.",
  ],
  "Trial Requested": [
    "Prefers to try the product rather than take a call and asks about a pilot.",
    "Asks how to start a trial with a couple of reps.",
  ],
  "Not Required Right Now": [
    "Timing is wrong (budget, reorg or hiring freeze) but they do not reject future contact.",
    "Says it is not a priority this quarter and invites a later check-in.",
  ],
  "Already Using a Tool — Not Required": [
    "An existing vendor or in-house process already covers the need; they see no reason to switch.",
  ],
  "Connected to Different POC": [
    "Says they are not the right person and points to a colleague who owns the topic.",
  ],
  "Out of Office": [
    "Automatic out-of-office notice with a return date; not a reply to the pitch.",
  ],
  "Left Company": [
    "States that the person has left the company and suggests a general mailbox.",
  ],
  "Do Not Contact": [
    "Explicit request to be removed from outreach.",
  ],
  "Other": [
    "Asks how they were contacted; no buying signal either way.",
  ],
};

/** What the AI plausibly confuses each intent with, for the few it gets wrong. */
const CONFUSED_WITH: Partial<Record<ReplyIntent, ReplyIntent>> = {
  "Information Requested": "Case Study",
  "Case Study": "Information Requested",
  "Meeting Requested": "Demo Request",
  "Demo Request": "Meeting Requested",
  "Not Required Right Now": "Already Using a Tool — Not Required",
  "Already Using a Tool — Not Required": "Not Required Right Now",
  "Other": "Connected to Different POC",
  "Connected to Different POC": "Other",
};

// ===========================================================================
// Plan: decide every random thing up front (no randomness while executing)
// ===========================================================================

const STAGES_WITHOUT_SEQUENCE: string[] = ["Meeting No Show", "Customer"];

type StageMove = { to: "Meeting Done" | "Meeting No Show" | "Trial User" | "Customer"; days: number; note: string };
type Cls = { mode: "auto" | "accepted" | "overridden" | "pending"; confidence: number };
type First = "sent" | "awaiting" | "discarded" | "skip" | "closed";

type Plan = {
  reply: DemoReply;
  person: DemoPerson;
  age: number;
  cls: Cls;
  first: First;
  variant: number;
  seats: number;
  /** Per follow-up step: send it or skip it. */
  follow: ("send" | "skip")[];
  edit: boolean[];
  reviewFollowUp: boolean;
  stages: StageMove[];
  u: number[];
};

const POSITIVE: ReplyIntent[] = ["Meeting Requested", "Demo Request", "Information Requested", "Case Study", "Trial Requested"];
const NO_DRAFT: ReplyIntent[] = ["Do Not Contact", "Left Company"];
const REVIEWABLE: ReplyIntent[] = ["Other", "Connected to Different POC", "Not Required Right Now", "Already Using a Tool — Not Required", "Information Requested", "Case Study", "Demo Request"];

function buildPlans(ctx: DemoContext, replies: DemoReply[], people: Map<string, DemoPerson>): Plan[] {
  const rand = ctx.rand;
  // One plan per record: its newest reply is the one the CRM works.
  const latest = new Map<string, DemoReply>();
  for (const reply of replies) {
    const current = latest.get(reply.recordId);
    if (!current || reply.sentAt > current.sentAt) latest.set(reply.recordId, reply);
  }
  const rows = [...latest.values()].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.messageId.localeCompare(b.messageId));
  // Variants go round per intent, so neighbouring rows in a queue never repeat each other's words.
  const turn = new Map<string, number>();
  const plans: Plan[] = rows.map((reply) => {
    const person = people.get(reply.personId);
    if (!person) throw new Error(`CRM outcomes: reply ${reply.messageId} names an unknown person`);
    const noDraft = NO_DRAFT.includes(reply.intent);
    return {
      reply,
      person,
      age: (ctx.now.getTime() - reply.sentAt.getTime()) / DAY,
      cls: { mode: "auto", confidence: 0.86 + rand.next() * 0.12 },
      first: noDraft ? "closed" : reply.intent === "Out of Office" ? "skip" : "sent",
      variant: (() => {
        const key = reply.intent;
        const n = turn.get(key) ?? rand.int(0, 11);
        turn.set(key, n + 1);
        return n;
      })(),
      seats: rand.pick([5, 8, 10, 12, 15, 20, 25]),
      follow: [rand.chance(0.42) ? "send" : "skip", rand.chance(0.42) ? "send" : "skip", rand.chance(0.42) ? "send" : "skip"],
      edit: Array.from({ length: 6 }, () => rand.chance(0.24)),
      reviewFollowUp: false,
      stages: [],
      u: Array.from({ length: 40 }, () => rand.next()),
    };
  });

  // Newest first: some replies are still waiting for a person.
  // Follow-ups that came due in the last few days and are waiting on a person: replies from a few days back
  // whose next step (2-3 days after the reply went out) fell due since.
  const followUpWindow: Partial<Record<ReplyIntent, [number, number]>> = {
    "Meeting Requested": [2.9, 5.3], "Demo Request": [2.9, 5.3], "Trial Requested": [2.9, 5.3],
    "Information Requested": [3.9, 6.3], "Case Study": [3.9, 6.3], "Out of Office": [5.8, 8.5],
  };
  rand.shuffle(plans.filter((p) => {
    const window = followUpWindow[p.reply.intent];
    return window && p.age >= window[0] && p.age <= window[1];
  })).slice(0, 4).forEach((p) => { p.reviewFollowUp = true; });

  const recent = plans
    .filter((p) => !NO_DRAFT.includes(p.reply.intent) && p.reply.intent !== "Out of Office" && p.age <= 14 && !p.reviewFollowUp)
    .sort((a, b) => b.reply.sentAt.getTime() - a.reply.sentAt.getTime());
  // The queue is worked daily: the replies still waiting for a draft to be reviewed are mostly from the last few days.
  let awaiting = 0;
  let positiveSeen = 0;
  let cutoff = Infinity;
  for (const p of recent) {
    if (awaiting >= 10) break;
    const positive = POSITIVE.includes(p.reply.intent);
    // The newest rows of the queue are good news; trivial replies were answered at once.
    if (positiveSeen < 4 && !positive) continue;
    if (p.age > 3.6 && !(awaiting < 9 && p.age <= 8)) continue;
    awaiting++;
    p.first = "awaiting";
    if (positive && positiveSeen < 4) {
      positiveSeen++;
      if (positiveSeen === 4) cutoff = p.reply.sentAt.getTime();
    }
  }
  // A handful of classifications the AI was not sure about wait for a person before anything is drafted.
  const unsure = recent.filter((p) => p.first !== "awaiting" && REVIEWABLE.includes(p.reply.intent) && p.age <= 12 && p.reply.sentAt.getTime() < cutoff);
  const spread = unsure.filter((_, index) => index % 2 === 0).concat(unsure.filter((_, index) => index % 2 === 1));
  let held = 0;
  for (const p of spread) {
    if (held >= 5) break;
    p.cls = { mode: "pending", confidence: 0.55 + rand.next() * 0.12 };
    p.first = "awaiting";
    held++;
  }
  if (held < 5) {
    for (const p of recent.filter((q) => q.first === "awaiting" && q.cls.mode !== "pending" && REVIEWABLE.includes(q.reply.intent) && q.reply.sentAt.getTime() < cutoff)) {
      if (held >= 5) break;
      p.cls = { mode: "pending", confidence: 0.55 + rand.next() * 0.12 };
      held++;
    }
  }
  const open = (p: Plan) => p.first !== "awaiting" && p.cls.mode !== "pending";

  // Progression for the positive replies, oldest first.
  const positive = plans.filter((p) => open(p) && ["Meeting Requested", "Demo Request"].includes(p.reply.intent))
    .sort((a, b) => b.age - a.age);
  const trials = plans.filter((p) => open(p) && p.reply.intent === "Trial Requested").sort((a, b) => b.age - a.age);
  const used = new Set<Plan>();
  const take = (pool: Plan[], minAge: number) => pool.find((p) => !used.has(p) && p.age >= minAge);
  const note = (p: Plan, kind: StageMove["to"]): string => {
    const who = rand.pick(["their RevOps lead", "the VP of Sales", "two of their SDR leads", "their head of growth"]);
    switch (kind) {
      case "Meeting Done": return `Intro call with ${p.person.firstName} and ${who}. Wants pricing for ${p.seats} seats.`;
      case "Meeting No Show": return `Did not join the call; no message in the 15 minutes after the start.`;
      case "Trial User": return "Pilot live: two seats connected, first campaign running.";
      case "Customer": return `Signed the Team plan for ${p.seats} seats on an annual contract.`;
    }
  };
  const gap = (lo: number, hi: number) => rand.int(lo, hi);
  const path = (p: Plan, steps: StageMove["to"][]) => {
    used.add(p);
    let day = 0;
    p.stages = steps.map((to, i) => {
      day += i === 0 ? gap(2, 5) : to === "Trial User" ? gap(4, 9) : gap(7, 13);
      return { to, days: day, note: note(p, to) };
    });
  };
  // Customers: most signed in the last 30 days, a couple before that, so the overview trends up.
  const customerSlots: [number, number][] = [[3, 27], [3, 27], [3, 27], [3, 27], [3, 27], [33, 58], [33, 58]];
  for (const [lo, hi] of customerSlots) {
    for (const p of rand.shuffle(positive.filter((q) => !used.has(q) && q.age >= 24))) {
      path(p, ["Meeting Done", "Trial User", "Customer"]);
      const signedAgo = p.age - p.stages[p.stages.length - 1].days;
      if (signedAgo >= lo && signedAgo <= hi) break;
      used.delete(p);
      p.stages = [];
    }
  }
  for (let i = 0; i < 4; i++) { const p = take(positive, 24); if (p) path(p, ["Meeting Done", "Trial User"]); }
  for (let i = 0; i < 6; i++) { const p = take(positive, 9); if (p) path(p, ["Meeting Done"]); }
  for (let i = 0; i < 3; i++) { const p = take(positive, 7); if (p) path(p, ["Meeting No Show"]); }
  for (let i = 0; i < 2; i++) { const p = take(trials, 14); if (p) path(p, ["Trial User"]); }
  // Make sure each chain actually fits before now (shorten otherwise).
  for (const p of plans) {
    p.stages = p.stages.filter((s) => s.days < p.age - 1.2);
  }

  // A few classifications a person had to look at.
  const settled = plans.filter((p) => open(p) && !NO_DRAFT.includes(p.reply.intent) && p.reply.intent !== "Out of Office" && p.age > 2.5);
  const confusable = rand.shuffle(settled.filter((p) => CONFUSED_WITH[p.reply.intent] && p.age > 12));
  confusable.slice(0, 4).forEach((p) => { p.cls = { mode: "overridden", confidence: 0.6 + rand.next() * 0.14 }; });
  rand.shuffle(settled.filter((p) => p.cls.mode === "auto")).slice(0, Math.round(settled.length * 0.2)).forEach((p) => {
    p.cls = { mode: "accepted", confidence: 0.7 + rand.next() * 0.14 };
  });

  // A few first drafts the rep threw away and replaced with their own words.
  const discardable = rand.shuffle(plans.filter((p) => open(p) && p.first === "sent" && p.stages.length === 0 && p.age > 6 && p.age < 45
    && ["Other", "Connected to Different POC", "Not Required Right Now", "Already Using a Tool — Not Required", "Information Requested"].includes(p.reply.intent)));
  discardable.slice(0, 3).forEach((p) => { p.first = "discarded"; });

  return plans;
}

// ===========================================================================
// Time helpers
// ===========================================================================

/** Moves a moment into working hours (05:00-23:00 UTC), keeping the order of events. */
function businessTime(d: Date, u: number): Date {
  const x = new Date(d);
  // The team spans time zones, so "at work" is most of the UTC day; weekends mostly wait for Monday.
  for (let guard = 0; guard < 5; guard++) {
    const dow = x.getUTCDay();
    const hour = x.getUTCHours();
    const weekend = (dow === 6 || dow === 0) && u >= 0.3;
    if (weekend || hour >= 23 || hour < 5) {
      if (!weekend && hour < 5) {
        x.setUTCHours(5, 5 + Math.floor(u * 80), Math.floor(u * 5000) % 60, 0);
      } else {
        x.setUTCDate(x.getUTCDate() + 1);
        x.setUTCHours(5, 5 + Math.floor(u * 120), Math.floor(u * 7000) % 60, 0);
      }
      continue;
    }
    break;
  }
  return x;
}

// ===========================================================================
// The stamping machinery (see the header)
// ===========================================================================

async function dbMarker(): Promise<string> {
  // Ten seconds back: the JS clock that stamps updated_at may trail the database's.
  const [row] = await db.execute<{ t: string }>(sql`SELECT to_char((clock_timestamp() - interval '10 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`);
  return row.t;
}

/**
 * One transaction's events all carry the same timestamp, so within a phase they
 * are put back in the order things actually happen.
 */
const EVENT_ORDER = sql.raw(`CASE event_type
  WHEN 'sequence.interrupted' THEN 5
  WHEN 'classification.auto_applied' THEN 10 WHEN 'classification.proposed' THEN 10
  WHEN 'classification.changed' THEN 10 WHEN 'stage.moved' THEN 10 WHEN 'classification.undone' THEN 10
  WHEN 'classification.acknowledged' THEN 12
  WHEN 'contact_policy.dnc_set' THEN 14 WHEN 'contact_policy.enforced' THEN 15
  WHEN 'workflow.state_changed' THEN 16
  WHEN 'sequence.started' THEN 20 WHEN 'sequence.step_skipped' THEN 20 WHEN 'sequence.step_adopted' THEN 25
  WHEN 'draft.generated' THEN 30 WHEN 'draft.edited' THEN 31 WHEN 'draft.discarded' THEN 32
  WHEN 'message.sending' THEN 40 WHEN 'message.sent' THEN 41
  ELSE 50 END`);

async function restamp(recordId: string, personId: string, marker: string, at: Date): Promise<void> {
  const A = at.toISOString();
  const org = currentOrganizationId();
  const M = sql`${marker}::timestamptz`;
  const Av = sql`${A}::timestamptz`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      UPDATE crm_events e SET created_at = ${Av} + (x.rn - 1) * interval '7 seconds'
        FROM (SELECT id, row_number() OVER (ORDER BY created_at, ${EVENT_ORDER}, id) AS rn FROM crm_events
               WHERE organization_id = ${org} AND created_at >= ${M}
                 AND (crm_record_id = ${recordId} OR (crm_record_id IS NULL AND person_id = ${personId}))) x
       WHERE e.id = x.id`);
    await tx.execute(sql`
      UPDATE crm_classifications SET
        created_at = CASE WHEN created_at >= ${M} THEN ${Av} ELSE created_at END,
        updated_at = CASE WHEN updated_at >= ${M} THEN ${Av} + interval '3 seconds' ELSE updated_at END,
        acknowledged_at = CASE WHEN acknowledged_at >= ${M} THEN ${Av} + interval '2 seconds' ELSE acknowledged_at END
       WHERE crm_record_id = ${recordId} AND (created_at >= ${M} OR updated_at >= ${M} OR acknowledged_at >= ${M})`);
    await tx.execute(sql`
      UPDATE crm_drafts SET
        created_at = CASE WHEN created_at >= ${M} THEN ${Av} ELSE created_at END,
        updated_at = CASE WHEN updated_at >= ${M} THEN ${Av} + interval '5 seconds' ELSE updated_at END
       WHERE crm_record_id = ${recordId} AND (created_at >= ${M} OR updated_at >= ${M})`);
    await tx.execute(sql`
      UPDATE crm_sequence_runs SET
        created_at = CASE WHEN created_at >= ${M} THEN ${Av} ELSE created_at END,
        updated_at = CASE WHEN updated_at >= ${M} THEN ${Av} + interval '4 seconds' ELSE updated_at END
       WHERE organization_id = ${org} AND crm_record_id = ${recordId} AND (created_at >= ${M} OR updated_at >= ${M})`);
    await tx.execute(sql`
      UPDATE crm_sequence_step_runs SET
        created_at = CASE WHEN created_at >= ${M} THEN ${Av} ELSE created_at END,
        updated_at = CASE WHEN updated_at >= ${M} THEN ${Av} + interval '4 seconds' ELSE updated_at END
       WHERE sequence_run_id IN (SELECT id FROM crm_sequence_runs WHERE organization_id = ${org} AND crm_record_id = ${recordId})
         AND (created_at >= ${M} OR updated_at >= ${M})`);
    await tx.execute(sql`
      UPDATE crm_send_attempts SET
        created_at = CASE WHEN created_at >= ${M} THEN ${Av} ELSE created_at END,
        updated_at = CASE WHEN updated_at >= ${M} THEN ${Av} + interval '4 seconds' ELSE updated_at END,
        reconciled_at = CASE WHEN reconciled_at >= ${M} THEN ${Av} ELSE reconciled_at END
       WHERE draft_id IN (SELECT id FROM crm_drafts WHERE crm_record_id = ${recordId}) AND (created_at >= ${M} OR updated_at >= ${M})`);
    await tx.execute(sql`
      UPDATE crm_conversation_messages SET
        sent_at = CASE WHEN created_at >= ${M} AND direction = 'outbound' THEN ${Av} + interval '4 seconds' ELSE sent_at END,
        created_at = CASE WHEN created_at >= ${M} THEN ${Av} + interval '4 seconds' ELSE created_at END
       WHERE conversation_id IN (SELECT id FROM crm_conversations WHERE organization_id = ${org} AND crm_record_id = ${recordId})
         AND created_at >= ${M}`);
    await tx.execute(sql`
      UPDATE crm_messages im SET sent_at = ${Av} + interval '4 seconds', created_at = ${Av} + interval '4 seconds'
       WHERE im.created_at >= ${M} AND im.smartlead_message_id LIKE 'crm-send:%'
         AND im.lead_id IN (SELECT id FROM crm_leads WHERE organization_id = ${org}
                             AND lower(email) = (SELECT lower(email) FROM people WHERE id = ${personId}))`);
    await tx.execute(sql`
      UPDATE "Message" SET "createdAt" = (${Av} + interval '4 seconds') AT TIME ZONE 'UTC'
       WHERE "organizationId" = ${org} AND "createdAt" >= (${M} AT TIME ZONE 'UTC') AND type = 'CUSTOM_SENT'
         AND "leadId" IN (SELECT id FROM "Lead" WHERE "organizationId" = ${org} AND "personId" = ${personId})`);
    await tx.execute(sql`
      UPDATE crm_person_contact_policies SET
        created_at = CASE WHEN created_at >= ${M} THEN ${Av} ELSE created_at END,
        updated_at = CASE WHEN updated_at >= ${M} THEN ${Av} ELSE updated_at END,
        set_at = CASE WHEN set_at >= ${M} THEN ${Av} ELSE set_at END,
        cleared_at = CASE WHEN cleared_at >= ${M} THEN ${Av} ELSE cleared_at END
       WHERE person_id = ${personId} AND (created_at >= ${M} OR updated_at >= ${M})`);
    await tx.execute(sql`
      UPDATE crm_conversations SET updated_at = CASE WHEN updated_at >= ${M} THEN ${Av} ELSE updated_at END
       WHERE organization_id = ${org} AND crm_record_id = ${recordId} AND updated_at >= ${M}`);
    await tx.execute(sql`
      UPDATE crm_records SET
        updated_at = CASE WHEN updated_at >= ${M} THEN ${Av} + interval '6 seconds' ELSE updated_at END,
        last_outbound_at = CASE WHEN last_outbound_at >= ${M} THEN ${Av} + interval '4 seconds' ELSE last_outbound_at END,
        last_interaction_at = CASE WHEN last_interaction_at >= ${M} THEN ${Av} + interval '4 seconds' ELSE last_interaction_at END
       WHERE organization_id = ${org} AND id = ${recordId}`);
  });
}

/**
 * The lib stamps schedules from the real clock ("due in 3 days" = now + 3
 * days). Rebuild them from `base`: each scheduled step comes due `delay` after
 * the one before; the record's next_action_at follows.
 */
async function fixSchedule(ctx: DemoContext, recordId: string, base: Date, draftAt?: Date): Promise<void> {
  const org = currentOrganizationId();
  const floor = ctx.now.getTime() + 45 * MINUTE;
  const steps = await db.select({ id: crmSequenceStepRuns.id, delay: crmSequenceSteps.delayMinutes })
    .from(crmSequenceStepRuns)
    .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
    .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
    .where(and(eq(crmSequenceRuns.crmRecordId, recordId), eq(crmSequenceRuns.status, "active"), eq(crmSequenceStepRuns.status, "scheduled")))
    .orderBy(asc(crmSequenceSteps.position));
  const [record] = await db.select({ state: crmRecords.workflowState, version: crmRecords.contextVersion }).from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.id, recordId))).limit(1);
  let cumulative = 0;
  let firstDue: Date | null = null;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    for (const step of steps) {
      cumulative += step.delay;
      let due = base.getTime() + cumulative * MINUTE;
      const waiting = record?.state === "waiting";
      if (waiting && due < floor) due = floor + (steps.indexOf(step)) * HOUR;
      const dueAt = new Date(due);
      firstDue ??= dueAt;
      // skipCurrentSequenceStep re-versions only the next step, so a later one would read as stale.
      await tx.execute(sql`UPDATE crm_sequence_step_runs SET due_at = ${dueAt.toISOString()}::timestamptz,
        expected_context_version = ${record?.version ?? 0} WHERE id = ${step.id}`);
    }
    const state = record?.state;
    const next = state === "waiting" ? firstDue : state === "action_required" ? draftAt ?? null : null;
    await tx.execute(sql`UPDATE crm_records SET next_action_at = ${next ? next.toISOString() : null}::timestamptz
      WHERE organization_id = ${org} AND id = ${recordId}`);
  });
}

// ===========================================================================
// Execution
// ===========================================================================

type Env = {
  ctx: DemoContext;
  subs: Map<string, { id: string; key: string; categoryKey: "customer" | "interested" | "not_interested" | "other" }>;
  inbound: Map<string, { subject: string | null; body: string }>;
  hex: () => string;
};

/** Follow-ups left waiting for review so far (kept to a few). */
const reviews = { n: 0 };

class Cursor {
  private i = 0;
  constructor(private readonly u: number[]) {}
  next(): number { return this.u[this.i++ % this.u.length]; }
}

/** Minutes a person takes to get to a draft: usually within a couple of hours, sometimes the next day. */
const humanDelay = (u: number, p: Plan) => 5 + Math.pow(u, 2.8) * 420 * (p.age < 30 ? 0.04 : p.age < 60 ? 1.8 : 2.6);
/** Recent conversations get answered whenever they arrive; older ones keep to working hours. */
const atWork = (p: Plan, d: Date, u: number) => (p.age < 30 ? d : businessTime(d, u));
const cap = (env: Env, d: Date) => new Date(Math.min(d.getTime(), env.ctx.now.getTime() - 3 * MINUTE));
const mono = (prev: Date, d: Date) => new Date(Math.max(d.getTime(), prev.getTime() + 70_000));

function classifier(env: Env, p: Plan, intent: ReplyIntent, confidence: number, reasoning: string): ClassificationCompletion {
  const sub = env.subs.get(intent);
  if (!sub) throw new Error(`CRM outcomes: no subcategory named ${intent}`);
  return async () => ({
    text: JSON.stringify({ categoryKey: sub.categoryKey, subcategoryKey: sub.key, confidence: Math.round(confidence * 100) / 100, reasoning, suggestedNextActionAt: null }),
    provider: "anthropic",
    model: "anthropic/claude-haiku-4.5",
    request: { model: "anthropic/claude-haiku-4.5", temperature: 0, response_format: { type: "json_schema" } },
    response: { id: `gen-${env.hex()}`, finish_reason: "stop" },
    usage: { inputTokens: 1500 + Math.round(p.u[0] * 900), outputTokens: 60 + Math.round(p.u[1] * 40) },
  });
}

function drafter(env: Env, p: Plan, subject: string | null, body: string): DraftCompletion {
  return async () => ({
    text: JSON.stringify({ subject, bodyText: body, bodyHtml: null }),
    provider: "anthropic",
    model: "anthropic/claude-sonnet-4.5",
    request: { model: "anthropic/claude-sonnet-4.5", temperature: 0.4, max_tokens: 900 },
    response: { id: `gen-${env.hex()}`, finish_reason: "stop" },
    usage: { inputTokens: 2400 + Math.round(p.u[2] * 1600), outputTokens: 120 + Math.round(p.u[3] * 140) },
  });
}

async function recordState(recordId: string) {
  const [row] = await db.select().from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.id, recordId))).limit(1);
  if (!row) throw new Error(`CRM outcomes: record ${recordId} vanished`);
  return row;
}

async function phase<T>(p: Plan, at: Date, fn: () => Promise<T>): Promise<T> {
  const marker = await dbMarker();
  const out = await fn();
  await restamp(p.reply.recordId, p.reply.personId, marker, at);
  return out;
}

function copyCtx(env: Env, p: Plan, at: Date, variantShift = 0): CopyCtx {
  const inbound = env.inbound.get(p.reply.messageId);
  return {
    first: p.person.firstName,
    company: p.person.company.name,
    industry: p.person.company.industry,
    title: p.person.title,
    rep: TEAM[p.reply.rep].first,
    channel: p.reply.channel as Chan,
    tz: tzLabel(p.person),
    inbound: inbound?.body ?? "",
    subject: inbound?.subject ?? null,
    at,
    variant: p.variant + variantShift,
    seats: p.seats,
  };
}

const INTENT_COPY: Partial<Record<ReplyIntent, CopyKey>> = {
  "Meeting Requested": "meeting",
  "Demo Request": "demo",
  "Information Requested": "info",
  "Case Study": "case",
  "Trial Requested": "trial",
  "Not Required Right Now": "nurture",
  "Already Using a Tool — Not Required": "using",
  "Connected to Different POC": "poc",
  "Other": "other",
};

const FOLLOW_COPY: Record<string, CopyKey[]> = {
  "Book the meeting": ["book_f1", "book_f2"],
  "Send the overview": ["overview_f1", "overview_f2"],
  "Pilot kickoff": ["pilot_f1", "pilot_f2"],
  "Nurture: check back next quarter": ["nurture_f1", "nurture_f2"],
  "Bump after out-of-office": ["ooo_f1", "ooo_f2"],
  "After the meeting": ["after_f1", "after_f2"],
};

/** The step run a fresh draft belongs to, and what it is (null step: a fallback draft). */
async function openStep(recordId: string) {
  const [row] = await db.select({
    stepRunId: crmSequenceStepRuns.id,
    position: crmSequenceSteps.position,
    delay: crmSequenceSteps.delayMinutes,
    sequenceName: sql<string>`(select name from crm_sequences where id = ${crmSequenceRuns.sequenceId})`,
  })
    .from(crmSequenceStepRuns)
    .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
    .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
    .where(and(eq(crmSequenceRuns.crmRecordId, recordId), eq(crmSequenceRuns.status, "active"), eq(crmSequenceStepRuns.status, "scheduled")))
    .orderBy(asc(crmSequenceSteps.position)).limit(1);
  return row ?? null;
}

async function awaitingDraft(recordId: string) {
  const [draft] = await db.select().from(crmDrafts)
    .where(and(eq(crmDrafts.crmRecordId, recordId), eq(crmDrafts.status, "awaiting_review")))
    .orderBy(desc(crmDrafts.createdAt)).limit(1);
  return draft ?? null;
}

/** Write (and leave awaiting review) the draft the record's next step calls for. */
async function writeDraftNow(env: Env, p: Plan, at: Date, key: CopyKey | null, stage?: "Meeting Done" | "Meeting No Show"): Promise<boolean> {
  const step = await openStep(p.reply.recordId);
  let copyKey = key;
  if (!copyKey) {
    if (stage === "Meeting Done") copyKey = "recap";
    else if (stage === "Meeting No Show") copyKey = "noShow";
    else if (step && step.position > 1) copyKey = (FOLLOW_COPY[step.sequenceName] ?? [])[step.position - 2] ?? "book_f1";
    else copyKey = INTENT_COPY[p.reply.intent] ?? "info";
  }
  const copy = writeCopy(copyCtx(env, p, at), copyKey);
  const complete = drafter(env, p, copy.subject, copy.body);
  const made = await phase(p, at, async () => {
    if (step) {
      // A step that is not the reply (position > 1) is drafted when it comes due.
      return generateDraftForStep(step.stepRunId, { complete });
    }
    return generateFallbackDraft(p.reply.recordId, { complete });
  });
  if (!made) return false;
  await fixSchedule(env.ctx, p.reply.recordId, at, at);
  return true;
}

function sendStub(env: Env): CrmSendAdapter {
  return async (input) => {
    const id = `${env.hex()}`;
    return {
      provider: "gmail", providerMessageId: `demo-gm-${id}`, providerThreadId: input.providerThreadId, rfcMessageId: `<demo.${id}@mail.northwind.example>`,
      response: { id: `demo-gm-${id}`, threadId: input.providerThreadId },
    };
  };
}

/** Send the draft awaiting review on a record (optionally after a small edit), as a person would. */
async function sendNow(env: Env, p: Plan, tEdit: Date | null, tSend: Date, actor: string | undefined): Promise<void> {
  let draft = await awaitingDraft(p.reply.recordId);
  if (!draft) throw new Error(`CRM outcomes: no draft to send on ${p.reply.recordId}`);
  if (tEdit) {
    const edited = lightEdit(draft.aiBodyText ?? "", draft.channel as Chan, p.variant);
    draft = await phase(p, tEdit, () => updateDraft({ draftId: draft!.id, revision: draft!.revision, subject: draft!.subject, bodyText: edited, actorRef: actor }));
  }
  const sendAt = tSend;
  await phase(p, sendAt, () => sendDraft(
    { draftId: draft!.id, revision: draft!.revision, idempotencyKey: `demo-send:${draft!.id}`, requestId: `demo-${draft!.id}`, actorRef: actor },
    { send: sendStub(env) },
  ));
  await fixSchedule(env.ctx, p.reply.recordId, sendAt);
}

/**
 * Work the record's sequence forward: each step that falls due before `until`
 * is drafted by the system and then sent or skipped by the rep. Stops (leaving
 * the record waiting) at the first step due after `until`.
 */
async function drive(env: Env, p: Plan, cursor: Cursor, from: Date, until: Date, actor: string | undefined, followIndex: { n: number }): Promise<Date> {
  let cur = from;
  for (let guard = 0; guard < 6; guard++) {
    const step = await openStep(p.reply.recordId);
    if (!step || step.position === 1) { await fixSchedule(env.ctx, p.reply.recordId, cur); return cur; }
    const due = new Date(cur.getTime() + step.delay * MINUTE);
    if (due.getTime() > until.getTime()) { await fixSchedule(env.ctx, p.reply.recordId, cur); return cur; }
    const action = p.follow[followIndex.n % p.follow.length];
    const editIt = p.edit[(followIndex.n + 1) % p.edit.length];
    const flaggedReview = p.reviewFollowUp && reviews.n < 3 && due.getTime() >= env.ctx.now.getTime() - 3.4 * DAY;
    followIndex.n++;
    const tDraft = cap(env, new Date(due.getTime() + Math.round((10 + cursor.next() * 50) * MINUTE)));
    if (action === "skip" && !flaggedReview) {
      const tSkip = cap(env, mono(tDraft, atWork(p, new Date(due.getTime() + (1 + cursor.next() * 8) * HOUR), cursor.next())));
      await phase(p, tSkip, () => skipCurrentSequenceStep({ recordId: p.reply.recordId, actorRef: actor }));
      await fixSchedule(env.ctx, p.reply.recordId, tSkip);
      cur = tSkip;
      continue;
    }
    const ok = await writeDraftNow(env, p, tDraft, null);
    if (!ok) return cur;
    if (flaggedReview) { reviews.n++; return tDraft; }
    const tEdit = editIt ? cap(env, mono(tDraft, atWork(p, new Date(tDraft.getTime() + humanDelay(cursor.next(), p) * MINUTE), cursor.next()))) : null;
    const tSend = cap(env, mono(tEdit ?? tDraft, atWork(p, new Date((tEdit ?? tDraft).getTime() + (editIt ? (p.age < 30 ? 1 : 2) + cursor.next() * (p.age < 30 ? 5 : 12) : humanDelay(cursor.next(), p)) * MINUTE), cursor.next())));
    await sendNow(env, p, tEdit, tSend, actor);
    cur = tSend;
  }
  return cur;
}

async function runRecord(env: Env, p: Plan): Promise<void> {
  const { ctx } = env;
  const recordId = p.reply.recordId;
  // The app's own routes record no actor reference (the history reads "Authenticated operator"); a user id would show as a raw uuid.
  const actor: string | undefined = undefined;
  const cursor = new Cursor(p.u);
  const intent = p.reply.intent;
  const reasons = REASONING[intent];
  const reasoning = reasons[p.variant % reasons.length];
  const job = { entityId: p.reply.messageId, payload: {} } as unknown as CrmJob;

  // 1. The AI reads the reply.
  const tClass = cap(env, new Date(p.reply.sentAt.getTime() + Math.round((1 + cursor.next() * (p.age < 30 ? 3 : 8)) * MINUTE)));
  let tNow = tClass;
  const wrongIntent = CONFUSED_WITH[intent];
  const aiIntent = p.cls.mode === "overridden" && wrongIntent ? wrongIntent : intent;
  const aiReasoning = p.cls.mode === "overridden"
    ? `Ambiguous: reads as ${aiIntent} but could also be ${intent}. Low confidence, flagged for review.`
    : p.cls.mode === "pending" && cursor.next() > 0.5
      ? `${reasoning} The wording is brief, so a person should confirm.`
      : reasoning;
  const confidence = intent === "Do Not Contact" ? 0.99 : p.cls.confidence;
  await phase(p, tClass, () => handleClassificationJob(job, { complete: classifier(env, p, aiIntent, confidence, aiReasoning) }));
  await fixSchedule(ctx, recordId, tClass);

  if (p.cls.mode === "pending") return; // waits in "Confirm classification"

  // 2. A person confirms or corrects it, when the AI was not sure.
  if (p.cls.mode === "accepted" || p.cls.mode === "overridden") {
    tNow = cap(env, mono(tClass, atWork(p, new Date(tClass.getTime() + (25 + cursor.next() * 300) * MINUTE), cursor.next())));
    const [classification] = await db.select({ id: crmClassifications.id }).from(crmClassifications)
      .where(eq(crmClassifications.crmRecordId, recordId)).orderBy(desc(crmClassifications.createdAt)).limit(1);
    const rec = await recordState(recordId);
    const target = env.subs.get(intent)!;
    await phase(p, tNow, () => applyHumanClassification({
      recordId, categoryKey: target.categoryKey, subcategoryId: target.id, expectedContextVersion: rec.contextVersion,
      classificationId: classification!.id,
      reason: p.cls.mode === "overridden" ? `Actually ${intent.toLowerCase()}: ${reasoning.charAt(0).toLowerCase()}${reasoning.slice(1)}` : undefined,
      actorRef: actor,
    }));
    await fixSchedule(ctx, recordId, tNow);
  }

  // 3. Records that need no answer.
  if (p.first === "closed") {
    const tClose = cap(env, mono(tNow, atWork(p, new Date(tNow.getTime() + (30 + cursor.next() * 600) * MINUTE), cursor.next())));
    const [classification] = await db.select({ id: crmClassifications.id }).from(crmClassifications)
      .where(eq(crmClassifications.crmRecordId, recordId)).orderBy(desc(crmClassifications.createdAt)).limit(1);
    if (classification) await phase(p, tClose, () => acknowledgeClassification({ classificationId: classification.id, actorRef: actor }));
    const reason = intent === "Do Not Contact" ? "Asked not to be contacted again" : "Left the company; no replacement named";
    await phase(p, new Date(tClose.getTime() + 30_000), () => closeCrmRecord({ recordId, reason, actorRef: actor }));
    return;
  }
  if (p.first === "skip") {
    // An auto-reply: nobody answers it. The follow-up waits for their return.
    const tSkip = cap(env, mono(tNow, atWork(p, new Date(tNow.getTime() + (40 + cursor.next() * 500) * MINUTE), cursor.next())));
    const [classification] = await db.select({ id: crmClassifications.id }).from(crmClassifications)
      .where(eq(crmClassifications.crmRecordId, recordId)).orderBy(desc(crmClassifications.createdAt)).limit(1);
    if (classification) await phase(p, tSkip, () => acknowledgeClassification({ classificationId: classification.id, actorRef: actor }));
    await phase(p, new Date(tSkip.getTime() + 20_000), () => skipCurrentSequenceStep({ recordId, actorRef: actor }));
    const tAfter = new Date(tSkip.getTime() + 20_000);
    await fixSchedule(ctx, recordId, tAfter);
    await drive(env, p, cursor, tAfter, new Date(ctx.now.getTime() - 20 * MINUTE), actor, { n: 0 });
    return;
  }

  // 4. The reply draft.
  const tDraft = cap(env, new Date(tNow.getTime() + Math.round((1 + cursor.next() * 3) * MINUTE)));
  const wrote = await writeDraftNow(env, p, tDraft, null);
  if (!wrote) throw new Error(`CRM outcomes: no draft for ${recordId} (${intent})`);
  if (p.first === "awaiting") return;

  let tSend: Date;
  if (p.first === "discarded") {
    const draft = await awaitingDraft(recordId);
    const tDiscard = cap(env, mono(tDraft, atWork(p, new Date(tDraft.getTime() + (30 + cursor.next() * 400) * MINUTE), cursor.next())));
    await phase(p, tDiscard, () => discardDraft({ draftId: draft!.id, actorRef: actor }));
    const tManual = cap(env, new Date(tDiscard.getTime() + (4 + cursor.next() * 12) * MINUTE));
    const bank = HANDWRITTEN[p.reply.channel as Chan];
    const manualBody = bank[p.variant % bank.length].replaceAll("{first}", p.person.firstName).replaceAll("{rep}", TEAM[p.reply.rep].first);
    const inbound = env.inbound.get(p.reply.messageId);
    const subject = p.reply.channel === "email" ? (inbound?.subject ? (/^re:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`) : `Re: Northwind Signal for ${p.person.company.name}`) : null;
    await phase(p, tManual, () => createManualDraft({ recordId, conversationId: p.reply.conversationId, subject, bodyText: manualBody }));
    await fixSchedule(ctx, recordId, tManual, tManual);
    tSend = cap(env, mono(tManual, new Date(tManual.getTime() + (3 + cursor.next() * 15) * MINUTE)));
    await sendNow(env, p, null, tSend, actor);
  } else {
    const tEdit = p.edit[0] ? cap(env, mono(tDraft, atWork(p, new Date(tDraft.getTime() + humanDelay(cursor.next(), p) * MINUTE), cursor.next()))) : null;
    tSend = cap(env, mono(tEdit ?? tDraft, atWork(p, new Date((tEdit ?? tDraft).getTime() + (p.edit[0] ? (p.age < 30 ? 1 : 2) + cursor.next() * (p.age < 30 ? 5 : 12) : humanDelay(cursor.next(), p)) * MINUTE), cursor.next())));
    await sendNow(env, p, tEdit, tSend, actor);
  }

  // 5. Follow-ups and stage moves, in order.
  let cur = tSend;
  const followIndex = { n: 0 };
  const finalUntil = new Date(ctx.now.getTime() - 20 * MINUTE);
  for (const [index, move] of p.stages.entries()) {
    const tMove = cap(env, atWork(p, new Date(p.reply.sentAt.getTime() + move.days * DAY + cursor.next() * 6 * HOUR), cursor.next()));
    if (tMove.getTime() <= cur.getTime()) continue;
    // A lead who booked a call is not chased before it: only later stages have follow-ups to work first.
    const booked = index === 0 && (move.to === "Meeting Done" || move.to === "Meeting No Show");
    if (!booked) cur = await drive(env, p, cursor, cur, new Date(tMove.getTime() - 2 * HOUR), actor, followIndex);
    const sub = env.subs.get(move.to)!;
    const rec = await recordState(recordId);
    const next = move.to === "Meeting Done" || move.to === "Meeting No Show" ? "reply" as const : "follow_up" as const;
    const occurredAt = new Date(tMove.getTime() - Math.round((20 + cursor.next() * 70) * MINUTE));
    await phase(p, tMove, () => moveRecordStage({
      recordId, categoryKey: sub.categoryKey, subcategoryId: sub.id, expectedContextVersion: rec.contextVersion,
      occurredAt, note: move.note, next, actorRef: actor,
    }));
    if (STAGES_WITHOUT_SEQUENCE.includes(move.to)) {
      // The new stage has no sequence, and the lib leaves the old run going when there is none to replace it.
      await phase(p, new Date(tMove.getTime() + 20_000), () => withCrmTransaction((tx) => interruptActiveSequenceRunInTransaction(tx, {
        recordId, reason: "stage_changed", contextVersion: rec.contextVersion + 1,
      })));
    }
    await fixSchedule(ctx, recordId, tMove);
    cur = tMove;
    followIndex.n = 0;
    if (next === "reply") {
      const tRecap = cap(env, new Date(tMove.getTime() + (3 + cursor.next() * 8) * MINUTE));
      const ok = await writeDraftNow(env, p, tRecap, null, move.to as "Meeting Done" | "Meeting No Show");
      if (!ok) continue;
      const tEdit = p.edit[2] ? cap(env, mono(tRecap, atWork(p, new Date(tRecap.getTime() + humanDelay(cursor.next(), p) * MINUTE), cursor.next()))) : null;
      const tSent = cap(env, mono(tEdit ?? tRecap, atWork(p, new Date((tEdit ?? tRecap).getTime() + (p.edit[2] ? (p.age < 30 ? 1 : 2) + cursor.next() * (p.age < 30 ? 5 : 12) : humanDelay(cursor.next(), p)) * MINUTE), cursor.next())));
      await sendNow(env, p, tEdit, tSent, actor);
      cur = tSent;
    }
  }
  await drive(env, p, cursor, cur, finalUntil, actor, followIndex);
}

// ===========================================================================
// Passes before and after
// ===========================================================================

/** Events and messages the channel modules wrote while ingesting replies carry the seed's wall-clock time; put them at the reply. */
async function fixIngestEvents(ctx: DemoContext): Promise<void> {
  const org = currentOrganizationId();
  const rows = await db.execute<{ id: string; crm_record_id: string; event_type: string; message_id: string | null }>(sql`
    SELECT e.id, e.crm_record_id, e.event_type, e.to_data->>'latestInboundMessageId' AS message_id
      FROM crm_events e
     WHERE e.organization_id = ${org} AND e.created_at >= ${ctx.now.toISOString()}::timestamptz
     ORDER BY e.crm_record_id, e.created_at,
       CASE e.event_type WHEN 'record.created' THEN 1 WHEN 'reply.received' THEN 2 ELSE 3 END, e.id`);
  // Messages too: the rows the channel modules just wrote carry the clock, and a
  // phase would take the freshest of them for its own.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      UPDATE crm_conversation_messages SET created_at = sent_at
       WHERE created_at > sent_at AND conversation_id IN (SELECT id FROM crm_conversations WHERE organization_id = ${org})`);
  });
  if (!rows.length) return;
  const msgs = await db.execute<{ id: string; record_id: string; sent_at: Date }>(sql`
    SELECT m.id, c.crm_record_id AS record_id, m.sent_at
      FROM crm_conversation_messages m JOIN crm_conversations c ON c.id = m.conversation_id
     WHERE c.organization_id = ${org} AND m.direction = 'inbound'`);
  const sentAt = new Map(msgs.map((m) => [m.id, new Date(m.sent_at)]));
  const first = new Map<string, Date>();
  for (const m of msgs) {
    const t = new Date(m.sent_at);
    const cur = first.get(m.record_id);
    if (!cur || t < cur) first.set(m.record_id, t);
  }
  // Records a call created have no inbound message; their history sits at the calls.
  const callOnly = await db.execute<{ id: string; created_at: Date; last_at: Date | null }>(sql`
    SELECT r.id, r.created_at, r.last_interaction_at AS last_at FROM crm_records r
     WHERE r.organization_id = ${org} AND NOT EXISTS (
       SELECT 1 FROM crm_conversation_messages m JOIN crm_conversations c ON c.id = m.conversation_id
        WHERE c.crm_record_id = r.id AND m.direction = 'inbound')`);
  const callAnchor = new Map(callOnly.map((r) => [r.id, { created: new Date(r.created_at), last: r.last_at ? new Date(r.last_at) : new Date(r.created_at) }]));
  const fixed: { id: string; at: Date }[] = [];
  const last = new Map<string, Date>();
  for (const r of rows) {
    let at: Date | undefined;
    if (r.event_type === "reply.received" && r.message_id) {
      const base = sentAt.get(r.message_id);
      if (base) at = new Date(base.getTime() + 1000);
    }
    const anchor = callAnchor.get(r.crm_record_id);
    if (!at && anchor) {
      const base = r.event_type === "record.created" ? anchor.created : new Date(anchor.last.getTime() + 4 * MINUTE);
      const prev = last.get(r.crm_record_id);
      at = prev && prev.getTime() >= base.getTime() ? new Date(prev.getTime() + 1000) : base;
    }
    if (!at && r.event_type === "record.created") at = first.get(r.crm_record_id);
    if (!at) {
      const prev = last.get(r.crm_record_id) ?? first.get(r.crm_record_id) ?? ctx.now;
      at = new Date(prev.getTime() + 1000);
    }
    last.set(r.crm_record_id, at);
    fixed.push({ id: r.id, at: new Date(Math.min(at.getTime(), ctx.now.getTime() - 60_000)) });
  }
  const values = sql.join(fixed.map((f) => sql`(${f.id}::uuid, ${f.at.toISOString()}::timestamptz)`), sql`, `);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`UPDATE crm_events e SET created_at = v.t FROM (VALUES ${values}) AS v(id, t) WHERE e.id = v.id`);
  });
}

async function backdateConfiguration(ctx: DemoContext): Promise<void> {
  const org = currentOrganizationId();
  const at = (days: number, hour = 14) => {
    const d = new Date(ctx.now.getTime() - days * DAY);
    d.setUTCHours(hour, 10 + Math.round(days) % 40, 0, 0);
    return d.toISOString();
  };
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    // The pipeline, its categories and settings came with the organization.
    await tx.execute(sql`UPDATE crm_pipelines SET created_at = ${at(118)}::timestamptz, updated_at = ${at(118)}::timestamptz WHERE organization_id = ${org}`);
    await tx.execute(sql`UPDATE crm_settings SET created_at = ${at(118)}::timestamptz WHERE pipeline_id IN (SELECT id FROM crm_pipelines WHERE organization_id = ${org})`);
    await tx.execute(sql`UPDATE crm_subcategories SET created_at = ${at(118)}::timestamptz, updated_at = ${at(118)}::timestamptz WHERE pipeline_id IN (SELECT id FROM crm_pipelines WHERE organization_id = ${org})`);
    await tx.execute(sql`UPDATE crm_settings SET updated_at = ${at(96)}::timestamptz WHERE pipeline_id IN (SELECT id FROM crm_pipelines WHERE organization_id = ${org})`);
    // Knowledge: written during the first weeks, in the order the files were created.
    const docs = await tx.execute<{ id: string }>(sql`SELECT id FROM crm_knowledge_documents WHERE organization_id = ${org} ORDER BY created_at, id`);
    for (const [i, doc] of docs.entries()) {
      const created = at(104 - i * 6);
      const updated = i % 2 === 0 ? at(70 - i * 5) : created;
      await tx.execute(sql`UPDATE crm_knowledge_documents SET created_at = ${created}::timestamptz, updated_at = ${updated}::timestamptz WHERE id = ${doc.id}`);
      await tx.execute(sql`UPDATE crm_knowledge_document_versions SET created_at = ${created}::timestamptz WHERE document_id = ${doc.id}`);
    }
    // Sequences: built in the first month, published the same day.
    const seqs = await tx.execute<{ id: string; draft_version_id: string }>(sql`SELECT id, draft_version_id FROM crm_sequences WHERE organization_id = ${org} ORDER BY created_at, id`);
    for (const [i, seq] of seqs.entries()) {
      const created = at(99 - i * 5);
      const published = new Date(new Date(created).getTime() + 26 * HOUR).toISOString();
      const edited = new Date(new Date(created).getTime() + (3 + i) * DAY).toISOString();
      await tx.execute(sql`UPDATE crm_sequences SET created_at = ${created}::timestamptz, updated_at = ${edited}::timestamptz WHERE id = ${seq.id}`);
      await tx.execute(sql`UPDATE crm_sequence_versions SET created_at = ${created}::timestamptz, updated_at = ${published}::timestamptz, published_at = CASE WHEN published_at IS NULL THEN NULL ELSE ${published}::timestamptz END WHERE sequence_id = ${seq.id}`);
      await tx.execute(sql`UPDATE crm_sequence_versions SET created_at = ${published}::timestamptz WHERE sequence_id = ${seq.id} AND status = 'draft'`);
      await tx.execute(sql`UPDATE crm_sequence_steps SET created_at = ${created}::timestamptz, updated_at = ${published}::timestamptz WHERE sequence_version_id IN (SELECT id FROM crm_sequence_versions WHERE sequence_id = ${seq.id})`);
      await tx.execute(sql`UPDATE crm_subcategory_sequence_assignments SET created_at = ${published}::timestamptz, updated_at = ${published}::timestamptz WHERE sequence_id = ${seq.id}`);
    }
  });
}

/** Whatever the lib stamped with the clock and no phase touched: line records and conversations up with their messages. */
async function finalPass(ctx: DemoContext): Promise<void> {
  const org = currentOrganizationId();
  const now = ctx.now.toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      UPDATE crm_conversation_messages SET created_at = sent_at
       WHERE created_at > sent_at AND conversation_id IN (SELECT id FROM crm_conversations WHERE organization_id = ${org})`);
    await tx.execute(sql`
      UPDATE crm_conversations c SET
        created_at = coalesce((SELECT min(m.sent_at) FROM crm_conversation_messages m WHERE m.conversation_id = c.id), c.created_at),
        updated_at = coalesce((SELECT max(m.sent_at) FROM crm_conversation_messages m WHERE m.conversation_id = c.id), c.updated_at)
       WHERE c.organization_id = ${org}`);
    await tx.execute(sql`
      UPDATE crm_records r SET
        created_at = coalesce((SELECT min(m.sent_at) FROM crm_conversation_messages m JOIN crm_conversations c ON c.id = m.conversation_id
                                WHERE c.crm_record_id = r.id AND m.direction = 'inbound'), r.created_at),
        last_interaction_at = greatest(r.last_inbound_at, r.last_outbound_at, r.last_interaction_at),
        updated_at = least(${now}::timestamptz - interval '1 minute', greatest(
          coalesce((SELECT max(e.created_at) FROM crm_events e WHERE e.crm_record_id = r.id), r.created_at),
          r.last_inbound_at, r.last_outbound_at))
       WHERE r.organization_id = ${org}`);
    // Inbound messages nobody classified (earlier messages of a thread, threads sorted by hand, call-created
    // records): the AI read them too, as the record stood, a few minutes after they arrived and before the
    // record's newest classification, so the record's current state is unchanged.
    await tx.execute(sql`
      INSERT INTO crm_classifications (crm_record_id, message_id, expected_context_version, previous_category_key,
        proposed_category_key, proposed_subcategory_id, applied_category_key, applied_subcategory_id, confidence, reasoning,
        status, provider, model, acknowledged_at, created_at, updated_at)
      SELECT r.id, m.id, 0, NULL,
             coalesce(r.category_key, 'other'), r.subcategory_id, coalesce(r.category_key, 'other'), r.subcategory_id,
             0.93, 'Consistent with the rest of the conversation.', 'auto_applied', 'anthropic', 'anthropic/claude-haiku-4.5',
             t.at + interval '40 minutes', t.at, t.at
        FROM crm_conversation_messages m
        JOIN crm_conversations c ON c.id = m.conversation_id AND c.organization_id = ${org}
        JOIN crm_records r ON r.id = c.crm_record_id
        CROSS JOIN LATERAL (SELECT least(
            m.sent_at + interval '4 minutes',
            coalesce((SELECT min(x.created_at) FROM crm_classifications x WHERE x.crm_record_id = r.id AND x.created_at > m.sent_at) - interval '1 minute', 'infinity'::timestamptz),
            ${now}::timestamptz - interval '2 minutes') AS at) t
       WHERE m.direction = 'inbound'
         AND NOT EXISTS (SELECT 1 FROM crm_classifications x WHERE x.message_id = m.id)
         AND t.at > m.sent_at`);
    // Nothing recorded may sit in the future (only schedules do).
    for (const table of ["crm_events", "crm_classifications", "crm_drafts", "crm_sequence_runs"]) {
      await tx.execute(sql`UPDATE ${sql.raw(table)} SET created_at = ${now}::timestamptz - interval '2 minutes' WHERE created_at > ${now}::timestamptz`);
    }
  });
}

// ===========================================================================
// Entry point
// ===========================================================================

export async function seedCrmOutcomes(ctx: DemoContext): Promise<void> {
  const people = new Map(ctx.people.map((person) => [person.id, person]));
  reviews.n = 0;
  const plans = buildPlans(ctx, ctx.replies, people);
  if (!plans.length) {
    await backdateConfiguration(ctx);
    return;
  }

  // Subcategories by name; the replies' text and subjects.
  const subRows = await db.select({ id: crmSubcategories.id, key: crmSubcategories.key, name: crmSubcategories.name, categoryKey: crmSubcategories.categoryKey })
    .from(crmSubcategories).where(eq(crmSubcategories.pipelineId, ctx.pipelineId));
  const subs: Env["subs"] = new Map(subRows.map((row) => [row.name, { id: row.id, key: row.key, categoryKey: row.categoryKey as "customer" | "interested" | "not_interested" | "other" }]));
  const messageRows = await db.select({ id: crmConversationMessages.id, subject: crmConversationMessages.subject, body: crmConversationMessages.bodyText })
    .from(crmConversationMessages).where(inArray(crmConversationMessages.id, plans.map((p) => p.reply.messageId)));
  const inbound = new Map(messageRows.map((row) => [row.id, { subject: row.subject, body: row.body }]));
  let counter = 0;
  const env: Env = {
    ctx, subs, inbound,
    hex: () => (++counter * 2654435761 >>> 0).toString(16).padStart(8, "0") + (counter * 40503 + 12345 >>> 0).toString(16).padStart(6, "0"),
  };

  await fixIngestEvents(ctx);
  for (const plan of plans) {
    try {
      await runRecord(env, plan);
    } catch (error) {
      throw new Error(`CRM outcomes failed on ${plan.reply.intent} / ${plan.reply.channel} (${plan.reply.recordId}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  await finalPass(ctx);
  await backdateConfiguration(ctx);

  const [totals] = await db.execute<Record<string, number>>(sql`
    SELECT
      (SELECT count(*) FROM crm_classifications c JOIN crm_records r ON r.id = c.crm_record_id WHERE r.organization_id = ${ctx.organizationId})::int AS classifications,
      (SELECT count(*) FROM crm_classifications c JOIN crm_records r ON r.id = c.crm_record_id WHERE r.organization_id = ${ctx.organizationId} AND c.status = 'proposed')::int AS proposed,
      (SELECT count(*) FROM crm_drafts d JOIN crm_records r ON r.id = d.crm_record_id WHERE r.organization_id = ${ctx.organizationId} AND d.status = 'sent')::int AS sent,
      (SELECT count(*) FROM crm_drafts d JOIN crm_records r ON r.id = d.crm_record_id WHERE r.organization_id = ${ctx.organizationId} AND d.status = 'awaiting_review')::int AS awaiting,
      (SELECT count(*) FROM crm_drafts d JOIN crm_records r ON r.id = d.crm_record_id WHERE r.organization_id = ${ctx.organizationId} AND d.status = 'discarded')::int AS discarded,
      (SELECT count(*) FROM crm_events WHERE organization_id = ${ctx.organizationId} AND event_type = 'stage.moved')::int AS moves,
      (SELECT count(*) FROM crm_records WHERE organization_id = ${ctx.organizationId} AND workflow_state = 'closed')::int AS closed`);
  count(ctx, "CRM records worked", plans.length);
  count(ctx, "CRM classifications", Number(totals?.classifications ?? 0));
  count(ctx, "CRM classifications waiting for review", Number(totals?.proposed ?? 0));
  count(ctx, "CRM drafts sent", Number(totals?.sent ?? 0));
  count(ctx, "CRM drafts awaiting review", Number(totals?.awaiting ?? 0));
  count(ctx, "CRM drafts discarded", Number(totals?.discarded ?? 0));
  count(ctx, "CRM stage moves", Number(totals?.moves ?? 0));
  count(ctx, "CRM records closed", Number(totals?.closed ?? 0));
}
