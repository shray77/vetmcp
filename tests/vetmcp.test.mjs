/*!
 * vetmcp.test.mjs — гейт MCP-сервера: протокол + инструменты на фикстурах.
 *
 * Классы:
 *  1. кэш источников — TTL, HTTP-ошибки, неизвестный источник (fetcher-стаб);
 *  2. валидаторы — station_id/limit/query, мусор перечисляется явно;
 *  3. JSON-RPC/MCP — initialize (все версии протокола), ping, tools/list,
 *     notifications молчат, неизвестный метод −32601, неизвестный инструмент −32602;
 *  4. инструменты — 10 шт. на fixture-данных: поля ответов, фильтры, честные
 *     ошибки (нет станции, пустой срез), isError-результат вместо падения;
 *  5. продакшн-смоук — реестр истоников валиден (все URL raw.githubusercontent).
 *
 * Запуск: node --test tests/vetmcp.test.mjs   (CI: .github/workflows/ci.yml)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer, makeCache, SOURCES, TOOLS, SERVER_INFO } from '../vetmcp.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ---------- фикстуры (реальные формы данных витрин, обрезаны) ---------- */
const FIX = {
  latest: {
    generatedAt: '2026-11-17T16:21:00Z', region: 'Ростовская область',
    stations: [
      { id: 'rostov', name: 'Ростов-на-Дону', t: 8.1, rh: 62, wind: 5.2, wdir: 250, precip24: 0, thi: 48.2, thiAdj: 47.1, thiMax7: 57.9, brd: 31 },
      { id: 'salsk', name: 'Сальск', t: 9.0, rh: 55, wind: 4.1, wdir: 210, precip24: 2, thi: 50.1, thiAdj: 49.5, thiMax7: 58.4, brd: 40 },
      { id: 'taganrog', name: 'Таганрог', t: 7.2, rh: 70, wind: 6.0, wdir: 270, precip24: 6, thi: 46.0, thiAdj: null, thiMax7: 55.0, brd: 22 },
    ],
  },
  forecast: {
    generatedAt: '2026-11-17T16:21:00Z', h0: '2026-11-17T19:00', hours: 48,
    stations: [{
      id: 'rostov', name: 'Ростов-на-Дону',
      thi: [42, 44, 46, 73, 75, 71, 60, 81, 79],
      thiAdj: [41, 43, 45, 72, 74, 70, 59, 80, 78],
      precip: [0, 0, 0.2, 0, 0, 1.1, 0, 0, 0], wind: [3, 3, 4, 5, 5, 6, 4, 3, 3],
    }],
  },
  ensemble: {
    generatedAt: '2026-11-17T15:30:00Z', source: 'open-meteo ensemble API',
    models: { ifs: { label: 'IFS 0.25°' }, aifs: { label: 'AIFS 0.25°' } },
    stations: {
      rostov: {
        dates: ['2026-11-18', '2026-11-19'],
        ifs: { p10: [44, 45], p50: [48, 52], p90: [52, 57], p72: [0, 0.1], p80: [0, 0] },
        aifs: { p10: [43, 44], p50: [46, 50], p90: [50, 55], p72: [0, 0.05], p80: [0, 0] },
      },
    },
  },
  verify: {
    generatedAt: '2026-11-17T16:21:26Z', verdict: 'умеренные', thi: 1.4,
    model: {
      from: '2026-10-18', to: '2026-11-16', stations: 49, hours: 35280,
      mae: { t: 0.8, thi: 1.4 }, bias: { t: -0.2, thi: -0.3 },
      win68: { pod: 65.4, far: 8.2 }, win72: { obs: 1, misses: 1, pod: 0 },
      aifs: { model: 'ecmwf_aifs025_single', from: '2026-10-18', to: '2026-11-16', mae: { t: 0.9, thi: 1.6 }, bias: { t: 0.1, thi: 0.2 }, win72: { obs: 1, hits: 1, pod: 100 } },
    },
    radar: { issues: 177, hours: 97314, span: ['10-18', '11-17'], horizons: [{ h: '1–3 ч', n: 2499, maeThi: 0.4 }] },
  },
  flu: {
    version: 'v4.2', generated_at: '2026-11-17T06:00:00Z',
    alert: { level: 'alert', max_r: 98, thresholds: { watch: 45, alert: 75 }, note: 'ok<45≤watch<75≤alert' },
    nodes: {
      ea: [
        { name: 'Калининград', p: 0.64, chan: 'transit', chan_value: 75, min_km: 227, wintering: true },
        { name: 'Санкт-Петербург', p: 0.41, chan: 'transit', chan_value: 40, min_km: 700, wintering: false },
      ],
      s: [{ name: 'Дагестан', p: 0.83, chan: 'wintering', chan_value: 90, min_km: 0, wintering: true }],
    },
  },
  recalls: {
    generated_at: '2026-11-17T07:00:00Z',
    items: [
      { published_at: '2026-11-16', signal_type: 'recall', region: 'Смоленская обл.', disease: null, product: 'молоко', verdict: 'confirmed', title: 'Отзыв партии молока', url: 'https://example.ru/1', summary: 'нарушение' },
      { published_at: '2026-11-15', signal_type: 'outbreak', region: 'Дагестан', disease: 'оспа овец', product: null, verdict: 'probable', title: 'Оспа овец в Дагестане', url: 'https://example.ru/2', summary: 'подозрение' },
    ],
  },
  biothreats: {
    generated_at: '2026-11-17T08:00:00Z',
    items: [
      { published_at: '2026-11-16', disease: 'африканская чума свиней', country: 'Греция', level: 'высокий', verdict: 'confirmed', distance_km: 1500, title: 'ASF in Greece', ai_summary: 'вспышка на ферме', url: 'https://example.org/1' },
      { published_at: '2026-11-15', disease: 'ящур', country: 'Турция', level: 'средний', verdict: 'probable', distance_km: 300, title: 'FMD in Anatolia', ai_summary: '...', url: 'https://example.org/2' },
    ],
  },
  digest: {
    generated_at: '2026-11-17T07:01:00Z',
    items: [
      { digest_date: '2026-11-17', published_at: '2026-11-16', source_id: 'pubmed-vet', title: 'Analgesia in trauma', impact: 'high', takeaways: 'премедикация снижает боль', url: 'https://doi.org/10.1/x' },
    ],
  },
  epimap: {
    updated: '2026-11-17', sources: ['wahis', 'fsvps'], total_outbreaks: 6,
    outbreaks: [
      { id: 1, disease_key: 'rabies', disease: 'Бешенство', disease_group: 'Wildlife', region: 'Белгородская область', federal_district: 'ЦФО', date: '2026-10-29', species: 'Wildlife', cases: 0, deaths: 0, status: 'Ongoing', source: 'fsvps', source_url: 'https://fsvps.gov.ru/x' },
      { id: 2, disease_key: 'asf', disease: 'Африканская чума свиней', disease_group: 'Swine', region: 'Ростовская область', federal_district: 'ЮФО', date: '2026-09-12', species: 'Swine', cases: 340, deaths: 210, status: 'Ongoing', source: 'wahis', source_url: 'https://wahis.woah.org/2' },
      { id: 3, disease_key: 'asf', disease: 'Африканская чума свиней', disease_group: 'Swine', region: 'Воронежская область', federal_district: 'ЦФО', date: '2025-03-01', species: 'Swine', cases: 0, deaths: 0, status: 'Resolved', source: 'fsvps', source_url: 'https://fsvps.gov.ru/3' },
      { id: 4, disease_key: 'leukosis', disease: 'Лейкоз КРС', disease_group: 'Ruminant', region: 'Амурская область', federal_district: 'ДФО', date: '2026-10-20', species: 'Bovine', cases: 0, deaths: 0, status: 'Ongoing', source: 'fsvps', source_url: null },
      { id: 5, disease_key: 'fmd', disease: 'Ящур', disease_group: 'Ruminant', region: 'Ростовская область', federal_district: 'ЮФО', date: '2007-08-15', species: 'Bovine', cases: 12, deaths: 3, status: 'Resolved', source: 'wahis', source_url: 'https://wahis.woah.org/5' },
      { id: 6, disease_key: 'rabies', disease: 'Бешенство', disease_group: 'Wildlife', region: 'Забайкальский край', federal_district: 'ДФО', date: '2026-11-01', species: 'Wildlife', cases: 0, deaths: 0, status: 'Ongoing', source: 'fsvps', source_url: null },
    ],
  },
  chembl: {
    source: 'ChEMBL web API', version: 'ChEMBL_37', generated: '2026-11-10T20:00:00Z', note: 'срез',
    drugs: [
      { inn: 'Amoxicillin', chembl_id: 'CHEMBL1082', pref_name: 'AMOXICILLIN', molecule_type: 'Small molecule', max_phase: 4.0, first_approval: 1974, withdrawn_flag: false, oral: true, parenteral: false, properties: { full_mwt: 365.41, alogp: 0.02, hba: 6, hbd: 4, psa: 132.96, num_ro5_violations: 0 }, mechanisms: [{ action_type: 'INHIBITOR', target_name: 'Bacterial penicillin-binding protein' }] },
      { inn: 'Oxytetracycline', chembl_id: 'CHEMBL279224', pref_name: 'OXYTETRACYCLINE', molecule_type: 'Small molecule', max_phase: 4.0, first_approval: null, withdrawn_flag: false, oral: true, parenteral: true, properties: { full_mwt: 460.43, alogp: -0.6, hba: 9, hbd: 6, psa: 182.7, num_ro5_violations: 2 }, mechanisms: [{ action_type: 'INHIBITOR', target_name: '30S ribosomal subunit' }] },
    ],
  },
  boltz: {
    model: 'boltz-2', generated: '2026-11-09T18:00:00Z', params: {}, units: {},
    pairs: [
      { drug_id: 'drug-110-rimantadine', inn: 'Rimantadine', target_id: 'hpai-m2', target_name: 'Ионный канал M2 (Influenza A)', pdb_id: '2RLF', status: 'ok', ic50_um_est: 2.536862, delta_g_kcal_mol: 7.63, confidence: { confidence_score: 0.7580477, iptm: 0.703 }, reference: { ic50_um: 60 } },
      { drug_id: 'drug-108-amoxicillin', inn: 'Amoxicillin', target_id: 'pbp1', target_name: 'Пенициллин-связывающий белок', pdb_id: null, status: 'ok', ic50_um_est: 0.851234, delta_g_kcal_mol: 7.01, confidence: { confidence_score: 0.81234 }, reference: null },
    ],
  },
};

/** Стаб-кэш: раздаёт фикстуры без сети; VETMCP_NO_FIXTURE — эмулирует 404. */
function fixtureCache(overrides = {}) {
  const data = { ...FIX, ...overrides };
  const calls = [];
  return {
    calls,
    async get(name) {
      calls.push(name);
      if (name in data) return data[name];
      throw new Error(`${name}: HTTP 404`);
    },
  };
}

const call = async (server, name, args = {}) => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.id, 7);
  return r.result;
};
const payload = (result) => JSON.parse(result.content[0].text);

/* ---------- 1. кэш ---------- */

test('кэш: TTL — второй запрос не ходит в сеть; 404 — явная ошибка', async () => {
  let hits = 0;
  const fetcher = async (url) => { hits++; return { ok: true, json: async () => ({ url }) }; };
  const c = makeCache(fetcher, 60_000);
  await c.get('latest'); await c.get('latest');
  assert.equal(hits, 1, 'повторный запрос в пределах TTL не должен ходить в сеть');
  await assert.rejects(() => c.get('nope'), /неизвестный источник/);
  const c404 = makeCache(async () => ({ ok: false, status: 404 }));
  await assert.rejects(() => c404.get('latest'), /HTTP 404/);
});

test('источники: все 12 — публичные raw.githubusercontent-каналы экосистемы', () => {
  for (const [k, u] of Object.entries(SOURCES)) {
    assert.ok(u.startsWith('https://raw.githubusercontent.com/shray77/'), k);
    assert.ok(u.endsWith('.json'), k);
  }
  assert.equal(Object.keys(SOURCES).length, 12);
});

/* ---------- 2. валидаторы (импорт внутрь через сообщения инструментов) ---------- */

test('валидаторы: мусор по station_id/limit — isError с текстом, не падение', async () => {
  const s = createServer({ cache: fixtureCache() });
  const r1 = await call(s, 'vet_weather_forecast', {});
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /station_id/);
  const r2 = await call(s, 'vet_weather_forecast', { station_id: 'DR; DROP TABLE' });
  assert.equal(r2.isError, true);
  const r3 = await call(s, 'vet_outbreaks_russia', { limit: 999 });
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /limit/);
});

/* ---------- 3. JSON-RPC / MCP ---------- */

test('initialize: эхо поддерживаемой версии, serverInfo, capabilities', async () => {
  const s = createServer({ cache: fixtureCache() });
  for (const v of ['2024-11-05', '2025-03-26', '2025-06-18']) {
    const r = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {} } });
    assert.equal(r.result.protocolVersion, v);
    assert.deepEqual(r.result.serverInfo, SERVER_INFO);
    assert.ok(r.result.capabilities.tools);
  }
  const r2 = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(r2.result.protocolVersion, '2025-06-18'); // незнакомую — на последнюю поддерживаемую
});

test('ping → {}; notifications молчат; мусорный метод −32601; мусорный инструмент −32602', async () => {
  const s = createServer({ cache: fixtureCache() });
  assert.deepEqual((await s.handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' })).result, {});
  assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const e1 = await s.handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.equal(e1.error.code, -32601);
  const e2 = await s.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(e2.error.code, -32602);
  assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'tools/list' }), null); // без id — уведомление
});

test('tools/list: 10 инструментов, у каждого имя/описание/JSON-Schema', async () => {
  const s = createServer({ cache: fixtureCache() });
  const r = await s.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  const names = r.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['vet_weather_now', 'vet_weather_forecast', 'vet_weather_ensemble', 'vet_forecast_quality',
    'vet_flu_windows', 'vet_outbreaks_russia', 'vet_biothreats', 'vet_digest', 'vet_epimap', 'vet_drug_reference']);
  for (const t of r.result.tools) {
    assert.ok(t.description.length > 40, t.name);
    assert.equal(t.inputSchema.type, 'object');
  }
});

/* ---------- 4. инструменты на фикстурах ---------- */

test('vet_weather_now: сводка области и детально по станции', async () => {
  const s = createServer({ cache: fixtureCache() });
  const all = payload(await call(s, 'vet_weather_now', {}));
  assert.equal(all.stations, 3);
  assert.equal(all.stations_THI_over_72, 0);
  assert.equal(all.hottest_now[0].name, 'Сальск'); // THI 50.1 максимум
  const one = payload(await call(s, 'vet_weather_now', { station_id: 'rostov' }));
  assert.equal(one.station.id, 'rostov');
  assert.equal(one.station.THI, 48.2);
  assert.equal(one.station.zone, 'комфорт');
});

test('vet_weather_now: пустой срез — честная ошибка isError', async () => {
  const s = createServer({ cache: fixtureCache({ latest: { generatedAt: 'x', stations: [] } }) });
  const r = await call(s, 'vet_weather_now', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /срез пуст/);
});

test('vet_weather_forecast: окна THI>72 считаются по часам', async () => {
  const s = createServer({ cache: fixtureCache() });
  const p = payload(await call(s, 'vet_weather_forecast', { station_id: 'rostov' }));
  assert.equal(p.fromHourMsk, '2026-11-17T19:00');
  const w = p.windows_THI_over_72;
  assert.equal(w.length, 2);                    // [73,75] и [81,79]
  assert.equal(w[0].fromHour, 3); assert.equal(w[0].toHour, 5);
  assert.equal(w[0].peakTHI, 75); assert.equal(w[0].peakAtHour, 4);
  assert.equal(w[1].fromHour, 7); assert.equal(w[1].hours, 2);
});

test('vet_weather_ensemble: дни, обе модели, расхождение медиан', async () => {
  const s = createServer({ cache: fixtureCache() });
  const p = payload(await call(s, 'vet_weather_ensemble', { station_id: 'rostov' }));
  assert.equal(p.days.length, 2);
  assert.equal(p.days[0].IFS.p50, 48);
  assert.equal(p.days[0].AIFS.p50, 46);
  assert.equal(p.max_median_divergence.THI, '2.0'); // |48−46| = |52−50| = 2 → первый день
  assert.equal(p.max_median_divergence.date, '2026-11-18');
});

test('vet_forecast_quality: три слоя, AIFS честно из verify', async () => {
  const s = createServer({ cache: fixtureCache() });
  const p = payload(await call(s, 'vet_forecast_quality', {}));
  assert.equal(p.overall_verdict, 'умеренные');
  assert.equal(p.layer_A_best_match_vs_ERA5.MAE.thi, 1.4);
  assert.equal(p.layer_A2_AIFS_vs_ERA5.model, 'ecmwf_aifs025_single');
  assert.equal(p.layer_A2_AIFS_vs_ERA5.windows_THI72.pod, 100);
  assert.equal(p.layer_B_own_48h_forecasts.issues, 177);
});

test('vet_flu_windows: алерт + топ регионов по вероятности', async () => {
  const s = createServer({ cache: fixtureCache() });
  const p = payload(await call(s, 'vet_flu_windows', { limit: 2 }));
  assert.equal(p.alert.level, 'alert');
  assert.equal(p.top_regions.length, 2);
  assert.equal(p.top_regions[0].region, 'Дагестан'); // p=0.83
  assert.ok(p.top_regions[0].p >= p.top_regions[1].p);
});

test('vet_outbreaks_russia: выдача + фильтр query по словам', async () => {
  const s = createServer({ cache: fixtureCache() });
  const all = payload(await call(s, 'vet_outbreaks_russia', {}));
  assert.equal(all.shown, 2);
  const f = payload(await call(s, 'vet_outbreaks_russia', { query: 'оспа овец' }));
  assert.equal(f.shown, 1);
  assert.equal(f.items[0].region, 'Дагестан');
});

test('vet_biothreats: фильтры по болезни и стране', async () => {
  const s = createServer({ cache: fixtureCache() });
  const f = payload(await call(s, 'vet_biothreats', { disease: 'африканская чума' }));
  assert.equal(f.shown, 1);
  assert.equal(f.items[0].country, 'Греция');
  const c = payload(await call(s, 'vet_biothreats', { country: 'турция' }));
  assert.equal(c.items[0].disease, 'ящур');
});

test('vet_digest: публикации с пользой и DOI', async () => {
  const s = createServer({ cache: fixtureCache() });
  const p = payload(await call(s, 'vet_digest', {}));
  assert.equal(p.items[0].url, 'https://doi.org/10.1/x');
  assert.ok(p.items[0].takeaways.includes('премедикация'));
});

test('vet_epimap: сводка страны — топ болезней, округа, самый свежий сверху', async () => {
  const s = createServer({ cache: fixtureCache() });
  const p = payload(await call(s, 'vet_epimap', {}));
  assert.equal(p.updated, '2026-11-17');
  assert.equal(p.total_in_dataset, 6);
  assert.equal(p.matched, 6);
  assert.equal(p.ongoing, 4);
  assert.equal(p.top_diseases[0].disease, 'Бешенство'); // 2 события
  assert.equal(p.top_diseases[0].n, 2);
  const cfo = p.by_district.find((x) => x.district === 'ЦФО');
  assert.equal(cfo.n, 2);
  assert.equal(p.items[0].date, '2026-11-01'); // свежайшее первым
  assert.equal(p.items[0].region, 'Забайкальский край');
});

test('vet_epimap: фильтры болезнь/регион/since/статус + поиск по ключу', async () => {
  const s = createServer({ cache: fixtureCache() });
  const a = payload(await call(s, 'vet_epimap', { disease: 'африканская чума' }));
  assert.equal(a.matched, 2);
  assert.equal(a.ongoing, 1);
  assert.ok(a.items.every((x) => x.disease_key === 'asf'));
  const k = payload(await call(s, 'vet_epimap', { disease: 'fmd' })); // ключ тоже матчится
  assert.equal(k.matched, 1);
  assert.equal(k.items[0].disease, 'Ящур');
  const r = payload(await call(s, 'vet_epimap', { region: 'ростов' })); // подстрока, регистронезависимо
  assert.equal(r.matched, 2);
  assert.ok(r.items.every((x) => x.region === 'Ростовская область'));
  const y = payload(await call(s, 'vet_epimap', { since: '2026' }));
  assert.equal(y.matched, 4);
  const st = payload(await call(s, 'vet_epimap', { status: 'Resolved' }));
  assert.equal(st.matched, 2);
  assert.ok(st.items.every((x) => x.status === 'Resolved'));
  const combo = payload(await call(s, 'vet_epimap', { disease: 'бешенство', federal_district: 'дфо' }));
  assert.equal(combo.matched, 1);
  assert.equal(combo.items[0].region, 'Забайкальский край');
});

test('vet_epimap: мусорные since/status — isError с подсказкой, не падение', async () => {
  const s = createServer({ cache: fixtureCache() });
  const r1 = await call(s, 'vet_epimap', { since: 'мусор' });
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /since/);
  const r2 = await call(s, 'vet_epimap', { status: 'подозрение' });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /status/);
});

test('vet_drug_reference: сводка без inn + карточка препарата с Boltz-аффинностью', async () => {
  const s = createServer({ cache: fixtureCache() });
  const all = payload(await call(s, 'vet_drug_reference', {}));
  assert.equal(all.chembl_version, 'ChEMBL_37');
  assert.equal(all.drugs_total, 2);
  assert.equal(all.boltz.model, 'boltz-2');
  assert.equal(all.affinity_predictions.length, 2);
  assert.equal(all.affinity_predictions[0].inn, 'Rimantadine');
  assert.equal(all.affinity_predictions[0].ic50_um_est, 2.54); // округление до сотых
  const one = payload(await call(s, 'vet_drug_reference', { inn: 'amox' }));
  assert.equal(one.matched, 1);
  assert.equal(one.items[0].inn, 'Amoxicillin');
  assert.equal(one.items[0].properties.MW, 365.41);
  assert.equal(one.items[0].properties.Ro5_violations, 0);
  assert.equal(one.items[0].boltz_affinity.length, 1);
  assert.equal(one.items[0].boltz_affinity[0].target_id, 'pbp1');
  assert.equal(one.items[0].boltz_affinity[0].ic50_um_est, 0.85);
  const miss = await call(s, 'vet_drug_reference', { inn: 'xyzzy' });
  assert.equal(miss.isError, true);
  assert.match(miss.content[0].text, /не найден/);
});

/* ---------- 5. смоук прод-конфигурации ---------- */

test('TOOLS: 10 экспортов, все run — функции', () => {
  assert.equal(TOOLS.length, 10);
  for (const t of TOOLS) {
    assert.equal(typeof t.run, 'function', t.name);
    assert.equal(typeof t.name, 'string');
  }
});
