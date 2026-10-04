#!/usr/bin/env node
// An external Codex boundary: plugin inventory and its versioned native config API.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const home = process.env.CODEX_HOME;
const file = path.join(home, "fixture.json");
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (state) => fs.writeFileSync(file, JSON.stringify(state));
const args = process.argv.slice(2);
if (args[0] === "plugin" && args[1] === "list") {
  console.log(JSON.stringify({ installed: read().plugins, available: read().available ?? [] }));
} else if (args[0] === "app-server") {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const state = read();
    let result = {};
    let error;
    if (request.method === "config/read") {
      result = {
        config: { ...state.config, ...(state.override ?? {}) }, origins: {},
        layers: [{ name: { type: "user", file: path.join(home, "config.toml"), profile: null },
          version: String(state.version), config: state.config },
          ...(state.override ? [{ name: { type: "project", dotCodexFolder: "/project/.codex" },
            version: "project", config: state.override }] : [])],
      };
    } else if (request.method === "config/batchWrite") {
      const p = request.params;
      if (state.race) {
        state.version++;
        state.config.model = "concurrent-edit";
        save(state);
      }
      if (p.filePath !== path.join(home, "config.toml") || p.expectedVersion !== String(state.version)) {
        error = { code: -32000, message: "configuration version conflict" };
      } else {
        if (p.edits.length !== 1 || p.edits[0].keyPath !== "mcp_servers.cross-agent" || p.edits[0].mergeStrategy !== "replace") {
          throw new Error("setup must edit only the cross-agent table");
        }
        const value = p.edits[0].value;
        state.config.mcp_servers ??= {};
        if (value === null) delete state.config.mcp_servers["cross-agent"];
        else state.config.mcp_servers["cross-agent"] = value;
        state.version++;
        state.writes = (state.writes ?? 0) + 1;
        save(state);
        result = { status: "ok", version: String(state.version), filePath: p.filePath };
      }
    } else if (request.method !== "initialize") {
      throw new Error(`unexpected native API method: ${request.method}`);
    }
    console.log(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }));
  }
} else {
  throw new Error(`unexpected Codex command: ${args.join(" ")}`);
}
