import * as Device from 'expo-device';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PairingScreen, RelayButton, relayColors } from '@/features/relay';
import type { PairingPayload, PairingState } from '@/features/relay';
import { PairingClient, parsePairingLink, useEkho } from '@/lib';

const idlePairing: PairingPayload = {
  endpoint: 'Waiting for a pairing link',
  hostname: 'Not connected',
  transport: 'https',
};

export default function ConnectRoute() {
  const { link } = useLocalSearchParams<{ link?: string }>();
  const router = useRouter();
  const { pair } = useEkho();
  const [isBusy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [pendingLink, setPendingLink] = useState<string>();
  const [pairing, setPairing] = useState<PairingPayload>(idlePairing);
  const [state, setState] = useState<PairingState>('ready');
  const [errorMessage, setErrorMessage] = useState<string>();
  const [scanEnabled, setScanEnabled] = useState(true);
  const scanEnabledRef = useRef(true);
  const preparing = useRef(false);

  const prepare = useCallback(async (value: string, fromScan = false) => {
    if (fromScan && !scanEnabledRef.current) return;
    if (preparing.current) return;
    if (fromScan) {
      scanEnabledRef.current = false;
      setScanEnabled(false);
    }
    preparing.current = true;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const input = parsePairingLink(value);
      const descriptor = await new PairingClient().describe(input.endpoint);
      setPendingLink(value);
      setPairing({
        endpoint: input.endpoint,
        hostname: descriptor.hostname ?? new URL(input.endpoint).hostname,
        machineName: descriptor.label,
        transport: input.endpoint.includes('.ts.net') ? 'tailscale' : 'https',
      });
      setState('confirm');
    } catch (error) {
      setState('error');
      setErrorMessage(error instanceof Error ? error.message : 'Could not read this pairing link');
    } finally {
      preparing.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!link) return;
    const timeout = setTimeout(() => void prepare(link), 0);
    return () => clearTimeout(timeout);
  }, [link, prepare]);

  const confirm = useCallback(async () => {
    if (!pendingLink || preparing.current) return;
    preparing.current = true;
    setBusy(true);
    try {
      const agent = await pair(pendingLink, Device.deviceName ?? 'Ekho mobile');
      router.replace({ pathname: '/', params: { agentId: agent.id } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pairing failed';
      setErrorMessage(message);
      setState(/expired|invalid pairing token/i.test(message) ? 'expired' : 'error');
    } finally {
      preparing.current = false;
      setBusy(false);
    }
  }, [pair, pendingLink, router]);

  const camera = permission?.granted ? scanEnabled ? (
    <CameraView
      style={styles.camera}
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      onBarcodeScanned={({ data }) => void prepare(data, true)}
    />
  ) : (
    <View style={styles.cameraPaused}><Text style={styles.cameraPausedText}>Scan paused</Text></View>
  ) : (
    <View style={styles.permission}>
      <Text style={styles.permissionText}>Camera access is used only to scan the one-time code.</Text>
      <RelayButton compact tone="route" onPress={() => void requestPermission()}>Allow camera</RelayButton>
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <PairingScreen
        pairing={pairing}
        state={state}
        isBusy={isBusy}
        errorMessage={errorMessage}
        qrContent={Device.isDevice ? camera : undefined}
        onBack={() => router.back()}
        onManualSubmit={(value) => void prepare(value)}
        onConfirm={() => void confirm()}
        onCancel={() => {
          setState('ready');
          setPendingLink(undefined);
          setErrorMessage(undefined);
          scanEnabledRef.current = true;
          setScanEnabled(true);
        }}
        onRetry={() => {
          setState('ready');
          setPendingLink(undefined);
          setErrorMessage(undefined);
          scanEnabledRef.current = true;
          setScanEnabled(true);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: relayColors.background },
  camera: { width: '100%', height: '100%' },
  cameraPaused: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: relayColors.surface },
  cameraPausedText: { color: relayColors.muted, fontSize: 13 },
  permission: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 16, backgroundColor: relayColors.background },
  permissionText: { color: relayColors.secondary, textAlign: 'center', fontSize: 12, lineHeight: 17 },
});
