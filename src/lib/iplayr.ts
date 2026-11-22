/* eslint-disable @typescript-eslint/no-explicit-any */

import { ApiSite } from '@/lib/config';
import { wrapM3u8Proxy } from '@/lib/proxy';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';

import { createIPlayrSpider } from './iplayr-core';

/**
 * TVpods / iPlayr 规则源（type: 'iplayr'）
 * api 字段填规则 JSON 的 URL；规则由 iplayr-core 解释器执行，
 * 搜索/详情结果映射为 MoonTV 的 SearchResult。
 * 播放地址统一走 /api/m3u8-proxy（带规则的 UA/Referer 拉上游，
 * 避开上游按 UA 拦截，如 lumenbox 对非浏览器 UA 返回 403）。
 *
 * api 也可以填聚合订阅清单（如 dp 仓库 import.json：{ vods: [...] }），
 * 其中 type=8 的条目是 iPlayr 规则，会被展开为多个规则并行搜索，
 * 结果合并到这一个源下（结果 id 带规则序号前缀，详情按序号路由）。
 */

const RULE_CACHE_TTL = 10 * 60 * 1000;
const spiderCache = new Map<string, { ts: number; spider: any }>();

interface SubEntry {
  title: string;
  url: string;
}
type Manifest =
  | { kind: 'rule'; rule: any }
  | { kind: 'sub'; entries: SubEntry[] };
const manifestCache = new Map<string, { ts: number; manifest: Manifest }>();

const FETCH_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { headers: { 'User-Agent': FETCH_UA } });
  if (!resp.ok) {
    throw new Error(`iPlayr 拉取失败: ${resp.status} ${url}`);
  }
  return resp.json();
}

function detectManifest(json: any): Manifest {
  // dp import.json 格式：{ vods: [{ title, url, type, ... }] }，type=8 为 iPlayr 规则
  const list = Array.isArray(json?.vods)
    ? json.vods
    : Array.isArray(json)
      ? json
      : null;
  if (list) {
    const entries: SubEntry[] = list
      .filter((v: any) => v && typeof v.url === 'string' && (v.type === 8 || v.type === '8'))
      .map((v: any) => ({ title: String(v.title || ''), url: String(v.url) }));
    if (entries.length > 0) {
      return { kind: 'sub', entries };
    }
  }
  return { kind: 'rule', rule: json };
}

async function loadManifest(site: ApiSite): Promise<Manifest> {
  const now = Date.now();
  const hit = manifestCache.get(site.api);
  if (hit && now - hit.ts < RULE_CACHE_TTL) {
    return hit.manifest;
  }
  const json = await fetchJson(site.api);
  const manifest = detectManifest(json);
  manifestCache.set(site.api, { ts: now, manifest });
  return manifest;
}

async function loadRuleSpider(url: string, key: string, name: string): Promise<any> {
  const now = Date.now();
  const hit = spiderCache.get(url);
  if (hit && now - hit.ts < RULE_CACHE_TTL) {
    return hit.spider;
  }
  const rule = await fetchJson(url);
  const spider = createIPlayrSpider(rule, { key, name });
  spiderCache.set(url, { ts: now, spider });
  return spider;
}

async function getSingleSpider(site: ApiSite, rule: any): Promise<any> {
  const now = Date.now();
  const hit = spiderCache.get(site.api);
  if (hit && now - hit.ts < RULE_CACHE_TTL) {
    return hit.spider;
  }
  const spider = createIPlayrSpider(rule, { key: site.key, name: site.name });
  spiderCache.set(site.api, { ts: now, spider });
  return spider;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function yearOf(remarks: string): string {
  return remarks?.match(/\d{4}/)?.[0] || 'unknown';
}

function mapSearchList(
  list: any[],
  site: ApiSite,
  sourceName: string,
  idPrefix: string
): SearchResult[] {
  return list.map((item: any) => ({
    id: `${idPrefix}${String(item.vod_id ?? '')}`,
    title: String(item.vod_name ?? '').trim(),
    poster: String(item.vod_pic ?? ''),
    episodes: [],
    source: site.key,
    source_name: sourceName,
    class: String(item.vod_remarks ?? ''),
    year: yearOf(String(item.vod_remarks ?? '')),
    desc: '',
    type_name: '',
  }));
}

async function searchWithSpider(
  spider: any,
  query: string,
  site: ApiSite,
  sourceName: string,
  idPrefix: string
): Promise<SearchResult[]> {
  const data: any = await withTimeout<any>(spider.search(query), 15000, { list: [] });
  const list = Array.isArray(data?.list) ? data.list : [];
  return mapSearchList(list, site, sourceName, idPrefix);
}

export async function searchIPlayr(
  site: ApiSite,
  query: string
): Promise<SearchResult[]> {
  try {
    const manifest = await loadManifest(site);
    if (manifest.kind === 'rule') {
      const spider = await getSingleSpider(site, manifest.rule);
      return await searchWithSpider(spider, query, site, site.name, '');
    }
    // 聚合订阅：各规则并行搜索，结果合并；单个规则失败不影响其他
    const groups = await Promise.all(
      manifest.entries.map(async (entry, idx) => {
        try {
          const spider = await loadRuleSpider(
            entry.url,
            site.key,
            entry.title || site.name
          );
          return await searchWithSpider(
            spider,
            query,
            site,
            entry.title || site.name,
            `${idx}::`
          );
        } catch (_) {
          return [] as SearchResult[];
        }
      })
    );
    return groups.flat();
  } catch (_) {
    return [];
  }
}

async function detailWithSpider(
  spider: any,
  id: string,
  site: ApiSite,
  sourceName: string,
  idPrefix: string
): Promise<SearchResult> {
  const data: any = await withTimeout<any>(spider.detail(id), 30000, null);
  const vod = data?.list?.[0];
  if (!vod) {
    throw new Error('iPlayr 详情获取失败');
  }

  // vod_play_url: 线路间 $$$ 分隔，集间 # 分隔，集内 名称$地址
  // MoonTV 无线路概念，取第一条线路
  const playFrom = String(vod.vod_play_from || '').split('$$$');
  const playUrl = String(vod.vod_play_url || '').split('$$$');
  const flag = playFrom[0] || '';
  const epList = (playUrl[0] || '')
    .split('#')
    .map((ep: string) => {
      const idx = ep.indexOf('$');
      return idx >= 0 ? ep.slice(idx + 1) : ep;
    })
    .filter(Boolean)
    .slice(0, 200);

  const episodes = await Promise.all(
    epList.map(async (epId: string) => {
      try {
        const played: any = await withTimeout<any>(spider.play(flag, epId), 20000, null);
        const url = String(played?.url || '');
        if (!url) return '';
        const header = (played?.header || {}) as Record<string, string>;
        return wrapM3u8Proxy(url, header);
      } catch (_) {
        return '';
      }
    })
  );

  return {
    id: `${idPrefix}${String(vod.vod_id ?? id)}`,
    title: String(vod.vod_name ?? ''),
    poster: String(vod.vod_pic ?? ''),
    episodes: episodes.filter(Boolean),
    source: site.key,
    source_name: sourceName,
    class: '',
    year: 'unknown',
    desc: cleanHtmlTags(String(vod.vod_content ?? '')),
    type_name: '',
  };
}

export async function detailIPlayr(
  site: ApiSite,
  id: string
): Promise<SearchResult> {
  const manifest = await loadManifest(site);
  if (manifest.kind === 'rule') {
    const spider = await getSingleSpider(site, manifest.rule);
    return detailWithSpider(spider, id, site, site.name, '');
  }
  // 聚合订阅：id 形如 "<规则序号>::<原id>"，按序号路由到对应规则
  const sep = id.indexOf('::');
  const idx = sep > 0 ? parseInt(id.slice(0, sep), 10) : 0;
  const realId = sep > 0 ? id.slice(sep + 2) : id;
  const entry = manifest.entries[idx] || manifest.entries[0];
  if (!entry) {
    throw new Error('iPlayr 订阅无可用规则');
  }
  const spider = await loadRuleSpider(entry.url, site.key, entry.title || site.name);
  return detailWithSpider(spider, realId, site, entry.title || site.name, `${idx}::`);
}
