/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { ApiSite } from '@/lib/config';
import { wrapM3u8Proxy } from '@/lib/proxy';
import { SearchResult } from '@/lib/types';

/**
 * XPTV 蜘蛛源（type: 'xptv'）
 * api 字段填蜘蛛 JS 的 URL；detail 字段可选填蜘蛛配置 JSON 字符串
 * （注入为宿主 $config_str）。
 *
 * 服务端拉取蜘蛛 JS 后用 new Function 求值，注入 XPTV 宿主垫片
 * （$fetch/$cache/$config_str/$print/local），再调用其
 * search/getTracks/getPlayinfo 接口并映射为 SearchResult。
 * 注意：这是服务端执行远程 JS，仅应添加自己信任的蜘蛛。
 */

interface XptvSpider {
  getConfig?: () => string;
  getCards?: (ext: string) => Promise<string>;
  getTracks?: (ext: string) => Promise<string>;
  getPlayinfo?: (ext: string) => Promise<string>;
  getPlayUrl?: (ext: string) => Promise<string>;
  search?: (ext: string) => Promise<string>;
}

const SPIDER_CACHE_TTL = 10 * 60 * 1000;
const spiderCache = new Map<string, { ts: number; spider: XptvSpider }>();

// Edge 运行时（Cloudflare Workers / Vercel Edge）禁止 new Function 动态求值，
// XPTV 蜘蛛在这些运行时上无法执行，探测一次后直接禁用并给出明确提示。
let evalSupportedCache: boolean | null = null;
function isEvalSupported(): boolean {
  if (evalSupportedCache !== null) return evalSupportedCache;
  try {
    new Function('return 1')();
    evalSupportedCache = true;
  } catch (_) {
    evalSupportedCache = false;
  }
  return evalSupportedCache;
}

export const XPTV_UNSUPPORTED_MSG =
  'XPTV 源在当前运行时不受支持（Edge 禁止动态代码执行），请改用 Node 部署';

function makeCacheShim() {
  const store = new Map<string, string>();
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: any) => {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
  };
}

function makeFetchShim() {
  const doFetch = async (
    url: string,
    method: string,
    body: any,
    opts: any
  ) => {
    const resp = await fetch(url, {
      method,
      headers: (opts && opts.headers) || {},
      body: method === 'POST' ? body : undefined,
    });
    const text = await resp.text();
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { data: text, body: text, status: resp.status, headers };
  };
  return {
    get: (url: string, opts?: any) => doFetch(url, 'GET', undefined, opts),
    post: (url: string, body?: any, opts?: any) =>
      doFetch(url, 'POST', body ?? '', opts),
  };
}

async function loadSpider(site: ApiSite): Promise<XptvSpider> {
  if (!isEvalSupported()) {
    throw new Error(XPTV_UNSUPPORTED_MSG);
  }
  const now = Date.now();
  const hit = spiderCache.get(site.api);
  if (hit && now - hit.ts < SPIDER_CACHE_TTL) {
    return hit.spider;
  }
  const resp = await fetch(site.api, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    },
  });
  if (!resp.ok) {
    throw new Error(`XPTV 蜘蛛拉取失败: ${resp.status}`);
  }
  const code = await resp.text();

  const factory = new Function(
    'fetch',
    'setTimeout',
    'clearTimeout',
    'console',
    '$cache',
    '$config_str',
    '$fetch',
    '$print',
    'local',
    `${code}
;return {
  getConfig: typeof getConfig !== 'undefined' ? getConfig : undefined,
  getCards: typeof getCards !== 'undefined' ? getCards : undefined,
  getTracks: typeof getTracks !== 'undefined' ? getTracks : undefined,
  getPlayinfo: typeof getPlayinfo !== 'undefined' ? getPlayinfo : undefined,
  getPlayUrl: typeof getPlayUrl !== 'undefined' ? getPlayUrl : undefined,
  search: typeof search !== 'undefined' ? search : undefined,
};`
  );

  const cacheShim = makeCacheShim();
  const spider = factory(
    fetch,
    setTimeout,
    clearTimeout,
    console,
    cacheShim,
    site.detail || '',
    makeFetchShim(),
    (...args: any[]) => console.log('[xptv]', ...args),
    cacheShim
  ) as XptvSpider;

  spiderCache.set(site.api, { ts: now, spider });
  return spider;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function parseSpiderJson(raw: any): any {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return {};
  }
}

function cardToResult(site: ApiSite, card: any): SearchResult {
  const remarks = String(card?.vod_remarks ?? card?.remark ?? '');
  return {
    id: String(card?.vod_id ?? card?.id ?? ''),
    title: String(card?.vod_name ?? card?.name ?? '').trim(),
    poster: String(card?.vod_pic ?? card?.pic ?? ''),
    episodes: [],
    source: site.key,
    source_name: site.name,
    class: remarks,
    year: remarks.match(/\d{4}/)?.[0] || 'unknown',
    desc: '',
    type_name: '',
  };
}

export async function searchXptv(
  site: ApiSite,
  query: string
): Promise<SearchResult[]> {
  try {
    const spider = await loadSpider(site);
    if (!spider.search) return [];
    const raw = await withTimeout(
      spider.search(JSON.stringify({ text: query, page: 1 })),
      15000,
      ''
    );
    const data = parseSpiderJson(raw);
    const list = Array.isArray(data?.list) ? data.list : [];
    return list.map((card: any) => cardToResult(site, card));
  } catch (_) {
    return [];
  }
}

async function findCardMeta(
  spider: XptvSpider,
  id: string
): Promise<{ title: string; poster: string }> {
  // getTracks 不返回影片信息，尽力从 getCards 里按 id 找标题/海报
  if (!spider.getCards) return { title: '', poster: '' };
  for (const ext of [{ page: 1 }, { group: 'all', page: 1 }]) {
    try {
      const raw = await withTimeout(
        spider.getCards(JSON.stringify(ext)),
        10000,
        ''
      );
      const data = parseSpiderJson(raw);
      const list = Array.isArray(data?.list) ? data.list : [];
      const found = list.find(
        (c: any) => String(c?.vod_id ?? c?.id ?? '') === String(id)
      );
      if (found) {
        return {
          title: String(found.vod_name ?? found.name ?? ''),
          poster: String(found.vod_pic ?? found.pic ?? ''),
        };
      }
    } catch (_) {
      /* 继续尝试下一组参数 */
    }
  }
  return { title: '', poster: '' };
}

export async function detailXptv(
  site: ApiSite,
  id: string
): Promise<SearchResult> {
  const spider = await loadSpider(site);
  if (!spider.getTracks) {
    throw new Error('XPTV 蜘蛛缺少 getTracks 接口');
  }
  const rawTracks = await withTimeout(
    spider.getTracks(JSON.stringify({ id })),
    30000,
    ''
  );
  const tracksData = parseSpiderJson(rawTracks);
  const groups = Array.isArray(tracksData?.list) ? tracksData.list : [];
  const group = groups.find(
    (g: any) => Array.isArray(g?.tracks) && g.tracks.length > 0
  );
  const tracks = (group?.tracks || []).slice(0, 200);

  const playFn = spider.getPlayinfo || spider.getPlayUrl;
  const episodes: string[] = [];
  if (playFn) {
    const resolved = await Promise.all(
      tracks.map(async (track: any) => {
        try {
          const ext =
            track?.ext && typeof track.ext === 'object'
              ? track.ext
              : { id };
          const raw = await withTimeout(
            playFn(JSON.stringify(ext)),
            20000,
            ''
          );
          const info = parseSpiderJson(raw);
          const urls: string[] = Array.isArray(info?.urls)
            ? info.urls
            : info?.url
              ? [info.url]
              : [];
          const url = String(urls[0] || '');
          if (!url) return '';
          const header =
            (Array.isArray(info?.headers) ? info.headers[0] : info?.header) ||
            {};
          return wrapM3u8Proxy(url, header as Record<string, string>);
        } catch (_) {
          return '';
        }
      })
    );
    episodes.push(...resolved.filter(Boolean));
  }

  const meta = await findCardMeta(spider, id);

  return {
    id: String(id),
    title: meta.title || String(id),
    poster: meta.poster,
    episodes,
    source: site.key,
    source_name: site.name,
    class: '',
    year: 'unknown',
    desc: '',
    type_name: '',
  };
}
