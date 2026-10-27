import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emailOutreachRowToMessageInput,

  type EmailOutreachRow,

} from "./outreachHistory";

function emailRow(overrides: Partial<EmailOutreachRow> = {}): EmailOutreachRow {
  return {
    id: "email-1",
    subject: "Quick question",
    body: "Hi there, wanted to reach out.",
    messageId: "<rfc-1@example.test>",
    sentAt: new Date("2026-09-01T09:00:00.000Z"),
    stepNumber: 1,
    campaignId: "campaign-1",
    ...overrides,
  };
}

describe("emailOutreachRowToMessageInput", () => {
  it("maps a sent plain-text email to an outbound message", () => {
    const input = emailOutreachRowToMessageInput(emailRow());
    assert.ok(input);
    assert.equal(input.direction, "outbound");
    assert.equal(input.idempotencyKey, "outreach-email:email-1");
    assert.equal(input.providerMessageId, "<rfc-1@example.test>");
    assert.equal(input.subject, "Quick question");
    assert.equal(input.bodyText, "Hi there, wanted to reach out.");
    assert.equal(input.bodyHtml, null);
    assert.deepEqual(input.raw, {
      source: "outreach_emails",
      id: "email-1",
      step: 1,
      campaignId: "campaign-1",
    });
    assert.equal(input.sentAt.toISOString(), "2026-09-01T09:00:00.000Z");
  });

  it("converts an HTML body to plain text and keeps the original HTML", () => {
    const html = "<p>Hi <b>there</b>,</p><p>wanted to reach out.</p>";
    const input = emailOutreachRowToMessageInput(emailRow({ body: html }));
    assert.ok(input);
    assert.equal(input.bodyText, "Hi there,\nwanted to reach out.");
    assert.equal(input.bodyHtml, html);
  });

  it("skips a row whose body is empty after trimming", () => {
    assert.equal(emailOutreachRowToMessageInput(emailRow({ body: "   " })), null);
    assert.equal(emailOutreachRowToMessageInput(emailRow({ body: null })), null);
    assert.equal(emailOutreachRowToMessageInput(emailRow({ body: "<p></p>" })), null);
  });

  it("skips a row with no sentAt (not actually sent)", () => {
    assert.equal(emailOutreachRowToMessageInput(emailRow({ sentAt: null })), null);
  });
});

