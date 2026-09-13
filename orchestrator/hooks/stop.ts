#!/usr/bin/env node
/**
 * Stop 钩子(Codex lifecycle hook,agent 每个 turn 想收工时由 Codex 同步调用;stdin = StopCommandInput JSON,cwd = 运行目录)。
 * 语义 = "缺产物 / 阶段校验不过,不许正常收工":
 *   - 不合格 → {"decision":"block","reason":...},agent 在同一 turn 内继续修(最多 MAX_STOP_BLOCKS 次,以本 (stage, attempt) 的日志计数);
 *   - 拦过 MAX_STOP_BLOCKS 次仍不合格 → 写终止标记 .vibe/stop-failed.json 并输出 {"continue":false,"stopReason":...}:本轮到此为止,
 *     编排器看到标记把这轮判为失败并带着校验错误补跑(不会被当成正常完成);
 *   - 合格 → 放行。
 * 上下文 / cwd 不一致、stdin 解析失败、内部异常 → 放行但一定出声(日志 + stderr),绝不让钩子故障卡死 agent。
 */
import fs from "node:fs";
import path from "node:path";

import { stages, type Stage } from "../src/config.ts";
import { MAX_STOP_BLOCKS, STOP_FAILED_REL, appendHookLog, contextMatchesCwd, readHookContext, readHookLog, readStdin, type StopFailedMarker } from "../src/hooks.ts";
import { writeJson } from "../src/fsutil.ts";
import { loadRun, validateStage } from "../src/validator.ts";


// **composition root**:钩子是独立子进程,也是一个入口 —— 垂类包要在这里注册
import "../src/finance/register.ts";
interface StopInput { cwd: string; stop_hook_active?: boolean; hook_event_name?: string; last_assistant_message?: string | null }

function expectedArtifacts(stage: Stage, runDir: string): string[] {
  const out = [path.join(runDir, "stages", `${stage}.json`)];
  if (stage === "report") out.unshift(path.join(runDir, "report.md"));
  return out;
}

const isRunDir = (d: string) => fs.existsSync(path.join(d, "manifest.json"));

async function main(): Promise<void> {
  let input: StopInput;
  try { input = JSON.parse(await readStdin()) as StopInput; } catch (e) { process.stderr.write(`[vibe stop hook] stdin 不是合法 JSON:${e instanceof Error ? e.message : String(e)}\n`); return; }
  const runDir = input.cwd;
  const ctx = readHookContext(runDir);
  const ts = () => new Date().toISOString();
  if (!ctx || !stages().includes(ctx.stage) || !contextMatchesCwd(ctx, runDir)) {
    if (isRunDir(runDir)) appendHookLog(runDir, { ts: ts(), hook: "stop", decision: "error", reason: !ctx ? "钩子上下文缺失(被删?)" : "钩子上下文与 cwd 不一致(被改?)" });
    process.stderr.write("[vibe stop hook] 无有效钩子上下文,放行\n");
    return;
  }
  const stage = ctx.stage as Stage;
  const problems: string[] = [];
  try {
    for (const f of expectedArtifacts(stage, runDir)) if (!fs.existsSync(f)) problems.push(`缺产物:${path.relative(runDir, f)}`);
    if (!problems.length) {
      const run = loadRun(runDir); // 账本用磁盘审计副本;最终裁判仍是编排器内存账本
      const r = validateStage(stage, run);
      problems.push(...r.errors.filter((e) => !/账本|编排器取数记录/.test(e)).slice(0, 8));
    }
  } catch (e) {
    appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "error", reason: e instanceof Error ? e.message : String(e) });
    process.stderr.write(`[vibe stop hook] 校验异常,放行:${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }
  if (!problems.length) {
    appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "allow", stop_hook_active: !!input.stop_hook_active });
    return;
  }
  const curCalcSet = validCalcSet(runDir); // 当前合法计算记录集合(推进判据,见下方说明)
  const priorBlocks = readHookLog(runDir).filter((e) => e.hook === "stop" && e.decision === "block" && e.stage === stage && e.attempt === ctx.attempt);
  const last = priorBlocks[priorBlocks.length - 1];
  // 推进感知(治"收工预算在写 stage 文件前烧尽"的误杀):
  // 合规工作流是"攒 N 轮 calc(quarterize→latest_quarter→ttm_sum→yoy→qoq)→ 最后一步才写 stage 文件",
  // 模型每轮想收工时 stage 文件还没写,旧逻辑每轮都计一次 block,第 3-5 轮还在攒 calc 就被 MAX 次烧尽终止,
  // stage 文件在后续轮才补写 ⇒ 阶段永久 failed(2026-09-05 茅台 600519 run 实测)。
  // 判据(回应 review"仅 mtime 变化不足以证明有效进展"):两次拦截之间出现了**新的合法计算记录**
  // (JSON 可解析 + calculation_id 为 string,与 merge.ts 的收数口径一致)才算推进;agent 写的
  // args_*/sq_* 参数文件、function 清单(00_list.json)无 calculation_id,不算推进,防止用无意义写盘刷掉预算。
  // 连续**无推进**的空转 block 累计到 MAX 才终止;一旦有新合法 calc 落盘,计数回 1。
  const isNewCalc = (cur: string[], prev: string[] | undefined): boolean =>
    prev === undefined ? true : cur.some((id) => !prev.includes(id));
  const prevStreak = last && typeof last.idleStreak === "number" ? last.idleStreak : 0;
  const idleStreak = isNewCalc(curCalcSet, last?.calcSet) ? 1 : prevStreak + 1;
  if (idleStreak <= MAX_STOP_BLOCKS) {
    const reason = `【Stop 钩子】本阶段(${stage})还不能收工(无推进空转 ${idleStreak}/${MAX_STOP_BLOCKS}),请先修好再结束本轮;有新增计算落盘则继续,不受此上限约束:\n- ${problems.join("\n- ")}`.slice(0, 1800);
    appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "block", reason, stop_hook_active: !!input.stop_hook_active, calcSet: curCalcSet, idleStreak });
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    return;
  }
  // 空转拦够次数仍不合格:终止本轮,留标记给编排器(这轮按失败处理并补跑),不算正常收工
  const marker: StopFailedMarker = { stage, attempt: ctx.attempt, problems: problems.slice(0, 8), blocks: prevStreak || MAX_STOP_BLOCKS, ts: ts() };
  writeJson(path.join(runDir, STOP_FAILED_REL), marker);
  const stopReason = `【Stop 钩子】无有效计算推进已提醒 ${prevStreak || MAX_STOP_BLOCKS} 次仍不合格,终止本轮交编排器补跑:${problems.slice(0, 3).join("; ")}`.slice(0, 1000);
  appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "stop", reason: stopReason, stop_hook_active: !!input.stop_hook_active, calcSet: curCalcSet, idleStreak });
  process.stdout.write(JSON.stringify({ continue: false, stopReason, systemMessage: stopReason }));
}

/** 列出 calcs/ 下**合法计算记录**的 calculation_id 集合(排序)。
 * 合法 = JSON 可解析且 calculation_id 为非空 string —— 与 merge.ts loadCalcs 的收数口径一致。
 * agent 往 calcs/ 写的临时参数文件(args 前缀、sq 前缀)、function 清单(无 calculation_id)不算,
 * 这正是"仅看 mtime 会误判推进"被排除的原因。 */
function validCalcSet(runDir: string): string[] {
  const dir = path.join(runDir, "calcs");
  if (!fs.existsSync(dir)) return [];
  const ids: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let rec: unknown;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (rec && typeof rec === "object" && typeof (rec as { calculation_id?: unknown }).calculation_id === "string"
      && (rec as { calculation_id: string }).calculation_id.length > 0) ids.push((rec as { calculation_id: string }).calculation_id);
  }
  return ids.sort();
}

main().catch((e) => { process.stderr.write(`[vibe stop hook] 顶层异常,放行:${e instanceof Error ? e.message : String(e)}\n`); }).finally(() => process.exit(0));
