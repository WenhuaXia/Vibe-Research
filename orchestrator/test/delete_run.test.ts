import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import { deleteRun, ServiceError, type ServiceContext } from "../src/service.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 造一个最小可用的 ServiceContext(dataRoot 指向临时目录) */
function tmpCtx(): { ctx: ServiceContext; runs: string; cleanup: () => void } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vr-delete-run-"));
  const runs = path.join(dataRoot, "runs");
  fs.mkdirSync(runs, { recursive: true });
  const ctx: ServiceContext = { repoRoot: REPO, dataRoot, python: "python3", node: "node", providerEnvKey: null };
  return { ctx, runs, cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }) };
}
function mkRun(runs: string, id: string): string {
  const d = path.join(runs, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const FINISHED = "2026-09-06T18:39:50.505+08:00";
function writeManifest(dir: string, body: string | object): void {
  fs.writeFileSync(path.join(dir, "manifest.json"), typeof body === "string" ? body : JSON.stringify(body));
}
const codeOf = (e: unknown): string | undefined => (e instanceof ServiceError ? e.code : undefined);

test("deleteRun:清单确认结束(complete+finished_at)→ 正常删,目录消失", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-done");
    writeManifest(d, { run_id: "run-done", symbol: "300308", status: "complete", exit_code: 0, finished_at: FINISHED, gate: { ok: true } });
    const r = deleteRun(t.ctx, "run-done");
    assert.equal(r.deleted, true);
    assert.equal(fs.existsSync(d), false, "运行目录应被删除");
  } finally { t.cleanup(); }
});

test("deleteRun:清单未结束(finished_at 缺失)→ 拒删 run_in_progress,目录保留", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-running");
    writeManifest(d, { run_id: "run-running", symbol: "300308", status: "running" });
    assert.throws(() => deleteRun(t.ctx, "run-running"), (e: unknown) => codeOf(e) === "run_in_progress");
    assert.equal(fs.existsSync(d), true, "进行中的运行目录必须保留");
  } finally { t.cleanup(); }
});

test("deleteRun:清单损坏(JSON 无法解析)→ 拒删 manifest_corrupt,目录保留", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-corrupt");
    writeManifest(d, "{ run_id: run-corrupt, status: complete, ");  // 半截 JSON,典型写到一半
    assert.throws(() => deleteRun(t.ctx, "run-corrupt"), (e: unknown) => codeOf(e) === "manifest_corrupt");
    assert.equal(fs.existsSync(d), true, "清单损坏的运行目录必须保留(数据不可信,不删)");
  } finally { t.cleanup(); }
});

test("deleteRun:清单缺失(目录在但无 manifest.json)→ 拒删 manifest_missing,目录保留", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-nomanifest");
    fs.writeFileSync(path.join(d, "events.jsonl"), "{}\n");  // 有别的产物,但没清单
    assert.throws(() => deleteRun(t.ctx, "run-nomanifest"), (e: unknown) => codeOf(e) === "manifest_missing");
    assert.equal(fs.existsSync(d), true, "无从确认终态的运行目录必须保留");
  } finally { t.cleanup(); }
});

test("deleteRun:进程级兜底——清单已结束但 control 明确未收尾 → 仍拒删 run_in_progress", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-control");
    writeManifest(d, { run_id: "run-control", symbol: "300308", status: "complete", exit_code: 0, finished_at: FINISHED, gate: { ok: true } });
    // control(owner.json)存在且 finished_at=null = worker 还活着(比 manifest 更实时)
    const cdir = path.join(t.ctx.dataRoot, "research-control", "run-control");
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, "owner.json"), JSON.stringify({ token: "11111111-2222-3333-4444-555555555555", state: "running", finished_at: null }));
    assert.throws(() => deleteRun(t.ctx, "run-control"), (e: unknown) => codeOf(e) === "run_in_progress");
    assert.equal(fs.existsSync(d), true);
  } finally { t.cleanup(); }
});

test("deleteRun:目录不存在 → 404 语义(deleted:false),不抛", () => {
  const t = tmpCtx(); try {
    const r = deleteRun(t.ctx, "run-absent");
    assert.equal(r.deleted, false);
  } finally { t.cleanup(); }
});

test("deleteRun:非法 run-id(路径穿越)→ bad_run_id,不碰任何目录", () => {
  const t = tmpCtx(); try {
    assert.throws(() => deleteRun(t.ctx, "../../etc"), (e: unknown) => codeOf(e) === "bad_run_id");
  } finally { t.cleanup(); }
});
