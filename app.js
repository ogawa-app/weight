(() => {
  'use strict';

  const STORAGE_KEY = 'weightflow_entries_v1';
  const GOAL_KEY = 'weightflow_goal_v1';
  const DOW = ['日','月','火','水','木','金','土'];

  /* ---------------- Utilities ---------------- */

  function pad(n){ return String(n).padStart(2,'0'); }

  function toISODate(d){
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  function todayDate(){
    const d = new Date();
    d.setHours(0,0,0,0);
    return d;
  }

  function todayStr(){ return toISODate(todayDate()); }

  function parseISO(s){ return new Date(s + 'T00:00:00'); }

  function formatJPDate(d){
    return `${d.getMonth()+1}月${d.getDate()}日（${DOW[d.getDay()]}）`;
  }

  function formatShort(d){
    return `${d.getMonth()+1}/${d.getDate()}`;
  }

  function addDays(d, n){
    const nd = new Date(d);
    nd.setDate(nd.getDate()+n);
    return nd;
  }

  function fmtKg(n){
    if (n === null || n === undefined || Number.isNaN(n)) return '--';
    return n.toFixed(1);
  }

  function escapeHtml(s){
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  }

  /* ---------------- Storage ---------------- */

  function loadEntries(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      const migrated = arr.map(e => ({
        ...e,
        exercise: e.exercise ?? e.tableTennis ?? false,
        bento: e.bento ?? (e.meal === 'bento'),
      }));
      return migrated.sort((a,b)=> a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    }catch(e){
      console.error('load failed', e);
      return [];
    }
  }

  function saveEntries(entries){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }

  function upsertEntry(entry){
    const entries = loadEntries();
    const idx = entries.findIndex(e => e.date === entry.date);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    entries.sort((a,b)=> a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    saveEntries(entries);
    return entries;
  }

  function deleteEntry(date){
    const entries = loadEntries().filter(e => e.date !== date);
    saveEntries(entries);
    return entries;
  }

  function loadGoal(){
    try{
      const raw = localStorage.getItem(GOAL_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }

  function saveGoal(goal){
    if (goal) localStorage.setItem(GOAL_KEY, JSON.stringify(goal));
    else localStorage.removeItem(GOAL_KEY);
  }

  /* ---------------- Stats ---------------- */

  function computeMovingAverages(entries, field='weight'){
    const withField = entries.filter(e => e[field] !== null && e[field] !== undefined && !Number.isNaN(e[field]));
    return withField.map(e => {
      const d = parseISO(e.date);
      const start = addDays(d, -6);
      const windowEntries = withField.filter(x => {
        const xd = parseISO(x.date);
        return xd >= start && xd <= d;
      });
      const avg = windowEntries.reduce((s,x)=>s+x[field],0) / windowEntries.length;
      return { date: e.date, avg };
    });
  }

  function findAvgNear(movingAvgs, targetDate, toleranceDays=2){
    let best = null, bestDiff = Infinity;
    for (const m of movingAvgs){
      const diff = Math.abs((parseISO(m.date) - targetDate) / 86400000);
      if (diff < bestDiff){ bestDiff = diff; best = m; }
    }
    if (best && bestDiff <= toleranceDays) return best.avg;
    return null;
  }

  function linearSlopePerDay(points){
    // points: [{x:dateObj, y:number}]
    const n = points.length;
    if (n < 2) return null;
    const x0 = points[0].x.getTime();
    const xs = points.map(p => (p.x.getTime()-x0)/86400000);
    const ys = points.map(p => p.y);
    const xMean = xs.reduce((a,b)=>a+b,0)/n;
    const yMean = ys.reduce((a,b)=>a+b,0)/n;
    let num=0, den=0;
    for (let i=0;i<n;i++){
      num += (xs[i]-xMean)*(ys[i]-yMean);
      den += (xs[i]-xMean)**2;
    }
    if (den === 0) return null;
    return num/den; // kg per day
  }

  function computeStats(entries){
    const stats = { latest:null, avg7:null, weekDiff:null, paceWeek:null };
    if (entries.length === 0) return stats;

    const movingAvgs = computeMovingAverages(entries);
    const last = entries[entries.length-1];
    stats.latest = last.weight;
    stats.avg7 = movingAvgs[movingAvgs.length-1].avg;

    const lastDate = parseISO(last.date);
    const weekAgoAvg = findAvgNear(movingAvgs, addDays(lastDate,-7), 2);
    if (weekAgoAvg !== null) stats.weekDiff = stats.avg7 - weekAgoAvg;

    const windowStart = addDays(lastDate, -13);
    const recentPts = movingAvgs
      .filter(m => parseISO(m.date) >= windowStart)
      .map(m => ({ x: parseISO(m.date), y: m.avg }));
    const slopePerDay = linearSlopePerDay(recentPts);
    stats.paceWeek = slopePerDay === null ? null : slopePerDay * 7;

    return stats;
  }

  function computeGoalProjection(stats, goal){
    if (!goal || !goal.weight || stats.avg7 === null) return null;
    const diff = stats.avg7 - goal.weight; // positive: need to lose
    if (Math.abs(diff) < 0.1) return { type: 'reached' };
    if (stats.paceWeek === null) return { type: 'no-pace' };
    const needsDecrease = diff > 0;
    const isDecreasing = stats.paceWeek < -0.01;
    const isIncreasing = stats.paceWeek > 0.01;
    if ((needsDecrease && !isDecreasing) || (!needsDecrease && !isIncreasing)){
      return { type: 'wrong-direction' };
    }
    const perDay = stats.paceWeek/7;
    const days = Math.abs(diff/perDay);
    return { type: 'on-track', days: Math.round(days) };
  }

  /* ---------------- Rendering: Hero ---------------- */

  function renderHero(entries, stats){
    document.getElementById('todayLabel').textContent = formatJPDate(todayDate());
    document.getElementById('latestWeight').textContent = stats.latest !== null ? fmtKg(stats.latest) : '--';
    document.getElementById('avgSub').textContent = stats.avg7 !== null
      ? `7日平均：${fmtKg(stats.avg7)} kg`
      : '7日平均：--';

    const badge = document.getElementById('trendBadge');
    const arrow = document.getElementById('trendArrow');
    const text = document.getElementById('trendText');
    badge.classList.remove('is-up','is-down');

    if (stats.weekDiff === null){
      arrow.textContent = '–';
      text.textContent = entries.length === 0 ? '記録を始めましょう' : 'もう少し記録がたまると先週比が出ます';
    } else if (Math.abs(stats.weekDiff) < 0.05){
      arrow.textContent = '→';
      text.textContent = '先週とほぼ同じ';
    } else if (stats.weekDiff < 0){
      badge.classList.add('is-down');
      arrow.textContent = '↓';
      text.textContent = `先週より ${fmtKg(Math.abs(stats.weekDiff))} kg 減`;
    } else {
      badge.classList.add('is-up');
      arrow.textContent = '↑';
      text.textContent = `先週より ${fmtKg(stats.weekDiff)} kg 増`;
    }
  }

  /* ---------------- Rendering: Stats grid ---------------- */

  function renderStatGrid(stats, goal){
    document.getElementById('statAvg7').textContent = stats.avg7 !== null ? `${fmtKg(stats.avg7)} kg` : '--';
    document.getElementById('statWeekDiff').textContent = stats.weekDiff !== null
      ? `${stats.weekDiff > 0 ? '+' : ''}${fmtKg(stats.weekDiff)} kg`
      : '--';
    document.getElementById('statPace').textContent = stats.paceWeek !== null
      ? `${stats.paceWeek > 0 ? '+' : ''}${fmtKg(stats.paceWeek)} kg/週`
      : '--';

    const goalEl = document.getElementById('statGoal');
    if (!goal || !goal.weight){
      goalEl.textContent = '未設定';
      return;
    }
    const proj = computeGoalProjection(stats, goal);
    if (!proj){ goalEl.textContent = '--'; return; }
    if (proj.type === 'reached') goalEl.textContent = '達成！';
    else if (proj.type === 'no-pace') goalEl.textContent = 'データ不足';
    else if (proj.type === 'wrong-direction') goalEl.textContent = '現ペースでは未達';
    else goalEl.textContent = `あと約${proj.days}日`;
  }

  /* ---------------- Rendering: Chart ---------------- */

  function catmullRomPath(points){
    if (points.length < 2) return '';
    let d = `M ${points[0][0].toFixed(1)},${points[0][1].toFixed(1)} `;
    for (let i=0; i<points.length-1; i++){
      const p0 = points[i-1] || points[i];
      const p1 = points[i];
      const p2 = points[i+1];
      const p3 = points[i+2] || p2;
      const cp1x = p1[0] + (p2[0]-p0[0])/6;
      const cp1y = p1[1] + (p2[1]-p0[1])/6;
      const cp2x = p2[0] - (p3[0]-p1[0])/6;
      const cp2y = p2[1] - (p3[1]-p1[1])/6;
      d += `C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)} `;
    }
    return d;
  }

  const FLOW_EMPTY_HTML = '<p class="flow-chart__empty" id="flowEmpty">まだ記録がありません。今日の体重を記録すると、ここに流れが見えてきます。</p>';
  const FLOW_EMPTY_BODYFAT_HTML = '<p class="flow-chart__empty">体脂肪率の記録がまだありません。</p>';

  const METRIC_FIELD = { weight: 'weight', bodyFat: 'bodyFat' };
  const METRIC_UNIT = { weight: 'kg', bodyFat: '%' };
  const METRIC_ARIA = { weight: '体重の推移グラフ', bodyFat: '体脂肪率の推移グラフ' };

  // Builds a set of x-axis tick dates spaced at least `minSpacingPx` apart
  // on screen, so labels never overlap or duplicate regardless of how many
  // days the chart spans (this replaces a fixed "3 labels" scheme that broke
  // down — and could render the same date twice — when the visible range
  // was very short, e.g. right after starting to use the app).
  function buildXTicks(dayStart, dayEnd, dayPx){
    const NICE_STEPS = [1,2,3,5,7,10,14,21,30,45,60,90,120,180,270,365,730];
    const spanDays = Math.max(0, Math.round((dayEnd - dayStart) / 86400000));
    const minSpacingPx = 64;
    let stepDays = NICE_STEPS.find(s => s * dayPx >= minSpacingPx);
    if (!stepDays) stepDays = Math.max(1, Math.ceil(spanDays / 4) || 1);

    const ticks = [];
    for (let d = 0; d <= spanDays; d += stepDays){
      ticks.push(addDays(dayStart, d));
    }
    if (ticks.length === 0) ticks.push(dayStart);

    const lastTick = ticks[ticks.length - 1];
    const daysFromEnd = (dayEnd - lastTick) / 86400000;
    if (daysFromEnd > stepDays * 0.4){
      ticks.push(dayEnd);
    } else {
      ticks[ticks.length - 1] = dayEnd;
    }
    return ticks;
  }

  // The chart draws its data at a fixed "days per screen" scale for the
  // 1ヶ月/3ヶ月 ranges (30 / 90 days always fill one viewport width), with
  // the y-axis frozen in its own small SVG and the plot itself scrolling
  // horizontally so older records can always be reached by scrolling left.
  // 全期間 instead scales the whole history to fit exactly one screen.
  // Data always starts flush at the left edge of the plot, so a short
  // history never gets stranded near the right edge.
  function renderChart(entries, goal, rangeKey, metric){
    const container = document.getElementById('flowChart');
    const hint = document.getElementById('flowHint');
    const field = METRIC_FIELD[metric] || 'weight';
    const unit = METRIC_UNIT[field];

    const withField = entries.filter(e => e[field] !== null && e[field] !== undefined && !Number.isNaN(e[field]));

    if (withField.length === 0){
      container.innerHTML = field === 'bodyFat' ? FLOW_EMPTY_BODYFAT_HTML : FLOW_EMPTY_HTML;
      hint.hidden = true;
      return;
    }

    const movingAvgs = computeMovingAverages(entries, field);

    const today = todayDate();
    const dayStart = parseISO(withField[0].date);
    const lastDate = parseISO(withField[withField.length - 1].date);
    const dayEnd = today > lastDate ? today : lastDate;
    const fullSpanDays = Math.max(1, (dayEnd - dayStart) / 86400000);

    const H = 260, padT = 24, padB = 32;
    const plotH = H - padT - padB;
    const padPlotL = 14, padPlotR = 54;
    const axisW = 46;

    const containerWidth = Math.max(220, Math.round(container.clientWidth || 320));
    const viewportPlotWidth = Math.max(160, containerWidth - axisW);

    const scaleDays = rangeKey === 'all' ? fullSpanDays : parseInt(rangeKey, 10);
    const dayPx = Math.max(2, (viewportPlotWidth - padPlotL - padPlotR) / scaleDays);
    const plotPxWidth = Math.max(viewportPlotWidth, Math.round(padPlotL + fullSpanDays * dayPx + padPlotR));
    const isScrollable = plotPxWidth > viewportPlotWidth + 1;

    const xOf = (dateObj) => padPlotL + ((dateObj - dayStart) / 86400000) * dayPx;

    let values = withField.map(e => e[field]).concat(movingAvgs.map(m => m.avg));
    if (field === 'weight' && goal && goal.weight) values.push(goal.weight);
    let yMin = Math.min(...values), yMax = Math.max(...values);
    if (yMax - yMin < 1.5){
      const mid = (yMax + yMin) / 2;
      yMin = mid - 0.75; yMax = mid + 0.75;
    }
    const padY = (yMax - yMin) * 0.15;
    yMin -= padY; yMax += padY;

    const yOf = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // ---- y-axis (frozen) ----
    let yaxisSvg = `<svg class="flow-chart__yaxis" width="${axisW}" height="${H}" viewBox="0 0 ${axisW} ${H}">`;
    [yMax, (yMax + yMin) / 2, yMin].forEach((v, i) => {
      const y = padT + (plotH / 2) * i;
      yaxisSvg += `<text x="${axisW - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="13" fill="#6B685E">${v.toFixed(1)}</text>`;
    });
    yaxisSvg += `</svg>`;

    // ---- plot (scrollable) ----
    let svg = `<svg class="flow-chart__plot" viewBox="0 0 ${plotPxWidth} ${H}" width="${plotPxWidth}" height="${H}" role="img" aria-label="${METRIC_ARIA[field]}">`;

    // gridlines (3 horizontal)
    for (let i = 0; i <= 2; i++){
      const y = padT + (plotH / 2) * i;
      svg += `<line x1="0" y1="${y.toFixed(1)}" x2="${plotPxWidth}" y2="${y.toFixed(1)}" stroke="#E4DFD3" stroke-width="1" />`;
    }

    // goal line (weight only)
    if (field === 'weight' && goal && goal.weight){
      const gy = yOf(goal.weight);
      svg += `<line x1="0" y1="${gy.toFixed(1)}" x2="${plotPxWidth}" y2="${gy.toFixed(1)}" stroke="#B98B4E" stroke-width="1.5" stroke-dasharray="5 4" />`;
      svg += `<text x="${plotPxWidth - 8}" y="${(gy - 7).toFixed(1)}" text-anchor="end" font-size="13" font-weight="700" fill="#B98B4E">目標 ${fmtKg(goal.weight)}kg</text>`;
    }

    // today marker
    const tx = xOf(today);
    svg += `<line x1="${tx.toFixed(1)}" y1="${padT}" x2="${tx.toFixed(1)}" y2="${padT + plotH}" stroke="#C7BCA6" stroke-width="1.2" stroke-dasharray="2 3" />`;

    // raw values connecting line (thin, behind the moving-average line)
    if (withField.length >= 2){
      const rawPts = withField.map(e => [xOf(parseISO(e.date)), yOf(e[field])]);
      svg += `<path d="${catmullRomPath(rawPts)}" fill="none" stroke="#C7BCA6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.85" />`;
    }

    // moving average smooth line
    if (movingAvgs.length >= 2){
      const pts = movingAvgs.map(m => [xOf(parseISO(m.date)), yOf(m.avg)]);
      svg += `<path d="${catmullRomPath(pts)}" fill="none" stroke="#62785B" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />`;
    }

    // raw dots
    withField.forEach(e => {
      const cx = xOf(parseISO(e.date));
      const cy = yOf(e[field]);
      if (e.exercise){
        svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8" fill="none" stroke="#3F6E67" stroke-width="2.2" />`;
      }
      svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.5" fill="#9C917A" stroke="#FFFFFF" stroke-width="1.5" />`;
    });

    // latest value label
    const lastPt = withField[withField.length - 1];
    const lx = xOf(parseISO(lastPt.date));
    const ly = yOf(lastPt[field]);
    const lastAnchor = lx < 80 ? 'start' : 'end';
    const lastX = lastAnchor === 'end' ? lx - 10 : lx + 10;
    svg += `<text x="${lastX.toFixed(1)}" y="${(ly - 12).toFixed(1)}" text-anchor="${lastAnchor}" font-size="14" font-weight="700" fill="#26251F">${fmtKg(lastPt[field])}${unit}</text>`;

    // x-axis labels
    const ticks = buildXTicks(dayStart, dayEnd, dayPx);
    ticks.forEach((d, i) => {
      const x = xOf(d);
      const anchor = i === 0 ? 'start' : (i === ticks.length - 1 ? 'end' : 'middle');
      const clampedX = anchor === 'start' ? Math.max(x, 2) : (anchor === 'end' ? Math.min(x, plotPxWidth - 2) : x);
      svg += `<text x="${clampedX.toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" font-size="13" fill="#6B685E">${formatShort(d)}</text>`;
    });

    svg += `</svg>`;

    container.innerHTML = `${yaxisSvg}<div class="flow-chart__scroll">${svg}</div>`;

    const scrollEl = container.querySelector('.flow-chart__scroll');
    if (scrollEl) scrollEl.scrollLeft = scrollEl.scrollWidth;

    hint.hidden = !(isScrollable && rangeKey !== 'all');
  }

  /* ---------------- Rendering: History ---------------- */

  function renderHistory(entries){
    const list = document.getElementById('historyList');
    if (entries.length === 0){
      list.innerHTML = '<p style="color:#6B685E;font-size:13px;">まだ記録がありません。</p>';
      return;
    }
    const rows = entries.slice().reverse().map(e => {
      const d = parseISO(e.date);
      const tags = [];
      if (e.exercise) tags.push('<i style="background:#3F6E67" title="運動した"></i>');
      if (e.bento) tags.push('<i style="background:#62785B" title="固定メニュー"></i>');
      const memoHtml = e.memo
        ? `<p class="history-row__memo">${escapeHtml(e.memo)}</p>`
        : '';
      return `
        <div class="history-row">
          <span class="history-row__date">${formatShort(d)}（${DOW[d.getDay()]}）</span>
          <span class="history-row__weight">${fmtKg(e.weight)}kg${e.bodyFat ? ` ・ ${fmtKg(e.bodyFat)}%` : ''}</span>
          <span class="history-row__tags">${tags.join('')}</span>
          <button class="history-row__del" data-date="${e.date}">削除</button>
          ${memoHtml}
        </div>`;
    }).join('');
    list.innerHTML = rows;
    list.querySelectorAll('.history-row__del').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm(`${btn.dataset.date} の記録を削除しますか？`)){
          deleteEntry(btn.dataset.date);
          refreshAll();
          showToast('削除しました');
        }
      });
    });
  }

  /* ---------------- Toast ---------------- */

  let toastTimer = null;
  function showToast(message){
    const toast = document.getElementById('toast');
    const msg = document.getElementById('toastMsg');
    msg.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 1800);
  }

  /* ---------------- App state / wiring ---------------- */

  let currentRange = '30';
  let currentMetric = 'weight';

  function refreshAll(){
    const entries = loadEntries();
    const goal = loadGoal();
    const stats = computeStats(entries);

    renderHero(entries, stats);
    renderStatGrid(stats, goal);
    renderChart(entries, goal, currentRange, currentMetric);
    renderHistory(entries);
    prefillTodayForm(entries);
  }

  function prefillTodayForm(entries){
    const today = todayStr();
    const existing = entries.find(e => e.date === today);
    const hint = document.getElementById('editingHint');
    if (existing){
      document.getElementById('inputWeight').value = existing.weight;
      document.getElementById('inputBodyFat').value = existing.bodyFat ?? '';
      document.getElementById('inputCondition').checked = !!existing.condition;
      document.getElementById('inputExercise').checked = !!existing.exercise;
      document.getElementById('inputBento').checked = !!existing.bento;
      document.getElementById('inputMemo').value = existing.memo || '';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }

  function setupForm(){
    document.getElementById('entryForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const weight = parseFloat(document.getElementById('inputWeight').value);
      if (Number.isNaN(weight) || weight <= 0) return;
      const bodyFatRaw = document.getElementById('inputBodyFat').value;

      const entry = {
        date: todayStr(),
        weight,
        bodyFat: bodyFatRaw === '' ? null : parseFloat(bodyFatRaw),
        condition: document.getElementById('inputCondition').checked,
        exercise: document.getElementById('inputExercise').checked,
        bento: document.getElementById('inputBento').checked,
        memo: document.getElementById('inputMemo').value.trim()
      };
      upsertEntry(entry);
      refreshAll();
      showToast('今日の記録を保存しました');
    });
  }

  function setupRangeButtons(){
    document.getElementById('rangeButtons').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-range]');
      if (!btn) return;
      currentRange = btn.dataset.range;
      document.querySelectorAll('#rangeButtons .segmented__btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      refreshAll();
    });
  }

  function setupMetricButtons(){
    document.getElementById('metricButtons').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-metric]');
      if (!btn) return;
      currentMetric = btn.dataset.metric;
      document.querySelectorAll('#metricButtons .segmented__btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      refreshAll();
    });
  }

  function setupChartResize(){
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        renderChart(loadEntries(), loadGoal(), currentRange, currentMetric);
      }, 150);
    });
  }

  function setupDisclosures(){
    [['goalToggle','goalBody'], ['historyToggle','historyBody'], ['backupToggle','backupBody']]
      .forEach(([toggleId, bodyId]) => {
        const toggle = document.getElementById(toggleId);
        const body = document.getElementById(bodyId);
        toggle.setAttribute('aria-expanded','false');
        toggle.addEventListener('click', () => {
          const open = body.hidden;
          body.hidden = !open;
          toggle.setAttribute('aria-expanded', String(open));
        });
      });
  }

  function setupGoal(){
    const goal = loadGoal();
    if (goal){
      document.getElementById('goalWeight').value = goal.weight ?? '';
      document.getElementById('goalDate').value = goal.date ?? '';
    }
    document.getElementById('goalSaveBtn').addEventListener('click', () => {
      const w = parseFloat(document.getElementById('goalWeight').value);
      const d = document.getElementById('goalDate').value;
      if (Number.isNaN(w)) return;
      saveGoal({ weight: w, date: d || null });
      refreshAll();
      showToast('目標を保存しました');
    });
    document.getElementById('goalClearBtn').addEventListener('click', () => {
      saveGoal(null);
      document.getElementById('goalWeight').value = '';
      document.getElementById('goalDate').value = '';
      refreshAll();
      showToast('目標を削除しました');
    });
  }

  function setupBackup(){
    document.getElementById('exportBtn').addEventListener('click', () => {
      const data = { entries: loadEntries(), goal: loadGoal(), exportedAt: new Date().toISOString() };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `weightflow-backup-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('importInput').addEventListener('change', (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try{
          const data = JSON.parse(reader.result);
          if (!Array.isArray(data.entries)) throw new Error('invalid');
          if (!confirm('現在のデータを上書きして読み込みますか？この操作は取り消せません。')) return;
          saveEntries(data.entries);
          saveGoal(data.goal || null);
          refreshAll();
          alert('読み込みました。');
        }catch(e){
          alert('読み込みに失敗しました。ファイルの形式を確認してください。');
        }
      };
      reader.readAsText(file);
      ev.target.value = '';
    });
  }

  function registerServiceWorker(){
    if ('serviceWorker' in navigator){
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }

  function init(){
    setupForm();
    setupRangeButtons();
    setupMetricButtons();
    setupChartResize();
    setupDisclosures();
    setupGoal();
    setupBackup();
    registerServiceWorker();
    refreshAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
