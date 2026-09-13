import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { makeConfig } from "../src/config.ts";
import { MAX_STOP_BLOCKS, buildHooksJson, contextMatchesCwd, hookHash, hookKey, installHooks, mergeBlock, normalizedHandler, readHookLog, readStopFailed, summarizeHookLog, writeHookContext } from "../src/hooks.ts";
import { writeJson } from "../src/fsutil.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const HOOKS_DIR = path.resolve(import.meta.dirname, "..", "hooks");

function tmpRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-hooks-"));
  fs.mkdirSync(path.join(repo, ".local", "runs", "r1", "stages"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".local", "runs", "r1", "fetch"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".local", "runs", "r1", "raw"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".local", "runs", "r1", "calcs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# c\n");
  // 产品必需件:项目技能目录(引擎按 <指令根>/.agents/skills 发现;缺了就是装坏了,preflight 会拒绝运行)
  fs.mkdirSync(path.join(repo, ".agents", "skills"), { recursive: true });
  return repo;
}

test("hookHash:复刻 Codex 规范化(timeout 默认 600 / async false / None 字段省略 / 键排序),稳定且对等价写法收敛", () => {
  const a = hookHash("Stop", undefined, { type: "command", command: "x" });
  const b = hookHash("Stop", undefined, { type: "command", command: "x", timeout: 600, async: false });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, hookHash("Stop", undefined, { type: "command", command: "y" }));
  assert.notEqual(a, hookHash("PreToolUse", "^Bash$", { type: "command", command: "x" }));
  assert.deepEqual(normalizedHandler("Stop", { type: "command", command: "x", additionalContextLimit: 2500 }), { type: "command", command: "x", timeout: 600, async: false });
  assert.deepEqual(normalizedHandler("PreToolUse", { type: "command", command: "x", additionalContextLimit: 100, statusMessage: "s" }), { type: "command", command: "x", timeout: 600, async: false, statusMessage: "s", additionalContextLimit: 100 });
  assert.deepEqual(normalizedHandler("SessionEnd", { type: "command", command: "x", timeout: 30 }), { type: "command", command: "x", timeout: 3, async: false });
  assert.equal(hookKey("/h/hooks.json", "PreToolUse", 0, 1), "/h/hooks.json:pre_tool_use:0:1");
});

test("installHooks:写 hooks.json + 在 config.toml 末尾登记 trusted_hash(幂等;块外内容保留;hooks.json 路径 = key 前缀)", () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "1", repoRoot: repo });
  fs.mkdirSync(cfg.codexHome, { recursive: true });
  fs.writeFileSync(path.join(cfg.codexHome, "config.toml"), '[projects."/x"]\ntrust_level = "trusted"\n');
  const inst = installHooks(cfg, "/usr/local/bin/node");
  const hooksJson = JSON.parse(fs.readFileSync(inst.hooksJsonPath, "utf8"));
  assert.ok(hooksJson.hooks.Stop[0].hooks[0].command.includes("orchestrator/hooks/stop.ts"));
  assert.equal(hooksJson.hooks.PreToolUse[0].matcher, "^(Bash|apply_patch)$");
  const toml = fs.readFileSync(inst.configTomlPath, "utf8");
  assert.ok(toml.startsWith('[projects."/x"]'));
  for (const st of inst.states) { assert.ok(toml.includes(`[hooks.state.${JSON.stringify(st.key)}]`)); assert.ok(toml.includes(st.trusted_hash)); assert.ok(st.key.startsWith(inst.hooksJsonPath + ":")); }
  const again = installHooks(cfg, "/usr/local/bin/node");
  assert.equal(fs.readFileSync(again.configTomlPath, "utf8"), toml); // 幂等
  // 已存在的块**就地替换**,不挪位置也不插空行(旧实现是"删掉再追加到末尾")
  assert.equal(mergeBlock("a = 1\n# >>> vibe-research hooks state (generated; do not edit) >>>\nold\n# <<< vibe-research hooks state <<<\n", "# >>> vibe-research hooks state (generated; do not edit) >>>\nnew\n# <<< vibe-research hooks state <<<"),
    "a = 1\n# >>> vibe-research hooks state (generated; do not edit) >>>\nnew\n# <<< vibe-research hooks state <<<\n");
  // 🔴 同一文件里多个生成块不许互相顶位置:旧实现下 A 写完把 B 顶到后面、B 写完又把 A 顶回去,
  //    每次运行都重写、changed 永远为真(config.toml 现在有 hooks / skills 隔离 / project root 三个块)
  const A = ["# >>> a >>>", "x = 1", "# <<< a <<<"].join("\n"), B = ["# >>> b >>>", "y = 2", "# <<< b <<<"].join("\n");
  const both = mergeBlock(mergeBlock("", A, "# >>> a >>>", "# <<< a <<<"), B, "# >>> b >>>", "# <<< b <<<");
  assert.equal(mergeBlock(both, A, "# >>> a >>>", "# <<< a <<<"), both, "重写 A 不该改变文件");
  assert.equal(mergeBlock(both, B, "# >>> b >>>", "# <<< b <<<"), both, "重写 B 不该改变文件");
  assert.ok(both.indexOf("# >>> a >>>") < both.indexOf("# >>> b >>>"), "写入顺序应保持");
  // 分隔符必须**独占整行**才算:注释 / 字符串里提到它(排查笔记很容易这么写)不能被判成"块只有一半"、
  // 从而每次运行都抛、自己好不了
  const mention = 'note = "排查时搜索 # >>> a >>>"\n';
  assert.doesNotThrow(() => mergeBlock(mention, A, "# >>> a >>>", "# <<< a <<<"));
  assert.ok(mergeBlock(mention, A, "# >>> a >>>", "# <<< a <<<").includes(mention.trim()), "原有内容要保留");
  // 真的只有一半仍要抛(不能因为放宽匹配就把真损坏放过去)
  assert.throws(() => mergeBlock("# >>> a >>>\nx = 1\n", A, "# >>> a >>>", "# <<< a <<<"), /只有一半/);
  assert.throws(() => mergeBlock(both + A + "\n", A, "# >>> a >>>", "# <<< a <<<"), /出现多次/);
  assert.deepEqual(Object.keys(buildHooksJson(cfg).hooks), ["Stop", "PreToolUse"]);
});

function runHook(name: string, cwd: string, input: Record<string, unknown>): { stdout: string; status: number | null } {
  const p = spawnSync(process.execPath, [path.join(HOOKS_DIR, name)], { cwd, input: JSON.stringify({ cwd, ...input }), encoding: "utf8", timeout: 30_000 });
  return { stdout: p.stdout, status: p.status };
}

test("Stop 钩子脚本:缺产物 → block(最多 MAX_STOP_BLOCKS 次无推进空转)→ 仍不合格则 continue:false + 终止标记(不算正常收工);产物合格 → 放行;无上下文 → 放行但出声", () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "r1" });
  const runDir = cfg.runDir;
  writeJson(path.join(runDir, "manifest.json"), { run_id: "r1" });
  let r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(r.status, 0); assert.equal(r.stdout, ""); // 无上下文 → 放行
  assert.ok(readHookLog(runDir).some((e) => e.decision === "error" && /上下文缺失/.test(e.reason ?? "")));
  writeHookContext(cfg, "profile", 1);
  for (let i = 0; i < MAX_STOP_BLOCKS; i++) {
    r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: i > 0 });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.ok(out.reason.includes("缺产物:stages/profile.json") && out.reason.includes(`无推进空转 ${i + 1}/${MAX_STOP_BLOCKS}`));
  }
  r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: true }); // 第 MAX+1 次仍无推进 → 终止本轮
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, false);
  const marker = readStopFailed(runDir);
  assert.ok(marker && marker.stage === "profile" && marker.attempt === 1 && marker.blocks === MAX_STOP_BLOCKS);
  // 新一轮(attempt 2):计数独立;产物齐全(取数无账本 → 账本类错误不 block,留给编排器)→ 放行
  writeHookContext(cfg, "profile", 2);
  writeJson(path.join(runDir, "stages", "profile.json"), { stage: "profile", status: "incomplete", summary: "x", evidence_ids: [], calculation_ids: [], gaps: [{ operation: "fetch_quote", reason_code: "source_failed", detail: "x" }, { operation: "fetch_profile", reason_code: "source_failed", detail: "x" }, { operation: "fetch_trade_calendar", reason_code: "source_failed", detail: "x" }], quote_decision: "unknown_unverified", quote_decision_reason: "x", moat_tag: "待补" });
  r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(r.stdout, "");
  const sum = summarizeHookLog(readHookLog(runDir));
  assert.equal(sum.stop_blocks, MAX_STOP_BLOCKS); assert.equal(sum.stop_terminations, 1); assert.equal(sum.errors, 1);
  // cwd 与上下文不一致(伪造上下文 / 换目录)→ 放行但记 error
  const other = path.join(repo, ".local", "runs", "r2"); fs.mkdirSync(other, { recursive: true }); writeJson(path.join(other, "manifest.json"), {});
  fs.mkdirSync(path.join(other, ".vibe"), { recursive: true }); fs.copyFileSync(path.join(runDir, ".vibe", "hook-context.json"), path.join(other, ".vibe", "hook-context.json"));
  r = runHook("stop.ts", other, { hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(r.stdout, "");
  assert.ok(readHookLog(other).some((e) => e.decision === "error" && /不一致/.test(e.reason ?? "")));
});

test("Stop 推进感知:新增合法 calc 记录 ⇒ 空转计数重置,合规攒算流不被收工预算误杀(2026-09-05 600519 复现)", () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "600519", market: "SH", repoRoot: repo, runId: "r2" });
  const runDir = cfg.runDir;
  writeJson(path.join(runDir, "manifest.json"), { run_id: "r2" });
  writeHookContext(cfg, "financials", 1);
  const calcDir = path.join(runDir, "calcs"); fs.mkdirSync(calcDir, { recursive: true });
  // 模拟合规攒算流:每轮落一个新合法 calc(quarterize→latest_quarter→ttm_sum→yoy→qoq…),
  // 直到第 MAX+3 轮才写 stage 文件 —— 旧逻辑(无推进感知,MAX=2)在第 3 轮就被终止。
  let r: ReturnType<typeof runHook>;
  for (let i = 0; i <= MAX_STOP_BLOCKS + 2; i++) {
    r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: i > 0 });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block", `第 ${i + 1} 轮有新 calc 落盘,必须继续 block 而不是终止`);
    assert.ok(!("continue" in out), "有推进时不允许 continue:false");
    // 本轮结束后再落一个新 calc(下一轮拦截时即为"新合法记录")
    writeJson(path.join(calcDir, `calc_${i}.json`), { calculation_id: `calc-${i}`, function: "ttm_sum", output: { status: "ok", value: 1, details: {} } });
  }
  const blocks = readHookLog(runDir).filter((e) => e.decision === "block");
  assert.equal(blocks.length, MAX_STOP_BLOCKS + 3);
  assert.ok(blocks.every((b) => (b.idleStreak ?? 1) <= 2), "每次拦截都有新 calc ⇒ idleStreak 不应超过 2");
  assert.equal(readStopFailed(runDir), null, "全程不得产生终止标记");
});

test("Stop 推进感知:仅 mtime/文件数变化但无合法 calc(参数文件、函数清单)⇒ 不算推进,空转照累计", () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "600519", market: "SH", repoRoot: repo, runId: "r3" });
  const runDir = cfg.runDir;
  writeJson(path.join(runDir, "manifest.json"), { run_id: "r3" });
  writeHookContext(cfg, "financials", 1);
  const calcDir = path.join(runDir, "calcs"); fs.mkdirSync(calcDir, { recursive: true });
  let r: ReturnType<typeof runHook>;
  for (let i = 0; i <= MAX_STOP_BLOCKS; i++) {
    r = runHook("stop.ts", runDir, { hook_event_name: "Stop", stop_hook_active: i > 0 });
    const out = JSON.parse(r.stdout);
    if (i < MAX_STOP_BLOCKS) {
      assert.equal(out.decision, "block");
      assert.ok(out.reason.includes(`无推进空转 ${i + 1}/${MAX_STOP_BLOCKS}`), "无合法 calc ⇒ 空转必须逐次累计");
    } else {
      assert.equal(out.continue, false, "纯参数文件/清单写盘 MAX 次后必须终止");
      break;
    }
    // 只落"非计算记录"的文件:args 前缀参数文件 + calculate 函数清单(00_list.json 形态)
    writeJson(path.join(calcDir, `args_${i}.json`), { period: "TTM", unit: "亿元" });
    writeJson(path.join(calcDir, "00_list.json"), { calc_version: "0.3.2", functions: { ttm_sum: "近四季合计" } });
  }
  const marker = readStopFailed(runDir);
  assert.ok(marker && marker.stage === "financials" && marker.attempt === 1);
  assert.equal(marker.blocks, MAX_STOP_BLOCKS);
});

test("PreToolUse 钩子脚本:自跑取数脚本 / 读禁区 / 改写受保护产物 / 联网 → block;普通 calc 命令 → 放行;apply_patch 触及 fetch/ → block", () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "r1", python: "/tmp/venv/bin/python" });
  const runDir = cfg.runDir;
  writeHookContext(cfg, "financials", 1);
  const bash = (command: string) => runHook("pre_tool_use.ts", runDir, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  let r = bash(`python3 ${repo}/.agents/skills/data-access/scripts/fetch_quote.py --symbol 300308`);
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash("cat ../../../交接资料/x.md");
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash(`echo x > ${runDir}/fetch/fetch_quote.json`);
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash("curl https://example.com");
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash("printf '{}' > .vibe/hook-context.json"); // 相对路径写钩子上下文
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash("rm .vibe/hooks.log; echo x >> fetch/fetch_quote.json");
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = bash(`/tmp/venv/bin/python ${repo}/calc/cli.py quarterize --args '{}' --evidence ev-1 --run-dir ${runDir} > ${runDir}/calcs/01_q.json`);
  assert.equal(r.stdout, "");
  r = bash("jq . fetch/fetch_financials.json");
  assert.equal(r.stdout, "");
  r = runHook("pre_tool_use.ts", runDir, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: fetch/fetch_quote.json\n+x\n*** End Patch" } });
  assert.equal(JSON.parse(r.stdout).decision, "block");
  r = runHook("pre_tool_use.ts", runDir, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Add File: stages/financials.json\n+{}\n*** End Patch" } });
  assert.equal(r.stdout, "");
  r = runHook("pre_tool_use.ts", runDir, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Add File: ../../../evil.json\n+{}\n*** End Patch" } });
  assert.equal(JSON.parse(r.stdout).decision, "block");
  const sum = summarizeHookLog(readHookLog(runDir));
  assert.equal(sum.pre_tool_use_blocks, 8);
  assert.equal(sum.errors, 0);
});

test("contextMatchesCwd:边界是**数据根**不是产品根(分离安装时运行目录本来就在产品根之外)", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "vra-hc-app-"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "vra-hc-data-"));
  const runDir = path.join(data, "runs", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  const ctx = { stage: "profile", attempt: 1, run_id: "r1", repo_root: app, data_root: data, run_dir: runDir,
    python: "python3", scripts_rel: "x", forbidden_path_patterns: [], allowed_path_prefixes: [], written_at: "" };

  // 分离安装:运行目录在产品根之外,但在数据根之内 → 必须匹配。
  // 🔴 旧实现要求"在产品根之下",于是这里返回 false,每次钩子调用都报"上下文与 cwd 不一致"并**放行** ——
  //    PreToolUse 那层执行纪律全程等于没有,而阶段照样 complete(真实运行里 5/5 全 error)。
  assert.equal(contextMatchesCwd(ctx, runDir), true, "数据根在产品根之外时也必须匹配");

  // cwd 不是上下文里的运行目录 → 不匹配
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "vra-hc-other-"));
  assert.equal(contextMatchesCwd(ctx, other), false);
  // 运行目录跑到数据根之外 → 不匹配(这才是该守的边界)
  assert.equal(contextMatchesCwd({ ...ctx, run_dir: other, data_root: data } as never, other), false);
  // 旧上下文没有 data_root → 视为不匹配,不按残缺上下文放行
  const legacy = { ...ctx } as Record<string, unknown>;
  delete legacy.data_root;
  assert.equal(contextMatchesCwd(legacy as never, runDir), false);
  // 仓库内布局仍然成立(数据根 = <产品根>/.local)
  const inRepoData = path.join(app, ".local");
  const inRepoRun = path.join(inRepoData, "runs", "r1");
  fs.mkdirSync(inRepoRun, { recursive: true });
  assert.equal(contextMatchesCwd({ ...ctx, data_root: inRepoData, run_dir: inRepoRun } as never, inRepoRun), true);
});
