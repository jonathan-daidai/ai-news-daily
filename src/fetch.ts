const UA = 'Mozilla/5.0 (compatible; ai-news/1.0)';
const ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8';

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function once(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: ACCEPT, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    // 5xx 值得重试，4xx 不值得
    (err as Error & { retryable?: boolean }).retryable = res.status >= 500;
    throw err;
  }
  return res.text();
}

/**
 * 刻意不用 rss-parser 的 parseURL —— 自己发请求才拿得到 UA、超时和重试的控制权。
 * 网络错误/超时/5xx 重试一次，仅一次。
 */
export async function fetchText(url: string): Promise<string> {
  try {
    return await once(url);
  } catch (e) {
    const retryable = (e as { retryable?: boolean }).retryable !== false;
    if (!retryable) throw e;
    await sleep(RETRY_DELAY_MS);
    return once(url);
  }
}
