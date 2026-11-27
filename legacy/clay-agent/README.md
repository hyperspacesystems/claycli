# @panphora/clay-agent

**Clay Agent is now Clay CLI: [`@panphora/claycli`](https://www.npmjs.com/package/@panphora/claycli), at [claycli.com](https://claycli.com).**

This name keeps working. The package passes every command to `@panphora/claycli` at the same version, and it is published again with each release, so `npx -y @panphora/clay-agent ...` stays current. A saved key, `CLAY_AGENT_KEY` and an existing MCP entry all keep working with no change.

For new setups, use the new name:

```bash
npx -y @panphora/claycli login
claude mcp add clay -- npx -y @panphora/claycli mcp
```

## License

MIT
