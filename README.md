# MCP IE Migration VRT

Edge IEモードの移行前画面とChromium Edgeの移行後画面を、2つのSeleniumセッションで操作・撮影し、Playwright Testで画像比較するMCPサーバーです。

```text
Edge IE mode ── Selenium screenshot ─┐
                                     ├─ Playwright VRT ─ pass / diff / report
Chromium Edge ─ Selenium screenshot ─┘
```

## 必要環境

- Windows 10/11またはWindows Server
- Microsoft Edge Stable
- Edge IEモードポリシー（`InternetExplorerIntegrationLevel=1`）
- IEDriverServer 4.0.0.0以上
- Node.js 20以上（Claude Desktop同梱ランタイム外で実行する場合）
- ログオン中の非昇格Windowsセッション
- Edge/IEズームとWindows表示倍率を100%に固定

IEモードはheadless実行できません。RDP利用中は、撮影の途中で解像度や表示倍率を変更しないでください。
IEDriverがEdgeをIEモードで起動するため、Enterprise Mode Site Listは必須ではありません。

事前診断:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\Test-IeMigrationVrtPrerequisites.ps1
```

## インストール

### 1. MCPBをインストール

[最新のGitHub Release](https://github.com/rayven122/mcp-ie-migration-vrt/releases/latest)から`.mcpb`をダウンロードし、Windows上で開いてClaude Desktopへインストールします。

保存先の初期設定は不要です。MCPBにはMCPサーバーと実行時依存関係が含まれます。

### 2. Skillをインストール

Claude Code:

```bash
npx skills add rayven122/mcp-ie-migration-vrt --agent claude-code
```

Codex:

```bash
npx skills add rayven122/mcp-ie-migration-vrt --agent codex
```

SkillはMCPBには含まれず、別途インストールされます。

## 使い方

エージェントへ次のように依頼します。

```text
$ie-migration-vrt を使って、移行前と移行後の注文一覧を同じ検索結果まで操作し、画面差分を確認してください。
```

エージェントは次の順に処理します。

1. `start_vrt_browsers`でEdge IEモードとChromium Edgeを起動
2. `sessionId`を指定して両画面を同じ業務状態まで個別に操作
3. `vrt`で現在の画面を比較
4. `before.png`、`after.png`、`diff.png`、`report.json`を保存
5. 必要に応じて移行後画面を修正し、再比較
6. 両セッションを終了

既定の比較条件:

- Viewport: `1200 x 650`
- `maxDiffPixelRatio`: `0.005`
- `threshold`: `0.2`
- ブラウザのタブやアドレスバーは撮影対象外
- 画像はリサイズ・トリミングせず、サイズが異なる場合も差分画像を生成してAIレビュー

詳細なチェックポイントと撮影規約は[`docs/vrt-standard.md`](docs/vrt-standard.md)を参照してください。MCPからは`vrt-standard://current`で取得できます。

## 主なMCP Tool

| Tool | 用途 |
|---|---|
| `start_vrt_browsers` | IEモードとChromium Edgeを同時起動 |
| `navigate` / `interact` / `send_keys` | 指定セッションを操作 |
| `accessibility_snapshot` | 画面構造と操作対象を取得 |
| `execute_script` | DOM・computed style・スクロールを確認 |
| `diagnostics` | console・JavaScript error・networkログを取得 |
| `vrt` | 2セッションの現在画面を比較し、既定でbefore・after・diff画像をAIへ返却 |
| `take_screenshot` | 現在画面を返すか、`outputPath`で指定した場所へ保存 |
| `close_session` | 指定セッションを終了 |

その他のSelenium Toolも`sessionId`を指定して利用できます。

## 補足

- Windows/IIS・ASP.NET 4.8・VB.NET Web Formsで動作確認済みです。
- VRT成果物は既定で相対パス`artifacts/vrt`へ保存されます。呼び出しごとに`vrt.outputDirectory`で変更できます。
- `vrt.returnImages`は`all`（既定）、`diff`、`none`から選択できます。寸法不一致はツールエラーではなく`status: "different"`として元画像・差分・診断情報を確認できます。
- 通常スクリーンショットは既定で画像データを直接返します。保存する場合だけ`take_screenshot.outputPath`を指定します。
- MCPB署名は公式CLIの既知不具合により保留中です。詳細は[`docs/mcpb-signing.md`](docs/mcpb-signing.md)を参照してください。
- 開発・ローカルビルドは[`package.json`](package.json)のnpm scriptsを参照してください。

## License

MIT
