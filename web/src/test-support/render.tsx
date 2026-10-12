// Renders UI inside the real providers: a QueryClient and a TanStack router. Components that use
// `Link` or `getRouteApi` need a router, so page tests render the real app router at a path.
// Callers must `vi.mock('.../app/deps.ts')` themselves (see router.test.tsx). Not a test file.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createAppRouter } from '../routes/router.tsx';

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** The real app router at `path` (header, footer, lazy pages and all). */
export async function renderApp(path: string) {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  const queryClient = client();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient, ...view };
}

/** One component under a stub router that knows `/`, `/borrow`, `/loan`, `/verify` and `/book`. */
export async function renderWithRouter(ui: ReactNode, path = '/') {
  const root = createRootRoute({ component: () => ui });
  const stub = (to: string) =>
    createRoute({ getParentRoute: () => root, path: to, component: () => null });
  const tree = root.addChildren([
    stub('/'),
    stub('/borrow'),
    stub('/loan'),
    stub('/verify'),
    stub('/book'),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const queryClient = client();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient, ...view };
}
