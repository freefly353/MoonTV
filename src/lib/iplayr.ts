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
 */

const RULE_CACHE_TTL = 10 * 60 * 1000;
const ruleCache = new Map<string, { ts: number; spider: any }>();

async function loadSpider(site: ApiSite): Promise<any> {
  const now = Date.now();
  const hit = ruleCache.get(site.api);
  if (hit && now - hit.ts < RULE_CACHE_TTL) {
    return hit.spider;
  }
  const resp = await fetch(site.api, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    },
  });
  if (!resp.ok) {
    throw new Error(`iPlayr 规则拉取失败: ${resp.status}`);
  }
  const rule = await resp.json();
  const spider = createIPlayrSpider(rule, { key: site.key, name: site.name });
  ruleCache.set(site.api, { ts: now, spider });
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

export async function searchIPlayr(
  site: ApiSite,
  query: string
): Promise<SearchResult[]> {
  try {
    const spider = await loadSpider(site);
    const data: any = await withTimeout<any>(spider.search(query), 15000, { list: [] });
    const list = Array.isArray(data?.list) ? data.list : [];
    return list.map((item: any) => ({
      id: String(item.vod_id ?? ''),
      title: String(item.vod_name ?? '').trim(),
      poster: String(item.vod_pic ?? ''),
      episodes: [],
      source: site.key,
      source_name: site.name,
      class: String(item.vod_remarks ?? ''),
      year: yearOf(String(item.vod_remarks ?? '')),
      desc: '',
      type_name: '',
    }));
  } catch (_) {
    return [];
  }
}

export async function detailIPlayr(
  site: ApiSite,
  id: string
): Promise<SearchResult> {
  const spider = await loadSpider(site);
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
    id: String(vod.vod_id ?? id),
    title: String(vod.vod_name ?? ''),
    poster: String(vod.vod_pic ?? ''),
    episodes: episodes.filter(Boolean),
    source: site.key,
    source_name: site.name,
    class: '',
    year: 'unknown',
    desc: cleanHtmlTags(String(vod.vod_content ?? '')),
    type_name: '',
  };
}
