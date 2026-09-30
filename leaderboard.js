/* =============================================================
 *  奶娃跳一跳  ·  leaderboard.js
 *  在线好友排行榜 —— TinyWebDB（App Inventor 的极简 key-value 云存储）
 *
 *  为什么能用：https://tinywebdb.appinventor.space/api 走 POST 表单，
 *  且带 Access-Control-Allow-Origin: *，所以纯静态页也能直接读写，
 *  不需要自建后端。做法与 https://github.com/YHSome/BigNaiWa 一致。
 *
 *  设计要点（刻意如此）：
 *   - 榜单是「最近 20 次提交」的滚动时间窗，不是历史最高榜：
 *     你只在自己还在窗口里的那段时间有排名，后来的人会把你挤出去。
 *   - 只写自己那一条，从不 delete、从不改别人的数据。
 *   - 网络不通 / 接口挂了，只是榜单打不开 —— 游戏照常玩，退回本机记录。
 * ============================================================= */
(function () {
'use strict';

/* ---------- 账号（与参考实现同样的异或编码，不明文存放） ----------
   XOR 解码等价于编码，改成自己的账号时把 user/secret 用同法编码即可。 */
const _K = [90, 60, 145, 39];
const _u = (h) => {
  let s = '';
  for (let i = 0; i < h.length; i += 2) {
    s += String.fromCharCode(parseInt(h.substr(i, 2), 16) ^ _K[(i >> 1) & 3]);
  }
  return s;
};
const ENDPOINT = 'https://tinywebdb.appinventor.space/api';
const USER = _u('3e5dff46334bf0');
const SECRET = _u('6c5aa4156f0da944');

const PREFIX = 'nwj_';          // 换前缀 = 另开一张榜
const NAME_KEY = 'naiwa.name';
const DEFAULT_NAME = '默认用户';
const MIN_GAP = 3000;           // 两次提交至少间隔
const MAX_SCORE = 99999999;     // 明显离谱的分数不收
const WINDOW_SIZE = 20;         // 只展示最近 20 次提交
const COUNT = 100;              // 一次多取一些，够覆盖时间窗

/* ---------- 小工具 ---------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* 昵称清洗：去控制字符/首尾空白，按码点限长 12，空串回落默认名 */
function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const cp = Array.from(s);
  if (cp.length > 12) s = cp.slice(0, 12).join('');
  return s || DEFAULT_NAME;
}

/* 该不该提交：0 分不上榜、离谱分数不收、两次提交限流 */
function shouldSubmit(score, lastAt, now) {
  if (!Number.isFinite(score) || score <= 0) return false;
  if (score > MAX_SCORE) return false;
  if (lastAt && now - lastAt < MIN_GAP) return false;
  return true;
}

/* 注意：tag 参数并不能真正按前缀过滤（返回里混着别的游戏的记录），
   所以必须在这里按 PREFIX 过滤一次。 */
function parsePage(text) {
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = [];
  for (const tag in obj) {
    if (tag.indexOf(PREFIX) !== 0) continue;
    let v = obj[tag];
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { continue; } }
    if (!v || typeof v !== 'object') continue;
    const s = Number(v.s);
    if (!Number.isFinite(s)) continue;
    out.push({ n: sanitizeName(v.n), s: s, t: Number(v.t) || 0 });
  }
  return out;
}

/* 取最近 WINDOW_SIZE 条（按提交时间），再按分数排序展示 */
function rankWindow(records) {
  const byTime = records.slice().sort((a, b) => b.t - a.t).slice(0, WINDOW_SIZE);
  return byTime.sort((a, b) => b.s - a.s || a.t - b.t);
}

function storedName() {
  try { return sanitizeName(localStorage.getItem(NAME_KEY)); } catch (e) { return DEFAULT_NAME; }
}
function storeName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch (e) {}
}

/* ---------- 网络 ---------- */
const RETRY = 4;                                       // 单次读取内部最多重试 4 次（共 5 次请求）
const RETRY_TIMES = 5;                                 // 榜单开着时最多再多轮询 5 次
const delay = (n) => new Promise((r) => setTimeout(r, 250 * (n + 1)));   // 退避：250/500/750/1000

/* 单次请求。
   坑：服务端出错时可能**不带 CORS 头**，浏览器会直接抛 TypeError: Failed to fetch，
   看起来像断网，其实只是这一发失败了 —— 所以重试策略必须放在调用方。 */
function postOnce(params) {
  const body = new URLSearchParams();
  body.set('user', USER);
  body.set('secret', SECRET);
  for (const k in params) body.set(k, params[k]);
  return fetch(ENDPOINT, { method: 'POST', body: body }).then((res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  });
}

/* 读榜单：空结果和网络错误都重试 —— 服务端两种抽风都会犯。
   同一个请求会时而返回整页、时而返回空对象（100/0/100/0 交替），
   所以空结果不能当成「榜是空的」。 */
function fetchBoard(attempt) {
  attempt = attempt || 0;
  return postOnce({ action: 'search', tag: PREFIX, no: 1, count: COUNT, type: 'both' })
    .then((text) => {
      const recs = parsePage(text);
      if (recs === null) throw new Error('返回的不是 JSON');
      if (recs.length === 0 && attempt < RETRY) {
        return delay(attempt).then(() => fetchBoard(attempt + 1));
      }
      return rankWindow(recs);
    })
    .catch((err) => {
      if (attempt < RETRY) return delay(attempt).then(() => fetchBoard(attempt + 1));
      throw err;
    });
}

/* 写榜单：失败也重试，但别让玩家等太久 */
function postRety(params, attempt) {
  attempt = attempt || 0;
  return postOnce(params).catch((err) => {
    if (attempt < RETRY) return delay(attempt).then(() => postRety(params, attempt + 1));
    throw err;
  });
}

/* ---------- 界面 ---------- */
let lastSubmitAt = 0;
let busy = false;
let retryLeft = 0;
let retryTimer = null;

function isOpen() {
  const el = $('boardScreen');
  return !!el && el.classList.contains('show');
}

function setStatus(msg, kind) {
  const el = $('boardStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'board-status' + (kind ? ' ' + kind : '');
}

function renderList(records, me) {
  const list = $('boardList');
  if (!list) return;
  list.innerHTML = '';
  if (!records.length) {
    setStatus('榜单还是空的，快去跳一把抢第一！');
    return;
  }
  const mine = storedName();
  records.forEach((r, i) => {
    const li = document.createElement('li');
    if (r.n === mine) li.className = 'me';

    const rk = document.createElement('span');
    rk.className = 'rk';
    rk.textContent = i + 1;

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = r.n;              // textContent —— 不拼 HTML，防 XSS

    const sc = document.createElement('span');
    sc.className = 'sc';
    sc.textContent = r.s;

    li.appendChild(rk); li.appendChild(nm); li.appendChild(sc);
    list.appendChild(li);
  });
  const idx = records.findIndex((r) => r.n === mine);
  setStatus('最近 ' + records.length + ' 次提交' + (idx >= 0 ? '｜你当前第 ' + (idx + 1) + ' 名' : ''));
}

/* 网络不可用时退回本机记录，保证离线也有东西看 */
function renderFallback(reason) {
  const list = $('boardList');
  if (!list) return;
  list.innerHTML = '';
  let board = [];
  try { board = (JSON.parse(localStorage.getItem('naiwa.jump.v1') || '{}').board) || []; } catch (e) {}
  if (!board.length) {
    setStatus(reason + '，本机也还没有成绩');
    return;
  }
  board.slice(0, 10).forEach((r, i) => {
    const li = document.createElement('li');
    const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = i + 1;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = '本机记录';
    const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = r.score;
    li.appendChild(rk); li.appendChild(nm); li.appendChild(sc);
    list.appendChild(li);
  });
  setStatus(reason + '，下面是本机记录');
}

/* 这个接口的脾气：能连着返回好几页正常数据，也能连着几秒吐 HTML/空对象。
   所以失败不当成终局 —— 只要榜单还开着就继续退避重试，好了自动刷新出来。 */
function refresh(keepRetrying) {
  if (busy) return;
  if (keepRetrying !== false) retryLeft = RETRY_TIMES;
  busy = true;
  const list = $('boardList');
  if (list) list.innerHTML = '';       // 先清空，别让上一次的内容留在那儿
  setStatus('正在读取排行榜…');
  fetchBoard()
    .then((recs) => {
      retryLeft = 0;
      renderList(recs);
    })
    .catch(() => {
      renderFallback('连不上排行榜');
      if (retryLeft > 0 && isOpen()) {
        retryLeft--;
        setStatus('连不上排行榜，正在重试…');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => refresh(false), 4000);
      }
    })
    .then(() => { busy = false; });
}

function open() {
  const input = $('nickInput');
  if (input) {
    input.value = storedName() === DEFAULT_NAME ? '' : storedName();
    input.placeholder = DEFAULT_NAME;
  }
  refresh();
}

/* 结算后自动上榜；失败只提示，不影响游戏 */
function submit(score, combo) {
  const now = Date.now();
  if (!shouldSubmit(score, lastSubmitAt, now)) return Promise.resolve(false);
  lastSubmitAt = now;
  const name = storedName();
  const tag = PREFIX + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const value = JSON.stringify({ n: name, s: score, t: now });
  return postRety({ action: 'update', tag: tag, value: value })
    .then(() => true)
    .catch(() => false);
}

/* ---------- 绑定 ---------- */
function bind() {
  const input = $('nickInput');
  if (input) {
    const save = () => {
      const n = sanitizeName(input.value);
      storeName(n);
      input.value = n === DEFAULT_NAME ? '' : n;
      input.placeholder = DEFAULT_NAME;
    };
    input.addEventListener('change', save);
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(); input.blur(); } });
    // 打字时别让游戏抢按键
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('keyup', (e) => e.stopPropagation());
  }
  const rf = $('btnBoardRefresh');
  if (rf) rf.addEventListener('click', () => refresh());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
else bind();

window.NaiwaBoard = {
  open: open,
  refresh: refresh,
  submit: submit,
  nickname: storedName,
  setNickname: (n) => { const v = sanitizeName(n); storeName(v); return v; },
  /* 供 node 端测试 */
  __internals: {
    sanitizeName: sanitizeName,
    shouldSubmit: shouldSubmit,
    parsePage: parsePage,
    rankWindow: rankWindow,
    PREFIX: PREFIX,
    WINDOW_SIZE: WINDOW_SIZE
  }
};
})();
