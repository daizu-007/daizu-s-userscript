# X(Twitter) メディア欄 動画/画像モード DOM調査レポート

調査日: 2026-08-20 / Edge 151 (CDP接続) で確認

## 仕様概要

- プロフィールのタブ構成が変更され、旧「メディア」タブは **「動画」タブ(ドロップダウン付き)** になった
- プロフィール直下ではタブのラベルは「メディア」(href=`/{user}/media`)、メディア欄内では「動画」または「画像」+ ▼矢印
- ドロップダウンメニューで **動画 / 画像** を切り替え可能。既定は「動画」

## URLスキーマ(最重要発見)

| URL | モード |
|---|---|
| `/{user}/media` | 動画モード(既定) |
| `/{user}/media?filter=photo` | 画像モード |

- 直接アクセスでもそのまま開く(自分のプロフィール・他ユーザー双方で確認)
- 動画モードには `?filter=video` のようなパラメータは付かない(素の `/media`)

## DOM構造

### タブ
```
div[role="tablist"]
 └─ a[role="tab"] href="/{user}"            (ポスト)      ← 新仕様ではこれも aria-haspopup="menu" を持つ!
 └─ a[role="tab"] href="/{user}/with_replies"(返信)
 └─ a[role="tab"] href="/{user}/reposts"     (リポスト)
 └─ a[role="tab"] href="/{user}/media"       (動画/画像)
      属性: aria-haspopup="menu" aria-expanded="true/false" aria-selected="true"
      末尾に▼のsvg
```

⚠️ **注意**: 「ポスト」タブにも `aria-haspopup="menu"` があるため、
`[role="tab"][aria-haspopup="menu"]` というセレクタだけではメディアタブを特定できない。
**href の pathname が `/media` で終わるか**で判定する必要がある。

### ドロップダウンメニュー
```
div[role="menu"]
 ├─ div[role="menuitem"]  「動画」 ← 選択中はチェックマークsvg(path d="M9.64 18.952...")付き
 └─ div[role="menuitem"]  「画像」
```
- メニュー項目は `div[role="menuitem"]`、テキストはラベルのみ
- 選択中の項目にだけチェックマークの `<svg>` が入る
- コンテナに `data-testid="Dropdown"`(タブ側ラッパー)

### タイムライン本体
- グリッドの各セル: `div[data-testid="cellInnerDiv"]` (従来通り)

## Xのルータの挙動(userscript実装上の制約)

検証して分かったこと:

1. **a要素の href を `?filter=photo` 付きに書き換えても無効** —
   クリック時にXのSPAルータがURLを正規化し、素の `/media` に戻される
2. **history.pushState / replaceState の引数を書き換えても無効** —
   アドレスバーは変わるが、Xは内部stateで描画するため動画モードのまま
3. 有効な手段は次の2つ:
   - **リダイレクト**: `location.replace(url + '?filter=photo')` (ページ読み込み時)
   - **ドロップダウンのプログラムクリック**: タブ.click() → メニュー表示 → 「画像」menuitem.click() (SPA遷移時)
4. 選択済みタブの `.click()` はナビゲーションではなくドロップダウンを開く

## userscriptの設計(`x-media-photo-default.user.js`)

- **ケース1(直接読み込み/リロード)**: document-start で即 `location.replace` → 描画前に画像モードへ
  (`location.replace` は履歴エントリを増やさないためここは問題なし)
- **ケース2(SPA遷移)**: history API ラップで `/media` 到着を検知 → ドロップダウンをプログラム操作して「画像」へ
- **ユーザーの意図の尊重**: 画像モードから自分で「動画」メニューを選んだ場合は妨害しない
  (タブ単位のセッション中は動画のまま。リロード・新規タブでは再び画像優先)
- **履歴のクリーンアップ**: 自動切替の際、Xは「動画→画像」で `pushState` を2回発行し、
  戻る操作で動画タブを挾んでしまう。そこで自動切替中(`switching`)に発行された
  `pushState` は `replaceState` に変換し、動画エントリを画像で上書きする。
  これによりメディア欄の履歴エントリは1つだけになり、戻るで動画を挾まない

### 検証結果(Playwright + addInitScript でdocument-start注入を再現)

| ケース | 結果 |
|---|---|
| `/media` 直接アクセス | ✅ `?filter=photo` にリダイレクト、画像表示 |
| プロフィール→メディアタブ(SPA遷移) | ✅ 自動で画像モードに切替 |
| 自分で「動画」を選択 | ✅ 動画のまま維持(暴走しない) |
| 別ユーザー(NASA)のメディア | ✅ 画像モード |
| リロード / 戻るボタン | ✅ 画像モード |
| 自動切替後に「戻る」 | ✅ 動画を挾まず直接前ページへ(history増分 2→1) |

## 実装上ハマった点

- `[role="tab"][aria-haspopup="menu"]` のみでタブを選ぶと「ポスト」タブにマッチし、
  クリックでプロフィールへ戻される事故が起きた → href 判定を追加して解決
- 自動切替の完了前に history ラップの回调が走ると状態(`lastMedia`)が更新されず、
  「ユーザーが動画を選んだ」判定が破綻する → switching 中も状態更新するよう修正
- 自動切替で「動画」「画像」の2エントリが履歴に積まれ、戻るで動画を挾む問題 →
  switching 中の `pushState` を `replaceState` に変換して動画エントリを上書きし解決

## ファイル一覧

- `x-media-photo-default.user.js` — 完成品userscript
- `verify-userscript.cjs` / `verify-edge.cjs` — 検証ハーネス
- `out-tabs.json` / `out-menu.json` / `out-menuitems.json` — DOMダンプ
