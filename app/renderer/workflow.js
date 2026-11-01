/* ================= 自动化工作流编辑器（ComfyUI 风格节点画布） =================
 * 把「替换文件 / 文件名修改 / 格式转换 / PDF去水印 / 文件自动化 / PPT编写」
 * 六大功能与「来源 / 规则 / 技能 / 保存位置 / AI模型」参数拆成独立节点，
 * 用 SVG 贝塞尔曲线连线组成可执行工作流，右下角「运行」按顺序执行。
 */
(function () {
  'use strict';
  const api = window.api;
  const SVGNS = 'http://www.w3.org/2000/svg';

  const NODE_W = 260;
  const HEAD_H = 30;     // 节点标题栏高度
  const PORT_GAP = 24;   // 每个端口行高（端口纵向间距 = 行高）
  const PORT_R = 6;
  // 端口圆点垂直居中于第 i 行：中心 = HEAD_H + i*PORT_GAP + PORT_GAP/2
  const PORT_TOP = HEAD_H + PORT_GAP / 2 - PORT_R;

  const PORT_COLOR = { files: '#4d9cf6', rules: '#f2b544', skill: '#a06bf0', save: '#37c46f', model: '#e8577a' };
  const PORT_LABEL = { files: '文件', rules: '规则', skill: '技能', save: '保存位置', model: '模型' };

  /* ---------------- 节点定义 ---------------- */
  const DEFS = {
    source:     { title: '来源',        group: 'input', color: '#3f7fd8', ins: [], outs: ['files'] },
    rules:      { title: '规则',        group: 'input', color: '#c9912f', ins: [], outs: ['rules'] },
    skill:      { title: '技能选择',    group: 'input', color: '#7a4fc0', ins: [], outs: ['skill'] },
    output:     { title: '保存位置',    group: 'input', color: '#2a9c5c', ins: [], outs: ['save'] },
    aimodel:    { title: 'AI 模型选择', group: 'input', color: '#c2435f', ins: [], outs: ['model'] },

    replace:    { title: '替换文件',    group: 'task', color: '#2f6fed', ins: ['files', 'rules', 'skill', 'save'], outs: ['files'] },
    rename:     { title: '文件名修改',  group: 'task', color: '#2f6fed', ins: ['files', 'rules', 'save'], outs: ['files'] },
    convert:    { title: '格式转换',    group: 'task', color: '#2f6fed', ins: ['files', 'save'], outs: ['files'] },
    pdfwm:      { title: 'PDF去水印',   group: 'task', color: '#2f6fed', ins: ['files', 'model', 'save'], outs: ['files'] },
    automation: { title: '文件自动化',  group: 'task', color: '#2f6fed', ins: ['files', 'skill', 'save'], outs: ['files'] },
    ppt:        { title: 'PPT 编写',    group: 'task', color: '#2f6fed', ins: ['files', 'model', 'save'], outs: ['files'] },
    // 模块自定义：自己写提示词，可接文件 / 规则 / 技能 / 保存位置
    custom:     { title: '模块自定义',  group: 'task', color: '#2f6fed', ins: ['files', 'rules', 'skill', 'save'], outs: ['files'] },
  };
  const INPUT_ORDER = ['source', 'rules', 'skill', 'output', 'aimodel'];
  const TASK_ORDER = ['replace', 'rename', 'convert', 'pdfwm', 'automation', 'ppt', 'custom'];

  const TASK_TIP = {
    replace: '按「规则」批量替换文件内容',
    rename: '按「规则」批量重命名文件',
  };

  const SRC_FORMATS = [
    { v: 'auto', t: '按文件自动识别' }, { v: 'pdf', t: 'PDF（.pdf）' },
    { v: 'docx', t: 'Word（.docx）' }, { v: 'doc', t: 'Word 97（.doc）' },
    { v: 'rtf', t: '富文本（.rtf）' }, { v: 'odt', t: 'OpenDocument（.odt）' },
    { v: 'html', t: '网页（.html）' }, { v: 'txt', t: '纯文本（.txt）' },
    { v: 'md', t: 'Markdown（.md）' }, { v: 'json', t: 'JSON（.json）' }, { v: 'csv', t: 'CSV（.csv）' },
  ];
  const DST_FORMATS = SRC_FORMATS.filter((f) => f.v !== 'auto');

  /* ---------------- 状态 ---------------- */
  let nodes = [];
  let edges = [];
  let seq = 1;
  let view = { x: 40, y: 30, k: 1 };
  let selection = null;      // { kind: 'node' | 'edge', id }
  let running = false;
  let stopFlag = false;
  let skillCache = null;
  let modelCache = null;

  const canvasEl = document.getElementById('canvas');
  const worldEl = document.getElementById('world');
  const svgEl = document.getElementById('edges');
  const nodesEl = document.getElementById('nodes');
  const statusEl = document.getElementById('status-text');
  const barEl = document.getElementById('progress-bar');
  const zoomEl = document.getElementById('zoom-info');
  const nameEl = document.getElementById('proj-name');
  const stateEl = document.getElementById('proj-state');
  const runBtn = document.getElementById('btn-run');
  const stopBtn = document.getElementById('btn-stop');
  const addMenu = document.getElementById('add-menu');
  const openMenu = document.getElementById('open-menu');

  /* ---------------- 小工具 ---------------- */
  function uid(p) { return (p || 'n') + (seq++) + '_' + Math.random().toString(36).slice(2, 6); }
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function field(label, control) {
    const w = el('div', 'nf');
    w.appendChild(el('div', 'nf-label', label));
    w.appendChild(control);
    return w;
  }
  function dirOf(p) { const s = String(p || ''); const i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i) : s; }
  function stamp() {
    const d = new Date();
    const p2 = (v) => String(v).padStart(2, '0');
    return '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }
  function nodeById(id) { return nodes.find((n) => n.id === id) || null; }
  function setStatus(t) { statusEl.textContent = t || ''; }
  function setProgress(pct) {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    barEl.style.width = v + '%';
  }
  function markDirty() {
    stateEl.textContent = '未保存';
    stateEl.className = 'proj-state';
  }
  function markSaved() {
    stateEl.textContent = '已保存';
    stateEl.className = 'proj-state saved';
  }
  function applyView() {
    worldEl.style.transform = 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.k + ')';
    zoomEl.textContent = Math.round(view.k * 100) + '%';
  }

  /* ---------------- 默认数据 ---------------- */
  function defaultData(type) {
    switch (type) {
      case 'source': return { files: [], folder: '' };
      case 'rules': return { rules: [{ name: '规则1', find: '', replace: '' }] };
      case 'skill': return { skill: '' };
      case 'output': return { mode: 'overwrite', dir: '', keep: true };
      case 'aimodel': return { profileId: '', model: '', label: '' };
      case 'convert': return { src: 'auto', dst: 'txt' };
      case 'pdfwm': return { marks: '', auto: true };
      case 'automation': return { layout: 'default', template: '' };
      case 'ppt': return { prompt: '' };
      case 'custom': return { prompt: '' };
      default: return {};
    }
  }

  /* ---------------- 节点渲染 ---------------- */
  function makePort(nodeId, kind, dir, idx) {
    const p = el('div', 'port ' + dir);
    p.dataset.node = nodeId;
    p.dataset.port = kind;
    p.dataset.dir = dir;
    p.style.top = (PORT_TOP + idx * PORT_GAP) + 'px';
    p.style.background = PORT_COLOR[kind] || '#888';
    p.title = '从这里拉线：' + (PORT_LABEL[kind] || kind) + (dir === 'in' ? '（输入）' : '（输出）');
    return p;
  }

  // 端口行：输入名靠左、输出名靠右，两边摆放在节点框内，行数决定节点高度
  function makePortRow(kind, dir) {
    const s = el('span', 'pl ' + dir);
    const dot = el('i', 'pd');
    dot.style.background = PORT_COLOR[kind] || '#888';
    const txt = el('span', 'pt', PORT_LABEL[kind] || kind);
    if (dir === 'in') { s.appendChild(dot); s.appendChild(txt); }
    else { s.appendChild(txt); s.appendChild(dot); }
    return s;
  }

  function buildPortRows(e, def) {
    const rows = Math.max((def.ins || []).length, (def.outs || []).length);
    if (!rows) return;
    const wrap = el('div', 'node-ports');
    for (let i = 0; i < rows; i++) {
      const row = el('div', 'prow');
      if (def.ins[i]) row.appendChild(makePortRow(def.ins[i], 'in'));
      else row.appendChild(el('span', 'pl in'));
      if (def.outs[i]) row.appendChild(makePortRow(def.outs[i], 'out'));
      else row.appendChild(el('span', 'pl out'));
      wrap.appendChild(row);
    }
    e.appendChild(wrap);
  }

  function buildBody(box, n) {
    const d = n.data;

    if (n.type === 'source') {
      const row = el('div', 'btn-row');
      const b1 = el('button', 'mini primary', '选择文件');
      const b2 = el('button', 'mini primary', '选择文件夹');
      const b3 = el('button', 'mini ghost', '清空');
      b1.addEventListener('click', async () => {
        const fs = await api.wfSelectFiles();
        if (fs && fs.length) { d.files = fs; d.folder = ''; markDirty(); render(); }
      });
      b2.addEventListener('click', async () => {
        const f = await api.wfSelectFolder();
        if (f) {
          const list = await api.scanFolder(f, []);
          d.files = (list && list.length) ? list : [];
          d.folder = f;
          markDirty(); render();
        }
      });
      b3.addEventListener('click', () => { d.files = []; d.folder = ''; markDirty(); render(); });
      row.appendChild(b1); row.appendChild(b2); row.appendChild(b3);
      box.appendChild(row);
      box.appendChild(el('div', 'nf-label', d.folder ? '文件夹：' + d.folder : '文件 ' + d.files.length + ' 个'));
      const box2 = el('div', 'file-box');
      if (!d.files.length) box2.appendChild(el('div', 'file-empty', '尚未选择文件'));
      else d.files.slice(0, 40).forEach((f) => box2.appendChild(el('div', 'fi', String(f).split('/').pop())));
      box.appendChild(box2);
      return;
    }

    if (n.type === 'rules') {
      const top = el('div', 'btn-row');
      const cnt = el('span', 'nf-label', '共 ' + d.rules.length + ' 条');
      const add = el('button', 'mini primary', '＋ 添加规则');
      add.addEventListener('click', () => {
        d.rules.push({ name: '规则' + (d.rules.length + 1), find: '', replace: '' });
        markDirty(); render();
      });
      top.appendChild(cnt); top.appendChild(add);
      box.appendChild(top);
      if (!d.rules.length) box.appendChild(el('div', 'rule-empty', '暂无规则'));
      d.rules.forEach((r, i) => {
        const item = el('div', 'rule-item');
        const x = el('div', 'ri-x', '×');
        x.title = '删除该规则';
        x.addEventListener('click', () => { d.rules.splice(i, 1); markDirty(); render(); });
        item.appendChild(x);
        const fi = el('input'); fi.type = 'text'; fi.value = r.find || ''; fi.placeholder = '查找内容';
        fi.addEventListener('input', () => { r.find = fi.value; markDirty(); });
        const rp = el('input'); rp.type = 'text'; rp.value = r.replace || ''; rp.placeholder = '替换为';
        rp.addEventListener('input', () => { r.replace = rp.value; markDirty(); });
        item.appendChild(fi); item.appendChild(rp);
        box.appendChild(item);
      });
      return;
    }

    if (n.type === 'skill') {
      const sel = el('select');
      const none = el('option'); none.value = ''; none.textContent = '不启用技能'; sel.appendChild(none);
      if (skillCache) {
        const all = (skillCache.builtin || []).concat(skillCache.installed || []);
        const seen = new Set();
        all.forEach((s) => {
          if (!s || !s.name || seen.has(s.name)) return;
          seen.add(s.name);
          const o = el('option'); o.value = s.name; o.textContent = s.name; sel.appendChild(o);
        });
      }
      sel.value = d.skill || '';
      sel.addEventListener('change', () => { d.skill = sel.value; markDirty(); });
      box.appendChild(field('技能选择（可选）', sel));
      const tip = el('div', 'nf-label', '用于 AI 型任务（PPT 编写等）时附加到提示词');
      box.appendChild(tip);
      return;
    }

    if (n.type === 'output') {
      const mk = (v, t) => {
        const lab = el('label', 'radio');
        const r = el('input'); r.type = 'radio'; r.name = 'sv-' + n.id; r.value = v; r.checked = d.mode === v;
        r.addEventListener('change', () => { d.mode = v; markDirty(); render(); });
        lab.appendChild(r); lab.appendChild(el('span', null, t));
        return lab;
      };
      box.appendChild(mk('overwrite', '覆盖原文件'));
      box.appendChild(mk('backup', '备份后覆盖'));
      box.appendChild(mk('output', '输出到新目录'));
      if (d.mode === 'output') {
        const row = el('div', 'nf-row');
        const inp = el('input'); inp.type = 'text'; inp.readOnly = true; inp.value = d.dir || '';
        inp.placeholder = '选择输出文件夹';
        const b = el('button', 'mini', '浏览');
        b.addEventListener('click', async () => {
          const f = await api.wfSelectOutputDir();
          if (f) { d.dir = f; markDirty(); render(); }
        });
        row.appendChild(inp); row.appendChild(b);
        box.appendChild(field('保存到', row));
        const chk = el('label', 'chk');
        const c = el('input'); c.type = 'checkbox'; c.checked = d.keep !== false;
        c.addEventListener('change', () => { d.keep = c.checked; markDirty(); });
        chk.appendChild(c); chk.appendChild(el('span', null, '保持目录结构'));
        box.appendChild(chk);
      }
      return;
    }

    if (n.type === 'aimodel') {
      const sel = el('select');
      const none = el('option'); none.value = ''; none.textContent = '跟随全局默认配置'; sel.appendChild(none);
      (modelCache || []).forEach((m) => {
        const o = el('option'); o.value = m.profileId + '||' + m.model; o.textContent = m.label; sel.appendChild(o);
      });
      const cur = d.profileId ? (d.profileId + '||' + (d.model || '')) : '';
      sel.value = cur;
      sel.addEventListener('change', () => {
        const v = sel.value;
        if (!v) { d.profileId = ''; d.model = ''; d.label = ''; }
        else {
          const parts = v.split('||');
          d.profileId = parts[0]; d.model = parts[1] || '';
          const hit = (modelCache || []).find((m) => m.profileId === d.profileId && m.model === d.model);
          d.label = hit ? hit.label : v;
        }
        markDirty();
      });
      box.appendChild(field('AI 模型', sel));
      box.appendChild(el('div', 'nf-label', d.label ? '已选：' + d.label : '未指定时用「AI 设置」里的启用配置'));
      return;
    }

    if (n.type === 'convert') {
      const s1 = el('select');
      SRC_FORMATS.forEach((f) => { const o = el('option'); o.value = f.v; o.textContent = f.t; s1.appendChild(o); });
      s1.value = d.src || 'auto';
      s1.addEventListener('change', () => { d.src = s1.value; markDirty(); });
      const s2 = el('select');
      DST_FORMATS.forEach((f) => { const o = el('option'); o.value = f.v; o.textContent = f.t; s2.appendChild(o); });
      s2.value = d.dst || 'txt';
      s2.addEventListener('change', () => { d.dst = s2.value; markDirty(); });
      box.appendChild(field('源格式', s1));
      box.appendChild(field('转成为', s2));
      return;
    }

    if (n.type === 'pdfwm') {
      const ta = el('textarea');
      ta.value = d.marks || '';
      ta.placeholder = '每行一条水印文字';
      ta.addEventListener('input', () => { d.marks = ta.value; markDirty(); });
      box.appendChild(field('水印文字（每行一条）', ta));
      const chk = el('label', 'chk');
      const c = el('input'); c.type = 'checkbox'; c.checked = d.auto !== false;
      c.addEventListener('change', () => { d.auto = c.checked; markDirty(); });
      chk.appendChild(c); chk.appendChild(el('span', null, '留空时自动识别候选水印'));
      box.appendChild(chk);
      return;
    }

    if (n.type === 'automation') {
      const sel = el('select');
      [{ v: 'default', t: '默认（按文件清单整理）' }, { v: 'template', t: '按模版目录' }].forEach((o0) => {
        const o = el('option'); o.value = o0.v; o.textContent = o0.t; sel.appendChild(o);
      });
      sel.value = d.layout || 'default';
      sel.addEventListener('change', () => { d.layout = sel.value; markDirty(); render(); });
      box.appendChild(field('整理方式', sel));
      if (d.layout === 'template') {
        const row = el('div', 'nf-row');
        const inp = el('input'); inp.type = 'text'; inp.readOnly = true; inp.value = d.template || '';
        inp.placeholder = '选择模版文件夹';
        const b = el('button', 'mini', '浏览');
        b.addEventListener('click', async () => {
          const f = await api.wfSelectFolder();
          if (f) { d.template = f; markDirty(); render(); }
        });
        row.appendChild(inp); row.appendChild(b);
        box.appendChild(field('模版文件夹', row));
      }
      return;
    }

    if (n.type === 'ppt') {
      const ta = el('textarea');
      ta.value = d.prompt || '';
      ta.placeholder = '例如：把这份 PPT 的标题页改成…';
      ta.addEventListener('input', () => { d.prompt = ta.value; markDirty(); });
      box.appendChild(field('给 AI 的指令（可选）', ta));
      return;
    }

    if (n.type === 'custom') {
      const ta = el('textarea');
      ta.value = d.prompt || '';
      ta.placeholder = '写清楚要让 AI 做什么，例如：通读这些文档，输出一份要点清单…';
      ta.style.minHeight = '78px';
      ta.addEventListener('input', () => { d.prompt = ta.value; markDirty(); });
      box.appendChild(field('信息内容（提示词）', ta));
      const tip = el('div', 'nf-label', '文件 / 规则 / 技能 / 保存位置 由左侧连线提供，结果存为 .md 文件');
      box.appendChild(tip);
      return;
    }

    // 纯任务节点：无额外参数
    box.appendChild(el('div', 'nf-label', TASK_TIP[n.type] || '参数由左侧连线提供'));
  }

  function buildNode(n) {
    const def = DEFS[n.type];
    const e = el('div', 'node' + (def.group === 'task' ? ' task' : ''));
    e.dataset.id = n.id;
    e.style.left = n.x + 'px';
    e.style.top = n.y + 'px';
    e.style.setProperty('--nc', def.color);

    const head = el('div', 'node-head');
    const title = el('span', 'node-title', def.title);
    const x = el('span', 'node-x', '×');
    x.title = '删除节点';
    x.addEventListener('mousedown', (ev) => ev.stopPropagation());
    x.addEventListener('click', (ev) => { ev.stopPropagation(); removeNode(n.id); });
    head.appendChild(title); head.appendChild(x);
    e.appendChild(head);

    buildPortRows(e, def);

    const body = el('div', 'node-body');
    buildBody(body, n);
    e.appendChild(body);

    (def.ins || []).forEach((p, i) => e.appendChild(makePort(n.id, p, 'in', i)));
    (def.outs || []).forEach((p, i) => e.appendChild(makePort(n.id, p, 'out', i)));

    const st = el('div', 'node-status');
    st.dataset.role = 'status';
    e.appendChild(st);
    return e;
  }

  function render() {
    nodesEl.innerHTML = '';
    nodes.forEach((n) => nodesEl.appendChild(buildNode(n)));
    renderEdges();
    applySelection();
  }

  function portPos(nodeId, kind, dir) {
    const n = nodeById(nodeId);
    if (!n) return { x: 0, y: 0 };
    const def = DEFS[n.type];
    const list = dir === 'in' ? def.ins : def.outs;
    const i = list.indexOf(kind);
    const y = n.y + PORT_TOP + (i < 0 ? 0 : i) * PORT_GAP + PORT_R;
    const x = dir === 'in' ? n.x : n.x + NODE_W;
    return { x, y };
  }

  function pathOf(a, b) {
    const dx = Math.max(48, Math.abs(b.x - a.x) * 0.5);
    return 'M ' + a.x + ' ' + a.y + ' C ' + (a.x + dx) + ' ' + a.y + ', ' + (b.x - dx) + ' ' + b.y + ', ' + b.x + ' ' + b.y;
  }

  function renderEdges() {
    svgEl.innerHTML = '';
    edges.forEach((e) => {
      const src = nodeById(e.from.node);
      if (!src) return;
      const a = portPos(e.from.node, e.from.port, 'out');
      const b = portPos(e.to.node, e.to.port, 'in');
      const d = pathOf(a, b);
      const color = PORT_COLOR[e.from.port] || '#7aa2f7';
      const hit = document.createElementNS(SVGNS, 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'edge-hit');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '14');
      hit.setAttribute('fill', 'none');
      hit.dataset.id = e.id;
      const vis = document.createElementNS(SVGNS, 'path');
      vis.setAttribute('d', d);
      vis.setAttribute('stroke', color);
      vis.setAttribute('stroke-width', selection && selection.kind === 'edge' && selection.id === e.id ? '3.4' : '2.2');
      vis.setAttribute('fill', 'none');
      vis.setAttribute('stroke-linecap', 'round');
      vis.setAttribute('pointer-events', 'none');
      svgEl.appendChild(vis);
      svgEl.appendChild(hit);
    });
  }

  /* ---------------- 选择 / 增删 ---------------- */
  function applySelection() {
    Array.prototype.forEach.call(nodesEl.children, (c) => {
      c.classList.toggle('sel', !!selection && selection.kind === 'node' && selection.id === c.dataset.id);
    });
  }
  function setSelection(sel) { selection = sel; applySelection(); renderEdges(); }

  function addNode(type, x, y) {
    if (!DEFS[type]) return null;
    const n = { id: uid(type), type: type, x: Math.round(x), y: Math.round(y), data: defaultData(type) };
    nodes.push(n);
    markDirty();
    render();
    return n;
  }

  function removeNode(id) {
    nodes = nodes.filter((n) => n.id !== id);
    edges = edges.filter((e) => e.from.node !== id && e.to.node !== id);
    if (selection && selection.id === id) selection = null;
    markDirty();
    render();
  }

  function removeEdge(id) {
    edges = edges.filter((e) => e.id !== id);
    if (selection && selection.id === id) selection = null;
    markDirty();
    renderEdges();
  }

  function canConnect(fromNodeId, fromPort, fromDir, toNodeId, toPort, toDir) {
    if (fromNodeId === toNodeId) return false;
    if (fromDir === toDir) return false;
    const a = fromDir === 'out' ? { n: fromNodeId, p: fromPort } : { n: toNodeId, p: toPort };
    const b = fromDir === 'out' ? { n: toNodeId, p: toPort } : { n: fromNodeId, p: fromPort };
    if (a.p !== b.p) return false;                       // 端口类型必须一致（文件↔文件）
    if (edges.some((e) => e.from.node === a.n && e.from.port === a.p && e.to.node === b.n && e.to.port === b.p)) return false;
    return true;
  }

  /* ---------------- 交互：平移 / 缩放 / 拖拽 / 连线 ---------------- */
  let pan = null;
  let drag = null;
  let link = null;
  let tempPath = null;

  canvasEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.node') || e.target.closest('.edge-hit')) return;
    pan = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    canvasEl.classList.add('panning');
    setSelection(null);
  });

  window.addEventListener('mousemove', (e) => {
    if (pan) {
      view.x = pan.ox + (e.clientX - pan.sx);
      view.y = pan.oy + (e.clientY - pan.sy);
      applyView();
      return;
    }
    if (drag) {
      const rect = canvasEl.getBoundingClientRect();
      const wx = (e.clientX - rect.left - view.x) / view.k;
      const wy = (e.clientY - rect.top - view.y) / view.k;
      drag.node.x = Math.round(wx - drag.dx);
      drag.node.y = Math.round(wy - drag.dy);
      drag.el.style.left = drag.node.x + 'px';
      drag.el.style.top = drag.node.y + 'px';
      renderEdges();
      return;
    }
    if (link) {
      const rect = canvasEl.getBoundingClientRect();
      const wx = (e.clientX - rect.left - view.x) / view.k;
      const wy = (e.clientY - rect.top - view.y) / view.k;
      const a = link.anchor;
      const d = link.dir === 'out'
        ? pathOf(a, { x: wx, y: wy })
        : pathOf({ x: wx, y: wy }, a);
      if (!tempPath) {
        tempPath = document.createElementNS(SVGNS, 'path');
        tempPath.setAttribute('fill', 'none');
        tempPath.setAttribute('stroke', '#ffffff');
        tempPath.setAttribute('stroke-width', '2');
        tempPath.setAttribute('stroke-dasharray', '5 4');
        tempPath.setAttribute('pointer-events', 'none');
        svgEl.appendChild(tempPath);
      }
      tempPath.setAttribute('d', d);
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (pan) { pan = null; canvasEl.classList.remove('panning'); }
    if (drag) { drag = null; markDirty(); }
    if (link) {
      if (tempPath) { svgEl.removeChild(tempPath); tempPath = null; }
      const t = e.target && e.target.closest ? e.target.closest('.port') : null;
      if (t) {
        const ok = canConnect(link.nodeId, link.port, link.dir, t.dataset.node, t.dataset.port, t.dataset.dir);
        if (ok) {
          const from = link.dir === 'out' ? { node: link.nodeId, port: link.port } : { node: t.dataset.node, port: t.dataset.port };
          const to = link.dir === 'out' ? { node: t.dataset.node, port: t.dataset.port } : { node: link.nodeId, port: link.port };
          edges.push({ id: uid('e'), from: from, to: to });
          markDirty();
        } else {
          setStatus('这条连线不成立：端口类型需一致，且输出要连到输入');
        }
      }
      link = null;
      renderEdges();
    }
  });

  // 端口按下：开始拉线；已连接的输入端口按下 = 断开并重新拉
  nodesEl.addEventListener('mousedown', (e) => {
    const p = e.target.closest ? e.target.closest('.port') : null;
    if (p) {
      e.preventDefault();
      e.stopPropagation();
      const nodeId = p.dataset.node;
      const port = p.dataset.port;
      const dir = p.dataset.dir;
      if (dir === 'in') {
        const hitIdx = edges.findIndex((ed) => ed.to.node === nodeId && ed.to.port === port);
        if (hitIdx >= 0) {
          const ed = edges[hitIdx];
          edges.splice(hitIdx, 1);
          const from = { node: ed.from.node, port: ed.from.port, dir: 'out' };
          link = { nodeId: from.node, port: from.port, dir: 'out', anchor: portPos(from.node, from.port, 'out') };
          markDirty();
          renderEdges();
          return;
        }
      }
      link = { nodeId: nodeId, port: port, dir: dir, anchor: portPos(nodeId, port, dir) };
      return;
    }
    const head = e.target.closest ? e.target.closest('.node-head') : null;
    if (head) {
      const nodeEl2 = head.parentElement;
      const n = nodeById(nodeEl2.dataset.id);
      if (!n) return;
      e.preventDefault();
      const rect = canvasEl.getBoundingClientRect();
      const wx = (e.clientX - rect.left - view.x) / view.k;
      const wy = (e.clientY - rect.top - view.y) / view.k;
      drag = { node: n, el: nodeEl2, dx: wx - n.x, dy: wy - n.y };
      setSelection({ kind: 'node', id: n.id });
    }
  });

  // 点击连线：选中（再按 Delete 删除）
  svgEl.addEventListener('click', (e) => {
    const hit = e.target && e.target.classList && e.target.classList.contains('edge-hit') ? e.target : null;
    if (!hit) return;
    setSelection({ kind: 'edge', id: hit.dataset.id });
    setStatus('已选中连线，按 Delete 删除');
  });

  canvasEl.addEventListener('wheel', (e) => {
    if (e.target.closest('textarea') || e.target.closest('.file-box') || e.target.closest('select')) return;
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const k0 = view.k;
    const k = Math.min(2, Math.max(0.35, k0 * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    if (k === k0) return;
    view.x = mx - (mx - view.x) * (k / k0);
    view.y = my - (my - view.y) * (k / k0);
    view.k = k;
    applyView();
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (!selection) return;
      if (selection.kind === 'node') removeNode(selection.id);
      else removeEdge(selection.id);
      e.preventDefault();
    }
  });

  /* ---------------- 新建菜单 ---------------- */
  function showAddMenu() {
    addMenu.innerHTML = '';
    const mkGroup = (t) => addMenu.appendChild(el('div', 'pop-group', t));
    const mkItem = (type) => {
      const it = el('div', 'pop-item');
      const sw = el('span', 'sw');
      sw.style.background = DEFS[type].color;
      it.appendChild(sw);
      it.appendChild(el('span', null, DEFS[type].title));
      it.appendChild(el('span', 'meta', DEFS[type].group === 'task' ? '任务' : '参数'));
      it.addEventListener('click', () => {
        addMenu.classList.add('hidden');
        const rect = canvasEl.getBoundingClientRect();
        const wx = (rect.width / 2 - view.x) / view.k - NODE_W / 2 + (Math.random() * 60 - 30);
        const wy = (rect.height / 2 - view.y) / view.k - 90 + (Math.random() * 60 - 30);
        const n = addNode(type, wx, wy);
        if (n) setStatus('已添加节点：' + DEFS[type].title);
      });
      return it;
    };
    mkGroup('参数节点');
    INPUT_ORDER.forEach((t) => addMenu.appendChild(mkItem(t)));
    mkGroup('任务节点');
    TASK_ORDER.forEach((t) => addMenu.appendChild(mkItem(t)));
    const r = document.getElementById('btn-add').getBoundingClientRect();
    addMenu.style.left = (r.right + 8) + 'px';
    addMenu.style.top = r.top + 'px';
    addMenu.classList.remove('hidden');
  }

  document.addEventListener('mousedown', (e) => {
    const tg = e.target;
    if (!tg || typeof tg.closest !== 'function') return;
    if (!addMenu.classList.contains('hidden') && !addMenu.contains(tg) && tg.closest('#btn-add') === null) {
      addMenu.classList.add('hidden');
    }
    if (!openMenu.classList.contains('hidden') && !openMenu.contains(tg) && tg.closest('#btn-open') === null) {
      openMenu.classList.add('hidden');
    }
  });

  /* ---------------- 项目：保存 / 打开 / 另存为 / 打开文件 ---------------- */
  function serialize() {
    return {
      version: 1,
      name: (nameEl.value || '').trim() || '未命名工作流',
      view: { x: view.x, y: view.y, k: view.k },
      nodes: nodes.map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, data: n.data })),
      edges: edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
    };
  }

  function deserialize(obj) {
    if (!obj || typeof obj !== 'object') { setStatus('项目文件内容无法识别'); return; }
    nodes = (Array.isArray(obj.nodes) ? obj.nodes : []).filter((n) => n && DEFS[n.type]).map((n) => ({
      id: n.id || uid(n.type),
      type: n.type,
      x: Number(n.x) || 40,
      y: Number(n.y) || 40,
      data: Object.assign(defaultData(n.type), n.data || {}),
    }));
    edges = (Array.isArray(obj.edges) ? obj.edges : []).filter((e) => e && e.from && e.to)
      .map((e) => ({ id: e.id || uid('e'), from: { node: e.from.node, port: e.from.port }, to: { node: e.to.node, port: e.to.port } }));
    if (obj.view && typeof obj.view.k === 'number') view = { x: obj.view.x || 40, y: obj.view.y || 30, k: obj.view.k };
    nameEl.value = obj.name || '';
    selection = null;
    render();
    markSaved();
  }

  async function saveProject() {
    const name = (nameEl.value || '').trim();
    if (!name) { setStatus('请先给项目起一个名字，再点「保存」'); nameEl.focus(); return; }
    const list = (await api.workflowFlowsGet()) || [];
    const item = { name: name, updatedAt: Date.now(), data: serialize() };
    const i = list.findIndex((p) => p.name === name);
    if (i >= 0) list[i] = item; else list.push(item);
    const r = await api.workflowFlowsSave(list);
    if (r && r.ok) { markSaved(); setStatus('项目「' + name + '」已保存到本机项目列表'); }
    else setStatus('保存失败：' + ((r && r.error) || '未知错误'));
  }

  async function showOpenMenu() {
    const list = (await api.workflowFlowsGet()) || [];
    openMenu.innerHTML = '';
    if (!list.length) {
      openMenu.appendChild(el('div', 'pop-empty', '还没有保存过的项目'));
    } else {
      list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach((p) => {
        const it = el('div', 'pop-item');
        it.appendChild(el('span', null, p.name));
        const dt = p.updatedAt ? new Date(p.updatedAt).toLocaleString('zh-CN') : '';
        it.appendChild(el('span', 'meta', dt));
        it.addEventListener('click', () => {
          openMenu.classList.add('hidden');
          deserialize(p.data || p);
          setStatus('已打开项目：' + p.name);
        });
        openMenu.appendChild(it);
      });
    }
    const r = document.getElementById('btn-open').getBoundingClientRect();
    openMenu.style.left = (r.right + 8) + 'px';
    openMenu.style.top = r.top + 'px';
    openMenu.classList.remove('hidden');
  }

  async function saveAsFile() {
    const name = (nameEl.value || '').trim() || 'workflow';
    const r = await api.wfSaveProjectFile({
      defaultPath: name + '.aiflow',
      content: JSON.stringify(serialize(), null, 2),
    });
    if (r && r.ok) { markSaved(); setStatus('已另存为：' + r.filePath); }
    else if (r && !r.canceled) setStatus('另存失败：' + (r.error || '未知错误'));
  }

  async function openFromFile() {
    const r = await api.wfOpenProjectFile();
    if (!r || !r.ok) { if (r && !r.canceled) setStatus('打开失败：' + (r.error || '未知错误')); return; }
    try { deserialize(JSON.parse(r.content)); setStatus('已打开文件：' + r.filePath); }
    catch (e) { setStatus('项目文件解析失败：' + e.message); }
  }

  /* ---------------- 适应画布 / 清空 ---------------- */
  function fitView() {
    if (!nodes.length) { view = { x: 40, y: 30, k: 1 }; applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    nodes.forEach((n) => {
      const e = nodesEl.querySelector('.node[data-id="' + n.id + '"]');
      const h = e ? (e.offsetHeight || 200) + 24 : 200;
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + NODE_W); y1 = Math.max(y1, n.y + h);
    });
    const rect = canvasEl.getBoundingClientRect();
    const pad = 60;
    const k = Math.min(1.2, Math.max(0.35, Math.min((rect.width - pad * 2) / (x1 - x0), (rect.height - pad * 2) / (y1 - y0))));
    view.k = k;
    view.x = pad - x0 * k + Math.max(0, (rect.width - pad * 2 - (x1 - x0) * k) / 2);
    view.y = pad - y0 * k + Math.max(0, (rect.height - pad * 2 - (y1 - y0) * k) / 2);
    applyView();
  }

  function clearAll() {
    if (!nodes.length) return;
    nodes = []; edges = []; selection = null;
    markDirty(); render();
    setStatus('画布已清空');
  }

  /* ---------------- 执行引擎 ---------------- */
  function setNodeStatus(id, kind, text) {
    const e = nodesEl.querySelector('.node[data-id="' + id + '"] .node-status');
    if (!e) return;
    e.className = 'node-status ' + (kind || '');
    e.textContent = text || '';
  }

  function collectInputs(n, rt) {
    const res = { files: [], rules: [], skill: null, save: null, model: null, baseDir: '' };
    edges.forEach((e) => {
      if (e.to.node !== n.id) return;
      const src = nodeById(e.from.node);
      if (!src) return;
      const kind = e.to.port;
      if (kind === 'files') {
        if (DEFS[src.type].group === 'task') {
          const o = rt.get(src.id);
          if (o) { res.files = res.files.concat(o.files || []); if (!res.baseDir) res.baseDir = o.baseDir || ''; }
        } else {
          res.files = res.files.concat(src.data.files || []);
          if (!res.baseDir && src.data.folder) res.baseDir = src.data.folder;
        }
      } else if (kind === 'rules') {
        res.rules = res.rules.concat((src.data.rules || []).filter((r) => r && r.find));
      } else if (kind === 'skill') {
        res.skill = src.data.skill || null;
      } else if (kind === 'save') {
        res.save = { mode: src.data.mode || 'overwrite', dir: src.data.dir || '', keep: src.data.keep !== false };
      } else if (kind === 'model') {
        res.model = { profileId: src.data.profileId || '', model: src.data.model || '', label: src.data.label || '' };
      }
    });
    // 兜底：未连「文件」但画布上只有一个有文件的来源节点时直接用它
    if (!res.files.length) {
      const srcs = nodes.filter((x) => x.type === 'source' && (x.data.files || []).length);
      if (srcs.length === 1) {
        res.files = (srcs[0].data.files || []).slice();
        if (srcs[0].data.folder) res.baseDir = srcs[0].data.folder;
      }
    }
    return res;
  }

  function topoOrder(tasks) {
    const ids = new Set(tasks.map((t) => t.id));
    const indeg = new Map();
    const adj = new Map();
    tasks.forEach((t) => { indeg.set(t.id, 0); adj.set(t.id, []); });
    edges.forEach((e) => {
      if (!ids.has(e.from.node) || !ids.has(e.to.node)) return;
      adj.get(e.from.node).push(e.to.node);
      indeg.set(e.to.node, (indeg.get(e.to.node) || 0) + 1);
    });
    const q = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
    const out = [];
    while (q.length) {
      const id = q.shift();
      out.push(nodeById(id));
      (adj.get(id) || []).forEach((nx) => {
        indeg.set(nx, (indeg.get(nx) || 0) - 1);
        if (indeg.get(nx) === 0) q.push(nx);
      });
    }
    return out.length === tasks.length ? out : null;
  }

  async function execTask(n, rt) {
    const inp = collectInputs(n, rt);
    const save = inp.save || { mode: 'overwrite', dir: '', keep: false };
    const toDir = save.mode === 'output' && !!save.dir;
    const saveMode = toDir ? 'output' : save.mode;
    const outputDir = toDir ? save.dir : '';
    const baseDir = inp.baseDir || '';
    const keep = !!save.keep;

    function finish(r) {
      const results = (r && r.results) || [];
      const outs = results.filter((x) => x.status === 'done' && x.outputPath).map((x) => x.outputPath);
      const s = (r && r.summary) || {};
      return {
        files: outs.length ? outs : inp.files.slice(),
        baseDir: toDir ? outputDir : baseDir,
        note: '完成 ' + (s.done || 0) + '/' + (s.total || inp.files.length),
      };
    }

    if (!inp.files.length) {
      throw new Error('没有可处理的文件：请把「来源」节点的「文件」端口连到本节点');
    }

    if (n.type === 'replace') {
      if (!inp.rules.length) throw new Error('未连接「规则」节点，或规则里「查找内容」为空');
      return finish(await api.runReplace(inp.files, inp.rules, saveMode, outputDir, baseDir, keep));
    }
    if (n.type === 'rename') {
      if (!inp.rules.length) throw new Error('未连接「规则」节点，或规则里「查找内容」为空');
      return finish(await api.renameFiles(inp.files, inp.rules, toDir ? 'copy' : 'overwrite', outputDir));
    }
    if (n.type === 'convert') {
      return finish(await api.convertFiles(inp.files, n.data.src || 'auto', n.data.dst, toDir ? 'output' : 'overwrite', outputDir, baseDir, keep));
    }
    if (n.type === 'pdfwm') {
      let marks = String(n.data.marks || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!marks.length && n.data.auto !== false) {
        const an = await api.pdfAnalyzeWatermark(inp.files);
        marks = ((an && an.candidates) || []).slice(0, 5).map((c) => c.text);
      }
      if (!marks.length) throw new Error('没拿到水印文字：请手填，或勾选自动识别');
      const dir = outputDir || (dirOf(inp.files[0]) + '/去水印输出');
      return finish(await api.pdfRemoveWatermark(inp.files, marks, dir));
    }
    if (n.type === 'automation') {
      const dir = outputDir || (dirOf(inp.files[0]) + '/自动化输出');
      const kind = n.data.layout === 'template' ? 'folder' : null;
      return finish(await api.automationConvert(kind, n.data.template || null, inp.files, dir, n.data.layout || 'default'));
    }
    if (n.type === 'ppt') {
      let prompt = String(n.data.prompt || '').trim();
      if (prompt && inp.skill) prompt = '【技能：' + inp.skill + '】\n' + prompt;
      if (prompt) {
        setStatus('PPT 节点：AI 处理中…');
        const r = await api.wfAiRun({
          profileId: inp.model ? inp.model.profileId : '',
          model: inp.model ? inp.model.model : '',
          prompt: prompt,
          files: inp.files.slice(0, 20),
        });
        if (!r || !r.ok) throw new Error((r && r.error) || 'AI 调用失败');
      }
      return finish(await api.pptSave(inp.files, toDir ? 'output' : 'overwrite', outputDir));
    }
    if (n.type === 'custom') {
      let prompt = String(n.data.prompt || '').trim();
      if (!prompt) throw new Error('请在「信息内容」里填写提示词');
      if (inp.rules.length) {
        prompt += '\n\n【替换规则】\n' + inp.rules.map((r) => (r.find || '') + ' → ' + (r.replace || '')).join('\n');
      }
      if (inp.skill) prompt = '【技能：' + inp.skill + '】\n' + prompt;
      setStatus('模块自定义：AI 处理中…');
      const r = await api.wfAiRun({
        profileId: inp.model ? inp.model.profileId : '',
        model: inp.model ? inp.model.model : '',
        prompt: prompt,
        files: inp.files.slice(0, 20),
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'AI 调用失败');
      const text = String((r && r.text) || '').trim();
      if (!text) throw new Error('AI 没有返回任何内容');
      const dir = (outputDir || (dirOf(inp.files[0]) + '/自定义输出')).replace(/\/+$/, '');
      const fp = dir + '/模块自定义-' + stamp() + '.md';
      const w = await api.wfWriteText({ filePath: fp, content: text });
      if (!w || !w.ok) throw new Error((w && w.error) || '结果写入失败');
      const outPath = (w && w.filePath) || fp;
      return { files: [outPath], baseDir: dir, note: '已生成 ' + outPath.split('/').pop() };
    }
    throw new Error('未知节点类型');
  }

  async function runWorkflow() {
    if (running) return;
    const tasks = nodes.filter((n) => DEFS[n.type].group === 'task');
    if (!tasks.length) {
      setStatus('请先添加一个任务节点（替换文件 / 文件名修改 / 格式转换 / PDF去水印 / 文件自动化 / PPT 编写 / 模块自定义）');
      return;
    }
    const order = topoOrder(tasks);
    if (!order) { setStatus('任务节点之间存在循环连线，无法确定执行顺序'); return; }

    running = true; stopFlag = false;
    runBtn.disabled = true;
    stopBtn.classList.remove('hidden');
    nodes.forEach((n) => setNodeStatus(n.id, '', ''));
    setProgress(0);

    const rt = new Map();
    let okCount = 0;
    for (const n of order) {
      if (stopFlag) { setStatus('已停止'); break; }
      setNodeStatus(n.id, 'running', '运行中…');
      setStatus('正在执行：' + DEFS[n.type].title);
      try {
        const out = await execTask(n, rt);
        rt.set(n.id, out);
        setNodeStatus(n.id, 'done', out.note);
        okCount++;
        setStatus('「' + DEFS[n.type].title + '」' + out.note);
      } catch (err) {
        setNodeStatus(n.id, 'error', err && err.message ? err.message : String(err));
        setStatus('「' + DEFS[n.type].title + '」执行失败：' + (err && err.message ? err.message : err));
        break;
      }
    }
    setProgress(100);
    setTimeout(() => setProgress(0), 1200);
    running = false;
    runBtn.disabled = false;
    stopBtn.classList.add('hidden');
    if (!stopFlag) setStatus('工作流执行完毕：' + okCount + '/' + order.length + ' 个任务成功');
  }

  /* ---------------- 数据预加载 ---------------- */
  async function loadSkills() {
    try { skillCache = await api.skillsList(); } catch (e) { skillCache = null; }
  }
  async function loadModels() {
    try {
      const st = await api.aiGetState();
      const profiles = (st && st.profiles) || [];
      const out = [];
      profiles.forEach((p) => {
        const ms = Array.isArray(p.models) && p.models.length ? p.models : (p.model ? [p.model] : []);
        ms.forEach((m) => {
          if (!m) return;
          out.push({ profileId: p.id, model: m, label: (p.name || '配置') + ' · ' + m });
        });
      });
      modelCache = out;
    } catch (e) { modelCache = []; }
  }

  /* ---------------- 绑定 ---------------- */
  document.getElementById('btn-add').addEventListener('click', showAddMenu);
  document.getElementById('btn-open').addEventListener('click', showOpenMenu);
  document.getElementById('btn-save').addEventListener('click', saveProject);
  document.getElementById('btn-saveas').addEventListener('click', saveAsFile);
  document.getElementById('btn-openfile').addEventListener('click', openFromFile);
  document.getElementById('btn-fit').addEventListener('click', fitView);
  document.getElementById('btn-clear').addEventListener('click', clearAll);
  runBtn.addEventListener('click', runWorkflow);
  stopBtn.addEventListener('click', () => { stopFlag = true; setStatus('正在停止…（当前节点结束后停止）'); });
  nameEl.addEventListener('input', markDirty);

  if (api.onModuleProgress) api.onModuleProgress((d) => { if (d && d.pct != null) setProgress(d.pct); });
  if (api.onWfAiText) api.onWfAiText((t) => { if (t) setStatus('AI：' + String(t).replace(/\s+/g, ' ').slice(0, 90)); });

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    await loadSkills();
    await loadModels();
    // 默认给一个「来源 → 任务」的起手布局，省得空画布无从下手
    const s = addNode('source', 60, 60);
    addNode('output', 60, 400);
    addNode('replace', 400, 90);
    if (s) markDirty();
    applyView();
    setStatus('就绪：点左侧「＋ 新建」添加节点，连线后点右下角「运行」');
  })();
})();
