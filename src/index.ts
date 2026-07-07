// 小红书笔记采集 —— 钉钉 AI 表格 AI 字段（FaaS 版，Object 摘要形态 A）
//
// 行级、声明式：在「链接」列填好小红书笔记链接，本 AI 字段逐行调用已上线的采集 API
// （https://caiji.aipaint.cc/extract），把标题/作者/正文/点赞/收藏/评论/转发/发布时间/
// 封面链接/状态/采集时间塞进一个 Object 单元格卡片。引用的链接列变更时自动重算。
//
// 设计约束（钉钉 FaaS）：一个字段=一列。图片以**文本链接**形式输出（多张用换行分隔），
// 不再用 Attachment 附件——生产环境不支持附件形态，故统一降级为纯文本 URL，可直接复制/点开。
// 复用 /extract 的 ?cache 边缘缓存（status=ok 缓存 10 分钟）。外部请求必须走 context.fetch
// （node-fetch 语法）。

import { FieldType, fieldDecoratorKit, FormItemComponent, FieldExecuteCode } from 'dingtalk-docs-cool-app';
const { t } = fieldDecoratorKit;

// 采集 API 域名白名单：只填域名，不带协议/路径/端口，子域自动放通。
const EXTRACT_HOST = 'caiji.aipaint.cc';
fieldDecoratorKit.setDomainList([EXTRACT_HOST]);

// 采到一条返回的 data 契约（与 worker src/index.js 对齐，仅列出本字段用到的键）。
interface ExtractData {
  title?: string;
  content?: string;
  author?: string;
  liked_count?: string;
  collected_count?: string;
  comment_count?: string;
  share_count?: string;
  publish_time?: string;
  image_proxy_urls?: string[];
  status?: string;
  error?: string;
  fetched_at?: string;
  engine?: string; // 实际出数引擎：home-cdp=自研 / tikhub=第三方付费
}

// 单元格值可能形态：纯文本列是 string；钉钉 Link 字段是 { text, link }，有的是 { url, text }。
type LinkCellValue =
  | string
  | { url?: string; link?: string; text?: string }
  | null
  | undefined;

function pickUrl(value: LinkCellValue): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  // 按官方文档：Link 字段值是 { url, text }（formItems.md）。取 url，纯文本列走 text；
  // link 仅作历史兜底（个别环境曾出现），不再优先。
  return (value.url || value.link || value.text || '').trim();
}

// execute 第二参数按官方文档就是 formData：{ <formKey>: 单元格值 }。
// noteLink 直接是「笔记链接」引用列在当前行的值（string 或 { url/link/text }）。
//
// ⚠️ 不要再依赖 sharedFields / fieldRef：那是开发环境底层优化透出的中间结构，官方明确
// 回复「这是开发环境的问题代码，底层优化不应对开发者透出，线上无此问题，按文档对接即可，
// 下个版本开发环境也会修正」。故这里只按文档读 formData 的值。
interface ExecuteFormData {
  noteLink?: LinkCellValue;
}

fieldDecoratorKit.setDecorator({
  name: '小红书笔记采集',

  i18nMap: {
    'zh-CN': {
      noteLink: '笔记链接',
      pTitle: '标题',
      pAuthor: '作者',
      pContent: '正文',
      pLikes: '点赞数',
      pCollects: '收藏数',
      pComments: '评论数',
      pShares: '转发数',
      pPublishTime: '发布时间',
      pImages: '图片',
      pStatus: '采集状态',
      pFetchedAt: '采集时间',
      pSource: '采集来源',
      // 用户可见的失败文案（经 errorMessages 透出，按采集 status 映射）。
      eLoginRequired: '登录态失效，请刷新 Cookie 后重试',
      eRedirected: '链接已过期或失效，请重新分享获取新链接',
      eEmpty: '未找到笔记内容（可能已删除或设为私密）',
      eFetchFailed: '采集失败，请稍后重试',
    },
    'en-US': {
      noteLink: 'Note link',
      pTitle: 'Title',
      pAuthor: 'Author',
      pContent: 'Content',
      pLikes: 'Likes',
      pCollects: 'Collects',
      pComments: 'Comments',
      pShares: 'Shares',
      pPublishTime: 'Published',
      pImages: 'Images',
      pStatus: 'Status',
      pFetchedAt: 'Fetched at',
      pSource: 'Source',
      eLoginRequired: 'Login expired; refresh the cookie and retry',
      eRedirected: 'Link expired or invalid; re-share to get a fresh link',
      eEmpty: 'No note content found (deleted or private)',
      eFetchFailed: 'Extract failed; please retry later',
    },
    'ja-JP': {
      noteLink: 'ノートリンク',
      pTitle: 'タイトル',
      pAuthor: '作者',
      pContent: '本文',
      pLikes: 'いいね数',
      pCollects: '保存数',
      pComments: 'コメント数',
      pShares: 'シェア数',
      pPublishTime: '公開日時',
      pImages: '画像',
      pStatus: 'ステータス',
      pFetchedAt: '取得日時',
      pSource: '取得元',
      eLoginRequired: 'ログインが失効しました。Cookie を更新して再試行してください',
      eRedirected: 'リンクが失効しています。再共有して新しいリンクを取得してください',
      eEmpty: 'ノート内容が見つかりません（削除または非公開）',
      eFetchFailed: '取得に失敗しました。後でもう一度お試しください',
    },
  },

  // 用户可见错误：execute 返回 errorMessage=<key>，宿主展示这里映射到的 i18n 文案。
  // 注意 errorMessage 仅在 code=FieldExecuteCode.Error 时生效（execute.md）；msg 不向用户透出。
  errorMessages: {
    login_required: t('eLoginRequired'),
    redirected: t('eRedirected'),
    empty: t('eEmpty'),
    empty_shell: t('eEmpty'),
    fetch_failed: t('eFetchFailed'),
  },

  formItems: [
    {
      key: 'noteLink',
      label: t('noteLink'),
      component: FormItemComponent.FieldSelect,
      props: {
        mode: 'single',
        // Link 列优先；也允许把链接存成纯文本列。
        supportTypes: [FieldType.Link, FieldType.Text],
      },
      validator: {
        required: true,
      },
    },
  ],

  // Object 摘要：所有属性都是文本，title 为唯一 primary（用于排序、不可隐藏）。
  resultType: {
    type: FieldType.Object,
    extra: {
      properties: [
        { key: 'title', type: FieldType.Text, title: t('pTitle'), primary: true },
        { key: 'author', type: FieldType.Text, title: t('pAuthor') },
        { key: 'content', type: FieldType.Text, title: t('pContent') },
        { key: 'likes', type: FieldType.Text, title: t('pLikes') },
        { key: 'collects', type: FieldType.Text, title: t('pCollects') },
        { key: 'comments', type: FieldType.Text, title: t('pComments') },
        { key: 'shares', type: FieldType.Text, title: t('pShares') },
        { key: 'publishTime', type: FieldType.Text, title: t('pPublishTime') },
        // 图片以文本链接输出（多张换行分隔）；生产环境不支持 Attachment，故用纯文本 URL。
        { key: 'images', type: FieldType.Text, title: t('pImages') },
        { key: 'status', type: FieldType.Text, title: t('pStatus') },
        { key: 'fetchedAt', type: FieldType.Text, title: t('pFetchedAt') },
        { key: 'source', type: FieldType.Text, title: t('pSource') },
      ],
    },
  },

  execute: async (context, formData: ExecuteFormData) => {
    const link = pickUrl(formData?.noteLink);
    if (!link) {
      return {
        code: FieldExecuteCode.InvalidArgument,
        data: null,
        // 注意：execute 运行时返回的 msg 不走 i18n 占位替换，必须给真实文案，
        // 不能用 t()（那会原样输出 ${{errEmpty}}）。
        msg: '未取到链接：请在字段配置里把「笔记链接」绑定到放链接的列，且该列当前行有值（调试态只触发第一行）。',
      };
    }

    try {
      const api = `https://${EXTRACT_HOST}/extract?url=${encodeURIComponent(link)}&retries=2`;
      const response = await context.fetch(api, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      const json = (await response.json()) as { ok?: boolean; data?: ExtractData };
      const d: ExtractData = json?.data || {};

      // 采集失败（login_required / redirected / empty / error 等）：返回错误态，让用户看到
      // 原因并可手动重试，不写入半成品卡片。
      // 用户看到的是 errorMessage 映射的 i18n 文案（errorMessages）；msg 仅供开发排查（带具体 status/error）。
      if (d.status !== 'ok') {
        const KNOWN = ['login_required', 'redirected', 'empty', 'empty_shell'];
        const key = KNOWN.includes(d.status || '') ? (d.status as string) : 'fetch_failed';
        const reason = d.status ? `${d.status}${d.error ? `（${d.error}）` : ''}` : 'unknown';
        return {
          code: FieldExecuteCode.Error,
          data: null,
          errorMessage: key,
          msg: `采集失败：${reason}`,
        };
      }

      return {
        code: FieldExecuteCode.Success,
        data: {
          title: d.title || '',
          author: d.author || '',
          content: d.content || '',
          likes: d.liked_count || '',
          collects: d.collected_count || '',
          comments: d.comment_count || '',
          shares: d.share_count || '',
          publishTime: d.publish_time || '',
          // 图片输出为文本链接，多张用换行分隔（不再受附件「最多 5 张」限制，全部带出）。
          images: (d.image_proxy_urls || []).join('\n'),
          status: d.status || '',
          fetchedAt: d.fetched_at || '',
          source:
            d.engine === 'home-cdp' ? '自研' : d.engine === 'tikhub' ? '第三方付费' : '',
        },
      };
    } catch (error) {
      return {
        code: FieldExecuteCode.Error,
        data: null,
        errorMessage: 'fetch_failed',
        msg: `采集异常：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

export default fieldDecoratorKit;
