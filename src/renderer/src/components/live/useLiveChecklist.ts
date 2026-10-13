import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LIVE_REQUIREMENTS,
  LIVE_REQUIREMENT_TITLES,
  type LiveChecklist,
  type LiveDeclareRequest,
  type LiveLimits,
  type LiveState,
} from '../../../../shared/live';
import type { DeliveryTestableChannel } from '../../../../shared/journal';

interface Snapshot {
  checklist: LiveChecklist;
  state: LiveState;
  stopActive: boolean;
}
export function checklistReasons(snapshot: Snapshot | null) {
  if (!snapshot) return ['La lista de comprobación aún no se ha verificado.'];
  const reasons = LIVE_REQUIREMENTS.flatMap((requirement) => {
    const item = snapshot.checklist.items.find((row) => row.requirement === requirement);
    return item?.state === 'cumplido'
      ? []
      : [`${LIVE_REQUIREMENT_TITLES[requirement]}: ${item?.evidence ?? 'pendiente'}.`];
  });
  if (!snapshot.checklist.allComplete && reasons.length === 0)
    reasons.push('El proceso principal aún no confirma todos los requisitos.');
  if (!snapshot.state.hasCredentials || !snapshot.state.accountMasked)
    reasons.push('Conecta y verifica las claves live del broker.');
  const limits = snapshot.checklist.limits.limits;
  if (
    limits &&
    (limits.shortOrderUsd > 0 || limits.shortExposureUsd > 0 || limits.shortPositions > 0) &&
    !snapshot.checklist.short?.allComplete
  )
    reasons.push(
      snapshot.checklist.short?.blockReason ?? 'Los requisitos del corto aún no se han verificado.',
    );
  if (snapshot.stopActive)
    reasons.push('La parada de emergencia está activa. Revisa Riesgo antes de continuar.');
  if (snapshot.state.mode === 'activo') reasons.push('Dinero real ya está activo.');
  return reasons;
}

export function useLiveChecklist() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [limits, setLimits] = useState<LiveLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rejection, setRejection] = useState<string[]>([]);
  const mounted = useRef(false);
  const working = useRef(false);
  const disconnected = useRef(false);
  const pendingRead = useRef(false);
  const generation = useRef(0);
  const read = useCallback(async (): Promise<Snapshot | null> => {
    const id = ++generation.current;
    setLoading(true);
    try {
      // Push events during an action are coalesced. Repeat the snapshot if
      // it changed while reading, without discarding the mutation's result.
      let next: Snapshot;
      do {
        pendingRead.current = false;
        const [checklist, state, stop, connection] = await Promise.all([
          window.tradia.live.checklist(),
          window.tradia.live.state(),
          window.tradia.risk.getKillSwitch(),
          window.tradia.connectivity.getState(),
        ]);
        if (!mounted.current || id !== generation.current) return null;
        disconnected.current = connection.status !== 'online';
        setOffline(disconnected.current);
        next = { checklist, state, stopActive: stop.active };
      } while (pendingRead.current && mounted.current && id === generation.current);
      setSnapshot(next);
      // The checklist also persists unconfirmed limits, unlike live:state.
      setLimits(next.checklist.limits.limits ?? next.state.limits);
      return disconnected.current ? null : next;
    } catch {
      if (mounted.current && id === generation.current)
        setError('No se pudo verificar la lista. Dinero real permanece bloqueado.');
      return null;
    } finally {
      if (mounted.current && id === generation.current) setLoading(false);
    }
  }, []);
  const reload = useCallback(async () => {
    if (working.current) return null;
    setError('');
    setRejection([]);
    setNotice('');
    return read();
  }, [read]);
  const reconnect = async () => {
    if (working.current) return;
    try {
      const connection = await window.tradia.connectivity.checkNow();
      if (!mounted.current) return;
      disconnected.current = connection.status !== 'online';
      setOffline(disconnected.current);
      await reload();
    } catch {
      if (mounted.current) setError('No se pudo comprobar la conexión. Reintenta conexión.');
    }
  };
  const run = async (action: () => Promise<void>, fallback: string) => {
    if (working.current || disconnected.current) return false;
    working.current = true;
    generation.current++;
    setBusy(true);
    setError('');
    setNotice('');
    setRejection([]);
    try {
      await action();
      return mounted.current && !disconnected.current;
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error && cause.message.includes('[corto-requisitos]')
            ? cause.message
            : fallback,
        );
      return false;
    } finally {
      if (pendingRead.current && mounted.current) await read();
      working.current = false;
      if (mounted.current) {
        setBusy(false);
        setLoading(false);
      }
    }
  };
  const declare = (request: LiveDeclareRequest) =>
    run(async () => {
      await window.tradia.live.declare(request);
      if (await read())
        setNotice(request.confirmed ? 'Declaración guardada con fecha.' : 'Declaración retirada.');
    }, 'No se pudo guardar la declaración. Reintenta y verifica su estado.');
  const save = (input: LiveLimits) =>
    run(async () => {
      const saved = await window.tradia.live.setLimits(input);
      if (!saved.limits) throw new Error('Sin límites guardados');
      if (!mounted.current) return;
      setLimits(saved.limits);
      if (await read())
        setNotice(
          input.shortOrderUsd > 0 || input.shortExposureUsd > 0 || input.shortPositions > 0
            ? 'Límites del corto guardados · todavía debes confirmar la nueva frase por escrito.'
            : 'Límites guardados · todavía debes confirmarlos por escrito.',
        );
    }, 'No se pudieron guardar los límites. Dinero real permanece bloqueado.');
  const testStop = () =>
    run(async () => {
      const result = await window.tradia.live.testKillSwitch();
      await read();
      if (!result.ok) setError(result.error ?? 'La prueba de parada falló. Revisa Riesgo.');
      else setNotice('Parada probada: se activó y se reanudó en paper.');
    }, 'No se pudo probar la parada. Revisa su estado en Riesgo antes de reintentar.');
  const testAlert = (channel: DeliveryTestableChannel) =>
    run(async () => {
      const result = await window.tradia.delivery.test({ channel });
      await read();
      if (!result.ok)
        setError(result.error ?? 'La alerta de prueba falló. Revisa los canales en Ajustes.');
      else setNotice('Alerta de prueba enviada correctamente.');
    }, 'No se pudo enviar la alerta de prueba. Revisa el canal en Ajustes.');
  const prepare = async () => {
    let ready = false;
    await run(async () => {
      const next = await read();
      ready = !!next && checklistReasons(next).length === 0 && !!next.checklist.limits.limits;
    }, 'No se pudo verificar la activación. Dinero real permanece bloqueado.');
    return ready;
  };
  const activate = async (phrase: string) => {
    let activated = false;
    await run(async () => {
      const result = await window.tradia.live.activate({ phrase });
      if (!mounted.current) return;
      setSnapshot((previous) => previous && { ...previous, state: result.state });
      await read();
      if (!mounted.current) return;
      activated = result.activated;
      if (!result.activated) {
        setRejection([
          ...new Set([
            ...result.reasons,
            ...result.pendingRequirements.map((r) => LIVE_REQUIREMENT_TITLES[r]),
          ]),
        ]);
        setError('Activación rechazada · los requisitos siguen pendientes.');
      } else setNotice('Dinero real activado con los límites confirmados.');
    }, 'No se pudo activar dinero real. Reintenta la verificación antes de continuar.');
    return activated;
  };
  useEffect(() => {
    mounted.current = true;
    const offConnection = window.tradia.connectivity.onChanged((connection) => {
      disconnected.current = connection.status !== 'online';
      setOffline(disconnected.current);
      if (working.current) pendingRead.current = true;
      else {
        generation.current++;
        if (disconnected.current) setLoading(false);
        else void reload();
      }
    });
    const changed = () => {
      if (!working.current) void reload();
      else {
        pendingRead.current = true;
      }
    };
    const offLive = window.tradia.live.onChanged(changed);
    const offRisk = window.tradia.risk.onChanged(changed);
    void reload();
    return () => {
      mounted.current = false;
      generation.current++;
      offConnection();
      offLive();
      offRisk();
    };
  }, [reload]);
  const acceptDeactivation = (next: LiveState) => {
    generation.current++;
    setSnapshot((previous) => previous && { ...previous, state: next });
    // Apply the action result even when a push event started another read.
    if (working.current) pendingRead.current = true;
    else void read();
  };
  return {
    acceptDeactivation,
    snapshot,
    limits,
    loading,
    busy,
    offline,
    error,
    notice,
    rejection,
    reload,
    reconnect,
    declare,
    save,
    testStop,
    testAlert,
    prepare,
    activate,
  };
}
