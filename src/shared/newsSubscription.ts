import type { NewsSubscriptionState } from './ai';

/** Textos seguros compartidos por los avisos y el adaptador de pruebas. */
export const NEWS_SUBSCRIPTION_COPY: Record<
  Exclude<NewsSubscriptionState, 'ok'>,
  { title: string; step: string }
> = {
  'cli-no-encontrada': {
    title: 'Suscripción no disponible · CLI no encontrada',
    step: 'Instala Claude Code y vuelve a abrir Tradia. Si ya está instalado, indica su ruta en este ajuste. Mientras tanto, se usa el analizador local.',
  },
  'sin-sesion': {
    title: 'Suscripción no disponible · sesión no iniciada',
    step: 'Abre un terminal, ejecuta claude y después /login. Vuelve aquí y prueba de nuevo. Mientras tanto, se usa el analizador local.',
  },
  'tope-diario': {
    title: 'Suscripción en pausa · tope diario alcanzado',
    step: 'Espera al próximo día o aumenta el máximo diario de titulares. Hasta entonces se usa el analizador local.',
  },
  error: {
    title: 'No se pudo usar la suscripción',
    step: 'Comprueba la conexión y vuelve a probar. Mientras tanto, se usa el analizador local.',
  },
};
