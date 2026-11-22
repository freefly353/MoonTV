/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

import { createIPlayrSpider } from '@/lib/iplayr-core';

export const runtime = 'edge';

/**
 * 源诊断接口（临时排查用）：/api/debug-source?key=<源key>&q=<关键词>
 * 分步报告规则/蜘蛛拉取与上游请求的实际状态，定位搜不到卡在哪一环。
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
    let rule: any = null;
    try {
      rule = JSON.parse(ruleRes.text);
    } catch (_) {
      rule = null;
    }
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
