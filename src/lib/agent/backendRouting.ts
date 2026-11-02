import "server-only";

const DEFAULT_PYTHON_TIMEOUT_MS = 90_000;

type EnvMap = Readonly<Record<string, string | undefined>>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ProspectBackendConfig =
  | { kind: "ts" }
  | { kind: "python"; baseUrl: string; token: string };

export type ProspectBackendConfigErrorCode =
  | "INVALID_PROSPECT_BACKEND"
  | "PYTHON_BACKEND_NOT_CONFIGURED"
  | "INVALID_PYTHON_BACKEND_URL";

/** A server configuration error that callers can map to a non-retryable 503. */
export class ProspectBackendConfigError extends Error {
  constructor(
    readonly code: ProspectBackendConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProspectBackendConfigError";
  }
}

/**
 * Pick the prospect implementation from server-only environment variables.
 *
 * The default stays `ts`. An explicit `python` selection fails closed when its
 * URL or token is missing, rather than silently serving the legacy pipeline
 * while operators believe the cutover succeeded.
 */
export function resolveProspectBackendConfig(env: EnvMap = process.env): ProspectBackendConfig {
  const selected = (env.PROSPECT_BACKEND ?? "").trim().toLowerCase();
  if (!selected || selected === "ts") return { kind: "ts" };
  if (selected !== "python") {
    throw new ProspectBackendConfigError(
      "INVALID_PROSPECT_BACKEND",
      "PROSPECT_BACKEND 只支持 ts 或 python",
    );
  }

  const rawUrl = (env.PYTHON_BACKEND_URL ?? "").trim();
  const token = (env.AGENT_BACKEND_TOKEN ?? "").trim();
  if (!rawUrl || !token) {
    throw new ProspectBackendConfigError(
      "PYTHON_BACKEND_NOT_CONFIGURED",
      "Python 后端已启用，但 PYTHON_BACKEND_URL 或 AGENT_BACKEND_TOKEN 未配置",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProspectBackendConfigError(
      "INVALID_PYTHON_BACKEND_URL",
      "PYTHON_BACKEND_URL 必须是合法的 http(s) 地址",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new ProspectBackendConfigError(
      "INVALID_PYTHON_BACKEND_URL",
      "PYTHON_BACKEND_URL 必须是合法的 http(s) 地址",
    );
  }

  return {
    kind: "python",
    baseUrl: parsed.toString().replace(/\/+$/, ""),
    token,
  };
}

export type PythonProspectSuccess = {
  ok: true;
  payload: Record<string, unknown>;
};

export type PythonProspectFailure = {
  ok: false;
  status: 502 | 504;
  code: string;
  message: string;
};

export type PythonProspectResult = PythonProspectSuccess | PythonProspectFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate just enough of the Python response that a malformed upstream cannot
 * crash the browser while rendering. The detailed business contract remains in
 * backend/tests/test_api.py.
 */
function isProspectPayload(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.ok !== true) return false;
  if (typeof value.traceId !== "string" || typeof value.summary !== "string") return false;
  if (typeof value.product !== "string" || !isRecord(value.intent) || !isRecord(value.stats)) return false;
  if (!Array.isArray(value.companies)) return false;
  return value.companies.every((company) => {
    if (!isRecord(company) || !isRecord(company.hit)) return false;
    return (
      typeof company.hit.key === "string"
      && typeof company.hit.name === "string"
      && typeof company.score === "number"
      && typeof company.reachable === "boolean"
      && Array.isArray(company.phones)
      && Array.isArray(company.dimensions)
      && Array.isArray(company.caveats)
    );
  });
}

/**
 * Forward one prospect request to FastAPI from the server only.
 *
 * The browser calls the existing Next.js route; the internal bearer token and
 * resolved organization never leave this process. Returned upstream error
 * bodies are deliberately discarded so a misconfiguration cannot leak them.
 */
export async function callPythonProspect(
  input: {
    baseUrl: string;
    token: string;
    product: string;
    organizationId: string;
    userName: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<PythonProspectResult> {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${input.token}`,
    "Content-Type": "application/json",
    "X-Organization-Id": input.organizationId,
  });
  const userName = input.userName.trim();
  if (userName) {
    // HTTP header values cannot safely carry every Unicode user name. Python
    // decodes this percent-encoded value before building the call script.
    headers.set("X-User-Name-Encoded", encodeURIComponent(userName));
  }

  let response: Response;
  try {
    response = await fetchImpl(`${input.baseUrl}/api/prospect/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ product: input.product }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_PYTHON_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        status: 504,
        code: "PYTHON_BACKEND_TIMEOUT",
        message: "Python 后端响应超时，请稍后重试",
      };
    }
    return {
      ok: false,
      status: 502,
      code: "PYTHON_BACKEND_UNAVAILABLE",
      message: "无法连接 Python 后端",
    };
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 502,
        code: "PYTHON_BACKEND_AUTH_FAILED",
        message: "Python 后端鉴权失败，请检查 AGENT_BACKEND_TOKEN 配置",
      };
    }
    if (response.status === 504) {
      return {
        ok: false,
        status: 504,
        code: "PYTHON_BACKEND_TIMEOUT",
        message: "Python 后端响应超时，请稍后重试",
      };
    }
    return {
      ok: false,
      status: 502,
      code: "PYTHON_BACKEND_REJECTED",
      message: "Python 后端未能完成本次拓客",
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: 502,
      code: "PYTHON_BACKEND_INVALID_RESPONSE",
      message: "Python 后端返回了无法识别的结果",
    };
  }
  if (!isProspectPayload(payload)) {
    return {
      ok: false,
      status: 502,
      code: "PYTHON_BACKEND_INVALID_RESPONSE",
      message: "Python 后端返回了无法识别的结果",
    };
  }

  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings
      .filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
      .map((warning) => warning.trim())
    : [];
  return { ok: true, payload: { ...payload, warnings } };
}
