// boot/waitForServices.ts
//
// Implements the services_wait boot phase.
//
// Called once at the end of coreInit(), after all service start() calls have
// been fire-and-forgot. Polls each service manager on a 2-second interval for
// up to 5 minutes, streaming live status to the frontend via BootState. When
// every tracked service has settled (running or error) or the deadline passes,
// it resolves — server.ts then calls setBootPhase('ready').
//
// Adding a service: append one entry to TRACKED_SERVICES. Nothing else changes.

import { setBootPhase, setBootProgress, type ServiceStatus } from './BootState.js';
import { getMeridianStatus }                                  from '../services/MeridianManager.js';
import { getPolarisStatus,  isBinaryPresent as isPolarisPresent }  from '../services/PolarisManager.js';
import { getJellyfinStatus, isBinaryPresent as isJellyfinPresent } from '../services/JellyfinManager.js';
import { getKavitaStatus,   isBinaryPresent as isKavitaPresent }   from '../services/KavitaManager.js';
import { getCamofoxStatus,  isCamofoxInstalled }                   from '../phobos/CamofoxManager.js';
import { getStirlingStatus, isBinaryPresent as isStirlingPresent } from '../services/StirlingManager.js';

const SERVICE_WAIT_MS = 5 * 60 * 1_000;
const POLL_INTERVAL_MS = 2_000;

// ── Service descriptor ────────────────────────────────────────────────────────

interface ServiceDescriptor {
  label:     string;
  isPresent: () => boolean;
  getState:  () => 'stopped' | 'starting' | 'running' | 'error';
}

const TRACKED_SERVICES: ServiceDescriptor[] = [
  {
    label:     'Meridian (Photos)',
    isPresent: () => true,  // first-party, always started
    getState:  () => getMeridianStatus().state,
  },
  {
    label:     'Polaris (Music)',
    isPresent: isPolarisPresent,
    getState:  () => getPolarisStatus().state,
  },
  {
    label:     'Jellyfin (Video)',
    isPresent: isJellyfinPresent,
    getState:  () => getJellyfinStatus().state,
  },
  {
    label:     'Kavita (Books)',
    isPresent: isKavitaPresent,
    getState:  () => getKavitaStatus().state,
  },
  {
    label:     'Stirling (PDF)',
    isPresent: isStirlingPresent,
    getState:  () => getStirlingStatus().state,
  },
  {
    label:     'Camofox (Browser)',
    isPresent: isCamofoxInstalled,
    getState:  () => getCamofoxStatus().state,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toServiceReadyState(raw: 'stopped' | 'starting' | 'running' | 'error'): ServiceStatus['state'] {
  if (raw === 'running') return 'ready';
  if (raw === 'error')   return 'failed';
  return 'waiting';
}

function buildSnapshot(active: ServiceDescriptor[]): ServiceStatus[] {
  const out: ServiceStatus[] = [];
  for (const svc of active) {
    out.push({ name: svc.label, state: toServiceReadyState(svc.getState()) });
  }
  return out;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function waitForServicesToSettle(): Promise<void> {
  // Filter to services that were actually started this boot.
  const active = TRACKED_SERVICES.filter(svc => svc.isPresent());

  if (active.length === 0) return;

  const deadline = Date.now() + SERVICE_WAIT_MS;

  setBootPhase('services_wait');
  setBootProgress({ services: buildSnapshot(active), waitDeadline: deadline });

  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      const services  = buildSnapshot(active);
      const allSettled = services.every(s => s.state === 'ready' || s.state === 'failed');
      const timedOut   = Date.now() >= deadline;

      setBootProgress({ services, waitDeadline: deadline });

      if (allSettled || timedOut) {
        clearInterval(poll);
        resolve();
      }
    }, POLL_INTERVAL_MS);
  });
}
