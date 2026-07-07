# xhs-field-decorator

小红书笔记采集的**钉钉 AI 表格 AI 字段（FaaS 版）**。与边栏插件（`dingtalk-plugin/`）并行，
共用同一个已上线的采集 API `https://caiji.aipaint.cc/extract`。

> 这是「AI 字段」入口：行级、声明式——在「链接」列填好笔记链接，本字段逐行自动采集并把结果
> 写进**一个 Object 摘要单元格**，引用列变更时自动重算。无需点按钮（区别于边栏插件的手动交互）。

## 形态：单个 Object 字段 = 文本摘要 + 图片附件（一次配置全带出）

一个 Object 字段，属性包含：标题（主属性）/作者/正文/点赞/收藏/评论/转发/发布时间/
**图片（Attachment）**/采集状态/采集时间。配置时勾「获取扩展信息」可把每个属性自动同步成
独立列（host 原生能力），其中「图片」是真正渲染的附件列。

要点（钉钉 FaaS，均已本地实测确认）：

- **Object 属性除文本外也支持 Attachment**：SDK 类型 `PureObjectFieldProperty` 允许
  `Text/Number/Link/Attachment`（钉钉开发文档「只支持文本」的说法已过时）。所以**不需要再单独做
  一个图片包**——一个 Object 字段就能同时带出文本摘要和渲染图片的附件列。
- **图片会被钉钉下载转存**：附件 url 给 `image_proxy_urls`（caiji 代理）后，钉钉服务端抓图
  存进自有 OSS，从 `alidocs2-zjk-cdn.dingtalk.com` 渲染，**图片持久、不随小红书 CDN 过期裂图**。
- **附件最多 5 张**：超过会报「最多上传5张图片」，故 `images` 封顶取前 5 张。
- 外部请求必须用 `context.fetch`（node-fetch 语法），不能用 axios/got。
- 域名白名单 `setDomainList(['caiji.aipaint.cc'])`，只填域名。

> 早期曾拆成两个包（本字段只出文本 + 一个只出图的 Attachment 包）；实测确认 Object 属性
> 支持 Attachment 后已合并到本字段，原独立图片包已删除。

## 开发 / 调试

```bash
npm install
npm run typecheck     # 类型自检
npm run start         # 启动本地 FaaS 调试服务（dingtalk-docs-cool-app start:field）
```

在 AI 表格里：插件 → 「AI 字段开发助手」→「FaaS 调试」→ 添加字段 → 选本 FaaS 字段 → 调试。

> ⚠️ 调试态限制：只触发**当前视图第一行**、需常驻本地服务、**不支持自动更新**（自动更新只能上架后体验）。
> Chrome 需关 web-security 才能 https→http：
>
> ```bash
> open -na "Google Chrome" --args --user-data-dir="/tmp/chrome_dev_test" --disable-web-security --disable-site-isolation-trials --disable-features=BlockInsecurePrivateNetworkRequests
> ```

### FaaS `execute` 入参结构（按官方文档取值）

`execute(context, formData)` 的第二参数就是 `formData`，`formData.<key>` **直接是引用列在当前行的单元格值**（`string` 或 `{ url/link/text }`）：

```jsonc
{ "noteLink": "https://www.xiaohongshu.com/..." }   // 或 { "noteLink": { "link": "https://..." } }
```

本项目用 `pickUrl(formData.noteLink)` 取值即可。

> ⚠️ **不要依赖 `sharedFields` / `fieldRef`**：开发环境曾把底层优化的中间结构（`formData.noteLink` 变成 `{ type:'fieldRef', value:{ fieldId } }`、真值挪到 `sharedFields[fieldId].value`）透出给字段代码。**官方明确回复这是开发环境的问题代码，底层优化不应对开发者透出，线上无此问题，按文档对接即可，下个版本开发环境也会修正。** 早期为此写过 `resolveNoteLink()` 走 `sharedFields`，已回退。

### 错误如何透出给用户

- `msg` **不向用户透出**（官方 execute.md：仅供开发者排查），且运行时不做 i18n 占位替换。
- 要让用户看到失败原因，用 **`errorMessage`（key）+ `errorMessages`（i18n 映射）**，且**仅 `code=FieldExecuteCode.Error` 时生效**。
- 本字段按采集 `status` 映射：`login_required / redirected / empty / empty_shell` → 各自的用户文案，其余落 `fetch_failed`；同时保留 `msg` 带具体 status/error 供开发排查。

> 排查过程见 `docs/钉钉AI表格插件接入与踩坑记录.md` 坑 7。

## 打包 / 上架

```bash
npm run build         # dingtalk-docs-cool-app pack:field
```

上架走**人工审核**（填上架申请表单，专员拉群），非自助。表单参考见
`.claude/skills/ai-table-plugin-generator/ai-field-decorator-generator/references/`。

## 与采集 API 的契约

`GET /extract?url=<encoded>&retries=2` → `{ ok, data }`，本字段用到的 `data` 键：
`title / content / author / liked_count / collected_count / comment_count / share_count /
publish_time / image_proxy_urls[] / status / fetched_at`。仅 `status==='ok'` 写入卡片，
其余（login_required/redirected/empty/error）返回错误态（见「错误如何透出给用户」）让用户可见并手动重试。

## 新需求

- 采集时间格式化
- 增加文章仿写功能
