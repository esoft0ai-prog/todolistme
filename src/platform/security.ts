import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as ScreenCapture from 'expo-screen-capture';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { SecurityService, type BiometricGateway, type SecureStoreGateway } from '../services/security';

/**
 * expo-secure-store encrypts values with a key held in the Android Keystore
 * (hardware-backed where available). Values never leave the device and are
 * excluded from Android auto-backup by the expo-secure-store config plugin.
 */
const memoryFallback = new Map<string, string>();

export const secureStoreGateway: SecureStoreGateway = {
  async getItem(key) {
    if (Platform.OS === 'web') return memoryFallback.get(key) ?? null;
    return SecureStore.getItemAsync(key, { keychainService: 'finora' });
  },
  async setItem(key, value) {
    if (Platform.OS === 'web') {
      memoryFallback.set(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value, { keychainService: 'finora' });
  },
  async deleteItem(key) {
    if (Platform.OS === 'web') {
      memoryFallback.delete(key);
      return;
    }
    await SecureStore.deleteItemAsync(key, { keychainService: 'finora' });
  },
};

export const biometricGateway: BiometricGateway = {
  async isAvailable() {
    if (Platform.OS === 'web') return false;
    try {
      return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
    } catch {
      return false;
    }
  },
  async authenticate(reason: string) {
    try {
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        cancelLabel: 'Use PIN',
        disableDeviceFallback: true, // Finora's own PIN is the fallback
        requireConfirmation: false,
      });
      return r.success ? { success: true } : { success: false, error: r.error };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Biometric error' };
    }
  },
};

export const securityService = new SecurityService(secureStoreGateway, { bytes: (n) => Crypto.getRandomBytes(n) });

/** FLAG_SECURE: hides app content in Recents and blocks screenshots/screen recording. */
export async function setScreenPrivacy(enabled: boolean): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (enabled) await ScreenCapture.preventScreenCaptureAsync('finora-privacy');
    else await ScreenCapture.allowScreenCaptureAsync('finora-privacy');
  } catch {
    // Not critical — some devices do not support it.
  }
}
