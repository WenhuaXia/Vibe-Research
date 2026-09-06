import { useEffect, useRef, useState } from "react";
import { FlaskConical, Play, FileText, Loader2, GitCompare, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { ReportView } from "@/components/ui/ReportView";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { useAiPage } from "../../../core/ai/pageContext";
import { backend, ApiError, type RunListItem, type ResearchStatus, type AlertDiff } from "@/lib/backend";

/**
 * 「个股研究」—— 六阶段研究引擎的唯一入口。
 *
 * 🔴 为什么新建这一页：这条链路**后端一直都有**（公司画像 → 财务 → 一致预期 → 估值 →
 *    风险 → 成稿，强制季度拆分 / TTM / 预测分歧 / 四情景估值 / 反证 / 裁决点），
 *    `backend.ts` 里 `runs()`、`report()` 也早就写好，但**没有任何路由指向它** ——
 *    用户完全不知道产品能生成带证据链与裁决点的正式研究。
 *    「我的研报」是上传外部文件的归档柜，不是这个。
 *
 * ⚠️ 跑一次真的**花模型额度、要十几分钟**，所以：
 *    ① 必须用户显式点，页面打开不自动跑；
 *    ② 阶段逐个显示，不是一个转圈 —— 用户要知道它在哪一步、卡在哪一步。
 */

/** 阶段的中文名。⚠️ 阶段由垂类包定义，这里只做显示；认不出的**原样显示**，不猜 */
const STAGE_CN: Record<string, string> = {
  profile: "公司画像",
  financials: "财务",
  estimates: "一致预期",
  valuation: "估值",
  risk: "风险与卡口",
  report: "成稿",
};

/** 三种变化分开说：糊成"有变化"会让"这条事实消失了"被读成噪音 */
const KIND_CN: Record<string, string> = { changed: "变了", added: "新增", removed: "消失" };

const STATUS_CN: Record<string, string> = {
  complete: "完成",
  running: "进行中",
  failed: "失败",
  pending: "待跑",
  incomplete: "未跑完",
};

export function Research() {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [symbol, setSymbol] = useState("");
  const [scope, setScope] = useState<"core" | "full">("core");
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState("");
  const [active, setActive] = useState<ResearchStatus | null>(null);
  /** 🔴 `null` = 还没取回；`[]` = 真的一次都没跑过。**两者不能混** ——
   *  接口挂了却渲染成"还没有研究运行",就是把故障说成了事实。 */
  const [runsErr, setRunsErr] = useState<string | null>(null);
  /** 轮询中断的原因。⚠️ 停掉轮询而不说话 = 页面永远停在"进行中"，开始按钮也一直禁用 */
  const [watchErr, setWatchErr] = useState<string | null>(null);
  /** 只认最后一次点击的运行：慢请求回来时不许覆盖已经切走的那一个 */
  const wantRun = useRef<string | null>(null);
  const [report, setReport] = useState<{ run_id: string; report: string | null } | null>(null);
  /**
   * 「昨天以来变了什么」：对齐同一标的最近两次研究。
   * 🔴 `need_two_runs` 要显示成"还没有可比较的第二次"，**不能显示成"没有变化"** ——
   *    后者会让用户以为已经核对过了，而其实根本没比。
   */
  const [alerts, setAlerts] = useState<{ base: string; next: string; diffs: AlertDiff[] } | null>(null);
  const [alertsNote, setAlertsNote] = useState("");
  const timer = useRef<number | null>(null);

  const loadRuns = () =>
    backend.runs(30)
      .then((r) => { setRuns(r); setRunsErr(null); })
      // 🔴 不写成空数组 —— 空数组会被读成"确实一次都没跑过"
      .catch((e) => setRunsErr(e instanceof ApiError ? e.message : String(e)));
  /** 删除一次归档(不可逆,先确认);进行中 run 后端会拒绝并给出原因 */
  const [deleting, setDeleting] = useState<string | null>(null);
  const [delErr, setDelErr] = useState("");
  const removeRun = async (id: string) => {
    if (!window.confirm(`删除这次研究归档？\n\n${id}\n\n会删掉它的报告 / 证据 / 计算，不可恢复。`)) return;
    setDeleting(id); setDelErr("");
    try {
      await backend.deleteRun(id);
      if (report?.run_id === id) setReport(null); // 删的是当前打开的报告
      await loadRuns();
    } catch (e) {
      setDelErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };
  useEffect(() => {
    void loadRuns();
    // 组件卸载要停掉轮询，否则它会在后台一直打接口
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);

  /** 轮询一次运行的状态，直到它不再是 running */
  const watch = (id: string) => {
    if (timer.current) window.clearInterval(timer.current);
    setWatchErr(null);
    // 🔴 一次网络抖动不该让整块永久停住(页面会一直显示"进行中"、开始按钮一直禁用)。
    //    连续失败到上限才停,并且**把原因说出来** —— 停掉却不说话是静默失败。
    let fails = 0;
    const MAX_FAILS = 3;
    timer.current = window.setInterval(() => {
      backend
        .researchStatus(id)
        .then((st) => {
          fails = 0; setWatchErr(null);
          setActive(st);
          if (st.status !== "running") {
            if (timer.current) window.clearInterval(timer.current);
            void loadRuns();
          }
        })
        .catch((e) => {
          fails += 1;
          const msg = e instanceof ApiError ? e.message : String(e);
          if (fails >= MAX_FAILS) {
            if (timer.current) window.clearInterval(timer.current);
            setWatchErr(`连着 ${MAX_FAILS} 次没问到进度，已停止跟踪：${msg}。研究**可能仍在后台跑**，稍后回到这一页从下面的归档里打开它。`);
          } else {
            setWatchErr(`第 ${fails} 次没问到进度（还在重试）：${msg}`);
          }
        });
    }, 4000);
  };

  const start = async () => {
    setErr(""); setReport(null);
    const code = symbol.trim();
    if (!/^\d{6}$/.test(code)) { setErr("请输入 6 位 A 股代码"); return; }
    setStarting(true);
    try {
      const quote = await backend.fetch("tx_quote", { symbol: code }).catch(() => null);
      const companyName = quote?.envelope.evidence.find((e) => e.field === "security_name")?.value;
      const r = await backend.startResearch({
        symbol: code,
        ...(typeof companyName === "string" && companyName.trim() ? { company_name: companyName.trim() } : {}),
        endpoints: scope,
        knowledge: "on",
      });
      setActive({
        run_id: r.run_id, exists: true, status: "running", exit_code: null,
        stages: [], evidence_count: null, calculation_count: null, finished_at: null,
      });
      watch(r.run_id);
      void loadRuns();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const loadAlerts = async (code: string, market?: string, forRun?: string) => {
    setAlerts(null); setAlertsNote("");
    try {
      const a = await backend.alerts(code, market);
      // 期间用户切了别的运行 → 这份结果已经不是他在看的那个,丢掉
      if (forRun && wantRun.current !== forRun) return;
      setAlerts(a);
      if (a.diffs.length === 0) setAlertsNote(`${a.base} → ${a.next}：两次之间没有可报的变化`);
    } catch (e) {
      if (forRun && wantRun.current !== forRun) return;
      // 分开说:"还没有第二次"是正常状态,不是故障
      setAlertsNote(e instanceof ApiError && e.code === "need_two_runs"
        ? "这只标的还只有一次研究 —— 再跑一次才能比较「变了什么」"
        : e instanceof ApiError ? e.message : String(e));
    }
  };

  const openReport = async (id: string) => {
    setErr("");
    // 🔴 连点两个运行时,慢的那个后回来会盖掉快的 —— 报告是 A 的、变化列表是 B 的,
    //    而页面上完全看不出这是两次运行拼起来的。⇒ 只认最后一次点击。
    wantRun.current = id;
    try {
      const r = await backend.report(id);
      if (wantRun.current !== id) return;
      setReport({ run_id: id, report: r.report });
      const st = await backend.researchStatus(id).catch(() => null);
      if (wantRun.current !== id) return;
      if (st) setActive(st);
      const run = runs.find((x) => x.run_id === id);
      if (run?.symbol) void loadAlerts(run.symbol, run.market ?? undefined, id);
    } catch (e) {
      if (wantRun.current !== id) return;
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  useAiPage({
    key: "research",
    title: "个股研究",
    context: active
      ? `当前研究运行 ${active.run_id}：状态 ${active.status}｜证据 ${active.evidence_count ?? "—"} 条｜计算 ${active.calculation_count ?? "—"} 项｜` +
        `阶段 ${active.stages.map((s) => `${STAGE_CN[s.stage] ?? s.stage}=${STATUS_CN[s.status] ?? s.status}`).join("、")}` +
        (report?.report ? `\n\n报告全文：\n${report.report.slice(0, 6000)}` : "")
      : `研究归档共 ${runs.length} 次运行。当前完整六阶段取数链支持 A 股。`,
    suggestions: ["这份研究的裁决点是什么", "哪些数据有缺口", "反证部分说了什么"],
  });

  const stagesToShow = active
    ? (active.stages.length ? active.stages : Object.keys(STAGE_CN).map((s) => ({ stage: s, status: "pending" })))
    : [];

  return (
    <div>
      <PageHeader
        title="个股研究"
        subtitle="六阶段完整研究：公司画像 → 财务 → 一致预期 → 估值 → 风险 → 成稿。每个数字都带证据来源与裁决点"
      />

      <GlassCard className="mb-4">
        <div className="mb-3 flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">跑一次研究</h3>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1.5">
            <span className="block text-xs text-muted-foreground">A 股代码</span>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="例如 600519"
              className="w-40 rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="space-y-1.5">
            <span className="block text-xs text-muted-foreground">取数范围</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as "core" | "full")}
              className="rounded-lg border border-border bg-background/60 px-3 py-2 text-sm"
            >
              <option value="core">核心（快，够形成判断）</option>
              <option value="full">完整（慢，全部端点）</option>
            </select>
          </label>
          <button
            onClick={() => void start()}
            disabled={starting || active?.status === "running"}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary ring-1 ring-primary/30 hover:bg-primary/25 disabled:opacity-50"
          >
            {starting || active?.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            开始
          </button>
        </div>
        {/* 🔴 代价要说在前面：它真的花额度、真的要十几分钟 */}
        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          一次完整研究会多轮调用你配置的模型、并真实取数十几个端点，<b className="text-foreground">通常十几分钟</b>，
          消耗你自己的模型额度。产出是一份带证据 id、确定性计算、数据缺口与裁决点的报告 ——
          每个数字都能追回它的来源。
        </p>
        {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
        {/* 🔴 轮询断了要说话:停掉却不说,页面会一直显示"进行中"、开始按钮一直禁用,
            而研究其实可能已经跑完了 —— 用户只会以为它卡住了。 */}
        {watchErr && <p className="mt-2 text-xs text-warning">{watchErr}</p>}
      </GlassCard>

      {active && (
        <GlassCard className="mb-4">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="font-semibold">{active.run_id}</h3>
            <span className="rounded-full bg-muted/50 px-2 py-0.5 text-[11px]">{STATUS_CN[active.status] ?? active.status}</span>
            {active.evidence_count !== null && <span className="text-xs text-muted-foreground">证据 {active.evidence_count} 条</span>}
            {active.calculation_count !== null && <span className="text-xs text-muted-foreground">计算 {active.calculation_count} 项</span>}
          </div>
          {/* 阶段逐个显示 —— 用户要知道它在哪一步，而不是看一个转圈 */}
          <div className="flex flex-wrap gap-2">
            {stagesToShow.map((s) => (
              <span
                key={s.stage}
                className={
                  s.status === "complete" ? "rounded-md bg-primary/15 px-2.5 py-1 text-xs text-primary"
                    : s.status === "failed" ? "rounded-md bg-destructive/15 px-2.5 py-1 text-xs text-destructive"
                    : s.status === "running" ? "rounded-md bg-muted/60 px-2.5 py-1 text-xs"
                    : "rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground/60"
                }
              >
                {STAGE_CN[s.stage] ?? s.stage} · {STATUS_CN[s.status] ?? s.status}
              </span>
            ))}
          </div>
        </GlassCard>
      )}

      {/*
        「昨天以来变了什么」——「用户不会每天重读静态资料，但会每天检查变化」。
        🔴 三种 kind 分开显示：**变了 / 新增 / 消失** 是三件不同的事，
           糊成一句"有变化"会让"这条事实不见了"这种最该警觉的情况被读成噪音。
      */}
      {(alerts || alertsNote) && (
        <GlassCard className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-primary" />
            <h3 className="font-semibold">上次以来变了什么</h3>
            {alerts && <span className="text-xs text-muted-foreground">{alerts.base} → {alerts.next}</span>}
          </div>
          {alertsNote && <p className="text-sm text-muted-foreground">{alertsNote}</p>}
          {alerts && alerts.diffs.length > 0 && (
            <div className="space-y-1">
              {alerts.diffs.slice(0, 30).map((d, i) => (
                <div key={`${d.key}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/30 py-1.5 text-sm last:border-0">
                  <span className={
                    d.kind === "removed" ? "rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive"
                      : d.kind === "added" ? "rounded bg-primary/15 px-1.5 py-0.5 text-[11px] text-primary"
                      : "rounded bg-muted/60 px-1.5 py-0.5 text-[11px]"
                  }>{KIND_CN[d.kind] ?? d.kind}</span>
                  <span className="font-medium">{d.field}</span>
                  <span className="text-xs text-muted-foreground">{d.period}</span>
                  {/* 🔴 两侧各挂自己的证据 id(tooltip) —— 一条变化要能追回它两边分别出自哪条证据。
                      id 收进 title 不占版面,但**不能不给**:溯源链是这产品的立身之本。 */}
                  <span className="ml-auto font-mono text-xs">
                    <span title={d.base?.id ? `证据 ${d.base.id} · ${d.base.source}${d.base.as_of ? ` · ${d.base.as_of}` : ""}` : "这一侧没有证据（新增项）"}
                          className={d.base?.id ? "cursor-help underline decoration-dotted underline-offset-2" : undefined}>
                      {String(d.base?.value ?? "—")}
                    </span>
                    <span className="mx-1 text-muted-foreground">→</span>
                    <span title={d.next?.id ? `证据 ${d.next.id} · ${d.next.source}${d.next.as_of ? ` · ${d.next.as_of}` : ""}` : "这一侧没有证据（本次消失）"}
                          className={d.next?.id ? "cursor-help underline decoration-dotted underline-offset-2" : undefined}>
                      {String(d.next?.value ?? "—")}
                    </span>
                    {d.unit && <span className="ml-1 text-muted-foreground">{d.unit}</span>}
                  </span>
                </div>
              ))}
              {alerts.diffs.length > 30 && (
                <p className="pt-1 text-xs text-muted-foreground">还有 {alerts.diffs.length - 30} 条未列出</p>
              )}
            </div>
          )}
        </GlassCard>
      )}

      {report && (
        <GlassCard className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            <h3 className="font-semibold">{report.run_id} 的报告</h3>
          </div>
          {report.report
            ? <div className="max-h-[70vh] overflow-auto rounded-lg bg-muted/10 p-4"><ReportView content={report.report} /></div>
            : <p className="text-sm text-muted-foreground">这次运行没有产出报告（多半是中途没跑完）。</p>}
        </GlassCard>
      )}

      <GlassCard>
        <h3 className="mb-3 font-semibold">研究归档</h3>
        {runsErr ? (
          // 🔴 取不到 ≠ 没有:接口挂了要说是挂了,不能显示成"还没有研究运行"
          <p className="text-sm text-destructive">归档列表没取到：{runsErr}</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有研究运行。上面填一个代码就能跑第一次。</p>
        ) : (
          <div className="space-y-1.5">
            {runs.map((r) => {
              const running = r.status === "running";
              return (
                <div
                  key={r.run_id}
                  className="group flex w-full cursor-pointer items-center gap-3 rounded-md border-b border-border/30 px-1 py-2.5 text-sm last:border-0 hover:bg-muted/30"
                  onClick={() => void openReport(r.run_id)}
                  title={r.run_id}
                >
                  <span className="font-medium">{r.name ?? "个股"}</span>
                  <span className="font-mono text-xs text-muted-foreground">{r.symbol ?? "—"}</span>
                  <span
                    className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
                      running ? "bg-primary/15 text-primary" : "bg-muted/60 text-muted-foreground"
                    }`}
                  >
                    {running ? "进行中" : (STATUS_CN[r.status ?? ""] ?? r.status ?? "?")}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); void removeRun(r.run_id); }}
                    disabled={running || deleting === r.run_id}
                    className="rounded p-1 text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                    title={running ? "研究进行中,跑完才能删" : "删除这次研究归档"}
                    aria-label="删除"
                  >
                    {deleting === r.run_id
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>
              );
            })}
            {delErr && <p className="pt-1 text-xs text-destructive">删除失败：{delErr}</p>}
          </div>
        )}
      </GlassCard>

      <Disclaimer />
    </div>
  );
}
