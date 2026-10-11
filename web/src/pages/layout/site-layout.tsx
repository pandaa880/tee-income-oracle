import { Outlet } from '@tanstack/react-router';
import { SiteFooter } from './site-footer.tsx';
import { SiteHeader } from './site-header.tsx';

/** Every page: header, the routed page, footer. */
export function SiteLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className="flex-1">
        <Outlet />
      </div>
      <SiteFooter />
    </div>
  );
}
