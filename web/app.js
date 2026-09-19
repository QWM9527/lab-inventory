/* 实验室物资清点 —— 前端逻辑 */
'use strict';

var state = { me: null, items: [], users: [], recOffset: 0, recLimit: 50, recTotal: 0 };

/* ---------------- 通用工具 ---------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var toastTimer = null;
function toast(msg, isErr) {
  var el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = 'toast hidden'; }, 2600);
}

async function api(path, opts) {
  opts = opts || {};
  var res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    if (res.status === 401 && state.me) { state.me = null; showLogin(); }
    throw new Error((data && data.error) || '请求失败（' + res.status + '）');
  }
  return data || {};
}

/* ---------------- 弹窗 ---------------- */
function openModal(html) {
  $('#modalBox').innerHTML = html;
  $('#modalMask').classList.remove('hidden');
  var first = $('#modalBox input, #modalBox select');
  if (first) setTimeout(function () { first.focus(); }, 30);
}
function closeModal() {
  $('#modalMask').classList.add('hidden');
  $('#modalBox').innerHTML = '';
}
$('#modalMask').addEventListener('mousedown', function (e) {
  if (e.target === $('#modalMask')) closeModal();
});
// 弹窗里的「取消」统一在这里处理，避免每次打开弹窗重复绑定事件
$('#modalBox').addEventListener('click', function (e) {
  if (e.target.hasAttribute('data-close')) closeModal();
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

/* ---------------- 登录 ---------------- */
function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
}
function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  applyRoleUI();
  loadItems();
  loadStats();
}

/* 按当前登录角色显示/隐藏管理员专属入口 */
function isAdminRole() { return !!state.me && (state.me.role === 'admin' || state.me.role === 'super'); }
function applyRoleUI() {
  var isAdmin = isAdminRole();
  var isSuper = !!state.me && state.me.role === 'super';
  $$('.admin-only').forEach(function (el) { el.classList.toggle('hidden', !isAdmin); });
  $$('.super-only').forEach(function (el) { el.classList.toggle('hidden', !isSuper); });
  $$('.member-only').forEach(function (el) { el.classList.toggle('hidden', isAdmin); });
  $('#whoName').textContent = state.me.display_name + '（' + state.me.username + '）';
  $('#whoRole').textContent = isSuper ? '超级管理员' : (isAdmin ? '管理员' : '普通成员');
  $('#whoRole').className = 'badge' + (isSuper ? ' super' : (isAdmin ? '' : ' member'));
}

$('#loginForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  var f = e.target;
  $('#loginErr').textContent = '';
  try {
    var r = await api('/api/login', { method: 'POST', body: { username: f.username.value.trim(), password: f.password.value } });
    state.me = r.user;
    f.reset();
    showApp();
    toast('欢迎回来，' + state.me.display_name);
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});

$('#btnLogout').addEventListener('click', async function () {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
  state.me = null;
  showLogin();
});

/* ---------------- 标签页 ---------------- */
$$('.tab').forEach(function (btn) {
  btn.addEventListener('click', function () {
    $$('.tab').forEach(function (b) { b.classList.remove('active'); });
    $$('.panel').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'records') { state.recOffset = 0; loadRecords(); }
    if (btn.dataset.tab === 'users') loadUsers();
  });
});

/* ---------------- 统计 ---------------- */
async function loadStats() {
  try {
    var s = await api('/api/stats');
    $('#stats').innerHTML =
      card('物资种类', s.kinds, '种') +
      card('库存总数', s.total, '件') +
      card('低于下限', s.low, '种', s.low > 0 ? 'warn' : 'ok') +
      card('今日入库', s.today_in, '件', 'ok') +
      card('今日领用', s.today_out, '件');
  } catch (e) { /* 静默 */ }
}
function card(k, v, unit, cls) {
  return '<div class="stat ' + (cls || '') + '"><div class="k">' + k + '</div><div class="v">' +
    esc(v) + (unit ? '<small>' + unit + '</small>' : '') + '</div></div>';
}

/* ---------------- 物资清单 ---------------- */
async function loadItems() {
  var kw = $('#itemSearch').value.trim();
  try {
    var r = await api('/api/items' + (kw ? '?kw=' + encodeURIComponent(kw) : ''));
    state.items = r.items;
    renderItems();
  } catch (e) { toast(e.message, true); }
}

function renderItems() {
  var tb = $('#itemTable tbody');
  if (!state.items.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">' +
      (isAdminRole() ? '还没有物资，点右上角「+ 新增物资」开始登记' : '还没有物资，请联系管理员登记') +
      '</td></tr>';
    return;
  }
  tb.innerHTML = state.items.map(function (it) {
    var ops;
    if (isAdminRole()) {
      ops = '<button class="btn tiny primary" data-act="out" data-id="' + it.id + '">领用</button> ' +
            '<button class="btn tiny" data-act="in" data-id="' + it.id + '">入库</button> ' +
            '<button class="btn tiny ghost" data-act="adjust" data-id="' + it.id + '">盘点</button> ' +
            '<button class="btn tiny ghost" data-act="edit" data-id="' + it.id + '">编辑</button> ' +
            '<button class="btn tiny danger" data-act="del" data-id="' + it.id + '">删除</button>';
    } else {
      ops = '<span class="muted">只读</span>';   // 普通成员只能查看
    }
    return '<tr class="' + (it.low ? 'low' : '') + '">' +
      '<td><b>' + esc(it.name) + '</b>' + (it.note ? '<div class="muted">' + esc(it.note) + '</div>' : '') + '</td>' +
      '<td>' + esc(it.category) + '</td>' +
      '<td class="muted">' + esc(it.spec) + '</td>' +
      '<td class="num"><span class="qty' + (it.low ? ' bad' : '') + '">' + it.qty + '</span></td>' +
      '<td>' + esc(it.unit) + '</td>' +
      '<td class="num muted">' + it.min_qty + '</td>' +
      '<td class="muted">' + esc(it.location) + '</td>' +
      '<td class="op">' + ops + '</td></tr>';
  }).join('');
}

$('#itemTable').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-act]');
  if (!b) return;
  var it = state.items.filter(function (x) { return x.id === Number(b.dataset.id); })[0];
  if (!it) return;
  var act = b.dataset.act;
  if (act === 'edit') itemForm(it);
  else if (act === 'del') delItem(it);
  else stockForm(it, act);
});

$('#itemSearch').addEventListener('input', function () {
  clearTimeout(window.__searchTimer);
  window.__searchTimer = setTimeout(loadItems, 220);
});

/* ---- 新增 / 编辑物资 ---- */
function itemForm(it) {
  var editing = !!it;
  it = it || { name: '', category: '', spec: '', unit: '个', location: '', min_qty: 0, note: '', qty: 0 };
  openModal(
    '<h3>' + (editing ? '编辑物资' : '新增物资') + '</h3>' +
    '<div class="err" id="mErr"></div>' +
    '<label>物资名称 *<input id="fName" value="' + esc(it.name) + '" placeholder="例如：STM32F103C8T6 开发板"></label>' +
    '<div class="row">' +
      '<label>类别<input id="fCategory" value="' + esc(it.category) + '" placeholder="单片机 / 元器件"></label>' +
      '<label>单位<input id="fUnit" value="' + esc(it.unit) + '" placeholder="块 / 个 / 盒"></label>' +
    '</div>' +
    '<label>规格型号<input id="fSpec" value="' + esc(it.spec) + '" placeholder="选填"></label>' +
    '<div class="row">' +
      '<label>存放位置<input id="fLocation" value="' + esc(it.location) + '" placeholder="例如：A柜 2 层"></label>' +
      '<label>库存下限<input id="fMin" type="number" min="0" value="' + it.min_qty + '"></label>' +
    '</div>' +
    (editing ? '' : '<label>初始数量<input id="fQty" type="number" min="0" value="0"></label>') +
    '<label>备注<input id="fNote" value="' + esc(it.note) + '" placeholder="选填"></label>' +
    '<div class="actions"><button class="btn" data-close>取消</button>' +
    '<button class="btn primary" id="mSave">保存</button></div>'
  );
  $('#mSave').onclick = async function () {
    var body = {
      name: $('#fName').value.trim(), category: $('#fCategory').value.trim(),
      spec: $('#fSpec').value.trim(), unit: $('#fUnit').value.trim() || '个',
      location: $('#fLocation').value.trim(), min_qty: Number($('#fMin').value || 0),
      note: $('#fNote').value.trim()
    };
    if (!body.name) { $('#mErr').textContent = '请填写物资名称'; return; }
    try {
      if (editing) await api('/api/items/' + it.id, { method: 'PUT', body: body });
      else {
        body.qty = Number($('#fQty').value || 0);
        await api('/api/items', { method: 'POST', body: body });
      }
      closeModal(); loadItems(); loadStats();
      toast(editing ? '已保存' : '物资已新增');
    } catch (e) { $('#mErr').textContent = e.message; }
  };
}

async function delItem(it) {
  if (!confirm('确定删除「' + it.name + '」吗？\n历史流水会保留，但物资会从清单消失。')) return;
  try {
    await api('/api/items/' + it.id, { method: 'DELETE' });
    loadItems(); loadStats(); toast('已删除');
  } catch (e) { toast(e.message, true); }
}

/* ---- 入库 / 领用 / 盘点 ---- */
function stockForm(it, act) {
  var title = act === 'in' ? '入库登记' : act === 'out' ? '领用登记' : '盘点修正';
  var hint = act === 'in' ? '新采购 / 归还的数量'
    : act === 'out' ? '被拿走的数量'
    : '填写实际清点数量，系统会按这个数校正';
  var max = act === 'out' ? ' max="' + it.qty + '"' : '';
  var dflt = act === 'in' ? 1 : act === 'out' ? 1 : it.qty;
  openModal(
    '<h3>' + title + '：' + esc(it.name) + '</h3>' +
    '<p class="muted" style="margin:-8px 0 14px">当前库存 <b>' + it.qty + '</b> ' + esc(it.unit) + '　·　' + hint + '</p>' +
    '<div class="err" id="mErr"></div>' +
    '<label>' + (act === 'adjust' ? '实际数量' : '数量') + '（' + esc(it.unit) + '）' +
      '<input id="fQty" type="number" min="0"' + max + ' value="' + dflt + '"></label>' +
    '<label>备注<input id="fNote" placeholder="' +
      (act === 'out' ? '谁领走的 / 用在哪 / 项目名' : act === 'in' ? '采购单号 / 来源' : '差异原因') + '"></label>' +
    '<div class="actions"><button class="btn" data-close>取消</button>' +
    '<button class="btn primary" id="mSave">确认' + title.slice(0, 2) + '</button></div>'
  );
  $('#mSave').onclick = async function () {
    var qty = Number($('#fQty').value);
    if (!Number.isInteger(qty) || qty < 0 || (act !== 'adjust' && qty === 0)) {
      $('#mErr').textContent = '请填写正确的数量'; return;
    }
    try {
      await api('/api/records', { method: 'POST', body: { item_id: it.id, type: act, qty: qty, note: $('#fNote').value.trim() } });
      closeModal(); loadItems(); loadStats();
      toast(title + '成功');
    } catch (e) { $('#mErr').textContent = e.message; }
  };
}

/* ---------------- 流水 ---------------- */
async function loadRecords() {
  var q = [];
  q.push('limit=' + state.recLimit, 'offset=' + state.recOffset);
  var kw = $('#recKw').value.trim();
  if (kw) q.push('kw=' + encodeURIComponent(kw));
  if ($('#recType').value) q.push('type=' + $('#recType').value);
  if ($('#recFrom').value) q.push('from=' + $('#recFrom').value);
  if ($('#recTo').value) q.push('to=' + $('#recTo').value);
  try {
    var r = await api('/api/records?' + q.join('&'));
    state.recTotal = r.total;
    renderRecords(r.records);
  } catch (e) { toast(e.message, true); }
}

function renderRecords(list) {
  var tb = $('#recTable tbody');
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">没有符合条件的记录</td></tr>';
  } else {
    tb.innerHTML = list.map(function (r) {
      var sign = r.type === 'out' ? '−' : r.type === 'in' ? '+' : '=';
      return '<tr><td class="muted">' + esc(r.created_at) + '</td>' +
        '<td><b>' + esc(r.item_name) + '</b></td>' +
        '<td><span class="tag ' + r.type + '">' + tagText(r.type) + '</span></td>' +
        '<td class="num">' + sign + r.qty + ' ' + esc(r.item_unit) + '</td>' +
        '<td class="num muted">' + r.before_qty + '</td>' +
        '<td class="num"><b>' + r.after_qty + '</b></td>' +
        '<td>' + esc(r.operator) + '</td>' +
        '<td class="muted">' + esc(r.note) + '</td></tr>';
    }).join('');
  }
  var from = state.recTotal ? state.recOffset + 1 : 0;
  var to = Math.min(state.recOffset + state.recLimit, state.recTotal);
  $('#recPageInfo').textContent = from + ' - ' + to + ' / 共 ' + state.recTotal + ' 条';
  $('#recPrev').disabled = state.recOffset <= 0;
  $('#recNext').disabled = to >= state.recTotal;
}
function tagText(t) { return t === 'in' ? '入库' : t === 'out' ? '领用' : '盘点'; }

$('#btnRecQuery').addEventListener('click', function () { state.recOffset = 0; loadRecords(); });
$('#btnRecReset').addEventListener('click', function () {
  $('#recKw').value = ''; $('#recType').value = ''; $('#recFrom').value = ''; $('#recTo').value = '';
  state.recOffset = 0; loadRecords();
});
$('#recKw').addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.recOffset = 0; loadRecords(); } });
$('#recPrev').addEventListener('click', function () { state.recOffset = Math.max(0, state.recOffset - state.recLimit); loadRecords(); });
$('#recNext').addEventListener('click', function () { state.recOffset += state.recLimit; loadRecords(); });
$('#btnExport').addEventListener('click', function () { window.location.href = '/api/export'; });

/* ---------------- 清理流水（仅超级管理员） ---------------- */
function todayStr(offsetDays) {
  var d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

$('#btnPurge').addEventListener('click', function () {
  openModal(
    '<h3>清理出入库流水</h3>' +
    '<div class="err" id="mErr"></div>' +
    '<div class="warn-box">只删除<b>历史流水</b>，物资的<b>现有数量不受影响</b>。<br>' +
      '清理前系统会自动整库备份一份，放在 <code>data\\backup</code> 里，随时可以恢复。</div>' +
    '<label>清理范围<select id="pScope">' +
      '<option value="before">某天之前（含当天）的流水</option>' +
      '<option value="range">指定日期区间</option>' +
      '<option value="all">全部流水</option>' +
    '</select></label>' +
    '<div class="row" id="pDateRow">' +
      '<label id="pFromWrap">开始日期<input type="date" id="pFrom"></label>' +
      '<label>结束日期<input type="date" id="pTo"></label>' +
    '</div>' +
    '<div class="sep" id="pCount">正在统计…</div>' +
    '<label>确认清理请输入「清理」两个字<input id="pConfirm" placeholder="清理"></label>' +
    '<div class="actions"><button class="btn" data-close>取消</button>' +
    '<button class="btn danger" id="mSave">确认清理</button></div>'
  );

  var $scope = $('#pScope'), $from = $('#pFrom'), $to = $('#pTo');
  $from.value = todayStr(-30);
  $to.value = '';

  function syncRows() {
    var s = $scope.value;
    $('#pDateRow').classList.toggle('hidden', s === 'all');
    $('#pFromWrap').classList.toggle('hidden', s === 'before');
    $('#pCount').textContent = '正在统计…';
    var q = ['limit=1'];
    if (s === 'before') {
      if (!$to.value) { $('#pCount').textContent = '请先选择「结束日期」'; return; }
      q.push('to=' + $to.value);
    } else if (s === 'range') {
      if (!$from.value || !$to.value) { $('#pCount').textContent = '请先选择起止日期'; return; }
      q.push('from=' + $from.value, 'to=' + $to.value);
    }
    api('/api/records?' + q.join('&')).then(function (r) {
      $('#pCount').innerHTML = '这个范围里有 <b>' + r.total + '</b> 条记录将被删除' +
        (r.total ? '' : '（没有可清理的记录）');
    }).catch(function (e) { $('#pCount').textContent = e.message; });
  }
  $scope.onchange = syncRows;
  $from.onchange = syncRows;
  $to.onchange = syncRows;
  syncRows();

  $('#mSave').onclick = async function () {
    if ($('#pConfirm').value.trim() !== '清理') {
      $('#mErr').textContent = '请在下框里输入「清理」两个字以确认'; return;
    }
    var body = { scope: $scope.value, from: $from.value, to: $to.value };
    if (body.scope === 'range' && (!body.from || !body.to)) { $('#mErr').textContent = '请选择起止日期'; return; }
    if (body.scope === 'before' && !body.to) { $('#mErr').textContent = '请选择结束日期'; return; }
    try {
      var r = await api('/api/records/purge', { method: 'POST', body: body });
      closeModal();
      loadRecords(); loadStats();
      toast(r.message + '，剩余 ' + r.remaining + ' 条');
    } catch (e) { $('#mErr').textContent = e.message; }
  };
});

/* ---------------- 人员管理 ---------------- */
async function loadUsers() {
  try {
    var r = await api('/api/users');
    state.users = r.users;
    renderUsers();
  } catch (e) { toast(e.message, true); }
}

function roleLabel(r) { return r === 'super' ? '超级管理员' : (r === 'admin' ? '管理员' : '普通成员'); }
function roleBadge(r) {
  var cls = r === 'super' ? ' super' : (r === 'admin' ? '' : ' member');
  return '<span class="badge' + cls + '">' + roleLabel(r) + '</span>';
}

function renderUsers() {
  var tb = $('#userTable tbody');
  $('#userCount').textContent = state.users.length;
  var iAmSuper = state.me.role === 'super';
  var activeAdmins = state.users.filter(function (x) { return (x.role === 'admin' || x.role === 'super') && x.active; }).length;
  tb.innerHTML = state.users.map(function (u) {
    var me = state.me.id === u.id;
    var isSuperRow = u.role === 'super';
    var isAdminRow = u.role === 'admin';
    var lastAdmin = isAdminRow && activeAdmins <= 1;

    // 能不能管理这个账号
    var canManage;
    if (me) canManage = true;                        // 自己的账号：改姓名 / 账号 / 密码
    else if (isSuperRow) canManage = false;          // 超级管理员只有他本人能动
    else if (iAmSuper) canManage = true;             // 超级管理员：全部都能管
    else if (isAdminRow) canManage = false;          // 普通管理员：管不了别的管理员
    else canManage = true;                           // 普通管理员：能管普通成员

    var canRole = iAmSuper && !me && !isSuperRow;    // 只有超级管理员能升/降角色
    var canToggle = canManage && !me && !isSuperRow;
    var canDelete = canManage && !me && !isSuperRow && !lastAdmin;

    return '<tr>' +
      '<td><b>' + esc(u.username) + '</b>' + (me ? ' <span class="muted">(我)</span>' : '') +
        (isSuperRow ? ' <span class="muted">· 保底钥匙</span>' : '') + '</td>' +
      '<td>' + esc(u.display_name) + '</td>' +
      '<td>' + roleBadge(u.role) + '</td>' +
      '<td>' + (u.active ? '正常' : '<span class="muted">已停用</span>') + '</td>' +
      '<td class="op">' +
        '<button class="btn tiny primary" data-uact="edit" data-id="' + u.id + '"' +
          (canManage ? '' : ' disabled title="' + (isSuperRow ? '只有超级管理员本人能改这个账号' : '只有超级管理员能管理管理员账号') + '"') +
          '>编辑</button> ' +
        '<button class="btn tiny ghost" data-uact="role" data-id="' + u.id + '"' +
          (canRole ? '' : ' disabled title="只有超级管理员能设置角色"') + '>设为' + (u.role === 'admin' ? '成员' : '管理员') + '</button> ' +
        '<button class="btn tiny ghost" data-uact="toggle" data-id="' + u.id + '"' +
          (canToggle ? '' : ' disabled') + '>' + (u.active ? '停用' : '启用') + '</button> ' +
        '<button class="btn tiny danger" data-uact="del" data-id="' + u.id + '"' +
          (canDelete ? '' : ' disabled') + '>删除</button>' +
      '</td></tr>';
  }).join('');
}

$('#userTable').addEventListener('click', async function (e) {
  var b = e.target.closest('button[data-uact]');
  if (!b) return;
  var u = state.users.filter(function (x) { return x.id === Number(b.dataset.id); })[0];
  if (!u) return;
  var act = b.dataset.uact;
  try {
    if (act === 'edit') { userEditForm(u); return; }
    if (act === 'role') {
      await api('/api/users/' + u.id, { method: 'PUT', body: { role: u.role === 'admin' ? 'member' : 'admin' } });
      toast(u.role === 'admin' ? '已降为普通成员' : '已升为管理员');
    } else if (act === 'toggle') {
      await api('/api/users/' + u.id, { method: 'PUT', body: { active: u.active ? 0 : 1 } });
      toast(u.active ? '已停用' : '已启用');
    } else if (act === 'del') {
      if (!confirm('确定删除账号「' + u.username + '」吗？\n他的历史流水会保留。')) return;
      await api('/api/users/' + u.id, { method: 'DELETE' });
      toast('已删除');
    }
    loadUsers();
  } catch (err) { toast(err.message, true); }
});

/* ---- 编辑某个账号（管理员）：改姓名 / 登录账号 / 密码 / 角色 ---- */
function userEditForm(u) {
  var me = u.id === state.me.id;
  var isSuperRow = u.role === 'super';
  var iAmSuper = state.me.role === 'super';
  var canRole = iAmSuper && !me && !isSuperRow;     // 只有超级管理员能设置角色
  openModal(
    '<h3>编辑账号</h3>' +
    '<div class="err" id="mErr"></div>' +
    '<label>登录账号 *<input id="uUser" value="' + esc(u.username) + '" placeholder="字母/数字，2-32 位"></label>' +
    '<label>姓名 *<input id="uDisplay" value="' + esc(u.display_name) + '" placeholder="张三"></label>' +
    '<label>新密码<input id="uPwd" placeholder="不修改就留空，至少 6 位"></label>' +
    '<label>角色<select id="uRole"' + (canRole ? '' : ' disabled') + '>' +
      '<option value="member"' + (u.role === 'member' ? ' selected' : '') + '>普通成员（只能查看，不能录入）</option>' +
      '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>管理员（可管理物资、录入出入库、管人员）</option>' +
      (isSuperRow ? '<option value="super" selected>超级管理员（保底账号，不可更改）</option>' : '') +
    '</select></label>' +
    (me ? '<p class="muted" style="margin:-8px 0 10px">不能修改自己的角色，避免把自己锁在外面。</p>' : '') +
    (isSuperRow && !me ? '<p class="muted" style="margin:-8px 0 10px">超级管理员是保底账号，不能改角色、不能停用、不能删除。</p>' : '') +
    (!canRole && !me && !isSuperRow ? '<p class="muted" style="margin:-8px 0 10px">只有超级管理员能设置角色，你可以改这个成员的姓名、账号和密码。</p>' : '') +
    '<div class="actions"><button class="btn" data-close>取消</button>' +
    '<button class="btn primary" id="mSave">保存</button></div>'
  );
  $('#mSave').onclick = async function () {
    var body = { username: $('#uUser').value.trim(), display_name: $('#uDisplay').value.trim() };
    var p = $('#uPwd').value;
    if (p) body.password = p;
    if (canRole) body.role = $('#uRole').value;
    try {
      await api('/api/users/' + u.id, { method: 'PUT', body: body });
      closeModal();
      if (me) await refreshMe();
      loadUsers();
      toast('已保存');
    } catch (e) { $('#mErr').textContent = e.message; }
  };
}

$('#btnNewUser').addEventListener('click', function () {
  var iAmSuper = state.me.role === 'super';
  openModal(
    '<h3>新增人员</h3>' +
    '<div class="err" id="mErr"></div>' +
    '<label>登录账号 *<input id="fUser" placeholder="字母/数字，2-32 位"></label>' +
    '<label>姓名 *<input id="fName2" placeholder="张三"></label>' +
    '<label>初始密码 *<input id="fPwd" placeholder="至少 6 位"></label>' +
    (iAmSuper
      ? '<label>角色<select id="fRole"><option value="member">普通成员（只能查看，不能录入）</option>' +
        '<option value="admin">管理员（可管理物资、录入出入库、管人员）</option></select></label>'
      : '<label>角色<input value="普通成员（只能查看，不能录入）" disabled></label>' +
        '<p class="muted" style="margin:-8px 0 10px">只有超级管理员能创建管理员账号，你新增的都是普通成员。</p>') +
    '<div class="actions"><button class="btn" data-close>取消</button>' +
    '<button class="btn primary" id="mSave">创建</button></div>'
  );
  $('#mSave').onclick = async function () {
    try {
      var body = {
        username: $('#fUser').value.trim(), display_name: $('#fName2').value.trim(),
        password: $('#fPwd').value
      };
      if (iAmSuper) body.role = $('#fRole').value;
      await api('/api/users', { method: 'POST', body: body });
      closeModal(); loadUsers(); toast('人员已创建');
    } catch (e) { $('#mErr').textContent = e.message; }
  };
});

/* ---------------- 我的账号：改姓名 / 改登录账号 / 改密码 ---------------- */
$('#btnPwd').addEventListener('click', function () {
  openModal(
    '<h3>我的账号</h3>' +
    '<div class="err" id="mErr"></div>' +
    '<label>登录账号 *<input id="pUser" value="' + esc(state.me.username) + '" placeholder="字母/数字，2-32 位"></label>' +
    '<label>姓名 *<input id="pName" value="' + esc(state.me.display_name) + '" placeholder="张三"></label>' +
    '<div class="sep">要改密码就填下面三项，不改就留空</div>' +
    '<label>原密码<input id="pOld" type="password"></label>' +
    '<label>新密码（至少 6 位）<input id="pNew" type="password"></label>' +
    '<label>再输一次<input id="pNew2" type="password"></label>' +
    '<div class="actions"><button class="btn" data-close>取消</button>' +
    '<button class="btn primary" id="mSave">保存</button></div>'
  );
  $('#mSave').onclick = async function () {
    var body = {
      username: $('#pUser').value.trim(),
      display_name: $('#pName').value.trim(),
    };
    var np = $('#pNew').value;
    if (np || $('#pOld').value || $('#pNew2').value) {
      if (np !== $('#pNew2').value) { $('#mErr').textContent = '两次输入的新密码不一致'; return; }
      if (!np) { $('#mErr').textContent = '请填写新密码'; return; }
      body.old_password = $('#pOld').value;
      body.new_password = np;
    }
    try {
      await api('/api/profile', { method: 'POST', body: body });
      closeModal();
      await refreshMe();
      toast('已保存');
    } catch (e) { $('#mErr').textContent = e.message; }
  };
});

/* 重新拉取自己的账号信息，刷新右上角显示 */
async function refreshMe() {
  var r = await api('/api/me');
  if (!r.user) { showLogin(); return; }
  state.me = r.user;
  applyRoleUI();
  if (isAdminRole()) loadUsers();
}

/* 顶栏「账号管理」按钮：不管下面的标签页怎么显示，这里永远能进人员管理 */
$('#btnUsers').addEventListener('click', function () {
  var tab = $('.tab[data-tab="users"]');
  if (tab) tab.click();
  else { toast('页面版本不对，请按 Ctrl+F5 强制刷新一下', true); }
});

$('#btnNewItem').addEventListener('click', function () { itemForm(null); });

/* ---------------- 启动 ---------------- */
(async function boot() {
  try {
    var r = await api('/api/me');
    if (r.user) { state.me = r.user; showApp(); } else showLogin();
  } catch (e) { showLogin(); }
})();
