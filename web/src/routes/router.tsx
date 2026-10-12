// Code-based routes. Each page loads lazily; each route owns its search-param schema.
import {
  type RouterHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';
import { z } from 'zod';
import { HomePage } from '../pages/home/home-page.tsx';
import { SiteLayout } from '../pages/layout/site-layout.tsx';

/** `?pool=0|1`; anything else (7, abc, -1) falls back to pool 0 instead of an error page. */
export const poolSearchSchema = z.object({
  pool: z.union([z.literal(0), z.literal(1)]).catch(0),
});

const rootRoute = createRootRoute({ component: SiteLayout });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});

const borrowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/borrow',
  component: lazyRouteComponent(() => import('../pages/borrow/borrow-page.tsx'), 'BorrowPage'),
});

const loanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/loan',
  validateSearch: poolSearchSchema,
  component: lazyRouteComponent(() => import('../pages/loan/loan-page.tsx'), 'LoanPage'),
});

const bookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/book',
  validateSearch: poolSearchSchema,
  component: lazyRouteComponent(() => import('../pages/book/book-page.tsx'), 'BookPage'),
});

const routeTree = rootRoute.addChildren([homeRoute, borrowRoute, loanRoute, bookRoute]);

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({ routeTree, ...(options.history ? { history: options.history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
