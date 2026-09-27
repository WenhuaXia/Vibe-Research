import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveRuntimeProvider, RuntimeProviderError, templateIds, isCliProvider } from "../src/runtime_provider.ts";

import "../src/finance/register.ts";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA = path.join(REPO, ".local");
const BASE_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

const code = (fn: () => unknown): string => {
  try { fn(); return "(没抛)"; } catch (e) { return e instanceof RuntimeProviderError ? e.code : `(不是 RuntimeProviderError:${e})`; }
};

test("runtime provider:三种订阅各走自己的真实 runtime,未知 cli-* 报错", () => {
  const ok = resolveRuntimeProvider(REPO, DATA, { provider: "cli-codex" }, BASE_ENV);
  assert.equal(ok.runtime, "codex");
  if (ok.runtime !== "codex") assert.fail("Codex 订阅应走 Codex runtime");
  assert.equal(ok.auth, "chatgpt_login");
  assert.equal(ok.profile.id, "openai");
  assert.equal(ok.env, BASE_ENV, "订阅档不该往 env 里塞任何东西");

  const claude = resolveRuntimeProvider(REPO, DATA, { provider: "cli-claude" }, BASE_ENV);
  assert.deepEqual(claude, { runtime: "local-agent", agent: "claude", model: null, env: BASE_ENV });
  const codebuddy = resolveRuntimeProvider(REPO, DATA, { provider: "cli-codebuddy" }, BASE_ENV);
  assert.deepEqual(codebuddy, { runtime: "local-agent", agent: "codebuddy", model: null, env: BASE_ENV });
  // 没有安全禁工具适配器的 CLI 不得回落到 Codex。
  for (const p of ["cli-qwen", "cli-deepseek", "cli-anything"]) {
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: p }, BASE_ENV)), "unsupported_cli", p);
  }
  assert.ok(isCliProvider("cli-x") && !isCliProvider("deepseek"));
});

test("runtime provider:实测模板按模板自己的 env_key 注入 key,默认模型来自模板", () => {
  const r = resolveRuntimeProvider(REPO, DATA, { provider: "deepseek", apiKey: "sk-secret-abc" }, BASE_ENV);
  assert.equal(r.runtime, "codex");
  if (r.runtime !== "codex") assert.fail("API provider 应走 Codex runtime");
  assert.equal(r.profile.id, "deepseek");
  assert.equal(r.auth, "api_key");
  // 🔴 用固定变量名的话,模板里 env_http_headers 引用的变量就对不上 —— 必须按模板声明的名字
  assert.equal(r.env[r.profile.env_key], "sk-secret-abc");
  assert.equal(r.env.VRA_RUNTIME_API_KEY, undefined, "不该同时塞一份固定名的");
  assert.equal(r.model, r.profile.default_model, "没指定 model 时用模板的默认模型");
  assert.equal(BASE_ENV.DEEPSEEK_API_KEY, undefined, "不许改动传进来的那份 env");

  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "deepseek" }, BASE_ENV)), "missing_key");
});

test("runtime provider:带占位符的模板,用户在界面上填了 baseURL 就能用起来", () => {
  // 百炼系模板的 base_url 里有 {WorkspaceId} —— 直接加载会被契约层按设计拒掉
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "qwen", apiKey: "k" }, BASE_ENV)), "needs_base_url");

  // 🔴 覆盖必须发生在**校验之前**。顺序反了的话,用户明明填了自己的网关地址,
  //    仍然会被告知"模板不能直接用" —— 而他已经照要求填了。
  const r = resolveRuntimeProvider(
    REPO, DATA, { provider: "qwen", apiKey: "k", baseURL: "https://ws-1234.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" }, BASE_ENV,
  );
  assert.equal(r.runtime, "codex");
  if (r.runtime !== "codex") assert.fail("API provider 应走 Codex runtime");
  assert.equal(r.profile.base_url, "https://ws-1234.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  assert.ok(!/[{<]/.test(r.profile.base_url ?? ""), "占位符还在就等于没填");
});

test("runtime provider:自填端点合成的档案要过契约校验,协议不能是引擎已删掉的 chat", () => {
  const r = resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL: "https://gw.example.com/v1", model: "my-model" }, BASE_ENV);
  assert.equal(r.runtime, "codex");
  if (r.runtime !== "codex") assert.fail("自定义 provider 应走 Codex runtime");
  assert.equal(r.profile.wire_api, "responses", "引擎 0.149.0 已彻底移除 chat 协议,写 chat 会跑到深处才炸");
  assert.equal(r.profile.matrix?.status, "unverified", "没跑过兼容矩阵就不许声称跑过");
  assert.equal(r.model, "my-model");
  assert.equal(r.env.VRA_RUNTIME_API_KEY, "k");

  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k" }, BASE_ENV)), "missing_base_url");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", baseURL: "https://a.b/v1" }, BASE_ENV)), "missing_key");
});

test("runtime provider:本机回环与局域网私网 HTTP 可配置;公网 HTTP 与伪装回环拒绝", () => {
  for (const baseURL of ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://[::1]:1234/v1", "http://192.168.1.2/v1", "http://10.0.0.5:8000/v1", "http://172.16.1.1/v1"]) {
    const r = resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "local-test", baseURL }, BASE_ENV);
    assert.notEqual(r.runtime, "local-agent");
    if (r.runtime === "local-agent") throw new Error("wrong runtime");
    assert.equal(r.profile.base_url, baseURL);
  }
  for (const baseURL of ["http://8.8.8.8/v1", "http://example.com/v1", "http://localhost.evil.test/v1", "http://127.0.0.1@evil.test/v1", "http://127.1/v1", "http://2130706433/v1", "http://192.169.1.1/v1", "http://172.32.0.1/v1"]) {
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "local-test", baseURL }, BASE_ENV)), "bad_base_url");
  }
});

test("runtime provider:baseURL 只放 http(s);认不出的 provider 报错而不是换一家去打", () => {
  for (const bad of ["file:///etc/passwd", "ftp://x/y", "不是个 URL"]) {
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL: bad }, BASE_ENV)), "bad_base_url", bad);
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "deepseek", apiKey: "k", baseURL: bad }, BASE_ENV)), "bad_base_url", bad);
  }
  // 🔴 URL 里内嵌凭据要拒 —— 否则 key 会跟着 base_url 走进配置对象、也会跟着报错走回界面
  for (const creds of ["https://u:p@gw.example.com/v1", "https://user@gw.example.com/v1"]) {
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL: creds }, BASE_ENV)), "bad_base_url", creds);
  }
  // 🔴 报错不许回显原串:用户可能把密钥粘进 URL,而报错消息一路回到界面、也可能被上层记下来
  try {
    resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL: "ht!tp://never mind/secret-token-xyz" }, BASE_ENV);
    assert.fail("非法 URL 应当报错");
  } catch (e) {
    assert.ok(e instanceof RuntimeProviderError && !e.message.includes("secret-token-xyz"), `报错回显了原串:${String(e)}`);
  }

  // 🔴 悄悄回落到默认 = 用户以为在用自己选的模型,账单和产出却来自别处,且没有任何提示
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "nosuchvendor", apiKey: "k" }, BASE_ENV)), "unknown_provider");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "../etc", apiKey: "k" }, BASE_ENV)), "bad_provider");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "   " }, BASE_ENV)), "bad_provider");
});

test("runtime provider:模板清单来自磁盘,不是写死的一份", () => {
  const ids = templateIds(REPO, DATA);
  const onDisk = fs.readdirSync(path.join(REPO, "providers")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  // 🔴 前端拿它给"已实测"打标。写死一份的话,迟早与 providers/ 目录对不上,
  //    而对不上的表现是"明明实测过却没标",或更糟的"没测过却标了已实测"。
  assert.deepEqual(ids, onDisk);

  // 用户数据根里的模板也要算进去(用户可以自己放一份)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vra-tpl-"));
  fs.mkdirSync(path.join(tmp, "providers"));
  fs.writeFileSync(path.join(tmp, "providers", "mygw.json"), "{}");
  assert.ok(templateIds(REPO, tmp).includes("mygw"));
  fs.rmSync(tmp, { recursive: true, force: true });
});
