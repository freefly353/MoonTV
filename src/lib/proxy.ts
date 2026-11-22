/**
 * m3u8 代理 URL 包装：把上游播放地址改写为本站 /api/m3u8-proxy 地址，
 * 由服务端带指定请求头（UA/Referer 等）拉上游并重写清单。
 * 用于 iPlayr / XPTV 源：上游常按 UA 拦截非浏览器请求，浏览器又设不了 UA。
 */

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function wrapM3u8Proxy(
  url: string,
  headers?: Record<string, string>
): string {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  let h = '';
  if (headers && Object.keys(headers).length > 0) {
    h = `&h=${b64urlEncode(JSON.stringify(headers))}`;
  }
  return `/api/m3u8-proxy?u=${encodeURIComponent(url)}${h}`;
}
