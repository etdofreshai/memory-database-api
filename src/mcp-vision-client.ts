import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * MCP Vision Client
 * 
 * Spawns @z_ai/mcp-server as a child process and communicates
 * via JSON-RPC 2.0 over stdio for image/video analysis.
 */

const MCP_INIT_TIMEOUT_MS = 30_000;
const MCP_CALL_TIMEOUT_MS = 300_000; // 5 minutes — Z.AI vision can take 90-120s, needs headroom
const MCP_IDLE_TIMEOUT_MS = 5 * 60_000; // Kill server after 5 min idle

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: any;
}

export class McpVisionClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = '';
  private initialized = false;
  private tools: McpToolInfo[] = [];
  private idleTimer: NodeJS.Timeout | null = null;

  /**
   * Start the MCP server process and initialize the protocol
   */
  async start(): Promise<void> {
    if (this.initialized) return;

    const apiKey = process.env.ZAI_TOKEN || process.env.Z_AI_API_KEY || process.env.Z_AI_TOKEN || process.env.z_ai_token;
    if (!apiKey) {
      throw new Error('ZAI_TOKEN / Z_AI_API_KEY not set for MCP vision server');
    }

    // @z_ai/mcp-server uses Z_AI_VISION_MODEL_MAX_TOKENS (max_tokens internally).
    // Accept max_output_tokens-style aliases too for convenience.
    const visionMaxTokens =
      process.env.Z_AI_VISION_MODEL_MAX_TOKENS ||
      process.env.Z_AI_VISION_MODEL_MAX_OUTPUT_TOKENS ||
      process.env.Z_AI_MCP_MAX_OUTPUT_TOKENS ||
      '32000';

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.kill();
        reject(new Error('MCP server startup timed out'));
      }, MCP_INIT_TIMEOUT_MS);

      try {
        this.process = spawn('npx', ['@z_ai/mcp-server'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            Z_AI_API_KEY: apiKey,
            ZAI_TOKEN: apiKey,
            Z_AI_MODE: 'ZAI',
            Z_AI_VISION_MODEL_MAX_TOKENS: visionMaxTokens,
          },
          shell: true,
        });

        this.process.stdout!.on('data', (data: Buffer) => {
          this.handleData(data.toString());
        });

        this.process.stderr!.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) console.log('[MCP-stderr]', msg);
        });

        this.process.on('error', (err) => {
          clearTimeout(timeout);
          console.error('[MCP] Process error:', err.message);
          this.cleanup();
          reject(err);
        });

        this.process.on('exit', (code) => {
          console.log(`[MCP] Process exited with code ${code}`);
          this.cleanup();
        });

        // Initialize protocol
        this.initializeProtocol().then(() => {
          clearTimeout(timeout);
          this.initialized = true;
          this.resetIdleTimer();
          resolve();
        }).catch((err) => {
          clearTimeout(timeout);
          this.kill();
          reject(err);
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  private async initializeProtocol(): Promise<void> {
    // Step 1: Initialize
    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memory-db', version: '1.0.0' },
    });
    console.log('[MCP] Initialized:', JSON.stringify(initResult).substring(0, 200));

    // Send initialized notification (no id = notification)
    this.sendNotification('notifications/initialized');

    // Step 2: List tools
    const toolsResult = await this.sendRequest('tools/list', {});
    this.tools = toolsResult?.tools || [];
    console.log('[MCP] Available tools:', this.tools.map(t => t.name).join(', '));
  }

  /**
   * Analyze an image file
   */
  async analyzeImage(filePath: string, prompt?: string): Promise<string> {
    await this.ensureStarted();
    this.resetIdleTimer();

    // Try known tool names for image analysis
    const toolName = this.findTool(['image_analysis', 'analyze_image', 'vision']);
    if (!toolName) {
      throw new Error(`No image analysis tool found. Available: ${this.tools.map(t => t.name).join(', ')}`);
    }

    const args: any = {};
    // Try to match the tool's input schema
    const tool = this.tools.find(t => t.name === toolName);
    const schema = tool?.inputSchema?.properties || {};

    // Common parameter names for image path
    if ('image_source' in schema) args.image_source = filePath;
    else if ('image_path' in schema) args.image_path = filePath;
    else if ('file_path' in schema) args.file_path = filePath;
    else if ('path' in schema) args.path = filePath;
    else if ('image' in schema) args.image = filePath;
    else if ('url' in schema) args.url = filePath;
    else args.image_source = filePath; // default for z.ai MCP server

    if (prompt) {
      if ('prompt' in schema) args.prompt = prompt;
      else if ('question' in schema) args.question = prompt;
    }

    const result = await this.callTool(toolName, args);
    return this.extractTextFromResult(result);
  }

  /**
   * Analyze a video file
   */
  async analyzeVideo(filePath: string, prompt?: string): Promise<string> {
    await this.ensureStarted();
    this.resetIdleTimer();

    const toolName = this.findTool(['video_analysis', 'analyze_video']);
    if (!toolName) {
      // Fall back to image analysis if no video-specific tool
      console.log('[MCP] No video tool found, falling back to image analysis');
      return this.analyzeImage(filePath, prompt);
    }

    const args: any = {};
    const tool = this.tools.find(t => t.name === toolName);
    const schema = tool?.inputSchema?.properties || {};

    if ('video_source' in schema) args.video_source = filePath;
    else if ('video_path' in schema) args.video_path = filePath;
    else if ('file_path' in schema) args.file_path = filePath;
    else if ('path' in schema) args.path = filePath;
    else args.video_source = filePath;

    if (prompt) {
      if ('prompt' in schema) args.prompt = prompt;
      else if ('question' in schema) args.question = prompt;
    }

    const result = await this.callTool(toolName, args);
    return this.extractTextFromResult(result);
  }

  /**
   * Call an MCP tool by name
   */
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    return this.sendRequest('tools/call', { name, arguments: args });
  }

  private findTool(candidates: string[]): string | null {
    for (const name of candidates) {
      if (this.tools.some(t => t.name === name)) return name;
    }
    // Fuzzy match
    for (const candidate of candidates) {
      const match = this.tools.find(t => t.name.toLowerCase().includes(candidate.toLowerCase()));
      if (match) return match.name;
    }
    // Return first tool if only one exists
    if (this.tools.length === 1) return this.tools[0].name;
    return null;
  }

  private extractTextFromResult(result: any): string {
    if (!result) return '';
    // MCP tool results come as { content: [{ type: 'text', text: '...' }] }
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
    }
    if (typeof result === 'string') return result;
    if (result.text) return result.text;
    return JSON.stringify(result);
  }

  private async ensureStarted(): Promise<void> {
    if (!this.initialized || !this.process || this.process.killed) {
      this.initialized = false;
      await this.start();
    }
  }

  private sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeoutMs = method === 'initialize' ? MCP_INIT_TIMEOUT_MS : MCP_CALL_TIMEOUT_MS;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      const line = JSON.stringify(request) + '\n';

      if (!this.process?.stdin?.writable) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error('MCP server stdin not writable'));
        return;
      }

      this.process.stdin.write(line);
    });
  }

  private sendNotification(method: string, params?: any): void {
    const notification = { jsonrpc: '2.0' as const, method, ...(params ? { params } : {}) };
    const line = JSON.stringify(notification) + '\n';
    this.process?.stdin?.write(line);
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Not JSON, ignore (could be debug output)
      }
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      console.log('[MCP] Idle timeout, killing server');
      this.kill();
    }, MCP_IDLE_TIMEOUT_MS);
  }

  private cleanup(): void {
    this.initialized = false;
    this.process = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP server disconnected'));
    }
    this.pendingRequests.clear();
  }

  kill(): void {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
    }
    this.cleanup();
  }

  getTools(): McpToolInfo[] {
    return [...this.tools];
  }

  isRunning(): boolean {
    return this.initialized && !!this.process && !this.process.killed;
  }
}

// Singleton instance
let instance: McpVisionClient | null = null;

export function getMcpVisionClient(): McpVisionClient {
  if (!instance) {
    instance = new McpVisionClient();
  }
  return instance;
}

export function shutdownMcpVisionClient(): void {
  if (instance) {
    instance.kill();
    instance = null;
  }
}
