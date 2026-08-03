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

  function computeMovingAverages(entries){
    return entries.map(e => {
      const d = parseISO(e.date);
      const start = addDays(d, -6);
      const windowEntries = entries.filter(x => {
        const xd = parseISO(x.date);
        return xd >= start && xd <= d;
      });
      const avg = windowEntries.reduce((s,x)=>s+x.weight,0) / windowEntries.length;
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

  function renderChart(entries, movingAvgs, goal, rangeKey){
    const container = document.getElementById('flowChart');

    if (entries.length === 0){
      container.innerHTML = FLOW_EMPTY_HTML;
      return;
    }

    const today = todayDate();
    let start;
    if (rangeKey === 'all') start = parseISO(entries[0].date);
    else start = addDays(today, -(parseInt(rangeKey,10)-1));

    const visible = entries.filter(e => parseISO(e.date) >= start);
    const visibleAvgs = movingAvgs.filter(m => parseISO(m.date) >= start);

    if (visible.length === 0){
      container.innerHTML = FLOW_EMPTY_HTML;
      return;
    }

    const W = 600, H = 220;
    const padL = 40, padR = 14, padT = 18, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const dayStart = start;
    const dayEnd = today > parseISO(visible[visible.length-1].date) ? today : parseISO(visible[visible.length-1].date);
    const totalDays = Math.max(1, (dayEnd - dayStart) / 86400000);

    const xOf = (dateObj) => padL + ((dateObj - dayStart)/86400000 / totalDays) * plotW;

    let weights = visible.map(e => e.weight).concat(visibleAvgs.map(m => m.avg));
    if (goal && goal.weight) weights.push(goal.weight);
    let yMin = Math.min(...weights), yMax = Math.max(...weights);
    if (yMax - yMin < 1.5){
      const mid = (yMax+yMin)/2;
      yMin = mid - 0.75; yMax = mid + 0.75;
    }
    const pad_ = (yMax-yMin) * 0.15;
    yMin -= pad_; yMax += pad_;

    const yOf = (w) => padT + (1 - (w - yMin)/(yMax-yMin)) * plotH;

    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="体重の推移グラフ">`;

    // gridlines (2 horizontal)
    for (let i=0;i<=2;i++){
      const y = padT + (plotH/2)*i;
      svg += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W-padR}" y2="${y.toFixed(1)}" stroke="#E4DFD3" stroke-width="1" />`;
    }

    // goal line
    if (goal && goal.weight){
      const gy = yOf(goal.weight);
      svg += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W-padR}" y2="${gy.toFixed(1)}" stroke="#B98B4E" stroke-width="1.2" stroke-dasharray="4 4" />`;
      svg += `<text x="${W-padR}" y="${(gy-5).toFixed(1)}" text-anchor="end" font-size="9" fill="#B98B4E">目標 ${fmtKg(goal.weight)}kg</text>`;
    }

    // today marker
    const tx = xOf(today);
    svg += `<line x1="${tx.toFixed(1)}" y1="${padT}" x2="${tx.toFixed(1)}" y2="${padT+plotH}" stroke="#C7BCA6" stroke-width="1" stroke-dasharray="2 3" />`;

    // moving average smooth line
    if (visibleAvgs.length >= 2){
      const pts = visibleAvgs.map(m => [xOf(parseISO(m.date)), yOf(m.avg)]);
      svg += `<path d="${catmullRomPath(pts)}" fill="none" stroke="#62785B" stroke-width="2.5" stroke-linecap="round" />`;
    }

    // raw dots
    visible.forEach(e => {
      const cx = xOf(parseISO(e.date));
      const cy = yOf(e.weight);
      if (e.exercise){
        svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.5" fill="none" stroke="#3F6E67" stroke-width="1.6" />`;
      }
      svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="#9C917A" />`;
    });

    // x-axis labels: start / mid / today
    const labelDates = [dayStart, new Date((dayStart.getTime()+dayEnd.getTime())/2), dayEnd];
    labelDates.forEach((d,i) => {
      const anchor = i===0 ? 'start' : (i===2 ? 'end' : 'middle');
      const x = i===0 ? padL : (i===2 ? W-padR : xOf(d));
      svg += `<text x="${x.toFixed(1)}" y="${H-8}" text-anchor="${anchor}" font-size="9.5" fill="#6B685E">${formatShort(d)}</text>`;
    });

    // y-axis labels
    [yMax, (yMax+yMin)/2, yMin].forEach((v,i) => {
      const y = padT + (plotH/2)*i;
      svg += `<text x="${padL-8}" y="${(y+3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#6B685E">${v.toFixed(1)}</text>`;
    });

    svg += `</svg>`;
    container.innerHTML = svg;
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
      return `
        <div class="history-row">
          <span class="history-row__date">${formatShort(d)}（${DOW[d.getDay()]}）</span>
          <span class="history-row__weight">${fmtKg(e.weight)}kg${e.bodyFat ? ` ・ ${fmtKg(e.bodyFat)}%` : ''}</span>
          <span class="history-row__tags">${tags.join('')}</span>
          <button class="history-row__del" data-date="${e.date}">削除</button>
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

  function refreshAll(){
    const entries = loadEntries();
    const goal = loadGoal();
    const stats = computeStats(entries);
    const movingAvgs = computeMovingAverages(entries);

    renderHero(entries, stats);
    renderStatGrid(stats, goal);
    renderChart(entries, movingAvgs, goal, currentRange);
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
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      refreshAll();
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
    setupDisclosures();
    setupGoal();
    setupBackup();
    registerServiceWorker();
    refreshAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
