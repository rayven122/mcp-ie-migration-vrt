# MCP IE Migration VRT

Edge IEモードで表示した移行前画面と、Chromium Edgeで表示した移行後画面を、2つの独立したSeleniumセッションで操作・撮影し、Playwright Testで画像比較するMCPサーバーです。

`rayven122/mcp-selenium`を基盤に、全ブラウザToolの複数セッション対応とIE移行VRTを追加しています。

## 仕組み

```text
beforeSessionId                         afterSessionId
Selenium + Edge IE mode                Selenium + Chromium Edge
        │                                      │
        └──────── page viewport PNG ───────────┘
                               │
                         Playwright Test
                               │
                    pass / diff PNG / report
```

- ブラウザ操作と撮影: Selenium WebDriver
- IEレンダリング: IEDriverServer + Edge IEモード
- Chromiumレンダリング: EdgeDriver + Microsoft Edge
- VRT比較: Playwright Test `toMatchSnapshot`
- ブラウザのタブ、アドレスバー、タイトルバーは撮影対象外

## 必要環境

- Windows 10/11またはWindows Server
- Node.js 18以上
- Microsoft Edge Stable
- IEDriverServer 4.0.0.0以上を`PATH`へ追加
- Edge IEモードとEnterprise Mode Site Listの設定
- 移行前URLが実際にIEモードで開くこと

IEモードはheadless実行できません。RDPで利用する場合は、撮影中に解像度、Windows表示倍率、Edgeズームを変更しないでください。

## インストール

### ローカルクローン

```powershell
git clone https://github.com/rayven122/mcp-ie-migration-vrt.git
cd mcp-ie-migration-vrt
npm install
npm test
```

Claude Codeへ追加:

```powershell
claude mcp add ie-migration-vrt -- node C:\absolute\path\mcp-ie-migration-vrt\src\lib\server.js
```

Claude DesktopなどのMCP設定:

```json
{
  "mcpServers": {
    "ie-migration-vrt": {
      "command": "node",
      "args": [
        "C:\\absolute\\path\\mcp-ie-migration-vrt\\src\\lib\\server.js"
      ],
      "env": {
        "MCP_VRT_ARTIFACT_DIR": "C:\\work\\vrt-artifacts"
      }
    }
  }
}
```

## Skillのインストール

Skillは[skills/ie-migration-vrt](skills/ie-migration-vrt)に含まれています。

プロジェクト単位で使用する場合:

```powershell
Copy-Item -Recurse skills\ie-migration-vrt C:\path\to\target-project\.claude\skills\
```

Codexで共通利用する場合:

```powershell
Copy-Item -Recurse skills\ie-migration-vrt $env:USERPROFILE\.agents\skills\
```

依頼例:

```text
$ie-migration-vrt を使って、移行前の注文一覧と移行後の注文一覧を同じ検索結果まで操作し、差分を修正してください。
```

## 基本的な使い方

### 1. 2つのブラウザを同時に起動

`start_vrt_browsers`:

```json
{
  "beforeUrl": "https://legacy.example.local/orders",
  "afterUrl": "https://new.example.local/orders",
  "width": 1440,
  "height": 900
}
```

返却例:

```json
{
  "beforeSessionId": "edge-ie_...",
  "afterSessionId": "edge_...",
  "captureContract": {
    "width": 1440,
    "height": 900,
    "mode": "viewport",
    "browserChrome": false,
    "allowImageResize": false
  }
}
```

### 2. 各セッションを個別に操作

移行前の検索欄へ入力:

```json
{
  "sessionId": "edge-ie_...",
  "by": "id",
  "value": "orderNo",
  "text": "A-1001"
}
```

移行後の検索欄へ入力:

```json
{
  "sessionId": "edge_...",
  "by": "css",
  "value": "[data-testid='order-number']",
  "text": "A-1001"
}
```

`navigate`、`interact`、`send_keys`、`frame`、`window`など、既存の全Selenium Toolで`sessionId`を指定できます。省略した場合は直近に起動したセッションを使用しますが、VRT中は明示指定を推奨します。

### 3. 現在の画面を比較

両画面を同じ業務状態まで操作してから`vrt`を呼び出します。

```json
{
  "beforeSessionId": "edge-ie_...",
  "afterSessionId": "edge_...",
  "name": "order-search-result",
  "width": 1440,
  "height": 900,
  "maxDiffPixelRatio": 0.005,
  "threshold": 0.2
}
```

成果物:

```text
artifacts/vrt/order-search-result/<timestamp>/
├── before.png
├── after.png
├── baseline/expected.png
├── report.json
└── test-results/
    └── ...-diff.png
```

差分修正後はafterセッションを`navigate`または`execute_script`で再読み込みし、同じ`vrt`を再実行します。

## Tool一覧

| Tool | 用途 |
|---|---|
| `start_browser` | 単独ブラウザセッションを起動 |
| `start_vrt_browsers` | Edge IEモードとChromium Edgeを同時起動 |
| `navigate` | 指定セッションをURLへ移動 |
| `interact` | click、doubleclick、rightclick、hover |
| `send_keys` | 入力欄をクリアして文字入力 |
| `get_element_text` | 要素テキスト取得 |
| `get_element_attribute` | 属性取得 |
| `press_key` | キー入力 |
| `upload_file` | ファイル入力 |
| `take_screenshot` | 指定セッションを撮影 |
| `accessibility_snapshot` | 指定セッションの操作可能要素とテキスト構造を取得 |
| `execute_script` | JavaScript実行、スクロール、computed style確認 |
| `window` | ウィンドウ・タブ管理 |
| `frame` | iframe切り替え |
| `alert` | alert、confirm、prompt操作 |
| `add_cookie` / `get_cookies` / `delete_cookie` | Cookie管理 |
| `diagnostics` | console、JavaScript error、networkログ取得 |
| `vrt` | 2セッションの現在画面をPlaywright Testで比較 |
| `close_session` | 指定セッションを終了 |

## 撮影規約

`vrt`は比較前に以下を検証します。

- `window.innerWidth`と`window.innerHeight`を指定値へ調整
- 両画面を`scrollX=0`、`scrollY=0`へ移動
- Seleniumのpage screenshotでブラウザchromeを除外
- before/after PNGの縦横ピクセル数が完全一致
- 指定viewportとPNGサイズが完全一致
- サイズ不一致時は画像をリサイズせず失敗

IEとChromiumではフォント描画が異なるため、初期値は`maxDiffPixelRatio=0.005`、`threshold=0.2`です。閾値を変更する前にdiff画像を確認してください。

## 開発

```bash
npm install
npm run check
npm test
npm run audit
npm run pack:dry-run
```

テストにはChromeとChromeDriverが必要です。Edge IEモードの実機確認はWindows環境で行ってください。

## 環境変数

| 変数 | 説明 |
|---|---|
| `MCP_VRT_ARTIFACT_DIR` | VRT成果物の保存先。既定は`./artifacts/vrt` |
| `MCP_SELENIUM_SCREENSHOT_DIR` | 通常スクリーンショットの保存可能ルート |
| `MCP_SELENIUM_ALLOW_UNSAFE_BROWSER_ARGS` | 信頼できる環境でのみ、制限されたブラウザ引数を許可 |

## License

MIT
