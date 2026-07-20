---
name: ie-migration-vrt
description: Compare a legacy page rendered in Microsoft Edge IE mode with its migrated Chromium Edge page, diagnose visual differences, fix the migrated implementation, and repeat VRT. Use when working on IE-to-Edge migrations with the mcp-ie-migration-vrt MCP server, especially when both browser sessions must be operated into equivalent UI states before screenshot comparison.
---

# IE Migration VRT

Use the `mcp-ie-migration-vrt` tools to keep the legacy and migrated pages in separate Selenium sessions. Treat the IE session as expected and the Chromium Edge session as actual.

## Workflow

1. Call `start_vrt_browsers` with the legacy and migrated URLs. Keep both returned session IDs.
2. Inspect each page through the accessibility resource or Selenium read tools. Always pass the intended `sessionId`.
3. Operate each session independently until both represent the same business state. Do not assume the locators or navigation steps are identical.
4. Wait for asynchronous content, fonts, and layout to settle. Avoid comparing loading indicators or transient animations.
5. Call `vrt` with `beforeSessionId`, `afterSessionId`, a stable checkpoint name, and the agreed viewport.
6. If the result is `different`, inspect the diff image, then inspect the Chromium page DOM and computed styles. Modify only the migrated implementation.
7. Reload or navigate the after session back to the checkpoint and call `vrt` again. Repeat until it passes or a genuine intended design difference is identified.
8. Close both sessions explicitly.

Read [capture-contract.md](references/capture-contract.md) before changing viewport, zoom, scrolling, masking, or comparison thresholds.

## Safety

- Do not submit, save, delete, approve, send, or trigger external actions unless the user explicitly authorizes that mutation.
- Use stable test data and reproduce the same state in both sessions.
- Do not resize screenshots to force equal dimensions. Fix the capture state instead.
- Do not update the IE expectation merely to make a failure pass.

## Failure handling

- If `start_vrt_browsers` fails, confirm Windows, IEDriverServer, Edge IE mode policy, and the Enterprise Mode Site List.
- If capture dimensions differ, restore the configured viewport and browser zoom before retrying.
- If differences are limited to font antialiasing, adjust the threshold only after confirming there is no layout or typography regression.
