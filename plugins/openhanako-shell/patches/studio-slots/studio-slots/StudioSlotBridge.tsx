import { useEffect } from 'react';
import { startSlotBridge } from './slot-bridge';

/** Headless: starts the Studio↔iframe geometry bridge. */
export function StudioSlotBridge() {
  useEffect(() => startSlotBridge(), []);
  return null;
}
