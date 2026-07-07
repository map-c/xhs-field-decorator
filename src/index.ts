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
  // 优先 link（钉钉 Link 字段真实 URL），再 url，最后 text（纯文本列）。
  return (value.link || value.url || value.text || '').trim();
}

// execute 第二参数的真实结构（钉钉调试态与上架一致，实测确认）：
//   { formData: { <formKey>: { type:'fieldRef', value:{ fieldId } } | 直接值 },
//     sharedFields: { <fieldId>: { fieldName, fieldType, value } } }
// FieldSelect 引用的列，值不在 formData 里，而要用 fieldId 去 sharedFields 查。
interface FieldRef {
  type?: string;
  value?: { fieldId?: string };
}
interface SharedField {
  fieldId?: string;
  fieldName?: string;
  fieldType?: string;
  value?: LinkCellValue;
}
interface ExecuteParams {
  formData?: Record<string, FieldRef | LinkCellValue>;
  sharedFields?: Record<string, SharedField>;
}

// 从 execute 入参里解析出「笔记链接」配置项引用列在当前行的真实链接。
function resolveNoteLink(params: ExecuteParams): string {
  const ref = params?.formData?.noteLink;
  if (!ref) return '';
  // 字段引用：拿 fieldId 去 sharedFields 取该列在当前行的单元格值。
  if (typeof ref === 'object' && (ref as FieldRef).type === 'fieldRef') {
    const fid = (ref as FieldRef).value?.fieldId;
    return fid ? pickUrl(params?.sharedFields?.[fid]?.value) : '';
  }
  // 兜底：某些场景 formData 里直接就是值（string 或 {url/link/text}）。
  return pickUrl(ref as LinkCellValue);
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
      errEmpty: '链接为空，请在引用字段里填入小红书笔记链接',
      errFetch: '采集失败',
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
      errEmpty: 'Link is empty; fill the referenced field with a Xiaohongshu note link',
      errFetch: 'Extract failed',
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
      errEmpty: 'リンクが空です。参照フィールドに小紅書ノートリンクを入力してください',
      errFetch: '取得に失敗しました',
    },
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

  execute: async (context, params: ExecuteParams) => {
    const link = resolveNoteLink(params);
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
      if (d.status !== 'ok') {
        const reason = d.status ? `${d.status}${d.error ? `（${d.error}）` : ''}` : 'unknown';
        return {
          code: FieldExecuteCode.Error,
          data: null,
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
        msg: `采集失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

export default fieldDecoratorKit;
