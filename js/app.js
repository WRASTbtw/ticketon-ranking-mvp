(function () {
  'use strict';

  const { generateCatalog, buildDemoVisitors, CATEGORIES, CITIES } = window.TicketonData;
  const { createRanker, SIGNALS } = window.TicketonEngine;

  const catalog = generateCatalog({ seed: 20261013 });
  const ranker = createRanker(catalog);
  const PAGE = 12;
  const TABS = ['showcase', 'ab', 'log', 'about'];

  const state = {
    city: 'almaty', surface: 'home', visitorId: 'guest', visitors: [],
    clicks: [], selectedId: null, show: PAGE, res: null, base: null,
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const dec = (x, d) => x.toFixed(d).replace('.', ',');
  const tenge = n => Math.round(n).toLocaleString('ru-RU') + ' ₸';
  const pct = (x, d = 1) => dec(x * 100, d) + '%';
  const signed = (x, d = 2) => (x > 0.00005 ? '+' : x < -0.00005 ? '−' : '') + dec(Math.abs(x), d);
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function fmtWhen(ms) {
    const d = new Date(ms);
    const day0 = new Date(ms);
    day0.setHours(0, 0, 0, 0);
    const diff = Math.round((day0.getTime() - catalog.today) / 864e5);
    const day = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : `${WD[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}`;
    return `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const visitor = () => state.visitors.find(v => v.id === state.visitorId) || state.visitors[0];
  const short = (t, n = 30) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ——— Витрина ———

  function loadVisitors() {
    state.visitors = buildDemoVisitors(catalog, state.city);
    if (!state.visitors.some(v => v.id === state.visitorId)) state.visitorId = 'guest';
    resetVisit(true);
  }

  function resetVisit(usePreset) {
    state.clicks = usePreset ? visitor().clicks.slice() : [];
    state.selectedId = null;
  }

  function render() {
    const v = visitor();
    const req = {
      city: state.city, surface: state.surface, platform: 'web', seed: state.city + ':' + v.id,
      user: { id: v.id, type: v.type, clicks: state.clicks, history: v.history },
    };
    state.res = ranker.rank(req);
    state.base = ranker.baseline(req);
    renderVisitors();
    renderKnowledge();
    renderColumns();
    renderExplain();
    renderRemoved();
    renderLog();
  }

  function renderVisitors() {
    $('#visitors').innerHTML = state.visitors.map(v =>
      `<button type="button" role="radio" data-id="${v.id}" aria-checked="${v.id === state.visitorId}">${esc(v.label)}</button>`).join('');
  }

  function renderKnowledge() {
    const v = visitor();
    const steps = [
      ['Город и витрина', true],
      [`Клики визита${state.clicks.length ? ' · ' + state.clicks.length : ''}`, state.clicks.length > 0],
      [`История покупок${v.history.length ? ' · ' + v.history.length : ''}`, v.history.length > 0],
    ];
    const chips = state.clicks.map(id =>
      `<span class="chip">${esc(short(catalog.byId[id].title))}<button type="button" data-unclick="${id}" aria-label="Убрать из визита">×</button></span>`).join('');
    $('#knowledge').innerHTML =
      `<div class="kn-steps">${steps.map(([label, on], i) =>
        (i ? '<span class="kn-arrow">→</span>' : '') + `<span class="kn-step${on ? ' on' : ''}">${on ? '✓ ' : ''}${esc(label)}</span>`).join('')}</div>` +
      `<div class="kn-note">${esc(v.type === 'guest' && v.id === 'guest' && state.clicks.length
        ? 'Гость без аккаунта: витрина подстраивается под то, что он открыл в этом визите.'
        : v.type === 'guest' && !state.clicks.length ? 'Ничего не знаем: только город, витрину и время.' : v.note)}</div>` +
      `<div class="kn-visit">${chips ? `<span class="kn-note" style="flex:0 0 auto">Открыто в визите:</span>${chips}<button type="button" class="link-btn" data-reset>Сбросить визит</button>` : ''}</div>`;
  }

  function moveTag(pos, other) {
    if (other == null) return '';
    const d = other - pos;
    if (d > 0) return `<span class="move up">↑ ${d} · было ${other}</span>`;
    if (d < 0) return `<span class="move down">↓ ${-d} · было ${other}</span>`;
    return '<span class="move same">на том же месте</span>';
  }

  function initials(title) {
    return title.replace(/[«»"():.,—-]/g, ' ').split(/\s+/)
      .filter(w => w && /\p{L}/u.test(w[0]))
      .slice(0, 2).map(w => w[0].toUpperCase()).join('');
  }

  function card(it, opt) {
    const e = it.event, C = CATEGORIES[e.category], now = catalog.now;
    const future = e.sessions.filter(s => s.start >= now);
    const next = future.find(s => s.sold < s.capacity) || future[0];
    const soldOut = it.flags.includes('soldout');
    const badges = [];
    if (state.clicks.includes(e.id)) badges.push(['opened', 'Открыто']);
    if (it.flags.includes('pinned')) badges.push(['pin', 'Закреплено']);
    if (it.flags.includes('promo')) badges.push(['promo', 'Промо']);
    if (it.flags.includes('explore')) badges.push(['explore', e.createdDaysAgo <= 3 ? 'Проба новинки' : 'Проба: мало показов']);
    else if (e.createdDaysAgo <= 3) badges.push(['new', 'Новинка']);
    if (soldOut) badges.push(['bad', 'Распродано']);
    if (opt.dup) badges.push(['bad', 'Дубль']);
    if (it.signals && it.signals.alreadyBought) badges.push(['bad', 'Билет уже куплен']);
    if (next && !soldOut && (next.capacity - next.sold) / next.capacity < 0.08) badges.push(['hot', 'Мало мест']);
    if (e.age >= 16) badges.push(['', e.age + '+']);

    const more = future.length > 1 ? ` · ещё ${future.length - 1} ${plural(future.length - 1, 'сеанс', 'сеанса', 'сеансов')}` : '';
    let move;
    if (opt.side === 'ours') move = moveTag(it.position, opt.other);
    else if (opt.other != null) move = `<span class="move none">у нас №${opt.other}</span>`;
    else move = `<span class="move down">у нас убрано</span>`;

    return `<li><button type="button" class="card${state.selectedId === e.id ? ' selected' : ''}${opt.dim ? ' dim' : ''}" data-id="${e.id}">` +
      `<span class="pos">${it.position}</span>` +
      `<span class="poster" style="--h:${C.hue}" aria-hidden="true"><b>${esc(initials(e.title))}</b><span>${esc(C.short)}</span></span>` +
      `<span class="info">` +
      `<span class="title">${esc(e.title)}</span>` +
      `<span class="meta">${esc(e.venueName)} · от ${tenge(e.price)}</span>` +
      `<span class="meta">${next ? esc(fmtWhen(next.start) + more) : ''}</span>` +
      `<span class="badges">${move}${badges.map(([c, l]) => `<span class="badge ${c}">${esc(l)}</span>`).join('')}</span>` +
      `</span></button></li>`;
  }

  function renderColumns() {
    const res = state.res, base = state.base;
    const basePos = new Map(base.items.map(it => [it.event.id, it.position]));
    const oursPos = new Map(res.items.map(it => [it.event.id, it.position]));
    const seenKeys = new Set(), dupIds = new Set();
    base.items.forEach(it => {
      const k = ranker.showKey(it.event);
      if (seenKeys.has(k)) dupIds.add(it.event.id);
      seenKeys.add(k);
    });

    $('#baseline').innerHTML = base.items.slice(0, state.show).map(it => {
      const dup = dupIds.has(it.event.id);
      return card(it, { side: 'base', dup, other: oursPos.get(it.event.id), dim: dup || it.flags.includes('soldout') });
    }).join('') || '<li class="hint">Нет событий</li>';

    $('#ours').innerHTML = res.items.slice(0, state.show).map(it =>
      card(it, { side: 'ours', other: basePos.get(it.event.id) })).join('') || '<li class="hint">Нет событий</li>';

    const cfg = ranker.config;
    $('#ours-sub').textContent = res.fallback
      ? `Запасной порядок · ${dec(res.latencyMs, 1)} мс`
      : `${cfg.modelVersion} · ответ за ${dec(res.latencyMs, 1)} мс`;
    const note = $('#fallback-note');
    note.hidden = !res.fallback;
    if (res.fallback) note.textContent = `${res.error}. Витрина не пустая: события идут по продажам в городе, правила фильтрации действуют.`;

    const total = Math.max(res.items.length, base.items.length);
    const btn = $('#more');
    btn.hidden = total <= PAGE;
    btn.textContent = state.show > PAGE ? 'Свернуть до 12' : 'Показать ещё 12';
  }

  const FLAG_TEXT = {
    pinned: () => 'Закреплено редактором на 1-й позиции: правило ставит его поверх оценки.',
    promo: () => 'Промо-размещение на 6-й позиции. В логе помечено отдельно, чтобы модель не училась на оплаченных местах.',
    explore: it => `Место для исследования: ${it.event.createdDaysAgo <= 3 ? 'событие новое' : 'событие мало показывали'}, система проверяет спрос. Вероятность выбора на эту позицию — ${pct(it.propensity, 0)}.`,
    diversity: () => 'Поднято правилом разнообразия: выше подряд шли события той же категории или площадки.',
  };

  function renderExplain() {
    const el = $('#explain');
    const res = state.res;
    if (!state.selectedId) {
      el.innerHTML = '<h3>Почему событие здесь</h3><p class="hint">Нажмите на любую карточку — это «открыть событие». ' +
        'Клик учтётся в визите, витрина пересоберётся, а здесь появится разбор оценки.</p>';
      return;
    }
    const e = catalog.byId[state.selectedId];
    const baseIt = state.base.items.find(x => x.event.id === e.id);
    const head = `<div class="ex-title">${esc(e.title)}</div><div class="ex-sub">${esc(CATEGORIES[e.category].name)} · ${esc(e.venueName)} · от ${tenge(e.price)}</div>`;
    const it = res.items.find(x => x.event.id === e.id);
    if (!it) {
      const rm = res.removed.find(x => x.event.id === e.id);
      el.innerHTML = head + `<p class="hint">${rm ? 'Убрано из выдачи: ' + esc(rm.reason) + '.' : 'Не относится к этой витрине.'}</p>`;
      return;
    }
    if (res.fallback) {
      el.innerHTML = head + '<p class="hint">Сервис ранжирования недоступен: витрина получила запасной порядок по продажам в городе. Разбор оценки появится, когда сервис ответит.</p>';
      return;
    }
    const cfg = ranker.config;
    const rows = SIGNALS.filter(s => Math.abs(it.contrib[s.key]) > 0.005)
      .sort((a, b) => Math.abs(it.contrib[b.key]) - Math.abs(it.contrib[a.key]));
    const maxAbs = Math.max(1, ...rows.map(s => Math.abs(it.contrib[s.key])));
    const bar = (label, value, title) => {
      const w = Math.min(50, (Math.abs(value) / maxAbs) * 50);
      return `<div class="bar-row" title="${esc(title)}"><span class="lbl">${esc(label)}</span>` +
        `<span class="bar-track"><span class="bar-fill ${value >= 0 ? 'pos' : 'neg'}" style="width:${w}%"></span></span>` +
        `<span class="val">${signed(value)}</span></div>`;
    };
    const bars = rows.map(s => bar(s.label, it.contrib[s.key],
      `сигнал ${dec(it.signals[s.key], 2)} × вес ${dec(cfg.weights[s.key], 1)}`)).join('');
    const sum = rows.reduce((acc, s) => acc + it.contrib[s.key], 0);

    const flags = it.flags.filter(f => FLAG_TEXT[f]).map(f => `<li>${esc(FLAG_TEXT[f](it))}</li>`);
    if (!it.flags.includes('pinned') && !it.flags.includes('promo') && !it.flags.includes('explore') && it.modelRank !== it.position) {
      flags.push(`<li>По одной оценке было бы №${it.modelRank}; позицию сдвинули правила.</li>`);
    }
    if (it.signals.alreadyBought) flags.push('<li>Посетитель уже купил билет на это шоу, поэтому событие опущено.</li>');

    el.innerHTML = head +
      `<div class="ex-kpis">` +
      `<div class="kpi"><b>№${it.position}</b><span>${baseIt ? 'сейчас №' + baseIt.position : 'у нас'}</span></div>` +
      `<div class="kpi"><b>${pct(it.p)}</b><span>шанс покупки (оценка)</span></div>` +
      `<div class="kpi"><b>×${dec(it.priceFactor, 2)}</b><span>поправка на чек</span></div>` +
      `</div>` +
      `<div class="bars">${bars || '<p class="hint">Сигналов нет</p>'}</div>` +
      (flags.length ? `<ul class="ex-flags">${flags.join('')}</ul>` : '') +
      `<div class="ex-formula">p = σ(${dec(cfg.bias, 1)} ${signed(sum)}) = ${pct(it.p)}; оценка = p × (цена / медиана ${tenge(res.refPrice)})<sup>α=${dec(cfg.alpha, 1)}</sup> = ${it.score.toFixed(4).replace('.', ',')}</div>`;
  }

  function renderRemoved() {
    const res = state.res;
    const groups = new Map();
    for (const r of res.removed) {
      const label = r.dup ? 'Склеены дубли' : r.reason.split(' — ')[0];
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(r);
    }
    const order = ['Распродано', 'Склеены дубли', 'Все сеансы уже прошли', 'Закрытое: только по прямой ссылке'];
    const labels = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    $('#removed').innerHTML = `<h3>Убрано из выдачи · ${res.removed.length}</h3>` + (labels.length ? labels.map(label => {
      const list = groups.get(label);
      const items = list.slice(0, 10).map(r => {
        const note = r.dup ? ` → оставлено «${esc(short(r.reason.replace(/^Дубль «|»$/g, ''), 34))}»` : r.reason.includes(' — ') ? ` (${esc(r.reason.split(' — ')[1])})` : '';
        return `<li>${esc(r.event.title)}${note}</li>`;
      }).join('');
      return `<details class="removed-group"${label === 'Склеены дубли' ? ' open' : ''}><summary><span>${esc(label)}</span><span>${list.length}</span></summary>` +
        `<ul>${items}${list.length > 10 ? `<li>и ещё ${list.length - 10}</li>` : ''}</ul></details>`;
    }).join('') : '<p class="hint">Ничего не убрано</p>');
  }

  function renderLog() {
    $('#log-json').textContent = state.res && state.res.log ? JSON.stringify(state.res.log, null, 2) : '';
  }

  // ——— A/B ———

  function signedPct(x) { return signed(x * 100, 1) + '%'; }

  function renderAB(r) {
    const convVerdict = r.conv.lo > 0 ? ['good', 'значимо выше контроля']
      : r.conv.hi < 0 ? ['bad', 'значимо ниже контроля'] : ['neutral', 'разница не значима — нужно больше визитов'];
    // Ограничение «не ниже контроля» проверяем с допуском 2%: нижняя граница ДИ не должна уходить глубже.
    const margin = 0.02 * r.gmv.a;
    const gmvVerdict = r.gmv.lo > 0 ? ['good', 'значимо выше контроля — ограничение выполнено']
      : r.gmv.lo > -margin ? ['good', 'не ниже контроля (допуск −2%) — ограничение выполнено']
        : r.gmv.hi < 0 ? ['bad', 'ниже контроля — ограничение нарушено']
          : ['neutral', 'данных мало, чтобы доказать «не ниже» — нужно больше визитов'];

    const bars = (a, b, fmt) => {
      const max = Math.max(a, b) || 1;
      const row = (label, v, color) => `<div class="ab-bar"><span class="lbl">${label}</span>` +
        `<span class="ab-track"><span style="width:${(v / max) * 100}%;background:${color}"></span></span>` +
        `<span class="val">${fmt(v)}</span></div>`;
      return `<div class="ab-chart">${row('Контроль', a, 'var(--muted)')}${row('Тест', b, 'var(--accent)')}</div>`;
    };
    const card = (title, a, b, fmt, m, verdict, ciText) =>
      `<div class="ab-card"><h3>${title}</h3>` +
      `<div class="ab-vals"><span class="from">${fmt(a)}</span><span>→</span><span class="to">${fmt(b)}</span></div>` +
      `<div class="ab-delta ${verdict[0]}">${signedPct(m.rel)} к контролю · ${verdict[1]}</div>` +
      `<div class="ab-delta neutral">95% ДИ разницы: ${ciText}</div>` +
      bars(a, b, fmt) + `</div>`;

    const cell = (row, v) => row.unit === 'tenge' ? tenge(v) : row.unit === 'pct' ? pct(v) : dec(v, 1);
    const change = row => {
      const d = row.b - row.a;
      const better = row.lowerIsBetter ? d < 0 : d > 0;
      const cls = Math.abs(d) < 1e-9 ? '' : better ? 'better' : 'worse';
      const text = row.unit === 'num' ? signed(d, 1) : row.a ? signedPct(d / row.a) : '—';
      return `<td class="${cls}">${text}</td>`;
    };

    $('#ab-results').innerHTML =
      `<div class="ab-headline">` +
      card('Конверсия в покупку — главная метрика', r.conv.a, r.conv.b, v => pct(v, 2), r.conv, convVerdict,
        `${signed(r.conv.lo * 100, 2)}…${signed(r.conv.hi * 100, 2)} п. п.`) +
      card('GMV на посетителя — ограничение', r.gmv.a, r.gmv.b, tenge, r.gmv, gmvVerdict,
        `${signed(r.gmv.lo, 0)}…${signed(r.gmv.hi, 0)} ₸`) +
      `</div>` +
      `<table class="ab-table"><thead><tr><th>Метрика</th><th>Контроль</th><th>Тест</th><th>Изменение</th></tr></thead><tbody>` +
      r.rows.map(row => `<tr><td>${esc(row.label)}</td><td>${cell(row, row.a)}</td><td>${cell(row, row.b)}</td>${change(row)}</tr>`).join('') +
      `</tbody></table>` +
      `<p class="ab-meta">${(r.A.visitors + r.B.visitors).toLocaleString('ru-RU')} визитов, по ${r.A.visitors.toLocaleString('ru-RU')} в группе · ` +
      `${r.B.rankCalls.toLocaleString('ru-RU')} вызовов ранжирования, в среднем ${dec(r.avgRankMs, 2)} мс · посчитано за ${dec(r.elapsedMs / 1000, 1)} с</p>`;
  }

  async function runAB() {
    const btn = $('#ab-run'), bar = $('#ab-progress');
    btn.disabled = true;
    bar.hidden = false;
    bar.value = 0;
    const visits = Number($('#ab-n').value);
    const r = await window.TicketonSim.runAB(catalog, ranker, { visits, seed: 42 }, p => { bar.value = p; });
    btn.disabled = false;
    bar.hidden = true;
    btn.textContent = 'Запустить ещё раз';
    renderAB(r);
  }

  // ——— Навигация и события ———

  function setTab(tab) {
    if (!TABS.includes(tab)) tab = 'showcase';
    $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.tab').forEach(s => { s.hidden = s.id !== 'tab-' + tab; });
    if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab);
  }

  function setup() {
    $('#city').innerHTML = CITIES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('#surface').innerHTML = [['home', 'Главная']].concat(Object.entries(CATEGORIES).map(([k, c]) => [k, c.name]))
      .map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');

    $('#city').addEventListener('change', e => {
      state.city = e.target.value;
      state.show = PAGE;
      loadVisitors();
      render();
    });
    $('#surface').addEventListener('change', e => {
      state.surface = e.target.value;
      state.show = PAGE;
      state.selectedId = null;
      render();
    });
    $('#visitors').addEventListener('click', e => {
      const b = e.target.closest('button[data-id]');
      if (!b || b.dataset.id === state.visitorId) return;
      state.visitorId = b.dataset.id;
      resetVisit(true);
      render();
    });
    $('#knowledge').addEventListener('click', e => {
      const un = e.target.closest('[data-unclick]');
      if (un) {
        state.clicks = state.clicks.filter(id => id !== un.dataset.unclick);
        render();
      } else if (e.target.closest('[data-reset]')) {
        resetVisit(false);
        render();
      }
    });
    ['#baseline', '#ours'].forEach(sel => $(sel).addEventListener('click', e => {
      const c = e.target.closest('.card');
      if (!c) return;
      const id = c.dataset.id;
      state.selectedId = id;
      if (!state.clicks.includes(id)) {
        state.clicks.push(id);
        toast('Клик учтён — витрина пересобрана');
      }
      render();
      if (window.innerWidth <= 760) $('#explain').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    $('#more').addEventListener('click', () => {
      state.show = state.show > PAGE ? PAGE : PAGE * 2;
      renderColumns();
    });

    $$('#rules [data-rule]').forEach(cb => cb.addEventListener('change', () => {
      ranker.setConfig({ rules: { [cb.dataset.rule]: cb.checked } });
      render();
    }));
    $('#alpha').addEventListener('input', e => {
      const a = Number(e.target.value);
      $('#alpha-out').textContent = a.toFixed(1);
      ranker.setConfig({ alpha: a });
      render();
    });
    $('#fail').addEventListener('change', e => {
      ranker.setConfig({ simulateFailure: e.target.checked });
      render();
    });

    $$('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    window.addEventListener('hashchange', () => setTab(location.hash.slice(1)));
    $('#ab-run').addEventListener('click', runAB);
  }

  setup();
  loadVisitors();
  render();
  setTab(location.hash.slice(1));
})();
