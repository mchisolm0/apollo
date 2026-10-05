import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ToolsetsScreen } from '@/features/relay/toolsets-screen';
import { useColors } from '@/features/relay/relay-ui';
import { useEkho, type HermesToolset } from '@/lib';

export default function ToolsetsRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const router = useRouter();
  const colors = useColors();
  const { agents, runtime, toolsets: loadToolsets, retryAgent } = useEkho();
  const agent = agents.find((candidate) => candidate.id === agentId);
  const status = runtime[agentId]?.status;
  const [result, setResult] = useState<{ request: string; toolsets: readonly HermesToolset[]; error?: string }>();
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => {
    if (status !== 'connected') void retryAgent(agentId);
    setRevision((value) => value + 1);
  }, [agentId, retryAgent, status]);
  const request = JSON.stringify([agentId, status, revision]);
  useEffect(() => {
    let current = true;
    void loadToolsets(agentId).then((toolsets) => { if (current) setResult({ request, toolsets }); })
      .catch((cause: unknown) => { if (current) setResult({ request, toolsets: [], error: cause instanceof Error ? cause.message : 'Could not load toolsets.' }); });
    return () => { current = false; };
  }, [agentId, loadToolsets, request]);
  if (!agent) return <Redirect href="/" />;
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
    <ToolsetsScreen toolsets={result?.toolsets ?? []} loading={result?.request !== request} error={result?.request === request ? result.error : undefined} onRetry={retry} onBack={() => router.back()} />
  </SafeAreaView>;
}
