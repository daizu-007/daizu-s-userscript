// ==UserScript==
// @name         Open photos by default in the Twitter media tab
// @namespace    https://x.com/
// @version      1.0.0
// @description  Videos now open by default in the Twitter media tab, so I'll make photos open by default instead.
// @author       daizu-007
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      Apache-2.0
// ==/UserScript==

(() => {
  'use strict';

  // ---------------------------------------------------------------
  // 仕様メモ(2026年時点の調査結果)
  // - メディアタブは「動画」が既定。タブに aria-haspopup="menu" の
  //   ドロップダウンがあり「動画 / 画像」を切り替えられる
  // - URLスキーマ:
  //     /{user}/media              → 動画モード(既定)
  //     /{user}/media?filter=photo → 画像モード
  //   直接アクセスでもそのまま開く(全ユーザーで有効)
  // - XのSPAルータは a要素のhref書き換えや pushState の引数書き換えを
  //   正規化して無視するため、URL制御は「リダイレクト」か
  //   「ドロップダウンのプログラムクリック」で行う必要がある
  // ---------------------------------------------------------------

  const MEDIA_RE = /^\/([^/]+)\/media(?:[?#].*)?$/;
  // パス部分判定用(hrefのpathnameはクエリを含まない)
  const MEDIA_PATH_RE = /^\/[^/]+\/media$/;
  // 「画像」メニュー項目のラベル(多言語フォールバック付き)
  const PHOTO_LABELS = new Set(['画像', 'Photos', 'Fotos', '照片', '사진']);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** URL(href)を解析し、メディア欄なら {user, filter} を返す */
  function parseMedia(href) {
    if (!href) return null;
    let u;
    try {
      u = new URL(href, location.origin);
    } catch {
      return null;
    }
    if (u.origin !== location.origin) return null;
    const m = u.pathname.match(MEDIA_RE);
    if (!m) return null;
    return { user: m[1].toLowerCase(), filter: u.searchParams.get('filter') };
  }

  // ===============================================================
  // ケース1: ページ直接読み込み(リロード・URL直打ち・外部リンク)
  // 描画前に即リダイレクトするのが最も確実で高速
  // ==============================================================
  const initial = parseMedia(location.href);
  if (initial && !initial.filter) {
    const u = new URL(location.href);
    u.searchParams.set('filter', 'photo');
    location.replace(u.href);
    return; // ここでの処理は不要
  }

  // ===============================================================
  // ケース2: SPA内遷移(プロフィール等からメディアタブをクリック)
  // Xが /media に遷移したのを検知したら、ドロップダウンを
  // プログラム操作して「画像」に切り替える
  // ===============================================================

  // 直前に見ていたメディア欄の状態(ユーザーによる意図的な「動画」選択を検出するため)
  let lastMedia = parseMedia(location.href);
  // このタブ(セッション)中にユーザーが自分で「動画」を選んだプロフィール
  const explicitVideo = new Set();
  let switching = false;

  /** メディアタブ(hrefが /{user}/media のタブ)を特定する */
  function findMediaTab() {
    for (const a of document.querySelectorAll('[role="tablist"] a[role="tab"]')) {
      const href = a.getAttribute('href') || '';
      try {
        const u = new URL(href, location.origin);
        if (MEDIA_PATH_RE.test(u.pathname) && a.getAttribute('aria-haspopup') === 'menu') {
          return a;
        }
      } catch {
        /* noop */
      }
    }
    return null;
  }

  /** ドロップダウンを開いて「画像」メニュー項目をクリックする */
  async function switchToPhoto() {
    if (switching) return;
    switching = true;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        // メディアタブ(ドロップダウン付き)が選択状態で描画されるまで待つ
        // ※ 新仕様では「ポスト」タブにも aria-haspopup="menu" があるため
        //   href でメディアタブを特定する必要がある
        const tab = findMediaTab();
        if (!tab || tab.getAttribute('aria-selected') !== 'true') {
          await sleep(300);
          continue;
        }
        // タブをクリックしてメニューを開く(選択済みタブはクリックでメニューが開く)
        tab.click();
        // メニュー項目「画像」を探す
        let item = null;
        for (let k = 0; k < 15; k++) {
          const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter((m) => {
            const r = m.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          for (const m of menus) {
            const items = Array.from(m.querySelectorAll('[role="menuitem"]'));
            // 優先: ラベル一致
            item = items.find((el) => PHOTO_LABELS.has(el.textContent.trim()));
            if (item) break;
            // フォールバック: 項目がちょうど2つで、1つ目(動画)にチェックマークの
            // svgが付いている = 動画モードのメディアメニューと判断して2つ目を選ぶ
            if (
              items.length === 2 &&
              items[0].querySelector('svg') &&
              !items[1].querySelector('svg')
            ) {
              item = items[1];
              break;
            }
          }
          if (item) break;
          await sleep(200);
        }
        if (item) {
          item.click();
          return;
        }
        // メニューが開かなかった場合は閉じてリトライ
        tab.click();
        await sleep(300);
      }
    } finally {
      switching = false;
    }
  }

  /** URLが変わるたびに呼ばれる */
  function onUrlChange() {
    const cur = parseMedia(location.href);

    if (cur && !cur.filter && !switching) {
      const sameUserWasPhoto =
        lastMedia && lastMedia.user === cur.user && lastMedia.filter === 'photo';

      if (sameUserWasPhoto) {
        // 画像モードから同じユーザーの素の /media へ → ユーザーが自分で
        // 「動画」メニューを選んだと判断し、尊重する(以降このセッション中は動画優先)
        explicitVideo.add(cur.user);
      } else if (!explicitVideo.has(cur.user)) {
        // それ以外の新規アクセス → 画像モードへ切り替える
        switchToPhoto();
      }
    }
    // switching 中(自動切替自身の pushState)も状態は更新する
    if (cur) lastMedia = cur;
  }

  // history API をラップしてSPA遷移を検知
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;

  history.pushState = function (...args) {
    // 自動切替中にXが発行したpushState(「画像」メニュー選択による遷移)は
    // replaceState に変換する。これにより「動画モード」の履歴エントリが
    // 「画像モード」で上書きされ、戻る操作で動画タブを挾まなくなる
    const fn = switching ? origReplaceState : origPushState;
    const ret = fn.apply(this, args);
    try {
      onUrlChange();
    } catch (e) {
      /* noop */
    }
    return ret;
  };
  history.replaceState = function (...args) {
    const ret = origReplaceState.apply(this, args);
    try {
      onUrlChange();
    } catch (e) {
      /* noop */
    }
    return ret;
  };
  // 戻る/進む操作
  window.addEventListener('popstate', () => {
    try {
      onUrlChange();
    } catch (e) {
      /* noop */
    }
  });
})();
