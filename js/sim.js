/* Симуляция A/B-теста на листингах категорий — там текущий порядок известен из ТЗ:
   по ближайшему сеансу. Синтетический посетитель открывает категорию, которая ему ближе,
   и листает её: контроль видит порядок по дате, тест — порядок нашей системы.
   Вкусов посетителей система не видит: ей доступны только клики визита,
   история покупок авторизованных и статистика продаж. */
(function (root) {
  'use strict';

  const { CATEGORIES, makeRandom } = root.TicketonData;
  const sigmoid = x => 1 / (1 + Math.exp(-x));
  const sq = x => x * x;
  const DAY = 864e5;
  const PAGE = 24;
  const CONTINUE = 0.85;
  const CONTINUE_AFTER_CLICK = 0.7;
  const MAX_CLICKS = 3;

  function hash01(a, b) {
    let h = 2166136261;
    const s = a + '#' + b;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10007) / 10007;
  }

  function newStats() {
    return { visitors: 0, buyers: 0, gmv: 0, gmvSq: 0, tickets: 0, clicks: 0, clickVisits: 0, examined: 0,
      soldOutClicks: 0, dupShows: 0, boughtShows: 0, newBuys: 0, tailBuys: 0, rankCalls: 0, rankMs: 0 };
  }

  function runAB(catalog, ranker, opts, onProgress) {
    const visits = (opts && opts.visits) || 5000;
    const R = makeRandom((opts && opts.seed) || 42);
    const now = catalog.now;
    const cats = Object.keys(CATEGORIES);
    const avail = e => e.sessions.find(s => s.start >= now && s.sold < s.capacity);
    const nextAny = e => e.sessions.find(s => s.start >= now);
    const group = e => e.dupOf || e.id;

    const top20 = {};
    for (const c of catalog.cities) {
      top20[c.id] = new Set((catalog.eventsByCity[c.id] || [])
        .filter(e => !e.closed && avail(e))
        .sort((a, b) => b.stats.sales7d - a.stats.sales7d)
        .slice(0, 20).map(e => e.id));
    }
    const midPrice = {};
    cats.forEach(c => { midPrice[c] = (CATEGORIES[c].price[0] + CATEGORIES[c].price[1]) / 2; });

    function makeVisitor(i) {
      const city = R.weighted(catalog.cities, c => c.traffic);
      const aff = {};
      let max = 0;
      for (const c of cats) { aff[c] = R.gamma(0.45) + 0.02; max = Math.max(max, aff[c]); }
      for (const c of cats) aff[c] /= max;
      const u = {
        id: 'sim' + i, city: city.id, aff, known: R.chance(0.35),
        surface: R.weighted(cats, c => aff[c] * aff[c]),
        budget: Math.exp(0.35 * R.normal()), priceSens: R.range(0.3, 1),
        history: [], bought: new Set(), boughtGroups: new Set(),
      };
      if (u.known) {
        const pool = (catalog.eventsByCity[city.id] || []).filter(e => !e.closed);
        const k = R.int(2, 5);
        for (let j = 0; j < k; j++) {
          const e = R.weighted(pool, x => Math.pow(aff[x.category], 1.5) * (0.2 + x.q));
          if (u.bought.has(e.id)) continue;
          u.bought.add(e.id);
          u.boughtGroups.add(group(e));
          u.history.push({ eventId: e.id, price: e.price });
        }
      }
      return u;
    }

    // «Истинная» полезность события для посетителя — известна только симуляции.
    function utility(u, e) {
      const C = CATEGORIES[e.category];
      const s = avail(e) || nextAny(e);
      const d = s ? Math.max(0, (s.start - now) / DAY) : 30;
      const dateFit = Math.exp(-sq(Math.log((d + 1) / (C.lead + 1))) / 2);
      const priceFit = -u.priceSens * Math.abs(Math.log(e.price / (u.budget * midPrice[e.category])));
      const noise = (hash01(u.id, e.id) - 0.5) * 1.6;
      return 2.4 * u.aff[e.category] + 1.4 * (e.q - 0.5) + 0.8 * dateFit + priceFit + noise;
    }

    function getList(arm, req, st) {
      if (arm === 'A') return ranker.baseline(req).items;
      const t0 = performance.now();
      const res = ranker.rank(req);
      st.rankCalls++;
      st.rankMs += performance.now() - t0;
      return res.items;
    }

    function visit(u, arm, st) {
      const req = { city: u.city, surface: u.surface, seed: u.id, noLog: true,
        user: { id: u.id, type: u.known ? 'known' : 'guest', clicks: [], history: u.history } };
      let queue = getList(arm, req, st).slice(0, PAGE);
      const seen = new Set(), groups = new Set();
      let i = 0, cont = CONTINUE, clicked = false;
      st.visitors++;
      while (i < queue.length) {
        const e = queue[i++].event;
        if (seen.has(e.id)) continue;
        if (seen.size > 0 && R.next() > cont) break;
        seen.add(e.id);
        st.examined++;
        const g = group(e);
        const repeat = groups.has(g);
        groups.add(g);
        if (repeat) st.dupShows++;
        const owned = u.bought.has(e.id) || u.boughtGroups.has(g);
        if (owned) st.boughtShows++;
        const util = utility(u, e);
        let pClick = sigmoid(-4.0 + util);
        if (repeat) pClick *= 0.3;
        if (owned) pClick *= 0.2;
        cont = CONTINUE;
        if (R.next() >= pClick) continue;

        st.clicks++;
        clicked = true;
        req.user.clicks.push(e.id);
        if (!avail(e)) {
          st.soldOutClicks++;
        } else if (!owned && R.next() < sigmoid(-4.2 + 0.8 * util)) {
          const C = CATEGORIES[e.category];
          const value = e.price * R.int(C.qty[0], C.qty[1]);
          st.buyers++;
          st.gmv += value;
          st.gmvSq += value * value;
          if (e.createdDaysAgo <= 3) st.newBuys++;
          if (!top20[u.city].has(e.id)) st.tailBuys++;
          break;
        }
        cont = CONTINUE_AFTER_CLICK;
        if (req.user.clicks.length >= MAX_CLICKS) break;
        if (arm === 'B') {
          // Тест: после клика нижняя часть витрины пересобирается с учётом интереса визита.
          const fresh = getList(arm, req, st).filter(x => !seen.has(x.event.id)).slice(0, PAGE - i);
          queue = queue.slice(0, i).concat(fresh);
        }
      }
      if (clicked) st.clickVisits++;
    }

    const A = newStats(), B = newStats();
    let i = 0;
    const started = performance.now();
    return new Promise(resolve => {
      function step() {
        // Считаем порциями по ~60 мс, чтобы страница не зависала и прогресс обновлялся.
        const budget = performance.now() + 60;
        while (i < visits && performance.now() < budget) {
          const u = makeVisitor(i);
          if (i % 2 === 0) visit(u, 'A', A); else visit(u, 'B', B);
          i++;
        }
        if (onProgress) onProgress(i / visits);
        if (i < visits) setTimeout(step, 0);
        else resolve(summarize(A, B, performance.now() - started));
      }
      step();
    });
  }

  function summarize(A, B, elapsedMs) {
    const conv = s => s.buyers / s.visitors;
    const gmv = s => s.gmv / s.visitors;
    const gmvVar = s => Math.max(0, s.gmvSq / s.visitors - sq(gmv(s)));
    const ratio = (n, d) => (d ? n / d : 0);

    const dConv = conv(B) - conv(A);
    const seConv = Math.sqrt(conv(A) * (1 - conv(A)) / A.visitors + conv(B) * (1 - conv(B)) / B.visitors);
    const dGmv = gmv(B) - gmv(A);
    const seGmv = Math.sqrt(gmvVar(A) / A.visitors + gmvVar(B) / B.visitors);

    return {
      A, B, elapsedMs,
      avgRankMs: ratio(B.rankMs, B.rankCalls),
      conv: { a: conv(A), b: conv(B), diff: dConv, lo: dConv - 1.96 * seConv, hi: dConv + 1.96 * seConv, rel: ratio(dConv, conv(A)) },
      gmv: { a: gmv(A), b: gmv(B), diff: dGmv, lo: dGmv - 1.96 * seGmv, hi: dGmv + 1.96 * seGmv, rel: ratio(dGmv, gmv(A)) },
      rows: [
        { label: 'Средний заказ', unit: 'tenge', a: ratio(A.gmv, A.buyers), b: ratio(B.gmv, B.buyers) },
        { label: 'Доля визитов с кликом', unit: 'pct', a: ratio(A.clickVisits, A.visitors), b: ratio(B.clickVisits, B.visitors) },
        { label: 'Клики по распроданным, на 1000 визитов', unit: 'num', a: 1000 * ratio(A.soldOutClicks, A.visitors), b: 1000 * ratio(B.soldOutClicks, B.visitors), lowerIsBetter: true },
        { label: 'Повторные показы одного шоу, на 1000 визитов', unit: 'num', a: 1000 * ratio(A.dupShows, A.visitors), b: 1000 * ratio(B.dupShows, B.visitors), lowerIsBetter: true },
        { label: 'Показы уже купленного, на 1000 визитов', unit: 'num', a: 1000 * ratio(A.boughtShows, A.visitors), b: 1000 * ratio(B.boughtShows, B.visitors), lowerIsBetter: true },
        { label: 'Доля покупок новинок', unit: 'pct', a: ratio(A.newBuys, A.buyers), b: ratio(B.newBuys, B.buyers) },
        { label: 'Доля покупок вне топ-20 города', unit: 'pct', a: ratio(A.tailBuys, A.buyers), b: ratio(B.tailBuys, B.buyers) },
      ],
    };
  }

  root.TicketonSim = { runAB };
})(window);
