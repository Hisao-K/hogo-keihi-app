// 保護活動経費アプリ（PWA）。全利用者で共通の画面。
// データの出し入れはすべて、各団体・個人の GAS（Api.js）に任せる。データはこの端末にもこのサイトにも保存しない。
// 端末に覚えるのは、接続先（GAS の URL）だけ。ログインのトークンは画面のメモリにだけ置く（ブラウザの保存領域には入れない）。
// 外から来た文字（猫の名前・日記・支払先・メンバーの名前・読み取りの結果など）は、必ず esc() を通してから画面に入れる。
(function () {
  'use strict';

  const CONFIG = window.HOGO_CONFIG || {};
  const API_URL_STORE = 'hogo.api';
  const GAS_URL_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/;
  const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const DEV_TOKEN = IS_LOCAL ? CONFIG.devIdToken || '' : '';
  const PHOTO_MAX_SIDE = 1600;
  const PHOTO_MAX_B64 = Math.floor(2 * 1024 * 1024 * 4 / 3);
  const DIARY_PHOTOS = 3;

  /* ===== 状態 ===== */
  let S = freshState();
  const auth = { apiUrl: '', idToken: '', waiters: [], session: 0, googleReady: false, promptSession: -1 };

  function freshState() {
    return {
      data: null,
      tab: 'cats',
      catId: null,          // 保護猫の詳細を開いているとき
      diaryCat: null,       // 成長日記を開いているとき
      diary: [],
      catFilter: '保護中',
      listF: { cat: '', month: '', category: '', q: '' },
      repF: null,
      add: null,            // 経費登録の作業状態
      dform: null,          // 日記の入力中の状態
      photoCache: {},       // 日記の写真（このログインの間だけ。閉じると消す）
      blobUrls: [],
    };
  }

  /* ===== 小道具 ===== */
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = n => (Number(n) || 0).toLocaleString('ja-JP') + '円';
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const toInt = s => { const n = parseInt(String(s).replace(/[^\d\-]/g, ''), 10); return isNaN(n) ? 0 : n; };
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const isImageDataUrl = u => /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(String(u || ''));

  function storageGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 保存できなくても動かす */ } }

  function blobUrl(blob) {
    const u = URL.createObjectURL(blob);
    S.blobUrls.push(u);
    return u;
  }

  function dataUrlToFile(dataUrl, name) {
    const [head, b64] = dataUrl.split(',');
    const type = head.match(/^data:([^;]+)/)[1];
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type });
  }

  function toast(msg, ms) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 2600);
  }
  function busy(msg) {
    $('#modal').innerHTML = `<div class="overlay"><div class="box" style="text-align:center"><div class="spin"></div><p>${esc(msg || '処理中…')}</p></div></div>`;
  }
  function closeModal() { $('#modal').innerHTML = ''; }
  function ask(msg, okLabel, danger) {
    return new Promise(resolve => {
      const el = $('#dialog');
      el.innerHTML = `<div class="overlay" style="z-index:25"><div class="box">
        <p style="margin-top:0;white-space:pre-wrap">${esc(msg)}</p>
        <div class="row"><span class="grow"></span><button class="btn" type="button" id="dNo">戻る</button><button class="btn ${danger ? 'danger' : 'primary'}" type="button" id="dYes">${esc(okLabel || 'OK')}</button></div>
      </div></div>`;
      const done = v => { el.innerHTML = ''; resolve(v); };
      $('#dNo').onclick = () => done(false);
      $('#dYes').onclick = () => done(true);
    });
  }
  function showImage(src) {
    if (!isImageDataUrl(src)) return;
    const el = $('#dialog');
    el.innerHTML = `<div class="overlay" style="z-index:25"><div class="box"><img class="bigimg" alt="写真" src="${esc(src)}">
      <button class="btn block" type="button" id="imgClose" style="margin-top:10px">閉じる</button></div></div>`;
    $('#imgClose').onclick = () => { el.innerHTML = ''; };
  }

  function view(name) {
    $('#view-setup').hidden = name !== 'setup';
    $('#view-login').hidden = name !== 'login';
    $('#app').hidden = name !== 'app';
    $('#tabs').hidden = name !== 'app';
    $('#setBtn').hidden = name !== 'app';
    window.scrollTo(0, 0);
  }
  function msg(id, text, kind) {
    const p = $('#' + id);
    p.textContent = text || '';
    p.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /* ===== 接続先（この団体・個人の GAS の URL） ===== */
  function validApiUrl(u) {
    if (IS_LOCAL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u)) return true;
    return GAS_URL_RE.test(u);
  }
  function apiId(u) {
    const m = String(u || '').match(/\/s\/([A-Za-z0-9_-]+)\/exec$/);
    return m ? m[1] : '';
  }
  function apiLabel(u) { const id = apiId(u); return id ? '…' + id.slice(-8) : u; }

  /**
   * リンクの ?api= は、確認して OK のときだけ使う（初めての端末でも、別の接続先に変わるときも）。
   * 知らない人から届いたリンクで接続先を書き換えられ、ログインや写真をその人の GAS に送ってしまうのを防ぐ。
   */
  function loadApiUrl() {
    const params = new URLSearchParams(location.search);
    const fromLink = params.get('api');
    let saved = storageGet(API_URL_STORE);
    if (fromLink && validApiUrl(fromLink) && fromLink !== saved) {
      const q = validApiUrl(saved)
        ? '接続先（データの置き場）を切り替えますか？\n\n今の接続先: ' + apiLabel(saved) + '\n新しい接続先: ' + apiLabel(fromLink)
        : 'このリンクの接続先（データの置き場）を使いますか？\n\n接続先: ' + apiLabel(fromLink);
      if (confirm(q + '\n\n自分で公開したアプリの「アプリを開く」、または代表者から受け取ったリンクのときだけ「OK」を押してください。心当たりがなければ「キャンセル」を押してください。')) {
        storageSet(API_URL_STORE, fromLink);
        saved = fromLink;
      }
    }
    if (fromLink) {
      params.delete('api');
      try { history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash); } catch (e) { /* 消せなくても動かす */ }
    }
    setApiUrl(validApiUrl(saved) ? saved : '');
  }

  function setApiUrl(u) {
    if (u !== auth.apiUrl) {
      auth.session++;
      auth.idToken = '';
      auth.googleReady = false;
    }
    auth.apiUrl = u;
    $('#login-api').textContent = u ? '接続先: ' + apiLabel(u) : '';
  }

  $('#setup-save').onclick = () => {
    const u = $('#setup-url').value.trim();
    if (!validApiUrl(u)) { msg('setup-msg', 'URL の形が違います。https://script.google.com/macros/s/…/exec の形の URL を貼り付けてください。', 'err'); return; }
    storageSet(API_URL_STORE, u);
    setApiUrl(u);
    start();
  };

  /* ===== ログイン（Google） ===== */
  function decodeJwt(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(part).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  /** ログインのトークンに入れる nonce。「今の接続先の ID.乱数」（GAS の Auth.verifyToken が完全一致で確かめる） */
  function loginNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return apiId(auth.apiUrl) + '.' + Array.prototype.map.call(bytes, b => ('0' + b.toString(16)).slice(-2)).join('');
  }

  /** 期限まで1分以上あり、今の接続先あてのトークンか */
  function tokenValid(token) {
    if (DEV_TOKEN && token === DEV_TOKEN) return true;
    const p = token && decodeJwt(token);
    return !!(p && p.exp * 1000 - Date.now() > 60 * 1000 && String(p.nonce || '').split('.')[0] === apiId(auth.apiUrl));
  }

  /** 自動のログイン（One Tap）を出す。出したときのログインの回を覚える */
  function promptLogin() {
    auth.promptSession = auth.session;
    try { google.accounts.id.prompt(); } catch (e) { /* ボタンで入れる */ }
  }

  function onCredential(res) {
    if (!tokenValid(res.credential)) { msg('login-msg', 'ログインをやり直してください（接続先が変わったため）。', 'err'); return; }
    // ボタンを押したログインは受け付ける。自動のログインは、いまの回に出したものだけ受け付ける（ログアウト前に出した分は捨てる）
    const byButton = /^btn/.test(String(res.select_by || ''));
    if (!byButton && auth.promptSession !== auth.session) return;
    auth.idToken = res.credential;
    const waiters = auth.waiters.splice(0);
    waiters.forEach(w => w(auth.idToken));
    if (!$('#view-login').hidden) boot();
  }

  function initGoogle() {
    if (DEV_TOKEN) return true;
    if (!CONFIG.googleClientId) { msg('login-msg', 'アプリの設定が終わっていません（ログイン用のクライアントIDが未設定）。導入を手伝った人にお知らせください。', 'err'); return false; }
    if (!(window.google && google.accounts && google.accounts.id)) return false;
    google.accounts.id.initialize({
      client_id: CONFIG.googleClientId, nonce: loginNonce(), callback: onCredential,
      auto_select: true, itp_support: true, use_fedcm_for_prompt: true,
    });
    google.accounts.id.renderButton($('#gsi-button'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' });
    auth.googleReady = true;
    return true;
  }

  /** 有効なトークンを返す。切れていれば自動のログインを試し、だめならログイン画面に戻す */
  function freshToken() {
    if (DEV_TOKEN) return Promise.resolve(DEV_TOKEN);
    if (tokenValid(auth.idToken)) return Promise.resolve(auth.idToken);
    return new Promise((resolve, reject) => {
      let done = false;
      auth.waiters.push(t => { done = true; resolve(t); });
      promptLogin();
      setTimeout(() => {
        if (done) return;
        auth.waiters.splice(0);
        endSession('ログインの有効期限が切れました。もう一度ログインしてください。', 'err');
        reject(new Error('ログインが必要です'));
      }, 6000);
    });
  }

  /** 「閉じる」＝ログアウト。ホーム画面のアプリは自分では閉じられないため、ログインを解除して画面のデータを消す */
  async function logout() {
    if (!await ask('ログアウトして閉じますか？\n次に開いたときは、ログインからになります。', 'ログアウト')) return;
    endSession('ログアウトしました。アプリを閉じるときは、スマホの操作で閉じてください。', 'ok');
  }
  $('#logout').onclick = logout;

  /**
   * ログインを終える（ログアウト・ログイン切れ・登録されていない）。トークン・画面のデータ・入力・選んだファイル・写真・
   * 投稿文・PDF を消す。session を増やすので、終える前に出した要求の結果は画面に出さない。
   */
  function endSession(text, kind) {
    auth.session++;
    auth.idToken = '';
    auth.waiters.splice(0);
    // 自動のログインを止める（次に開いたときは、ボタンで選び直してもらう）
    try { google.accounts.id.cancel(); google.accounts.id.disableAutoSelect(); } catch (e) { /* 未読み込みなら何もしない */ }
    S.blobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { /* 消えていれば何もしない */ } });
    S = freshState();
    $('#app').innerHTML = '';
    $('#modal').innerHTML = '';
    $('#dialog').innerHTML = '';
    $('#me').textContent = '';
    $('#logout').hidden = true;
    view(auth.apiUrl ? 'login' : 'setup');
    msg('login-msg', text, kind);
  }

  /* ===== GAS とのやり取り ===== */
  const never = () => new Promise(() => {});   // 終えたログインの応答は捨てる（画面に出さない）

  /** @returns {Promise<Object>} GAS の応答（ok:false でも返す） */
  function api(action, params) {
    const session = auth.session;
    return freshToken().then(idToken => {
      if (session !== auth.session) return never();
      return fetch(auth.apiUrl, {
        method: 'POST',
        // text/plain にすると事前確認（プリフライト）が出ず、GAS がそのまま受け取れる
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({}, params || {}, { action, idToken })),
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
      }).catch(() => {
        throw new Error(navigator.onLine === false ? '電波がありません。つながる場所でもう一度お試しください。' : '通信できませんでした。電波のよい場所でもう一度お試しください。');
      }).then(res => res.json().catch(() => { throw new Error('応答を読めませんでした（HTTP ' + res.status + '）。'); }))
        .then(json => {
          if (session !== auth.session) return never();
          if (!json.ok && json.code === 'AUTH') {
            endSession(json.message, 'err');
            return never();
          }
          return json;
        }, e => {
          if (session !== auth.session) return never();
          throw e;
        });
    }, e => {
      if (session !== auth.session) return never();
      throw e;
    });
  }

  /** 成功なら data を返し、失敗なら message の Error を投げる */
  async function call(action, params) {
    const json = await api(action, params);
    if (!json.ok) throw new Error(json.message || '失敗しました。');
    return json.data;
  }
  function errText(e) { return (e && e.message) || String(e); }

  async function reload() { S.data = await call('init'); }

  const role = () => (S.data && S.data.me.role) || 'member';
  const isOwner = () => role() === 'owner';
  const isStaff = () => role() === 'owner' || role() === 'assistant';

  /* ===== 共通の部品 ===== */
  function catName(id) {
    if (!S.data) return '';
    if (id === S.data.common.id) return S.data.common.name;
    const c = S.data.cats.find(c => c.id === id);
    return c ? c.name : '（不明）';
  }
  function sortedCats() {
    const order = s => (s === '保護中' ? 0 : 1);
    return S.data.cats.slice().sort((a, b) => order(a.status) - order(b.status) || a.name.localeCompare(b.name, 'ja'));
  }
  function catOptions(selected, opt) {
    opt = opt || {};
    let h = opt.placeholder ? `<option value="">${esc(opt.placeholder)}</option>` : '';
    sortedCats().forEach(c => {
      const label = c.status === '保護中' ? c.name : `${c.name}（${c.status}）`;
      h += `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(label)}</option>`;
    });
    h += `<option value="${esc(S.data.common.id)}"${selected === S.data.common.id ? ' selected' : ''}>${esc(S.data.common.name)}</option>`;
    return h;
  }
  function categoryOptions(selected, placeholder) {
    let h = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
    S.data.categories.forEach(c => { h += `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`; });
    return h;
  }
  function expensesOf(catId) { return S.data.expenses.filter(e => e.catId === catId); }
  function byDateDesc(a, b) { return b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt); }

  /** 写真を長い辺 max px の JPEG に作り直す（画素から新しく作るので、撮った場所などの情報は入らない） */
  function resizeImage(file, max) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const out = c.toDataURL('image/jpeg', 0.85);
        // JPEG に作り直せなかったときは、元の写真を使わずに止める
        if (!/^data:image\/jpeg;base64,/.test(out)) { reject(new Error('写真を作り直せませんでした。別の写真を選んでください。')); return; }
        if (out.length - out.indexOf(',') - 1 > PHOTO_MAX_B64) { reject(new Error('写真が大きすぎます。')); return; }
        resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('この写真は開けませんでした。JPEG か PNG の写真を選んでください。')); };
      img.src = url;
    });
  }

  /* ===== 起動 ===== */
  async function boot() {
    view('app');
    busy('読み込み中…');
    try {
      await reload();
      closeModal();
      $('#me').textContent = S.data.me.name || S.data.me.email;
      $('#logout').hidden = false;
      render();
    } catch (e) {
      closeModal();
      $('#tabs').hidden = true;
      $('#app').innerHTML = `<div class="panel" style="margin-top:24px">
        <h2 style="margin-top:0">開けませんでした</h2>
        <p class="err">${esc(errText(e))}</p>
        <button class="btn primary block" type="button" id="retry">もう一度開く</button>
      </div>`;
      $('#retry').onclick = boot;
    }
  }

  function start() {
    loadApiUrl();
    if (!auth.apiUrl) { view('setup'); return; }
    view('login');
    if (DEV_TOKEN) { auth.idToken = DEV_TOKEN; boot(); return; }
    let tries = 0;
    (function waitGoogle() {
      if (initGoogle()) { promptLogin(); return; }
      if (!CONFIG.googleClientId) return;
      if (++tries > 50) { msg('login-msg', 'Google のログイン部品を読み込めませんでした。電波を確かめて、アプリを開き直してください。', 'err'); return; }
      setTimeout(waitGoogle, 200);
    })();
  }

  $('#setBtn').onclick = () => openSettings();

  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.onclick = () => { S.tab = b.dataset.tab; S.catId = null; S.diaryCat = null; if (S.tab === 'add') S.add = null; render(); window.scrollTo(0, 0); };
  });

  function render() {
    if (!S.data) return;
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
    if (S.tab === 'cats') return S.diaryCat ? renderDiary() : S.catId ? renderCatDetail() : renderCats();
    if (S.tab === 'add') return renderAdd();
    if (S.tab === 'list') return renderList();
    if (S.tab === 'report') return renderReport();
  }

  /* ===== 設定 ===== */
  function openSettings(errMsg) {
    const d = S.data;
    if (!d) return;
    const me = d.me;
    $('#modal').innerHTML = `<div class="overlay"><div class="box">
      <h3 style="margin-top:0">設定</h3>
      <p class="small" style="margin:0">${esc(me.name || '')}（${esc(me.email)}）　役割：${esc(me.roleLabel)}</p>

      ${isStaff() ? `
      <label class="f" for="sName">帳票に出す名前（団体名や氏名。空でもかまいません）</label>
      <input type="text" id="sName" maxlength="60" value="${esc(d.ownerName)}">
      <label class="f" for="sCats">費目（1行に1つ）</label>
      <textarea id="sCats" style="min-height:170px">${esc(d.categories.join('\n'))}</textarea>
      <label class="f" for="sTags">Instagram の投稿に付けるハッシュタグ</label>
      <input type="text" id="sTags" maxlength="300" value="${esc(d.hashtags)}">
      <button class="btn primary block" type="button" id="sSave" style="margin-top:10px">名前・費目・ハッシュタグを保存する</button>` : ''}

      <h3>領収書の読み取り</h3>
      <p class="small" style="margin:0 0 6px">${d.geminiReady
        ? 'いまは Gemini で読み取っています（日付・支払先・合計・品目）。キーは代表者が登録したものを使います。'
        : 'いまはドライブの文字読み取りで読み取っています（日付・支払先・合計）。代表者が Gemini のキーを登録すると、品目と費目まで読み取れます。'}</p>
      <p class="muted small">Gemini での読み取りは、アプリ全体で1日 ${esc(d.geminiLimit)} 回までです。超えた日はドライブの文字読み取りに切り替わります。無料枠のキーでは、送った写真が Google のサービス改善に使われ、人が読むことがあります。</p>
      ${isOwner() ? `
      <label class="f" for="sKey">Gemini の API キー${d.geminiReady ? '（登録済み。変えるときだけ貼る）' : ''}</label>
      <input type="password" id="sKey" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="コピーしたキーを貼る">
      <div class="row" style="margin-top:8px">
        <button class="btn primary grow" type="button" id="sKeySave">キーを登録する</button>
        ${d.geminiReady ? '<button class="btn danger grow" type="button" id="sKeyDel">キーを消す</button>' : ''}
      </div>
      <p class="muted small">キーは <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> で、このアプリを公開したアカウントで作ってください。キーはこのアプリの中だけに保存され、画面には出ません。</p>` : ''}

      ${isStaff() ? `<h3>メンバー</h3>
      <button class="btn block" type="button" id="sMembers">メンバーを見る・追加する</button>` : ''}

      <h3>データ</h3>
      ${isOwner() && d.sheetUrl ? `<a class="btn block" href="${esc(d.sheetUrl)}" target="_blank" rel="noopener">データのスプレッドシートを開く</a>
      <a class="btn block" style="margin-top:8px" href="${esc(d.folderUrl)}" target="_blank" rel="noopener">写真のフォルダを開く</a>` : ''}
      ${isStaff() ? `<button class="btn block" type="button" id="sExport" style="margin-top:8px">バックアップを書き出す</button>` : ''}
      ${isOwner() ? `<label class="btn block" for="sImport" style="margin-top:8px">バックアップを読み込む（新しい版に移るとき）</label>
      <input type="file" id="sImport" accept=".json,application/json" class="vh">` : ''}
      ${isStaff() ? '' : '<p class="muted small">名前・費目・メンバー・バックアップは、代表者と補佐が設定します。</p>'}
      <div id="sOut"></div>
      <p class="err" id="sErr">${esc(errMsg || '')}</p>
      <p class="muted small">アプリの版：${esc(d.version)}　接続先：${esc(apiLabel(auth.apiUrl))}</p>
      <button class="btn block" type="button" id="sClose">閉じる</button>
    </div></div>`;

    $('#sClose').onclick = () => { closeModal(); render(); };
    if ($('#sSave')) $('#sSave').onclick = async () => {
      const settings = { ownerName: $('#sName').value, categories: $('#sCats').value, hashtags: $('#sTags').value };
      busy('保存中…');
      try { await call('saveSettings', { settings }); await reload(); openSettings(); toast('保存しました'); }
      catch (e) { openSettings(errText(e)); }
    };
    if ($('#sKeySave')) $('#sKeySave').onclick = async () => {
      const key = $('#sKey').value.trim();
      if (!key) { $('#sErr').textContent = 'キーを貼ってください。'; return; }
      busy('キーを確かめています…');
      try { await call('setGeminiKey', { key }); await reload(); openSettings(); toast('キーを登録しました'); }
      catch (e) { openSettings(errText(e)); }
    };
    if ($('#sKeyDel')) $('#sKeyDel').onclick = async () => {
      if (!await ask('Gemini のキーを消しますか？\n消すと、ドライブの文字読み取りに戻ります。', '消す', true)) return;
      busy('消しています…');
      try { await call('setGeminiKey', { key: '' }); await reload(); openSettings(); toast('キーを消しました'); }
      catch (e) { openSettings(errText(e)); }
    };
    if ($('#sMembers')) $('#sMembers').onclick = () => openMembers();
    if ($('#sExport')) $('#sExport').onclick = async () => {
      busy('書き出し中…');
      try {
        const text = await call('exportData');
        openSettings();
        const t = today().replace(/-/g, '');
        const url = blobUrl(new Blob([text], { type: 'application/json' }));
        $('#sOut').innerHTML = `<a class="btn primary block" style="margin-top:8px" href="${esc(url)}" download="保護活動経費_バックアップ_${t}.json">バックアップを保存する</a>
          <p class="muted small">保存したファイルは、新しい版のアプリの「バックアップを読み込む」で使います。写真はドライブに残るので、ファイルには入りません。メンバーも入りません（新しい版で登録し直してください）。</p>`;
      } catch (e) { openSettings(errText(e)); }
    };
    if ($('#sImport')) $('#sImport').onchange = async ev => {
      const f = ev.target.files[0];
      if (!f) return;
      const session = auth.session;
      const text = await f.text();
      if (session !== auth.session) return;
      if (!await ask('バックアップを読み込みますか？\n（データが空のアプリにだけ読み込めます）', '読み込む')) return;
      busy('読み込み中…');
      try {
        const r = await call('importData', { text });
        await reload(); openSettings(); toast(`猫${r.cats}件・経費${r.expenses}件・日記${r.diary}件を読み込みました`, 4000);
      } catch (e) { openSettings(errText(e)); }
    };
  }

  /* ===== メンバー（代表者・補佐） ===== */
  async function openMembers(errMsg, okMsg) {
    busy('読み込み中…');
    let r;
    try { r = await call('listMembers'); } catch (e) { openSettings(errText(e)); return; }
    const active = r.members.filter(m => !m.removedAt);
    const removed = r.members.filter(m => m.removedAt);
    const canRemove = m => isOwner() || (m.role === 'member' && m.email.toLowerCase() !== S.data.me.email.toLowerCase());
    $('#modal').innerHTML = `<div class="overlay"><div class="box">
      <h3 style="margin-top:0">メンバー</h3>
      <p class="muted small" style="margin:0">登録した Google アカウントだけがログインできます。登録した人は、猫・経費・日記をすべて見られます。</p>
      <div class="members" style="margin:10px 0">
        <div class="m"><div class="grow"><strong>代表者</strong><div class="muted small">${esc(r.owner)}</div></div></div>
        ${active.map(m => `<div class="m">
          <div class="grow"><strong>${esc(m.name || '（名前なし）')}</strong>　<span class="badge">${esc(m.roleLabel)}</span>${m.loggedIn ? '' : '　<span class="badge">まだログインしていません</span>'}
            <div class="muted small">${esc(m.email)}</div></div>
          ${canRemove(m) ? `<button class="btn danger" type="button" data-rm="${esc(m.row)}">外す</button>` : ''}
        </div>`).join('')}
      </div>
      ${removed.length ? `<p class="muted small">外した人：${removed.length}人（記録はスプレッドシートの「メンバー」シートに残ります）</p>` : ''}
      <h3>追加する</h3>
      <label class="f" for="mEmail">Google アカウントのメールアドレス</label>
      <input type="email" id="mEmail" autocomplete="off" autocapitalize="off" spellcheck="false">
      <label class="f" for="mName">名前（一覧と帳票の登録者に出ます）</label>
      <input type="text" id="mName" maxlength="60">
      ${isOwner() ? `<label class="f" for="mRole">役割</label>
      <select id="mRole"><option value="member">メンバー（猫・経費・日記の登録と帳票）</option><option value="assistant">補佐（メンバーにできることに加え、メンバーの追加・外す、名前・費目の変更、バックアップの書き出し）</option></select>` : ''}
      <button class="btn primary block" type="button" id="mAdd" style="margin-top:10px">追加する</button>
      <p class="msg ${errMsg ? 'err' : 'ok'}" id="mMsg">${esc(errMsg || okMsg || '')}</p>
      <div class="note small">追加した人には、次の URL を送ってください。開いて「アプリを開く」を押し、ホーム画面に追加してから、登録したアカウントでログインしてもらいます。
        <input type="text" id="mUrl" readonly value="${esc(auth.apiUrl)}" style="margin-top:6px">
        <button class="btn block" type="button" id="mCopy" style="margin-top:6px">URL をコピーする</button></div>
      <button class="btn block" type="button" id="mBack" style="margin-top:8px">設定に戻る</button>
    </div></div>`;
    $('#mBack').onclick = () => openSettings();
    $('#mCopy').onclick = () => copyText(auth.apiUrl, $('#mUrl')).then(ok => toast(ok ? 'コピーしました' : 'コピーできませんでした。長押しでコピーしてください'));
    $('#mAdd').onclick = async () => {
      const body = { email: $('#mEmail').value.trim(), name: $('#mName').value.trim(), role: $('#mRole') ? $('#mRole').value : 'member' };
      if (!body.email) { $('#mMsg').textContent = 'メールアドレスを入れてください。'; return; }
      busy('追加しています…');
      try { await call('addMember', body); openMembers('', `${body.email} を追加しました。`); }
      catch (e) { openMembers(errText(e)); }
    };
    document.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
      const m = active.find(x => String(x.row) === b.dataset.rm);
      if (!m || !await ask(`${m.name || m.email}（${m.email}）を外しますか？\n外すと、次の操作から使えなくなります。登録した経費・日記は消えません。`, '外す', true)) return;
      busy('外しています…');
      try { await call('removeMember', { row: m.row, email: m.email }); openMembers('', `${m.email} を外しました。`); }
      catch (e) { openMembers(errText(e)); }
    });
  }

  function copyText(text, inputEl) {
    const fallback = () => {
      try {
        if (!inputEl) return false;
        inputEl.focus(); inputEl.select();
        return document.execCommand('copy');
      } catch (e) { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallback());
    return Promise.resolve(fallback());
  }

  /* ===== 保護猫 ===== */
  function renderCats() {
    const d = S.data;
    const ym = today().slice(0, 7);
    const active = d.cats.filter(c => c.status === '保護中').length;
    const month = sum(d.expenses.filter(e => e.date.slice(0, 7) === ym), e => e.amount);
    const yr = sum(d.expenses.filter(e => e.date.slice(0, 4) === ym.slice(0, 4)), e => e.amount);
    const filters = ['保護中', 'すべて'].concat(d.statuses.filter(s => s !== '保護中'));
    const cats = sortedCats().filter(c => S.catFilter === 'すべて' || c.status === S.catFilter);
    const card = (id, name, sub, badge) => {
      const ex = expensesOf(id);
      return `<button class="card" type="button" data-cat="${esc(id)}">
        <div class="row"><span class="name grow">${esc(name)}</span>${badge ? `<span class="badge s-${esc(badge)}">${esc(badge)}</span>` : ''}</div>
        <div class="muted small">${esc(sub)}</div>
        <div class="row" style="margin-top:6px"><span class="muted small grow">${ex.length}件</span><span class="num" style="font-weight:700">${yen(sum(ex, e => e.amount))}</span></div>
      </button>`;
    };
    $('#app').innerHTML = `
      <div class="stats">
        <div class="stat"><div class="k">保護中</div><div class="v">${active}頭</div></div>
        <div class="stat"><div class="k">今月の経費</div><div class="v num">${yen(month)}</div></div>
        <div class="stat"><div class="k">${ym.slice(0, 4)}年の経費</div><div class="v num">${yen(yr)}</div></div>
      </div>
      <div class="row"><h2 class="grow" style="margin:8px 0">保護猫</h2><button class="btn primary" type="button" id="newCat">＋ 猫を登録</button></div>
      <div class="chips">${filters.map(f => `<button type="button" class="chip${f === S.catFilter ? ' on' : ''}" data-f="${esc(f)}">${esc(f)}</button>`).join('')}</div>
      ${cats.length ? `<div class="cards">${cats.map(c => card(c.id, c.name, (c.rescuedOn ? `保護日 ${c.rescuedOn}` : '保護日 未入力') + (c.diaryCount ? `　📔${c.diaryCount}` : ''), c.status)).join('')}</div>`
        : `<div class="panel empty">${d.cats.length ? 'この状態の猫はいません。' : 'まだ猫が登録されていません。「＋ 猫を登録」から始めてください。'}</div>`}
      <h3>特定の猫に分けない経費</h3>
      <div class="cards">${card(d.common.id, d.common.name, 'フードのまとめ買いなど、全体で使ったもの', '')}</div>
    `;
    document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.catFilter = b.dataset.f; renderCats(); });
    document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { S.catId = b.dataset.cat; render(); window.scrollTo(0, 0); });
    $('#newCat').onclick = () => openCatForm(null);
  }

  function renderCatDetail() {
    const d = S.data;
    const isCommon = S.catId === d.common.id;
    const cat = isCommon ? null : d.cats.find(c => c.id === S.catId);
    if (!isCommon && !cat) { S.catId = null; return renderCats(); }
    const ex = expensesOf(S.catId).sort(byDateDesc);
    const byCat = Object.create(null);
    ex.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
    $('#app').innerHTML = `
      <p><button class="linkbtn" type="button" id="back">← 保護猫の一覧へ</button></p>
      <div class="panel">
        <div class="row"><h2 class="grow" style="margin:0">${esc(catName(S.catId))}</h2>${cat ? `<span class="badge s-${esc(cat.status)}">${esc(cat.status)}</span>` : ''}</div>
        ${cat ? `<p class="muted small" style="margin:6px 0">保護日 ${esc(cat.rescuedOn || '未入力')}</p>
          ${cat.memo ? `<p style="margin:6px 0;white-space:pre-wrap">${esc(cat.memo)}</p>` : ''}
          <div class="row"><button class="btn" type="button" id="editCat">猫の情報を直す</button>
          <button class="btn primary" type="button" id="toDiary">📔 成長日記${cat.diaryCount ? `（${cat.diaryCount}件）` : ''}</button></div>` : `<p class="muted small">特定の猫に分けない経費です。</p>`}
      </div>
      <div class="row">
        <button class="btn primary grow" type="button" id="addRc">📷 領収書から追加</button>
        <button class="btn grow" type="button" id="addMn">✏️ 手で追加</button>
      </div>
      <div class="panel">
        <div class="row"><strong class="grow">経費の合計</strong><span class="num" style="font-size:20px;font-weight:700">${yen(sum(ex, e => e.amount))}</span></div>
        ${Object.keys(byCat).length ? `<div style="margin-top:8px">${Object.keys(byCat).map(k => `<div class="sumline"><span class="muted">${esc(k)}</span><span class="num">${yen(byCat[k])}</span></div>`).join('')}</div>` : ''}
        <button class="btn block" type="button" id="toReport" style="margin-top:8px">📄 この猫の帳票を出す</button>
      </div>
      <h3>経費（${ex.length}件）</h3>
      ${expenseList(ex, false)}
    `;
    $('#back').onclick = () => { S.catId = null; render(); };
    if (cat) {
      $('#editCat').onclick = () => openCatForm(cat);
      $('#toDiary').onclick = () => openDiary(cat.id);
    }
    $('#addRc').onclick = () => { S.tab = 'add'; S.add = { mode: 'pick', presetCat: S.catId }; S.catId = null; render(); };
    $('#addMn').onclick = () => { S.tab = 'add'; S.add = { mode: 'manual', presetCat: S.catId }; S.catId = null; render(); };
    $('#toReport').onclick = () => { S.repF = Object.assign(defaultRepF(), { cat: S.catId, from: '', to: '' }); S.tab = 'report'; S.catId = null; render(); };
    bindExpenseList();
  }

  function openCatForm(cat) {
    const c = cat || { id: '', name: '', rescuedOn: today(), status: '保護中', memo: '' };
    $('#modal').innerHTML = `<div class="overlay"><div class="box">
      <h3 style="margin-top:0">${cat ? '猫の情報を直す' : '猫を登録'}</h3>
      <label class="f" for="cName">名前（仮名でも可）</label><input type="text" id="cName" maxlength="60" value="${esc(c.name)}">
      <div class="two">
        <div><label class="f" for="cDate">保護日</label><input type="date" id="cDate" value="${esc(c.rescuedOn)}"></div>
        <div><label class="f" for="cStat">状態</label><select id="cStat">${S.data.statuses.map(s => `<option value="${esc(s)}"${s === c.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      </div>
      <label class="f" for="cMemo">特徴・メモ（柄・性別・保護場所など）</label><textarea id="cMemo" maxlength="500">${esc(c.memo)}</textarea>
      <p class="err" id="cErr"></p>
      <div class="row"><button class="btn grow" type="button" id="cCancel">やめる</button><button class="btn primary grow" type="button" id="cSave">保存する</button></div>
      ${cat ? `<button class="btn danger block" type="button" id="cDel" style="margin-top:16px">この猫を削除</button>` : ''}
    </div></div>`;
    $('#cCancel').onclick = closeModal;
    if (cat) $('#cDel').onclick = async () => {
      const ex = expensesOf(cat.id);
      const m = `「${cat.name}」を削除しますか？` + (ex.length
        ? `\nこの猫の経費 ${ex.length}件（${yen(sum(ex, e => e.amount))}）も一緒に削除され、一覧と帳票に出なくなります。`
        : '') + (cat.diaryCount ? `\n成長日記（${cat.diaryCount}件）も見えなくなります。` : '');
      if (!await ask(m, '削除する', true)) return;
      busy('削除中…');
      try {
        await call('deleteCat', { catId: cat.id });
        await reload();
        closeModal();
        toast(`「${cat.name}」を削除しました`);
        S.catId = null; S.tab = 'cats';
        render(); window.scrollTo(0, 0);
      } catch (e) { openCatForm(cat); $('#cErr').textContent = errText(e); }
    };
    $('#cSave').onclick = async () => {
      const body = { id: c.id, name: $('#cName').value.trim(), rescuedOn: $('#cDate').value, status: $('#cStat').value, memo: $('#cMemo').value };
      if (!body.name) { $('#cErr').textContent = '名前を入れてください。'; return; }
      busy('保存中…');
      try {
        const id = await call('saveCat', { cat: body });
        await reload();
        closeModal();
        toast('保存しました');
        if (!cat) { S.catId = id; S.catFilter = body.status === '保護中' ? '保護中' : 'すべて'; }
        render();
      } catch (e) { openCatForm(cat); $('#cErr').textContent = errText(e); }
    };
  }

  /* ===== 成長日記 ===== */
  async function openDiary(catId) {
    S.diaryCat = catId;
    busy('日記を読み込み中…');
    try {
      S.diary = await call('listDiary', { catId });
      closeModal();
      render(); window.scrollTo(0, 0);
    } catch (e) { closeModal(); S.diaryCat = null; toast(errText(e), 4000); }
  }

  /** 日記の写真（このログインの間だけ覚える） */
  function loadPhoto(id) {
    if (!S.photoCache[id]) {
      S.photoCache[id] = call('diaryPhoto', { photoId: id }).then(r => {
        if (!isImageDataUrl(r.dataUrl)) throw new Error('この写真は開けませんでした。');
        return r.dataUrl;
      });
      S.photoCache[id].catch(() => { delete S.photoCache[id]; });
    }
    return S.photoCache[id];
  }

  function fillPhotos(root) {
    root.querySelectorAll('[data-ph]').forEach(btn => {
      const id = btn.dataset.ph;
      loadPhoto(id).then(src => {
        btn.innerHTML = `<img alt="写真" src="${esc(src)}">`;
        btn.onclick = () => showImage(src);
      }, () => { btn.textContent = '×'; btn.title = '写真を開けませんでした'; });
    });
  }

  function renderDiary() {
    const cat = S.data.cats.find(c => c.id === S.diaryCat);
    if (!cat) { S.diaryCat = null; return render(); }
    const list = S.diary;
    const weights = list.filter(e => e.weight !== '').slice().sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    const wRows = weights.map((e, i) => {
      const prev = i ? weights[i - 1].weight : null;
      const d = prev == null ? '' : e.weight - prev;
      return `<tr><td>${esc(e.date)}</td><td class="r num">${esc(e.weight)}g</td><td class="r num ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d === '' ? '' : (d > 0 ? '+' : '') + d + 'g'}</td></tr>`;
    }).reverse();
    $('#app').innerHTML = `
      <p><button class="linkbtn" type="button" id="back">← ${esc(cat.name)} の詳細へ</button></p>
      <div class="row"><h2 class="grow" style="margin:8px 0">📔 ${esc(cat.name)} の成長日記</h2><button class="btn primary" type="button" id="newDiary">＋ 日記を書く</button></div>
      ${wRows.length ? `<div class="panel"><strong>体重</strong>
        <table class="weights"><thead><tr><th>日付</th><th class="r">体重</th><th class="r">前回から</th></tr></thead><tbody>${wRows.join('')}</tbody></table></div>` : ''}
      ${list.length ? list.map(e => `<div class="diary">
        <div class="row"><strong class="grow">${esc(e.date)}</strong>${e.weight !== '' ? `<span class="badge">${esc(e.weight)}g</span>` : ''}</div>
        ${e.body ? `<div class="body">${esc(e.body)}</div>` : ''}
        ${e.photos.length ? `<div class="photos">${e.photos.map(p => `<button class="ph" type="button" data-ph="${esc(p)}"><span class="spin" style="width:20px;height:20px"></span></button>`).join('')}</div>` : ''}
        <div class="muted small">書いた人：${esc(e.author || '代表者')}${e.editedBy ? `　最後に直した人：${esc(e.editedBy)}` : ''}${e.sharedAt ? `　共有：${esc(e.sharedAt)}` : ''}</div>
        <div class="row" style="margin-top:8px"><button class="btn" type="button" data-edit="${esc(e.id)}">直す</button><button class="btn" type="button" data-ig="${esc(e.id)}">📷 Instagram に投稿</button></div>
      </div>`).join('') : '<div class="panel empty">まだ日記がありません。「＋ 日記を書く」から始めてください。</div>'}
    `;
    $('#back').onclick = () => { S.diaryCat = null; S.catId = cat.id; render(); };
    $('#newDiary').onclick = () => { S.dform = { id: '', catId: cat.id, date: today(), body: '', weight: '', photos: [] }; openDiaryForm(); };
    document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const e = list.find(x => x.id === b.dataset.edit);
      S.dform = { id: e.id, catId: e.catId, date: e.date, body: e.body, weight: e.weight === '' ? '' : String(e.weight), photos: e.photos.map(id => ({ id, src: '' })) };
      openDiaryForm();
    });
    document.querySelectorAll('[data-ig]').forEach(b => b.onclick = () => openShare(list.find(x => x.id === b.dataset.ig)));
    fillPhotos($('#app'));
  }

  function pullDiaryForm() {
    const f = S.dform;
    if (!f || !$('#dDate')) return f;
    f.date = $('#dDate').value; f.body = $('#dBody').value; f.weight = $('#dWeight').value.trim();
    return f;
  }

  function openDiaryForm(errMsg) {
    const f = S.dform;
    const cat = S.data.cats.find(c => c.id === f.catId);
    $('#modal').innerHTML = `<div class="overlay"><div class="box">
      <h3 style="margin-top:0">${f.id ? '日記を直す' : '日記を書く'}（${esc(cat ? cat.name : '')}）</h3>
      <div class="two">
        <div><label class="f" for="dDate">日付</label><input type="date" id="dDate" value="${esc(f.date)}"></div>
        <div><label class="f" for="dWeight">体重（g・任意）</label><input type="text" inputmode="numeric" id="dWeight" value="${esc(f.weight)}" placeholder="例：850"></div>
      </div>
      <label class="f" for="dBody">本文（2,000字まで）</label><textarea id="dBody" maxlength="2000" style="min-height:140px">${esc(f.body)}</textarea>
      <label class="f">写真（${DIARY_PHOTOS}枚まで）</label>
      <div class="photos" id="dPhotos">${f.photos.map((p, i) => `<div class="ph" ${p.src ? '' : `data-ph="${esc(p.id)}"`}>${p.src ? `<img alt="写真" src="${esc(p.src)}">` : '<span class="spin" style="width:20px;height:20px"></span>'}<button class="x" type="button" data-rmph="${i}" aria-label="外す">×</button></div>`).join('')}</div>
      ${f.photos.length < DIARY_PHOTOS ? `<label class="btn block" for="dFile">📷 写真を撮る／選ぶ</label><input type="file" id="dFile" accept="image/*" class="vh">` : ''}
      <p class="err" id="dErr">${esc(errMsg || '')}</p>
      <div class="row">${f.id ? '<button class="btn danger" type="button" id="dDel">削除</button>' : ''}<span class="grow"></span><button class="btn" type="button" id="dCancel">やめる</button><button class="btn primary" type="button" id="dSave">保存する</button></div>
    </div></div>`;
    // 付いている写真は、押すと外せる（×）。読み込みは一覧と同じ
    $('#dPhotos').querySelectorAll('[data-ph]').forEach(el => {
      loadPhoto(el.dataset.ph).then(src => { const img = el.querySelector('.spin'); if (img) img.outerHTML = `<img alt="写真" src="${esc(src)}">`; }, () => {});
    });
    document.querySelectorAll('[data-rmph]').forEach(b => b.onclick = () => { pullDiaryForm(); f.photos.splice(+b.dataset.rmph, 1); openDiaryForm(); });
    $('#dCancel').onclick = closeModal;
    if ($('#dFile')) $('#dFile').onchange = async ev => {
      const file = ev.target.files[0];
      if (!file) return;
      pullDiaryForm();
      busy('写真を保存中…');
      const session = auth.session;
      try {
        const src = await resizeImage(file, PHOTO_MAX_SIDE);
        if (session !== auth.session) return;
        const r = await call('uploadDiaryPhoto', { image: src.split(',')[1] });
        f.photos.push({ id: r.photoId, src });
        S.photoCache[r.photoId] = Promise.resolve(src);
        openDiaryForm();
      } catch (e) { openDiaryForm(errText(e)); }
    };
    $('#dSave').onclick = async () => {
      pullDiaryForm();
      const w = f.weight.normalize('NFKC').replace(/[,\s]/g, '').replace(/g$/i, '');
      if (w !== '' && !/^[1-9]\d{0,4}$/.test(w)) { $('#dErr').textContent = '体重は g の整数で入れてください（例：850）。'; return; }
      const weight = w === '' ? '' : Number(w);
      if (!f.date) { $('#dErr').textContent = '日付を入れてください。'; return; }
      if (!f.body.trim() && !f.photos.length && weight === '') { $('#dErr').textContent = '本文・体重・写真のどれかを入れてください。'; return; }
      const diary = { id: f.id, catId: f.catId, date: f.date, body: f.body, weight, photos: f.photos.map(p => p.id) };
      busy('保存中…');
      try {
        await call(f.id ? 'updateDiary' : 'addDiary', { diary });
        S.diary = await call('listDiary', { catId: f.catId });
        await reload();
        S.dform = null;
        closeModal(); toast('保存しました'); render();
      } catch (e) { openDiaryForm(errText(e)); }
    };
    if ($('#dDel')) $('#dDel').onclick = async () => {
      if (!await ask(`${f.date} の日記を削除しますか？` + (f.photos.length ? '\n付いている写真はドライブのゴミ箱に移します。' : ''), '削除する', true)) return;
      busy('削除中…');
      try {
        await call('deleteDiary', { id: f.id });
        S.diary = await call('listDiary', { catId: f.catId });
        await reload();
        S.dform = null;
        closeModal(); toast('削除しました'); render();
      } catch (e) { openDiaryForm(errText(e)); }
    };
  }

  /* ===== Instagram への投稿（スマホの共有メニューを使う） ===== */
  function captionOf(e) {
    const cat = S.data.cats.find(c => c.id === e.catId);
    return [
      `${cat ? cat.name : ''}　${e.date}`,
      e.body ? '\n' + e.body : '',
      e.weight !== '' ? `\n体重 ${e.weight}g` : '',
      S.data.hashtags ? '\n' + S.data.hashtags : '',
    ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function openShare(e) {
    if (!e) return;
    const session = auth.session;
    const share = { files: null, ready: !e.photos.length, failed: false };
    $('#modal').innerHTML = `<div class="overlay"><div class="box">
      <h3 style="margin-top:0">📷 Instagram に投稿</h3>
      <p class="small" style="margin:0 0 6px">「コピーして Instagram へ」を押すと、投稿文をコピーして、写真をスマホの共有メニューに渡します。共有メニューで Instagram を選び、投稿文の欄に貼り付けて投稿してください。</p>
      <p class="note small">共有の前に、写真に住所・表札・病院名などが写っていないか、投稿文に載せたくないことが入っていないかを確かめてください。</p>
      <label class="f" for="igText">投稿文（ここで直せます）</label>
      <textarea id="igText" style="min-height:180px">${esc(captionOf(e))}</textarea>
      <p class="muted small" id="igState">${e.photos.length ? `写真（${e.photos.length}枚）を準備しています…` : 'この日記には写真がありません。Instagram は写真が要るため、投稿文のコピーだけになります。'}</p>
      <button class="btn primary block" type="button" id="igGo" ${share.ready ? '' : 'disabled'}>${e.photos.length ? 'コピーして Instagram へ' : '投稿文をコピーする'}</button>
      <div id="igOut"></div>
      <p class="msg" id="igMsg"></p>
      <button class="btn block" type="button" id="igClose" style="margin-top:8px">閉じる</button>
    </div></div>`;
    $('#igClose').onclick = closeModal;

    // 共有メニューはボタンを押した直後でないと開けないため、押す前に写真を受け取っておく
    if (e.photos.length) {
      Promise.allSettled(e.photos.map(loadPhoto)).then(results => {
        if (session !== auth.session || !$('#igGo')) return;
        const srcs = results.filter(x => x.status === 'fulfilled').map(x => x.value);
        if (!srcs.length) throw new Error('写真を開けませんでした');
        share.files = srcs.map((src, i) => dataUrlToFile(src, `${e.date}_${i + 1}.jpg`));
        share.canShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: share.files }));
        share.ready = true;
        $('#igGo').disabled = false;
        $('#igState').textContent = share.canShare
          ? `写真（${srcs.length}枚）の準備ができました。` + (srcs.length < e.photos.length ? `（開けなかった写真 ${e.photos.length - srcs.length}枚は入りません）` : '')
          : 'この端末・ブラウザは、写真を共有メニューに渡せません。下のボタンで写真を保存し、投稿文をコピーしてから、Instagram で投稿してください。';
        if (!share.canShare) {
          $('#igGo').textContent = '投稿文をコピーする';
          $('#igOut').innerHTML = share.files.map((f, i) => `<a class="btn block" style="margin-top:8px" href="${esc(blobUrl(f))}" download="${esc(f.name)}">写真${i + 1}を保存する</a>`).join('');
        }
      }).catch(err => {
        if (session !== auth.session || !$('#igGo')) return;
        share.failed = true;
        $('#igState').textContent = '写真を受け取れませんでした（' + errText(err) + '）。閉じてもう一度お試しください。';
      });
    }

    $('#igGo').onclick = () => {
      const text = $('#igText').value;
      // コピーと共有メニューは、押した直後の同じ流れで呼ぶ（間に通信を挟むと、端末が共有メニューを開かない）
      const copied = copyText(text, $('#igText'));
      const sharing = share.files && share.canShare ? navigator.share({ files: share.files }) : null;
      copied.then(ok => {
        if (!sharing) { msg('igMsg', ok ? '投稿文をコピーしました。' + (e.photos.length ? '保存した写真と一緒に Instagram で投稿してください。' : '') : 'コピーできませんでした。投稿文を長押ししてコピーしてください。', ok ? 'ok' : 'err'); return; }
        sharing.then(async () => {
          if (session !== auth.session) return;
          msg('igMsg', (ok ? '投稿文をコピーしました。' : '投稿文はコピーできませんでした（長押しでコピーしてください）。') + 'Instagram の投稿画面で、投稿文の欄に貼り付けてください。', 'ok');
          try {
            e.sharedAt = await call('markShared', { id: e.id });
          } catch (err) { /* 記録できなくても共有は済んでいる */ }
        }, err => {
          if (session !== auth.session) return;
          msg('igMsg', err && err.name === 'AbortError' ? '共有をやめました。' : '共有メニューを開けませんでした（' + errText(err) + '）。', 'err');
        });
      });
    };
  }

  /* ===== 経費の一覧（共通部品） ===== */
  function expenseList(ex, showCat) {
    if (!ex.length) return `<div class="list"><div class="empty">経費はまだありません。</div></div>`;
    return `<div class="list">${ex.map(e => `
      <button class="item" type="button" data-ex="${esc(e.id)}">
        <div class="main">
          <div class="t1">${showCat ? esc(catName(e.catId)) + '　' : ''}${esc(e.detail || e.category)}</div>
          <div class="t2">${esc(e.date)}　${esc(e.category)}${e.payee ? '　' + esc(e.payee) : ''}${e.fileId ? '　📎領収書' : ''}　登録：${esc(e.createdBy || '代表者')}</div>
        </div>
        <div class="amt num">${yen(e.amount)}</div>
      </button>`).join('')}</div>`;
  }
  function bindExpenseList() {
    document.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => openExpenseForm(S.data.expenses.find(e => e.id === b.dataset.ex)));
  }

  function openExpenseForm(e) {
    if (!e) return;
    $('#modal').innerHTML = `<div class="overlay"><div class="box">
      <h3 style="margin-top:0">経費を直す</h3>
      <p class="muted small" style="margin:0">登録 ${esc(e.createdAt)}（${esc(e.createdBy || '代表者')}）${e.updatedAt ? `／最終更新 ${esc(e.updatedAt)}${e.editedBy ? `（${esc(e.editedBy)}）` : ''}` : ''}</p>
      ${expenseFields(e, 'x')}
      ${e.fileId ? `<div id="xImg"><button class="btn block" type="button" id="xShow" style="margin-top:12px">📎 領収書の写真を見る</button></div>` : ''}
      <p class="err" id="xErr"></p>
      <div class="row"><button class="btn danger" type="button" id="xDel">削除</button><span class="grow"></span><button class="btn" type="button" id="xCancel">閉じる</button><button class="btn primary" type="button" id="xSave">保存する</button></div>
    </div></div>`;
    $('#xCancel').onclick = closeModal;
    if (e.fileId) $('#xShow').onclick = async () => {
      $('#xImg').innerHTML = '<div class="spin" style="margin:12px auto"></div>';
      try {
        const r = await call('receipt', { fileId: e.fileId });
        $('#xImg').innerHTML = isImageDataUrl(r.dataUrl)
          ? `<img class="thumb" alt="領収書" src="${esc(r.dataUrl)}">`
          : r.driveUrl && /^https:\/\/drive\.google\.com\/file\/d\/[\w-]+\/view$/.test(r.driveUrl)
            ? `<p class="muted small">この写真は前の版のアプリで撮ったため、ここでは表示できません。</p><a class="btn block" href="${esc(r.driveUrl)}" target="_blank" rel="noopener">ドライブで写真を開く</a>`
            : '<p class="muted small">この写真は前の版のアプリで撮ったため、ここでは表示できません（代表者はドライブで開けます）。</p>';
      } catch (err) { $('#xImg').innerHTML = `<p class="err">${esc(errText(err))}</p>`; }
    };
    $('#xSave').onclick = async () => {
      const body = Object.assign({ id: e.id }, readExpenseFields('x'));
      const m = checkExpense(body);
      if (m) { $('#xErr').textContent = m; return; }
      busy('保存中…');
      try { await call('updateExpense', { expense: body }); await reload(); closeModal(); toast('保存しました'); render(); }
      catch (err) { closeModal(); toast(errText(err), 4000); }
    };
    $('#xDel').onclick = async () => {
      if (!await ask(`この経費（${e.date} ${yen(e.amount)}）を削除しますか？`, '削除する', true)) return;
      busy('削除中…');
      try { await call('deleteExpense', { id: e.id }); await reload(); closeModal(); toast('削除しました'); render(); }
      catch (err) { closeModal(); toast(errText(err), 4000); }
    };
  }

  function expenseFields(e, p) {
    return `
      <label class="f" for="${p}Cat">保護猫</label><select id="${p}Cat">${catOptions(e.catId, { placeholder: '選んでください' })}</select>
      <div class="two">
        <div><label class="f" for="${p}Date">日付</label><input type="date" id="${p}Date" value="${esc(e.date)}"></div>
        <div><label class="f" for="${p}Amt">金額（円・税込）</label><input type="text" inputmode="numeric" id="${p}Amt" value="${e.amount ? esc(e.amount) : ''}"></div>
      </div>
      <label class="f" for="${p}Kind">費目</label><select id="${p}Kind">${categoryOptions(e.category, '選んでください')}</select>
      <label class="f" for="${p}Payee">支払先（病院名・店名）</label><input type="text" id="${p}Payee" maxlength="100" value="${esc(e.payee)}">
      <label class="f" for="${p}Detail">内容</label><input type="text" id="${p}Detail" maxlength="300" value="${esc(e.detail)}" placeholder="例：3種混合ワクチン、ロイヤルカナン 2kg">`;
  }
  function readExpenseFields(p) {
    return {
      catId: $('#' + p + 'Cat').value, date: $('#' + p + 'Date').value, amount: toInt($('#' + p + 'Amt').value),
      category: $('#' + p + 'Kind').value, payee: $('#' + p + 'Payee').value.trim(), detail: $('#' + p + 'Detail').value.trim(),
    };
  }
  function checkExpense(r) {
    if (!r.catId) return '保護猫を選んでください。';
    if (!r.date) return '日付を入れてください。';
    if (!r.amount) return '金額を入れてください。';
    if (!r.category) return '費目を選んでください。';
    return '';
  }

  /* ===== 経費を登録 ===== */
  function renderAdd() {
    const a = S.add || (S.add = { mode: 'pick', presetCat: '' });
    if (a.mode === 'manual') return renderManual();
    if (a.mode === 'review') return renderReview();
    $('#app').innerHTML = `
      <h2>経費を登録</h2>
      ${a.presetCat ? `<div class="note">「${esc(catName(a.presetCat))}」の経費として登録します。</div>` : ''}
      <label class="btn primary big block" for="rcFile" style="margin-top:8px">📷 領収書・レシートを撮る／写真を選ぶ</label>
      <input type="file" id="rcFile" accept="image/*" class="vh">
      <p class="muted small">写真から日付・支払先・金額を読み取ります。読み取った内容は登録前に確認・修正できます。写真は代表者の Google ドライブに保存されます。</p>
      ${S.data.geminiReady ? '' : '<p class="note">いまはドライブの文字読み取りで、日付・支払先・合計を読み取ります。品目と費目は手で入れてください。代表者が「設定」で Gemini のキーを登録すると、品目まで読み取れます。</p>'}
      <button class="btn big block" type="button" id="toManual" style="margin-top:16px">✏️ 領収書なしで手入力する</button>
    `;
    $('#toManual').onclick = () => { a.mode = 'manual'; renderAdd(); };
    $('#rcFile').onchange = ev => { const f = ev.target.files[0]; if (f) analyze(f); };
  }

  function renderManual() {
    const a = S.add;
    const e = a.draft || { catId: a.presetCat || '', date: today(), amount: 0, category: '', payee: '', detail: '' };
    $('#app').innerHTML = `
      <p><button class="linkbtn" type="button" id="back">← 戻る</button></p>
      <h2>経費を手入力</h2>
      <div class="panel">
        ${expenseFields(e, 'm')}
        <p class="err" id="mErr"></p>
        <button class="btn primary block" type="button" id="mSave">登録する</button>
      </div>`;
    $('#back').onclick = () => { S.add = { mode: 'pick', presetCat: a.presetCat }; renderAdd(); };
    $('#mSave').onclick = async () => {
      const r = readExpenseFields('m');
      const m = checkExpense(r);
      if (m) { $('#mErr').textContent = m; return; }
      a.draft = r;
      busy('登録中…');
      try {
        await call('addExpenses', { rows: [r] });
        await reload(); closeModal(); toast('登録しました');
        S.add = null; S.tab = 'cats'; S.catId = r.catId; render(); window.scrollTo(0, 0);
      } catch (err) { closeModal(); $('#mErr').textContent = errText(err); }
    };
  }

  async function analyze(file) {
    const a = S.add;
    busy('写真を準備中…');
    const session = auth.session;
    let dataUrl;
    try { dataUrl = await resizeImage(file, PHOTO_MAX_SIDE); }
    catch (e) { if (session === auth.session) { closeModal(); toast(errText(e), 4000); } return; }
    if (session !== auth.session) return;
    busy('領収書を読み取り中…（10〜30秒）');
    try {
      const r = await call('analyzeReceipt', { image: dataUrl.split(',')[1] });
      const res = r.result || { date: '', store: '', total: 0, items: [], taxNote: '' };
      const items = res.items.length ? res.items : [{ name: '', amount: res.total || 0, category: '' }];
      const big = items.slice().sort((x, y) => y.amount - x.amount)[0];
      Object.assign(a, {
        mode: 'review', img: dataUrl, fileId: r.fileId, error: r.error, engine: r.engine, note: r.note,
        date: res.date || today(), store: res.store, total: res.total || sum(items, i => i.amount), taxNote: res.taxNote,
        catId: a.presetCat || '', split: false,
        category: big ? big.category : '', detail: items.map(i => i.name).filter(Boolean).join('、').slice(0, 300),
        items: items.map(i => ({ name: i.name, amount: i.amount, category: i.category, catId: '' })),
      });
      closeModal();
      renderAdd();
      window.scrollTo(0, 0);
    } catch (e) { closeModal(); toast(errText(e), 5000); }
  }

  function renderReview() {
    const a = S.add;
    const itemSum = sum(a.items, i => i.amount);
    const diff = a.total - itemSum;
    $('#app').innerHTML = `
      <p><button class="linkbtn" type="button" id="back">← やめて最初に戻る</button></p>
      <h2>読み取り結果を確認</h2>
      ${a.note ? `<p class="note">${esc(a.note)}</p>` : ''}
      ${a.error ? `<p class="err">${esc(a.error)}</p>` : a.engine === 'ocr'
        ? '<div class="note">日付・支払先・合計を読み取りました。写真と見比べて、違っていれば直してください。費目は選んでください。</div>'
        : '<div class="note">読み取った内容です。写真と見比べて、違っていれば直してください。</div>'}
      <details class="panel"><summary>領収書の写真</summary><img class="thumb" alt="領収書" src="${esc(a.img)}"></details>
      <div class="panel">
        <label class="f" for="rCat"><strong style="color:var(--ink)">どの保護猫の経費ですか</strong></label>
        <select id="rCat">${catOptions(a.catId, { placeholder: '選んでください' })}</select>
        <div class="two">
          <div><label class="f" for="rDate">日付</label><input type="date" id="rDate" value="${esc(a.date)}"></div>
          <div><label class="f" for="rTotal">合計（円・税込）</label><input type="text" inputmode="numeric" id="rTotal" value="${esc(a.total)}"></div>
        </div>
        <label class="f" for="rStore">支払先</label><input type="text" id="rStore" maxlength="100" value="${esc(a.store)}">
        ${a.taxNote ? `<p class="muted small">読み取りメモ：${esc(a.taxNote)}</p>` : ''}

        <label class="f">登録のしかた</label>
        <div class="chips">
          <button type="button" class="chip${a.split ? '' : ' on'}" data-split="0">合計を1件で登録</button>
          <button type="button" class="chip${a.split ? ' on' : ''}" data-split="1">品目ごとに分けて登録</button>
        </div>
        ${a.split ? `
          <p class="muted small">品目ごとに猫や費目を変えられます。猫が「上と同じ」の行は、上で選んだ猫になります。</p>
          ${a.items.map((it, i) => `
            <div class="itemrow">
              <input type="text" data-i="${i}" data-k="name" maxlength="300" value="${esc(it.name)}" placeholder="品目">
              <div class="two" style="margin-top:6px">
                <input type="text" inputmode="numeric" data-i="${i}" data-k="amount" value="${esc(it.amount)}" placeholder="金額">
                <select data-i="${i}" data-k="category">${categoryOptions(it.category, '費目')}</select>
              </div>
              <div class="row" style="margin-top:6px">
                <select class="grow" data-i="${i}" data-k="catId" style="width:auto"><option value="">上と同じ</option>${catOptions(it.catId)}</select>
                <button class="linkbtn" type="button" data-del="${i}" style="color:var(--ng)">外す</button>
              </div>
            </div>`).join('')}
          <button class="btn block" type="button" id="addItem">＋ 行を足す</button>
          <div style="margin-top:10px">
            <div class="sumline"><span>品目の合計</span><span class="num">${yen(itemSum)}</span></div>
            ${diff ? `<div class="sumline diff"><span>領収書の合計との差（消費税・値引きなど）</span><span class="num">${yen(diff)}</span></div>
            <button class="btn block" type="button" id="addDiff">差額 ${yen(diff)} を1行として足す</button>` : ''}
          </div>
        ` : `
          <label class="f" for="rKind">費目</label><select id="rKind">${categoryOptions(a.category, '選んでください')}</select>
          <label class="f" for="rDetail">内容</label><input type="text" id="rDetail" maxlength="300" value="${esc(a.detail)}">
        `}
        <p class="err" id="rErr"></p>
        <button class="btn primary block" type="button" id="rSave" style="margin-top:8px">この内容で登録する</button>
      </div>`;

    const pull = () => {
      a.catId = $('#rCat').value; a.date = $('#rDate').value; a.total = toInt($('#rTotal').value); a.store = $('#rStore').value;
      if (!a.split) { a.category = $('#rKind').value; a.detail = $('#rDetail').value; }
      document.querySelectorAll('[data-i]').forEach(el => {
        const it = a.items[+el.dataset.i];
        it[el.dataset.k] = el.dataset.k === 'amount' ? toInt(el.value) : el.value;
      });
    };
    $('#back').onclick = async () => { if (await ask('入力をやめますか？（写真は登録に使わなければ、1日後にドライブのゴミ箱へ移ります）', 'やめる')) { S.add = { mode: 'pick', presetCat: a.presetCat }; renderAdd(); } };
    document.querySelectorAll('[data-split]').forEach(b => b.onclick = () => { pull(); a.split = b.dataset.split === '1'; renderReview(); });
    document.querySelectorAll('[data-i][data-k=amount]').forEach(el => el.onchange = () => { pull(); renderReview(); });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { pull(); a.items.splice(+b.dataset.del, 1); renderReview(); });
    if ($('#addItem')) $('#addItem').onclick = () => { pull(); a.items.push({ name: '', amount: 0, category: '', catId: '' }); renderReview(); };
    if ($('#addDiff')) $('#addDiff').onclick = () => { pull(); a.items.push({ name: '消費税・値引きなど', amount: a.total - sum(a.items, i => i.amount), category: a.items[0] ? a.items[0].category : '', catId: '' }); renderReview(); };
    $('#rTotal').onchange = () => { pull(); if (a.split) renderReview(); };

    $('#rSave').onclick = async () => {
      pull();
      const err = m => { $('#rErr').textContent = m; };
      if (!a.catId) return err('どの保護猫の経費か選んでください。');
      if (!a.date) return err('日付を入れてください。');
      let rows;
      if (a.split) {
        const its = a.items.filter(i => i.amount);
        if (!its.length) return err('金額の入った品目がありません。');
        if (its.some(i => !i.category)) return err('費目が空の行があります。');
        if (sum(its, i => i.amount) !== a.total && !await ask(`品目の合計（${yen(sum(its, i => i.amount))}）が領収書の合計（${yen(a.total)}）と合いません。このまま登録しますか？`, '登録する')) return;
        rows = its.map(i => ({ catId: i.catId || a.catId, date: a.date, amount: i.amount, category: i.category, payee: a.store, detail: i.name, fileId: a.fileId }));
      } else {
        if (!a.total) return err('合計の金額を入れてください。');
        if (!a.category) return err('費目を選んでください。');
        rows = [{ catId: a.catId, date: a.date, amount: a.total, category: a.category, payee: a.store, detail: a.detail, fileId: a.fileId }];
      }
      busy('登録中…');
      try {
        const n = await call('addExpenses', { rows });
        await reload(); closeModal(); toast(`${n}件 登録しました`);
        const go = a.catId;
        S.add = null; S.tab = 'cats'; S.catId = go; render(); window.scrollTo(0, 0);
      } catch (e) { closeModal(); err(errText(e)); }
    };
  }

  /* ===== 経費一覧 ===== */
  function renderList() {
    const d = S.data, f = S.listF;
    const months = Array.from(new Set(d.expenses.map(e => e.date.slice(0, 7)))).sort().reverse();
    let ex = d.expenses.filter(e =>
      (!f.cat || e.catId === f.cat) && (!f.month || e.date.slice(0, 7) === f.month) &&
      (!f.category || e.category === f.category) &&
      (!f.q || (e.detail + ' ' + e.payee + ' ' + catName(e.catId) + ' ' + e.createdBy).indexOf(f.q) >= 0));
    ex = ex.sort(byDateDesc);
    $('#app').innerHTML = `
      <h2>経費一覧</h2>
      <div class="panel">
        <div class="two">
          <div><label class="f" for="fCat">保護猫</label><select id="fCat">${catOptions(f.cat, { placeholder: 'すべて' })}</select></div>
          <div><label class="f" for="fMonth">月</label><select id="fMonth"><option value="">すべて</option>${months.map(m => `<option value="${esc(m)}"${m === f.month ? ' selected' : ''}>${esc(m.replace('-', '年'))}月</option>`).join('')}</select></div>
          <div><label class="f" for="fKind">費目</label><select id="fKind">${categoryOptions(f.category, 'すべて')}</select></div>
        </div>
        <label class="f" for="fQ">キーワード（内容・支払先・猫の名前・登録者）</label><input type="text" id="fQ" value="${esc(f.q)}">
      </div>
      <div class="row" style="margin:8px 2px"><span class="grow muted">${ex.length}件</span><strong class="num">合計 ${yen(sum(ex, e => e.amount))}</strong></div>
      ${expenseList(ex, true)}
      <button class="btn block" type="button" id="toRep" style="margin-top:12px">📄 この条件で帳票を出す</button>
    `;
    const upd = () => { Object.assign(f, { cat: $('#fCat').value, month: $('#fMonth').value, category: $('#fKind').value }); renderList(); };
    ['#fCat', '#fMonth', '#fKind'].forEach(s => $(s).onchange = upd);
    $('#fQ').onchange = () => { f.q = $('#fQ').value.trim(); renderList(); };
    $('#toRep').onclick = () => {
      const r = defaultRepF();
      r.cat = f.cat; r.category = f.category;
      if (f.month) { const [y, m] = f.month.split('-').map(Number); r.from = f.month + '-01'; r.to = f.month + '-' + pad(new Date(y, m, 0).getDate()); }
      else { r.from = ''; r.to = ''; }
      S.repF = r; S.tab = 'report'; render(); window.scrollTo(0, 0);
    };
    bindExpenseList();
  }

  /* ===== 帳票 ===== */
  function defaultRepF() {
    const t = today();
    return { from: t.slice(0, 4) + '-01-01', to: t, cat: '', category: '', detail: true };
  }

  /** 画面の下見。PDF は GAS が同じ中身で作る（Report.js）。ここでも外から来た文字は esc() を通す */
  function reportHtml(f) {
    const d = S.data;
    const ex = d.expenses.filter(e =>
      (!f.from || e.date >= f.from) && (!f.to || e.date <= f.to) && (!f.cat || e.catId === f.cat) &&
      (!f.category || e.category === f.category)).sort((a, b) => a.date.localeCompare(b.date));
    const groups = Object.create(null);
    ex.forEach(e => { (groups[e.catId] = groups[e.catId] || []).push(e); });
    const order = sortedCats().map(c => c.id).concat([d.common.id]).filter(id => groups[id]);
    Object.keys(groups).forEach(id => { if (order.indexOf(id) < 0) order.push(id); });
    const kinds = Object.create(null);
    ex.forEach(e => { const k = kinds[e.category] || (kinds[e.category] = { n: 0, amt: 0 }); k.n++; k.amt += e.amount; });
    const statusOf = id => { const c = d.cats.find(c => c.id === id); return c ? c.status : ''; };
    const period = (f.from || f.to) ? `${f.from || '最初'} 〜 ${f.to || '最新'}` : '全期間';
    const cond = [f.cat ? `保護猫：${catName(f.cat)}` : '保護猫：すべて', f.category ? `費目：${f.category}` : ''].filter(Boolean).join('　');
    const total = sum(ex, e => e.amount);
    let h = `<div class="rp">
      <h1>保護活動経費 明細書</h1>
      <div class="meta">${d.ownerName ? '名前：' + esc(d.ownerName) + '<br>' : ''}対象期間：${esc(period)}<br>${esc(cond)}</div>
      <h2>保護猫別の集計</h2>
      <table><thead><tr><th>保護猫</th><th>状態</th><th class="r">件数</th><th class="r">金額</th></tr></thead><tbody>
      ${order.map(id => `<tr><td>${esc(catName(id))}</td><td>${esc(statusOf(id))}</td><td class="r">${groups[id].length}</td><td class="r">${yen(sum(groups[id], e => e.amount))}</td></tr>`).join('') || '<tr><td colspan="4" class="c">該当なし</td></tr>'}
      <tr class="sub"><td colspan="2">合計</td><td class="r">${ex.length}</td><td class="r">${yen(total)}</td></tr></tbody></table>
      <h2>費目別の集計</h2>
      <table><thead><tr><th>費目</th><th class="r">件数</th><th class="r">金額</th></tr></thead><tbody>
      ${d.categories.filter(k => kinds[k]).concat(Object.keys(kinds).filter(k => d.categories.indexOf(k) < 0)).map(k => `<tr><td>${esc(k)}</td><td class="r">${kinds[k].n}</td><td class="r">${yen(kinds[k].amt)}</td></tr>`).join('') || '<tr><td colspan="3" class="c">該当なし</td></tr>'}
      </tbody></table>`;
    if (f.detail) {
      h += `<h2>明細</h2>`;
      order.forEach(id => {
        const g = groups[id];
        h += `<div class="cat"><h3>${esc(catName(id))}${statusOf(id) ? `（${esc(statusOf(id))}）` : ''}</h3>
          <table><thead><tr><th style="width:11%">日付</th><th style="width:17%">費目</th><th>内容</th><th style="width:20%">支払先</th><th style="width:7%">領収書</th><th class="r" style="width:13%">金額</th></tr></thead><tbody>
          ${g.map(e => `<tr><td>${esc(e.date)}</td><td>${esc(e.category)}</td><td>${esc(e.detail)}</td><td>${esc(e.payee)}</td><td class="c">${e.fileId ? '有' : ''}</td><td class="r">${yen(e.amount)}</td></tr>`).join('')}
          <tr class="sub"><td colspan="5">小計（${g.length}件）</td><td class="r">${yen(sum(g, e => e.amount))}</td></tr></tbody></table></div>`;
      });
    }
    h += `<div class="grand">総合計　${yen(total)}</div></div>`;
    return h;
  }

  function renderReport() {
    const f = S.repF || (S.repF = defaultRepF());
    const t = today(), y = +t.slice(0, 4), m = +t.slice(5, 7);
    const last = (yy, mm) => `${yy}-${pad(mm)}-${pad(new Date(yy, mm, 0).getDate())}`;
    const pm = m === 1 ? [y - 1, 12] : [y, m - 1];
    const quick = {
      '今月': [`${y}-${pad(m)}-01`, last(y, m)],
      '先月': [`${pm[0]}-${pad(pm[1])}-01`, last(pm[0], pm[1])],
      '今年': [`${y}-01-01`, `${y}-12-31`],
      '昨年': [`${y - 1}-01-01`, `${y - 1}-12-31`],
      '全期間': ['', ''],
    };
    $('#app').innerHTML = `
      <h2 class="noprint">帳票</h2>
      <div class="panel noprint">
        <div class="chips">${Object.keys(quick).map(k => `<button type="button" class="chip${quick[k][0] === f.from && quick[k][1] === f.to ? ' on' : ''}" data-q="${k}">${k}</button>`).join('')}</div>
        <div class="two">
          <div><label class="f" for="pFrom">開始日</label><input type="date" id="pFrom" value="${esc(f.from)}"></div>
          <div><label class="f" for="pTo">終了日</label><input type="date" id="pTo" value="${esc(f.to)}"></div>
          <div><label class="f" for="pCat">保護猫</label><select id="pCat">${catOptions(f.cat, { placeholder: 'すべて' })}</select></div>
          <div><label class="f" for="pKind">費目</label><select id="pKind">${categoryOptions(f.category, 'すべて')}</select></div>
          <div><label class="f" for="pDetail">内容</label><select id="pDetail"><option value="1"${f.detail ? ' selected' : ''}>集計＋明細</option><option value="0"${f.detail ? '' : ' selected'}>集計だけ</option></select></div>
        </div>
        <button class="btn primary block" type="button" id="pPdf" style="margin-top:14px">📄 PDF にする（保存・印刷・共有）</button>
        <div id="pPdfOut"></div>
        <p class="muted small">印刷するときは、作った PDF を開いて、PDF の画面の共有メニューから印刷してください。</p>
      </div>
      <div class="paperwrap"><div id="paper">${reportHtml(f)}</div></div>
    `;
    document.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { [f.from, f.to] = quick[b.dataset.q]; renderReport(); });
    const upd = () => { Object.assign(f, { from: $('#pFrom').value, to: $('#pTo').value, cat: $('#pCat').value, category: $('#pKind').value, detail: $('#pDetail').value === '1' }); renderReport(); };
    ['#pFrom', '#pTo', '#pCat', '#pKind', '#pDetail'].forEach(s => $(s).onchange = upd);
    $('#pPdf').onclick = async () => {
      busy('PDF を作成中…');
      try {
        const r = await call('reportPdf', { filter: { from: f.from, to: f.to, cat: f.cat, category: f.category, detail: f.detail } });
        const bin = atob(r.pdf), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], r.name, { type: 'application/pdf' });
        const url = blobUrl(file);
        const canShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
        closeModal();
        $('#pPdfOut').innerHTML = `<a class="btn primary block" style="margin-top:10px" href="${esc(url)}" target="_blank" rel="noopener">PDF を開く</a>
          <a class="btn block" style="margin-top:8px" href="${esc(url)}" download="${esc(r.name)}">PDF を保存する</a>
          ${canShare ? '<button class="btn block" type="button" id="pShare" style="margin-top:8px">PDF を共有する（印刷・メール・LINE など）</button>' : ''}`;
        if (canShare) $('#pShare').onclick = () => { navigator.share({ files: [file] }).catch(() => {}); };
      } catch (e) { closeModal(); toast(errText(e), 4000); }
    };
  }

  /* ===== 電波 ===== */
  function onlineState() { $('#offline').hidden = navigator.onLine !== false; }
  window.addEventListener('online', onlineState);
  window.addEventListener('offline', onlineState);
  onlineState();

  if ('serviceWorker' in navigator && !IS_LOCAL) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  start();
})();
