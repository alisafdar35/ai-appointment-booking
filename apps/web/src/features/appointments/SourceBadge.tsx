import { FileText, MessageSquare, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { AppointmentSource } from '@appt/shared';
import { Badge } from '@/components/ui/Badge';

const SOURCES: Record<AppointmentSource, { label: string; icon: LucideIcon }> = {
  chat: { label: 'Chat', icon: MessageSquare },
  form: { label: 'Form', icon: FileText },
  admin: { label: 'Admin', icon: ShieldCheck },
};

/** How the booking was made. Deliberately neutral: the status badge is the one that should draw the eye. */
export function SourceBadge({ source }: { source: AppointmentSource }) {
  const { label, icon: Icon } = SOURCES[source];
  return (
    <Badge>
      <Icon className="size-3" aria-hidden="true" />
      <span className="sr-only">Booked via </span>
      {label}
    </Badge>
  );
}
