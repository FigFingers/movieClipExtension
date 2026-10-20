// モック管理の画面。/__mock/api/* を使う。
const $ = (selector) => document.querySelector(selector);

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function api(path, init = {}) {
  const res = await fetch(`/__mock/api/${path}`, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${path} failed`);
  return body;
}

function table(rows, columns) {
  if (rows.length === 0) return '<p class="empty">なし</p>';
  return `<table class="table"><thead><tr>${columns.map(([label]) => `<th>${escape(label)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((row) => `<tr>${columns.map(([, render]) => `<td>${render(row)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

let lastSettings = null;

function fillSettings(settings) {
  if (lastSettings && JSON.stringify(lastSettings) === JSON.stringify(settings)) return;
  lastSettings = settings;
  const form = $('#settings-form');
  form.validationErrorFormat.value = settings.validationErrorFormat;
  form.authTokenTtlDays.value = String(Math.round((settings.authTokenTtlMs / 86_400_000) * 100) / 100);
  form.allowedOrigins.value = settings.allowedOrigins.join(',');
  form.relinkReassignsUser.checked = settings.relinkReassignsUser;
  form.fakeCsp.value = settings.fake.csp;
}

async function refresh() {
  const [state, { requests }] = await Promise.all([api('state'), api('requests')]);
  fillSettings(state.settings);
  const users = new Map(state.users.map((user) => [user.id, user.name]));
  $('#linked').innerHTML = table(state.linkedExtensions, [
    ['ID', (row) => row.id],
    ['利用者', (row) => escape(users.get(row.userId)) + (row.previousUserIds?.length ? `<br><small>以前: ${row.previousUserIds.map((id) => escape(users.get(id))).join(', ')}</small>` : '')],
    ['instanceId', (row) => `<code>${escape(row.extensionInstanceId)}</code>`],
    ['期限', (row) => escape(row.expiresAt)],
    ['更新', (row) => row.rotations ?? 0],
    ['状態', (row) => (row.revokedAt ? `解除 ${escape(row.revokedAt)}` : '有効')],
    ['', (row) => (row.revokedAt ? '' : `<button data-linked="${row.id}" data-op="revoke" class="secondary">失効</button> <button data-linked="${row.id}" data-op="expire" class="secondary">期限切れ</button> <button data-linked="${row.id}" data-op="soon" class="secondary">期限を 1 日後に</button>`)],
  ]);
  $('#faults').innerHTML = table(state.faults, [
    ['ID', (row) => row.id],
    ['対象', (row) => `${escape(row.method)} ${escape(row.path)}`],
    ['種類', (row) => `${escape(row.kind)}${row.kind === 'status' ? ` ${row.status}` : ''}${row.delayMs ? ` +${row.delayMs}ms` : ''}`],
    ['残り', (row) => (row.times === null ? '∞' : row.times)],
    ['当たり', (row) => row.hits],
    ['', (row) => `<button data-fault="${row.id}" class="secondary">消す</button>`],
  ]);
  const clips = [...state.clips].reverse().slice(0, 30);
  $('#clips').innerHTML = table(clips, [
    ['ID', (row) => row.id],
    ['利用者', (row) => escape(users.get(row.userId))],
    ['名前', (row) => escape(row.name)],
    ['作品', (row) => `${escape(row.title)}${row.epnum ? ` / ${escape(row.epnum)}` : ''}`],
    ['区間', (row) => `${row.startMs / 1000}–${row.endMs / 1000}`],
    ['URL', (row) => `<code>${escape(row.url)}</code>`],
    ['由来', (row) => (row.source ? `拡張 #${row.source.linkedExtensionId}<br><small>${escape(row.source.clientItemId)}</small>` : '初期データ')],
  ]);
  $('#requests').innerHTML = table([...requests].reverse().slice(0, 80), [
    ['#', (row) => row.id],
    ['時刻', (row) => escape(row.at.slice(11, 23))],
    ['要求', (row) => `${escape(row.method)} ${escape(row.path)}${row.query ? `<br><small>${escape(row.query)}</small>` : ''}`],
    ['status', (row) => `${escape(row.status)}${row.fault ? ` <span class="tag">障害 #${row.fault.id}</span>` : ''}`],
    ['Origin', (row) => escape(row.origin || '—')],
    ['認証', (row) => escape(row.authorization || '—')],
    ['本文', (row) => (row.body ? `<details><summary>表示</summary><pre>${escape(JSON.stringify(row.body, null, 2))}</pre></details>` : '')],
  ]);
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.admin === 'reset') await api('reset', { method: 'POST', body: '{}' });
    else if (target.dataset.admin === 'reset-empty') await api('reset', { method: 'POST', body: JSON.stringify({ seed: 'empty' }) });
    else if (target.dataset.admin === 'clear-faults') await api('faults', { method: 'DELETE' });
    else if (target.dataset.fault) await api(`faults/${target.dataset.fault}`, { method: 'DELETE' });
    else if (target.dataset.linked) {
      const op = target.dataset.op;
      if (op === 'revoke') await api(`linked-extensions/${target.dataset.linked}/revoke`, { method: 'POST', body: '{}' });
      if (op === 'expire') await api(`linked-extensions/${target.dataset.linked}/expire`, { method: 'POST', body: '{}' });
      if (op === 'soon') await api(`linked-extensions/${target.dataset.linked}/expire`, { method: 'POST', body: JSON.stringify({ inMs: 86_400_000 }) });
    } else return;
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

$('#fault-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const fault = {
    method: form.get('method'),
    path: form.get('path'),
    kind: form.get('kind'),
    status: Number(form.get('status')),
    delayMs: Number(form.get('delayMs')),
  };
  const times = form.get('times');
  if (times) fault.times = Number(times);
  try {
    await api('faults', { method: 'POST', body: JSON.stringify(fault) });
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('settings', {
      method: 'POST',
      body: JSON.stringify({
        validationErrorFormat: form.validationErrorFormat.value,
        authTokenTtlMs: Math.round(Number(form.authTokenTtlDays.value) * 86_400_000),
        allowedOrigins: form.allowedOrigins.value.split(',').map((value) => value.trim()).filter(Boolean),
        relinkReassignsUser: form.relinkReassignsUser.checked,
        fake: { csp: form.fakeCsp.value },
      }),
    });
    lastSettings = null;
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

refresh();
setInterval(() => refresh().catch(() => {}), 2000);
