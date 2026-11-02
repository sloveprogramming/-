import { describe, expect, test } from "bun:test";

import {
  callPythonProspect,
  ProspectBackendConfigError,
  resolveProspectBackendConfig,
} from "./backendRouting";

const PYTHON_ENV = {
  PROSPECT_BACKEND: "python",
  PYTHON_BACKEND_URL: "http://127.0.0.1:8000/",
  AGENT_BACKEND_TOKEN: "internal-token",
};

const VALID_PAYLOAD = {
  ok: true,
  traceId: "trace-1",
  summary: "搜到 0 家公司",
  product: "面包丝",
  intent: { query: "面包丝" },
  stats: { searchedTerms: 1, found: 0, reachable: 0, priority: 0 },
  replan: null,
  companies: [],
  warnings: [" 搜索降级：当前只在本地线索库里搜索。 ", "", 42],
};

describe("prospect backend routing", () => {
  test("defaults to the TypeScript backend", () => {
    expect(resolveProspectBackendConfig({})).toEqual({ kind: "ts" });
    expect(resolveProspectBackendConfig({ PROSPECT_BACKEND: " TS " })).toEqual({ kind: "ts" });
  });

  test("selects Python only from server-side variables", () => {
    expect(resolveProspectBackendConfig(PYTHON_ENV)).toEqual({
      kind: "python",
      baseUrl: "http://127.0.0.1:8000",
      token: "internal-token",
    });
  });

  test("does not read a public switch", () => {
    expect(resolveProspectBackendConfig({
      NEXT_PUBLIC_PROSPECT_BACKEND: "python",
      NEXT_PUBLIC_PYTHON_BACKEND_URL: "http://127.0.0.1:8000",
      NEXT_PUBLIC_AGENT_BACKEND_TOKEN: "leaked",
    })).toEqual({ kind: "ts" });
  });

  test("fails closed instead of silently falling back when Python is incomplete", () => {
    expect(() => resolveProspectBackendConfig({
      ...PYTHON_ENV,
      PYTHON_BACKEND_URL: "",
    })).toThrow(ProspectBackendConfigError);
    expect(() => resolveProspectBackendConfig({
      ...PYTHON_ENV,
      AGENT_BACKEND_TOKEN: "",
    })).toThrow(ProspectBackendConfigError);
  });

  test("rejects an unsupported backend or unsafe URL", () => {
    expect(() => resolveProspectBackendConfig({
      ...PYTHON_ENV,
      PROSPECT_BACKEND: "pyhton",
    })).toThrow(/只支持 ts 或 python/);
    expect(() => resolveProspectBackendConfig({
      ...PYTHON_ENV,
      PYTHON_BACKEND_URL: "file:///tmp/backend",
    })).toThrow(/http\(s\)/);
    expect(() => resolveProspectBackendConfig({
      ...PYTHON_ENV,
      PYTHON_BACKEND_URL: "http://127.0.0.1:8000?token=leak",
    })).toThrow(/http\(s\)/);
  });
});

describe("Python prospect proxy", () => {
  test("forwards tenant and encoded user name without exposing the token", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const result = await callPythonProspect({
      baseUrl: "http://127.0.0.1:8000",
      token: "internal-token",
      product: "面包丝",
      organizationId: "00000000-0000-4000-8000-000000000001",
      userName: "张三",
    }, async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return Response.json(VALID_PAYLOAD);
    });

    expect(result.ok).toBe(true);
    expect(seenUrl).toBe("http://127.0.0.1:8000/api/prospect/run");
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer internal-token");
    expect(headers.get("x-organization-id")).toBe("00000000-0000-4000-8000-000000000001");
    expect(headers.get("x-user-name-encoded")).toBe("%E5%BC%A0%E4%B8%89");
    expect(seenInit?.body).toBe(JSON.stringify({ product: "面包丝" }));

    if (result.ok) {
      expect(result.payload.warnings).toEqual(["搜索降级：当前只在本地线索库里搜索。"]);
    }
  });

  test("does not forward an upstream error body", async () => {
    const result = await callPythonProspect({
      baseUrl: "http://127.0.0.1:8000",
      token: "wrong-token",
      product: "面包丝",
      organizationId: "00000000-0000-4000-8000-000000000001",
      userName: "张三",
    }, async () => new Response("upstream secret details", { status: 401 }));

    expect(result).toEqual({
      ok: false,
      status: 502,
      code: "PYTHON_BACKEND_AUTH_FAILED",
      message: "Python 后端鉴权失败，请检查 AGENT_BACKEND_TOKEN 配置",
    });
  });

  test("maps an upstream timeout to 504", async () => {
    const result = await callPythonProspect({
      baseUrl: "http://127.0.0.1:8000",
      token: "internal-token",
      product: "面包丝",
      organizationId: "00000000-0000-4000-8000-000000000001",
      userName: "",
    }, async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    });

    expect(result).toMatchObject({ ok: false, status: 504, code: "PYTHON_BACKEND_TIMEOUT" });
  });

  test("rejects a malformed success response", async () => {
    const result = await callPythonProspect({
      baseUrl: "http://127.0.0.1:8000",
      token: "internal-token",
      product: "面包丝",
      organizationId: "00000000-0000-4000-8000-000000000001",
      userName: "",
    }, async () => Response.json({ ok: true, companies: "not-an-array" }));

    expect(result).toMatchObject({ ok: false, status: 502, code: "PYTHON_BACKEND_INVALID_RESPONSE" });
  });
});
