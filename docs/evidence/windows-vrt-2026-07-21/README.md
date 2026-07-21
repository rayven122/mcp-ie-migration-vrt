# Windows IE migration VRT evidence — 2026-07-21

Environment: Proxmox VM `worklens-wintest`, Windows 11 Enterprise Evaluation, Microsoft Edge 150, IIS + ASP.NET 4.8 VB.NET Web Forms.

Capture contract: 1200 × 650 CSS pixels, page viewport only, browser chrome excluded, no image resizing.

## Equivalent postback state

Both sessions clicked the ASP.NET server-side `IncrementButton`; `CounterValue` changed from `0` to `1` in both browsers.

- `01-edge-ie-mode-after-postback.png`: Edge IE mode (`documentMode=11`, Trident/7.0)
- `02-chromium-edge-after-postback.png`: Chromium Edge (`documentMode=null`)
- Playwright result: passed with `maxDiffPixelRatio=0.005`, `threshold=0.2`

## Intentional difference

The after URL used `?variant=different`, changing the action button from blue to red while keeping the postback state equivalent.

- `03-playwright-intentional-diff.png`: Playwright diff artifact
- `04-intentional-after-red-button.png`: Chromium Edge received image
- Playwright result: different, 8,200 pixels (approximately 2% of the image)

## Button layout shift

The migrated page applies an intentional `margin-left: 80px` to the action button while preserving its color and the postback state.

- `05-layout-shift-before.png`: Edge IE mode reference position
- `06-layout-shift-after-80px.png`: Chromium Edge with the button shifted 80px right
- `07-layout-shift-playwright-diff.png`: Playwright diff showing the old and new button regions
- Playwright result: different, 8,380 pixels (approximately 2% of the image)

Implementation commit: [`f991451`](https://github.com/rayven122/mcp-ie-migration-vrt/commit/f991451b504a6db6ed3b214d31eff6851363f2a5)
