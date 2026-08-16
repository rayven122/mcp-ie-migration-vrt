# Capture contract

Use the same contract for both sessions:

- Capture the page viewport only. Exclude Edge tabs, address bar, title bar, and other browser chrome.
- Include the web application's own header, navigation, content, and visible footer.
- Agree on a viewport that fits the Windows interactive desktop before starting both sessions. The proven RDP baseline is `1200 x 650` CSS pixels; use a larger viewport only when the desktop can contain it without clipping.
- Keep browser zoom at 100% and the Windows display scale fixed for the entire run.
- Start at scroll position `(0, 0)` unless the checkpoint explicitly requires another position.
- Use viewport capture by default. Use full-page capture only when both engines can produce the same document extent.
- Never normalize different pixel dimensions by resizing or cropping. Return the raw source images and the Playwright diff for AI review.
- Start with `maxDiffPixelRatio: 0.005` and `threshold: 0.2`. Change these only after reviewing real diff artifacts.

The `vrt` tool enforces viewport position and the no-resize/no-crop rule before invoking Playwright Test. Pixel-dimension differences return `status: "different"` with source images, a diff image, and capture diagnostics instead of a tool error.
