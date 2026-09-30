import * as Clipboard from 'expo-clipboard';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable } from 'react-native';

import { useColors } from '../relay/relay-ui';

export function CopyButton({ text, label = 'Copy message' }: { text: string; label?: string }) {
  const colors = useColors();
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timeout.current); }; }, []);
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={copied ? 'Copied' : label}
    onPress={() => {
      void Clipboard.setStringAsync(text).then(() => {
        if (!mounted.current) return;
        setCopied(true);
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => setCopied(false), 1200);
      }).catch(() => {
        if (mounted.current) Alert.alert('Could not copy', 'Try selecting and copying the text instead.');
      });
    }}
    style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.55 : 1 })}
  >
    <SymbolView name={{ ios: copied ? 'checkmark' : 'doc.on.doc', android: copied ? 'check' : 'content_copy', web: copied ? 'check' : 'content_copy' }} size={14} tintColor={copied ? colors.green : colors.muted} />
  </Pressable>;
}
