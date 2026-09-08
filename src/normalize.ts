import { decodeHTML } from 'entities';

const ENTITY_RE = /&(#\d+|#x[0-9a-f]+|[a-z]+);/i;

/**
 * xml2js 已经解过一层实体，但 TechCrunch 的标题本身就是转义过的，
 * 于是实际会出现 `&amp;#8217;` 这类双重编码。只有当第一轮解码后
 * 仍然残留实体时才解第二轮 —— 最多两轮，避免标题里真有 `&amp;`
 * 时被过度解码成 `&`。
 */
export function decodeEntities(input: string): string {
  const once = decodeHTML(input);
  return ENTITY_RE.test(once) ? decodeHTML(once) : once;
}

/** 解码 → 去标签（兜底 Verge 的 type="html" 标题）→ 去控制字符 → 折叠空白 */
export function cleanTitle(input: string | undefined): string {
  if (!input) return '';
  return decodeEntities(input)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 feed 的 description/summary 压成一段纯文本，供摘要模块当补充上下文 */
export function cleanSnippet(input: string | undefined, maxLen = 600): string | undefined {
  const text = cleanTitle(input);
  if (!text) return undefined;
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** 反斜杠转义 Markdown 链接文本里会破坏结构的字符 */
export function escapeMdLinkText(input: string): string {
  return input.replace(/([\\\[\]*_`])/g, '\\$1');
}

/** 表格单元格：在链接文本转义基础上再处理 `|` 和换行 */
export function escapeMdTable(input: string): string {
  return escapeMdLinkText(input).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/** 正文里的摘要：折叠换行，转义会被误读成结构的字符 */
export function escapeMdText(input: string): string {
  return input.replace(/\s*\n\s*/g, ' ').replace(/([\\\[\]*_`])/g, '\\$1').trim();
}

/**
 * 含括号的 URL 会截断朴素的 Markdown 链接解析器，用尖括号包住。
 */
export function mdLinkTarget(url: string): string {
  return /[()\s]/.test(url) ? `<${url}>` : url;
}

const TRACKING_PARAMS = new Set([
  'ref',
  'ref_src',
  'source',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'igshid',
]);

function stripTracking(u: URL): void {
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(key) || TRACKING_PARAMS.has(key.toLowerCase())) {
      u.searchParams.delete(key);
    }
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
}

/**
 * `display` 用于展示，`key` 用于去重与缓存。
 * key 额外做：host 小写、去 www.、协议统一 https、query 参数排序。
 * 路径**不**转小写 —— 路径是大小写敏感的。
 */
export function normalizeUrl(raw: string): { display: string; key: string } {
  let display: URL;
  try {
    display = new URL(raw);
  } catch {
    return { display: raw, key: raw };
  }
  stripTracking(display);

  const key = new URL(display.toString());
  key.protocol = 'https:';
  key.hostname = key.hostname.toLowerCase().replace(/^www\./, '');
  key.searchParams.sort();

  return { display: display.toString(), key: key.toString() };
}
