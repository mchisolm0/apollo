import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AttachmentSource } from '../../lib/attachments';
import { relayColors as colors } from './relay-ui';

type VisibleAttachment = { id: string; name: string; mimeType: string; size: number; source?: AttachmentSource };

export function AttachmentStrip({ files, onRemove, disabled = false }: { files: readonly VisibleAttachment[]; onRemove?: (id: string) => void; disabled?: boolean }) {
  if (!files.length) return null;
  return <ScrollView horizontal style={styles.strip} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}>
    {files.map((file) => <View key={file.id} style={styles.file}>
      {/^image\/(jpeg|png|gif|webp|heic|heif)$/.test(file.mimeType) && file.source
        ? <Image source={file.source} style={styles.image} contentFit="cover" cachePolicy="memory" accessibilityLabel={`Attached photo ${file.name}`} />
        : <View style={styles.fileIcon}><SymbolView name={{ ios: 'doc', android: 'description', web: 'description' }} size={24} tintColor={colors.secondary} /></View>}
      <View style={styles.details}><Text numberOfLines={1} style={styles.name}>{file.name}</Text><Text style={styles.size}>{file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</Text></View>
      {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={`Remove attachment ${file.name}`} accessibilityState={{ disabled }} disabled={disabled} onPress={() => onRemove(file.id)} style={styles.remove}><SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={15} tintColor={disabled ? colors.muted : colors.primary} /></Pressable> : null}
    </View>)}
  </ScrollView>;
}

const styles = StyleSheet.create({
  strip: { flexGrow: 0, marginBottom: 8 }, content: { gap: 8 },
  file: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1c1d22', borderRadius: 8, overflow: 'hidden', maxWidth: 280 },
  image: { width: 64, height: 64 }, fileIcon: { width: 44, height: 64, alignItems: 'center', justifyContent: 'center' },
  details: { paddingHorizontal: 10, paddingVertical: 8, gap: 4, flexShrink: 1 },
  name: { color: colors.primary, fontSize: 13, maxWidth: 150 }, size: { color: colors.secondary, fontSize: 12 },
  remove: { width: 44, minHeight: 64, alignItems: 'center', justifyContent: 'center' },
});
