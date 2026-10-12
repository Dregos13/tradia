/**
 * Servidor falso de la API de Anthropic Messages para las pruebas del
 * adaptador (`anthropic.test.ts`), mismo patrón que el fake de Alpaca.
 *
 * `createAnthropicFakeFetch` devuelve un `fetch` compatible que sirve un
 * plan de respuestas en cola (o una función por petición) y graba cada
 * llamada —URL, cabeceras y cuerpo— para comprobar el prompt delimitado
 * y que la clave solo viaja en `x-api-key`.
 */

export interface RecordedLlmRequest {
  url: string;
  headers: Record<string, string>;
  /** Cuerpo ya parseado (Messages API). */
  body: Record<string, unknown>;
}

export interface FakeAnthropicServer {
  fetch: typeof globalThis.fetch;
  calls: RecordedLlmRequest[];
}

/** Respuesta Messages correcta con el JSON de análisis indicado. */
export function okMessage(
  assets: { ticker: string; summary: string; sentiment: string }[],
  usage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 180,
    output_tokens: 60,
  },
): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_fake_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: JSON.stringify({ assets }) }],
      stop_reason: 'end_turn',
      usage,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Respuesta de error de la API (el cuerpo puede traer cualquier texto). */
export function errorMessage(
  status: number,
  body: unknown = { error: { type: 'error', message: `HTTP ${status}` } },
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * `plan` puede ser:
 * - una lista de respuestas servidas en orden (la última se repite);
 * - una función que decide la respuesta de cada petición grabada.
 */
export function createAnthropicFakeFetch(
  plan: Response[] | ((call: RecordedLlmRequest, index: number) => Response | Promise<Response>),
): FakeAnthropicServer {
  const calls: RecordedLlmRequest[] = [];
  const queue = Array.isArray(plan) ? [...plan] : null;

  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[name] = value;
    }
    let body: RecordedLlmRequest['body'];
    try {
      body = JSON.parse(String(init.body ?? '{}')) as RecordedLlmRequest['body'];
    } catch {
      body = { _raw: String(init.body) };
    }
    const call: RecordedLlmRequest = { url: String(input), headers, body };
    calls.push(call);
    if (queue !== null) {
      const response = queue.length > 1 ? queue.shift()! : queue[0]!;
      return response.clone();
    }
    const handler = plan as (
      call: RecordedLlmRequest,
      index: number,
    ) => Response | Promise<Response>;
    return handler(call, calls.length - 1);
  };

  return { fetch, calls };
}
