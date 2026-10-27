import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { outreachCampaigns, outreachLeads, suppressionList } from "@/lib/outreach/schema";
import { getPeopleByIds, withLeadTransaction } from "./records";
import { inOrg } from "@/lib/tenancy/scope";

export type AssignmentResult = {
  requested: number;
  added: number;
  skippedMissingIdentity: number;
  skippedDuplicate: number;
  skippedSuppressed: number;
};

export async function addPeopleToEmailCampaign(campaignId: string, personIds: string[]): Promise<AssignmentResult> {
  const uniqueIds = [...new Set(personIds.map((id) => id.trim()).filter(Boolean))];
  return withLeadTransaction(async (tx) => {
    const [campaign] = await tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, campaignId))).limit(1);
    if (!campaign) throw new Error("Email campaign not found");

    if (!uniqueIds.length) {
      return { requested: 0, added: 0, skippedMissingIdentity: 0, skippedDuplicate: 0, skippedSuppressed: 0 };
    }

    const rows = await getPeopleByIds(tx, uniqueIds);
    const emails = rows.flatMap(({ person }) => (person.email ? [person.email] : []));
    const [existingRows, suppressedRows] = await Promise.all([
      tx.select({ personId: outreachLeads.personId }).from(outreachLeads).where(and(eq(outreachLeads.campaignId, campaignId), inArray(outreachLeads.personId, uniqueIds))),
      emails.length
        ? tx.select({ email: suppressionList.email }).from(suppressionList).where(and(inOrg(suppressionList), inArray(suppressionList.email, emails)))
        : [],
    ]);
    const existing = new Set(existingRows.map((row) => row.personId));
    const suppressed = new Set(suppressedRows.map((row) => row.email.toLowerCase()));
    const result: AssignmentResult = { requested: uniqueIds.length, added: 0, skippedMissingIdentity: 0, skippedDuplicate: 0, skippedSuppressed: 0 };

    for (const { person } of rows) {
      if (!person.email) {
        result.skippedMissingIdentity += 1;
        continue;
      }
      if (suppressed.has(person.email)) {
        result.skippedSuppressed += 1;
        continue;
      }
      if (existing.has(person.id)) {
        result.skippedDuplicate += 1;
        continue;
      }
      await tx.insert(outreachLeads).values({ personId: person.id, campaignId, sequenceStatus: "pending" });
      existing.add(person.id);
      result.added += 1;
    }
    result.skippedMissingIdentity += uniqueIds.length - rows.length;
    return result;
  });
}
