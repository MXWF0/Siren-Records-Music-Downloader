import { isTauri } from '@tauri-apps/api/core';
import type { PlatformBridge } from './types';
import { tauriPlatform } from './tauri';
import { webPlatform } from './web';

export const platform: PlatformBridge = isTauri() ? tauriPlatform : webPlatform;
export type { PlatformInfo } from './types';
