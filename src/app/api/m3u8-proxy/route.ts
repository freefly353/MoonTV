/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';

/**
 * m3u8 代理：服务端带请求头拉上游清单/分片，清单内 URI 重写回本站。
 * 供 iPlayr / XPTV 源使用（上游按 UA 拦截、播放需自定义头时）。
 * 路由受 middleware 登录保护，非公开代理。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

function b64urlDecode(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function resolveUrl(maybeRel: string, base: string): string {
  const s = (maybeRel || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  try {
    return new URL(s, base).toString();
  } catch (_) {
    return s;
  }
}

function proxyUrlFor(upstream: string, hParam: string): string {
  return `/api/m3u8-proxy?u=${encodeURIComponent(upstream)}${hParam ? `&h=${hParam}` : ''}`;
}

function rewritePlaylist(
  text: string,
  upstreamUrl: string,
  hParam: string
): string {
  const lines = String(text || '').split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      out.push(line);
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      out.push(line);
      if (i + 1 < lines.length && lines[i + 1] && !lines[i + 1].startsWith('#')) {
        out.push(proxyUrlFor(resolveUrl(lines[i + 1].trim(), upstreamUrl), hParam));
        i++;
      }
      continue;
    }
    if (
      line.startsWith('#EXT-X-KEY') ||
      line.startsWith('#EXT-X-MAP') ||
      line.startsWith('#EXT-X-MEDIA')
    ) {
      out.push(
        line.replace(/URI="([^"]+)"/g, (_m, uri) =>
          `URI="${proxyUrlFor(resolveUrl(uri, upstreamUrl), hParam)}"`
        )
      );
      continue;
    }
    if (line.startsWith('#')) {
      out.push(line);
      continue;
    }
    out.push(proxyUrlFor(resolveUrl(line.trim(), upstreamUrl), hParam));
  }
  return out.join('\n');
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const u = searchParams.get('u') || '';
  const hParam = searchParams.get('h') || '';
  if (!/^https?:\/\//i.test(u)) {
    return NextResponse.json({ error: 'invalid u' }, { status: 400 });
  }

  let extraHeaders: Record<string, string> = {};
  if (hParam) {
    try {
      extraHeaders = JSON.parse(b64urlDecode(hParam)) || {};
    } catch (_) {
      extraHeaders = {};
    }
  }
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    ...extraHeaders,
  };
  const range = request.headers.get('range');
  if (range) headers['Range'] = range;

  let resp: Response;
  try {
    resp = await fetch(u, { headers, redirect: 'follow' });
  } catch (e: any) {
    return NextResponse.json(
      { error: `upstream fetch failed: ${String(e?.message || e).slice(0, 120)}` },
      { status: 502 }
    );
  }
  if (!resp.ok && resp.status !== 206) {
    return new NextResponse('upstream error', { status: 502 });
  }

  const contentType = resp.headers.get('content-type') || '';
  const finalUrl = resp.url || u;
  const looksPlaylist =
    /mpegurl/i.test(contentType) || /\.m3u8(\?|#|$)/i.test(finalUrl);

  if (looksPlaylist) {
    const text = await resp.text();
    if (text.trimStart().startsWith('#EXTM3U')) {
      return new NextResponse(rewritePlaylist(text, finalUrl, hParam), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        },
      });
    }
    // 不是清单内容则原样透传
    return new NextResponse(text, {
      status: 200,
      headers: { 'Content-Type': contentType || 'text/plain' },
    });
  }

  const outHeaders: Record<string, string> = {
    'Content-Type': contentType || 'application/octet-stream',
    'Cache-Control': 'no-store',
  };
  const contentRange = resp.headers.get('content-range');
  if (contentRange) outHeaders['Content-Range'] = contentRange;
  const contentLength = resp.headers.get('content-length');
  if (contentLength) outHeaders['Content-Length'] = contentLength;

  return new NextResponse(resp.body, {
    status: resp.status,
    headers: outHeaders,
  });
}
