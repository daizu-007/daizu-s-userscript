// ==UserScript==
// @name         Open photos by default in the Twitter media tab
// @namespace    https://x.com/
// @version      1.2.0
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

  // プロフィールのメディアページ: /{screen_name}/media
  const MEDIA_PATH_RE = /^\/([A-Za-z0-9_]{1,20})\/media\/?$/;

  // メニューの「動画」項目の検出用(日本語/英語ほか)
  const VIDEO_ITEM_RE = /(?:動画|ビデオ|video|vidéo)/i;

  let videoMenuClickedAt = 0; // 直近でメニューの「動画」をクリックした時刻

  function isMediaPage(url) {
    if (!url) return false;
    try {
      const u = new URL(url, location.origin);
      return MEDIA_PATH_RE.test(u.pathname);
    } catch {
      return false;
    }
  }

  // フィルタ指定のないメディアページなら ?filter=photo を付けたURLを返す(なければ null)
  function withPhotoFilter(url) {
    try {
      const u = new URL(url, location.origin);
      if (!MEDIA_PATH_RE.test(u.pathname)) return null;
      if (u.searchParams.has("filter")) return null;
      u.searchParams.set("filter", "photo");
      return u.href;
    } catch {
      return null;
    }
  }

  // URLを書き換えて SPA に再描画させる
  function rewriteAndNotify(newHref) {
    history.replaceState(history.state, "", newHref);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }

  // メニューの「動画」クリックを検出(通常の動画表示を妨げないため)
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      const item = t && t.closest ? t.closest('[role="menuitem"]') : null;
      if (item && VIDEO_ITEM_RE.test((item.textContent || "").trim())) {
        videoMenuClickedAt = Date.now();
      }
    },
    true
  );

  // --- SPA 内部遷移の横取り ---
  // メニューの「動画」選択(直前1.2秒以内のクリック)以外で
  // フィルタなしの /{user}/media に遷移しようとしたら ?filter=photo に書き換える
  function wrapHistoryFn(name) {
    const orig = history[name];
    if (typeof orig !== "function") return;
    history[name] = function (state, title, url) {
      try {
        if (
          url &&
          isMediaPage(String(new URL(url, location.origin))) &&
          Date.now() - videoMenuClickedAt > 1200
        ) {
          const rewritten = withPhotoFilter(url);
          if (rewritten) {
            url = rewritten;
            const ret = orig.call(this, state, title, url);
            setTimeout(() => {
              window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
            }, 0);
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

  // --- 初回ロード(document-start) ---
  // アプリが起動してルート解決する前にURLを ?filter=photo 付きに正規化
  {
    const rewritten = withPhotoFilter(location.href);
    if (rewritten) {
      history.replaceState(history.state, "", rewritten);
    }
  }

  // --- 念のための後発修正(スクリプト注入が遅れた場合など) ---
  function fixup() {
    if (isMediaPage(location.href) && !new URL(location.href).searchParams.has("filter")) {
      const rewritten = withPhotoFilter(location.href);
      if (rewritten) rewriteAndNotify(rewritten);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fixup, { once: true });
  } else {
    fixup();
  }
})();
