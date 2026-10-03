import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AttachmentSource } from '../../lib/attachments';
import { MAX_ATTACHMENT_BYTES } from '../../lib/attachments';
import { useColors } from './relay-ui';
import { attachmentCacheIdentity } from '../content/attachment-cache';

type VisibleAttachment = { id: string; name: string; mimeType: string; size: number; source?: AttachmentSource };

const previewDirectory = new Directory(Paths.cache, 'attachment-previews');
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

function displaySize(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function cachedName(file: VisibleAttachment) {
  const extension = /\.[a-z\d]{1,10}$/i.exec(file.name)?.[0] ?? '';
  const identity = attachmentCacheIdentity(file.source?.uri ?? '', file.id);
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, identity);
  return `${digest.slice(0, 32)}${extension}`;
}

function supportsTextPreview(file: VisibleAttachment) {
  return /^(?:text\/|application\/(?:json|xml|javascript|x-javascript|x-sh|yaml))/i.test(file.mimeType)
    || /\.(?:txt|md|mdx|json|jsonc|ya?ml|xml|csv|tsv|[cm]?[jt]sx?|css|scss|html?|py|rb|rs|go|java|kt|swift|sh|bash|zsh|fish|pl|pm|sql|toml|ini|env)$/i.test(file.name);
}

async function localAttachment(file: VisibleAttachment): Promise<File> {
  if (!file.source) throw new Error('This attachment is no longer available.');
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('This attachment is too large to preview.');
  if (file.source.uri.startsWith('file://')) return new File(file.source.uri);
  if (!/^https?:\/\//i.test(file.source.uri)) throw new Error('This attachment location cannot be opened.');

  previewDirectory.create({ idempotent: true, intermediates: true });
  const destination = new File(previewDirectory, await cachedName(file));
  if (destination.exists && destination.size === file.size) return destination;
  if (destination.exists) destination.delete();
  try {
    const response = await expoFetch(file.source.uri, {
      headers: file.source.headers,
      credentials: 'omit',
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) throw new Error('Reconnect to this agent, then try again.');
    if (response.status === 404) throw new Error('This attachment is no longer available.');
    if (!response.ok || response.redirected) throw new Error('The attachment could not be downloaded. Try again.');
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_ATTACHMENT_BYTES) throw new Error('This attachment is too large to preview.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The attachment download was empty. Try again.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES || size > file.size) {
        await reader.cancel();
        throw new Error('This attachment is too large to preview.');
      }
      chunks.push(value);
    }
    if (size !== file.size) throw new Error('The attachment download was incomplete. Try again.');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    destination.create({ overwrite: true });
    destination.write(bytes);
    return destination;
  } catch (error) {
    if (destination.exists) destination.delete();
    throw error;
  }
}

export function AttachmentStrip({ files, onRemove, disabled = false }: { files: readonly VisibleAttachment[]; onRemove?: (id: string) => void; disabled?: boolean }) {
  const colors = useColors();
  const [selected, setSelected] = useState<VisibleAttachment>();
  const [localUri, setLocalUri] = useState<string>();
  const [previewText, setPreviewText] = useState<string>();
  const [previewNote, setPreviewNote] = useState<string>();
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);

  const open = useCallback((file: VisibleAttachment) => {
    const current = ++request.current;
    setSelected(file);
    setLocalUri(undefined);
    setPreviewText(undefined);
    setPreviewNote(undefined);
    setLoading(true);
    void localAttachment(file).then(async (cached) => {
      if (request.current !== current) return;
      setLocalUri(cached.uri);
      if (supportsTextPreview(file)) {
        if (file.size > MAX_TEXT_PREVIEW_BYTES) setPreviewNote('Text preview is limited to 512 KB. Use Share to open the full file.');
        else {
          const text = await cached.text();
          if (request.current === current) setPreviewText(text);
        }
      }
    }).catch((error: unknown) => {
      if (request.current === current) {
        setSelected(undefined);
        Alert.alert('Could not open attachment', error instanceof Error ? error.message : 'Try downloading the attachment again.');
      }
    }).finally(() => {
      if (request.current === current) setLoading(false);
    });
  }, []);

  const close = () => {
    request.current += 1;
    setSelected(undefined);
    setLocalUri(undefined);
    setPreviewText(undefined);
    setPreviewNote(undefined);
    setLoading(false);
  };

  const share = async () => {
    if (!selected) return;
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) throw new Error('Sharing is not available on this device.');
      setLoading(true);
      const local = localUri ? new File(localUri) : await localAttachment(selected);
      setLocalUri(local.uri);
      await Sharing.shareAsync(local.uri, { dialogTitle: `Share ${selected.name}`, mimeType: selected.mimeType });
    } catch (error) {
      Alert.alert('Could not share attachment', error instanceof Error ? error.message : 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!files.length) return null;
  return <>
    <ScrollView horizontal style={styles.strip} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}>
      {files.map((file) => <View key={file.id} style={[styles.file, { backgroundColor: colors.surface }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Preview attachment ${file.name}`} onPress={() => open(file)} style={({ pressed }) => [styles.preview, { opacity: pressed ? 0.6 : 1 }]}>
          {/^image\/(jpeg|png|gif|webp|heic|heif)$/.test(file.mimeType) && file.source
            ? <Image source={file.source} style={styles.image} contentFit="cover" cachePolicy="memory" accessibilityLabel={`Attached photo ${file.name}`} />
            : <View style={styles.fileIcon}><SymbolView name={{ ios: 'doc', android: 'description', web: 'description' }} size={24} tintColor={colors.secondary} /></View>}
          <View style={styles.details}><Text numberOfLines={1} style={[styles.name, { color: colors.primary }]}>{file.name}</Text><Text style={[styles.size, { color: colors.secondary }]}>{displaySize(file.size)}</Text></View>
        </Pressable>
        {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={`Remove attachment ${file.name}`} accessibilityState={{ disabled }} disabled={disabled} onPress={() => onRemove(file.id)} style={styles.remove}><SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={15} tintColor={disabled ? colors.muted : colors.primary} /></Pressable> : null}
      </View>)}
    </ScrollView>
    <Modal visible={Boolean(selected)} transparent animationType="fade" onRequestClose={close}>
      <View style={[styles.backdrop, { backgroundColor: colors.backdrop }]}>
        <View style={[styles.modal, { backgroundColor: colors.elevated, borderColor: colors.line }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.line }]}>
            <View style={styles.modalTitle}><Text numberOfLines={1} style={[styles.modalName, { color: colors.primary }]}>{selected?.name}</Text><Text style={[styles.size, { color: colors.secondary }]}>{selected ? `${displaySize(selected.size)} · ${selected.mimeType}` : ''}</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close attachment preview" onPress={close} style={styles.action}><SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={18} tintColor={colors.primary} /></Pressable>
          </View>
          <View style={styles.previewBody}>
            {loading && !localUri ? <ActivityIndicator color={colors.secondary} /> : selected && localUri && selected.mimeType.startsWith('image/')
              ? <Image source={{ uri: localUri }} style={styles.fullImage} contentFit="contain" accessibilityLabel={`Preview of ${selected.name}`} />
              : previewText !== undefined ? <ScrollView style={styles.textScroll} contentContainerStyle={styles.textContent}><Text selectable style={[styles.previewText, { color: colors.primary }]}>{previewText || 'Empty file'}</Text></ScrollView>
              : previewNote ? <Text style={[styles.previewNote, { color: colors.secondary }]}>{previewNote}</Text>
              : <SymbolView name={{ ios: 'doc', android: 'description', web: 'description' }} size={54} tintColor={colors.secondary} />}
          </View>
          <View style={[styles.modalFooter, { borderTopColor: colors.line }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Share ${selected?.name ?? 'attachment'}`} disabled={loading} onPress={() => void share()} style={({ pressed }) => [styles.share, { opacity: loading ? 0.4 : pressed ? 0.6 : 1 }]}>
              <SymbolView name={{ ios: 'square.and.arrow.up', android: 'share', web: 'share' }} size={17} tintColor={colors.primary} />
              <Text style={{ color: colors.primary, fontSize: 14 }}>Share</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  strip: { flexGrow: 0, marginBottom: 8 }, content: { gap: 8 },
  file: { flexDirection: 'row', alignItems: 'center', borderRadius: 8, overflow: 'hidden', maxWidth: 280 },
  preview: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  image: { width: 64, height: 64 }, fileIcon: { width: 44, height: 64, alignItems: 'center', justifyContent: 'center' },
  details: { paddingHorizontal: 10, paddingVertical: 8, gap: 4, flexShrink: 1 },
  name: { fontSize: 13, maxWidth: 150 }, size: { fontSize: 12 },
  remove: { width: 44, minHeight: 64, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, padding: 16, alignItems: 'center', justifyContent: 'center' },
  modal: { width: '100%', maxWidth: 560, maxHeight: '82%', borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  modalHeader: { minHeight: 60, paddingLeft: 14, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  modalTitle: { flex: 1, gap: 3 }, modalName: { fontSize: 15, fontWeight: '600' },
  action: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  previewBody: { minHeight: 240, maxHeight: 520, alignItems: 'center', justifyContent: 'center' },
  fullImage: { width: '100%', height: 520, maxHeight: '100%' },
  textScroll: { width: '100%', maxHeight: 520 }, textContent: { padding: 14 },
  previewText: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18 }, previewNote: { padding: 24, textAlign: 'center', lineHeight: 20 },
  modalFooter: { minHeight: 54, paddingHorizontal: 8, borderTopWidth: StyleSheet.hairlineWidth, alignItems: 'flex-end', justifyContent: 'center' },
  share: { minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
});
