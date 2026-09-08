import { decodeEntities } from './normalize.ts';

const UA = 'Mozilla/5.0 (compatible; ai-news/1.0)';
const ACCEPT = 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5';

const TIMEOUT_MS = 12_000;
/** 单篇正文送进模型的上限。粗算 1 token ≈ 2.5 字符，1.2 万字符约 5k token */
const MAX_CHARS = 12_000;
/** 短于此长度基本可以断定是 cookie 墙 / 空壳页，不值得花 token */
const MIN_CHARS = 240;
/** 只下载前 2MB，防止误踩巨型页面 */
const MAX_BYTES = 2 * 1024 * 1024;

/** 整块丢弃：脚本、样式、模板，以及导航/页脚这类模板噪音 */
const DROP_BLOCKS =
  /<(script|style|noscript|svg|template|head|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** 这些标签的边界要变成换行，否则相邻段落会粘成一坨 */
const BLOCK_TAGS = /<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre)\b[^>]*>/gi;
/** 控制字符，但放过 \n —— 后面靠它保留段落结构 */
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** 明显不是正文的整页拦截，命中就当作抓不到 */
const WALL_RE =
  /(enable javascript and cookies|verify you are a human|checking your browser|请开启 ?javascript|subscribe to (?:continue|read)|this content is available to subscribers)/i;

/**
 * Vertex AI 上没有服务端 web_fetch 工具，正文只能自己抓。
 * 这里不做 readability 级别的正文抽取 —— 摘要只需要 40-60 字，
 * 模板噪音对结论影响有限，够用就行。
 *
 * @returns 正文纯文本；抓不到 / 不是网页 / 内容太短时返回 null
 */
export async function extractArticleText(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: ACCEPT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch {
    // 超时、DNS、TLS、连接重置：一律当作抓不到，不重试（摘要不值得）
    return null;
  }

  if (!res.ok) return null;

  // PDF、图片、纯 JSON 接口等直接放弃
  const contentType = res.headers.get('content-type') ?? '';
  if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) return null;

  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) return null;

  let html: string;
  try {
    html = await res.text();
  } catch {
    return null;
  }
  if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);

  const text = htmlToText(html);
  if (text.length < MIN_CHARS || WALL_RE.test(text.slice(0, 1500))) return null;

  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(DROP_BLOCKS, ' ')
      .replace(BLOCK_TAGS, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(CONTROL_CHARS, ' ')
    // 行内折叠空白，行间最多留一个空行 —— 保留段落结构，砍掉缩进噪音
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
