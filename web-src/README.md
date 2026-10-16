# web-src

`web/`(项目根的静态目录,由 `server/app.mjs` 的 `serveStatic` 原样服务)的前端源码。

这是整个 `claude_cloud-ce` 项目里**唯一**引入 npm 依赖 / 构建步骤的地方——服务端
(`server/`)继续保持零依赖纯 Node。构建产物直接落进 `../web/`,不需要重启服务端进程
(`serveStatic` 逐请求 `fs.readFile`,没有任何缓存),改完前端源码只需:

```sh
cd web-src
npm run build
```

然后刷新浏览器即可。

## 开发

```sh
npm install
npm run dev
```

开发服务器默认跑在 Vite 自己的端口(5173),`vite.config.js` 里配了 `/auth`、`/api` 的
反向代理转发到 `http://localhost:8890`——服务端完全没有 CORS 头,所以这一步是必须的,
不能直接跨源 fetch。

## 技术栈

React 19(JS,不用 TypeScript)+ `@assistant-ui/react`(headless 组件库,版本锁死不用
`^`,见下)+ Tailwind v4。

`@assistant-ui/react` / `@assistant-ui/react-markdown` 锁了精确版本号——这个库还在剧烈
重构中(仓库里同时存在当前真正生效的桥接层和大量已标记 deprecated 但还能跑的旧 API),
升级前最好先过一遍 changelog。
