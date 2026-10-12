import type { ServerLaunch } from "./launch.js";

// Starts the installed server the way an app would, negotiates, lists tools,
// and calls the harmless ping tool. This proves the executable works; it does
// not prove that a GUI app has loaded its config entry.

export type ProbeResult = {
  ok: boolean;
  duration_ms: number;
  tools: number;
  protocol_era: string | null;
  server_version: string | null;
  detail: string;
};

export async function probeServer(launch: ServerLaunch, options: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ProbeResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/client/stdio");
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: { ...getDefaultEnvironment(), ...options.env },
    stderr: "pipe"
  });
  const client = new Client({ name: "dialogues-setup-probe", version: "1.0.0" });
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      await client.connect(transport);
      const tools = await client.listTools();
      const ping = await client.callTool({ name: "ping", arguments: { message: "setup-probe" } });
      if (ping.isError) throw new Error("ping tool returned an error");
      return { tools: tools.tools.length };
    })();
    const result = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      })
    ]);
    return {
      ok: true,
      duration_ms: Date.now() - started,
      tools: result.tools,
      protocol_era: client.getProtocolEra() ?? null,
      server_version: client.getServerVersion()?.version ?? null,
      detail: `Server started and answered (${result.tools} tools).`
    };
  } catch (error) {
    return {
      ok: false,
      duration_ms: Date.now() - started,
      tools: 0,
      protocol_era: null,
      server_version: null,
      detail: `Server check failed: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (timer) clearTimeout(timer);
    // Closing stdin lets the server exit; close() also reaps the child.
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
