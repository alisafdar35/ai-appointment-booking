import type { Metadata } from 'next';
import { ChatWorkspace } from '@/features/chat';

export const metadata: Metadata = { title: 'Assistant' };

export default function AssistantPage() {
  return <ChatWorkspace />;
}
