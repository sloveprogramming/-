import "server-only";

import { timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { personCompanyName } from "@/lib/leads/companyName";
import { getPlatformCredentials } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { callSessions, callingProxies, callingStations } from "./schema";
import { requireProxy, workerProxy } from "./proxies";
import { deleteObject, headRecording, presignRecordingDownload, presignRecordingUpload, stationProfileKey } from "./storage";
import { normalizePhone } from "@/lib/phone";
import { CallApiError, finishCall, recorderLeadFor } from "./sessions";
import { createRecorderToken } from "./token";
import {
  STATION_LAUNCHERS,
  usesGoLogin,
  MAX_TIMELINE_ENTRIES,
  type CallTimelineEntry,
  type CallingStation,
  type CloudCallPhase,
  type CreateStationRequest,
  type StationLauncher,
  type UpdateStationRequest,
  type WorkerCallStatus,
  type WorkerClaimRequest,
  type WorkerJob,
  type WorkerProfileCommitRequest,
  type WorkerProfileCommitResponse,
  type WorkerProfileUploadResponse,
  type WorkerStation,
  type WorkerStationStateRequest,
} from "./stationContract";
import { MAX_AGENT_BRIEF_CHARS, TERMINAL_CALL_STATUSES, type RecorderCallPhase } from "./contract";

/**
 * Cloud calling stations: WhatsApp numbers whose WhatsApp Web runs in a remote
 * browser that the call worker (services/call-worker) opens for each job.
 * The app manages them in its organization's scope; the worker's API is
 * platform-wide — it claims across organizations, like the grid worker, and
 * runs each job's reads in the organization the station belongs to.
 *
 * A cloud call is a call_sessions row with mode "agent_cloud" and a station.
 * It waits unclaimed (status pending, claimed_at null) until a worker that can
 * open its station's launcher claims it; the claim mints the recorder token
 * the extension in that browser will report with. One call at a time per
 * station: the claim locks the station row and skips stations already on a
 * call.
 */

type StationRow = typeof callingStations.$inferSelect;
type CallSessionRow = typeof callSessions.$inferSelect;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** A link attempt whose worker has said nothing for this long is offered to another worker. */
const LINK_STALE_MS = 5 * 60 * 1000;
/** Cloud calls nobody claimed in this long are failed rather than placed hours late. */
export const CLOUD_UNCLAIMED_EXPIRES_MS = 15 * 60 * 1000;
/** A claimed cloud call still open after this long lost its worker (the worker gives a call 30 minutes). */
export const CLOUD_CLAIMED_EXPIRES_MS = 45 * 60 * 1000;
const OPEN_STATUSES = ["pending", "in_progress"] as const;

// --- the app's view -------------------------------------------------------------

export function toCallingStation(row: StationRow, busyCallId: string | null, proxyLabel: string | null = null): CallingStation {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    launcher: row.launcher,
    gologinProfileId: row.gologinProfileId,
    status: row.status,
    busyCallId,
    link: row.linkRequestedAt
      ? {
          requestedAt: row.linkRequestedAt.toISOString(),
          code: row.linkCode,
          screenshot: row.linkScreenshot,
          updatedAt: row.linkUpdatedAt ? row.linkUpdatedAt.toISOString() : null,
        }
      : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    lastCallAt: row.lastCallAt ? row.lastCallAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    proxyId: row.proxyId,
    proxyLabel: row.proxyId ? proxyLabel : null,
    profile: {
      version: row.profileVersion,
      bytes: row.profileBytes,
      savedAt: row.profileSavedAt ? row.profileSavedAt.toISOString() : null,
    },
    linkedPhone: row.linkedPhone,
  };
}

/** WhatsApp Web is logged in as another account than the number says: its calls would go out from that one. */
export function wrongAccountError(row: Pick<StationRow, "phone" | "linkedPhone">): string | null {
  if (!row.linkedPhone || row.linkedPhone === row.phone) return null;
  return `WhatsApp Web is logged in as ${row.linkedPhone}, not ${row.phone} — unlink it on that phone (Linked devices) and link ${row.phone}, or change this number to ${row.linkedPhone}`;
}

/** The open, claimed cloud call on each of `stationIds`. */
async function busyCalls(stationIds: string[]): Promise<Map<string, string>> {
  if (stationIds.length === 0) return new Map();
  const rows = await db
    .select({ id: callSessions.id, stationId: callSessions.stationId })
    .from(callSessions)
    .where(
      and(
        inOrg(callSessions),
        eq(callSessions.mode, "agent_cloud"),
        inArray(callSessions.stationId, stationIds),
        inArray(callSessions.status, [...OPEN_STATUSES]),
        isNotNull(callSessions.claimedAt),
      ),
    );
  return new Map(rows.flatMap((row) => (row.stationId ? [[row.stationId, row.id] as const] : [])));
}

export async function listStations(): Promise<CallingStation[]> {
  const rows = await db
    .select({ station: callingStations, proxyLabel: callingProxies.label })
    .from(callingStations)
    .leftJoin(callingProxies, and(eq(callingProxies.id, callingStations.proxyId), inOrg(callingProxies)))
    .where(inOrg(callingStations))
    .orderBy(asc(callingStations.createdAt));
  const busy = await busyCalls(rows.map((row) => row.station.id));
  return rows.map((row) => toCallingStation(row.station, busy.get(row.station.id) ?? null, row.proxyLabel));
}

async function requireStation(id: string): Promise<StationRow> {
  if (!UUID_PATTERN.test(id)) throw new CallApiError(404, "Calling number not found");
  const [row] = await db.select().from(callingStations).where(and(inOrg(callingStations), eq(callingStations.id, id))).limit(1);
  if (!row) throw new CallApiError(404, "Calling number not found");
  return row;
}

async function stationView(row: StationRow): Promise<CallingStation> {
  const proxy = row.proxyId ? await requireProxy(row.proxyId).catch(() => null) : null;
  return toCallingStation(row, (await busyCalls([row.id])).get(row.id) ?? null, proxy?.label ?? null);
}

function parseProxyId(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new CallApiError(400, "proxyId must be an IP's id");
  return value;
}

/** A proxy given to `stationId` must be this organization's and not another number's. */
async function assertProxyFree(proxyId: string, stationId: string | null): Promise<void> {
  await requireProxy(proxyId);
  const [holder] = await db
    .select({ id: callingStations.id, name: callingStations.name })
    .from(callingStations)
    .where(and(inOrg(callingStations), eq(callingStations.proxyId, proxyId)))
    .limit(1);
  if (holder && holder.id !== stationId) throw new CallApiError(409, `${holder.name} already uses this IP — one number per IP`);
}

function parseLauncher(value: unknown): StationLauncher {
  if (typeof value === "string" && (STATION_LAUNCHERS as readonly string[]).includes(value)) return value as StationLauncher;
  throw new CallApiError(400, `launcher must be one of ${STATION_LAUNCHERS.join(", ")}`);
}

function parseName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new CallApiError(400, "Give the number a name");
  if (name.length > 80) throw new CallApiError(400, "The name is over 80 characters");
  return name;
}

function parseProfileId(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 100) throw new CallApiError(400, "gologinProfileId must be a GoLogin profile id");
  return value.trim();
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CallApiError(400, "Expected a JSON object");
  return value as Record<string, unknown>;
}

export function parseCreateStationRequest(value: unknown): CreateStationRequest {
  const body = asObject(value);
  const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : null;
  if (!phone) throw new CallApiError(400, "Enter the number with its country code, e.g. +91…");
  return {
    name: parseName(body.name),
    phone,
    launcher: parseLauncher(body.launcher),
    gologinProfileId: parseProfileId(body.gologinProfileId),
    proxyId: parseProxyId(body.proxyId),
  };
}

export function parseUpdateStationRequest(value: unknown): UpdateStationRequest {
  const body = asObject(value);
  const update: UpdateStationRequest = {};
  if (body.name !== undefined) update.name = parseName(body.name);
  if (body.phone !== undefined) {
    const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : null;
    if (!phone) throw new CallApiError(400, "Enter the number with its country code, e.g. +91…");
    update.phone = phone;
  }
  if (body.launcher !== undefined) update.launcher = parseLauncher(body.launcher);
  if (body.gologinProfileId !== undefined) update.gologinProfileId = parseProfileId(body.gologinProfileId);
  if (body.proxyId !== undefined) update.proxyId = parseProxyId(body.proxyId);
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "paused") throw new CallApiError(400, "status can only be set to active or paused");
    update.status = body.status;
  }
  return update;
}

export async function createStation(input: CreateStationRequest): Promise<CallingStation> {
  if (usesGoLogin(input.launcher) && !input.gologinProfileId) {
    throw new CallApiError(400, "A GoLogin number needs its GoLogin profile id");
  }
  const [existing] = await db
    .select({ id: callingStations.id })
    .from(callingStations)
    .where(and(inOrg(callingStations), eq(callingStations.phone, input.phone)))
    .limit(1);
  if (existing) throw new CallApiError(409, "That number is already a calling number");
  if (input.proxyId) await assertProxyFree(input.proxyId, null);
  const [row] = await db
    .insert(callingStations)
    .values({
      organizationId: currentOrganizationId(),
      name: input.name,
      phone: input.phone,
      launcher: input.launcher,
      gologinProfileId: input.gologinProfileId ?? null,
      proxyId: input.proxyId ?? null,
    })
    .returning();
  if (!row) throw new Error("calling_stations insert did not return a row");
  return stationView(row);
}

export async function updateStation(id: string, input: UpdateStationRequest): Promise<CallingStation> {
  const current = await requireStation(id);
  const launcher = input.launcher ?? current.launcher;
  const profileId = input.gologinProfileId !== undefined ? input.gologinProfileId : current.gologinProfileId;
  if (usesGoLogin(launcher) && !profileId) throw new CallApiError(400, "A GoLogin number needs its GoLogin profile id");
  if (input.status === "active" && current.status === "banned") throw new CallApiError(409, "A banned number can't be resumed");
  if (input.proxyId) await assertProxyFree(input.proxyId, id);
  const renumbered = input.phone !== undefined && input.phone !== current.phone;
  if (renumbered) {
    if ((await busyCalls([id])).size > 0) throw new CallApiError(409, "This number is on a call — wait for it to end");
    const [other] = await db
      .select({ name: callingStations.name })
      .from(callingStations)
      .where(and(inOrg(callingStations), eq(callingStations.phone, input.phone!), ne(callingStations.id, id)))
      .limit(1);
    if (other) throw new CallApiError(409, `${other.name} already has ${input.phone}`);
  }
  // A new number that matches the logged-in account clears the wrong-account warning.
  const fixesWrongAccount = renumbered && wrongAccountError(current) !== null && wrongAccountError({ phone: input.phone!, linkedPhone: current.linkedPhone }) === null;
  const [row] = await db
    .update(callingStations)
    .set({ ...input, ...(fixesWrongAccount ? { lastError: null } : {}), updatedAt: new Date() })
    .where(and(inOrg(callingStations), eq(callingStations.id, id)))
    .returning();
  return stationView(row ?? current);
}

export async function deleteStation(id: string): Promise<void> {
  await requireStation(id);
  const busy = await busyCalls([id]);
  if (busy.size > 0) throw new CallApiError(409, "This number is on a call — wait for it to end");
  await db.delete(callingStations).where(and(inOrg(callingStations), eq(callingStations.id, id)));
}

/** The operator wants WhatsApp Web linked: the next free worker opens its login screen. */
export async function requestLink(id: string, fresh = false): Promise<CallingStation> {
  const current = await requireStation(id);
  if (current.status === "banned") throw new CallApiError(409, "A banned number can't be linked");
  const [row] = await db
    .update(callingStations)
    .set({
      linkRequestedAt: new Date(),
      linkFresh: fresh,
      // A fresh link forgets the wrong account; the worker reads the new one.
      ...(fresh ? { linkedPhone: null } : {}),
      linkCode: null,
      linkScreenshot: null,
      linkUpdatedAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(inOrg(callingStations), eq(callingStations.id, id)))
    .returning();
  return stationView(row ?? current);
}

export async function cancelLink(id: string): Promise<CallingStation> {
  const current = await requireStation(id);
  const [row] = await db
    .update(callingStations)
    .set({ linkRequestedAt: null, linkFresh: false, linkCode: null, linkScreenshot: null, linkUpdatedAt: null, updatedAt: new Date() })
    .where(and(inOrg(callingStations), eq(callingStations.id, id)))
    .returning();
  return stationView(row ?? current);
}

// --- queueing a cloud call (from startCall) ---------------------------------------

/**
 * The station a cloud call goes out from: the one asked for, or the active
 * station that has gone longest without a call. Checked here, in the rep's
 * request, so a misconfigured number fails at the click rather than later.
 */
export async function stationForCloudCall(stationId: string | null | undefined, brief: string | null | undefined): Promise<{ station: StationRow; brief: string }> {
  const trimmed = brief?.trim() ?? "";
  if (!trimmed) throw new CallApiError(400, "The AI agent needs a brief");
  if (trimmed.length > MAX_AGENT_BRIEF_CHARS) throw new CallApiError(400, `The brief is over ${MAX_AGENT_BRIEF_CHARS} characters`);

  let station: StationRow | undefined;
  if (stationId) {
    station = await requireStation(stationId);
    if (station.status !== "active") throw new CallApiError(409, `${station.name} isn't active (${station.status.replace("_", " ")})`);
    const wrongAccount = wrongAccountError(station);
    if (wrongAccount) throw new CallApiError(409, `${station.name}: ${wrongAccount}`);
  } else {
    [station] = await db
      .select()
      .from(callingStations)
      .where(
        and(
          inOrg(callingStations),
          eq(callingStations.status, "active"),
          or(isNull(callingStations.linkedPhone), eq(callingStations.linkedPhone, callingStations.phone)),
        ),
      )
      .orderBy(sql`${callingStations.lastCallAt} asc nulls first`)
      .limit(1);
    if (!station) throw new CallApiError(409, "No active cloud calling number — add one in Settings → WhatsApp → Calling numbers");
  }
  if (usesGoLogin(station.launcher) && !(await getPlatformCredentials("gologin"))) {
    throw new CallApiError(409, "Connect GoLogin in Settings → WhatsApp → Integrations to call from this number");
  }
  return { station, brief: trimmed };
}

export const QUEUED_PHASE: CloudCallPhase = { kind: "queued" };

// --- cloud calls that never finish ----------------------------------------------

/**
 * Closes cloud calls nobody will finish: never claimed (no worker can open
 * the station) or claimed by a worker that stopped reporting. Run in the
 * organization's scope, with the other stale-call sweeps.
 */
export async function expireStaleCloudCalls(): Promise<CallSessionRow[]> {
  const now = new Date();
  const [unclaimed, lost] = await Promise.all([
    db
      .update(callSessions)
      .set({
        status: "failed",
        error: "No call worker picked this call up within 15 minutes — is one running for this number?",
        livePhase: { kind: "error", message: "No call worker picked this call up", savedLocally: false },
        updatedAt: now,
      })
      .where(
        and(
          inOrg(callSessions),
          eq(callSessions.mode, "agent_cloud"),
          eq(callSessions.status, "pending"),
          isNull(callSessions.claimedAt),
          lt(callSessions.createdAt, new Date(now.getTime() - CLOUD_UNCLAIMED_EXPIRES_MS)),
        ),
      )
      .returning(),
    db
      .update(callSessions)
      .set({
        status: "failed",
        error: "The call worker stopped reporting on this call",
        livePhase: { kind: "error", message: "The call worker stopped reporting", savedLocally: false },
        updatedAt: now,
      })
      .where(
        and(
          inOrg(callSessions),
          eq(callSessions.mode, "agent_cloud"),
          inArray(callSessions.status, [...OPEN_STATUSES]),
          lt(callSessions.claimedAt, new Date(now.getTime() - CLOUD_CLAIMED_EXPIRES_MS)),
        ),
      )
      .returning(),
  ]);
  return [...unclaimed, ...lost];
}

// --- the worker's API ---------------------------------------------------------------

/** Constant-time check of the worker's bearer token against CALL_WORKER_SECRET. */
export function authorizeWorker(request: Request): void {
  const secret = process.env.CALL_WORKER_SECRET?.trim();
  if (!secret) throw new CallApiError(503, "Cloud calling is not set up on this server (CALL_WORKER_SECRET is missing)");
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/.exec(header)?.[1]?.trim() ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CallApiError(401, "Invalid worker token");
}

export function parseWorkerClaimRequest(value: unknown): WorkerClaimRequest {
  const body = asObject(value);
  const workerId = typeof body.workerId === "string" && body.workerId.trim() ? body.workerId.trim().slice(0, 100) : null;
  if (!workerId) throw new CallApiError(400, "workerId is required");
  if (!Array.isArray(body.launchers) || body.launchers.length === 0) throw new CallApiError(400, "launchers is required");
  return { workerId, launchers: body.launchers.map(parseLauncher) };
}

async function workerStation(row: StationRow): Promise<WorkerStation> {
  return runInOrganization(row.organizationId, async () => {
    const gologin = usesGoLogin(row.launcher) ? await getPlatformCredentials("gologin") : null;
    const proxy = row.proxyId ? await requireProxy(row.proxyId).catch(() => null) : null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      phone: row.phone,
      launcher: row.launcher,
      gologinProfileId: row.gologinProfileId,
      gologinToken: gologin?.apiToken ?? null,
      proxy: proxy ? workerProxy(proxy) : null,
      fingerprintSeed: row.fingerprintSeed,
      profile: {
        version: row.profileVersion,
        downloadUrl: row.profileKey ? await presignRecordingDownload(row.profileKey) : null,
      },
    };
  });
}

/**
 * The next job for a worker: a queued cloud call on a free station it can
 * open, else a station waiting to be linked. Global (no organization scope),
 * like the grid worker's claim; each job names its organization.
 */
export async function claimWorkerJob(input: WorkerClaimRequest): Promise<WorkerJob | null> {
  return (await claimCall(input)) ?? (await claimLink(input));
}

/** A station is free when no claimed cloud call on it is still open. */
const stationIsFree = sql`NOT EXISTS (
  SELECT 1 FROM call_sessions busy
   WHERE busy.station_id = ${callingStations.id}
     AND busy.mode = 'agent_cloud'
     AND busy.claimed_at IS NOT NULL
     AND busy.status IN ('pending', 'in_progress'))`;

async function claimCall({ workerId, launchers }: WorkerClaimRequest): Promise<WorkerJob | null> {
  const claimed = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ call: callSessions, station: callingStations })
      .from(callSessions)
      .innerJoin(
        callingStations,
        and(eq(callingStations.id, callSessions.stationId), eq(callingStations.organizationId, callSessions.organizationId)),
      )
      .where(
        and(
          eq(callSessions.mode, "agent_cloud"),
          eq(callSessions.status, "pending"),
          isNull(callSessions.claimedAt),
          eq(callingStations.status, "active"),
          inArray(callingStations.launcher, launchers),
          // Never call from a number whose WhatsApp Web is another account.
          or(isNull(callingStations.linkedPhone), eq(callingStations.linkedPhone, callingStations.phone)),
          stationIsFree,
        ),
      )
      .orderBy(asc(callSessions.createdAt))
      .limit(1)
      .for("update", { of: [callSessions, callingStations], skipLocked: true });
    if (!locked) return null;

    const now = new Date();
    const { token, hash } = createRecorderToken();
    const startingPhase: CloudCallPhase = { kind: "starting-browser" };
    await tx
      .update(callSessions)
      .set({
        claimedAt: now,
        claimedBy: workerId,
        uploadTokenHash: hash,
        tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
        livePhase: startingPhase,
        updatedAt: now,
      })
      .where(eq(callSessions.id, locked.call.id));
    await tx
      .update(callingStations)
      .set({ workerId, lastCallAt: now, updatedAt: now })
      .where(eq(callingStations.id, locked.station.id));
    return { ...locked, token };
  });
  if (!claimed) return null;

  const { call, station, token } = claimed;
  const lead = await runInOrganization(call.organizationId, async () => {
    const [found] = await db
      .select({ person: people, companyName: companies.name })
      .from(people)
      .leftJoin(companies, eq(people.companyId, companies.id))
      .where(and(inOrg(people), eq(people.id, call.personId)))
      .limit(1);
    return found ? recorderLeadFor(found.person, personCompanyName(found.person.raw, found.companyName)) : null;
  });
  return {
    kind: "call",
    station: await workerStation(station),
    call: { id: call.id, phone: call.phone, recorderToken: token, lead, brief: call.agentBrief ?? "" },
  };
}

async function claimLink({ workerId, launchers }: WorkerClaimRequest): Promise<WorkerJob | null> {
  const station = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(callingStations)
      .where(
        and(
          isNotNull(callingStations.linkRequestedAt),
          ne(callingStations.status, "banned"),
          inArray(callingStations.launcher, launchers),
          or(isNull(callingStations.linkUpdatedAt), lt(callingStations.linkUpdatedAt, new Date(Date.now() - LINK_STALE_MS))),
          stationIsFree,
        ),
      )
      .orderBy(asc(callingStations.linkRequestedAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!locked) return null;
    await tx
      .update(callingStations)
      .set({ workerId, linkUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(callingStations.id, locked.id));
    return locked;
  });
  return station ? { kind: "link", station: await workerStation(station), fresh: station.linkFresh } : null;
}

async function workerStationRow(id: string): Promise<StationRow> {
  if (!UUID_PATTERN.test(id)) throw new CallApiError(404, "Calling number not found");
  // Deliberately unscoped: the worker serves every organization, and the
  // station row is how it names one.
  const [row] = await db.select().from(callingStations).where(eq(callingStations.id, id)).limit(1);
  if (!row) throw new CallApiError(404, "Calling number not found");
  return row;
}

export function parseWorkerStationStateRequest(value: unknown): WorkerStationStateRequest {
  const body = asObject(value);
  const state: WorkerStationStateRequest = {};
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "logged_out") throw new CallApiError(400, "status must be active or logged_out");
    state.status = body.status;
  }
  if (body.link !== undefined) {
    if (body.link === null) state.link = null;
    else {
      const link = asObject(body.link);
      const code = typeof link.code === "string" ? link.code.slice(0, 20) : null;
      const screenshot =
        typeof link.screenshot === "string" && /^data:image\/(png|jpeg);base64,/.test(link.screenshot) && link.screenshot.length < 2_000_000
          ? link.screenshot
          : null;
      state.link = { code, screenshot };
    }
  }
  if (body.linkDone !== undefined) state.linkDone = body.linkDone === true;
  if (body.error !== undefined) state.error = typeof body.error === "string" ? body.error.slice(0, 500) : null;
  if (body.linkedPhone !== undefined) {
    state.linkedPhone = body.linkedPhone === null ? null : typeof body.linkedPhone === "string" ? normalizePhone(body.linkedPhone) : null;
  }
  return state;
}

export async function reportStationState(id: string, state: WorkerStationStateRequest): Promise<void> {
  const row = await workerStationRow(id);
  const now = new Date();
  const set: Partial<StationRow> = { lastSeenAt: now, updatedAt: now };
  if (state.status === "logged_out") set.status = row.status === "banned" ? "banned" : "logged_out";
  // Logged in again: back to active, unless the operator paused it (or it is banned).
  if (state.status === "active" && row.status !== "paused" && row.status !== "banned") set.status = "active";
  if (state.link !== undefined) {
    set.linkCode = state.link?.code ?? null;
    set.linkScreenshot = state.link?.screenshot ?? null;
    set.linkUpdatedAt = now;
  }
  if (state.linkDone) {
    set.linkRequestedAt = null;
    set.linkFresh = false;
    set.linkCode = null;
    set.linkScreenshot = null;
    set.linkUpdatedAt = null;
  }
  if (state.error !== undefined) set.lastError = state.error;
  else if (state.status === "active") set.lastError = null;
  if (state.linkedPhone !== undefined) {
    set.linkedPhone = state.linkedPhone;
    // The wrong account is the error that matters most: it stays on the card until fixed.
    const wrongAccount = wrongAccountError({ phone: row.phone, linkedPhone: state.linkedPhone });
    if (wrongAccount) set.lastError = wrongAccount;
  }
  await db.update(callingStations).set(set).where(eq(callingStations.id, row.id));
}

async function workerCallRow(id: string): Promise<CallSessionRow> {
  if (!UUID_PATTERN.test(id)) throw new CallApiError(404, "Call not found");
  // Deliberately unscoped, like workerStationRow; only cloud calls are the worker's.
  const [row] = await db
    .select()
    .from(callSessions)
    .where(and(eq(callSessions.id, id), eq(callSessions.mode, "agent_cloud")))
    .limit(1);
  if (!row) throw new CallApiError(404, "Call not found");
  return row;
}

export async function workerCallStatus(id: string): Promise<WorkerCallStatus> {
  const row = await workerCallRow(id);
  return { status: row.status, done: (TERMINAL_CALL_STATUSES as readonly string[]).includes(row.status) };
}

/** The worker could not run the call (logged out, browser failed): it is failed, through the usual finish path. */
export async function releaseCall(id: string, error: string): Promise<void> {
  const row = await workerCallRow(id);
  await runInOrganization(row.organizationId, async () => {
    const message = error.trim().slice(0, 500) || "The call worker could not place the call";
    await db
      .update(callSessions)
      .set({ livePhase: { kind: "error", message, savedLocally: false }, updatedAt: new Date() })
      .where(and(inOrg(callSessions), eq(callSessions.id, row.id)));
    await finishCall(row, { outcome: "failed", error: message });
  });
}

/** POST /api/call-worker/calls/:id/timeline — the worker's record of the call's timed steps. */
export function parseTimelineRequest(value: unknown): CallTimelineEntry[] {
  const body = asObject(value);
  if (!Array.isArray(body.entries)) throw new CallApiError(400, "entries must be a list");
  if (body.entries.length > MAX_TIMELINE_ENTRIES) throw new CallApiError(400, `At most ${MAX_TIMELINE_ENTRIES} timeline entries`);
  return body.entries.map((entry: unknown) => {
    const e = asObject(entry);
    if (typeof e.at !== "number" || !Number.isFinite(e.at)) throw new CallApiError(400, "Each entry needs a numeric `at`");
    if (e.source !== "worker" && e.source !== "extension") throw new CallApiError(400, "source must be worker or extension");
    if (typeof e.text !== "string") throw new CallApiError(400, "Each entry needs `text`");
    return { at: Math.round(e.at), source: e.source, text: e.text.slice(0, 400) };
  });
}

export async function saveCallTimeline(id: string, entries: CallTimelineEntry[]): Promise<void> {
  const row = await workerCallRow(id);
  await runInOrganization(row.organizationId, async () => {
    await db
      .update(callSessions)
      .set({ timeline: entries, updatedAt: new Date() })
      .where(and(inOrg(callSessions), eq(callSessions.id, row.id)));
  });
}

// --- the extension's phase reports (station mode) -----------------------------------

export function parsePhaseRequest(value: unknown): RecorderCallPhase {
  const body = asObject(value);
  const phase = body.phase;
  if (!phase || typeof phase !== "object" || typeof (phase as { kind?: unknown }).kind !== "string") {
    throw new CallApiError(400, "phase must be a call phase");
  }
  // Stored as given for the rep's page to show; it is the extension's own shape and size-bounded.
  if (JSON.stringify(phase).length > 2_000) throw new CallApiError(400, "phase is too large");
  return phase as RecorderCallPhase;
}

/** POST /api/call-recorder/calls/:id/phase — run inside withRecorderScope. */
export async function recordPhase(row: CallSessionRow, phase: RecorderCallPhase): Promise<void> {
  if (row.mode !== "agent_cloud") return;
  await db
    .update(callSessions)
    .set({ livePhase: phase, updatedAt: new Date() })
    .where(and(inOrg(callSessions), eq(callSessions.id, row.id)));
}

// --- saved browser profiles (CloakBrowser) ---------------------------------------
// A number's browser profile — WhatsApp Web's login and storage — is packed
// by the worker after each job and kept in the organization's R2 bucket, one
// object per save; the row holds which object is current and its version.
// The worker downloads it before opening the browser (workerStation's
// downloadUrl), so the number's state does not depend on one worker's disk.

/** A profile bigger than this is refused: WhatsApp Web's data is tens of MB, not gigabytes. */
const MAX_PROFILE_BYTES = 500 * 1024 * 1024;
const PROFILE_CONTENT_TYPE = "application/gzip";

export async function profileUploadUrl(stationId: string, bytes: unknown): Promise<WorkerProfileUploadResponse> {
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) throw new CallApiError(400, "bytes must be a positive integer");
  if (bytes > MAX_PROFILE_BYTES) throw new CallApiError(413, `The profile is ${Math.round(bytes / 1e6)} MB — over the ${MAX_PROFILE_BYTES / 1e6} MB limit`);
  const row = await workerStationRow(stationId);
  return runInOrganization(row.organizationId, async () => {
    const key = stationProfileKey(row.id, row.profileVersion + 1, crypto.randomUUID().slice(0, 8));
    const { url, headers } = await presignRecordingUpload(key, PROFILE_CONTENT_TYPE);
    return { url, headers, key };
  });
}

export function parseProfileCommitRequest(value: unknown): WorkerProfileCommitRequest {
  const body = asObject(value);
  if (typeof body.key !== "string" || typeof body.bytes !== "number" || typeof body.baseVersion !== "number") {
    throw new CallApiError(400, "key, bytes and baseVersion are required");
  }
  return { key: body.key, bytes: body.bytes, baseVersion: body.baseVersion };
}

/**
 * Makes an uploaded profile the number's current one — only if no other save
 * landed since the worker downloaded `baseVersion`, so a stale worker never
 * overwrites a newer profile. The replaced object is deleted.
 */
export async function commitProfile(stationId: string, input: WorkerProfileCommitRequest): Promise<WorkerProfileCommitResponse> {
  const row = await workerStationRow(stationId);
  if (!input.key.startsWith(`calling-profiles/${row.id}/`)) throw new CallApiError(400, "That upload is not this number's");
  return runInOrganization(row.organizationId, async () => {
    const head = await headRecording(input.key);
    if (!head) throw new CallApiError(409, "The profile upload was not found");
    const [updated] = await db
      .update(callingStations)
      .set({
        profileKey: input.key,
        profileBytes: head.bytes,
        profileVersion: sql`${callingStations.profileVersion} + 1`,
        profileSavedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(inOrg(callingStations), eq(callingStations.id, row.id), eq(callingStations.profileVersion, input.baseVersion)))
      .returning({ version: callingStations.profileVersion });
    if (!updated) {
      await deleteObject(input.key).catch(() => {});
      throw new CallApiError(409, "A newer profile was saved for this number since this one was opened");
    }
    if (row.profileKey && row.profileKey !== input.key) await deleteObject(row.profileKey).catch(() => {});
    return { version: updated.version };
  });
}
