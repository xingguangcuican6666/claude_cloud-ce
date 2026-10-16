# App 外围功能缺失 — 服务端契约交接 (26100920)

> 由 App 侧逆向会话整理交给 core.mjs 负责方。所有 schema 来自 26100920 反编译 smali(kotlinx.serialization descriptor),字段名/枚举值精确。
> App **不请求 statsig/growthbook 端点**,主界面能力全部由 `GET /api/bootstrap/{org}/app_start` 的返回决定。

## 端点现状(实测,ORG=20937a9c-...）

已实现:`/api/account` `/api/bootstrap` `/api/bootstrap/{org}/app_start` `/api/legal` `/api/organizations/{org}/projects_v2` `/api/organizations/{org}/chat_conversations`(返回 `[]`)。

标【未实现→空默认】(App 侧表现为报错/缺失):
- `GET /api/organizations/{org}/recents`           → 现返回 `{}`
- `GET /api/organizations/{org}/projects/{id}`     → 点进 project 即 something went wrong
- `GET /api/organizations/{org}/projects/{id}/docs`
- `GET /api/organizations/{org}/projects/{id}/conversations`
- `GET /api/organizations/{org}/projects/{id}/kb/stats`
- `PUT /api/organizations/{org}/projects/{id}`
- `POST /api/organizations/{org}/projects/{id}/docs`
- `POST /api/organizations/{org}/projects/{id}/kb/resync`
- `GET /api/organizations/{org}/mcp/v2/bootstrap`
- `GET /api/organizations/{org}/memory/settings`
- `GET /api/organizations/{org}/experiences`
- `PATCH /api/organizations/{org}/notification/preferences`

## A. 模型锁死 opus-4-8 + 无法切 thinking 【最高优先】

根因:`app_start.current_user_access = null` 且 `model_selector_config[].models[].thinking` 的 effort/mode 选项全空。

### A1. 填 current_user_access(解锁模型选择器/cowork/projects 入口)

Schema: `CurrentUserAccess{ features:FeatureAccess[], account_features:FeatureAccess[], organization_permissions:enum[]? }`
`FeatureAccess = { feature:String(自由串), status:FeatureAccessStatus }`
`FeatureAccessStatus` 枚举 = `available`|`blocked_by_entitlement`|`blocked_by_org_admin`|`blocked_by_org_tier`|`blocked_by_platform`|`feedback`。**解锁一律用 `"available"`**。
`organization_permissions` 可空 → 填 `null` 降风险。

```json
"current_user_access": {
  "features": [
    {"feature": "model_picker", "status": "available"},
    {"feature": "cowork", "status": "available"},
    {"feature": "mobile_cowork_tab_enabled", "status": "available"},
    {"feature": "projects", "status": "available"},
    {"feature": "research", "status": "available"},
    {"feature": "raven", "status": "available"},
    {"feature": "artifacts_enabled", "status": "available"}
  ],
  "account_features": [
    {"feature": "model_picker", "status": "available"},
    {"feature": "cowork", "status": "available"},
    {"feature": "mobile_cowork_tab_enabled", "status": "available"},
    {"feature": "projects", "status": "available"},
    {"feature": "research", "status": "available"},
    {"feature": "raven", "status": "available"},
    {"feature": "artifacts_enabled", "status": "available"}
  ],
  "organization_permissions": null
}
```
`feature` 既是自由字符串,填多/填错不会崩反序列化;若某功能仍锁,多半是漏了对应 flag 名,补即可。

### A2. 填 thinking 档位(让 thinking 强度可切)

每个模型的 `thinking` 从 `{effort_options:[],mode_options:[]}` 改为(类型 `ThinkingOptions{effort_options:ThinkingOption[], mode_options:ThinkingOption[], description:String?}`,
`ThinkingOption = { id:String, name:String, description:String?, recommended:Boolean, badge:? }`):

```json
"thinking": {
  "effort_options": [
    {"id": "none",   "name": "标准",  "description": null, "recommended": false, "badge": null},
    {"id": "low",    "name": "低",    "description": null, "recommended": false, "badge": null},
    {"id": "medium", "name": "中",    "description": null, "recommended": true,  "badge": null},
    {"id": "high",   "name": "高",    "description": null, "recommended": false, "badge": null},
    {"id": "max",    "name": "最大",  "description": null, "recommended": false, "badge": null}
  ],
  "mode_options": [],
  "description": null
}
```
并把 `model_selector_state[]` 的 `thinking` 给个默认,如 `{"effort":"medium"}`(或 `thinking_by_model` 按模型给默认 effort)。

⚠️ **thinking 要真生效**:completion 代理(`POST .../chat_conversations/{id}/completion`)需把所选 effort 翻译成上游 Anthropic 兼容的 `thinking:{type:"enabled", budget_tokens:N}`(none→不带 thinking;low/medium/high/max→递增 budget)。只填 UI 选项而不翻译,则能点不生效。

## B. 会话历史(session 历史)

- `GET .../chat_conversations` 现返回 `[]`:schema 对(元素 = `ChatConversation`),但**创建的会话没被持久化/没进列表**。需要:`POST .../chat_conversations` 建会话时落库,列表 GET 把它们返回(按 updated_at 倒序)。元素另有 `ChatConversationWithNestedMessage`(带最近一条消息,用于列表预览)。
- `GET .../recents` 现返回 `{}`:App 期望 `ProjectRecentsResponse` 形(非空对象/列表)。先返回安全空壳(如 `{"recents": []}`),再按真实数据填充。

## C. projects(全部 something went wrong)

`projects_v2` 列表 OK,但点进任意 project 触发的 `GET .../projects/{id}` 及其子端点(docs/conversations/kb/stats)全未实现 → 详情页崩。按 project 详情最小集实现:`projects/{id}`(项目元数据)、`projects/{id}/conversations`(该项目会话列表,`ChatConversationWithProjectReference`)、`projects/{id}/docs`(知识库文档列表)、`projects/{id}/kb/stats`(`{document_count,...}` 统计)。写操作 PUT/POST/resync 可先返回合法占位。

## D. cowork

- 入口受 `current_user_access` 里 `cowork` + `mobile_cowork_tab_enabled` 控制(见 A1)。
- 端点族(App 内常量):`/api/organizations/{org}/cowork/scheduled_tasks/{triggerId}`、cowork session / scheduled_runs 等;对应"远程/定时 agent 会话"(与本项目 Remote Control 账号隔离目标吻合)。先实现列表类 GET 返回空壳,逐个按点击补。
- `GET .../experiences` 未实现:cowork/experiences surface 的配置,先返回合法空壳。

## E. 其余未实现(次要,先返回合法空壳即可)

`mcp/v2/bootstrap`(MCP 工具,返回空工具集)、`memory/settings`、`notification/preferences`(PATCH 回显)。

---
建议顺序:A(改 app_start:current_user_access + thinking)→ 重启服务 → 用户点一遍验证模型/thinking → 再 C/B/D。改完 app_start **务必保证仍能反序列化**(字段缺失或枚举值错 → App 又回 "Something went wrong")。
