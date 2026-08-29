import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { apiTokenPath } from "./vite-token";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/**
 * LAN 访问开关（默认关 = 纯 localhost，与本机桌面用法完全一致）。
 *
 * 设为 1 时，`npm run dev` 可被局域网设备通过本机 IP 访问（如 http://192.168.x.x:5930）：
 *   VRA_LAN=1 npm run dev
 *
 * 为什么需要两处改动：
 *   1. host 绑 0.0.0.0 —— 否则只有回环接口在监听；
 *   2. 代理把 Origin 归一化为回环 —— 后端 crossSiteReject 只认本机 Origin（CSRF 防护），
 *      而 LAN 客户端的浏览器带的是 http://192.168.x.x:5930，POST 全被 403。
 *      代理本身是本机进程（浏览器→vite 这一跳已由 vite host 控制），它到 loopback 后端
 *      的那一跳用本机身份转发，正是它的角色；changeOrigin 只重写 Host 不重写 Origin，
 *      故必须显式归一化。
 * 安全前提：非回环绑定的 API 端（--host 0.0.0.0）本就强制 VRA_API_TOKEN（见 api.ts），
 * Bearer token 只存在于 vite 进程、不进浏览器 —— 与回环模式同一把钥匙，只是多了一个
 * 由本机代理把关的入口。
 */
const lan = process.env.VRA_LAN === "1";

/**
 * 开发期鉴权:**Bearer token 只留在 Vite 进程里,不进浏览器**。
 * 前端一律打 `/api/*`(同源、无凭据),由这里补 Authorization 头转发到本机编排器 API。
 * 🔴 每次请求都重读 token 文件 —— API 重启会换 token(api.ts:resolveToken),
 *    缓存住就会在"看着还开着"的情况下整站 401,而且要重启前端才好,极难排查。
 *    文件是本机几十字节,重读的代价可以忽略。
 */
function apiToken(): string {
  const fromEnv = process.env.VRA_API_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const file = apiTokenPath(repoRoot);
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 16) return t;
  } catch {
    /* 缺失时不补头,后端会以 401 明确拒绝,好过在这里静默放行 */
  }
  return "";
}

export default defineConfig({
  plugins: [react()],
  // 🔴 `@` 指向**垂类包**而不是 src:上游 UI 里写的是 `@/components`、`@/lib`、`@/data`,
  //    我们把它整套放进 verticals/finance/,别名这么指,上游代码一行都不用改。
  resolve: { alias: { "@": path.resolve(here, "src/verticals/finance") } },
  server: {
    // 🔴 默认写死 IPv4:localhost 在本机可能解析成 [::1],而后端绑的是 127.0.0.1,对不上会 502。
    // LAN 模式(VRA_LAN=1)放开 0.0.0.0,让局域网设备能访问(见文件头说明)。
    host: lan ? "0.0.0.0" : "127.0.0.1",
    port: 5930,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/api/, ""),
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            // 后端 crossSiteReject 只接受本机 Origin;浏览器带的是 127.0.0.1:5930,本机、放行。
            // LAN 模式下浏览器 Origin 是 http://192.168.x.x:5930,会被 403 ——
            // 由本机代理把它归一化为回环身份(见文件头安全说明)。
            if (lan) proxyReq.setHeader("origin", "http://127.0.0.1:5930");
            const token = apiToken();
            if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
          });
          proxy.on("error", (err, _req, res) => {
            // 默认错误页是一段 HTML,前端 res.json() 会炸在"Unexpected token <",把真正原因埋掉
            const msg = /ECONNREFUSED/.test(String(err))
              ? "编排器 API 没在跑:先执行 node orchestrator/src/api.ts"
              : `代理失败:${err.message}`;
            if ("writeHead" in res && !res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "api_unreachable", message: msg }));
            }
          });
        },
      },
    },
  },
});
