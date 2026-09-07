import { LegendList } from '@legendapp/list/react-native';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConnectionMark, RelayHeader, relayColors } from '@/features/relay';
import { IconButton } from '@/features/relay/relay-ui';
import { useEkho } from '@/lib';

export default function AgentsRoute() {
  const router = useRouter();
  const { agents, runtime } = useEkho();

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <RelayHeader
        title="Agents"
        detail={`${agents.length} paired`}
        onBack={() => router.back()}
        action={<IconButton name="plus" label="Add agent" onPress={() => router.push('/connect')} />}
      />
      <LegendList
        data={agents}
        recycleItems
        keyExtractor={(item) => item.id}
        estimatedItemSize={68}
        renderItem={({ item }) => {
          const status = runtime[item.id]?.status;
          const connection = status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : status === 'revoked' ? 'revoked' : 'offline';
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Use agent ${item.label}`}
              onPress={() => router.dismissTo({ pathname: '/', params: { agentId: item.id } })}
              style={({ pressed }) => [styles.row, { opacity: pressed ? 0.65 : 1 }]}
            >
              <View style={styles.lead}>
                <ConnectionMark state={connection} />
                <View style={styles.copy}>
                  <Text style={styles.name}>{item.label}</Text>
                  <Text style={styles.endpoint} numberOfLines={1}>{item.endpoint.url}</Text>
                </View>
              </View>
              <Text style={styles.route}>{connection === 'connected' ? 'Connected' : connection === 'connecting' ? 'Connecting' : connection === 'revoked' ? 'Revoked' : 'Offline'}</Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyText}>No paired agents.</Text></View>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: relayColors.background },
  row: { minHeight: 68, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: relayColors.line, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  lead: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  copy: { flex: 1, gap: 4 },
  name: { color: relayColors.primary, fontSize: 15, fontWeight: '600' },
  endpoint: { color: relayColors.muted, fontSize: 12 },
  route: { color: relayColors.secondary, fontSize: 13 },
  empty: { padding: 20 },
  emptyText: { color: relayColors.secondary, fontSize: 14 },
});
