import type { Metadata } from 'next';
import { AppointmentsDashboard } from '@/features/appointments';

export const metadata: Metadata = { title: 'Appointments' };

export default function AppointmentsPage() {
  return <AppointmentsDashboard />;
}
