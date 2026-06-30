// 小红书笔记采集 —— 钉钉 AI 表格 AI 字段（FaaS 版，Object 摘要形态 A）
//
// 行级、声明式：在「链接」列填好小红书笔记链接，本 AI 字段逐行调用已上线的采集 API
// （https://caiji.aipaint.cc/extract），把标题/作者/正文/点赞/收藏/评论/转发/发布时间/
// 封面链接/状态/采集时间塞进一个 Object 单元格卡片。引用的链接列变更时自动重算。
//
// 设计约束（钉钉 FaaS）：一个字段=一列。Object 属性除文本外**也支持 Attachment**（SDK 类型
// PureObjectFieldProperty 允许 Text/Number/Link/Attachment，钉钉开发文档「只支持文本」的说法已过时）——
// 所以本字段在一个 Object 里同时带出文本摘要 + 图片附件，图片实测会被钉钉下载转存进自有 OSS、
// 真正渲染且持久（不随小红书 CDN 过期裂图）。复用 /extract 的 ?cache 边缘缓存（status=ok 缓存
// 10 分钟）。外部请求必须走 context.fetch（node-fetch 语法）。

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
}

// FieldSelect 选中的链接列，取到的单元格值：Link 字段是 {url,text}，Text 字段是 string。
type LinkCellValue = string | { url?: string; text?: string } | null | undefined;

function pickUrl(value: LinkCellValue): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  return (value.url || value.text || '').trim();
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
        // 图片做成 Attachment 属性：钉钉会把 url 下载转存并渲染成图（Object 属性支持 Attachment）。
        { key: 'images', type: FieldType.Attachment, title: t('pImages') },
        { key: 'status', type: FieldType.Text, title: t('pStatus') },
        { key: 'fetchedAt', type: FieldType.Text, title: t('pFetchedAt') },
      ],
    },
  },

  execute: async (context, formData: { noteLink: LinkCellValue }) => {
    const link = pickUrl(formData.noteLink);
    if (!link) {
      return {
        code: FieldExecuteCode.InvalidArgument,
        data: null,
        msg: t('errEmpty'),
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
          msg: `${t('errFetch')}：${reason}`,
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
          // 附件字段有「最多 5 张图」的平台上限，超出会报错，故封顶取前 5 张。
          images: (d.image_proxy_urls || []).slice(0, 5).map((url, i) => ({
            fileName: `小红书图_${i + 1}.jpg`,
            type: 'image',
            url,
          })),
          status: d.status || '',
          fetchedAt: d.fetched_at || '',
        },
      };
    } catch (error) {
      return {
        code: FieldExecuteCode.Error,
        data: null,
        msg: `${t('errFetch')}：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

export default fieldDecoratorKit;
