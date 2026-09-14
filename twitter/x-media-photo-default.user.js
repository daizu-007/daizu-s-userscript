// ==UserScript==
// @name         Open photos by default in the Twitter media tab
// @namespace    https://x.com/
// @version      1.2.1
// @description  Videos now open by default in the Twitter media tab, so I'll make photos open by default instead.
// @author       daizu-007
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      Apache-2.0
// ==/UserScript==

(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 定数
   * ------------------------------------------------------------------ */
  const MEDIA_PATH_RE = /^\/([A-Za-z0-9_]{1,20})\/media\/?$/;
  // メニュー「画像」項目のラベル(多言語フォールバック)
  const PHOTO_LABEL_RE = /^(画像|写真|photos?|fotos?|foto|照片|图片|사진)$/i;
  // メニューの「動画」クリック直後は、その遷移をユーザー操作として尊重する猶予
  const VIDEO_MENU_GRACE_MS = 1500;
  // ループ防止用の記録キー
  const REPLACE_LOG_KEY = "xmdf:replace-log";
  const RELOAD_LOG_KEY = "xmdf:reload-log";

  /* ------------------------------------------------------------------ *
   * ユーティリティ
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** href を解析し、メディアページなら { user, filter } を返す */
  function parseMedia(href) {
    if (!href) return null;
    let u;
    try {
      u = new URL(href, location.origin);
    } catch {
      return null;
    }
    const m = u.pathname.match(MEDIA_PATH_RE);
    if (!m) return null;
    return { user: m[1].toLowerCase(), filter: u.searchParams.get("filter") || null };
  }

  /** フィルタ指定のないメディアURLなら ?filter=photo 付きのURLを返す(対象外なら null) */
  function withPhotoFilter(href) {
    let u;
    try {
      u = new URL(href, location.origin);
    } catch {
      return null;
    }
    if (!MEDIA_PATH_RE.test(u.pathname)) return null;
    if (u.searchParams.has("filter")) return null; // filter=video 等は尊重する
    u.searchParams.set("filter", "photo");
    return u.href;
  }

  /** 再帰的な書き換え/リロードを防ぐための簡易カウンタ */
  function guardLimit(key, path, limit, windowMs) {
    try {
      const now = Date.now();
      const log = (JSON.parse(sessionStorage.getItem(key) || "[]") || []).filter(
        (e) => e && e.p === path && now - e.t < windowMs
      );
      if (log.length >= limit) return true;
      log.push({ p: path, t: now });
      sessionStorage.setItem(key, JSON.stringify(log.slice(-8)));
      return false;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 「ユーザーが動画を選んだ」の記録
   * ------------------------------------------------------------------ */
  // この文書(=タブ)内で、ユーザーが自分で「動画」を選んだプロフィール
  const explicitVideo = new Set();
  // 直近の「動画」クリック時刻
  let videoChosenAt = 0;

  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      const item = t && t.closest ? t.closest('[role="menuitem"]') : null;
      if (!item) return;
      const label = (item.textContent || "").trim();
      if (!label || PHOTO_LABEL_RE.test(label)) return;

      // メディア欄のドロップダウンは「動画/画像」の2項目。それ以外のメニューは無視する
      const menu = item.closest('[role="menu"]');
      const items = menu ? Array.from(menu.querySelectorAll('[role="menuitem"]')) : [];
      if (items.length < 2 || items.length > 3) return;
      if (!items.some((i) => PHOTO_LABEL_RE.test((i.textContent || "").trim()))) return;

      const cur = parseMedia(location.href);
      if (cur && cur.user) explicitVideo.add(cur.user);
      videoChosenAt = Date.now();
    },
    true
  );

  /* ------------------------------------------------------------------ *
   * 描画状態の判定(Xの内部stateはメディアタブの href に反映される)
   * ------------------------------------------------------------------ */
  /** メディアタブの要素を返す */
  function mediaTabEl(user) {
    const tabs = document.querySelectorAll('[role="tablist"] a[role="tab"]');
    for (const a of tabs) {
      const href = a.getAttribute("href");
      if (!href) continue;
      let u;
      try {
        u = new URL(href, location.origin);
      } catch {
        continue;
      }
      const m = u.pathname.match(MEDIA_PATH_RE);
      if (!m) continue;
      if (user && m[1].toLowerCase() !== user) continue;
      return a;
    }
    return null;
  }

  /** 'photo' | 'video' | 'unknown' */
  function photoModeState() {
    const cur = parseMedia(location.href);
    if (!cur) return "photo"; // メディアページ以外は判定対象外
    const tab = mediaTabEl(cur.user);
    if (!tab) return "unknown";
    const href = tab.getAttribute("href") || "";
    try {
      return new URL(href, location.origin).searchParams.get("filter") === "photo" ? "photo" : "video";
    } catch {
      return "unknown";
    }
  }

  /* ------------------------------------------------------------------ *
   * 画像モードへの強制(SPA遷移用)
   * ------------------------------------------------------------------ */
  /** 対象URLなら { user } を返す(対象外・ユーザーが動画を選択済みなら null) */
  function shouldEnforceUrl(href) {
    const media = parseMedia(href);
    if (!media || media.filter) return null;
    if (explicitVideo.has(media.user)) return null;
    if (Date.now() - videoChosenAt < VIDEO_MENU_GRACE_MS) return null;
    return media;
  }

  function findPhotoMenuItem() {
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const r = menu.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      for (const item of menu.querySelectorAll('[role="menuitem"]')) {
        if (PHOTO_LABEL_RE.test((item.textContent || "").trim())) return item;
      }
    }
    return null;
  }

  let menuBusy = false;
  /** X自身のドロップダウンを操作して「画像」を選ぶ(最終手段としての確実な方法) */
  async function clickPhotoMenuItem(user) {
    if (menuBusy) return false;
    menuBusy = true;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const tab = mediaTabEl(user);
        if (!tab || tab.getAttribute("aria-selected") !== "true") {
          await sleep(250);
          continue;
        }
        tab.click(); // 選択済みタブのクリックはナビゲーションではなくメニューを開く
        for (let k = 0; k < 10; k++) {
          const item = findPhotoMenuItem();
          if (item) {
            item.click();
            return true;
          }
          await sleep(150);
        }
        tab.click(); // 開かなければ閉じてリトライ
        await sleep(250);
      }
      return false;
    } finally {
      menuBusy = false;
    }
  }

  let verifyTimer = 0;
  let verifyToken = 0;

  /**
   * 書き換え後に「本当に画像モードで描画されたか」を検証し、必要ならフォールバックする。
   * URLが ?filter=photo でもXの内部stateが動画のまま、という食い違いが起きるため、
   * URLではなくメディアタブの href(内部stateを反映する)で判定すること。
   */
  function scheduleVerify() {
    const token = ++verifyToken;
    clearTimeout(verifyTimer);
    let step = 0;
    let menuTries = 0;

    const tick = async () => {
      if (token !== verifyToken) return;
      const cur = parseMedia(location.href);
      if (!cur) return; // メディアページから離れた
      if (cur.filter && cur.filter !== "photo") return; // 明示的な別フィルタは尊重
      if (explicitVideo.has(cur.user)) return; // ユーザーの意思を尊重
      if (Date.now() - videoChosenAt < VIDEO_MENU_GRACE_MS) {
        verifyTimer = setTimeout(tick, 700);
        return;
      }

      const st = photoModeState();
      if (st === "photo") return; // 成功

      step++;
      if (st === "video") {
        // URL(またはXの内部state)が動画のまま → X自身のメニュー操作で画像へ
        if (menuTries < 2) {
          menuTries++;
          const clicked = await clickPhotoMenuItem(cur.user);
          if (token !== verifyToken) return;
          if (clicked) {
            verifyTimer = setTimeout(tick, 1200);
            return;
          }
        }
        if (step >= 4) {
          // 最終手段: 正しいURLで読み込み直せばXは必ず画像モードで起動する
          if (!guardLimit(RELOAD_LOG_KEY, location.pathname, 1, 15000)) {
            try {
              location.reload();
            } catch {
              /* noop */
            }
          }
          return;
        }
        verifyTimer = setTimeout(tick, 1200);
        return;
      }
      // unknown: タブがまだ描画されていないだけの可能性があるので、しばらく待つ
      if (step <= 8) verifyTimer = setTimeout(tick, 800);
    };

    verifyTimer = setTimeout(tick, 900);
  }

  /** 現在のURLが対象なら画像モードへ寄せる */
  function enforcePhotoMode() {
    if (!shouldEnforceUrl(location.href)) return;
    const target = withPhotoFilter(location.href);
    if (target && target !== location.href) {
      try {
        // アドレスバーだけ先に直し、popstate でXにURLを読み直させる(速い経路)
        history.replaceState(history.state, "", target);
        // Xの pushState 処理が終わってから発火させる(同期発火だとXに上書きされる)
        setTimeout(() => {
          window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        }, 0);
      } catch {
        /* noop */
      }
    }
    scheduleVerify();
  }

  /* ------------------------------------------------------------------ *
   * SPA内部遷移の横取り
   * ------------------------------------------------------------------ */
  function wrapHistoryFn(name) {
    const orig = history[name];
    if (typeof orig !== "function") return;
    history[name] = function (state, title, url) {
      try {
        if (url && shouldEnforceUrl(String(url))) {
          const rewritten = withPhotoFilter(String(url));
          if (rewritten) {
            const ret = orig.call(this, state, title, rewritten);
            // Xの遷移処理が完了してから発火させる(同期発火だとXに上書きされる)
            setTimeout(() => {
              window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
            }, 0);
            scheduleVerify();
            return ret;
          }
        }
      } catch {
        /* 書き換えに失敗したら通常動作にフォールバック */
      }
      return orig.call(this, state, title, url);
    };
  }
  wrapHistoryFn("pushState");
  wrapHistoryFn("replaceState");

  // 戻る/進む
  window.addEventListener("popstate", () => {
    enforcePhotoMode();
  });

  // bfcache から復帰したとき
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) fixup();
  });

  /* ------------------------------------------------------------------ *
   * 初回ロード
   * ------------------------------------------------------------------ */
  // その場書き換え(replaceState)はXの起動と競合するため、
  // 初回は「本当のナビゲーション」で正規化する。こうすればXは必ず
  // ?filter=photo 付きのURLで起動するので、注入タイミングに依存しない。
  (function normalizeOnLoad() {
    const cur = parseMedia(location.href);
    if (!cur || cur.filter) return;
    const target = withPhotoFilter(location.href);
    if (!target) return;
    if (guardLimit(REPLACE_LOG_KEY, location.pathname, 3, 10000)) return;
    try {
      location.replace(target);
    } catch {
      /* noop */
    }
  })();

  /* ------------------------------------------------------------------ *
   * 後発修正(ナビゲーションが何らかの理由で効かなかった場合の保険)
   * ------------------------------------------------------------------ */
  function fixup() {
    const cur = parseMedia(location.href);
    if (cur && !cur.filter) enforcePhotoMode();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fixup, { once: true });
  } else {
    fixup();
  }
})();
