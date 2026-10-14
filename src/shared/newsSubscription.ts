import type { NewsEngine, NewsSubscriptionState } from './ai';

export const ENGINE_DISPLAY_NAMES: Record<NewsEngine, string> = {
  'suscripcion-claude': 'Claude Code',
  'suscripcion-codex': 'OpenAI Codex',
  'suscripcion-antigravity': 'Google Antigravity',
  'suscripcion-copilot': 'GitHub Copilot',
  local: 'Analizador local',
};

export const ENGINE_COMMANDS: Record<NewsEngine, string> = {
  'suscripcion-claude': 'claude',
  'suscripcion-codex': 'codex',
  'suscripcion-antigravity': 'agy',
  'suscripcion-copilot': 'copilot',
  local: '',
};

export interface SubscriptionCopyOptions {
  context?: 'noticias' | 'ajustes';
  dailyCap?: number;
}

export function getNewsSubscriptionCopy(
  state: Exclude<NewsSubscriptionState, 'ok'>,
  engine: NewsEngine = 'suscripcion-claude',
  options?: SubscriptionCopyOptions,
): { title: string; step: string } {
  const engineName = ENGINE_DISPLAY_NAMES[engine] ?? 'Claude Code';
  const cliCmd = ENGINE_COMMANDS[engine] ?? 'claude';
  const location = options?.context === 'noticias' ? 'en Ajustes' : 'arriba';
  const cap = options?.dailyCap ?? 200;

  switch (state) {
    case 'cli-no-encontrada':
      return {
        title: `Suscripción no disponible · No encontramos el comando de ${engineName}.`,
        step: `Tradia no puede ejecutar el análisis con esta opción. Instala ${engineName} en tu ordenador o escribe la ruta exacta a su archivo ejecutable ${location}. Mientras tanto, las noticias se analizan con el analizador local.`,
      };
    case 'sin-sesion':
      return {
        title: `Suscripción no disponible · No hay una sesión iniciada en ${engineName}.`,
        step: `Tu suscripción no está validada en este equipo. Abre un terminal, ejecuta ${cliCmd} para iniciar sesión y pulsa el botón de comprobar. Mientras tanto, las noticias se analizan con el analizador local.`,
      };
    case 'tope-diario':
      return {
        title: 'Suscripción en pausa · Has alcanzado el límite diario de titulares.',
        step: `Se han analizado los ${cap} titulares permitidos por hoy para proteger tu consumo. Espera a mañana o aumenta el límite diario en el campo inferior. Hasta entonces, las noticias se analizan con el analizador local.`,
      };
    case 'error':
    default:
      return {
        title: 'No se pudo usar la suscripción',
        step: 'Comprueba la conexión y vuelve a probar. Mientras tanto, las noticias se analizan con el analizador local.',
      };
  }
}

/** Textos seguros compartidos por los avisos y el adaptador de pruebas. */
export const NEWS_SUBSCRIPTION_COPY: Record<
  Exclude<NewsSubscriptionState, 'ok'>,
  { title: string; step: string }
> = {
  'cli-no-encontrada': getNewsSubscriptionCopy('cli-no-encontrada', 'suscripcion-claude'),
  'sin-sesion': getNewsSubscriptionCopy('sin-sesion', 'suscripcion-claude'),
  'tope-diario': getNewsSubscriptionCopy('tope-diario', 'suscripcion-claude'),
  error: getNewsSubscriptionCopy('error', 'suscripcion-claude'),
};
