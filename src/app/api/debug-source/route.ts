/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { detectManifest } from '@/lib/iplayr';
import { createIPlayrSpider } from '@/lib/iplayr-core';

export const runtime = 'edge';

/**
 * 源诊断接口（临时排查用）：/api/debug-source?key=<源key>&q=<关键词>
 * 分步报告规则/蜘蛛拉取与上游请求的实际状态，定位搜不到卡在哪一环。
 * iPlayr 聚合订阅清单（import.json 类）会逐条规则探测 searchFetch，
 * 用于判断各规则站点是否放行当前运行时出口（如 CF Workers 出口 IP）。
 * 受 middleware 登录保护。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

async function timedFetch(url: string, headers: Record<string, string>) {
  const started = Date.now();
  try {
    const resp = await fetch(url, { headers, redirect: 'follow' });
    const text = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      contentType: resp.headers.get('content-type') || '',
      ms: Date.now() - started,
      len: text.length,
      bodyHead: text.slice(0, 200),
      text,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      ms: Date.now() - started,
      len: 0,
      bodyHead: '',
      text: '',
      error: String(e?.message || e).slice(0, 200),
    };
  }
}

function jsonSummary(text: string) {
  try {
    const data = JSON.parse(text);
    const arr = Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.list)
        ? data.list
        : null;
    return { jsonOk: true, count: arr ? arr.length : null };
  } catch (_) {
    return { jsonOk: false, count: null };
  }
}

function fillTpl(tpl: string, vars: Record<string, string>) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) =>
    vars[k] !== undefined ? vars[k] : m
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key') || '';
  const q = searchParams.get('q') || 'test';
  if (!key) {
    return NextResponse.json({ error: 'missing key' }, { status: 400 });
  }

  const config = await getConfig();
  const site = (config.SourceConfig || []).find((s: any) => s.key === key);
  if (!site) {
    return NextResponse.json({ error: `source not found: ${key}` }, { status: 404 });
  }

  const type = site.type || 'maccms';
  const steps: Record<string, any> = {};

  if (type === 'iplayr') {
    const ruleRes = await timedFetch(site.api, { 'User-Agent': DEFAULT_UA });
    let parsed: any = null;
    try {
      parsed = JSON.parse(ruleRes.text);
    } catch (_) {
      parsed = null;
    }
    const manifest = parsed ? detectManifest(parsed) : null;
    if (manifest?.kind === 'sub') {
      // 聚合订阅清单：逐条规则探测。iplayr-core 的 search() 只发一次
      // search_url_first_page 请求，故 searchFetch 状态即代表该规则站点
      // 对当前运行时出口的放行情况；不再重复跑 spiderSearch 以免双倍子请求。
      // 子请求数 = 1（清单）+ 2×规则数，13 条规则约 27 个，在免费版限额内。
      const MAX_RULE_PROBES = 20;
      const entries = manifest.entries.slice(0, MAX_RULE_PROBES);
      steps.manifestFetch = {
        status: ruleRes.status,
        ok: ruleRes.ok,
        ms: ruleRes.ms,
        len: ruleRes.len,
        error: (ruleRes as any).error || undefined,
        jsonOk: !!parsed,
        kind: 'sub',
        entryCount: manifest.entries.length,
        probedCount: entries.length,
        truncated: manifest.entries.length > entries.length,
      };
      steps.rules = await Promise.all(
        entries.map(async (entry: any) => {
          const rRes = await timedFetch(entry.url, {
            'User-Agent': DEFAULT_UA,
          });
          let r: any = null;
          try {
            r = JSON.parse(rRes.text);
          } catch (_) {
            r = null;
          }
          const out: Record<string, any> = {
            title: entry.title,
            url: entry.url,
            ruleFetch: {
              status: rRes.status,
              ok: rRes.ok,
              ms: rRes.ms,
              error: (rRes as any).error || undefined,
              jsonOk: !!r,
              ruleTitle: r?.title || null,
              hasSearchUrl: !!r?.search_url_first_page,
            },
          };
          if (r?.search_url_first_page) {
            const ua = r.user_agent || r['user-agent'] || DEFAULT_UA;
            const headers: Record<string, string> = { 'User-Agent': ua };
            if (r.referer) headers['Referer'] = r.referer;
            const url = fillTpl(r.search_url_first_page, {
              wd: encodeURIComponent(q),
              pg: '1',
            });
            const s = await timedFetch(url, headers);
            out.searchFetch = {
              url,
              status: s.status,
              ok: s.ok,
              ms: s.ms,
              contentType: s.contentType,
              error: (s as any).error || undefined,
              ...jsonSummary(s.text),
              bodyHead: s.bodyHead,
            };
          }
          return out;
        })
      );
    } else {
      const rule = parsed;
      steps.ruleFetch = {
        status: ruleRes.status,
        ok: ruleRes.ok,
        ms: ruleRes.ms,
        len: ruleRes.len,
        error: (ruleRes as any).error || undefined,
        jsonOk: !!rule,
        ruleTitle: rule?.title || null,
        searchFlag: rule?.search_flag ?? null,
        hasSearchUrl: !!rule?.search_url_first_page,
        categoryCount: Array.isArray(rule?.category) ? rule.category.length : 0,
      };
      if (rule) {
        const ua = rule.user_agent || rule['user-agent'] || DEFAULT_UA;
        const headers: Record<string, string> = { 'User-Agent': ua };
        if (rule.referer) headers['Referer'] = rule.referer;

        if (rule.search_url_first_page) {
          const url = fillTpl(rule.search_url_first_page, {
            wd: encodeURIComponent(q),
            pg: '1',
          });
          const r = await timedFetch(url, headers);
          steps.searchFetch = {
            url,
            status: r.status,
            ok: r.ok,
            ms: r.ms,
            contentType: r.contentType,
            error: (r as any).error || undefined,
            ...jsonSummary(r.text),
            bodyHead: r.bodyHead,
          };
        }
        const cat0 = Array.isArray(rule.category) ? rule.category[0] : null;
        if (cat0?.url0) {
          const r = await timedFetch(cat0.url0, headers);
          steps.categoryFetch = {
            url: cat0.url0,
            status: r.status,
            ok: r.ok,
            ms: r.ms,
            contentType: r.contentType,
            error: (r as any).error || undefined,
            ...jsonSummary(r.text),
            bodyHead: r.bodyHead,
          };
        }
        try {
          const spider = createIPlayrSpider(rule, { key: site.key });
          const data: any = await (spider as any).search(q);
          steps.spiderSearch = { count: Array.isArray(data?.list) ? data.list.length : 0 };
        } catch (e: any) {
          steps.spiderSearch = { error: String(e?.message || e).slice(0, 200) };
        }
      }
    }
  } else if (type === 'xptv') {
    const jsRes = await timedFetch(site.api, { 'User-Agent': DEFAULT_UA });
    steps.jsFetch = {
      status: jsRes.status,
      ok: jsRes.ok,
      ms: jsRes.ms,
      len: jsRes.len,
      error: (jsRes as any).error || undefined,
    };
    try {
      const v = new Function('return 42')();
      steps.evalProbe = { ok: true, value: v };
    } catch (e: any) {
      steps.evalProbe = {
        ok: false,
        error: `${e?.name || 'Error'}: ${String(e?.message || e).slice(0, 160)}`,
      };
    }
  } else {
    const url = `${site.api}?ac=videolist&wd=${encodeURIComponent(q)}`;
    const r = await timedFetch(url, { 'User-Agent': DEFAULT_UA });
    steps.apiFetch = {
      url,
      status: r.status,
      ok: r.ok,
      ms: r.ms,
      contentType: r.contentType,
      error: (r as any).error || undefined,
      ...jsonSummary(r.text),
      bodyHead: r.bodyHead,
    };
  }

  return NextResponse.json(
    { key: site.key, name: site.name, type, api: site.api, q, steps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
