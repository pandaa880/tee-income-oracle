// Code-based routes. Each page loads lazily; each route owns its search-param schema.
import {
  type RouterHistory,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';
import { z } from 'zod';
import { HomePage } from '../pages/home-page.tsx';

/** `?pool=0|1`; anything else (7, abc, -1) falls back to pool 0 instead of an error page. */
export const borrowSearchSchema = z.object({
  pool: z.union([z.literal(0), z.literal(1)]).catch(0),
});

const rootRoute = createRootRoute({ component: Outlet });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});

const borrowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/borrow',
  validateSearch: borrowSearchSchema,
  component: lazyRouteComponent(() => import('../pages/borrow-page.tsx'), 'BorrowPage'),
});

const routeTree = rootRoute.addChildren([homeRoute, borrowRoute]);

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({ routeTree, ...(options.history ? { history: options.history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
