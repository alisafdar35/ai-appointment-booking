import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for Mistral's chat-completions endpoint.
 *
 * The application's provider talks to it over real HTTP, so the request it
 * builds (auth header, tool definition, forced tool choice, message list) and
 * the way it reads the response are exercised exactly as in production. Each
 * test scripts the replies it wants; anything the app sends beyond the script
 * is answered with a 500 and counted, so an unexpected retry fails loudly.
 */

export interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    tools: { type: string; function: { name: string; parameters: { properties: Record<string, { enum?: string[] }> } } }[];
    tool_choice: string;
    temperature: number;
    max_tokens: number;
  };
}

export type StubReply =
  /** A tool call. A string is sent as-is, so a test can send malformed JSON. */
  | { kind: 'tool'; args: Record<string, unknown> | string; usage?: { prompt_tokens: number; completion_tokens: number } }
  /** The model ignores the forced tool choice and answers in prose. */
  | { kind: 'prose'; content: string }
  /** A well-formed response with no choices at all. */
  | { kind: 'empty' }
  /** An HTTP error, optionally with headers such as Retry-After. */
  | { kind: 'status'; status: number; body?: string; headers?: Record<string, string> }
  /** 200 OK, but the body is not JSON. */
  | { kind: 'garbage' }
  /** Accept the request and never answer. */
  | { kind: 'stall' };

export const TOOL_NAME = 'respond_to_booking_request';

export const tool = (args: Record<string, unknown> | string, usage?: { prompt_tokens: number; completion_tokens: number }): StubReply => ({
  kind: 'tool',
  args,
  ...(usage ? { usage } : {}),
});
export const failWith = (status: number, body = 'upstream error', headers?: Record<string, string>): StubReply => ({
  kind: 'status',
  status,
  body,
  ...(headers ? { headers } : {}),
});

export interface MistralStub {
  url: string;
  /** Every request received, oldest first. */
  requests: CapturedRequest[];
  /** Requests that arrived after the script ran out. */
  unscripted: number;
  /** Queue replies, served one per request in order. */
  enqueue(...replies: StubReply[]): void;
  reset(): void;
  stop(): Promise<void>;
}

export async function startMistralStub(): Promise<MistralStub> {
  const queue: StubReply[] = [];
  const stalled: ServerResponse[] = [];
  const stub: MistralStub = {
    url: '',
    requests: [],
    unscripted: 0,
    enqueue: (...replies) => void queue.push(...replies),
    reset() {
      queue.length = 0;
      stub.requests.length = 0;
      stub.unscripted = 0;
    },
    async stop() {
      for (const res of stalled) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as CapturedRequest['body'];
      stub.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });

      const reply = queue.shift();
      if (!reply) {
        stub.unscripted += 1;
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"message":"no scripted reply"}');
        return;
      }
      respond(res, reply, body.model);
    });
  });

  function respond(res: ServerResponse, reply: StubReply, model: string): void {
    switch (reply.kind) {
      case 'stall':
        stalled.push(res);
        return;
      case 'status':
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers }).end(reply.body ?? '');
        return;
      case 'garbage':
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>gateway says hello</html>');
        return;
      case 'empty':
        json(res, { id: 'cmpl-empty', object: 'chat.completion', model, choices: [] });
        return;
      case 'prose':
        json(res, completion(model, { role: 'assistant', content: reply.content }, 'stop'));
        return;
      case 'tool':
        json(
          res,
          completion(
            model,
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_stub_1',
                  type: 'function',
                  function: {
                    name: TOOL_NAME,
                    arguments: typeof reply.args === 'string' ? reply.args : JSON.stringify(reply.args),
                  },
                },
              ],
            },
            'tool_calls',
            reply.usage,
          ),
        );
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

function completion(
  model: string,
  message: Record<string, unknown>,
  finishReason: string,
  usage = { prompt_tokens: 100, completion_tokens: 20 },
) {
  return {
    id: 'cmpl-stub',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
