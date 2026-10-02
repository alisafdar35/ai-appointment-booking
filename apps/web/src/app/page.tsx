import { DemoCallout } from '@/features/marketing/DemoCallout';
import { Features } from '@/features/marketing/Features';
import { Hero } from '@/features/marketing/Hero';
import { HowItWorks } from '@/features/marketing/HowItWorks';
import { LandingFooter } from '@/features/marketing/LandingFooter';
import { LandingHeader } from '@/features/marketing/LandingHeader';

export default function LandingPage() {
  return (
    <>
      <LandingHeader />
      <main id="main">
        <Hero />
        <Features />
        <HowItWorks />
        <DemoCallout />
      </main>
      <LandingFooter />
    </>
  );
}
