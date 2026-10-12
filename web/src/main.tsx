import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadConfig } from './app/config.ts';
import { initDeps } from './app/deps.ts';
import { BootErrorPage } from './pages/boot-error-page.tsx';
import { createAppRouter } from './routes/router.tsx';

const element = document.getElementById('root');
if (element === null) throw new Error('index.html has no #root element');
const root = createRoot(element);
const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>);

try {
  // Loan and confirm calls combine abort signals; Safari added these in 17.4.
  if (typeof AbortSignal.any !== 'function' || typeof AbortSignal.timeout !== 'function') {
    throw new Error('This browser lacks AbortSignal.any / AbortSignal.timeout.');
  }
  // Config and the demo wallet first: hooks read them synchronously through realDeps().
  await initDeps(loadConfig(import.meta.env));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={createAppRouter()} />
    </QueryClientProvider>,
  );
} catch (cause) {
  render(<BootErrorPage message={cause instanceof Error ? cause.message : String(cause)} />);
}
