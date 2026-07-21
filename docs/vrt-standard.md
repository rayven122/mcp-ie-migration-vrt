# IE migration VRT standard

The machine-readable source of truth is [`config/vrt-standard.json`](../config/vrt-standard.json).

## Default capture contract

- Viewport: `1200 x 650` CSS pixels (`windows-rdp`)
- Comparison: `maxDiffPixelRatio=0.005`, `threshold=0.2` (`ie-migration`)
- Page viewport only; browser chrome excluded
- Scroll position `(0, 0)` unless the checkpoint explicitly says otherwise
- Browser zoom and Windows display scale fixed at 100%
- Images with different dimensions fail; they are never resized

Use `large-desktop` (`1440 x 900`) only when the interactive Windows desktop can contain the outer browser windows without clipping. Use `pixel-strict` only for controlled fixtures or intentional-difference tests.

## Required checkpoint set

Select only checkpoints that exist in the target application. Before capture, record the URL, user role, test record, selected tab, filters, dialog state, scroll position, and any authorized action used to reach the state.

The standard IDs are `initial-load`, `authenticated-home`, `search-results`, `detail-view`, `edit-form`, `validation-error`, `dialog-open`, `post-action`, `empty-state`, and `scroll-section`.

Both sessions must represent the same business state. Locator and navigation steps may differ. Do not save, submit, delete, approve, or send anything unless the test action is explicitly authorized.
