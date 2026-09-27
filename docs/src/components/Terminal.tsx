import { lazy, Suspense } from 'react';

const TerminalLazy = lazy(() => import('./TerminalRender.tsx').then((module) => ({ default: module.TerminalRender })));

export function Terminal() {
  return (
    <Suspense
      fallback={
        <div className="not-content flex h-[29rem] items-center justify-center rounded-xl bg-[#1a1b26] text-sm text-[#a9b1d6]">
          Loading terminal…
        </div>
      }
    >
      <TerminalLazy />
    </Suspense>
  );
}
