# xhs-field-decorator

小红书笔记采集的**钉钉 AI 表格 AI 字段（FaaS 版）**。

在表格的「链接」列填入小红书笔记链接，本字段逐行调用采集 API
`https://caiji.aipaint.cc/extract`，把结果写进**一个 Object 单元格**（标题/作者/正文/点赞/
收藏/评论/转发/发布时间/图片/采集状态/采集时间），引用列变更时自动重算。

## 字段形态

单个 Object 字段，`extra.properties` 含以下属性；勾选「获取扩展信息」可把每个属性自动同步成
独立列：

| 属性 | 类型 | 说明 |
|---|---|---|
| 标题 | Text（primary） | 笔记标题 |
| 作者 | Text | 作者昵称 |
| 正文 | Text | 正文内容 |
| 点赞数 / 收藏数 / 评论数 / 转发数 | Text | 互动数据（可能是「1.2万」展示串，故用文本） |
| 发布时间 | Text | 北京时间字符串 |
| **图片** | **Attachment** | 笔记图片，最多 5 张；附件 URL 由钉钉服务端下载转存后渲染 |
| 采集状态 | Text | `ok` / `login_required` / … |
| 采集时间 | Text | ISO 时间戳 |

## 关键实现说明

- **外部请求**：仅访问采集 API，域名白名单 `setDomainList(['caiji.aipaint.cc'])`；通过
  `context.fetch` 调用（node-fetch 语法），未使用 axios/got 等被禁库。
- **无需授权**：采集 API 为公开只读接口，不涉及任何密钥 / 用户凭证，故未配置 `authorizations`。
- **输入**：`FieldSelect` 支持 `Link` / `Text` 两种链接列。
- **结果一致性**：`resultType` 为 `Object`，与 `execute` 返回的数据结构严格对应；仅当采集
  `status === 'ok'` 时写入，其余（login_required/redirected/empty/error）返回错误码 + 文案，
  让用户可见并手动重试。
- **图片**：`images` 属性为 `Attachment`，`execute` 返回
  `[{ fileName, type: 'image', url }]`（`url` 用采集 API 的图片代理地址，公开可访问）；
  附件字段有「最多 5 张」上限，故封顶取前 5 张。
- **i18n**：`zh-CN` / `en-US` / `ja-JP` 三语。

入口代码全部在 `src/index.ts`（单文件）。

## 构建 / 自检

```bash
npm install
npm run typecheck     # tsc 类型自检
npm run build         # dingtalk-docs-cool-app pack:field，产出上架包
```

## 本地调试

```bash
npm run start         # 启动本地 FaaS 调试服务（dingtalk-docs-cool-app start:field）
```

在 AI 表格里：插件 →「字段模板开发助手」→「FaaS 调试」→ 添加字段 → 选本 FaaS 字段 → 调试。

> 调试态只触发当前视图第一行、需常驻本地服务、不支持自动更新（自动更新为上架后能力）。

## 采集 API 契约

`GET /extract?url=<encodeURIComponent>&retries=2` → `{ ok, data }`，本字段用到的 `data` 键：

```
title / content / author / liked_count / collected_count / comment_count /
share_count / publish_time / image_proxy_urls[] / status / fetched_at
```
