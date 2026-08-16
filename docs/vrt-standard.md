# IE migration VRT standard

The machine-readable source of truth is [`config/vrt-standard.json`](../config/vrt-standard.json).

## Default capture contract

- Viewport: `1200 x 650` CSS pixels (`windows-rdp`)
- Comparison: `maxDiffPixelRatio=0.005`, `threshold=0.2` (`ie-migration`)
- Page viewport only; browser chrome excluded
- Scroll position `(0, 0)` unless the checkpoint explicitly says otherwise
- Browser zoom and Windows display scale fixed at 100%
- Images are never resized or cropped. Different dimensions produce a diff for AI review instead of a tool error
- `vrt.returnImages` defaults to `all`, returning the IE image, Edge image, and generated diff directly to the AI

Use `large-desktop` (`1440 x 900`) only when the interactive Windows desktop can contain the outer browser windows without clipping. Use `pixel-strict` only for controlled fixtures or intentional-difference tests.

## AI review of differences

`vrt` returns `status: "different"` for pixel or image-dimension differences. This is a review result, not a tool execution error. The response includes the requested viewport, raw PNG dimensions, document mode, viewport and overflow measurements, DPI information, and the artifact paths.

By default, the MCP response also contains labeled `before`, `after`, and `diff` PNG image blocks. Review all three images together. A narrow red band at an outer edge can be caused by an IE Driver border or scrollbar, but it must not be ignored solely because it is red. Confirm that the source images and diagnostics show only an environment-specific edge difference and no displaced, hidden, or clipped application content.

Use `returnImages: "diff"` to return only a generated diff, or `returnImages: "none"` when artifact paths and structured evidence are sufficient. A passing comparison has no diff image.

Invalid sessions, WebDriver failures, Playwright failures that do not produce a comparison diff, and file I/O failures remain tool execution errors (`isError: true`).

## Required checkpoint set

Select only checkpoints that exist in the target application. Before capture, record the URL, user role, test record, selected tab, filters, dialog state, scroll position, and any authorized action used to reach the state.

The standard IDs are `initial-load`, `authenticated-home`, `search-results`, `detail-view`, `edit-form`, `validation-error`, `dialog-open`, `post-action`, `empty-state`, and `scroll-section`.

Both sessions must represent the same business state. Locator and navigation steps may differ. Do not save, submit, delete, approve, or send anything unless the test action is explicitly authorized.
