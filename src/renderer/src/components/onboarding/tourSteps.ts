export interface TourStep {
  route: string | null;
  anchor: string | null;
  fallback: string | null;
  title: string;
  text: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    route: null,
    anchor: null,
    fallback: null,
    title: 'Te enseñamos Tradia en 2 minutos',
    text: 'Tradia vigila el mercado, prueba estrategias con datos del pasado y te avisa con probabilidades, no con corazonadas. Por defecto todo es simulado: no se mueve dinero real. Son 10 pasos y puedes saltarlos cuando quieras.',
  },
  {
    route: 'inicio',
    anchor: 'inicio-situacion',
    fallback: '.dashboard-grid',
    title: 'Inicio: el estado de un vistazo',
    text: 'Aquí ves la situación del mercado, las señales del día, tus posiciones en paper y si los datos están al día. Si algo necesita tu atención, aparece primero aquí.',
  },
  {
    route: 'mercado',
    anchor: 'mercado-lista',
    fallback: 'section[aria-label="Datos de mercado"]',
    title: 'Mercado: tu lista de seguimiento',
    text: 'Añade los activos que quieres vigilar. Tradia descarga sus velas diarias de Tiingo y los indicadores macro de FRED. Sin claves de los proveedores no hay datos reales.',
  },
  {
    route: 'fuentes',
    anchor: 'fuentes-lista',
    fallback: '#contenido',
    title: 'Fuentes y Noticias',
    text: 'Elige de dónde llegan las noticias (RSS, fuentes oficiales y APIs). En Noticias verás cada titular con su fiabilidad. Un titular sin confirmar nunca crea una señal por sí solo.',
  },
  {
    route: 'estrategias',
    anchor: 'estrategias-lista',
    fallback: '#contenido',
    title: 'Estrategias: probadas con el pasado',
    text: 'Cada estrategia tiene su ficha: en qué régimen funciona, en cuál falla y su backtest con datos que no ha visto. Si no supera la validación, no se usa.',
  },
  {
    route: 'riesgo',
    anchor: 'parada',
    fallback: '.top',
    title: 'Riesgo manda sobre todo lo demás',
    text: 'Todas las señales pasan por el motor de riesgo, con sus límites de pérdida y de exposición. Este botón detiene al instante todas las órdenes nuevas. El tour no lo pulsa: solo te enseña dónde está.',
  },
  {
    route: 'ordenes',
    anchor: 'ordenes-paper',
    fallback: '#contenido',
    title: 'Señales y órdenes en paper',
    text: 'Las señales aprobadas por Riesgo se convierten en órdenes simuladas (paper). Aquí ves cada orden, su estado y su conciliación con el broker. Arriba, la cabecera indica siempre el modo: «Señales + paper trading».',
  },
  {
    route: 'ia',
    anchor: 'ia-regimen',
    fallback: 'section:has(#ai-regime-title), #contenido',
    title: 'IA: régimen y probabilidades',
    text: 'La IA clasifica el régimen del mercado y estima la probabilidad de subida o bajada, con su ficha y su calibración. En Salud de modelos verás si un modelo se degrada y cuándo toca reentrenarlo. La IA nunca se salta a Riesgo.',
  },
  {
    route: 'dinero-real',
    anchor: 'dinero-real-lista',
    fallback: '#contenido',
    title: 'Dinero real: bloqueado hasta que cumplas la lista',
    text: 'El modo real está bloqueado. Para activarlo hacen falta meses de validación en paper, la parada probada, alertas activas, claves sin permiso de retirada, un plan de contingencia, revisión legal y fiscal y tus límites confirmados por escrito. No hay atajos.',
  },
  {
    route: 'ajustes',
    anchor: 'ajustes-proveedores',
    fallback: 'section[aria-label="Proveedores de datos"]',
    title: 'Ajustes: conecta tus datos',
    text: 'Pega aquí tus claves de Tiingo y FRED y pulsa «Probar conexión» en cada una. Verás «Conectado» y la fecha del último dato, o el motivo exacto si falla. Puedes volver a ver este tour desde aquí.',
  },
];
