/**
 * Provider profiles(Phase 1 M4,开发方案 v2 §6):产品级模板 providers/<id>.json ← 用户覆盖 <data_root>/providers/<id>.json。
 * 只含环境变量名与契约元数据,永不含密钥;映射到 Codex 的 model_provider / model_providers.<id> 配置(经 SDK config 覆盖注入,不碰 ~/.codex)。
 */
import fs from "node:fs";
import path from "node:path";

import AjvModule from "ajv";
import { NOFOLLOW_FLAG } from "./fsutil.ts";

// 不 import schemas.ts:config.ts → providers.ts → schemas.ts → config.ts 会成环(模块求值期 STAGES 未定义);这里直接用 Ajv
const AjvCtor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (o: object) => { compile: (s: object) => unknown };
const ajv = new AjvCtor({ allErrors: true, strict: false });
let compiled: ((x: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null } | null = null;
function validateWith(_name: string, schema: unknown, data: unknown): string[] {
  if (!compiled) compiled = ajv.compile(schema as object) as never;
  const ok = compiled!(data);
  return ok ? [] : (compiled!.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
}

export interface ProviderProfileFile {
  id: string;
  name: string;
  wire_api: "responses" | "chat";
  base_url: string | null;
  env_key: string;
  auth_modes: ("chatgpt_login" | "api_key")[];
  requires_openai_auth: boolean;
  default_model: string | null;
  responses_support: "native" | "gateway" | "none";
  stream_format?: string;
  tool_calls?: boolean;
  reasoning?: string;
  context_limit_tokens?: number | null;
  retryable_errors?: string[];
  known_incompatibilities?: string[];
  query_params?: Record<string, string>;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  request_max_retries?: number;
  stream_max_retries?: number;
  stream_idle_timeout_ms?: number;
  matrix?: { status: string; note?: string; last_run?: string; results?: Record<string, string> };
  /**
   * 这家支持哪种"强制结构化产出"。缺省 = `json_schema`(OpenAI 的做法)。
   * `prompt` = 它的 Responses 端点**不认 `text.format.type=json_schema`**,只能把 schema 写进提示词。
   * 实测:小米 MiMo 返回 `responses_feature_not_supported:only 'text' and 'json_object' are allowed`。
   */
  structured_output?: "json_schema" | "prompt";
  /** 模板里易变的供应商信息(default_model / context_limit_tokens)最近一次人工核实日期;null = 未核实 */
  verified_at?: string | null;
}

export const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_KEY_RE = "^[A-Z][A-Z0-9_]*$";
const FORBIDDEN_ENV = ["PATH", "HOME", "USER", "SHELL", "CODEX_HOME", "TMPDIR", "LANG", "TERM"];

export const providerProfileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "wire_api", "base_url", "env_key", "auth_modes", "requires_openai_auth", "default_model", "responses_support"],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" }, name: { type: "string", minLength: 1 }, wire_api: { type: "string", enum: ["responses", "chat"] },
    base_url: { type: ["string", "null"], pattern: "^https?://[^\\s]+$" }, env_key: { type: "string", pattern: ENV_KEY_RE, not: { enum: FORBIDDEN_ENV } },
    auth_modes: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ["chatgpt_login", "api_key"] } }, requires_openai_auth: { type: "boolean" }, default_model: { type: ["string", "null"] },
    responses_support: { type: "string", enum: ["native", "gateway", "none"] }, stream_format: { type: "string" }, tool_calls: { type: "boolean" }, reasoning: { type: "string" }, context_limit_tokens: { type: ["integer", "null"], minimum: 1 },
    retryable_errors: { type: "array", items: { type: "string" } }, known_incompatibilities: { type: "array", items: { type: "string" } },
    query_params: { type: "object", additionalProperties: { type: "string" } }, http_headers: { type: "object", additionalProperties: { type: "string" } }, env_http_headers: { type: "object", additionalProperties: { type: "string", pattern: ENV_KEY_RE, not: { enum: FORBIDDEN_ENV } } },
    request_max_retries: { type: "integer", minimum: 0 }, stream_max_retries: { type: "integer", minimum: 0 }, stream_idle_timeout_ms: { type: "integer", minimum: 1000 },
    matrix: { type: "object", additionalProperties: false, properties: { status: { type: "string" }, note: { type: "string" }, last_run: { type: "string" }, results: { type: "object", additionalProperties: { type: "string" } } } },
    structured_output: { type: "string", enum: ["json_schema", "prompt"] },
    verified_at: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  },
} as const;

export type StructuredOutputMode = "json_schema" | "prompt";

/** 这家支持哪种强制结构化产出。没声明 = `json_schema`(OpenAI 的做法,也是引擎的默认路径) */
export function structuredOutputMode(prof?: ProviderProfileFile | null): StructuredOutputMode {
  return prof?.structured_output ?? "json_schema";
}

/**
 * 按 provider 的能力决定 schema 走哪条路。
 *
 * 🔴 为什么可以降级到提示词而不算放松要求:**`outputSchema` 从来就不是校验边界**
 *    (`ingest.ts` 的注释早就写着这句)。它是给模型的约束,产物合不合规是我们自己校验的
 *    (阶段产物过 validator、导入草稿过 parseOutput)。⇒ 降级损失的是**命中率**不是**正确性**:
 *    模型少了一层硬约束,可能更容易写歪、重试次数上升,但写歪了照样过不了我们这关。
 *
 * ⚠️ 所以这条降级**不能**顺手把校验也一起省掉 —— 那才是真放松。
 */
export function withOutputSchema(
  prompt: string,
  schema: unknown,
  mode: StructuredOutputMode,
): { prompt: string; outputSchema?: unknown } {
  if (schema === undefined || schema === null) return { prompt };
  if (mode === "json_schema") return { prompt, outputSchema: schema };
  return {
    prompt:
      `${prompt}\n\n---\n\n` +
      "**最终回复必须是一个 JSON 对象,且只有这个 JSON —— 不要代码围栏、不要任何解释文字。**\n" +
      "它必须符合下面这份 JSON Schema(你所在的通道不支持由服务端强制 schema,所以这里靠你自己遵守):\n" +
      "```json\n" +
      `${JSON.stringify(schema, null, 2)}\n` +
      "```",
  };
}

const SECRET_LIKE = /(sk-[A-Za-z0-9]{8,}|Bearer\s+\S{8,}|[A-Za-z0-9_-]{32,})/;

export function validateProfile(p: unknown, label: string): ProviderProfileFile {
  const errs = validateWith("provider-profile", providerProfileSchema, p);
  if (errs.length) throw new Error(`${label} 不符合 provider profile schema:${errs.slice(0, 5).join("; ")}`);
  const prof = p as ProviderProfileFile;
  // 密钥不得写进 profile:http_headers 值 / query_params 值若像 token 直接拒绝(密钥只走 env_key / env_http_headers)
  for (const [k, v] of Object.entries({ ...(prof.http_headers ?? {}), ...(prof.query_params ?? {}) })) {
    if (SECRET_LIKE.test(v) || /key|token|secret|password/i.test(k) && v.length > 8) throw new Error(`${label}:${k} 看起来含密钥值;密钥只能通过环境变量(env_key / env_http_headers)提供`);
  }
  if (prof.id !== "openai" && prof.requires_openai_auth) throw new Error(`${label}:非 openai provider 不得 requires_openai_auth=true(会要求 OpenAI 登录)`);
  if (prof.id === "openai" && prof.base_url !== null) throw new Error(`${label}:openai 模板的 base_url 必须为 null(官方端点);第三方网关请用独立 id`);
  // 组合约束(单字段合法 ≠ 契约自洽)
  if (prof.id !== "openai") {
    // Codex 对空 base_url 会回退到 api.openai.com/v1(codex-rs/model-provider-info/src/lib.rs to_api_provider),第三方密钥会发到错误主机 → 必须显式 https
    if (!prof.base_url) throw new Error(`${label}:非 openai provider 必须显式给出 https base_url(空值会让 Codex 回退到 OpenAI 官方端点)`);
    // 模板里有需要用户替换的占位(如百炼的 {WorkspaceId})。没换就直接发请求,会得到一个看不懂的 404/401
    const ph = /[{<]([A-Za-z_][A-Za-z0-9_]*)[}>]/.exec(prof.base_url);
    if (ph)
      throw new Error(
        `${label}:base_url 里还有没替换的占位符 ${ph[0]},模板不能直接用。` +
          `请把这份模板复制到 <数据根>/providers/${prof.id}.json,把 ${ph[0]} 换成你自己的值,再选用 ${prof.id}。`,
      );
    if (prof.auth_modes.some((m) => m !== "api_key")) throw new Error(`${label}:非 openai provider 只能 auth_modes=["api_key"](chatgpt_login 是 OpenAI 登录态)`);
  }
  // 🔴 **引擎已彻底移除 chat 协议**:codex-rs/model-provider-info/src/lib.rs:56 里有硬报错
  //    `wire_api = "chat" is no longer supported`(实测 0.149.0 仍在)。
  //    以前不拦是因为契约层"理论上允许" —— 结果是配置能存下、能加载,**跑到引擎深处才炸**,
  //    错误还出现在一个跟 provider 配置八竿子打不着的地方。⇒ 在这里就说清楚。
  //    枚举里保留 "chat" 是为了**读得懂旧档并给出解释**,不是为了放行。
  if (prof.wire_api === "chat") {
    throw new Error(
      `${label}:引擎不再支持 wire_api="chat"(codex-rs 硬报错)。` +
        "改法:① 该厂商若已提供 OpenAI 兼容的 Responses 端点,就把 wire_api 改成 responses、base_url 指到它;" +
        "② 否则要在中间架一个把 Responses 翻成 Chat Completions 的网关,再把 base_url 指向网关(responses_support=gateway)。",
    );
  }
  // responses_support 与 wire_api 双向自洽:native ⇒ responses;responses ⇒ native|gateway(none 矛盾)
  // ⚠️ 上面那条 chat 硬拒之后,wire_api 只剩 "responses" 一个取值 ⇒ **本行现在够不到**(测不出来,别假装它被覆盖了)。
  //    留着是因为 wire_api 枚举日后若加第三个取值,这条就是那时该有的守卫。
  if (prof.responses_support === "native" && prof.wire_api !== "responses") throw new Error(`${label}:responses_support=native 要求 wire_api=responses`);
  if (prof.wire_api === "responses" && prof.responses_support === "none") throw new Error(`${label}:wire_api=responses 要求 responses_support=native|gateway(none 矛盾)`);
  // env_http_headers 引用的变量不得是 FORBIDDEN_ENV(HOME/PATH 等),且不得与 env_key 重名以外的"像密钥"的名字混淆——值会作为 HTTP 头发给 provider
  for (const [h, v] of Object.entries(prof.env_http_headers ?? {})) if (FORBIDDEN_ENV.includes(v)) throw new Error(`${label}:env_http_headers.${h} 引用了受保护环境变量 ${v}`);
  return prof;
}

export function providersDirs(repoRoot: string, dataRoot: string): { product: string; user: string } {
  return { product: path.join(repoRoot, "providers"), user: path.join(dataRoot, "providers") };
}

/** openai 原生的内置模板:产品 providers/openai.json 缺失时(假仓库 / 测试 / 精简部署)仍能工作 */
export const BUILTIN_OPENAI_PROFILE: ProviderProfileFile = { id: "openai", name: "OpenAI(原生 Responses)", wire_api: "responses", base_url: null, env_key: "OPENAI_API_KEY", auth_modes: ["chatgpt_login", "api_key"], requires_openai_auth: true, default_model: null, responses_support: "native", matrix: { status: "baseline" } };

/** 读 profile:用户覆盖优先(整份替换),否则产品模板;openai 无文件 → 内置默认;其它不存在 → 抛错列出可用 id */
/** 读 providers 目录里的一份模板:目录不得是符号链接、realpath 必须落在根(仓库根 / 数据根)之内,最终文件 O_NOFOLLOW 打开;不存在 → null */
function readProfileJson(dir: string, id: string, root: string, label: string): unknown | null {
  const f = path.join(dir, `${id}.json`);
  if (!fs.existsSync(f) || !fs.lstatSync(f).isFile()) return null;
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${label} 目录 ${dir} 是符号链接,拒绝读取`);
  const realDir = fs.realpathSync(dir), realRoot = fs.realpathSync(root);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw new Error(`${label} 目录 ${dir} 解析到根目录之外(${realDir}),拒绝读取`);
  const fd = fs.openSync(f, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
  try { return JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
}

/**
 * 读一份 provider 档案。
 *
 * `baseUrlOverride`:**在校验之前**替换 base_url。
 * 🔴 顺序是承重的 —— 带占位符的模板（如百炼的 `{WorkspaceId}`）会被 `validateProfile` 拒掉，
 *    先校验再替换的话，用户明明在界面上填了自己的网关地址，仍然会被告知"模板不能直接用"。
 */
export function loadProviderProfile(
  repoRoot: string, dataRoot: string, id: string, baseUrlOverride?: string,
): { profile: ProviderProfileFile; source: string } {
  if (!PROVIDER_ID_RE.test(id)) throw new Error(`非法 provider id ${JSON.stringify(id)}`);
  const { product, user } = providersDirs(repoRoot, dataRoot);
  for (const [dir, root, label] of [[user, dataRoot, "用户 provider"], [product, repoRoot, "产品 provider"]] as const) {
    const raw0 = readProfileJson(dir, id, root, label);
    const raw = raw0 !== null && baseUrlOverride
      ? { ...(raw0 as Record<string, unknown>), base_url: baseUrlOverride }
      : raw0;
    if (raw !== null) {
      const f = path.join(dir, `${id}.json`);
      const prof = validateProfile(raw, `${label} ${f}`);
      if (prof.id !== id) throw new Error(`${label} ${f} 的 id=${prof.id} 与文件名不符`);
      return { profile: prof, source: f };
    }
  }
  if (id === "openai") return { profile: BUILTIN_OPENAI_PROFILE, source: "builtin" };
  throw new Error(`未知 provider ${id};可用:${[...new Set(["openai", ...listProviderIds(repoRoot, dataRoot)])].join(", ")}`);
}

/** 目录是否可安全枚举:存在、非符号链接、realpath 落在根之内(与 readProfileJson 同口径) */
function safeDir(dir: string, root: string): boolean {
  if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return false;
  const realDir = fs.realpathSync(dir), realRoot = fs.realpathSync(root);
  return realDir === realRoot || realDir.startsWith(realRoot + path.sep);
}

export function listProviderIds(repoRoot: string, dataRoot: string): string[] {
  const { product, user } = providersDirs(repoRoot, dataRoot);
  const ids = new Set<string>();
  for (const [dir, root] of [[product, repoRoot], [user, dataRoot]] as const)
    if (safeDir(dir, root)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".json") && PROVIDER_ID_RE.test(f.slice(0, -5))) ids.add(f.slice(0, -5));
  return [...ids].sort();
}

/** Codex 配置覆盖:model_provider = id + model_providers.<id> = {...}(openai 原生不注入,沿用引擎默认) */
export function codexProviderConfig(prof: ProviderProfileFile): Record<string, unknown> {
  if (prof.id === "openai") return {};
  const mp: Record<string, unknown> = { name: prof.name, base_url: prof.base_url, env_key: prof.env_key, wire_api: prof.wire_api, requires_openai_auth: false };
  for (const k of ["query_params", "http_headers", "env_http_headers", "request_max_retries", "stream_max_retries", "stream_idle_timeout_ms"] as const) if (prof[k] !== undefined) mp[k] = prof[k];
  return { model_provider: prof.id, model_providers: { [prof.id]: mp } };
}

export type AuthMode = "chatgpt_login" | "api_key";

/** 认证方式枚举校验:CLI / 环境变量 / 配置进来的字符串都必须过这一关(乱值不得静默落入任一分支) */
export function assertAuth(v: unknown, label: string): AuthMode {
  if (v === "chatgpt_login" || v === "api_key") return v;
  throw new Error(`${label} 只能是 chatgpt_login 或 api_key,收到 ${JSON.stringify(v)}`);
}

/** provider 进程环境:env_key 的值(与 env_http_headers 引用的变量)按名透传;缺失 → 抛错(密钥只从环境变量读) */
export function providerEnv(prof: ProviderProfileFile, auth: AuthMode, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  assertAuth(auth, "auth");
  const out: Record<string, string> = {};
  if (auth === "api_key") {
    const v = env[prof.env_key];
    if (!v) throw new Error(`provider ${prof.id} 需要环境变量 ${prof.env_key}(密钥只从环境变量读,不进配置文件)`);
    out[prof.env_key] = v;
    if (prof.id === "openai") out.CODEX_API_KEY = v;  // 原生 OpenAI 走 Codex 的 CODEX_API_KEY
  } else if (!prof.auth_modes.includes("chatgpt_login")) {
    throw new Error(`provider ${prof.id} 不支持 chatgpt_login,只能 auth=api_key`);
  }
  for (const v of Object.values(prof.env_http_headers ?? {})) if (env[v]) out[v] = env[v] as string;
  return out;
}
