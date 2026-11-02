/* ================= 定时任务窗口逻辑 =================
 * 左侧任务列表 + 主区三个视图：首页预设 / 新建编辑 / 任务详情。
 * 任务数据经 preload 读写主进程（userData/scheduled-tasks.json），调度在主进程。
 */
(function () {
  const api = window.api || {};
  const $ = (id) => document.getElementById(id);

  /* ---------------- 六个常规任务预设 ---------------- */
  const PRESETS = [
    {
      key: 'work', icon: '📅', name: '安排一周工作提醒', desc: '每周一早上列出本周工作要点和提醒。',
      prompt: '每周一早上为我安排一周工作：请列出本周（今天起 7 天）的工作要点与提醒，按日期分组，标注优先级，并给出每天最重要的 1-3 件事。请以清晰的清单形式输出。',
      repeat: 'weekly', weekdays: [1], time: '08:30',
    },
    {
      key: 'trip', icon: '🧳', name: '周末旅游规划', desc: '每周四为我推荐适合周末出游的目的地和行程。',
      prompt: '请为即将到来的周末做一份出游规划：推荐 2-3 个适合周末的目的地（以我所在城市周边为主），包含交通方式、大致行程安排、天气提示和预算估算，并说明推荐理由。',
      repeat: 'weekly', weekdays: [4], time: '18:00',
    },
    {
      key: 'fin', icon: '💰', name: '每周财务状态', desc: '每周回顾最近的支出，看看有什么需要注意。',
      prompt: '请帮我做一次每周财务回顾：列一份简洁的检查清单（固定支出、待缴账单、异常支出、可优化项），并给我 3 条本周财务建议。请以模板加引导问题的形式输出，方便我填写实际数据后得到结论。',
      repeat: 'weekly', weekdays: [0], time: '21:00',
    },
    {
      key: 'meal', icon: '🥗', name: '每周饮食规划', desc: '规划一周的餐食，并列出食材采购清单。',
      prompt: '请为我规划未来一周的餐食：每天三餐搭配均衡、简单易做，标注大致热量；最后汇总一份按超市分区整理的食材采购清单（含用量）。',
      repeat: 'weekly', weekdays: [0], time: '17:00',
    },
    {
      key: 'mail', icon: '📧', name: '监控电子邮箱', desc: '每天提醒检查邮箱，总结需要处理的新邮件。',
      prompt: '请提醒我检查今天的邮箱：输出一份「邮件处理清单」模板（重要 / 待回复 / 可归档三类），并提醒我按优先级处理。若我提供了邮箱摘要内容，请帮我归纳要点并起草回复。',
      repeat: 'daily', time: '09:00',
    },
    {
      key: 'aiuse', icon: '📊', name: '每周AI使用量总结', desc: '每周总结 AI 使用情况与效率收益。',
      prompt: '请帮我做一次每周 AI 使用量总结：给出一份统计模板（使用次数、主要场景、节省的耗时、产出价值），并针对下周给出 3 条更高效使用 AI 的建议。请以引导提问的形式让我补充数据后给出结论。',
      repeat: 'weekly', weekdays: [0], time: '22:00',
    },
  ];

  const WD = ['日', '一', '二', '三', '四', '五', '六'];

  let tasks = [];
  let view = 'home';
  let editingId = null;   // null = 新建
  let editingIcon = '⏰';
  let detailId = null;
  let runWait = null;     // { id, since } 等待「立即运行」出结果

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function schedText(t) {
    if (t.repeat === 'weekly') {
      const wds = (t.weekdays && t.weekdays.length ? t.weekdays : [1]).slice().sort().map((x) => WD[x]).join('、');
      return '每周' + wds + ' ' + t.time;
    }
    if (t.repeat === 'monthly') return '每月 ' + (t.day || 1) + ' 号 ' + t.time;
    return '每天 ' + t.time;
  }
  function fmtNext(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p2 = (v) => String(v).padStart(2, '0');
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WD[d.getDay()] + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const p2 = (v) => String(v).padStart(2, '0');
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function show(sec) {
    view = sec;
    $('view-home').classList.toggle('hidden', sec !== 'home');
    $('view-editor').classList.toggle('hidden', sec !== 'editor');
    $('view-detail').classList.toggle('hidden', sec !== 'detail');
  }

  /* ---------------- 左侧列表 ---------------- */
  function renderSide() {
    const list = $('task-list');
    list.innerHTML = '';
    $('task-empty').classList.toggle('hidden', tasks.length > 0);
    tasks.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'task-item' + (view === 'detail' && detailId === t.id ? ' active' : '');
      b.innerHTML =
        '<span class="ti">' + esc(t.icon || '⏰') + '</span>' +
        '<span class="tm"><span class="tn">' + esc(t.name) + '</span>' +
        '<span class="ts">' + esc(schedText(t)) + (t.enabled ? '' : ' · 已暂停') + '</span></span>' +
        '<span class="dot' + (t.enabled ? '' : ' paused') + '"></span>';
      b.addEventListener('click', () => openDetail(t.id));
      list.appendChild(b);
    });
  }

  /* ---------------- 首页预设 ---------------- */
  function renderPresets() {
    const g = $('preset-grid');
    g.innerHTML = '';
    PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'preset';
      b.innerHTML = '<span class="pi">' + p.icon + '</span><span class="pt">' + esc(p.name) + '</span><span class="pd">' + esc(p.desc) + '</span>';
      b.querySelector('.pt').style.cssText = 'display:block;font-size:13.5px;font-weight:600;margin-bottom:3px;';
      b.querySelector('.pd').style.cssText = 'display:block;font-size:12.5px;color:var(--muted);line-height:1.55;';
      b.addEventListener('click', () => openEditor(p));
      g.appendChild(b);
    });
  }

  /* ---------------- 新建 / 编辑 ---------------- */
  function renderWeekdays(sel) {
    const wrap = $('ed-weekdays');
    wrap.innerHTML = '';
    WD.forEach((_, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wd' + ((sel || []).indexOf(i) >= 0 ? ' on' : '');
      b.textContent = WD[i];
      b.addEventListener('click', () => b.classList.toggle('on'));
      wrap.appendChild(b);
    });
  }

  function syncRepeatUI() {
    const rep = $('ed-repeat').value;
    $('ed-weekdays').classList.toggle('hidden', rep !== 'weekly');
    $('ed-day-wrap').classList.toggle('hidden', rep !== 'monthly');
  }

  function openEditor(seed) {
    editingId = seed && seed.id ? seed.id : null;
    editingIcon = (seed && seed.icon) || '⏰';
    const src = seed || {};
    $('ed-prompt').value = src.prompt || '';
    $('ed-name').value = src.name || '';
    $('ed-repeat').value = src.repeat || 'daily';
    $('ed-time').value = src.time || '09:00';
    $('ed-day').value = src.day || 1;
    renderWeekdays(src.weekdays || [1]);
    $('ed-local').checked = src.localRun !== false;
    $('ed-notify').value = src.notify || 'important';
    $('ed-web').checked = src.web !== false;
    $('ed-save').textContent = editingId ? '保存' : '创建';
    syncRepeatUI();
    show('editor');
    renderSide();
  }

  async function saveEditor() {
    const prompt = $('ed-prompt').value.trim();
    if (!prompt) { alert('请先填写任务提示词：告诉 AI 这个任务每次要做些什么'); return; }
    const weekdays = Array.from(document.querySelectorAll('#ed-weekdays .wd.on'))
      .map((b) => WD.indexOf(b.textContent)).filter((x) => x >= 0);
    const base = {
      icon: editingIcon,
      name: $('ed-name').value.trim() || '未命名任务',
      prompt,
      repeat: $('ed-repeat').value,
      time: $('ed-time').value || '09:00',
      weekdays: weekdays.length ? weekdays : [1],
      day: Math.min(Math.max(parseInt($('ed-day').value, 10) || 1, 1), 28),
      localRun: $('ed-local').checked,
      notify: $('ed-notify').value,
      web: $('ed-web').checked,
    };
    let next = [];
    if (editingId) {
      const old = tasks.find((t) => t.id === editingId);
      next = tasks.map((t) => (t.id === editingId ? Object.assign({}, t, base) : t));
      detailId = editingId;
    } else {
      const t = Object.assign({ id: 't' + Date.now() + Math.random().toString(36).slice(2, 5), enabled: true, history: [], createdAt: Date.now() }, base);
      next = tasks.concat([t]);
      detailId = t.id;
    }
    await api.scheduleTasksSave(next);
    await load();
    show('detail');
    renderDetail();
    renderSide();
  }

  /* ---------------- 详情 ---------------- */
  function openDetail(id) {
    detailId = id;
    runWait = null;
    show('detail');
    renderDetail();
    renderSide();
  }

  function renderDetail() {
    const t = tasks.find((x) => x.id === detailId);
    if (!t) { show('home'); renderSide(); return; }
    $('d-icon').textContent = t.icon || '⏰';
    $('d-name').textContent = t.name;
    const waiting = runWait && runWait.id === t.id;
    $('d-sub').textContent = schedText(t) + (t.nextRun && t.enabled && t.localRun !== false ? ' · 下次：' + fmtNext(t.nextRun) : '');
    const chip = $('d-state');
    if (waiting) { chip.textContent = '运行中'; chip.className = 'chip running'; }
    else { chip.textContent = t.enabled ? (t.localRun === false ? '未在本机运行' : '已启用') : '已暂停'; chip.className = 'chip' + (t.enabled && t.localRun !== false ? '' : ' paused'); }
    $('d-toggle').textContent = t.enabled ? '暂停' : '启用';
    const hist = $('d-hist');
    hist.innerHTML = '';
    if (!t.history || !t.history.length) {
      hist.innerHTML = '<div class="hist-empty">还没有运行记录，到点会自动运行，也可以点上面的「立即运行」试一次</div>';
      return;
    }
    t.history.forEach((h) => {
      const d = document.createElement('div');
      d.className = 'hist';
      d.innerHTML =
        '<div class="hh"><span class="st ' + (h.ok ? 'ok">✓ 成功' : 'err">✕ 失败') + '</span>' +
        '<span>' + esc(fmtTime(h.time)) + '</span></div>' +
        '<pre>' + esc(h.text || '') + '</pre>';
      hist.appendChild(d);
    });
  }

  /* ---------------- 数据 ---------------- */
  async function load() {
    try { tasks = (await api.scheduleTasksGet()) || []; } catch (e) { tasks = []; }
    if (runWait) {
      const t = tasks.find((x) => x.id === runWait.id);
      const last = t && t.history && t.history[0];
      if (last && last.time >= runWait.since) runWait = null;
    }
  }

  function renderAll() {
    renderSide();
    if (view === 'detail') renderDetail();
  }

  /* ---------------- 绑定 ---------------- */
  $('btn-new').addEventListener('click', () => openEditor(null));
  $('ed-cancel').addEventListener('click', () => {
    if (editingId) { openDetail(editingId); } else { show('home'); renderSide(); }
  });
  $('ed-save').addEventListener('click', saveEditor);
  $('ed-repeat').addEventListener('change', syncRepeatUI);
  $('ed-adv-toggle').addEventListener('click', () => {
    const open = $('ed-adv').classList.toggle('hidden') === false;
    $('ed-adv-toggle').classList.toggle('open', open);
  });
  $('d-run').addEventListener('click', async () => {
    if (!detailId) return;
    try {
      const r = await api.scheduleRunNow(detailId);
      if (r && r.ok) { runWait = { id: detailId, since: Date.now() }; renderDetail(); }
      else if (r && r.error) alert(r.error);
    } catch (e) { alert(e.message); }
  });
  $('d-toggle').addEventListener('click', async () => {
    const t = tasks.find((x) => x.id === detailId);
    if (!t) return;
    t.enabled = !t.enabled;
    await api.scheduleTasksSave(tasks);
    await load();
    renderDetail(); renderSide();
  });
  $('d-edit').addEventListener('click', () => {
    const t = tasks.find((x) => x.id === detailId);
    if (t) openEditor(t);
  });
  $('d-del').addEventListener('click', async () => {
    const t = tasks.find((x) => x.id === detailId);
    if (!t) return;
    if (!confirm('确定删除任务「' + t.name + '」？删除后不可恢复。')) return;
    await api.scheduleTasksSave(tasks.filter((x) => x.id !== detailId));
    detailId = null;
    await load();
    show('home');
    renderSide();
  });

  if (api.onScheduleChanged) api.onScheduleChanged(async () => { await load(); renderAll(); });

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    renderPresets();
    await load();
    renderSide();
    show('home');
  })();
})();
