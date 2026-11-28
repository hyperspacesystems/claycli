# @panphora/claycli

Let AI agents read and edit [Hyperclay](https://hyperclay.com) HTML files and publish sites, from the command line or as an MCP server for Claude Code, Claude Desktop and Cursor.

> Works with hyperclay.com. Support for the HTML Clay and Hyperclay Local desktop apps comes in a later version.

## How it works

You make an **agent key** in the Hyperclay dashboard (account menu, **Agent keys…**; see [the docs](https://hyperclay.com/docs/agents/)): a named key that can be limited to one team or folder, and to reading, changing content, or full editing. You can revoke it at any time, and **Recent activity** in the Agent keys dialog shows what each key changed. The agent acts as you, with no more access than you have, and every change it makes to an HTML file is kept in the file's version history as "Recorded by you through <key name>", so any change can be restored.

With full editing, a key can also create and replace files and folders (pages, images, CSS and `site.json`), publish a local folder as a site, claim subdomains for HTML files and site folders, and add custom domains and read their status and DNS records. Every change to a file is based on the version the agent read: if it changed in the meantime, the write is refused and the agent is told to read it again, and a replaced file's old bytes are kept as a backup. Agents cannot delete, rename, move or share anything, cannot make a private page public, cannot remove a custom domain, and cannot change a subdomain once it is set.

## Sign in

```bash
npx -y @panphora/claycli login
```

Paste the key when asked. It is saved in `~/.config/claycli/credentials.json`, readable only by you. The key is never accepted as a command-line argument (it would end up in your shell history), and it is never printed. `CLAY_CLI_KEY` works instead of a saved key.

```bash
npx -y @panphora/claycli status
npx -y @panphora/claycli logout
```

## Use it as an MCP server

Claude Code:

```bash
claude mcp add clay -- npx -y @panphora/claycli mcp
```

Claude Desktop and Cursor (`claude_desktop_config.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "clay": { "command": "npx", "args": ["-y", "@panphora/claycli", "mcp"] }
  }
}
```

If Node is installed through nvm, use the absolute path to `npx` (`which npx`) as the command.

Options: `mcp --read-only` offers only the reading tools.

### Tools

| Tool | What it does |
|---|---|
| `list_documents` | HTML files the key can reach |
| `read_document` | The whole HTML file when small; otherwise an outline, or the parts you select (`select` by CSS selector, `range` by offset) |
| `outline_document` | The element tree with selector paths and sizes |
| `find_in_document` | Where some text appears, with the element around it |
| `read_data` | The page's structured data, through its `api` rules |
| `write_data` | Change that data |
| `edit_document` | Replace exact text in the version read; each match must be unique |
| `save_document` | Save a whole HTML file |
| `create_document` | Create a new HTML file at a path, such as `notes/plan.html`. Missing folders are created; refused if anything is already there |
| `list_versions`, `read_version`, `restore_version` | Version history |
| `claim_subdomain` | Give an HTML file or a site folder its public address at `<name>.hyperclay.com`. Version history can't undo it, and a different name takes the dashboard |
| `list_sites` | Site folders the key can reach (each a folder holding its own `site.json`), with each one's address, home page and page count |
| `list_files` | Folders, HTML files and other files under a folder, with an etag for each |
| `add_domain` | Add a custom domain to an HTML file or a site folder and answer the two DNS records to set. Agents can never remove a domain |
| `domain_status` | Each custom domain on an HTML file or a site folder, whether it is active, and the DNS records it needs |
| `publish_site` | Upload a local folder as a site. Sends only what changed, never deletes files that exist only on hyperclay.com (lists them as `remoteOnly`), and claims the subdomain last |

Large HTML files (up to 8 MB) are read in pieces: an outline first, then the parts the agent needs, and small changes go through `edit_document`.

## Use it from the command line

```bash
claycli list
claycli read hyperclay:123 --outline
claycli read hyperclay:123 --select 'main > section'
claycli edit hyperclay:123 --find 'Draft' --replace 'Final' --if-match <etag>
claycli create notes/plan.html --file ./plan.html
claycli versions hyperclay:123
claycli subdomain hyperclay:123 my-tool
claycli subdomain (<document> | --site <site>) <name> [--account <name>]
claycli sites [--account <name>] [--cursor <id>]
claycli files <path> [--account <name>] [--cursor <id>]
claycli domain add (<document> | --site <site>) <domain> [--also-www]
claycli domain status (<document> | --site <site>)
claycli publish <folder> <account folder> [--subdomain <name>] [--account <name>] [--dry-run]
```

Preview a site publish before sending anything, then run it again without `--dry-run`:

```bash
npx -y @panphora/claycli publish ./maya demos/maya --subdomain maya --dry-run
```

An HTML file is `hyperclay:<id>` or its hyperclay.com URL. A site folder (a folder holding its own `site.json`) is its path in your account such as `demos/maya`, its address, or `hyperclay:<folder id>`. Content changes need `--if-match` with the etag from a read. `publish` sends only what changed, never deletes files that exist only on hyperclay.com, and claims the subdomain last. Add `--json` to any command for machine-readable output.

Exit codes: `0` done, `1` refused or failed, `2` the file changed since it was read (the current etag is printed), `3` the host is not reachable, `4` not signed in, or the key is malformed, revoked or expired, `5` the host may or may not have saved the write (read the file before trying again).

Needs Node 20.18.1 or later.

## Renamed from Clay Agent

This package was `@panphora/clay-agent` through 0.7.0, with the command `clay-agent`. Nothing you set up under that name needs to change:

- `npx -y @panphora/clay-agent ...` keeps working. The old package passes every command to this one and is published again with each release, so it stays current.
- A key saved by `clay-agent login` still signs you in. New sign-ins are saved in `~/.config/claycli/`, and `logout` removes the key from both places.
- `CLAY_AGENT_KEY` and `CLAY_AGENT_URL` still work. `CLAY_CLI_KEY` and `CLAY_CLI_URL` win when both are set.
- An MCP entry named `clay` needs no edit.

## License

MIT
