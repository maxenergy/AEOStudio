'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const ACTIVE_STATUSES = new Set(['QUEUED', 'RUNNING', 'RETRY_WAIT']);

export function JobPoller({ status }: { status: string }) {
  const router = useRouter();

  useEffect(() => {
    if (!ACTIVE_STATUSES.has(status)) {
      return;
    }
    const timer = window.setTimeout(() => router.refresh(), 700);
    return () => window.clearTimeout(timer);
  }, [router, status]);

  return null;
}
