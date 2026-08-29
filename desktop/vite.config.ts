import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { apiTokenPath } from "./vite-token";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

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
    // 🔴 必须写死 IPv4:默认 localhost 在本机解析成 [::1],而后端绑的是 127.0.0.1,对不上会 502
    // LAN 部署(192.168.248.5 访问):host 放开 0.0.0.0;API 端口 8766 —— 8765 被 feishu-card 自治系统占用
    host: "0.0.0.0",
    port: 5930,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8766",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            // 🔴 LAN 部署(192.168.x 访问):浏览器 Origin 是局域网地址,而后端 crossSiteReject
            //    只认回环 Origin(CSRF 防护)。changeOrigin 只重写 Host 不重写 Origin(实测),
            //    这里显式改写成回环 —— 本机代理就是可信跳板,以它的名义转发。
            proxyReq.setHeader("origin", "http://127.0.0.1:5930");
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
