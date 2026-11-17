#!/usr/bin/env node
/**
 * VetMCP — MCP-сервер ветеринарной экосистемы shray77: живые данные витрин
 * для ИИ-агентов через Model Context Protocol.
 *
 * Инструменты: погода и тепловые стрессы (49 станций Ростовской обл.),
 * вероятностный веер двух ансамблей ECMWF (физический IFS + ИИ-модель AIFS),
 * ретро-проверка прогноза, окна риска ВПГП, сигналы отзывов/вспышек РФ,
 * мировые биоугрозы, дайджест ветеринарной науки, эпидкарта вспышек РФ
 * 2005→сегодня (ВетКарта), справочник ветпрепаратов ChEMBL + предсказания
 * сродства Boltz-2 (VetInSilico).
 *
 * Транспорт: stdio, newline-delimited JSON-RPC 2.0 (транспорт MCP).
 * Версии протокола: 2024-11-05 / 2025-03-26 / 2025-06-18.
 * Зависимостей нет: Node ≥ 20 (глобальный fetch).
 *
 * Данные — открытые JSON-каналы GitHub Pages витрин (обновляются CI-ботами:
 * станции ~каждые 20 мин; отзывы/угрозы/дайджест — ежедневно). Сервер только
 * читает публичные данные, ничего не пишет и не пересылает наружу.
 */
import { createInterface } from 'node:readline';

export const SERVER_INFO = { name: 'vetmcp', version: '1.1.0' };

const RAW = 'https://raw.githubusercontent.com/shray77';
export const SOURCES = Object.freeze({
  latest:     `${RAW}/vet-meteo/main/data/latest.json`,
  stations:   `${RAW}/vet-meteo/main/data/stations.json`,
  forecast:   `${RAW}/vet-meteo/main/data/forecast.json`,
  ensemble:   `${RAW}/vet-meteo/main/data/ensemble.json`,
  verify:     `${RAW}/vet-meteo/main/data/verify.json`,
  flu:        `${RAW}/vetflu-site/main/data/model.json`,
  recalls:    `${RAW}/vetrecall-site/main/signals.json`,
  biothreats: `${RAW}/biothreat-site/main/events.json`,
  digest:     `${RAW}/vetdigest-site/main/digest.json`,
  epimap:     `${RAW}/vet-heatmap/main/public/data/outbreaks.json`,
  chembl:     `${RAW}/vet-insilico/main/public/data/chembl-reference.json`,
  boltz:      `${RAW}/vet-insilico/main/public/data/boltz-affinities.json`,
});

/* ─── кэш источников: TTL 5 мин, таймаут 15 с; fetcher инжектится в тестах ── */
export function makeCache(fetcher = fetch, ttlMs = 300000, timeoutMs = 15000) {
  const mem = new Map();
  return {
    async get(name) {
      const url = SOURCES[name];
      if (!url) throw new Error(`неизвестный источник: ${name}`);
      const hit = mem.get(name);
      if (hit && Date.now() - hit.at < ttlMs) return hit.data;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetcher(url, { signal: ctl.signal });
        if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
        const data = await r.json();
        mem.set(name, { at: Date.now(), data });
        return data;
      } finally {
        clearTimeout(t);
      }
    },
  };
}

/* ─── валидация параметров (руками, без схемных либ) ──────────────────────── */
export function vStation(v) {
  if (typeof v !== 'string' || !/^[a-z0-9_]{2,32}$/.test(v)) {
    throw new Error('station_id: ожидается идентификатор станции (латиница/цифры/подчёркивание), например "rostov"');
  }
  return v;
}
export function vLimit(v, def = 10, max = 50) {
  if (v == null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`limit: целое 1–${max}`);
  return n;
}
export function vQuery(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s === '' ? null : s.slice(0, 120);
}
export function vStatus(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'ongoing') return 'Ongoing';
  if (s === 'resolved') return 'Resolved';
  throw new Error('status: ожидается Ongoing (действующие) или Resolved (завершённые)');
}
export function vSince(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(s)) return s;
  throw new Error('since: ожидается год "2024" или дата "2024-06-01"');
}

const thiZone = (t) => (t >= 80 ? 'сильный стресс' : t >= 72 ? 'тепловой стресс' : t >= 68 ? 'лёгкий стресс' : 'комфорт');
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? null : Number(x).toFixed(d));

/* ─── инструменты ─────────────────────────────────────────────────────────── */
/* Каждый: name/description/inputSchema (JSON Schema draft) + run(args, cache).
 * Возврат — обычный объект; сервер упакует его в content[0].text как JSON.   */

export const TOOLS = [
  {
    name: 'vet_weather_now',
    description: 'Погода и тепловая нагрузка КРС по 49 станциям Ростовской области (ВетРадар-61): THI/THIadj, ветер, осадки, BRD-риск. Без station_id — сводка по области (топ стрессовых станций), с station_id — детально по станции.',
    inputSchema: {
      type: 'object',
      properties: {
        station_id: { type: 'string', description: 'идентификатор станции (например, rostov, salsk); без него — сводка по области' },
      },
    },
    async run(args, cache) {
      const L = await cache.get('latest');
      const st = (L.stations || []).filter((s) => s && s.thi != null);
      if (!st.length) throw new Error('срез пуст — источник обновляется, попробуйте позже');
      const base = { generatedAt: L.generatedAt, region: L.region, stations: st.length };
      if (args.station_id != null) {
        vStation(args.station_id);
        const s = st.find((x) => x.id === args.station_id);
        if (!s) throw new Error(`станция не найдена: ${args.station_id} (список — вызовите без station_id)`);
        return {
          ...base, station: {
            id: s.id, name: s.name, t: s.t, rh: s.rh, wind: s.wind, wdir: s.wdir,
            precip24: s.precip24, THI: s.thi, zone: thiZone(s.thi),
            THIadj: s.thiAdj != null ? s.thiAdj : null,
            THImax_7d: s.thiMax7, BRD_risk: s.brd,
          },
        };
      }
      const top = [...st].sort((a, b) => b.thi - a.thi).slice(0, 5)
        .map((s) => ({ name: s.name, THI: s.thi, zone: thiZone(s.thi), T: s.t, THImax_7d: s.thiMax7 }));
      return {
        ...base,
        hottest_now: top,
        stations_THI_over_72: st.filter((s) => s.thi >= 72).length,
        max_wind: Math.max(...st.map((s) => s.wind || 0)),
        note: 'THI: 68/72/80 — пороги стресса КРС; THIadj — Mader 2006 (ветер+солнце); BRD — риск бронхопневмонии телят, %',
      };
    },
  },
  {
    name: 'vet_weather_forecast',
    description: 'Почасовой прогноз на 48 ч по станции: THI/THIadj час за часом, осадки, ветер, окна тепловой нагрузки (THI>72/80).',
    inputSchema: {
      type: 'object',
      properties: { station_id: { type: 'string', description: 'идентификатор станции (например, rostov)' } },
      required: ['station_id'],
    },
    async run(args, cache) {
      const F = await cache.get('forecast');
      const id = vStation(args.station_id);
      const s = (F.stations || []).find((x) => x.id === id);
      if (!s) throw new Error(`станция не найдена в прогнозе: ${id}`);
      const thi = s.thi || [];
      const win72 = [];
      let inWin = null;
      thi.forEach((v, k) => {
        if (v > 72 && !inWin) inWin = { from: k, peak: v, peakAt: k };
        if (v > 72 && inWin) { if (v > inWin.peak) { inWin.peak = v; inWin.peakAt = k; } }
        if (v <= 72 && inWin) { win72.push({ fromHour: inWin.from, toHour: k, hours: k - inWin.from, peakTHI: inWin.peak, peakAtHour: inWin.peakAt }); inWin = null; }
      });
      if (inWin) win72.push({ fromHour: inWin.from, toHour: thi.length, hours: thi.length - inWin.from, peakTHI: inWin.peak, peakAtHour: inWin.peakAt });
      return {
        generatedAt: F.generatedAt, fromHourMsk: F.h0, hours: F.hours,
        station: { id: s.id, name: s.name },
        THI: thi, THIadj: s.thiAdj || null, precip_mm: s.precip || null, wind_ms: s.wind || null,
        windows_THI_over_72: win72,
        note: 'часы отсчитываются от fromHourMsk; окна — часы с THI>72 (порог 80 — сильный стресс)',
      };
    },
  },
  {
    name: 'vet_weather_ensemble',
    description: 'Вероятностный прогноз на 7 дней по станции: ДВА ансамбля ECMWF — физический IFS 0.25° и ИИ-модель AIFS 0.25° (по 50 членов): p10/p50/p90 THImax и вероятность P(THImax>72 / >80) по дням. Расхождение медиан — мера неопределённости («второе мнение»).',
    inputSchema: {
      type: 'object',
      properties: { station_id: { type: 'string', description: 'идентификатор станции (например, rostov)' } },
      required: ['station_id'],
    },
    async run(args, cache) {
      const E = await cache.get('ensemble');
      const id = vStation(args.station_id);
      const s = (E.stations || {})[id];
      if (!s || !s.ifs) throw new Error(`ансамбль не найден для станции: ${id}`);
      const days = (s.dates || []).map((d, k) => {
        const row = { date: d, IFS: { p10: s.ifs.p10[k], p50: s.ifs.p50[k], p90: s.ifs.p90[k], P72: s.ifs.p72[k], P80: s.ifs.p80[k] } };
        if (s.aifs && s.aifs.p50) row.AIFS = { p10: s.aifs.p10[k], p50: s.aifs.p50[k], p90: s.aifs.p90[k], P72: s.aifs.p72[k], P80: s.aifs.p80[k] };
        return row;
      });
      let maxDelta = 0, maxDeltaDay = null;
      if (s.aifs && s.aifs.p50) {
        s.ifs.p50.forEach((v, k) => {
          const d = Math.abs(v - s.aifs.p50[k]);
          if (d > maxDelta) { maxDelta = d; maxDeltaDay = s.dates[k]; }
        });
      }
      return {
        generatedAt: E.generatedAt, source: E.source,
        models: { ifs: E.models.ifs.label, aifs: s.aifs ? E.models.aifs.label : 'недоступна в этом срезе' },
        station: id, days,
        max_median_divergence: maxDelta ? { THI: fmt(maxDelta), date: maxDeltaDay } : null,
        note: 'p10/p50/p90 — перцентили суточного THImax по 50 членам; P72/P80 — доля членов с THImax>72/>80',
      };
    },
  },
  {
    name: 'vet_forecast_quality',
    description: 'Ретро-проверка прогнозов ВетРадара: слой А — бэктест модели за 30 дней против ERA5-реанализа (MAE THI/T/RH/ветер, bias, окна THI>68/72: POD/FAR); слой А2 — бэктест ИИ-модели AIFS против того же ERA5; слой Б — точность собственных выпусков 48 ч по горизонтам.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, cache) {
      const V = await cache.get('verify');
      const m = V.model || {};
      const r = V.radar || {};
      return {
        generatedAt: V.generatedAt,
        overall_verdict: V.verdict,
        layer_A_best_match_vs_ERA5: {
          window: `${m.from}…${m.to}`, stations: m.stations, hours: m.hours,
          MAE: m.mae, bias: m.bias,
          windows_THI68: m.win68 || null, windows_THI72: m.win72 || null,
        },
        layer_A2_AIFS_vs_ERA5: m.aifs
          ? { model: m.aifs.model, window: `${m.aifs.from}…${m.aifs.to}`, MAE: m.aifs.mae, bias: m.aifs.bias, windows_THI72: m.aifs.win72 || null }
          : 'слой ещё копит данные (пересчёт раз в 12 ч)',
        layer_B_own_48h_forecasts: {
          issues: r.issues, stationHours: r.hours, span: r.span,
          byHorizon: r.horizons || null,
        },
        note: 'MAE в THI-баллах/°C/м/с; POD — доля пойманных событий, FAR — доля ложных тревог',
      };
    },
  },
  {
    name: 'vet_flu_windows',
    description: 'Окна риска заноса высокопатогенного гриппа птиц в РФ (модель VetFlu): текущий уровень тревоги, пороги и топ регионов-узлов по вероятности заноса.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'сколько регионов показать (1–50, по умолчанию 10)' } },
    },
    async run(args, cache) {
      const M = await cache.get('flu');
      const limit = vLimit(args.limit, 10, 50);
      const flat = [];
      for (const [node, list] of Object.entries(M.nodes || {})) {
        for (const r of list) flat.push({ node, region: r.name, p: fmt(r.p, 2), channel: r.chan, channel_value: r.chan_value, min_distance_km: r.min_km, wintering: r.wintering });
      }
      flat.sort((a, b) => Number(b.p) - Number(a.p));
      return {
        model_version: M.version, generatedAt: M.generated_at,
        alert: { level: (M.alert || {}).level, max_r: (M.alert || {}).max_r, thresholds: (M.alert || {}).thresholds, note: (M.alert || {}).note },
        top_regions: flat.slice(0, limit),
        note: 'p — вероятность заноса в узле; channel — канал (transit/...); пороги: ok<45≤watch<75≤alert (max_r)',
      };
    },
  },
  {
    name: 'vet_outbreaks_russia',
    description: 'Сигналы отзывов и вспышек РФ (ВетОтзывы): неблагонадёжные партии продукции, карантинные мероприятия, нарушения — с вердиктом ИИ-разметки и регионом.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'сколько сигналов (1–50, по умолчанию 10)' },
        query: { type: 'string', description: 'фильтр по словам в заголовке (например, "африканская чума")' },
      },
    },
    async run(args, cache) {
      const D = await cache.get('recalls');
      const limit = vLimit(args.limit);
      const q = vQuery(args.query);
      let items = (D.items || []).filter((x) => x && x.title);
      if (q) items = items.filter((x) => (x.title + ' ' + (x.summary || '') + ' ' + (x.disease || '')).toLowerCase().includes(q));
      items = items.slice(0, limit).map((x) => ({
        published: x.published_at, type: x.signal_type, region: x.region, disease: x.disease || null,
        product: x.product || null, verdict: x.verdict, title: x.title, url: x.url,
      }));
      return { generatedAt: D.generated_at, total: (D.items || []).length, shown: items.length, filtered_by: q || null, items };
    },
  },
  {
    name: 'vet_biothreats',
    description: 'Мировые биоугрозы (БиоУгрозы мира): международные события по карантинным болезням животных с ИИ-сводками, уровнем и дистанцией от Ростовской области.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'сколько событий (1–50, по умолчанию 10)' },
        disease: { type: 'string', description: 'фильтр по болезни (например, "африканская чума свиней")' },
        country: { type: 'string', description: 'фильтр по стране' },
      },
    },
    async run(args, cache) {
      const D = await cache.get('biothreats');
      const limit = vLimit(args.limit);
      const dis = vQuery(args.disease);
      const ctry = vQuery(args.country);
      let items = (D.items || []).filter((x) => x && x.title);
      if (dis) items = items.filter((x) => String(x.disease || '').toLowerCase().includes(dis));
      if (ctry) items = items.filter((x) => String(x.country || '').toLowerCase().includes(ctry));
      items = items.slice(0, limit).map((x) => ({
        published: x.published_at, disease: x.disease, country: x.country, level: x.level,
        verdict: x.verdict, distance_km: x.distance_km, title: x.title, ai_summary: x.ai_summary, url: x.url,
      }));
      return { generatedAt: D.generated_at, total: (D.items || []).length, shown: items.length, filters: { disease: dis, country: ctry }, items };
    },
  },
  {
    name: 'vet_digest',
    description: 'Дайджест ветеринарной науки (ВетДайджест): свежие публикации с извлечённой пользой (impact, takeaways) и ссылками на DOI.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'сколько публикаций (1–50, по умолчанию 10)' },
        query: { type: 'string', description: 'фильтр по словам в заголовке/выводах' },
      },
    },
    async run(args, cache) {
      const D = await cache.get('digest');
      const limit = vLimit(args.limit);
      const q = vQuery(args.query);
      let items = (D.items || []).filter((x) => x && x.title);
      if (q) items = items.filter((x) => (x.title + ' ' + (x.takeaways || '')).toLowerCase().includes(q));
      items = items.slice(0, limit).map((x) => ({
        digest_date: x.digest_date, published: x.published_at, source: x.source_id,
        title: x.title, impact: x.impact, takeaways: x.takeaways, url: x.url,
      }));
      return { generatedAt: D.generated_at, total: (D.items || []).length, shown: items.length, filtered_by: q || null, items };
    },
  },
  {
    name: 'vet_epimap',
    description: 'Эпидкарта вспышек карантинных болезней животных РФ (ВетКарта): события WAHIS+ФСВПС 2005→сегодня (бешенство, лейкоз, бруцеллёз, АЧС, ящур и др.). Без фильтров — сводка по стране (топ болезней, динамика по годам, округа); с фильтрами — выборка и свежие события. Обновление 4 раза в сутки.',
    inputSchema: {
      type: 'object',
      properties: {
        disease: { type: 'string', description: 'фильтр по болезни — имя или ключ (например, "бешенство", "asf", "африканская чума")' },
        region: { type: 'string', description: 'фильтр по региону — подстрока (например, "Ростов", "Амурская")' },
        federal_district: { type: 'string', description: 'фильтр по федеральному округу (ЦФО, ЮФО, СФО, ДФО, ПФО, УрФО, СЗФО, СКФО)' },
        status: { type: 'string', description: 'Ongoing — действующие, Resolved — завершённые' },
        since: { type: 'string', description: 'только события с этой даты: год "2024" или дата "2024-06-01"' },
        limit: { type: 'integer', description: 'сколько событий показать (1–50, по умолчанию 10)' },
      },
    },
    async run(args, cache) {
      const D = await cache.get('epimap');
      const all = (D.outbreaks || []).filter((x) => x && x.date);
      if (!all.length) throw new Error('срез пуст — источник обновляется, попробуйте позже');
      const dis = vQuery(args.disease);
      const reg = vQuery(args.region);
      const fd = vQuery(args.federal_district);
      const status = vStatus(args.status);
      const since = vSince(args.since);
      const limit = vLimit(args.limit);
      let sel = all;
      if (dis) sel = sel.filter((x) => (String(x.disease || '') + ' ' + String(x.disease_key || '')).toLowerCase().includes(dis));
      if (reg) sel = sel.filter((x) => String(x.region || '').toLowerCase().includes(reg));
      if (fd) sel = sel.filter((x) => String(x.federal_district || '').toLowerCase().includes(fd));
      if (status) sel = sel.filter((x) => String(x.status || '') === status);
      if (since) sel = sel.filter((x) => String(x.date) >= since);
      const tally = (rows, key) => Object.entries(rows.reduce((m, x) => { const k = x[key] || '—'; m[k] = (m[k] || 0) + 1; return m; }, {}))
        .sort((a, b) => b[1] - a[1]);
      const years = tally(sel, 'date').map(([y, n]) => [y.slice(0, 4), n])
        .reduce((m, [y, n]) => { m[y] = (m[y] || 0) + n; return m; }, {});
      return {
        updated: D.updated, sources: D.sources, total_in_dataset: D.total_outbreaks ?? all.length,
        filters: { disease: dis, region: reg, federal_district: fd, status, since },
        matched: sel.length,
        ongoing: sel.filter((x) => x.status === 'Ongoing').length,
        top_diseases: tally(sel, 'disease').slice(0, 8).map(([disease, n]) => ({ disease, n })),
        by_year_recent: Object.entries(years).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 8),
        by_district: tally(sel, 'federal_district').slice(0, 8).map(([district, n]) => ({ district, n })),
        items: [...sel].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit).map((x) => ({
          date: x.date, disease: x.disease, disease_key: x.disease_key, group: x.disease_group || null,
          region: x.region, district: x.federal_district || null, status: x.status, species: x.species || null,
          cases: x.cases || 0, deaths: x.deaths || 0, source: x.source, url: x.source_url || null,
        })),
        note: 'ВетКарта: вспышки карантинных болезней животных РФ, WAHIS+ФСВПС, 2005→сегодня; date — дата регистрации события; координаты и карта — на витрине',
      };
    },
  },
  {
    name: 'vet_drug_reference',
    description: 'Справочник ветеринарных препаратов (VetInSilico): свойства 180+ молекул из среза ChEMBL (MW, logP, PSA, нарушения Липинского, фаза, механизмы действия) и предсказанные аффинности Boltz-2 для пар препарат–мишень. Без inn — сводка со списком предсказаний; с inn — карточки препаратов.',
    inputSchema: {
      type: 'object',
      properties: {
        inn: { type: 'string', description: 'название или начало названия препарата латиницей (например, "amox", "rimantadine"); без него — сводка' },
        limit: { type: 'integer', description: 'сколько препаратов (1–50, по умолчанию 10)' },
      },
    },
    async run(args, cache) {
      const C = await cache.get('chembl');
      const B = await cache.get('boltz');
      const drugs = (C.drugs || []).filter(Boolean);
      if (!drugs.length) throw new Error('срез ChEMBL пуст — источник обновляется, попробуйте позже');
      const pairs = (B.pairs || []).filter(Boolean);
      const limit = vLimit(args.limit);
      const inn = vQuery(args.inn);
      const r2 = (x) => (x == null || Number.isNaN(Number(x)) ? null : Math.round(Number(x) * 100) / 100);
      const affOf = (p) => ({
        inn: p.inn, target: p.target_name, target_id: p.target_id, pdb: p.pdb_id || null,
        ic50_um_est: r2(p.ic50_um_est), delta_g_kcal_mol: r2(p.delta_g_kcal_mol),
        confidence: r2(p.confidence && p.confidence.confidence_score), status: p.status,
        reference_ic50_um: (p.reference && p.reference.ic50_um) || null,
      });
      const base = {
        chembl_version: C.version, chembl_updated: C.generated,
        boltz: { model: B.model, updated: B.generated, pairs: pairs.length },
      };
      if (inn != null) {
        const found = drugs.filter((x) => String(x.inn || '').toLowerCase().includes(inn) || String(x.pref_name || '').toLowerCase().includes(inn));
        if (!found.length) throw new Error(`препарат не найден: ${args.inn} (поиск по INN латиницей, например "amox"; без inn — сводка со списком)`);
        return {
          ...base, matched: found.length,
          items: found.slice(0, limit).map((d) => {
            const pr = d.properties || {};
            return {
              inn: d.inn, chembl_id: d.chembl_id, type: d.molecule_type, max_phase: d.max_phase,
              first_approval: d.first_approval ?? null, oral: d.oral ?? null, parenteral: d.parenteral ?? null,
              withdrawn: !!d.withdrawn_flag,
              properties: { MW: pr.full_mwt ?? null, alogp: pr.alogp ?? null, HBA: pr.hba ?? null, HBD: pr.hbd ?? null, PSA: pr.psa ?? null, Ro5_violations: pr.num_ro5_violations ?? null },
              mechanisms: (d.mechanisms || []).slice(0, 3).map((m) => `${m.action_type} → ${m.target_name}`),
              boltz_affinity: pairs.filter((p) => String(p.inn || '').toLowerCase() === String(d.inn || '').toLowerCase()).map(affOf),
            };
          }),
          note: 'меньше IC50 / более отрицательный dG = сильнее связывание (Boltz-2 affinity head); свойства считаны RDKit по каноническим структурам ChEMBL',
        };
      }
      return {
        ...base, drugs_total: drugs.length,
        affinity_predictions: pairs.map(affOf),
        note: 'ChEMBL-срез ветеринарных препаратов + предсказания сродства Boltz-2; срезы обновляет CI VetInSilico (ChEMBL — еженедельно); задайте inn для карточки препарата',
      };
    },
  },
];

/* Все инструменты активны; реестр для tools/list: */
const ACTIVE_TOOLS = TOOLS;

/* ─── JSON-RPC / MCP слой ─────────────────────────────────────────────────── */
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

export function createServer({ cache } = {}) {
  const c = cache || makeCache();
  const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  return {
    /** Обработать одно сообщение; null — уведомление (ответа не требует). */
    async handleMessage(msg) {
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return err(msg && msg.id, -32600, 'невалидный запрос');
      const { id, method, params } = msg;
      const reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
      if (typeof method !== 'string') return err(id, -32600, 'нет method');
      if (method.startsWith('notifications/')) return null; // initialized, cancelled, roots/*
      switch (method) {
        case 'initialize': {
          const asked = params && params.protocolVersion;
          const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
          return reply({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
        }
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: ACTIVE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const name = params && params.name;
          const tool = ACTIVE_TOOLS.find((t) => t.name === name);
          if (!tool) return err(id, -32602, `неизвестный инструмент: ${name}`);
          try {
            const result = await tool.run((params && params.arguments) || {}, c);
            return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
          } catch (e) {
            /* ошибка инструмента — не фатальная: MCP ждёт isError-результат */
            return reply({ isError: true, content: [{ type: 'text', text: `ошибка: ${e.message}` }] });
          }
        }
        default:
          return err(id, -32601, `метод не поддерживается: ${method}`);
      }
    },
  };
}

/* ─── stdio-цикл продакшена ───────────────────────────────────────────────── */
export async function runStdio(server = createServer()) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'ошибка парсинга JSON' } }) + '\n');
      return;
    }
    Promise.resolve(server.handleMessage(msg))
      .then((resp) => { if (resp) process.stdout.write(JSON.stringify(resp) + '\n'); })
      .catch((e) => process.stderr.write(`vetmcp: ${e.message}\n`));
  });
  return new Promise(() => {}); // работает, пока открыт stdin
}

if (process.argv[1] && process.argv[1].endsWith('vetmcp.mjs') && !process.env.VETMCP_TEST) {
  runStdio().catch((e) => { process.stderr.write(`vetmcp фатально: ${e.message}\n`); process.exit(1); });
}
