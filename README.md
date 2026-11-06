# @panphora/clay-agent

Let AI agents read and edit your [Hyperclay](https://hyperclay.com) documents, from the command line or as an MCP server for Claude Code, Claude Desktop and Cursor.

> Works with hyperclay.com. Support for the HTML Clay and Hyperclay Local desktop apps comes in a later version.

## How it works

You make an **agent key** in the Hyperclay dashboard (account menu, **Agent keys…**; see [the docs](https://hyperclay.com/docs/agents/)): a named key that can be limited to one team or folder, and to reading, changing content, or full editing. You can revoke it at any time. The agent acts as you, with no more access than you have, and every change it makes to a document is kept in the document's version history as "Recorded by you through <key name>", so any change can be restored.

Every change to a document's content is based on the version the agent read. If the document changed in the meantime, the write is refused and the agent is told to read it again. Nothing is merged or overwritten silently.

## Sign in

```bash
npx -y @panphora/clay-agent login
```

Paste the key when asked. It is saved in `~/.config/clay-agent/credentials.json`, readable only by you. The key is never accepted as a command-line argument (it would end up in your shell history), and it is never printed. `CLAY_AGENT_KEY` works instead of a saved key.

```bash
npx -y @panphora/clay-agent status
npx -y @panphora/clay-agent logout
```

## Use it as an MCP server

Claude Code:

```bash
claude mcp add clay -- npx -y @panphora/clay-agent mcp
```

Claude Desktop and Cursor (`claude_desktop_config.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "clay": { "command": "npx", "args": ["-y", "@panphora/clay-agent", "mcp"] }
  }
}
```

If Node is installed through nvm, use the absolute path to `npx` (`which npx`) as the command.

Options: `mcp --read-only` offers only the reading tools.

### Tools

| Tool | What it does |
|---|---|
| `list_documents` | Documents the key can reach |
| `read_document` | The whole document when small; otherwise an outline, or the parts you select (`select` by CSS selector, `range` by offset) |
| `outline_document` | The element tree with selector paths and sizes |
| `find_in_document` | Where some text appears, with the element around it |
| `read_data` | The page's structured data, through its `api` rules |
| `write_data` | Change that data |
| `edit_document` | Replace exact text in the version read; each match must be unique |
| `save_document` | Save a whole document |
| `list_versions`, `read_version`, `restore_version` | Version history |
| `claim_subdomain` | Give a document its public address at `<name>.hyperclay.com`. Version history can't undo it, and a different name takes the dashboard |

Large documents (up to 5 MB) are read in pieces: an outline first, then the parts the agent needs, and small changes go through `edit_document`.

## Use it from the command line

```bash
clay-agent list
clay-agent read hyperclay:123 --outline
clay-agent read hyperclay:123 --select 'main > section'
clay-agent edit hyperclay:123 --find 'Draft' --replace 'Final' --if-match <etag>
clay-agent versions hyperclay:123
clay-agent subdomain hyperclay:123 my-tool
```

A document is `hyperclay:<id>` or its hyperclay.com URL. Content changes need `--if-match` with the etag from a read. Add `--json` to any command for machine-readable output.

Exit codes: `0` done, `1` refused or failed, `2` the document changed since it was read (the current etag is printed), `3` the host is not reachable, `4` not signed in, or the key is malformed, revoked or expired, `5` the host may or may not have saved the write (read the document before trying again).

Needs Node 20.18.1 or later.

## License

MIT
