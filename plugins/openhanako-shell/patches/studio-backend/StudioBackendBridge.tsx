import { useEffect } from 'react';
import { startStudioBackendBridge } from './studio-backend-bridge';

/**
 * Headless: starts the Studio agent bridge as soon as this module is imported
 * (before App's init effect) and again on mount. The page keeps the shims if
 * this component unmounts — dropping them mid-session would strand the socket.
 */
startStudioBackendBridge();

export function StudioBackendBridge() {
  useEffect(() => startStudioBackendBridge(), []);
  return null;
}
