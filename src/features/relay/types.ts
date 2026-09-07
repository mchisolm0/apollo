import type { ReactNode } from 'react';

export type ConnectionState = 'connected' | 'connecting' | 'offline' | 'revoked';

export type PairingMode = 'qr' | 'manual';

export type PairingState = 'ready' | 'confirm' | 'expired' | 'error';

export type RelayAgent = {
  id: string;
  name: string;
  hostname: string;
  endpoint: string;
  transport: 'tailscale' | 'https';
  connection: ConnectionState;
  lastSeen?: string;
  platform?: string;
};

export type RelaySession = {
  id: string;
  title: string;
  agentId: string;
  preview?: string;
  updatedAt: string;
  running?: boolean;
  unread?: boolean;
};

export type RunEventKind = 'user' | 'assistant' | 'tool' | 'system' | 'error';

export type RunEvent = {
  id: string;
  kind: RunEventKind;
  text: string;
  timestamp?: string;
  toolName?: string;
  status?: 'running' | 'complete' | 'failed';
};

export type ApprovalRequest = {
  id: string;
  title: string;
  command: string;
  reason?: string;
};

export type PairingPayload = {
  endpoint: string;
  hostname: string;
  machineName?: string;
  code?: string;
  transport: 'tailscale' | 'https';
};

export type QrContent = ReactNode;
