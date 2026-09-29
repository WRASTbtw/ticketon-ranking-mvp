/* Движок ранжирования: отбор кандидатов → оценка → правила Ticketon.
   Ничего не знает об интерфейсе: на пилоте этот же алгоритм переносится в сервис с API. */
(function (root) {
  'use strict';

  const DAY = 864e5;

  const SIGNALS = [
    { key: 'demand', label: 'Спрос в городе', level: 'context' },
    { key: 'conversion', label: 'Конверсия просмотр → покупка', level: 'context' },
    { key: 'heat', label: 'Скорость распродажи', level: 'context' },
    { key: 'dateFit', label: 'Удобная дата для категории', level: 'context' },
    { key: 'weekend', label: 'Сеанс на ближайших выходных', level: 'context' },
    { key: 'visitInterest', label: 'Интерес по кликам визита', level: 'visit' },
    { key: 'similar', label: 'Похоже на открытое или купленное', level: 'visit' },
    { key: 'persona', label: 'Тот же артист или команда', level: 'visit' },
    { key: 'historyInterest', label: 'Любимая категория по покупкам', level: 'history' },
    { key: 'venue', label: 'Любимая площадка', level: 'history' },
    { key: 'priceFit', label: 'Привычный чек', level: 'history' },
    { key: 'alreadyBought', label: 'Билет уже куплен', level: 'history' },
  ];

  const DEFAULT_CONFIG = {
    modelVersion: 'formula-v0.1',
    bias: -5.5,
    weights: {
      demand: 1.6, conversion: 0.9, heat: 0.5, dateFit: 1.2, weekend: 0.35,
      visitInterest: 1.5, similar: 1.1, persona: 0.9,
      historyInterest: 1.8, venue: 0.5, priceFit: 1.0, alreadyBought: -4.0,
    },
    alpha: 0.3, // 0 — максимум покупок, 1 — максимум ожидаемого GMV
    pageSize: 12,
    timeoutMs: 150,
    rules: { dedupe: true, diversity: true, explore: true, pins: true },
    diversity: { window: 5, maxPerCategory: 2, maxPerVenue: 2, head: 36 },
    // Места для исследования: новинки и редко показываемые события (нижние 30% по просмотрам в категории).
    explore: { firstSlot: 3, every: 6, newDays: 3, minViews: 60, lowExposureQuantile: 0.3, priorStrength: 20, draws: 40 },
    simulateFailure: false,
  };

  const sigmoid = x => 1 / (1 + Math.exp(-x));
  const sq = x => x * x;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const median = xs => {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  function merge(a, b) {
    const out = { ...a };
    for (const k in b) {
      const v = b[k];
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...a[k], ...v } : v;
    }
    return out;
  }

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normal(rnd) {
    let u = 0;
    while (u === 0) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  }

  function gammaSample(k, rnd) {
    if (k < 1) return gammaSample(k + 1, rnd) * Math.pow(rnd(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = normal(rnd); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = rnd();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function betaSample(a, b, rnd) {
    const x = gammaSample(a, rnd);
    return x / (x + gammaSample(b, rnd));
  }

  // Ключ «одного шоу»: языковые версии и дополнительные концерты склеиваются в один.
  function showKey(e) {
    const t = e.title.toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/дополнительный концерт/g, ' ')
      .replace(/\b20\d\d\b/g, ' ')
      .replace(/[^a-z0-9а-яёәғқңөұүһі]+/g, ' ')
      .trim();
    return `${e.city}|${e.category}|${t}`;
  }

  function hardFilter(e, now) {
    if (e.closed) return 'Закрытое: только по прямой ссылке';
    const future = e.sessions.filter(s => s.start >= now);
    if (!future.length) return 'Все сеансы уже прошли';
    if (!future.some(s => s.sold < s.capacity)) return 'Распродано';
    return null;
  }

  // Ближайшие выходные: со среды по воскресенье сигнал включён, в пн–вт — нет.
  function weekendWindow(now) {
    const d = new Date(now), dow = d.getDay();
    if (dow === 1 || dow === 2) return null;
    const day0 = new Date(now);
    day0.setHours(0, 0, 0, 0);
    const from = new Date(day0);
    if (dow >= 3 && dow <= 5) { from.setDate(day0.getDate() + (5 - dow)); from.setHours(17); }
    const to = new Date(day0);
    to.setDate(day0.getDate() + ((7 - dow) % 7));
    to.setHours(23, 59, 59, 999);
    return [Math.max(now, from.getTime()), to.getTime()];
  }

  function createRanker(catalog, config) {
    let cfg = merge(DEFAULT_CONFIG, config || {});
    const baseCache = new Map();
    const baselineCache = new Map();
    const keyCache = new Map();
    let reqSeq = 0;

    const key = e => {
      let k = keyCache.get(e.id);
      if (!k) { k = showKey(e); keyCache.set(e.id, k); }
      return k;
    };

    // «Офлайн-часть»: признаки, не зависящие от посетителя, считаются один раз на город.
    function cityBase(cityId) {
      let b = baseCache.get(cityId);
      if (b) return b;
      const now = catalog.now;
      const rows = [], removed = [];
      for (const e of catalog.eventsByCity[cityId] || []) {
        const reason = hardFilter(e, now);
        if (reason) { removed.push({ event: e, reason }); continue; }
        rows.push({ event: e, session: e.sessions.find(s => s.start >= now && s.sold < s.capacity), key: key(e) });
      }
      const maxSales = Math.max(1, ...rows.map(r => r.event.stats.sales7d));
      const refPrice = median(rows.map(r => r.event.price)) || 1;
      const wk = weekendWindow(now);
      for (const r of rows) {
        const e = r.event, st = e.stats, lead = catalog.categories[e.category].lead;
        const prior = catalog.prior[e.category] || 0.03;
        const conv = (st.sales7d + 60 * prior) / (st.views7d + 60);
        const days = (r.session.start - now) / DAY;
        r.isNew = e.createdDaysAgo <= cfg.explore.newDays || st.views7d < cfg.explore.minViews;
        r.stat = {
          demand: Math.log1p(st.sales7d) / Math.log1p(maxSales),
          conversion: clamp(Math.log(conv / prior) / Math.log(3), -1, 1),
          heat: r.session.sold / r.session.capacity,
          dateFit: Math.exp(-sq(Math.log((days + 1) / (lead + 1))) / (2 * 0.8 * 0.8)),
          weekend: wk && e.sessions.some(s => s.start >= wk[0] && s.start <= wk[1] && s.sold < s.capacity) ? 1 : 0,
        };
      }
      // Холодный старт: пока у новинки мало статистики, её спрос берётся не ниже типичного для категории.
      const demandByCat = {}, viewsByCat = {};
      for (const r of rows) {
        const c = r.event.category;
        if (!r.isNew) (demandByCat[c] = demandByCat[c] || []).push(r.stat.demand);
        (viewsByCat[c] = viewsByCat[c] || []).push(r.event.stats.views7d);
      }
      for (const c in viewsByCat) viewsByCat[c].sort((a, b) => a - b);
      for (const r of rows) {
        const c = r.event.category, views = viewsByCat[c];
        if (r.isNew) r.stat.demand = Math.max(r.stat.demand, 0.8 * median(demandByCat[c] || [0]));
        const cut = views[Math.floor((views.length - 1) * cfg.explore.lowExposureQuantile)];
        r.explorable = r.isNew || (views.length >= 4 && r.event.stats.views7d <= cut);
      }
      const fallbackOrder = rows.slice().sort((a, b) => b.event.stats.sales7d - a.event.stats.sales7d);
      b = { rows, removed, refPrice, fallbackOrder };
      baseCache.set(cityId, b);
      return b;
    }

    function profile(user) {
      const byId = catalog.byId;
      const clicks = (user.clicks || []).map(id => byId[id]).filter(Boolean);
      const hist = (user.history || []).filter(h => byId[h.eventId]).map(h => ({ ...h, event: byId[h.eventId] }));
      const share = list => {
        const m = {};
        list.forEach(e => { m[e.category] = (m[e.category] || 0) + 1 / list.length; });
        return m;
      };
      const histEvents = hist.map(h => h.event);
      const anchors = clicks.concat(histEvents);
      return {
        level: hist.length ? 'history' : clicks.length ? 'visit' : 'context',
        visitCat: share(clicks),
        histCat: share(histEvents),
        personaOf: anchors.filter(e => e.persona),
        venues: new Set(histEvents.map(e => e.venueId)),
        medianPrice: median(hist.map(h => h.price)),
        bought: new Set(hist.map(h => h.eventId)),
        boughtKeys: new Set(histEvents.map(key)),
        anchors,
      };
    }

    function similarity(prof, e, eKey) {
      let best = 0;
      for (const a of prof.anchors) {
        if (a.id === e.id || key(a) === eKey) continue;
        const cf = Math.min(1, catalog.sim(a.id, e.id) / 0.35);
        const content = (a.category === e.category ? 0.35 : 0) +
          (a.persona && a.persona === e.persona ? 0.4 : 0) + (a.venueId === e.venueId ? 0.15 : 0);
        best = Math.max(best, cf, content * 0.7);
      }
      return best;
    }

    // Разнообразие: в любом окне из N позиций не больше K событий одной категории и одной площадки.
    function fitsWindow(it, recent, opt, byCategory) {
      let sameCat = 0, sameVenue = 0;
      for (const x of recent) {
        if (x.event.category === it.event.category) sameCat++;
        if (x.event.venueId === it.event.venueId) sameVenue++;
      }
      return (!byCategory || sameCat < opt.maxPerCategory) && sameVenue < opt.maxPerVenue;
    }

    function explore(list, req, rules) {
      const picks = [];
      if (!rules.explore) return { list, picks };
      const ex = cfg.explore;
      const rnd = mulberry32(hashString(String(req.seed == null ? 'seed' : req.seed) + '|' + (req.surface || 'home')));
      const pool = list.filter(it => it.explorable && !it.signals.alreadyBought);
      for (let pos = ex.firstSlot; pos < cfg.pageSize; pos += ex.every) {
        const cands = pool.filter(it => it.modelRank > pos && !picks.some(p => p.it === it));
        if (!cands.length) break;
        const params = cands.map(it => {
          const st = it.event.stats, prior = catalog.prior[it.event.category] || 0.03;
          const s = it.signals;
          return {
            a: prior * ex.priorStrength + st.sales7d,
            b: (1 - prior) * ex.priorStrength + Math.max(0, st.views7d - st.sales7d),
            rel: (0.5 + Math.max(s.visitInterest, s.historyInterest, s.similar)) * it.priceFactor,
          };
        });
        const draw = () => {
          let best = 0, bestV = -1;
          params.forEach((p, i) => { const v = betaSample(p.a, p.b, rnd) * p.rel; if (v > bestV) { bestV = v; best = i; } });
          return best;
        };
        const chosen = draw();
        let wins = 0;
        for (let t = 0; t < ex.draws; t++) if (draw() === chosen) wins++;
        picks.push({ it: cands[chosen], pos, propensity: Math.round((wins / ex.draws) * 1000) / 1000 });
      }
      const chosenSet = new Set(picks.map(p => p.it));
      return { list: list.filter(it => !chosenSet.has(it)), picks };
    }

    function doRank(req, requestId, t0) {
      const surface = req.surface || 'home';
      const inSurface = e => surface === 'home' || e.category === surface;
      const base = cityBase(req.city);
      const prof = profile(req.user || {});
      const rules = { ...cfg.rules, ...(req.rules || {}) };
      const removed = base.removed.filter(x => inSurface(x.event)).map(x => ({ ...x }));
      const W = cfg.weights;

      // Шаг 2: оценка каждого кандидата.
      const scored = [];
      for (const r of base.rows) {
        const e = r.event;
        if (!inSurface(e)) continue;
        const sig = { ...r.stat, visitInterest: 0, similar: 0, persona: 0, historyInterest: 0, venue: 0, priceFit: 0, alreadyBought: 0 };
        if (prof.level !== 'context') {
          sig.visitInterest = prof.visitCat[e.category] || 0;
          sig.similar = similarity(prof, e, r.key);
          // Совпадение артиста считаем только с другими шоу: само событие себе не «похоже».
          sig.persona = e.persona && prof.personaOf.some(a => a.persona === e.persona && key(a) !== r.key) ? 1 : 0;
        }
        if (prof.level === 'history') {
          sig.historyInterest = prof.histCat[e.category] || 0;
          sig.venue = prof.venues.has(e.venueId) ? 1 : 0;
          if (prof.medianPrice) sig.priceFit = Math.exp(-sq(Math.log(e.price / prof.medianPrice)) / (2 * 0.5 * 0.5)) - 0.5;
          sig.alreadyBought = prof.bought.has(e.id) || prof.boughtKeys.has(r.key) ? 1 : 0;
        }
        let logit = cfg.bias;
        const contrib = {};
        for (const k in sig) { contrib[k] = (W[k] || 0) * sig[k]; logit += contrib[k]; }
        const p = sigmoid(logit);
        const priceFactor = Math.pow(e.price / base.refPrice, cfg.alpha);
        scored.push({ event: e, key: r.key, isNew: r.isNew, explorable: r.explorable, signals: sig, contrib, logit, p, priceFactor, score: p * priceFactor, flags: [], propensity: 1 });
      }
      scored.sort((a, b) => b.score - a.score || (a.event.id < b.event.id ? -1 : 1));
      scored.forEach((it, i) => { it.modelRank = i; });

      // Шаг 3: правила. Закрепления и промо вынимаем сразу, чтобы другие правила их не двигали.
      let list = scored;
      const fixed = [];
      if (rules.pins && surface === 'home') {
        list = list.filter(it => {
          if (it.event.pinnedHome != null) { fixed.push({ it, pos: it.event.pinnedHome, flag: 'pinned' }); return false; }
          if (it.event.promoHome != null) { fixed.push({ it, pos: it.event.promoHome, flag: 'promo' }); return false; }
          return true;
        });
        base.removed.forEach(x => {
          if (x.event.pinnedHome != null || x.event.promoHome != null) {
            const hit = removed.find(y => y.event === x.event);
            if (hit) hit.reason += x.event.pinnedHome != null ? ' — закрепление снято' : ' — промо снято';
          }
        });
      }
      if (rules.dedupe) {
        const seen = new Map(fixed.map(f => [f.it.key, f.it]));
        list = list.filter(it => {
          const first = seen.get(it.key);
          if (first) { removed.push({ event: it.event, reason: `Дубль «${first.event.title}»`, dup: true }); return false; }
          seen.set(it.key, it);
          return true;
        });
      }
      const ex = explore(list, req, rules);
      const rest = ex.list;

      // Сборка: закрепления и пробы новинок стоят на своих местах, остальные места
      // заполняются по оценке с учётом разнообразия относительно уже поставленных.
      const fixedAt = new Map(fixed.map(f => [f.pos, f]));
      const exploreAt = new Map(ex.picks.map(p => [p.pos, p]));
      const total = rest.length + fixed.length + ex.picks.length;
      const div = cfg.diversity, byCategory = surface === 'home';
      const out = [];
      for (let pos = 0; out.length < total; pos++) {
        const f = fixedAt.get(pos), x = exploreAt.get(pos);
        if (f) { f.it.flags.push(f.flag); out.push(f.it); continue; }
        if (x) { x.it.flags.push('explore'); x.it.propensity = x.propensity; out.push(x.it); continue; }
        if (!rest.length) continue;
        let idx = 0;
        if (rules.diversity && out.length < div.head) {
          const recent = out.slice(-(div.window - 1));
          idx = rest.findIndex(it => fitsWindow(it, recent, div, byCategory));
          if (idx < 0) idx = 0;
          if (idx > 0) rest[idx].flags.push('diversity');
        }
        out.push(rest.splice(idx, 1)[0]);
      }

      const res = {
        requestId, fallback: false, level: prof.level, removed,
        items: out.map((it, i) => ({ ...it, position: i + 1, modelRank: it.modelRank + 1 })),
        refPrice: base.refPrice,
        latencyMs: performance.now() - t0,
      };
      res.log = req.noLog ? null : buildLog(req, res, surface, rules);
      return res;
    }

    function fallback(req, requestId, t0, error) {
      const surface = req.surface || 'home';
      const base = cityBase(req.city);
      const inSurface = e => surface === 'home' || e.category === surface;
      const res = {
        requestId, fallback: true, error, level: 'context',
        removed: base.removed.filter(x => inSurface(x.event)),
        items: base.fallbackOrder.filter(r => inSurface(r.event)).map((r, i) => ({
          event: r.event, position: i + 1, score: null, p: null, signals: null, contrib: null, flags: ['fallback'], propensity: 1, modelRank: null,
        })),
        latencyMs: performance.now() - t0,
      };
      res.log = req.noLog ? null : buildLog(req, res, surface, cfg.rules);
      return res;
    }

    function buildLog(req, res, surface, rules) {
      const r3 = x => Math.round(x * 1000) / 1000;
      const user = req.user || {};
      return {
        request_id: res.requestId,
        ts: new Date().toISOString(),
        model_version: res.fallback ? 'fallback-popularity' : cfg.modelVersion,
        surface, city: req.city, platform: req.platform || 'web',
        user: { id: user.id || 'anonymous', type: user.type || 'guest', knowledge_level: res.level, clicks_in_visit: (user.clicks || []).length, purchases: (user.history || []).length },
        config: { alpha: cfg.alpha, rules },
        fallback: res.fallback,
        error: res.error || null,
        latency_ms: Math.round(res.latencyMs * 100) / 100,
        items: res.items.slice(0, cfg.pageSize).map(it => ({
          position: it.position,
          event_id: it.event.id,
          title: it.event.title,
          score: it.score == null ? null : Number(it.score.toPrecision(4)),
          p_buy: it.p == null ? null : Math.round(it.p * 10000) / 10000,
          propensity: it.propensity,
          flags: it.flags,
          features: it.signals ? Object.fromEntries(Object.entries(it.signals).map(([k, v]) => [k, r3(v)])) : null,
        })),
        removed_count: res.removed.length,
      };
    }

    function rank(req) {
      const t0 = performance.now();
      const requestId = req.requestId || `req-${Math.floor(catalog.now / 1000).toString(36)}-${(++reqSeq).toString(36)}`;
      if (cfg.simulateFailure) {
        return fallback(req, requestId, t0, `Сервис не ответил за ${cfg.timeoutMs} мс — отдан запасной порядок`);
      }
      try {
        return doRank(req, requestId, t0);
      } catch (err) {
        return fallback(req, requestId, t0, 'Ошибка ранжирования: ' + err.message);
      }
    }

    // Упрощённая модель текущего порядка: по ближайшему сеансу, без правил.
    function baseline(req) {
      const surface = req.surface || 'home';
      const ck = req.city + '|' + surface;
      let items = baselineCache.get(ck);
      if (!items) {
        const now = catalog.now;
        const rows = [];
        for (const e of catalog.eventsByCity[req.city] || []) {
          if (e.closed || !(surface === 'home' || e.category === surface)) continue;
          const next = e.sessions.find(s => s.start >= now);
          if (!next) continue;
          rows.push({ e, next: next.start, soldOut: !e.sessions.some(s => s.start >= now && s.sold < s.capacity) });
        }
        rows.sort((a, b) => a.next - b.next || (a.e.id < b.e.id ? -1 : 1));
        items = rows.map((r, i) => ({ position: i + 1, event: r.e, flags: r.soldOut ? ['soldout'] : [] }));
        baselineCache.set(ck, items);
      }
      return { items };
    }

    return {
      rank,
      baseline,
      showKey: key,
      get config() { return cfg; },
      setConfig(patch) {
        cfg = merge(cfg, patch);
        baseCache.clear();
      },
    };
  }

  root.TicketonEngine = { createRanker, showKey, SIGNALS, DEFAULT_CONFIG };
})(window);
