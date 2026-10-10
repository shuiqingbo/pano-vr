/**
 * 管理页：上传全景图、看切片进度、管理项目。
 *
 * 切片在后端要跑好几秒（11008x5504 约 5-6 秒），所以上传接口是
 * 「立即返回 jobId」的形式，这里轮询 /api/jobs/<id> 显示进度。
 */

const el = {
  drop: document.getElementById('drop'),
  file: document.getElementById('file'),
  queue: document.getElementById('queue'),
  list: document.getElementById('list'),
  count: document.getElementById('count'),
  toast: document.getElementById('toast'),
};

/* ---------------- 提示条 ---------------- */

let toastTimer = null;
function toast(msg, isError = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle('toast--error', isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, isError ? 8000 : 4000);
}

/* ---------------- 上传 ---------------- */

el.drop.addEventListener('click', () => el.file.click());
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); }
});
el.file.addEventListener('change', () => {
  if (el.file.files.length) upload([...el.file.files]);
  el.file.value = '';
});

// 拖放
['dragenter', 'dragover'].forEach((t) =>
  el.drop.addEventListener(t, (e) => {
    e.preventDefault();
    el.drop.classList.add('drop--over');
  })
);
['dragleave', 'drop'].forEach((t) =>
  el.drop.addEventListener(t, (e) => {
    e.preventDefault();
    if (t === 'dragleave' && el.drop.contains(e.relatedTarget)) return;
    el.drop.classList.remove('drop--over');
  })
);
el.drop.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) upload(files);
  else toast('没有识别到图片文件', true);
});

// 防止拖到页面其他地方时浏览器直接打开图片
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/** 建一条进度卡片 */
function addTask(label) {
  const wrap = document.createElement('div');
  wrap.className = 'task';
  wrap.innerHTML = `
    <div class="task__row">
      <span class="task__name"></span>
      <span class="task__msg">准备中…</span>
      <span class="task__pct">0%</span>
    </div>
    <div class="bar-track"><div class="bar-fill"></div></div>`;
  wrap.querySelector('.task__name').textContent = label;
  el.queue.appendChild(wrap);
  el.queue.hidden = false;
  return {
    setMsg(t) { wrap.querySelector('.task__msg').textContent = t; },
    setPct(p) {
      const v = Math.max(0, Math.min(100, Math.round(p)));
      wrap.querySelector('.bar-fill').style.width = v + '%';
      wrap.querySelector('.task__pct').textContent = v + '%';
    },
    finish(ok, msg) {
      wrap.classList.add(ok ? 'task--done' : 'task--error');
      if (msg) wrap.querySelector('.task__msg').textContent = msg;
      if (ok) wrap.querySelector('.bar-fill').style.width = '100%';
    },
  };
}

async function upload(files) {
  const label = files.length === 1 ? files[0].name : `${files.length} 张图`;
  const task = addTask(label);
  task.setPct(3);
  task.setMsg('正在上传…');

  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);

  let res;
  try {
    res = await fetch('/api/projects', { method: 'POST', body: fd });
  } catch (e) {
    task.finish(false, `网络错误：${e.message}`);
    toast('上传失败，检查服务是否还在运行', true);
    return;
  }

  let data = {};
  try { data = await res.json(); } catch { /* 交给下面统一报错 */ }

  if (!res.ok) {
    const detail = Array.isArray(data.details) && data.details.length
      ? ' —— ' + data.details.join('；')
      : '';
    task.finish(false, (data.error || `上传失败（HTTP ${res.status}）`) + detail);
    toast('没有可用的图片，看看上面的提示', true);
    return;
  }

  if (data.warnings?.length) {
    toast(`已跳过 ${data.warnings.length} 张：${data.warnings.join('；')}`, true);
  }

  task.setMsg(`已上传 ${data.accepted} 张，开始切片…`);
  await pollJob(data.jobId, task);
}

/** 轮询切片进度 */
async function pollJob(jobId, task) {
  let lastMsg = '';
  while (true) {
    await new Promise((r) => setTimeout(r, 700));
    let j;
    try {
      const r = await fetch(`/api/jobs/${jobId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      j = await r.json();
    } catch (e) {
      task.finish(false, `查询进度失败：${e.message}`);
      return;
    }

    if (j.message && j.message !== lastMsg) {
      lastMsg = j.message;
      task.setMsg(j.message);
    }

    const total = j.total || 1;
    const done = j.done || 0;
    // 留 5% 给"收尾"（写元数据），避免进度条先到 100% 再卡住
    task.setPct(((done + (j.state === 'running' ? 0.5 : 1)) / total) * 95);

    if (j.state === 'done') {
      task.finish(true, `完成，共 ${total} 个场景`);
      loadProjects();
      return;
    }
    if (j.state === 'error') {
      task.finish(false, j.error || '切片失败');
      loadProjects();
      return;
    }
  }
}

/* ---------------- 项目列表 ---------------- */

async function loadProjects() {
  let items = [];
  try {
    const r = await fetch('/api/projects');
    items = await r.json();
  } catch (e) {
    el.list.innerHTML = '';
    toast('读取项目列表失败，检查服务是否还在运行', true);
    return;
  }

  el.count.textContent = items.length ? `${items.length} 个` : '';
  el.list.innerHTML = '';

  for (const p of items) {
    el.list.appendChild(renderItem(p));
  }
}

function renderItem(p) {
  const row = document.createElement('div');
  row.className = 'item';

  // 封面
  if (p.cover) {
    const img = document.createElement('img');
    img.className = 'item__cover';
    img.loading = 'lazy';
    img.alt = `${p.scenes?.[0] || '项目'} 预览`;
    img.src = p.cover;
    img.onerror = () => { img.replaceWith(emptyCover()); };
    row.appendChild(img);
  } else {
    row.appendChild(emptyCover());
  }

  // 主体
  const body = document.createElement('div');
  body.className = 'item__body';

  const title = document.createElement('div');
  title.className = 'item__title';
  const nameSpan = document.createElement('span');
  // 项目名用第一个场景名，多场景时补个说明
  nameSpan.textContent = p.scenes?.[0] || '未命名项目';
  title.appendChild(nameSpan);

  if (p.pending) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = '切片中';
    title.appendChild(b);
  }

  const idSpan = document.createElement('span');
  idSpan.className = 'item__id';
  idSpan.textContent = p.id;
  title.appendChild(idSpan);
  body.appendChild(title);

  const scenes = document.createElement('div');
  scenes.className = 'item__scenes';
  const names = p.scenes || [];
  scenes.textContent = names.length
    ? `${names.length} 个场景 · ${names.join(' / ')}`
    : '暂无场景';
  body.appendChild(scenes);

  const time = document.createElement('div');
  time.className = 'item__scenes';
  time.textContent = p.created || '';
  body.appendChild(time);

  row.appendChild(body);

  // 操作
  const acts = document.createElement('div');
  acts.className = 'item__acts';

  const open = document.createElement('a');
  open.className = 'btn btn--primary';
  open.textContent = '打开预览';
  open.href = `/p/${p.id}`;
  acts.appendChild(open);

  const copy = document.createElement('button');
  copy.className = 'btn';
  copy.type = 'button';
  copy.textContent = '复制链接';
  copy.addEventListener('click', async () => {
    const url = `${location.origin}/p/${p.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制');
    } catch {
      // 剪贴板可能被浏览器限制（非 https），退回手动复制
      prompt('复制这个链接：', url);
    }
  });
  acts.appendChild(copy);

  const del = document.createElement('button');
  del.className = 'btn btn--danger';
  del.type = 'button';
  del.textContent = '删除';
  del.addEventListener('click', () => removeProject(p, del));
  acts.appendChild(del);

  row.appendChild(acts);
  return row;
}

function emptyCover() {
  const d = document.createElement('div');
  d.className = 'item__cover item__cover--empty';
  d.textContent = '切片中';
  return d;
}

async function removeProject(p, btn) {
  const names = p.scenes || [];
  const label = names[0] || '这个项目';
  if (!confirm(`删除「${label}」？\n\n会同时删掉已切好的 ${names.length} 个场景，无法撤销。`)) {
    return;
  }
  btn.disabled = true;
  btn.textContent = '删除中…';
  try {
    const r = await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    toast(`已删除「${label}」`);
    loadProjects();
  } catch (e) {
    toast(`删除失败：${e.message}`, true);
    btn.disabled = false;
    btn.textContent = '删除';
  }
}

loadProjects();
