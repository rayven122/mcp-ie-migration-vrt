# MCPB signing status

Production signing is intentionally not enabled with `@anthropic-ai/mcpb@2.1.2`.

The official format uses a PKCS#7 detached signature with a PEM X.509 code-signing certificate, matching private key, and optional intermediate certificates. However, the current CLI has two open upstream blockers:

- [modelcontextprotocol/mcpb#277](https://github.com/modelcontextprotocol/mcpb/issues/277): `mcpb verify` cannot verify signatures produced by `mcpb sign`.
- [modelcontextprotocol/mcpb#278](https://github.com/modelcontextprotocol/mcpb/issues/278): the appended signature makes the archive invalid for strict ZIP parsers, including Claude Desktop.

Do not sign Release assets until both issues are resolved in a published MCPB CLI and a signed bundle passes all of the following checks:

1. `mcpb sign` with the Rayven code-signing certificate.
2. `mcpb verify` succeeds in CI.
3. Claude Desktop for Windows previews and installs the signed bundle.
4. The installed extension starts and lists its MCP tools.
5. The unsigned artifact is not uploaded as the production Release asset.

Private keys must remain in the managed CI secret store. Never commit a PFX, PEM private key, password, or decoded temporary key file.
