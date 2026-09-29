/* Синтетический каталог в структуре Ticketon: города, площадки, события, сеансы,
   статистика за 7 дней и история покупок. Всё детерминировано зерном:
   одно зерно — одни и те же данные. Даты считаются от момента открытия страницы. */
(function (root) {
  'use strict';

  const DAY = 864e5;
  const HOUR = 36e5;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

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

  function makeRandom(seed) {
    const next = mulberry32(seed);
    const R = {
      next,
      int: (a, b) => a + Math.floor(next() * (b - a + 1)),
      range: (a, b) => a + next() * (b - a),
      chance: p => next() < p,
      pick: arr => arr[Math.floor(next() * arr.length)],
      shuffle(arr) {
        const out = arr.slice();
        for (let i = out.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
      },
      normal() {
        let u = 0;
        while (u === 0) u = next();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
      },
      gamma(k) {
        if (k < 1) return R.gamma(k + 1) * Math.pow(next(), 1 / k);
        const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
        for (;;) {
          let x, v;
          do { x = R.normal(); v = 1 + c * x; } while (v <= 0);
          v = v * v * v;
          const u = next();
          if (u < 1 - 0.0331 * x * x * x * x) return d * v;
          if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
        }
      },
      weighted(items, weight) {
        const ws = items.map(weight);
        let x = next() * ws.reduce((s, w) => s + w, 0);
        for (let i = 0; i < items.length; i++) {
          x -= ws[i];
          if (x <= 0) return items[i];
        }
        return items[items.length - 1];
      },
    };
    return R;
  }

  const CITIES = [
    { id: 'almaty', name: 'Алматы', traffic: 1.0 },
    { id: 'astana', name: 'Астана', traffic: 0.8 },
    { id: 'shymkent', name: 'Шымкент', traffic: 0.45 },
    { id: 'karaganda', name: 'Караганда', traffic: 0.28 },
    { id: 'aktobe', name: 'Актобе', traffic: 0.2 },
  ];

  // lead — типичный срок покупки до сеанса в днях; conv — конверсия просмотра в покупку.
  const CATEGORIES = {
    cinema: { name: 'Кино', short: 'Кино', hue: 212, share: 0.2, lead: 2, price: [1800, 3500], conv: 0.08, ages: [6, 12, 16, 18], qty: [1, 3] },
    concert: { name: 'Концерты', short: 'Концерт', hue: 330, share: 0.18, lead: 21, price: [7000, 35000], conv: 0.03, ages: [12, 16], qty: [1, 3] },
    theatre: { name: 'Театр', short: 'Театр', hue: 18, share: 0.17, lead: 10, price: [3500, 12000], conv: 0.045, ages: [12, 16], qty: [1, 2] },
    standup: { name: 'Стендап', short: 'Стендап', hue: 42, share: 0.12, lead: 8, price: [5000, 15000], conv: 0.05, ages: [18], qty: [1, 2] },
    sport: { name: 'Спорт', short: 'Спорт', hue: 145, share: 0.1, lead: 6, price: [2500, 15000], conv: 0.04, ages: [0, 6], qty: [1, 4] },
    kids: { name: 'Детям', short: 'Детям', hue: 275, share: 0.14, lead: 5, price: [2500, 6000], conv: 0.06, ages: [0, 6], qty: [2, 4] },
    expo: { name: 'Выставки', short: 'Выставка', hue: 185, share: 0.09, lead: 3, price: [2000, 5000], conv: 0.06, ages: [0], qty: [1, 3] },
  };

  // Площадки и названия вымышленные.
  const VENUES = {
    cinema: [['Кинотеатр «Орбита»', 140], ['Киноцентр «Премьер»', 180], ['Кинотеатр «Звезда»', 120]],
    concert: [['Концертный зал «Орда»', 1200], ['Арена «Тулпар»', 4000], ['Летняя сцена «Бақ»', 800]],
    theatre: [['Городской драматический театр', 600], ['Молодёжный театр «Жас»', 300], ['Театр оперы и балета', 900]],
    standup: [['Клуб «Подвал»', 180], ['Бар «Микрофон»', 120]],
    sport: [['Стадион «Центральный»', 8000], ['Ледовый дворец «Мұз»', 4500], ['Спорткомплекс «Жігер»', 2500]],
    kids: [['Детский театр «Сказка»', 350], ['Цирк «Шапито»', 1200]],
    expo: [['Выставочный центр «Көрме»', 400], ['Галерея «Кёк»', 250]],
  };

  const NAMES = {
    cinema: ['Последний рейс', 'Степной волк', 'Город без сна', 'Тайна старого маяка', 'Большое путешествие', 'Нулевая высота',
      'Код Алатау', 'Лето в Бурабае', 'Двойная игра', 'Сердце степи', 'Ночной патруль', 'Космический десант', 'Наследие',
      'Всё будет хорошо', 'Горная тропа', 'Семейный переполох', 'Тихий берег', 'Против ветра', 'Дорога на Байконур', 'Шестой этаж'],
    musicians: ['Группа «Северный ветер»', 'Айжан Серікқызы', 'Джаз-квартет «Синяя птица»', 'Рок-группа «Кардиограмма»',
      'Дина Маратова', 'Хор «Шабыт»', 'DJ Nomad', 'Тимур Альжанов', 'Ансамбль «Көкжиек»', 'Группа «Полночь»', 'Арман Касенов',
      'Группа «Ақ жол»', 'Скрипач Ерлан Абенов', 'Кавер-бенд «Пластинка»', 'Оркестр «Сазген»'],
    concertShows: ['Большой сольный концерт', 'Тур «Дорога домой»', 'Юбилейный концерт', 'Презентация нового альбома', 'Акустический вечер'],
    specialConcerts: ['Симфонический вечер: Чайковский', 'Вечер домбры', 'Хиты 90-х при свечах', 'Органная музыка: Бах',
      'Джаз под звёздами', 'Музыка из кино: оркестр'],
    plays: ['Ревизор', 'Абай', 'Вишнёвый сад', 'Қыз Жібек', 'Три сестры', 'Женитьба', 'Козы Корпеш — Баян сулу', 'Гамлет',
      'Мастер и Маргарита', 'Ханума', 'Анна Каренина', 'Ромео и Джульетта', 'Чайка', 'Горе от ума', 'Лебединое озеро',
      'Бесприданница', 'Кармен', 'Дядя Ваня'],
    comedians: ['Ерлан Жумабаев', 'Азамат Нурланов', 'Алия Касымова', 'Данияр Сейтов', 'Клуб «Смех без правил»',
      'Open Mic: новые лица', 'Руслан Бекетов', 'Команда «Квартал 7»', 'Стендап-баттл «Кто смешнее»', 'Мадина Оразова'],
    standupShows: ['сольный концерт', 'новый материал', 'большой стендап', 'проверка материала'],
    matches: ['ФК «Беркут» — ФК «Тулпар»', 'ХК «Буран» — ХК «Метель»', 'Вечер бокса «Золотой пояс»', 'Волейбол: «Звезда» — «Молния»',
      'Баскетбол: «Кобра» — «Сокол»', 'Турнир по джиу-джитсу', 'ФК «Тулпар» — ФК «Сарбаз»', 'Кёкпар: показательный турнир',
      'Мини-футбол: «Ураган» — «Вихрь»', 'Теннис: турнир «Открытый корт»'],
    kids: ['Щелкунчик для малышей', 'Приключения Алдара Косе', 'Шоу мыльных пузырей', 'Кукольный театр: Колобок',
      'Цирковое представление «Шапито»', 'Научное шоу профессора Химикуса', 'Лесные друзья', 'Мастер-класс по лепке',
      'Красная Шапочка', 'Шоу роботов для детей', 'Спектакль «Буратино»', 'Шоу дрессированных собак', 'Ёлка «Снежная сказка»'],
    expos: ['Выставка «Мир динозавров»', 'Иммерсивная выставка импрессионистов', 'Музей иллюзий', 'Выставка роботов',
      'Фотовыставка «Степь»', 'Выставка «Космос рядом»', 'Выставка «Средневековые доспехи»', 'Выставка моделей из конструктора',
      'Выставка «Искусство кочевников»'],
  };

  function generateCatalog(options) {
    const opts = options || {};
    const R = makeRandom(opts.seed == null ? 20261013 : opts.seed);
    const now = opts.now == null ? Date.now() : opts.now;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const today = start.getTime();

    const at = (dayOffset, time) => {
      const [h, m] = time.split(':').map(Number);
      return today + dayOffset * DAY + h * HOUR + m * 6e4;
    };
    const isWeekend = d => [0, 6].includes(new Date(today + d * DAY + 12 * HOUR).getDay());
    const cityById = Object.fromEntries(CITIES.map(c => [c.id, c]));

    const venues = [];
    const venuesByCityCat = {};
    for (const city of CITIES) {
      for (const [cat, list] of Object.entries(VENUES)) {
        venuesByCityCat[city.id + ':' + cat] = list.map(([name, capacity], i) => {
          const v = { id: `${city.id}-${cat}-${i}`, name, capacity, city: city.id, category: cat };
          venues.push(v);
          return v;
        });
      }
    }

    const events = [];
    let seq = 0;
    const newId = () => 'ev' + String(++seq).padStart(4, '0');

    function pickUnused(list, used) {
      const free = list.filter(x => !used.has(x));
      if (!free.length) return null;
      const x = R.pick(free);
      used.add(x);
      return x;
    }

    function makeTitle(cat, used) {
      switch (cat) {
        case 'cinema': {
          const t = pickUnused(NAMES.cinema, used);
          return t && { title: t, persona: null };
        }
        case 'concert': {
          if (R.chance(0.7)) {
            const p = pickUnused(NAMES.musicians, used);
            if (p) return { title: `${p}. ${R.pick(NAMES.concertShows)}`, persona: p };
          }
          const t = pickUnused(NAMES.specialConcerts, used);
          return t && { title: t, persona: null };
        }
        case 'theatre': {
          const t = pickUnused(NAMES.plays, used);
          return t && { title: t, persona: null };
        }
        case 'standup': {
          const p = pickUnused(NAMES.comedians, used);
          return p && { title: `${p}: ${R.pick(NAMES.standupShows)}`, persona: p };
        }
        case 'sport': {
          const t = pickUnused(NAMES.matches, used);
          return t && { title: t, persona: t.includes(' — ') ? t.split(' — ')[0] : null };
        }
        case 'kids': {
          const t = pickUnused(NAMES.kids, used);
          return t && { title: t, persona: null };
        }
        case 'expo': {
          const t = pickUnused(NAMES.expos, used);
          return t && { title: t, persona: null };
        }
      }
      return null;
    }

    function fillSessions(starts, cap, q) {
      return starts.sort((a, b) => a - b).map(s => {
        const daysUntil = (s - now) / DAY;
        const fill = clamp(0.12 + 0.75 * q - daysUntil / 90 + 0.15 * R.normal(), 0.02, 0.97);
        return { start: s, capacity: cap, sold: Math.round(cap * fill) };
      });
    }

    function distinctDays(n, lo, hi) {
      const s = new Set();
      for (let guard = 0; s.size < n && guard < 200; guard++) s.add(R.int(lo, hi));
      return [...s];
    }

    function makeSessions(cat, cap, q) {
      const starts = [];
      switch (cat) {
        case 'cinema': {
          const from = -R.int(0, 12);
          const to = Math.min(13, from + R.int(12, 24));
          for (let d = Math.max(0, from); d <= to; d++) {
            R.shuffle(['11:00', '14:30', '17:10', '19:40', '22:00']).slice(0, R.int(2, 3)).forEach(t => starts.push(at(d, t)));
          }
          break;
        }
        case 'concert': {
          const d0 = R.int(6, 70), t = R.pick(['19:00', '20:00']);
          const n = R.chance(0.2) ? 2 : 1;
          for (let i = 0; i < n; i++) starts.push(at(d0 + i, t));
          break;
        }
        case 'theatre':
          distinctDays(R.int(2, 6), 1, 45).forEach(d => starts.push(at(d, isWeekend(d) ? '18:00' : '19:00')));
          break;
        case 'standup':
          distinctDays(R.int(1, 3), 2, 35).forEach(d => starts.push(at(d, '20:00')));
          break;
        case 'sport':
          starts.push(at(R.int(1, 30), R.pick(['16:00', '18:00', '19:30'])));
          break;
        case 'kids': {
          const weekends = [];
          for (let d = 1; d <= 30; d++) if (isWeekend(d)) weekends.push(d);
          R.shuffle(weekends).slice(0, R.int(2, 6)).forEach(d => {
            starts.push(at(d, '11:00'));
            if (R.chance(0.5)) starts.push(at(d, '13:30'));
          });
          break;
        }
        case 'expo': {
          const len = R.int(15, 45);
          for (let d = 0; d <= len; d++) starts.push(at(d, '10:00'));
          break;
        }
      }
      return fillSessions(starts, cap, q);
    }

    function makeEvent(city, cat, used) {
      const t = makeTitle(cat, used);
      if (!t) return null;
      const C = CATEGORIES[cat];
      const venue = R.pick(venuesByCityCat[city.id + ':' + cat]);
      const q = clamp(0.5 + 0.18 * R.normal(), 0.05, 0.97); // скрытое «качество»: система его не видит
      const priceShare = clamp(0.3 * R.next() + 0.5 * q + 0.1 * R.normal(), 0, 1);
      const price = Math.round((C.price[0] + (C.price[1] - C.price[0]) * priceShare) / 500) * 500;
      return {
        id: newId(), city: city.id, category: cat, title: t.title, persona: t.persona,
        venueId: venue.id, venueName: venue.name, price: Math.max(500, price),
        age: R.pick(C.ages), lang: R.chance(0.72) ? 'ru' : 'kz', q,
        createdDaysAgo: R.chance(0.12) ? R.int(0, 2) : R.int(5, 120),
        closed: false, dupOf: null, pinnedHome: null, promoHome: null,
        sessions: makeSessions(cat, cat === 'expo' ? 400 : venue.capacity, q),
      };
    }

    function moveToPast(e) {
      const last = e.sessions[e.sessions.length - 1];
      const shiftDays = Math.ceil((last.start - today) / DAY) + R.int(2, 40);
      e.sessions.forEach(s => {
        s.start -= shiftDays * DAY;
        s.sold = Math.round(s.capacity * clamp(0.4 + 0.5 * e.q, 0, 1));
      });
    }

    const catKeys = Object.keys(CATEGORIES);
    for (const city of CITIES) {
      const used = new Set();
      // По два прошедших события каждой категории — из них складывается история покупок.
      for (const cat of catKeys) {
        for (let i = 0; i < 2; i++) {
          const e = makeEvent(city, cat, used);
          if (!e) continue;
          moveToPast(e);
          e.createdDaysAgo = R.int(60, 200);
          events.push(e);
        }
      }
      const target = Math.round(64 * Math.pow(city.traffic, 0.45));
      let made = 0;
      for (let tries = 0; made < target && tries < target * 4; tries++) {
        const cat = R.weighted(catKeys, k => CATEGORIES[k].share);
        const e = makeEvent(city, cat, used);
        if (!e) continue;
        const r = R.next();
        if (cat !== 'cinema' && cat !== 'expo' && r < 0.07) {
          e.sessions.forEach(s => { if (s.start >= now) s.sold = s.capacity; });
        } else if (r < 0.1) {
          e.closed = true;
        } else if (r < 0.13 && cat !== 'cinema') {
          moveToPast(e);
        }
        events.push(e);
        made++;
      }
    }

    // Дубли: языковые версии и дополнительные концерты заведены отдельными событиями без связи.
    const dupBase = events.filter(e => ['theatre', 'concert', 'standup', 'kids'].includes(e.category) &&
      !e.closed && e.sessions.some(s => s.start >= now && s.sold < s.capacity));
    for (const b of dupBase) {
      if (!R.chance(0.16)) continue;
      const twin = { ...b, id: newId(), dupOf: b.id, pinnedHome: null, promoHome: null, createdDaysAgo: R.int(0, Math.min(b.createdDaysAgo, 20)) };
      const extra = (b.category === 'concert' || b.category === 'standup') && R.chance(0.5);
      if (extra) {
        const last = b.sessions[b.sessions.length - 1];
        twin.title = `${b.title} — дополнительный концерт`;
        twin.sessions = [{ start: last.start + DAY, capacity: last.capacity, sold: Math.round(last.capacity * clamp(0.1 + 0.4 * b.q, 0, 1)) }];
      } else {
        twin.lang = b.lang === 'ru' ? 'kz' : 'ru';
        twin.title = `${b.title} (${twin.lang === 'kz' ? 'на казахском языке' : 'на русском языке'})`;
        twin.sessions = makeSessions(b.category, b.sessions[0].capacity, b.q).slice(0, 2);
      }
      events.push(twin);
    }

    // Статистика за 7 дней. Нынешний порядок «по дате» даёт больше просмотров ближайшим событиям.
    for (const e of events) {
      const city = cityById[e.city];
      const next = e.sessions.find(s => s.start >= now);
      const daysToNext = next ? (next.start - now) / DAY : 60;
      const ageFactor = clamp((e.createdDaysAgo + 0.5) / 7, 0.07, 1);
      const exposure = 0.35 + 1 / (1 + daysToNext / 7);
      const views = Math.round(city.traffic * 300 * (0.25 + e.q) * ageFactor * exposure * R.range(0.7, 1.3) *
        (e.dupOf ? 0.45 : 1) * (next ? 1 : 0.15) * (e.closed ? 0.1 : 1));
      const sales = Math.round(views * CATEGORIES[e.category].conv * (0.35 + 1.4 * e.q) * R.range(0.7, 1.3));
      e.stats = { views7d: views, sales7d: Math.min(sales, views) };
    }

    const hasAvailable = e => e.sessions.some(s => s.start >= now && s.sold < s.capacity);

    // Закрепления редактора и промо-размещения на главной.
    for (const city of CITIES) {
      const live = events.filter(e => e.city === city.id && !e.closed && !e.dupOf && hasAvailable(e));
      if (!live.length) continue;
      const byQ = live.slice().sort((a, b) => b.q - a.q);
      let pinned = R.pick(byQ.slice(0, Math.max(1, Math.round(byQ.length * 0.3))));
      if (city.id === 'karaganda') {
        // Здесь редактор закрепил событие, которое уже распродано, — правило должно его снять.
        const soldOut = events.find(e => e.city === city.id && !e.closed && !e.dupOf &&
          e.sessions.some(s => s.start >= now) && !hasAvailable(e));
        if (soldOut) pinned = soldOut;
      }
      pinned.pinnedHome = 0;
      if (city.traffic >= 0.4) {
        const pool = live.filter(e => e !== pinned && e.q < 0.55);
        if (pool.length) R.pick(pool).promoHome = 5;
      }
    }

    // История покупок прошлых покупателей → «кто купил это, купил и то».
    const co = new Map();
    const purchases = new Map();
    for (const city of CITIES) {
      const pool = events.filter(e => e.city === city.id && !e.closed);
      const users = Math.round(1400 * city.traffic);
      for (let u = 0; u < users; u++) {
        const aff = {};
        for (const c of catKeys) aff[c] = R.gamma(0.5) + 0.01;
        const ws = pool.map(e => Math.pow(aff[e.category], 1.3) * (0.2 + e.q) * (e.createdDaysAgo <= 3 ? 0.12 : 1));
        const total = ws.reduce((s, w) => s + w, 0);
        const picks = new Set();
        const k = R.int(2, 6);
        for (let j = 0; j < k; j++) {
          let x = R.next() * total, idx = 0;
          while (idx < pool.length - 1 && (x -= ws[idx]) > 0) idx++;
          picks.add(pool[idx].id);
        }
        const ids = [...picks].sort();
        ids.forEach(id => purchases.set(id, (purchases.get(id) || 0) + 1));
        for (let a = 0; a < ids.length; a++) {
          for (let b = a + 1; b < ids.length; b++) {
            const key = ids[a] + '|' + ids[b];
            co.set(key, (co.get(key) || 0) + 1);
          }
        }
      }
    }
    const simMap = new Map();
    for (const [key, c] of co) {
      const [a, b] = key.split('|');
      simMap.set(key, c / (Math.sqrt((purchases.get(a) || 1) * (purchases.get(b) || 1)) + 3));
    }

    const prior = {};
    for (const c of catKeys) {
      let v = 0, s = 0;
      events.forEach(e => { if (e.category === c) { v += e.stats.views7d; s += e.stats.sales7d; } });
      prior[c] = v ? s / v : CATEGORIES[c].conv;
    }

    const byId = Object.fromEntries(events.map(e => [e.id, e]));
    const eventsByCity = {};
    for (const e of events) (eventsByCity[e.city] = eventsByCity[e.city] || []).push(e);

    return {
      now, today, cities: CITIES, categories: CATEGORIES, venues, events, byId, eventsByCity, prior, purchases,
      sim: (a, b) => simMap.get(a < b ? a + '|' + b : b + '|' + a) || 0,
    };
  }

  // Готовые посетители для демонстрации: от «ничего не знаем» до «знаем историю покупок».
  function buildDemoVisitors(catalog, cityId) {
    const now = catalog.now;
    const inCity = (catalog.eventsByCity[cityId] || []).filter(e => !e.closed && !e.dupOf);
    const isPast = e => e.sessions.every(s => s.start < now);
    const isLive = e => e.sessions.some(s => s.start >= now && s.sold < s.capacity);
    const take = (cat, pred, k) => inCity.filter(e => e.category === cat && pred(e)).sort((a, b) => b.q - a.q).slice(0, k);
    const history = (list, from) => list.map((e, i) => ({ eventId: e.id, price: e.price, daysAgo: from + i * 23 }));

    let clickEvents = take('standup', isLive, 2);
    if (clickEvents.length < 2) clickEvents = clickEvents.concat(take('concert', isLive, 2 - clickEvents.length));
    const clickCats = [...new Set(clickEvents.map(e => catalog.categories[e.category].name.toLowerCase()))].join(' и ');

    const theatre = take('theatre', isPast, 2).concat(take('concert', isPast, 1));
    const theatreUpcoming = take('theatre', isLive, 1);
    const music = take('concert', isPast, 2).concat(take('standup', isPast, 1));
    const musicUpcoming = take('concert', isLive, 1);
    const parent = take('kids', isPast, 2).concat(take('cinema', isPast, 1));
    const parentUpcoming = take('kids', isLive, 1);

    return [
      { id: 'guest', label: 'Новый гость', type: 'guest', clicks: [], history: [],
        note: 'Ничего не знаем: только город, витрину и время.' },
      { id: 'guest-clicks', label: 'Гость с кликами', type: 'guest', clicks: clickEvents.map(e => e.id), history: [],
        note: `Не авторизован, но в этом визите уже открыл ${clickCats || 'несколько событий'}.` },
      { id: 'theatre', label: 'Зритель театра', type: 'known', clicks: [],
        history: history(theatre, 20).concat(history(theatreUpcoming, 3)),
        note: 'Авторизован. Покупал театр и классику, на один спектакль билет уже куплен.' },
      { id: 'music', label: 'Меломан', type: 'known', clicks: [],
        history: history(music, 15).concat(history(musicUpcoming, 5)),
        note: 'Авторизован. Ходит на концерты и стендап, привык к дорогим билетам.' },
      { id: 'parent', label: 'Родитель', type: 'known', clicks: [],
        history: history(parent, 10).concat(history(parentUpcoming, 2)),
        note: 'Авторизован. Покупает детские события и семейное кино.' },
    ];
  }

  root.TicketonData = { generateCatalog, buildDemoVisitors, makeRandom, mulberry32, CITIES, CATEGORIES };
})(window);
