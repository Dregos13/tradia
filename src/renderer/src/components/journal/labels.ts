import type { JournalEntryType, JournalResult } from '../../../../shared/journal';
export const typeLabel: Record<JournalEntryType, string> = { senal: 'Señal', veto: 'Veto', contradiccion: 'Contradicción', operacion: 'Operación simulada', resumen: 'Resumen', error: 'Error', limite: 'Límite' };
export const resultLabel: Record<JournalResult, string> = { aprobada: 'Aprobada', reducida: 'Reducida', vetada: 'Vetada', 'sin-senal': 'Sin señal', ganancia: 'Ganancia', perdida: 'Pérdida', empate: 'Empate', completado: 'Completado', 'con-retraso': 'Con retraso', alcanzado: 'Alcanzado', error: 'Error' };
export const localDate = (iso: string) => new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(iso));
